// Pulse card tests: actions. Run: cd tests && npm test (or node --test actions.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, whyAll, mk, withRooms, real, quietRoom, day, b, over } from './helpers.mjs';

// ── Step 5: tap feedback, one lights wording, room page by subsystem ─────────────────────────────
const fakeEl = (dataset, extra = {}) => ({ dataset, ...extra });

const scenesHass = (over = {}) => ({
  ...withRooms([quietRoom('parlour', { lights_on: 2, scene: 'parlour lamps' })], [], { 'scene.parlour_lamps': { state: '2026-10-25T18:00:00+00:00', last_changed: '2026-10-25T18:00:00+00:00', attributes: { friendly_name: 'Parlour lamps' } }, ...over }),
});

const SCENE_TAP = { act: 'scene', entity: 'scene.parlour_lamps' };

const tileBusy = (html) => /<button type="button" class="hm-scene[^"]*" data-act="scene" data-entity="scene\.parlour_lamps" aria-pressed="[a-z]+" aria-busy="true">/.test(html);

// ── Write paths per entity ───────────────────────────────────────────────────────────────────
// Every entity the card can write, enumerated from the tables it reads (room table, settings rows, Mo toggles,
// house numbers, cameras), must pass; anything else must throw.
const writableEntities = () => {
  const out = []; // [domain, service, entity]
  for (const r of P.ROOM_TABLE) {
    out.push(['scene', 'turn_on', `scene.${r.key}_anything_at_all`]);
    for (const [id] of r.lights || []) {
      const d = id.split('.')[0];
      out.push([d, 'turn_on', id], [d, 'turn_off', id]);
    }
    for (const [id] of r.media || []) for (const s of ['media_play_pause', 'volume_set', 'turn_on', 'turn_off']) out.push(['media_player', s, id]);
    for (const g of r.settings) for (const row of g.rows) {
      if (row.kind === 'toggle') out.push(['input_boolean', 'turn_on', row.id], ['input_boolean', 'turn_off', row.id]);
      else out.push(['input_number', 'set_value', row.id]);
    }
    if (r.kind === 'room') out.push(['input_boolean', 'turn_on', `input_boolean.${r.key}_automation_presence_override`]); // keepOccupiedRow
    if (r.theme) out.push(['input_select', 'select_option', r.theme], ['input_boolean', 'turn_on', `input_boolean.${r.key}_light_theme_calendar_enabled`]);
  }
  for (const d of Object.values(P.MO_TOGGLES)) out.push(['input_boolean', 'turn_on', d.id], ['input_boolean', 'turn_off', d.id]);
  for (const d of Object.values(P.HOUSE_NUMBERS)) out.push(['input_number', 'set_value', d.id]);
  out.push(['input_number', 'set_value', P.HOUSE_VACATION_HOURS], ['input_select', 'select_option', P.HOUSE_MODIFIER]);
  for (const id of ['input_boolean.house_heating_enabled', 'input_boolean.wfh_adam', 'input_boolean.wfh_sarah']) out.push(['input_boolean', 'turn_on', id], ['input_boolean', 'turn_off', id]);
  for (const c of P.CAMERAS) {
    out.push(['switch', 'turn_on', `switch.${c.k}_privacy`], ['switch', 'turn_off', `switch.${c.k}_privacy`]);
    for (const dir of Object.keys(P.PTZ_DIRS)) out.push(['button', 'press', `button.${c.k}_move_${dir}`]);
  }
  out.push(['switch', 'turn_on', 'switch.bathroom_fan_extractor'], ['switch', 'turn_off', 'switch.bathroom_fan_extractor']);
  return out;
};

// ── Haptics ──────────────────────────────────────────────────────────────────────────────────────
const fakeNode = () => { const events = []; return { events, dispatchEvent: (e) => { events.push(e); return true; } }; };

test('unknown room and unknown mode fail loudly', () => {
  assert.throws(() => whyAll({ room: 'attic' }, mk(), NOW), /needs a known room/);
  assert.throws(() => P.render('nope', {}, mk(), NOW), /unknown mode/);
});

