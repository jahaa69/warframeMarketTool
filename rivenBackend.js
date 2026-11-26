'use strict';
/**
 * rivenBackend.js – côté "main" d'Electron. Appels à warframe.market, lecture/écriture de rivens.json,
 * historique des prix, import AlecaFrame, relevé quotidien + notifications.
 * Le token WFM_JWT reste ICI : la page (renderer) ne le voit jamais, et il n'est envoyé à warframe.market
 * que pour les actions qui l'exigent (vendre / retirer).
 *
 * Branché dans main.js (registerRivenIpc). `dir` = racine du projet en dev, userData une fois packagé.
 * Réglages (.env, modifiables dans la page Paramètres) : voir settings.js.
 */
const fs = require('fs');
const path = require('path');
const { importFromAlecaFrame } = require('./alecaframeImport');

const BASE = 'https://api.warframe.market/v1';
// damage_vs_* : envoyés tels quels sous forme de multiplicateur (ex. 1.47, 0.97). Constat 2026-11-25 sur ~600
// annonces (GET /v1/auctions/search) : c'est le format que warframe.market stocke et renvoie. L'ancienne
// conversion "1.47 -> 47" du prototype a été retirée.
// Polarités : sur ces mêmes annonces, seules madurai, vazarin et naramon apparaissent (les rivens n'en ont pas
// d'autre en jeu). Les autres restent proposées dans la liste au cas où.
const POLARITIES = ['madurai', 'vazarin', 'naramon', 'zenurik', 'unairu', 'penjaga'];

