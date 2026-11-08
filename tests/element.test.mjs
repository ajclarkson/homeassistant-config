// Pulse card tests: element. Run: cd tests && npm test (or node --test element.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { require, P, root, NOW, FULL, SCENES, registryFixture, withRooms, histEntry, histSensor, real, day, b, sheetHass, update, richHass, allCards, over } from './helpers.mjs';

test('card element: a repaint puts keyboard focus back on the control that had it (a stepper tapped twice)', async () => {
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, window: globalThis.window };
  let Card;
  const focused = [];
  const mkEl = (name, dataset) => ({ name, dataset, focus() { focused.push(name); } });
  const plus = { act: 'setting-number', room: 'bathroom', group: 'fan', key: 'min_run', delta: '1' };
  let live = [mkEl('plus-before', plus)];
  const shadow = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return live; }, activeElement: null, innerHTML: '' };
  globalThis.HTMLElement = class { constructor() { this.style = {}; } attachShadow() { return shadow; } };
  globalThis.customElements = { get() { return undefined; }, define(n, c) { if (n === 'pulse-card') Card = c; } };
  globalThis.window = { customCards: [], addEventListener() {}, removeEventListener() {} };
  try {
    const modPath = new URL('../www/pulse-card.js', import.meta.url).pathname;
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    const c = new Card();
    c.setConfig({ mode: 'automation', room: 'bathroom' });
    c.hass = sheetHass();
    assert.ok(shadow.innerHTML.includes('data-act="setting-number"'), 'the Automation list painted inline');
    assert.deepEqual(focused, [], 'nothing was focused, so nothing is restored');
    shadow.activeElement = live[0];
    live = [mkEl('plus-after', plus), mkEl('other', { act: 'setting-number', room: 'bathroom', group: 'fan', key: 'max_run', delta: '1' })];
    c.hass = sheetHass({ 'input_number.bathroom_automation_fan_min_run': b('10') });
    assert.deepEqual(focused, ['plus-after'], 'the repainted copy of the same control takes focus');
  } finally {
    Object.assign(globalThis, saved);
    if (saved.window === undefined) delete globalThis.window;
    if (saved.HTMLElement === undefined) delete globalThis.HTMLElement;
    if (saved.customElements === undefined) delete globalThis.customElements;
    delete require.cache[require.resolve(new URL('../www/pulse-card.js', import.meta.url).pathname)];
    require(new URL('../www/pulse-card.js', import.meta.url).pathname);
  }
});

test('card element: tapping a disclosure row opens it, remembers it in localStorage, and a hass update keeps it open', async () => {
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, window: globalThis.window };
  let Card;
  const listeners = {};
  const stored = {};
  const shadow = { addEventListener(t, f) { listeners[t] = f; }, querySelector() { return null; }, querySelectorAll() { return []; }, activeElement: null, innerHTML: '' };
  globalThis.HTMLElement = class { constructor() { this.style = {}; } attachShadow() { return shadow; } };
  globalThis.customElements = { get() { return undefined; }, define(n, c) { if (n === 'pulse-card') Card = c; } };
  globalThis.window = { customCards: [], addEventListener() {}, removeEventListener() {}, localStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } } };
  try {
    const modPath = new URL('../www/pulse-card.js', import.meta.url).pathname;
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    const c = new Card();
    c.setConfig({ mode: 'automation', room: 'bathroom' });
    c.hass = sheetHass();
    assert.match(shadow.innerHTML, /aria-expanded="false"/);
    assert.match(shadow.innerHTML, /id="dp-bathroom-automation" hidden>/);
    const tap = { closest: () => ({ dataset: { act: 'disclose', id: 'bathroom:automation' } }) };
    listeners.click({ target: tap });
    assert.match(shadow.innerHTML, /aria-expanded="true"/);
    assert.doesNotMatch(shadow.innerHTML, /id="dp-bathroom-automation" hidden/);
    assert.equal(stored['pulse-card:open'], '{"bathroom:automation":true}');
    c.hass = sheetHass({ 'input_number.bathroom_automation_fan_min_run': b('12') });
    assert.match(shadow.innerHTML, /aria-expanded="true"/, 'a repaint from hass keeps it open');
    listeners.click({ target: tap });
    assert.match(shadow.innerHTML, /aria-expanded="false"/);
    assert.equal(stored['pulse-card:open'], '{}');
    // A reload reads it back; storage that throws or holds rubbish leaves everything closed.
    stored['pulse-card:open'] = '{"bathroom:automation":true,"bad id":true,"x:y":1}';
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    assert.deepEqual({ ...globalThis.window.PulseLib.disclosureStore }, { 'bathroom:automation': true });
    globalThis.window.localStorage.getItem = () => { throw new Error('blocked'); };
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    assert.deepEqual({ ...globalThis.window.PulseLib.disclosureStore }, {});
  } finally {
    Object.assign(globalThis, saved);
    if (saved.window === undefined) delete globalThis.window;
    if (saved.HTMLElement === undefined) delete globalThis.HTMLElement;
    if (saved.customElements === undefined) delete globalThis.customElements;
    delete require.cache[require.resolve(new URL('../www/pulse-card.js', import.meta.url).pathname)];
    require(new URL('../www/pulse-card.js', import.meta.url).pathname);
  }
});