test('write paths are whitelisted; others throw', () => {
  const calls = [];
  const hass = { states: { 'light.parlour_light_floor_lamp': { state: 'off' }, 'media_player.parlour': { state: 'playing' } }, callService: (d, s, data) => calls.push([d, s, data]) };
  const el = (act, entity) => ({ dataset: { act, entity } });
  P.handleAction(hass, el('scene', 'scene.parlour_lamps'));
  P.handleAction(hass, el('toggle', 'light.parlour_light_floor_lamp'));
  P.handleAction(hass, el('brightness', 'light.parlour_light_floor_lamp'), '40');
  P.handleAction(hass, el('brightness', 'light.parlour_light_floor_lamp'), '0');
  P.handleAction(hass, el('media-play', 'media_player.parlour'));
  P.handleAction(hass, el('volume', 'media_player.parlour'), '28');
  assert.deepEqual(calls.map((c) => `${c[0]}.${c[1]}`), ['scene.turn_on', 'light.turn_on', 'light.turn_on', 'light.turn_off', 'media_player.media_play_pause', 'media_player.volume_set']);
  assert.equal(calls[5][2].volume_level, 0.28);
  assert.throws(() => P.callService(hass, 'mqtt', 'publish', {}), /not an allowed write path/);
  assert.throws(() => P.callService(hass, 'homeassistant', 'restart', {}), /not an allowed write path/);
  assert.throws(() => P.callService(hass, 'light', 'toggle', {}), /not an allowed write path/);
});

test('this step adds no write paths', () => {
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
});

test('pending: a tap marks the control busy at once; a state change clears it', async () => {
  const calls = [];
  const hass = { ...scenesHass(), callService: (d, sv, data) => { calls.push(`${d}.${sv}:${data.entity_id}`); return Promise.resolve(); } };
  const ui = { pending: {}, error: null };
  assert.ok(!tileBusy(P.render('lights', { room: 'parlour' }, hass, NOW, ui)), 'idle control is not busy');
  const done = P.perform(hass, ui, fakeEl(SCENE_TAP), undefined, NOW);
  assert.deepEqual(calls, ['scene.turn_on:scene.parlour_lamps'], 'the write was started synchronously');
  assert.ok(tileBusy(P.render('lights', { room: 'parlour' }, hass, NOW + 1000, ui)), 'busy straight away, before HA answers');
  assert.equal(P.pendingFor(ui, hass, SCENE_TAP, NOW + 1000).waiting, true);
  await done;
  // Same state, still waiting: a repaint must not clear it early.
  assert.ok(tileBusy(P.render('lights', { room: 'parlour' }, hass, NOW + 7999, ui)));
  // The scene entity moves (HA stamps it on activation): cleared.
  const moved = scenesHass({ 'scene.parlour_lamps': { state: '2026-10-25T18:42:01+00:00', last_changed: '2026-10-25T18:42:01+00:00', attributes: {} } });
  assert.ok(!tileBusy(P.render('lights', { room: 'parlour' }, moved, NOW + 2000, ui)), 'cleared by a state change');
  assert.equal(P.pendingFor(ui, moved, SCENE_TAP, NOW + 2000), null);
  // last_changed alone moving counts too (a toggle that lands in the state it was already shown in).
  const hass2 = scenesHass();
  P.pendingStart(ui, hass2, SCENE_TAP, NOW);
  const touched = scenesHass({ 'scene.parlour_lamps': { state: '2026-10-25T18:00:00+00:00', last_changed: '2026-10-25T18:42:05+00:00', attributes: {} } });
  assert.equal(P.pendingFor(ui, touched, SCENE_TAP, NOW + 100), null, 'cleared by last_changed');
});

test('pending: cleared by the 8 s timeout, and a skewed clock cannot make it immortal or negative', () => {
  const hass = scenesHass();
  const ui = { pending: {} };
  assert.equal(P.PENDING_MS, 8000);
  P.pendingStart(ui, hass, SCENE_TAP, NOW);
  assert.equal(P.pendingFor(ui, hass, SCENE_TAP, NOW + P.PENDING_MS - 1).waiting, true);
  const late = P.pendingFor(ui, hass, SCENE_TAP, NOW + P.PENDING_MS);
  assert.deepEqual([late.waiting, late.timedOut], [false, true]);
  assert.ok(!tileBusy(P.render('lights', { room: 'parlour' }, hass, NOW + P.PENDING_MS, ui)), 'no longer busy after the timeout');
  assert.equal(P.pendingFor(ui, hass, SCENE_TAP, NOW - 60000).waiting, true, 'a clock before the tap reads as just tapped');
  // Nothing to wait for: an unknown target sets no mark.
  assert.equal(P.pendingStart(ui, hass, { act: 'scene', entity: 'scene.nope' }, NOW), null);
  assert.equal(P.pendingStart(ui, hass, { act: 'camera-ptz', camera: 'garage', dir: 'up' }, NOW), null);
  assert.throws(() => P.pendingStart(null, hass, SCENE_TAP, NOW), /needs the card ui state/);
});