// ---------- .env sans module ----------
function loadEnv(dir) {
  for (const p of [path.join(dir, '.env'), path.join(dir, '..', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
    return p;
  }
  return null;
}

// User-Agent obligatoire : sans lui warframe.market répond 403 (même valeur que WF_HEADERS dans main.js).
// Le token n'est joint QUE si auth = true (vendre / retirer) : les recherches publiques n'en ont pas besoin.
const headers = (auth = false) => ({
  'User-Agent': 'WarframeMarketTool/1.0',
  Platform: 'pc', Language: 'en', 'Content-Type': 'application/json',
  ...(auth ? { Authorization: `JWT ${process.env.WFM_JWT || ''}` } : {}),
});
const keyOf = r => `${r.weapon_url_name}|${[...r.pos].sort().join(',')}|${[...r.neg].sort().join(',')}`;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// ---------- prix (sans OCR ni souris : warframe.market + statistiques hebdomadaires de DE) ----------
const ONLINE = ['ingame', 'online'];
// warframe.market applique un QUOTA sur /auctions/search : ~20 recherches, puis HTTP 429 pendant plusieurs minutes
// (mesuré le 2026-11-26, même en espaçant les requêtes). D'où : 1 seule recherche par riven + cache de 30 min.
const WFM_GAP_MS = 1500;
const WFM_CACHE_MS = 30 * 60 * 1000;
let lastWfmCall = 0;
const searchCache = new Map();                          // requête -> { at, auctions } (mémoire du process main)
async function wfmSearch(params, fetchFn = fetch, wait = sleep) {
  const q = new URLSearchParams({ type: 'riven', sort_by: 'price_asc', buyout_policy: 'direct', ...params }).toString();
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < WFM_CACHE_MS) return hit.auctions;
  for (let attempt = 0; attempt < 3; attempt++) {
    const gap = WFM_GAP_MS - (Date.now() - lastWfmCall);
    if (gap > 0) await wait(gap);
    lastWfmCall = Date.now();
    const res = await fetchFn(`${BASE}/auctions/search?${q}`, { headers: headers() });
    if (res.status === 429) { if (attempt < 2) await wait(10000 * (attempt + 1)); continue; }   // 10 s puis 20 s
    if (!res.ok) throw new Error(`HTTP ${res.status} sur la recherche d'enchères`);
    const auctions = (await res.json()).payload.auctions;
    searchCache.set(q, { at: Date.now(), auctions });
    return auctions;
  }
  throw new Error('HTTP 429 : quota de recherches warframe.market atteint. Patiente quelques minutes puis reclique ' +
                  'sur « Calculer les prix » : les rivens déjà calculés ne refont pas de recherche (cache 30 min).');
}

// UNE recherche : mêmes stats positives, négative quelconque. Les annonces qui ont aussi la même négative (ou
// aucune si le riven n'en a pas) sont triées localement : si elles sont ≥ 3, on ne garde qu'elles (palier exact).
// Ta propre annonce (auction_id) est exclue : ce n'est pas un concurrent.
async function marketPrice(r, fetchFn = fetch, wait = sleep) {
  const found = (await wfmSearch({ weapon_url_name: r.weapon_url_name, positive_stats: r.pos.slice(0, 3).join(',') }, fetchFn, wait))
    .filter(a => a.id !== r.auction_id && a.buyout_price);
  const sameNeg = a => {
    const negs = ((a.item && a.item.attributes) || []).filter(t => !t.positive).map(t => t.url_name);
    return r.neg.length ? negs.length === 1 && negs[0] === r.neg[0] : negs.length === 0;
  };
  const exact = found.filter(sameNeg);
  const chosen = exact.length >= 3
    ? { tier: 'exact', label: 'mêmes stats (même négative)', auctions: exact }
    : { tier: 'positives', label: 'mêmes stats positives, négative quelconque', auctions: found };
  const all = chosen.auctions.map(a => a.buyout_price).sort((a, b) => a - b);
  const online = chosen.auctions.filter(a => ONLINE.includes(a.owner.status)).map(a => a.buyout_price).sort((a, b) => a - b);
  return { n: all.length, online: online.length, min: online.length ? online[0] : all.length ? all[0] : null,
           median: medianOf(all), tier: chosen.tier, tierLabel: chosen.label,
           prices: online.slice(0, 50), allPrices: all.slice(0, 100) };   // listes : pour le conseil, non sauvegardées
}

// Statistiques hebdomadaires publiques de DE : prix des échanges de rivens en jeu, par arme (rerollé ou non).
// Le fichier n'est pas du JSON strict (clés sans guillemets, chaînes en '...') : converti sans être exécuté.
const DE_WEEKLY_URL = 'https://www-static.warframe.com/repos/weeklyRivensPC.json';
function parseLoose(raw) {
  try { return JSON.parse(raw); } catch { /* format non strict */ }
  const BS = String.fromCharCode(92);
  let out = '', i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'" || c === '"') {
      let s = '', j = i + 1;
      while (j < raw.length && raw[j] !== c) { if (raw[j] === BS) { s += raw[j + 1]; j += 2; } else s += raw[j++]; }
      out += JSON.stringify(s); i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < raw.length && /\w/.test(raw[j])) j++;
      const w = raw.slice(i, j); let k = j; while (/\s/.test(raw[k] || '')) k++;
      if (raw[k] === ':') out += JSON.stringify(w);
      else if (['true', 'false', 'null'].includes(w)) out += w;
      else throw new Error(`stats DE : jeton inattendu « ${w} »`);
      i = j;
    } else { out += c; i++; }
  }
  return JSON.parse(out);
}
let deCache = null;
async function deWeeklyStats(fetchFn = fetch) {
  if (deCache && Date.now() - deCache.at < 6 * 3600 * 1000) return deCache.map;
  const res = await fetchFn(DE_WEEKLY_URL, { headers: { 'User-Agent': 'WarframeMarketTool/1.0' } });
  if (!res.ok) throw new Error(`stats DE : HTTP ${res.status}`);
  const map = new Map();
  for (const e of parseLoose(await res.text())) if (e.compatibility) map.set(`${e.compatibility.toLowerCase()}|${!!e.rerolled}`, e);
  deCache = { at: Date.now(), map };
  return map;
}
const deFor = (map, r) => {
  if (!map) return null;
  const w = String(r.weapon || '').toLowerCase(), rr = (r.re_rolls || 0) > 0;
  return map.get(`${w}|${rr}`) || map.get(`${w}|${!rr}`) || null;
};

