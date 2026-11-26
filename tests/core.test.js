'use strict';
// Tests unitaires des calculs (sans réseau, sans Electron) : npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backend = require('../rivenBackend');
const { mergeRivens } = require('../alecaframeImport');
const { updateEnvText, cleanValue, createSettings } = require('../settings');

const day = (d, volume, median, extra = {}) => ({ datetime: `2026-10-${String(d).padStart(2, '0')}T00:00:00`, volume, median, ...extra });

test('prix conseillé : passe 3 % sous le moins cher en ligne, sans aberrants', () => {
  const s = backend.suggestPrice({ weapon: 'Soma' }, { allPrices: [10, 100, 105, 110, 120, 130], prices: [100, 105], tierLabel: 'x' });
  assert.strictEqual(s.lowest, 100);
  assert.strictEqual(s.price, 95);
  assert.strictEqual(s.source, 'wfm');
});

test('prix conseillé : repli sur la médiane DE sans annonce comparable, rien sans donnée', () => {
  const s = backend.suggestPrice({ weapon: 'Soma' }, { allPrices: [], prices: [], de: { median: 95, min: 4, max: 2500, rerolled: true } });
  assert.strictEqual(s.price, 95);
  assert.strictEqual(s.confidence, 'faible');
  assert.strictEqual(backend.suggestPrice({ weapon: 'Soma' }, { allPrices: [], prices: [], de: null }), null);
});

test('baromètre (rivens, demande) : demande en hausse = bon, < 3 semaines = inconnu', () => {
  const rows = Array.from({ length: 30 }, (_, i) => day(i + 1, i < 15 ? 100 : 300, 10));
  assert.strictEqual(backend.barometer(rows).verdict.level, 'bon');
  assert.strictEqual(backend.barometer(rows.slice(0, 10)).verdict.level, 'inconnu');
});

test('baromètre (objets, prix) : prix au plus haut = bon ; prix au plus bas = attendre + achat', () => {
  const up = Array.from({ length: 30 }, (_, i) => day(i + 1, 100, i < 15 ? 50 : 80));
  assert.strictEqual(backend.barometer(up, { basis: 'price' }).verdict.level, 'bon');
  const down = Array.from({ length: 30 }, (_, i) => day(i + 1, 100, i < 15 ? 80 : 50));
  const v = backend.barometer(down, { basis: 'price' }).verdict;
  assert.strictEqual(v.level, 'attendre');
  assert.strictEqual(v.buy, true);
});

test('baromètre : cumule les lignes du même jour (rivens revealed + unrevealed)', () => {
  const rows = [day(1, 10, 8, { subtype: 'revealed' }), day(1, 30, 12, { subtype: 'unrevealed' })];
  const s = backend.barometer(rows).series;
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].vol, 40);
  assert.strictEqual(s[0].med, 11);
});

test('notifications : catégorie qui passe au vert (une fois) et vendeur moins cher que toi (une fois par prix)', () => {
  const mine = { weapon: 'Fang', auction_id: 'a1', listed_price: 100 };
  const free = { weapon: 'Soma' };
  const results = [
    { riven: mine, info: { prices: [90] }, catType: 'melee', catLabel: 'rivens de mêlée', catLevel: 'bon' },
    { riven: free, info: { prices: [] }, catType: 'melee', catLabel: 'rivens de mêlée', catLevel: 'bon' },
  ];
  const first = backend.planNotifications(results, {});
  assert.strictEqual(first.notes.length, 2);
  assert.match(first.notes[0].body, /Soma/);            // seuls les rivens pas déjà en vente sont proposés
  const again = backend.planNotifications(results, first.state);
  assert.strictEqual(again.notes.length, 0);             // rien de nouveau : pas de doublon
  const cheaper = backend.planNotifications([{ ...results[0], info: { prices: [80] } }], again.state);
  assert.strictEqual(cheaper.notes.length, 1);           // nouveau prix plus bas : nouvelle alerte
});