test('pending: every kind of write is covered (toggle, select, number, slider, media, garden) and keys differ per control', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const hass = mk({
    'switch.parlour_plug_table_lamp': b('on'), 'light.parlour_light_floor_lamp': b('on'), 'input_select.house_active_mode_modifier': b('none'),
    'input_number.global_temperature_comfort': b('20'), 'input_number.bathroom_automation_fan_min_run': b('10'), 'input_number.house_automation_vacation_threshold_hours': b('48'),
    'media_player.parlour': b('playing'),
  });
  const ui = { pending: {} };
  const taps = [
    { act: 'toggle', entity: 'switch.parlour_plug_table_lamp' }, { act: 'brightness', entity: 'light.parlour_light_floor_lamp' },
    { act: 'house-modifier', option: 'guest' }, { act: 'house-number', key: 'comfort', delta: '1' }, { act: 'house-number', key: 'comfort', delta: '-1' },
    { act: 'setting-number', room: 'bathroom', group: 'fan', key: 'min_run', delta: '1' }, { act: 'house-threshold', delta: '1' },
    { act: 'media-play', entity: 'media_player.parlour' }, { act: 'volume', entity: 'media_player.parlour' },
  ];
  hass.states['switch.bathroom_fan_extractor'] = b('off');
  for (const t of taps) assert.ok(P.pendingStart(ui, hass, t, NOW), `${t.act} marks pending`);
  assert.equal(Object.keys(ui.pending).length, taps.length, 'the + and - buttons are separate controls');
  assert.equal(P.pendingKey({ b: '1', a: '2' }), P.pendingKey({ a: '2', b: '1' }), 'key does not depend on attribute order');
  const html = P.markPending('<button class="tog tap" data-act="toggle" data-entity="switch.parlour_plug_table_lamp" aria-pressed="true"></button><button data-act="toggle" data-entity="switch.other"></button><a data-act="nav" data-path="/x"></a>', ui, hass, NOW);
  assert.match(html, /data-entity="switch\.parlour_plug_table_lamp" aria-pressed="true" aria-busy="true">/);
  assert.equal((html.match(/aria-busy/g) || []).length, 1, 'only the tapped control, not its neighbours or links');
  const slider = P.markPending('<input type="range" data-act="brightness" data-entity="light.parlour_light_floor_lamp" aria-label="x">', ui, hass, NOW);
  assert.match(slider, /aria-label="x" aria-busy="true">/);
});