// ---------- baromètre du marché : est-ce le bon moment pour vendre ? (warframe.market, 90 jours) ----------
// Aucune source publique ne donne l'historique d'une arme précise ; warframe.market publie en revanche les ventes
// CONCLUES des rivens voilés de chaque catégorie sur 90 jours : un indicateur de la demande de rivens du moment.
const PUB_HEADERS = { 'User-Agent': 'WarframeMarketTool/1.0', Platform: 'pc', Language: 'en', Accept: 'application/json' };
const CATEGORY_LABEL = { rifle: 'fusils', pistol: 'armes secondaires', melee: 'armes de mêlée', shotgun: 'fusils à pompe',
                         zaw: 'zaws', kitgun: 'kitguns', archgun: 'archguns' };
let weaponTypeCache = null;
async function rivenTypeOf(r, fetchFn = fetch) {
  if (!weaponTypeCache || Date.now() - weaponTypeCache.at > 24 * 3600 * 1000) {
    const res = await fetchFn('https://api.warframe.market/v2/riven/weapons', { headers: PUB_HEADERS });
    if (!res.ok) throw new Error(`liste des armes : HTTP ${res.status}`);
    weaponTypeCache = { at: Date.now(), map: new Map((await res.json()).data.map(w => [w.slug, w.rivenType])) };
  }
  return weaponTypeCache.map.get(r.weapon_url_name) || null;
}
const categoryCache = new Map();
async function categoryStats(type, fetchFn = fetch) {
  const hit = categoryCache.get(type);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.rows;
  const res = await fetchFn(`https://api.warframe.market/v1/items/${type}_riven_mod_veiled/statistics`, { headers: PUB_HEADERS });
  if (!res.ok) throw new Error(`statistiques ${type} : HTTP ${res.status}`);
  const rows = ((await res.json()).payload.statistics_closed || {})['90days'] || [];
  categoryCache.set(type, { at: Date.now(), rows });
  return rows;
}

/**
 * Pur (testable). rows = statistiques 90 jours (2 lignes/jour : rivens "revealed" et "unrevealed").
 * Renvoie la série journalière (volume, médiane pondérée, moyennes sur 7 jours) et un verdict :
 *  - percentile = part des 90 derniers jours où la moyenne 7 j était ≤ à celle d'aujourd'hui
 *  - tendance   = moyenne 7 j d'aujourd'hui comparée à celle d'il y a 14 jours
 *  basis 'volume' (rivens, défaut) : bon = demande ≥ 66e percentile et pas en chute (> −5 %) ;
 *                                    attendre = demande ≤ 33e percentile ou chute ≤ −20 %.
 *  basis 'price' (objets : sets prime, arcanes, mods…) : bon = prix ≥ 66e percentile, pas en chute (> −5 %) et
 *                                    demande pas au plus bas (> 20e percentile) ; attendre = prix ≤ 33e percentile ou chute ≤ −15 %.
 */