test('render cost: a parsed attribute is the same object for the same state object, and re-parsed after replacement', () => {
  const hass = withRooms(P.ROOM_ORDER.map(FULL), []);
  const a = P.parsedAttr(hass, 'sensor.info_rooms', 'rooms', P.parseList);
  assert.equal(P.parsedAttr(hass, 'sensor.info_rooms', 'rooms', P.parseList), a);
  assert.equal(P.parsedAttr(update(hass, { 'sensor.unrelated_9': { state: '1', attributes: {} } }), 'sensor.info_rooms', 'rooms', P.parseList), a, 'unrelated update keeps the parse');
  const old = hass.states['sensor.info_rooms'];
  const next = update(hass, { 'sensor.info_rooms': { state: 'ok', attributes: { rooms: old.attributes.rooms } } });
  assert.notEqual(P.parsedAttr(next, 'sensor.info_rooms', 'rooms', P.parseList), a, 'replaced state object parses again');
  assert.deepEqual(P.parsedAttr(next, 'sensor.info_rooms', 'rooms', P.parseList), a);
  assert.deepEqual(P.parsedAttr(hass, 'sensor.nope', 'rooms', P.parseList), []);
  assert.throws(() => P.parsedAttr(hass, 'sensor.info_rooms', 'rooms'), /needs a parser/);
  P.setOptimise(false);
  try { assert.notEqual(P.parsedAttr(hass, 'sensor.info_rooms', 'rooms', P.parseList), P.parsedAttr(hass, 'sensor.info_rooms', 'rooms', P.parseList)); } finally { P.setOptimise(true); }
});

test('render cost: output is byte-identical with and without the optimisations, for every section and the gate', () => {
  const hass = richHass();
  const cards = allCards();
  assert.ok(cards.length > 70, `cards ${cards.length}`);
  const plain = (h) => cards.map(([, m, c, ui]) => P.render(m, c, h, NOW, ui));
  P.setOptimise(false);
  let off;
  try { off = plain(hass); } finally { P.setOptimise(true); }
  const on = plain(hass);
  cards.forEach(([label], i) => assert.equal(on[i], off[i], label));
  assert.ok(off.filter(Boolean).length > 60, 'the fixture renders real content');
  const gates = cards.map(() => P.makeRenderGate());
  const viaGate = cards.map(([, m, c, ui], i) => gates[i].run(m, c, hass, NOW, ui, false).html);
  cards.forEach(([label], i) => assert.equal(viaGate[i], off[i], `gate ${label}`));
  // And after a run of skipped updates the held output is still the output a fresh render gives.
  const later = update(hass, { 'sensor.unrelated_0': { state: '1', attributes: {} } });
  cards.forEach(([label, m, c, ui], i) => assert.equal(gates[i].run(m, c, later, NOW + 1000, ui, false).html, P.render(m, c, later, NOW + 1000, ui), `after update ${label}`));
});

test('disclosure: the render gate skips an unchanged repaint, redraws on a toggle and keeps the state across a hass update', () => {
  const gate = P.makeRenderGate();
  const cfg = { room: 'bedroom' };
  const hass = richHass();
  const ui = { open: {} };
  const first = gate.run('lights', cfg, hass, NOW, ui, false);
  assert.equal(gate.run('lights', cfg, hass, NOW, ui, false).skipped, true, 'unchanged: the repaint is skipped, so nothing re-animates');
  ui.open['bedroom:lights'] = true;
  const opened = gate.run('lights', cfg, hass, NOW, ui, false);
  assert.equal(opened.skipped, false);
  assert.notEqual(opened.html, first.html);
  assert.equal(gate.run('lights', cfg, update(hass, { 'sensor.unrelated_0': { state: '1', attributes: {} } }), NOW, ui, false).html, opened.html, 'a hass update keeps the row open');
});