test('pending: a rejected service call renders the inline error and clears the pending state', async () => {
  const hass = { ...scenesHass(), callService: () => Promise.reject(new Error('boom')) };
  const ui = { pending: {}, error: null };
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    await P.perform(hass, ui, fakeEl(SCENE_TAP), undefined, NOW);
  } finally { console.warn = warn; }
  assert.equal(P.pendingFor(ui, hass, SCENE_TAP, NOW), null, 'the mark is cleared so the control is usable again');
  const html = P.render('lights', { room: 'parlour' }, hass, NOW + 100, ui);
  assert.match(html, /<div class="err" role="alert">Couldn&#39;t reach Parlour lamps<\/div>/);
  assert.ok(!tileBusy(html));
  assert.ok(logged.some((l) => /boom/.test(l)), 'the real error is logged, not swallowed');
  assert.doesNotMatch(P.render('lights', { room: 'parlour' }, hass, NOW + P.ERROR_MS, ui), /class="err"/, 'the message goes away by itself');
  // A synchronous throw (an unknown table key) is reported the same way and not left unhandled.
  const bad = { act: 'house-number', key: 'nope', delta: '1' };
  console.warn = () => {};
  try { await P.perform(hass, ui, fakeEl(bad), undefined, NOW); } finally { console.warn = warn; }
  assert.match(P.render('lights', { room: 'parlour' }, hass, NOW, ui), /Couldn&#39;t reach that/);
  // A later successful tap clears the old error.
  const okHass = { ...scenesHass(), callService: () => Promise.resolve() };
  await P.perform(okHass, ui, fakeEl(SCENE_TAP), undefined, NOW);
  assert.doesNotMatch(P.render('lights', { room: 'parlour' }, okHass, NOW, ui), /class="err"/);
  // Names fall back to the object part of the id when there is no friendly name.
  const nameless = { ...scenesHass({ 'scene.parlour_lamps': { state: 'x', attributes: {} } }), callService: () => Promise.reject(new Error('x')) };
  console.warn = () => {};
  try { await P.perform(nameless, ui, fakeEl(SCENE_TAP), undefined, NOW); } finally { console.warn = warn; }
  assert.match(P.render('lights', { room: 'parlour' }, nameless, NOW, ui), /Couldn&#39;t reach Parlour lamps/);
});

test('pending: disallowed writes still fail loudly, and are reported on the card', async () => {
  const hass = { ...scenesHass(), callService: () => assert.fail('must not be called') };
  const ui = { pending: {} };
  const warn = console.warn;
  console.warn = () => {};
  try { await P.perform(hass, ui, fakeEl({ act: 'toggle', entity: 'automation.x' }), undefined, NOW); } finally { console.warn = warn; }
  assert.match(P.render('lights', { room: 'parlour' }, hass, NOW, ui), /class="err"/);
});

test('every entity the card can write passes callService', () => {
  const sent = [];
  const hass = { callService: (...a) => sent.push(a) };
  const all = writableEntities();
  assert.ok(all.length > 150, `enumerated ${all.length} writes`);
  for (const [d, s, id] of all) P.callService(hass, d, s, { entity_id: id });
  assert.equal(sent.length, all.length);
});

test('the fan switch the bathroom view passes to the device row is writable', () => {
  const view = readFileSync(root + 'views/info-room-bathroom.yaml', 'utf8');
  const fan = /fan: (switch\.\S+)/.exec(view)[1];
  assert.ok(P.writeAllowed('switch', 'turn_on', fan) && P.writeAllowed('switch', 'turn_off', fan), fan);
});

test('every settings and house helper the card writes exists in packages/helpers.yaml', () => {
  const helpers = yaml.load(readFileSync(root + 'packages/helpers.yaml', 'utf8'));
  for (const [d, s, id] of writableEntities()) {
    const [dom, name] = id.split('.');
    if (!dom.startsWith('input_')) continue;
    assert.ok(name in helpers[dom], `${id} (${d}.${s}) has no helper in packages/helpers.yaml`);
  }
});

test('writes outside the patterns throw', () => {
  const hass = { callService: () => assert.fail('must not be called') };
  const bad = [
    ['light', 'toggle', 'light.parlour_light_floor_lamp'], // wrong service
    ['scene', 'create', 'scene.parlour_lamps'],
    ['lock', 'unlock', 'lock.front_door'], // wrong domain
    ['homeassistant', 'restart', 'homeassistant.x'],
    ['light', 'turn_on', 'light.not_in_the_room_table'], // right domain and service, unknown entity
    ['switch', 'turn_on', 'switch.garage_door'],
    ['media_player', 'turn_on', 'media_player.nowhere'],
    ['button', 'press', 'button.parlour_move_diagonal'],
    ['button', 'press', 'button.garage_move_up'],
    ['scene', 'turn_on', 'scene.garage_all'], // scene for an unknown room
    ['scene', 'turn_on', 'scene.parlour'], // no scene name after the room
    ['scene', 'turn_on', 'scene.parlourx_all'],
    ['scene', 'turn_on', 'light.parlour_all'],
    ['input_boolean', 'turn_on', 'input_boolean.patio_door_heating_suspended'], // a real helper the card does not own
    ['input_boolean', 'turn_on', 'input_boolean.anything'],
    ['input_boolean', 'toggle', 'input_boolean.house_heating_enabled'],
    ['input_number', 'set_value', 'input_number.bathroom_automation_shower_rise'], // calibration, not exposed on purpose
    ['input_number', 'set_value', 'input_number.front_garden_automation_porch_hold'],
    ['input_select', 'select_option', 'input_select.hallway_upstairs_heating_manual_mode'], // a room with no climate has no helper
    ['input_select', 'select_option', 'input_select.back_garden_heating_manual_mode'],
    ['input_select', 'select_option', 'input_select.parlour_heating_manual_mode\n'],
    ['input_select', 'select_option', 'input_select.xparlour_heating_manual_mode'],
    ['input_number', 'set_value', 'input_select.parlour_heating_manual_mode'],
    ['input_select', 'select_option', 'input_select.anything'],
    ['input_boolean', 'turn_on', 'input_boolean.house_heating_enabled\n'], // anchored
    ['input_boolean', 'turn_on', 'xinput_boolean.house_heating_enabled'],
  ];
  for (const [d, s, id] of bad) assert.throws(() => P.callService(hass, d, s, { entity_id: id }), /not an allowed write path/, `${d}.${s} ${id}`);
});

test('a call without a usable entity_id throws, for every domain and service', () => {
  const hass = { callService: () => assert.fail('must not be called') };
  for (const [d, svcs] of Object.entries(P.ALLOWED)) for (const s of Object.keys(svcs)) {
    for (const data of [undefined, null, {}, { entity_id: '' }, { entity_id: null }, { entity_id: ['light.parlour_light_floor_lamp'] }, { entity_id: { x: 1 } }, { option: 'x' }]) {
      assert.throws(() => P.callService(hass, d, s, data), /not an allowed write path/, `${d}.${s} ${JSON.stringify(data)}`);
    }
  }
  assert.throws(() => P.callService(hass, 'prototype', 'turn_on', { entity_id: 'x.y' }), /not an allowed write path/);
  assert.throws(() => P.callService(hass, '__proto__', 'x', { entity_id: 'x.y' }), /not an allowed write path/);
  assert.throws(() => P.callService(hass, 'light', 'constructor', { entity_id: 'light.parlour_light_floor_lamp' }), /not an allowed write path/);
});

test('scene patterns come from the room table, gardens included', () => {
  for (const k of ['front_garden', 'back_garden', 'parlour', 'home_office']) assert.ok(P.writeAllowed('scene', 'turn_on', `scene.${k}_all`), k);
  assert.ok(P.ROOM_TABLE.filter((r) => r.kind === 'garden').length >= 2);
  assert.ok(!P.writeAllowed('scene', 'turn_on', 'scene.shed_all'));
});

test('handleAction cannot be steered at an entity outside the table by a forged data-entity', () => {
  const hass = { states: {}, callService: () => assert.fail('must not be called') };
  for (const act of ['toggle', 'scene', 'brightness', 'media-play', 'media-power', 'volume']) {
    assert.throws(() => P.handleAction(hass, { dataset: { act, entity: 'lock.front_door' } }, '50'), /not an allowed write path|is not/, act);
  }
  assert.throws(() => P.handleAction(hass, { dataset: { act: 'toggle', entity: 'input_boolean.anything' } }), /not an allowed write path/);
  assert.throws(() => P.handleAction(hass, { dataset: { act: 'scene' } }), /not an allowed write path/);
});

test('every service call in the card goes through callService', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const direct = [...src.matchAll(/\.callService\s*\(/g)];
  assert.equal(direct.length, 1, 'hass.callService is called in exactly one place');
  const fn = src.slice(src.indexOf('function callService(hass'));
  assert.ok(fn.indexOf('.callService(') < fn.indexOf('\n  }\n'), 'and that place is callService itself');
  assert.ok(fn.indexOf('writeAllowed(domain, service, entity)') < fn.indexOf('.callService('), 'after the entity check');
  for (const other of ['callApi', 'fireEvent', 'callWS({ type: \'call_service', 'hass.connection.sendMessage', 'publish(']) assert.ok(!src.includes(other), `no ${other}`);
  for (const m of src.matchAll(/callWS\(\s*\{([^}]*)\}/g)) assert.match(m[1], /type:\s*'(history|recorder|media_source|config)\//, `callWS reads only: ${m[1]}`);
});

test('haptic: validates the type and dispatches a composed, bubbling event carrying it', () => {
  assert.deepEqual([...P.HAPTIC_TYPES].sort(), ['failure', 'heavy', 'light', 'medium', 'selection', 'success', 'warning']);
  for (const type of P.HAPTIC_TYPES) {
    const node = fakeNode();
    P.haptic(node, type);
    assert.equal(node.events.length, 1);
    const [ev] = node.events;
    assert.equal(ev.type, 'haptic');
    assert.equal(ev.detail, type);
    assert.equal(ev.bubbles, true);
    assert.equal(ev.composed, true);
  }
  assert.throws(() => P.haptic(fakeNode(), 'buzz'), /unknown haptic "buzz"/);
  assert.throws(() => P.haptic(null, 'buzz'), /unknown haptic/, 'a bad type throws even with no node');
  assert.doesNotThrow(() => P.haptic(null, 'light'));
  assert.doesNotThrow(() => P.haptic({}, 'light'));
});

test('haptic: every HAPTICS entry is an allowed type, and success is never used', () => {
  for (const [kind, type] of Object.entries(P.HAPTICS)) assert.ok(P.HAPTIC_TYPES.includes(type), kind);
  assert.ok(!Object.values(P.HAPTICS).includes('success'));
});

test('haptic: every action the card dispatches maps to a HAPTICS entry or is explicitly silent', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const handler = src.slice(src.indexOf('  function handleAction('), src.indexOf('  // ── Disclosure state'));
  const seen = new Set();
  for (const re of [/data-act="([a-z][a-z-]*)"/g, /\bact: '([a-z][a-z-]*)'/g, /dataset\.act === '([a-z][a-z-]*)'/g]) for (const m of src.matchAll(re)) seen.add(m[1]);
  for (const m of handler.matchAll(/case '([a-z][a-z-]*)':/g)) seen.add(m[1]);
  assert.ok(seen.size >= 20, `found the actions (${seen.size})`);
  for (const act of seen) assert.ok(Object.prototype.hasOwnProperty.call(P.ACT_HAPTIC, act), `action "${act}" needs a haptic decision in ACT_HAPTIC`);
  for (const act of Object.keys(P.ACT_HAPTIC)) assert.ok(seen.has(act), `ACT_HAPTIC lists "${act}" but the card has no such action`);
  for (const [act, kind] of Object.entries(P.ACT_HAPTIC)) assert.ok(kind === null || Object.prototype.hasOwnProperty.call(P.HAPTICS, kind), `${act} -> ${kind}`);
  const silent = Object.keys(P.ACT_HAPTIC).filter((a) => P.ACT_HAPTIC[a] === null).sort();
  assert.deepEqual(silent, ['camera-clip', 'camera-rec', 'camera-rec-refresh', 'disclose', 'nav']);
});

test('haptic: a tap plays the mapped type; silent actions and unknown actions behave', () => {
  const play = (act) => { const n = fakeNode(); P.tapHaptic(n, act); return n.events.map((e) => e.detail); };
  assert.deepEqual(play('scene'), ['selection']);
  assert.deepEqual(play('energy-day'), ['selection']);
  assert.deepEqual(play('cost-fuel'), ['selection']);
  assert.deepEqual(play('house-number'), ['selection']);
  assert.deepEqual(play('setting-number'), ['selection']);
  for (const a of ['toggle', 'setting-toggle', 'mo-toggle', 'camera-toggle', 'cameras-all', 'garden-power', 'media-power', 'camera-ptz', 'media-play', 'volume', 'brightness']) assert.deepEqual(play(a), ['light'], a);
  for (const a of ['nav', 'disclose', 'camera-rec', 'camera-clip']) assert.deepEqual(play(a), [], a);
  assert.throws(() => play('mystery'), /no haptic decision for "mystery"/);
});

test('haptic: failure plays once when the error is set, not on re-render, and not on success', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const node = fakeNode();
    const ui = { pending: {}, error: null };
    const bad = { ...scenesHass(), callService: () => Promise.reject(new Error('boom')) };
    await P.perform(bad, ui, fakeEl(SCENE_TAP), undefined, NOW, node);
    assert.deepEqual(node.events.map((e) => e.detail), ['failure']);
    for (let i = 0; i < 5; i += 1) P.render('lights', { room: 'parlour' }, bad, NOW + i * 100, ui);
    assert.equal(node.events.length, 1, 'rendering the error banner does not replay it');
    // A write the allow-list refuses ends in the same error state, and counts as one failure.
    await P.perform(bad, ui, fakeEl({ act: 'toggle', entity: 'automation.x' }), undefined, NOW, node);
    assert.equal(node.events.length, 2);
    const good = { ...scenesHass(), callService: () => Promise.resolve() };
    await P.perform(good, ui, fakeEl(SCENE_TAP), undefined, NOW, node);
    assert.equal(node.events.length, 2, 'a successful write plays no success haptic');
  } finally { console.warn = warn; }
});

test('haptic: rendering and hass tracking never take a node, and the hass setter plays nothing', () => {
  // render() and trackHass() are handed no element to dispatch from, so a repaint cannot play a haptic.
  assert.equal(P.render.length <= 5, true);
  assert.equal(P.trackHass.length, 1);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const from = src.indexOf('      set hass(hass) {');
  const setter = src.slice(from, src.indexOf('\n      }\n', from));
  assert.ok(setter.length > 50, 'found the hass setter');
  assert.doesNotMatch(setter, /haptic/i);
  const paint = src.slice(src.indexOf('      _paint(fromHass = false) {'), src.indexOf('\n      }\n', src.indexOf('      _paint(fromHass = false) {')));
  assert.ok(paint.length > 50, 'found _paint');
  assert.doesNotMatch(paint, /haptic/i);
});
