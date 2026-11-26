'use strict';
/**
 * alecaframeImport.js – process main. Lit l'inventaire Warframe directement depuis AlecaFrame (sans OCR) :
 *   %LOCALAPPDATA%\AlecaFrame\lastData.dat   chiffré AES-128-CBC (JSON de l'inventaire, mis à jour par AlecaFrame)
 *   AlecaFrameClientLib.dll                  contient la clé et l'IV : retrouvés au runtime d'après le SHA-256
 *                                            de leur contenu (nom du champ généré par le compilateur C#).
 *                                            La clé n'est écrite nulle part (ni dans le code, ni sur disque).
 *   cachedData\custom\rivensV2.json          valeurs de base des stats + multiplicateurs selon le nombre de stats
 * + warframe.market (GET publics, lecture seule) :
 *   /v2/riven/weapons, /v2/riven/attributes  correspondance officielle tag interne -> slug, disposition, syllabes
 *   /v1/profile/{pseudo}/auctions            tes annonces actives -> statut "listed" + auction_id
 *
 * Si AlecaFrame change sa clé ou son format, l'import échoue avec un message clair (rien n'est écrit).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AF_EXTENSION_ID = 'afmcagbpgggkpdkokjhjkllpegnadmkignlonpjm';
const KEY_SHA256 = 'A9E16D68AB04C87B3542D306E6C6E0DF38744FA07F8895385DF386307914371F'; // StaticData.lastDataKey
const IV_SHA256 = '7D6F1F0743050BCED46B46CEE96B75AFF754A691A8D941A670A3EFE7CF8C68E5';  // StaticData.lastDataIV
const WFM = 'https://api.warframe.market';
const WFM_HEADERS = { 'User-Agent': 'WarframeMarketTool/1.0', Platform: 'pc', Language: 'en', Accept: 'application/json' };

// Variantes "mêlée" de stats que warframe.market ne référence pas sous ce tag
const TAG_ALIAS = {
  WeaponMeleeDamageMod: 'WeaponDamageAmountMod',
  WeaponMeleeFactionDamageCorpus: 'WeaponFactionDamageCorpus',
  WeaponMeleeFactionDamageGrineer: 'WeaponFactionDamageGrineer',
  WeaponMeleeFactionDamageInfested: 'WeaponFactionDamageInfested',
};
const POLARITY = { AP_ATTACK: 'madurai', AP_DEFENSE: 'vazarin', AP_TACTIC: 'naramon',
                   AP_POWER: 'zenurik', AP_WARD: 'unairu', AP_PRECEPT: 'penjaga', AP_UMBRA: 'umbra' };
const RAND_MAX = 0x3FFFFFFF;
// Valeur affichée = base × disposition × multiplicateur(nb de stats) × (0,9 + 0,2 × aléa) × (rang + 1) × VALUE_SCALE
// (×100 en plus pour les stats en %). Calée le 2026-11-26 sur tes annonces warframe.market créées par AlecaFrame.
// TODO(à vérifier en jeu) : la carte "Unveiled rivens" d'AlecaFrame affiche des valeurs ≈ ×1,2/disposition
// (ex. Fang dégâts critiques : 143.1 ici, 126.2 sur la carte). Compare avec le jeu avant le 1er envoi réel.
const VALUE_SCALE = 10;

const localAppData = () => process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');

// ---------- fichiers AlecaFrame ----------
function findDll() {
  if (process.env.ALECAFRAME_DLL) return process.env.ALECAFRAME_DLL;
  const root = path.join(localAppData(), 'Overwolf', 'Extensions', AF_EXTENSION_ID);
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0; };
  let versions = [];
  try { versions = fs.readdirSync(root).filter(v => /^\d+(\.\d+)*$/.test(v)).sort(cmp); } catch { /* AlecaFrame absent */ }
  for (const v of versions) {
    const p = path.join(root, v, 'NET', 'AlecaFrameClientLib.dll');
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`AlecaFrameClientLib.dll introuvable dans ${root} (AlecaFrame installé ? sinon ALECAFRAME_DLL dans le .env).`);
}
const dataDir = () => process.env.ALECAFRAME_DIR || path.join(localAppData(), 'AlecaFrame');