test('render cost: an unrelated entity change skips, a read entity, the registry, config or ui re-render', () => {
  const hass = richHass();
  const g = P.makeRenderGate();
  const cfg = { room: 'bedroom' };
  const ui = {};
  assert.equal(g.run('room-head', cfg, hass, NOW, ui, false).skipped, false, 'first run renders');
  const un = update(hass, { 'sensor.unrelated_0': { state: '5', attributes: {} }, 'sensor.brand_new': { state: 'x', attributes: {} } });
  assert.equal(g.run('room-head', cfg, un, NOW + 1000, ui, false).skipped, true, 'unrelated change');
  assert.equal(g.run('room-head', cfg, hass, NOW + 2000, ui, false).skipped, true, 'same hass');
  assert.equal(g.run('room-head', cfg, un, NOW + 3000, ui, true).skipped, false, 'forced');
  // A read entity: the room report, then a plain state the model falls back on.
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), temp: k === 'bedroom' ? 23.1 : 20.8 }));
  const changed = update(un, { 'sensor.info_rooms': { state: 'ok', attributes: { rooms: JSON.stringify(rooms) } } });
  const r = g.run('room-head', cfg, changed, NOW + 4000, ui, false);
  assert.equal(r.skipped, false, 'read entity');
  assert.match(r.html, /23\.1°/);
  assert.equal(g.run('room-head', cfg, update(changed, {}), NOW + 5000, ui, false).skipped, true);
  // The registry: scenes come from hass.entities / hass.devices.
  const lights = (h, c) => g.run('lights', c, h, NOW + 6000, ui, false);
  assert.equal(lights(changed, cfg).skipped, false);
  const reg = registryFixture({ ...SCENES, bedroom: ['all', 'off'] });
  const newReg = lights({ ...changed, entities: reg.entities, devices: reg.devices }, cfg);
  assert.equal(newReg.skipped, false, 'registry');
  assert.doesNotMatch(newReg.html, /scene\.bedroom_lamps/);
  const afterReg = { ...changed, entities: reg.entities, devices: reg.devices };
  assert.equal(lights(afterReg, cfg).skipped, true);
  assert.equal(lights({ ...afterReg, devices: { ...reg.devices } }, cfg).skipped, false, 'devices');
  // Another hass property that is read is tracked by identity too.
  const g2 = P.makeRenderGate();
  const probe = (h) => g2.run('now-header', {}, h, NOW, {}, false).skipped;
  const { view, deps } = P.trackHass({ ...hass, user: { name: 'a' } });
  void view.user;
  assert.equal(P.depsUnchanged(deps, { ...hass, user: deps.props.get('user') }), true);
  assert.equal(P.depsUnchanged(deps, { ...hass, user: { name: 'a' } }), false, 'hass.user');
  assert.equal(probe(hass), false);
  // Config and mode.
  assert.equal(g.run('lights', { room: 'bedroom' }, afterReg, NOW + 7000, ui, false).skipped, false, 'a new config object');
  assert.equal(g.run('room-head', { room: 'bedroom' }, afterReg, NOW + 7000, ui, false).skipped, false, 'a new mode');
  // The ui state: the top guard, a pending mark, the day tab.
  const cfgSame = { room: 'bedroom' };
  const sui = { top: 0, pending: {} };
  const head = (u) => g.run('room-head', cfgSame, afterReg, NOW + 8000, u, false);
  assert.equal(head(sui).skipped, false);
  assert.equal(head(sui).skipped, true);
  sui.top = 63;
  assert.equal(head(sui).skipped, false, 'top guard sized');
  assert.match(head({ ...sui }).html, /data-top-guard/);
  const lightId = Object.keys(afterReg.states).find((id) => id.startsWith('light.'));
  const pendingUi = { pending: {} };
  const lg = (u) => g.run('lights', cfgSame, afterReg, NOW + 8000, u, false);
  lg(pendingUi);
  assert.equal(lg(pendingUi).skipped, true);
  P.pendingStart(pendingUi, afterReg, { act: 'toggle', entity: lightId }, NOW + 8000);
  assert.equal(lg(pendingUi).skipped, false, 'pending mark');
  assert.equal(g.run('lights', cfgSame, afterReg, NOW + 8000, { pending: {}, error: { text: 'x', at: NOW } }, false).skipped, false, 'error banner');
  // Untrackable reads never skip.
  assert.equal(P.depsUnchanged({ states: new Map(), props: new Map(), keys: null, opaque: true }, hass), false);
  const sp = P.trackHass(hass);
  Object.keys(sp.view); // eslint-disable-line no-unused-expressions
  assert.equal(sp.deps.opaque, true, 'listing hass itself');
  const hasOwn = P.trackHass(hass);
  Object.prototype.hasOwnProperty.call(hasOwn.view.states, 'person.adam');
  assert.equal(hasOwn.deps.opaque, true, 'a descriptor lookup on states');
  assert.throws(() => { P.trackHass(hass).view.states['x.y'] = {}; }, /must not write/);
  assert.throws(() => P.trackHass(null), /needs a hass object/);
});