function barometer(rows, { basis = 'volume' } = {}) {
  const byDay = new Map();
  for (const x of rows) {
    const k = String(x.datetime).slice(0, 10), d = byDay.get(k) || { vol: 0, w: 0 };
    d.vol += x.volume || 0; d.w += (x.median || 0) * (x.volume || 0); byDay.set(k, d);
  }
  const days = [...byDay.keys()].sort().map(k => {
    const d = byDay.get(k);
    return { date: k, vol: d.vol, med: d.vol ? d.w / d.vol : null, vol7: 0, med7: /** @type {number|null} */ (null) };
  });
  days.forEach((d, i) => {
    const win = days.slice(Math.max(0, i - 6), i + 1), vol = win.reduce((s, x) => s + x.vol, 0);
    d.vol7 = vol / win.length;
    d.med7 = vol ? win.reduce((s, x) => s + (x.med || 0) * x.vol, 0) / vol : null;
  });
  if (days.length < 21) return { series: days, verdict: { level: 'inconnu', text: "Pas assez d'historique pour juger (moins de 3 semaines)." } };
  const pct = (arr, v) => Math.round(100 * arr.filter(x => x <= v).length / arr.length);
  const now = days[days.length - 1], before = days[days.length - 15];
  const volPct = pct(days.map(d => d.vol7), now.vol7), medPct = pct(days.filter(d => d.med7 != null).map(d => d.med7), now.med7);
  const volTrend = before.vol7 ? Math.round(100 * (now.vol7 - before.vol7) / before.vol7) : 0;
  const medTrend = before.med7 ? Math.round(100 * (now.med7 - before.med7) / before.med7) : 0;
  const level = basis === 'price'
    ? (medPct >= 66 && medTrend > -5 && volPct > 20 ? 'bon' : medPct <= 33 || medTrend <= -15 ? 'attendre' : 'moyen')
    : (volPct >= 66 && volTrend > -5 ? 'bon' : volPct <= 33 || volTrend <= -20 ? 'attendre' : 'moyen');
  const head = { bon: 'Bon moment pour vendre', moyen: 'Moment moyen', attendre: 'Plutôt attendre' }[level];
  const sign = v => (v > 0 ? '+' : '') + v + ' %';
  const med = now.med7 != null ? now.med7.toFixed(1) : '?';
  const text = basis === 'price'
    ? `${head} : prix médian ${med} pl (moy. 7 j), plus haut que ${medPct} % des 90 derniers jours, ${sign(medTrend)} sur 2 semaines` +
      ` · ${Math.round(now.vol7)} ventes/jour (${volPct}e percentile, ${sign(volTrend)})`
    : `${head} : ${Math.round(now.vol7)} ventes/jour (moy. 7 j), plus que ${volPct} % des 90 derniers jours, ` +
      `${sign(volTrend)} sur 2 semaines · prix médian ${med} pl (${medPct}e percentile, ${sign(medTrend)})`;
  // Pendant pour l'achat (objets) : prix dans le bas de ses 90 jours et marché encore actif
  const buy = basis === 'price' && medPct <= 33 && volPct > 20;
  return { series: days, verdict: { level, buy, text: text + (buy ? ' · 🛒 bon moment pour ACHETER (prix bas)' : ''),
                                    volNow: Math.round(now.vol7), volPct, volTrend, medNow: now.med7, medPct, medTrend } };
}

// ---------- prix de vente conseillé ----------
//  0. Comparables = annonces warframe.market du palier retenu (exact, sinon mêmes positives), toutes, SANS les
//     aberrants (< médiane/3 ou > médiane×3). Ta propre annonce est exclue.
//  1. ≥ 3 comparables : valeur V = médiane ; concurrence L = le moins cher en ligne (sinon le moins cher tout court) ;
//     cible = L − 3 % pour passer devant ; plancher = 80 % du 1er quartile.
//  2. 1 ou 2 comparables : aligné sur le moins cher, plancher 80 % de V.
//  3. Aucun comparable (roll quasi unique, cas fréquent) : médiane des échanges en jeu de la semaine (DE) pour
//     l'arme, rerollé ou non. Ce chiffre ignore les stats : confiance faible, à ajuster à la main.
//  4. Arrondi vers le bas à un palier lisible (1 / 5 / 10 / 50 pl), sans passer sous le plancher.
//  Confiance : haute ≥ 10 comparables, moyenne ≥ 3, sinon faible.
const quantile = (a, q) => {                       // quantile avec interpolation linéaire
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};
const medianOf = a => quantile(a, 0.5);
const niceStep = p => (p < 50 ? 1 : p < 200 ? 5 : p < 1000 ? 10 : 50);

function niceRound(price, floor) {
  const step = niceStep(price);
  let rounded = Math.floor(price / step) * step;
  if (rounded < floor) rounded = Math.ceil(price / step) * step;
  return Math.max(1, rounded);
}