let keyCache = null; // { dll, mtime, key, iv } – en mémoire uniquement
async function findKeyIv(dll) {
  const st = fs.statSync(dll);
  if (keyCache && keyCache.dll === dll && keyCache.mtime === st.mtimeMs) return keyCache;
  const b = fs.readFileSync(dll);
  let key = null, iv = null;
  for (let i = 0; i + 16 <= b.length && !(key && iv); i++) {
    if (i % 65536 === 0) await new Promise(r => setImmediate(r));          // ne bloque pas l'interface
    const h = crypto.createHash('sha256').update(b.subarray(i, i + 16)).digest('hex').toUpperCase();
    if (!key && h === KEY_SHA256) key = Buffer.from(b.subarray(i, i + 16));
    else if (!iv && h === IV_SHA256) iv = Buffer.from(b.subarray(i, i + 16));
  }
  if (!key || !iv) throw new Error("Clé de lastData.dat introuvable dans la DLL : AlecaFrame a sans doute changé de format (mise à jour). L'import est à adapter.");
  keyCache = { dll, mtime: st.mtimeMs, key, iv };
  return keyCache;
}

async function readInventory() {
  const dat = path.join(dataDir(), 'lastData.dat');
  if (!fs.existsSync(dat)) throw new Error(`${dat} introuvable : lance AlecaFrame au moins une fois avec Warframe ouvert.`);
  const { key, iv } = await findKeyIv(findDll());
  let text;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    text = Buffer.concat([d.update(fs.readFileSync(dat)), d.final()]).toString('utf8').replace(/^﻿/, '');
    return { inv: JSON.parse(text), file: dat, mtime: fs.statSync(dat).mtime };
  } catch (e) {
    throw new Error(`Déchiffrement de lastData.dat impossible (${e.message}) : format AlecaFrame modifié ?`);
  }
}