test('vente : damage_vs_* envoyé tel quel (multiplicateur), comme warframe.market le stocke', () => {
  assert.deepStrictEqual(backend.attributePayload({ stat: 'damage_vs_corpus', value: 1.47, positive: true }),
                         { url_name: 'damage_vs_corpus', positive: true, value: 1.47 });
});

test('stats DE : format non strict converti sans exécuter de code', () => {
  const d = backend.parseLoose("[ { itemType: 'Rifle Riven Mod', compatibility: 'Soma', rerolled: true, median: 95 } ]");
  assert.strictEqual(d[0].compatibility, 'Soma');
  assert.throws(() => backend.parseLoose('[ { a: process.exit(1) } ]'));
});

test('import : prix de ton annonce mémorisé, puis retiré quand l\'annonce disparaît', () => {
  const st = [{ stat: 'multishot', value: 10, positive: true }];
  const riven = { item_id: 'i1', weapon: 'Soma', weapon_url_name: 'soma', stats: st, pos: ['multishot'], neg: [], polarity: 'naramon' };
  const auction = { id: 'a1', buyout_price: 120, item: { weapon_url_name: 'soma', attributes: [{ url_name: 'multishot', positive: true }] } };
  const listed = mergeRivens([], [riven], [auction], { includeListed: true }).rivens[0];
  assert.strictEqual(listed.listed_price, 120);
  assert.strictEqual(listed.auction_id, 'a1');
  const gone = mergeRivens([listed], [riven], [], {}).rivens[0];
  assert.strictEqual(gone.auction_id, undefined);
  assert.strictEqual(gone.listed_price, undefined);
});

test('.env : mise à jour en gardant commentaires et autres clés ; suppression ; pas d\'injection', () => {
  const before = '# mon commentaire\nWFM_JWT = ancien\nAUTRE=garde\n';
  const after = updateEnvText(before, { WFM_JWT: 'nouveau', NOTIFY: '0' });
  assert.strictEqual(after, '# mon commentaire\nWFM_JWT=nouveau\nAUTRE=garde\nNOTIFY=0\n');
  assert.strictEqual(updateEnvText(after, { WFM_JWT: null }), '# mon commentaire\nAUTRE=garde\nNOTIFY=0\n');
  assert.throws(() => cleanValue('WFM_USERNAME', 'moi\nWFM_JWT=pirate'), /retour à la ligne/);
  assert.strictEqual(cleanValue('WFM_JWT', 'JWT abc.def'), 'abc.def');
});

test('réglages : le token est écrit dans le .env mais jamais renvoyé par get()', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-settings-'));
  const saved = process.env.WFM_JWT;
  try {
    const s = createSettings({ dir });
    const r = s.set({ WFM_JWT: 'secret-de-test', WFM_USERNAME: 'moi' });
    assert.strictEqual(r.hasToken, true);
    assert.ok(!JSON.stringify(r).includes('secret-de-test'));
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /WFM_JWT=secret-de-test/);
    s.set({ WFM_JWT: '' });
    assert.strictEqual(s.get().hasToken, false);
  } finally {
    if (saved === undefined) delete process.env.WFM_JWT; else process.env.WFM_JWT = saved;
    delete process.env.WFM_USERNAME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vente : un riven déjà en vente est refusé (pas de doublon), même en simulation', async () => {
  const handlers = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-ipc-'));
  try {
    backend.registerRivenIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, dialog: {}, getWindow: () => null, dir,
                               settings: { flag: () => false } });
    const riven = { weapon: 'Soma', riven_name: 'Crita-satis', auction_id: 'a1', listed_price: 50,
                    stats: [{ stat: 'multishot', value: 10, positive: true }] };
    const out = await handlers['riven:sell'](null, { riven, price: 40, polarity: 'naramon', live: false });
    assert.strictEqual(out.ok, false);
    assert.match(out.text, /Déjà en vente/);
    const sim = await handlers['riven:sell'](null, { riven: { ...riven, auction_id: undefined }, price: 40, polarity: 'naramon', live: false });
    assert.ok(sim.ok && sim.text.startsWith('SIMULATION'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
