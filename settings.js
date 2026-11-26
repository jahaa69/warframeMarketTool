'use strict';
/**
 * settings.js – process main. Réglages de l'app stockés dans le .env (jamais versionné) + diagnostic de
 * premier lancement. Le token WFM_JWT est en ÉCRITURE SEULE : la page peut le définir ou l'effacer,
 * mais il n'est jamais renvoyé au renderer (seulement "défini / non défini").
 *
 * Emplacement du .env : racine du projet en dev, dossier userData une fois l'app packagée (voir main.js).
 */
const fs = require('fs');
const path = require('path');

// Réglages modifiables depuis la page Paramètres (tout le reste du .env est conservé tel quel)
const KEYS = {
  WFM_JWT:        { secret: true },
  WFM_USERNAME:   {},
  RIVENS_JSON:    {},
  ALECAFRAME_DIR: {},
  ALECAFRAME_DLL: {},
  AUTO_DAILY:     { bool: true, def: '1' },   // relevé quotidien automatique des prix des rivens
  NOTIFY:         { bool: true, def: '1' },   // notifications Windows
};

/** Pur (testable) : applique des modifications à un texte .env en gardant commentaires, ordre et autres clés. */
function updateEnvText(text, changes) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const k = m && m[1];
    if (k && k in changes) {
      if (done.has(k)) continue;                       // doublon : on ne garde que la 1re occurrence
      done.add(k);
      if (changes[k] !== null) out.push(`${k}=${changes[k]}`);
      continue;                                        // null = suppression de la clé
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();   // pas de lignes vides en fin de fichier
  for (const [k, v] of Object.entries(changes)) if (!done.has(k) && v !== null) out.push(`${k}=${v}`);
  return out.join('\n') + '\n';
}

/** Valide une valeur avant écriture : pas de retour à la ligne (injection d'autres clés), longueur raisonnable. */
function cleanValue(k, v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/[\r\n\0]/.test(s)) throw new Error(`${k} : retour à la ligne interdit`);
  if (s.length > 4096) throw new Error(`${k} : valeur trop longue`);
  if (KEYS[k].bool) return s === '1' || s === 'true' ? '1' : '0';
  if (k === 'WFM_JWT') return s.replace(/^JWT\s+/i, '').replace(/^Bearer\s+/i, '');   // copier-coller avec préfixe
  return s;
}

function createSettings({ dir, app }) {
  const envPath = () => {
    for (const p of [path.join(dir, '.env'), path.join(dir, '..', '.env')]) if (fs.existsSync(p)) return p;
    return path.join(dir, '.env');
  };
  const flag = k => (process.env[k] ?? KEYS[k].def) === '1';

  function get() {
    const values = {};
    for (const [k, meta] of Object.entries(KEYS)) {
      if (meta.secret) continue;
      values[k] = meta.bool ? flag(k) : (process.env[k] || '');
    }
    return { values, hasToken: !!process.env.WFM_JWT, envFile: envPath(), packaged: !!(app && app.isPackaged) };
  }

  function set(updates) {
    const changes = {};
    for (const [k, v] of Object.entries(updates || {})) {
      if (!(k in KEYS)) throw new Error(`Réglage inconnu : ${k}`);
      const c = cleanValue(k, v);
      changes[k] = c === '' ? null : c;                // vide = on retire la clé (retour au défaut)
    }
    const p = envPath();
    const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, updateEnvText(before, changes), { encoding: 'utf8', mode: 0o600 });
    for (const [k, v] of Object.entries(changes)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
    return get();
  }

  return { get, set, flag, envPath };
}

/**
 * Diagnostic de premier lancement : ce qui manque pour que l'app marche chez quelqu'un qui l'installe.
 * Chaque point : { id, label, ok, level ('ok' | 'warn' | 'error'), detail, help }
 */
async function diagnostics({ jsonPath, fetchFn = fetch, Notification } = {}) {
  const imp = require('./alecaframeImport');
  const out = [];
  const add = (id, label, ok, detail, help, level) => out.push({ id, label, ok, level: level || (ok ? 'ok' : 'error'), detail, help });
  const local = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const afDir = process.env.ALECAFRAME_DIR || path.join(local, 'AlecaFrame');

  let dll = null;
  try { dll = imp.findDll(); } catch (e) { /* signalé ci-dessous */ }
  add('alecaframe', 'AlecaFrame installé', !!dll, dll || 'AlecaFrameClientLib.dll introuvable',
      "Installe AlecaFrame (overlay Overwolf) et lance-le au moins une fois. Sinon, indique le chemin de la DLL dans « Dossier / DLL AlecaFrame ».");

  const dat = path.join(afDir, 'lastData.dat');
  const datOk = fs.existsSync(dat);
  add('lastdata', 'Inventaire AlecaFrame (lastData.dat)', datOk,
      datOk ? `mis à jour le ${fs.statSync(dat).mtime.toLocaleString()}` : `${dat} introuvable`,
      "Lance Warframe avec AlecaFrame ouvert : il enregistre ton inventaire dans ce fichier à chaque synchronisation.");

  const cache = path.join(afDir, 'cachedData', 'custom', 'rivensV2.json');
  add('afcache', 'Données des rivens d\'AlecaFrame', fs.existsSync(cache), fs.existsSync(cache) ? cache : `${cache} introuvable`,
      "AlecaFrame télécharge ce fichier à son premier lancement. Ouvre son onglet Rivens une fois.");

  let user = process.env.WFM_USERNAME || '';
  if (!user) { try { user = fs.readFileSync(path.join(afDir, 'lastUsername.txt'), 'utf8').replace(/^﻿/, '').trim(); } catch { /* absent */ } }
  add('username', 'Pseudo warframe.market', !!user, user ? 'détecté' : 'non détecté',
      "Sert à retrouver tes annonces (statut « en vente »). Il est lu automatiquement depuis AlecaFrame ; sinon, renseigne-le ci-dessous.", user ? 'ok' : 'warn');

  add('token', 'Token warframe.market', !!process.env.WFM_JWT, process.env.WFM_JWT ? 'défini (masqué)' : 'non défini : vente et retrait en simulation uniquement',
      "Nécessaire seulement pour Vendre / Retirer pour de vrai. Voir l'aide « ? » du champ Token.", process.env.WFM_JWT ? 'ok' : 'warn');

  if (jsonPath) {
    const d = path.dirname(jsonPath);
    let writable = false;
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); writable = true; } catch { /* non */ }
    add('rivensjson', 'Fichier des rivens', writable, jsonPath + (fs.existsSync(jsonPath) ? '' : ' (sera créé au 1er import)'),
        "Dossier où l'app enregistre tes rivens, prix et historique. Modifiable ci-dessous.");
  }

  try {
    const r = await fetchFn('https://api.warframe.market/v2/riven/weapons', { headers: { 'User-Agent': 'WarframeMarketTool/1.0' } });
    add('network', 'Accès à warframe.market', r.ok, r.ok ? 'OK' : `HTTP ${r.status}`, "Vérifie ta connexion internet ou un pare-feu.");
  } catch (e) { add('network', 'Accès à warframe.market', false, e.message, "Vérifie ta connexion internet ou un pare-feu."); }

  if (Notification) {
    const ok = Notification.isSupported();
    add('notify', 'Notifications Windows', ok, ok ? 'disponibles' : 'non supportées sur ce système',
        "Paramètres Windows › Système › Notifications : autorise « Warframe Market Tool ».", ok ? 'ok' : 'warn');
  }
  return out;
}

module.exports = { KEYS, updateEnvText, cleanValue, createSettings, diagnostics };