function readAfRivenData() {
  const p = path.join(dataDir(), 'cachedData', 'custom', 'rivensV2.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`Cache AlecaFrame illisible (${p}) : ${e.message}`); }
}

// ---------- warframe.market (lecture seule) ----------
let wfmCache = null;
async function wfmRivenData(fetchFn = fetch) {
  if (wfmCache) return wfmCache;
  const get = async u => {
    const r = await fetchFn(WFM + u, { headers: WFM_HEADERS });
    if (!r.ok) throw new Error(`warframe.market ${u} : HTTP ${r.status}`);
    return (await r.json()).data;
  };
  const [attrs, weapons] = [await get('/v2/riven/attributes'), await get('/v2/riven/weapons')];
  wfmCache = { attrByTag: Object.fromEntries(attrs.map(a => [a.gameRef, a])),
               weaponByRef: Object.fromEntries(weapons.map(w => [w.gameRef, w])),
               weaponByName: Object.fromEntries(weapons.map(w => [w.i18n.en.name.toLowerCase(), w])) };
  return wfmCache;
}

function readUsername() {
  if (process.env.WFM_USERNAME) return process.env.WFM_USERNAME;
  try { return fs.readFileSync(path.join(dataDir(), 'lastUsername.txt'), 'utf8').replace(/^﻿/, '').trim() || null; }
  catch { return null; }
}

async function myAuctions(username, fetchFn = fetch) {
  const r = await fetchFn(`${WFM}/v1/profile/${encodeURIComponent(username)}/auctions`, { headers: WFM_HEADERS });
  if (!r.ok) throw new Error(`annonces de ${username} : HTTP ${r.status}`);
  return ((await r.json()).payload.auctions || [])
    .filter(a => a.item && a.item.type === 'riven' && a.visible && !a.closed);
}

// ---------- conversion d'un riven de l'inventaire ----------
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function convertRiven(upgrade, af, wfm) {
  const f = JSON.parse(upgrade.UpgradeFingerprint || '{}');
  const id = upgrade.ItemId && (upgrade.ItemId.$oid || upgrade.ItemId);
  if (!f.compat || !f.buffs || !f.buffs.length) return { skip: 'riven sans arme ou sans stats (non dévoilé ?)', id };
  const warnings = [];
  let w = wfm.weaponByRef[f.compat];
  const afWeapon = af.weaponStats[f.compat];
  if (!w && afWeapon) w = wfm.weaponByName[String(afWeapon.name).toLowerCase()];
  const weaponName = w ? w.i18n.en.name : (afWeapon && afWeapon.name) || f.compat.split('/').pop();
  if (!w) warnings.push(`arme « ${weaponName} » inconnue de warframe.market (prix et vente impossibles)`);
  const disposition = w ? w.disposition : afWeapon && afWeapon.omegaAtt;
  const typeStats = (af.dataByRivenInternalID[upgrade.ItemType] || {}).rivenStats || {};
  const buffs = f.buffs, curses = f.curses || [];
  const mods = af.modifiersBasedOnTraitCount.find(m => m.goodModifiersCount === buffs.length && m.badModifiersCount === curses.length);
  if (!disposition || !mods) return { skip: `${weaponName} : disposition ou combinaison de stats inconnue`, id };

  const stats = [];
  for (const [list, good] of [[buffs, true], [curses, false]]) for (const b of list) {
    const tag = TAG_ALIAS[b.Tag] || b.Tag;
    const attr = wfm.attrByTag[tag], def = typeStats[b.Tag] || typeStats[tag];
    if (!attr) { warnings.push(`stat ${b.Tag} inconnue de warframe.market`); continue; }
    if (!def) { warnings.push(`stat ${b.Tag} absente du cache AlecaFrame (valeur inconnue)`); stats.push({ stat: attr.slug, value: null, positive: good }); continue; }
    const frac = def.baseValue * disposition * (good ? mods.goodModifierMultiplier : mods.badModifierMultiplier)
               * (0.9 + 0.2 * (b.Value / RAND_MAX)) * ((f.lvl || 0) + 1) * VALUE_SCALE;
    const percent = /\|val\|%|\|STAT1\|%/.test(def.localizationString || '');
    let value = percent ? frac * 100 : frac;
    if (/^damage_vs_/.test(attr.slug)) value = round(1 + frac, 2);            // affiché "x1.47" (même format que l'OCR)
    else value = round(value, 1);
    stats.push({ stat: attr.slug, value, positive: good });
  }

  // Nom : stats positives triées par aléa décroissant -> Préfixe1[-préfixe2]suffixeN (vérifié sur tes annonces)
  let rivenName = null;
  const named = [...buffs].sort((a, b) => b.Value - a.Value).map(b => wfm.attrByTag[TAG_ALIAS[b.Tag] || b.Tag]);
  if (named.every(Boolean)) {
    const pre = named.slice(0, -1).map(a => a.prefix.toLowerCase()), suf = named[named.length - 1].suffix.toLowerCase();
    rivenName = capitalize(pre[0]) + (pre.length > 1 ? '-' + pre.slice(1).join('') : '') + suf;
  } else warnings.push('nom du riven non calculable');

  const weaponUrl = w ? w.slug : weaponName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { riven: {
    item_id: id, source: 'alecaframe',
    weapon: weaponName, riven_name: rivenName, stats,
    mastery_level: f.lvlReq ?? null, re_rolls: f.rerolls ?? 0, mod_rank: f.lvl ?? 0,
    polarity: POLARITY[f.pol] || '', weapon_url_name: weaponUrl,
    pos: stats.filter(s => s.positive).map(s => s.stat), neg: stats.filter(s => !s.positive).map(s => s.stat),
    listed: false,
  }, warnings };
}

const statKey = r => `${r.weapon_url_name}|${(r.stats || []).map(s => s.stat + (s.positive ? '+' : '-')).sort().join(',')}`;
const auctionKey = a => `${a.item.weapon_url_name}|${a.item.attributes.map(t => t.url_name + (t.positive ? '+' : '-')).sort().join(',')}`;

// Champs venant du jeu (écrasés à chaque import) ; tout le reste (prix, finder, conseil…) est conservé.
const GAME_FIELDS = ['item_id', 'source', 'weapon', 'riven_name', 'stats', 'mastery_level', 're_rolls', 'mod_rank',
                     'polarity', 'weapon_url_name', 'pos', 'neg'];

/**
 * Fusionne l'inventaire dans la liste existante. Pur (testable) : ne touche ni disque ni réseau.
 * options : includeListed (ajoute aussi les nouveaux rivens déjà en vente), prune (retire les absents).
 */
function mergeRivens(existing, converted, auctions, { includeListed = false, prune = false } = {}) {
  const out = existing.map(r => ({ ...r }));
  const log = [];
  const byAuction = new Map();
  if (auctions) for (const a of auctions) {
    const k = auctionKey(a);
    byAuction.set(k, byAuction.has(k) ? null : a);                   // null = ambigu (2 annonces identiques)
  }
  const used = new Set();
  let added = 0, updated = 0, skippedListed = 0;
  for (const c of converted) {
    let i = out.findIndex((r, j) => !used.has(j) && r.item_id && r.item_id === c.item_id);
    if (i < 0) i = out.findIndex((r, j) => !used.has(j) && !r.item_id && statKey(r) === statKey(c)); // ancien OCR
    const auction = auctions ? byAuction.get(statKey(c)) : undefined;
    const listed = !!auction;
    if (i >= 0) {
      for (const k of GAME_FIELDS) if (!(k === 'polarity' && !c.polarity)) out[i][k] = c[k]; // garde une polarité choisie à la main si le jeu n'en donne pas
      if (auctions) {                                                 // statut "listed" connu
        out[i].listed = listed;
        if (auction) { out[i].auction_id = auction.id; out[i].listed_price = auction.buyout_price ?? null; }
        else {
          if (out[i].auction_id) log.push(`${c.weapon} : plus d'annonce active, auction_id retiré`);
          delete out[i].auction_id; delete out[i].listed_price;
        }
      }
      used.add(i); updated++;
    } else {
      if (listed && !includeListed) { skippedListed++; continue; }
      out.push({ ...c, listed, ...(auction ? { auction_id: auction.id, listed_price: auction.buyout_price ?? null } : {}) });
      used.add(out.length - 1); added++;
    }
  }
  if (auctions) for (const [k, a] of byAuction) if (a === null) log.push(`2 annonces identiques (${k}) : statut "listed" non attribué`);

  let removed = [];
  if (prune) {
    const keep = [];
    out.forEach((r, j) => {
      if (used.has(j)) keep.push(r);
      else if (r.auction_id) { keep.push(r); log.push(`gardé malgré son absence de l'inventaire (annonce ${r.auction_id}) : ${r.weapon}`); }
      else removed.push(r);
    });
    return { rivens: keep, added, updated, skippedListed, removed, log };
  }
  return { rivens: out, added, updated, skippedListed, removed, log };
}

/** Import complet : lit AlecaFrame + warframe.market, fusionne, renvoie le résultat (l'appelant écrit le fichier). */
async function importFromAlecaFrame(existing, options = {}, fetchFn = fetch) {
  const { inv, file, mtime } = await readInventory();
  const af = readAfRivenData();
  const wfm = await wfmRivenData(fetchFn);
  const ups = (inv.Upgrades || []).filter(u => /\/Randomized\//.test(u.ItemType || '') && u.UpgradeFingerprint);
  const converted = [], warnings = [];
  for (const u of ups) {
    const r = convertRiven(u, af, wfm);
    if (r.skip) { warnings.push(`ignoré : ${r.skip}`); continue; }
    converted.push(r.riven);
    r.warnings.forEach(w => warnings.push(`${r.riven.weapon} : ${w}`));
  }
  let auctions = null, auctionsInfo;
  const user = readUsername();
  if (!user) auctionsInfo = 'pseudo inconnu (WFM_USERNAME dans le .env) : statut "listed" non vérifié';
  else {
    try { auctions = await myAuctions(user, fetchFn); auctionsInfo = `${auctions.length} annonce(s) riven active(s) sur warframe.market`; }
    catch (e) { auctionsInfo = `annonces non vérifiées (${e.message}) : statut "listed" inchangé`; }
  }
  // sécurité : si les annonces n'ont pas pu être lues, on ne nettoie pas les entrées qui avaient un auction_id
  const res = mergeRivens(existing, converted, auctions, options);
  return { ...res, inventoryRivens: converted.length, warnings, auctionsInfo, source: file, sourceDate: mtime };
}

module.exports = { importFromAlecaFrame, mergeRivens, convertRiven, readInventory, findDll, findKeyIv, statKey,
                   TAG_ALIAS, POLARITY, VALUE_SCALE };