test('render cost: listing the states is tracked by the ids, so a new scene shows', () => {
  const hass = richHass();
  const g = P.makeRenderGate();
  const cfg = { room: 'front_garden' };
  g.run('garden-theme', cfg, hass, NOW, {}, false);
  assert.equal(g.run('garden-theme', cfg, update(hass, { 'sensor.unrelated_0': { state: '9', attributes: {} } }), NOW + 1, {}, false).skipped, true);
  const scene = { state: '2026-10-25T18:00:00+00:00', attributes: {} };
  assert.equal(g.run('garden-theme', cfg, update(hass, { 'scene.front_garden_normal': scene }), NOW + 2, {}, false).skipped, false);
});

test('render cost: relative-time text refreshes after the maximum age and never goes backwards in time', () => {
  // the rooms list shows elapsed time only for a lit room whose scene was set in the last 15 minutes
  const hass = update(withRooms(P.ROOM_ORDER.map((k) => FULL(k)).map((r) => (r.k === 'kitchen' ? { ...r, lights_on: 2, pres_labels: [], heat_labels: [], manual: null } : r)), []), {
    ...histSensor('kitchen', [histEntry(3, { decision: 'activate_scene', outcome: undefined })]),
    'sensor.kitchen_active_scene': { state: 'kitchen_cabinets', attributes: {} },
  });
  const g = P.makeRenderGate();
  const ui = {};
  const kcfg = {};
  const run = (at) => g.run('rooms', kcfg, update(hass), at, ui, false);
  const first = run(NOW);
  assert.equal(run(NOW + P.RENDER_MAX_AGE_MS - 1).skipped, true);
  assert.equal(run(NOW + P.RENDER_MAX_AGE_MS).skipped, false, 'a quiet house still repaints on the tick');
  assert.equal(run(NOW + P.RENDER_MAX_AGE_MS + 1).skipped, true);
  assert.equal(run(NOW - 1).skipped, false, 'clock moved back');
  const later = P.makeRenderGate().run('rooms', {}, hass, NOW + 5 * 60000, ui, false);
  assert.notEqual(later.html, first.html, 'the fixture does show elapsed time');
  assert.equal(g.run('rooms', {}, hass, NOW + 5 * 60000, ui, false).html, later.html);
  for (const bad of [0, 999, 60001, NaN, '15000']) assert.throws(() => P.makeRenderGate(bad), /max age/);
});

test('render cost: a throwing render is not cached, and the pass state is restored', () => {
  const hass = richHass();
  const g = P.makeRenderGate();
  assert.throws(() => g.run('heating', { room: 'nowhere' }, hass, NOW, {}, false), /known room/);
  assert.throws(() => g.run('heating', { room: 'nowhere' }, hass, NOW, {}, false), /known room/);
  assert.equal(g.run('heating', { room: 'bedroom' }, hass, NOW, {}, false).skipped, false);
  // After a render has thrown, a direct roomModel call is fresh, not served from a finished pass.
  const a = P.roomModel(hass, 'bedroom');
  assert.notEqual(P.roomModel(hass, 'bedroom'), a);
});

test('render cost: measured skip rate over hass updates where only unrelated entities change', () => {
  let hass = richHass();
  const cards = allCards().filter(([, m]) => m !== 'camera'); // camera cards repaint on every update by design
  const gates = cards.map(() => P.makeRenderGate());
  const step = (h, at) => cards.map(([, m, c, ui], i) => gates[i].run(m, c, h, at, ui, false));
  step(hass, NOW);
  let skipped = 0; let total = 0; let t = NOW;
  for (let i = 1; i <= 100; i += 1) {
    t += 1000; // 100 s of updates, one a second; the age tick fires every 15 s
    hass = update(hass, { [`sensor.unrelated_${i % 7}`]: { state: String(i), attributes: {} } });
    for (const r of step(hass, t)) { total += 1; if (r.skipped) skipped += 1; }
  }
  const rate = skipped / total;
  console.log(`   skip rate: ${skipped}/${total} card paints skipped (${(rate * 100).toFixed(1)}%) over 100 unrelated updates, ${cards.length} cards`);
  assert.ok(rate > 0.8, `skip rate ${rate}`);
});

test('render cost: the card only skips on a hass update', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const paints = [...src.matchAll(/this\._paint\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(paints.filter((a) => a === 'true').length, 1, 'only `set hass` passes true');
  assert.match(src, /set hass\(hass\) \{[^}]*this\._paint\(true\)/s);
  assert.match(src, /!fromHass/);
});