function suggestPrice(r, info) {
  const all = ((info && info.allPrices) || []).filter(p => p > 0);
  const online = ((info && info.prices) || []).filter(p => p > 0);
  const de = info && info.de;
  const deTxt = de ? `échanges en jeu de la semaine (DE) pour ${r.weapon} ${de.rerolled ? 'rerollé' : 'non rerollé'} : ` +
                     `médiane ${de.median} pl, de ${de.min} à ${de.max}` : '';

  if (!all.length) {                                             // aucun comparable : repli sur les stats DE
    if (!de || !(de.median > 0)) return null;                    // aucune donnée : pas de conseil inventé
    const price = niceRound(de.median, 1);
    return { price, confidence: 'faible', value: Math.round(de.median), lowest: null, comps: 0, source: 'de',
             reason: `aucune annonce comparable sur warframe.market · ${deTxt} → ${price} pl ` +
                     '(ignore tes stats : à ajuster à la main)' };
  }

  const m0 = medianOf(all);
  const sane = p => p >= m0 / 3 && p <= m0 * 3;
  const clean = all.filter(sane), onlineClean = online.filter(sane);
  const value = medianOf(clean);
  const lowest = onlineClean.length ? onlineClean[0] : clean[0];
  let lowestSrc = onlineClean.length ? 'vendeur en ligne le moins cher' : 'annonce la moins chère (vendeur hors ligne)';
  const skipped = all.filter(p => p < lowest && !sane(p)).length;
  if (skipped) lowestSrc += ` (hors ${skipped} prix aberrant${skipped > 1 ? 's' : ''})`;

  const comps = all.length;
  let target, why;
  if (comps <= 2) { target = lowest; why = `peu d'annonces (${comps}) → aligné sur ${lowest}`; }
  else { target = lowest - Math.max(1, Math.round(lowest * 0.03)); why = `${lowest} − 3 % pour passer devant`; }
  const floorBase = clean.length >= 3 ? quantile(clean, 0.25) : value;
  const floor = Math.max(1, Math.round(floorBase * 0.8));
  if (target < floor) why += ` → relevé au plancher (${floor} = 80 % ${clean.length >= 3 ? 'du bas du marché' : 'de la valeur'})`;
  const price = niceRound(Math.max(target, floor), floor);

  const confidence = comps >= 10 ? 'haute' : comps >= 3 ? 'moyenne' : 'faible';
  const reason = `${comps} annonce(s) comparable(s) (${(info && info.tierLabel) || 'warframe.market'}) · ` +
    `médiane ≈ ${Math.round(value)} pl · ${lowestSrc} : ${lowest} pl · ${why} → ${price} pl` + (de ? ` · pour info, ${deTxt}` : '');
  return { price, confidence, value: Math.round(value), lowest, comps, source: 'wfm', reason };
}

// ---------- vente / retrait ----------
const attributePayload = s => ({ url_name: s.stat, positive: s.positive, value: s.value });   // damage_vs_* : multiplicateur tel quel
const sellPayload = (r, price, polarity, note = '') => ({
  item: { type: 'riven', weapon_url_name: r.weapon_url_name, name: r.riven_name,
          mastery_level: r.mastery_level, re_rolls: r.re_rolls, mod_rank: r.mod_rank,
          polarity, attributes: r.stats.map(attributePayload) },
  note, starting_price: price, buyout_price: price, minimal_reputation: 0, minimal_increment: 1, private: false,
});

/**
 * Pur (testable). Décide quelles notifications envoyer après un relevé.
 *  - catégorie de rivens qui passe au vert (bon moment) alors qu'elle ne l'était pas au relevé précédent
 *  - annonce à toi (auction_id + listed_price) avec un vendeur EN LIGNE moins cher : une seule fois par prix concurrent
 * results : [{ riven, info, catType, catLabel, catLevel }] ; state : { levels: {type: level}, undercut: {auctionId: prix} }
 */
function planNotifications(results, state) {
  const notes = [], levels = { ...(state.levels || {}) }, undercut = { ...(state.undercut || {}) };
  const byCat = new Map();
  for (const x of results) if (x.catType) {
    if (!byCat.has(x.catType)) byCat.set(x.catType, { label: x.catLabel, level: x.catLevel, rivens: [] });
    byCat.get(x.catType).rivens.push(x.riven);
  }
  for (const [type, c] of byCat) {
    if (c.level === 'bon' && levels[type] !== 'bon') {
      const names = c.rivens.filter(r => !r.auction_id).map(r => r.weapon);
      if (names.length) notes.push({ title: `Bon moment pour vendre : ${c.label}`,
        body: `La demande est haute. Rivens concernés : ${[...new Set(names)].slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}` });
    }
    if (c.level && c.level !== 'inconnu') levels[type] = c.level;
  }
  for (const { riven: r, info } of results) {
    if (!r.auction_id || !r.listed_price || !info || !info.prices || !info.prices.length) continue;
    const cheapest = info.prices[0];                                   // vendeurs en ligne, ta propre annonce exclue
    if (cheapest < r.listed_price && undercut[r.auction_id] !== cheapest) {
      notes.push({ title: `${r.weapon} : quelqu'un vend moins cher`,
        body: `Un vendeur en ligne propose ${cheapest} pl, ton annonce est à ${r.listed_price} pl.` });
      undercut[r.auction_id] = cheapest;
    }
  }
  return { notes, state: { ...state, levels, undercut } };
}

function registerRivenIpc({ ipcMain, dialog, getWindow, dir, Notification, settings }) {
  loadEnv(dir);
  const jsonPath = () => process.env.RIVENS_JSON || path.join(dir, 'rivens.json');
  const histPath = () => path.join(path.dirname(jsonPath()), 'price_history.json');
  const statePath = () => path.join(path.dirname(jsonPath()), 'notif_state.json');
  const readHist = () => { try { return JSON.parse(fs.readFileSync(histPath(), 'utf8')); } catch { return []; } };
  const readJson = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
  const flag = k => (settings ? settings.flag(k) : true);

  // Prix d'un riven + point d'historique (partagé par le bouton, la courbe et le relevé quotidien)
  async function priceAndRecord(r) {
    const info = await marketPrice(r);
    try { info.de = deFor(await deWeeklyStats(), r); } catch { info.de = null; }   // repli facultatif
    const suggested = suggestPrice(r, info);
    const hist = readHist(), key = keyOf(r), now = new Date();
    const point = { date: now.toISOString(), key, n: info.n, min: info.min, median: info.median,
                    suggested: suggested ? suggested.price : null, de: info.de ? info.de.median : null };
    // < 30 min après le précédent point de ce riven (mêmes données, cache) : on le remplace au lieu d'empiler
    let last = -1; for (let k = hist.length - 1; k >= 0; k--) if (hist[k].key === key) { last = k; break; }
    if (last >= 0 && now - new Date(hist[last].date) < WFM_CACHE_MS) hist[last] = point; else hist.push(point);
    fs.writeFileSync(histPath(), JSON.stringify(hist));
    return { ...info, suggested };
  }

  function notify(title, body) {
    if (!Notification || !flag('NOTIFY') || !Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => { const w = getWindow(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } });
    n.show();
  }

  // Relevé quotidien : prix de chaque riven (historique), baromètre des catégories, notifications.
  // N'écrit PAS rivens.json (la page peut le modifier en même temps) : seulement l'historique et notif_state.json.
  let dailyRunning = false;
  async function runDailyCheck({ force = false } = {}) {
    if (dailyRunning) return { ok: false, text: 'Relevé déjà en cours.' };
    const state = readJson(statePath(), {});
    if (!force && state.lastRun && Date.now() - new Date(state.lastRun) < 20 * 3600 * 1000)
      return { ok: true, skipped: true, text: `Dernier relevé : ${new Date(state.lastRun).toLocaleString()} (moins de 20 h).` };
    const rivens = readJson(jsonPath(), null);
    if (!Array.isArray(rivens) || !rivens.length) return { ok: false, text: 'Aucun riven : importe d\'abord depuis AlecaFrame.' };
    dailyRunning = true;
    const results = [], errors = [];
    try {
      const cats = new Map();
      for (const r of rivens) {
        if (!r.weapon_url_name || !Array.isArray(r.pos)) continue;
        let info = null;
        try { info = await priceAndRecord(r); }
        catch (e) { errors.push(`${r.weapon} : ${e.message}`); if (/429/.test(e.message)) break; continue; }
        let type = null;
        try { type = await rivenTypeOf(r); } catch { /* catégorie inconnue */ }
        if (type && !cats.has(type)) {
          try { cats.set(type, barometer(await categoryStats(type)).verdict.level); } catch { cats.set(type, 'inconnu'); }
        }
        results.push({ riven: r, info, catType: type, catLabel: `rivens de ${CATEGORY_LABEL[type] || type}`, catLevel: type ? cats.get(type) : null });
      }
      const plan = planNotifications(results, state);
      for (const n of plan.notes) notify(n.title, n.body);
      fs.writeFileSync(statePath(), JSON.stringify({ ...plan.state, lastRun: new Date().toISOString(),
                                                    lastCount: results.length, lastErrors: errors }, null, 2));
      return { ok: true, text: `Relevé terminé : ${results.length}/${rivens.length} rivens, ${plan.notes.length} notification(s)` +
                                (errors.length ? `\n${errors.join('\n')}` : '') };
    } finally { dailyRunning = false; }
  }
  // Au démarrage (après 1 min) puis toutes les 6 h : relevé si le dernier a plus de 20 h et si l'option est active
  const tick = () => { if (flag('AUTO_DAILY')) runDailyCheck().catch(e => console.error('Relevé quotidien :', e.message)); };
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, 6 * 3600 * 1000).unref?.();
  ipcMain.handle('riven:daily', () => runDailyCheck({ force: true }));
  ipcMain.handle('riven:dailyStatus', () => {
    const s = readJson(statePath(), {});
    return { lastRun: s.lastRun || null, lastCount: s.lastCount || 0, lastErrors: s.lastErrors || [], running: dailyRunning };
  });
  const confirm = async (win, title, detail) =>
    (await dialog.showMessageBox(win, { type: 'warning', buttons: ['Annuler', 'Confirmer'], defaultId: 0, cancelId: 0,
                                         title, message: title, detail })).response === 1;

  ipcMain.handle('riven:config', () => ({ polarities: POLARITIES, rivensJson: jsonPath(), hasToken: !!process.env.WFM_JWT }));
  ipcMain.handle('riven:load', () => {
    // Premier lancement : pas encore de fichier -> liste vide et consigne claire (pas d'erreur technique)
    if (!fs.existsSync(jsonPath())) return { ok: true, rivens: [], firstRun: true };
    try { return { ok: true, rivens: JSON.parse(fs.readFileSync(jsonPath(), 'utf8')) }; }
    catch (e) { return { ok: false, error: `Impossible de lire ${jsonPath()} : ${e.message}` }; }
  });
  ipcMain.handle('riven:save', (_e, rivens) => { fs.writeFileSync(jsonPath(), JSON.stringify(rivens, null, 2)); return true; });

  ipcMain.handle('riven:price', async (_e, r) => {
    try { return { ok: true, ...(await priceAndRecord(r)) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  // Baromètre de la catégorie de l'arme (90 jours) : courbe du marché + verdict "bon moment ?"
  ipcMain.handle('riven:barometer', async (_e, r) => {
    try {
      const type = await rivenTypeOf(r);
      if (!type) return { ok: false, error: `catégorie de ${r.weapon} inconnue de warframe.market` };
      const b = barometer(await categoryStats(type));
      return { ok: true, type, label: `rivens de ${CATEGORY_LABEL[type] || type}`, ...b };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // Tout l'historique du riven (y compris les points sans médiane warframe.market), du plus ancien au plus récent
  ipcMain.handle('riven:history', (_e, r) =>
    readHist().filter(h => h.key === keyOf(r)).sort((a, b) => new Date(a.date) - new Date(b.date)));

  ipcMain.handle('riven:sell', async (_e, { riven, price, polarity, live }) => {
    const body = sellPayload(riven, price, polarity);
    // Import AlecaFrame : une stat récente peut avoir une valeur inconnue (cache AlecaFrame), le nom peut manquer
    const missing = [...riven.stats.filter(s => s.value == null).map(s => `valeur de ${s.stat}`), ...(riven.riven_name ? [] : ['nom du riven'])];
    // Déjà en vente : une 2e annonce du même riven serait un doublon
    if (riven.auction_id) return { ok: false, text: `Déjà en vente (annonce ${riven.auction_id}${riven.listed_price ? `, ${riven.listed_price} pl` : ''}) : retire-la d'abord pour la remplacer.` };
    const warn = missing.length ? `\n⚠ Inconnu : ${missing.join(', ')} – envoi réel bloqué.` : '';
    if (!live) return { ok: true, text: 'SIMULATION – rien envoyé :\n' + JSON.stringify(body, null, 2) + warn };
    if (missing.length) return { ok: false, text: `Envoi bloqué : ${missing.join(', ')} inconnu(e)(s).` };
    if (!process.env.WFM_JWT) return { ok: false, text: 'Token warframe.market absent : renseigne-le dans Paramètres.' };
    const detail = `${riven.weapon} (${riven.riven_name})\nPrix : ${price} pl\nPolarité : ${polarity}\n` +
      riven.stats.map(s => `${s.positive ? '+' : '−'} ${s.stat} ${s.value}`).join('\n');
    if (!(await confirm(getWindow(), 'Publier cette annonce sur warframe.market ?', detail)))
      return { ok: false, text: 'Annulé.' };
    // Route /v1/auctions/create confirmée (liste des routes autorisées dans la DLL d'AlecaFrame, 2026-11-26).
    // TODO(à vérifier au 1er envoi réel) : méthode POST et format de la réponse (payload.auction.id).
    const res = await fetch(`${BASE}/auctions/create`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    const text = await res.text();
    let id = null; try { id = JSON.parse(text).payload.auction.id; } catch { /* format à vérifier */ }
    return { ok: res.ok, auctionId: id, text: `HTTP ${res.status}\n${text.slice(0, 800)}` };
  });

  ipcMain.handle('riven:unsell', async (_e, { riven, live }) => {
    if (!riven.auction_id) return { ok: false, text: "Pas d'auction_id (vends d'abord ce riven depuis l'outil)." };
    if (!live) return { ok: true, text: `SIMULATION – fermerait l'annonce ${riven.auction_id}` };
    if (!process.env.WFM_JWT) return { ok: false, text: 'Token warframe.market absent : renseigne-le dans Paramètres.' };
    if (!(await confirm(getWindow(), "Retirer l'annonce ?", `${riven.weapon} (${riven.riven_name})\nannonce ${riven.auction_id}`)))
      return { ok: false, text: 'Annulé.' };
    // Route /v1/auctions/entry/{id}/close confirmée (DLL d'AlecaFrame). TODO(à vérifier au 1er essai) : méthode PUT.
    const res = await fetch(`${BASE}/auctions/entry/${encodeURIComponent(riven.auction_id)}/close`, { method: 'PUT', headers: headers(true) });
    return { ok: res.ok, text: `HTTP ${res.status}\n${(await res.text()).slice(0, 800)}` };
  });

  // Import direct depuis AlecaFrame (lastData.dat) : remplace l'OCR. Lecture seule côté warframe.market.
  ipcMain.handle('riven:import', async (_e, { includeListed = false, prune = false } = {}) => {
    let existing = [];
    if (fs.existsSync(jsonPath())) {
      try { existing = JSON.parse(fs.readFileSync(jsonPath(), 'utf8')); }
      catch (e) { return { ok: false, text: `${jsonPath()} illisible (${e.message}) : import annulé, rien n'a été écrit.` }; }
    }
    try {
      const r = await importFromAlecaFrame(existing, { includeListed, prune });
      if (r.removed.length) fs.writeFileSync(jsonPath() + '.bak', JSON.stringify(existing, null, 2));
      fs.writeFileSync(jsonPath(), JSON.stringify(r.rivens, null, 2));
      const lines = [
        `Inventaire AlecaFrame du ${new Date(r.sourceDate).toLocaleString()} : ${r.inventoryRivens} riven(s) dévoilé(s)`,
        r.auctionsInfo,
        `${r.added} ajouté(s), ${r.updated} mis à jour, ${r.skippedListed} déjà en vente ignoré(s), ${r.removed.length} retiré(s)`,
        ...r.removed.map(x => `Retiré (plus dans l'inventaire) : ${x.weapon} ${x.riven_name || ''}`.trim()),
        ...(r.removed.length ? [`Sauvegarde avant nettoyage : ${jsonPath()}.bak`] : []),
        ...r.log, ...r.warnings,
      ];
      return { ok: true, text: lines.join('\n') };
    } catch (e) { return { ok: false, text: `Import impossible : ${e.message}` }; }
  });
}

module.exports = { registerRivenIpc, marketPrice, suggestPrice, planNotifications, parseLoose, deWeeklyStats, deFor,
                   barometer, categoryStats, rivenTypeOf, sellPayload, attributePayload, keyOf, loadEnv };
