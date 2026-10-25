// Offline tests for www/pulse-card.js and the YAML that drives it.
// Run: cd tests && npm install && node pulse-card.test.mjs
// Covers: every mode for all 10 rooms with full, sparse and missing report data; attention vs
// calm; manual set/null; empty, 50-slot and garbage rate lists (via the data_generator strings
// extracted from the real YAML); unknown rooms and disallowed services fail loudly.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const P = require('../www/pulse-card.js');
const root = new URL('..', import.meta.url).pathname;
let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log('ok', name); };

const NOW = Date.parse('2026-10-25T18:42:00Z');
const BASE = 'sensor.octopus_energy_electricity_24e8140196_1012483035417';
const FULL = (k) => ({
  k, n: k, nav: '/x', occupied: true, occupancy_unavailable: false, unavailable: [], temp: 20.8, target: 5.0,
  mode_target: 18.0, target_reason: 'window open', mode_name: 'baseline day', pres_labels: ['Bed occupied'],
  heat_labels: ['Window open'], humidity: 63, hvac_action: 'idle', heating_active: 'baseline_day',
  heating_source: 'schedule', lights_on: 0, lights_total: 3, scene: 'off', lights_enabled: true,
  heating_enabled: true, override: false, ext_open: true, holds: [], reason_text: 'Bed occupied · Window open',
  override_text: '', labels: ['Bed occupied', 'Window open'], manual: null, lights_why: 'sleep hold',
  lights_ts: '2026-10-25T18:30:00+00:00', last: 'x', last_ts: '2026-10-25T18:30:00+00:00', verdict: 'Occupied · lights off',
});
const mk = (over = {}) => {
  const states = {
    'person.adam': { state: 'home', attributes: {} }, 'person.sarah': { state: 'not_home', attributes: {} },
    'input_boolean.wfh_adam': { state: 'on', attributes: {} }, 'sensor.house_active_mode': { state: 'normal', attributes: {} },
    'input_select.house_active_mode_modifier': { state: 'none', attributes: {} },
    [`${BASE}_current_rate`]: { state: '0.348', attributes: {} }, [`${BASE}_next_rate`]: { state: '0.412', attributes: {} },
    'sensor.glow_electricity_power': { state: '412', attributes: {} },
    'sensor.cheapest_2h_waking_start': { state: '02:00', attributes: {} }, 'sensor.cheapest_2h_waking_end': { state: '04:00', attributes: {} },
    'sensor.cheapest_2h_waking_avg_rate': { state: '9.8', attributes: {} },
    'binary_sensor.octopus_tomorrow_data_available': { state: 'on', attributes: {} },
    'sensor.octopus_tomorrow_negative_windows': { state: '13:30–14:30 (-2p)', attributes: {} },
    'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '1', attributes: {} },
    'sensor.st_albans_collect_domestic_food_days_until_collection': { state: '5', attributes: {} },
    'sensor.st_albans_collect_domestic_recycling_days_until_collection': { state: 'unknown', attributes: {} },
    'input_boolean.house_heating_enabled': { state: 'on', attributes: {} },
    'binary_sensor.house_heating_boiler_firing': { state: 'on', attributes: {} },
    'light.parlour_light_floor_lamp': { state: 'on', attributes: { brightness: 102, supported_color_modes: ['brightness'], friendly_name: 'Floor lamp' } },
    'switch.parlour_plug_table_lamp': { state: 'on', attributes: {} },
    'media_player.parlour': { state: 'playing', attributes: { volume_level: 0.28, media_title: 'Song' } },
    'media_player.parlour_tv': { state: 'off', attributes: {} },
    'sensor.parlour_active_scene': { state: 'parlour_lamps', attributes: {} },
    'input_boolean.bedroom_automation_lights_enabled': { state: 'on', attributes: {} },
    'input_boolean.bedroom_automation_heating_enabled': { state: 'off', attributes: {} },
  };
  const hass = { states };
  for (const [id, v] of Object.entries(over)) { if (v === null) delete states[id]; else states[id] = v; }
  return hass;
};
const withRooms = (rooms, attention, extra = {}) => mk({
  'sensor.info_rooms': { state: 'ok', attributes: { rooms: typeof rooms === 'string' ? rooms : JSON.stringify(rooms) } },
  'sensor.info_attention': { state: String(attention.length), attributes: { items: JSON.stringify(attention) } },
  ...extra,
});
const NOISE = /undefined|NaN|\[object|null/;
const ALL_MODES = ['now-header', 'attention', 'rooms', 'energy', 'energy-foot', 'bins', 'heating', 'feed', 'footer'];
const ROOM_MODES = ['room-head', 'why', 'scenes', 'lights-title', 'lights', 'media', 'automations', 'room-feed'];
const renderAll = (hass) => {
  const out = {};
  for (const m of ALL_MODES) out[m] = P.render(m, {}, hass, NOW);
  for (const k of P.ALL_ROOM_KEYS) for (const m of ROOM_MODES) out[`${m}:${k}`] = P.render(m, { room: k }, hass, NOW);
  return out;
};
const noNoise = (out, label) => { for (const [k, v] of Object.entries(out)) assert.ok(!NOISE.test(v), `${label} ${k} contains noise: ${(v.match(NOISE) || [])[0]} in ${v.slice(0, 200)}`); };

ok('10 rooms configured', () => assert.equal(P.ALL_ROOM_KEYS.length, 10));

ok('every mode renders for all 10 rooms with full report data (attention state)', () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const hass = withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }]);
  const out = renderAll(hass);
  noNoise(out, 'full');
  assert.match(out.attention, /1 needs attention/);
  assert.match(out['room-head:bedroom'], /Heating suspended/);
  assert.match(out['room-head:bedroom'], /Valve target/);
  assert.match(out.rooms, /Bedroom details/);
  assert.match(out['why:bedroom'], /Bed occupied · Window open/);
});

ok('calm state: no attention, All good', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, verdict: 'Empty · lights off' }));
  const out = renderAll(withRooms(rooms, []));
  noNoise(out, 'calm');
  assert.match(out.attention, /All good/);
  assert.doesNotMatch(out.rooms, /details ›/);
  assert.match(out['room-head:parlour'], /All good/);
  assert.match(out['room-head:parlour'], /Heating<\/div>/);
});

ok('sparse report entries (only k) never throw and keep a calm render', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ k }));
  const out = renderAll(withRooms(rooms, [{}, { key: 'nope' }]));
  noNoise(out, 'sparse');
});

ok('no info_rooms / info_attention at all (fresh restart) renders honest empty states', () => {
  const out = renderAll(mk());
  noNoise(out, 'missing');
  assert.match(out.attention, /No attention report/);
  assert.match(out['room-head:bedroom'], /No report yet/);
  assert.equal(out['why:bedroom'], '');
});

ok('attributes arriving as JSON strings, garbage strings or wrong types', () => {
  const garbage = withRooms('not json', []);
  noNoise(renderAll(garbage), 'garbage');
  const weird = mk({ 'sensor.info_rooms': { state: 'ok', attributes: { rooms: 42 } }, 'sensor.info_attention': { state: '1', attributes: { items: { a: 1 } } } });
  noNoise(renderAll(weird), 'weird');
  const nulls = withRooms([{ k: 'bedroom', temp: null, target: 'abc', lights_on: 'x', manual: 'str', holds: 'nope', labels: 7 }], []);
  noNoise(renderAll(nulls), 'nulls');
});

ok('no-climate rooms: no numbers card, "no climate" in row', () => {
  const out = renderAll(withRooms(P.ROOM_ORDER.map(FULL), []));
  assert.doesNotMatch(out['room-head:hallway_upstairs'], /Valve target|class="lbl">Room/);
  assert.match(out.rooms, /no climate/);
  assert.doesNotMatch(out['why:hallway_upstairs'], /Heating target/);
  for (const g of ['back_garden', 'front_garden']) {
    assert.match(out[`room-head:${g}`], /Lights only/);
    assert.equal(out[`lights:${g}`], '');
    assert.equal(out[`lights-title:${g}`], '');
    assert.equal(out[`why:${g}`], '');
  }
});

ok('manual marker set vs null', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T18:40:00+00:00', what: 'Wall button: scene cycled' };
  const set = P.render('scenes', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), manual }], []), NOW);
  assert.match(set, /Manual · wall button, 2 min ago/);
  assert.match(set, /Automation last acted: sleep hold/);
  const none = P.render('scenes', { room: 'parlour' }, withRooms([FULL('parlour')], []), NOW);
  assert.doesNotMatch(none, /Manual ·/);
  assert.match(none, /Set by automation at/);
  const noWhy = P.render('scenes', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), lights_why: '', manual: null }], []), NOW);
  assert.match(noWhy, /No automation action seen/);
  assert.match(set, /aria-pressed="true"/); // lamps is active
  assert.match(set, /data-entity="scene.parlour_lamps"/);
});

ok('scene tiles use the spike scene map and highlight the active scene', () => {
  const want = { parlour: ['all', 'lamps', 'dining', 'off'], kitchen: ['all', 'cabinets', 'off'], hallway_downstairs: ['daylight', 'low', 'off'], hallway_upstairs: ['daylight', 'low', 'off'], bedroom: ['all', 'all_full', 'lamps', 'off'], bathroom: ['full', 'low', 'off'], home_office: ['all', 'lamps', 'off'], foreign_office: ['all', 'off'], back_garden: ['all', 'off'], front_garden: ['all', 'autumn', 'halloween', 'off'] };
  for (const [k, ids] of Object.entries(want)) assert.deepEqual([...P.ROOMS[k].scenes].sort(), [...ids].sort(), k);
});

ok('individual lights: dimmable gets a slider, switches a toggle, missing entity is honest', () => {
  const html = P.render('lights', { room: 'parlour' }, mk(), NOW);
  assert.match(html, /type="range"[^>]*data-entity="light.parlour_light_floor_lamp"/);
  assert.match(html, /data-act="toggle" data-entity="switch.parlour_plug_table_lamp"/);
  assert.match(html, /Not found/);
  assert.match(P.render('lights-title', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), lights_on: 2, lights_total: 5 }], []), NOW), /2 of 5 on/);
  assert.match(P.render('lights-title', { room: 'parlour' }, mk(), NOW), /2 of 5 on/); // falls back to entity states: 2 on
});

ok('media only for rooms with players', () => {
  for (const k of P.ALL_ROOM_KEYS) {
    const html = P.render('media', { room: k }, mk(), NOW);
    assert.equal(html === '', P.ROOMS[k].media.length === 0, k);
  }
  const p = P.render('media', { room: 'parlour' }, mk(), NOW);
  assert.match(p, /data-act="media-play"/);
  assert.match(p, /data-act="volume"/);
  assert.match(p, /data-act="media-power"/);
});

ok('bins: tomorrow highlighted, unknown dimmed, sorted', () => {
  const html = P.render('bins', {}, mk(), NOW);
  assert.match(html, /bin soon"><div class="d">Tomorrow<\/div><div class="n">Refuse/);
  assert.match(html, /<div class="d">–<\/div>/);
});

ok('energy handles missing sensors', () => {
  const html = P.render('energy', {}, { states: {} }, NOW);
  assert.match(html, /–/);
  assert.doesNotMatch(html, NOISE);
});

ok('feed hides stored plumbing entries', () => {
  const entries = [
    { loc: 'kitchen', ts: '2026-10-25T18:30:00+00:00', decision: 'update_external_temp', auto: 'kitchen:room_temp_feed', sentence: 'PLUMB' },
    { loc: 'kitchen', ts: '2026-10-25T18:20:00+00:00', decision: 'turn_off', auto: 'kitchen:lighting', sentence: 'Kitchen lights turned off' },
  ];
  const hass = mk({ 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify(entries), by_room: JSON.stringify(entries) } } });
  const feed = P.render('feed', {}, hass, NOW);
  assert.doesNotMatch(feed, /PLUMB/);
  assert.match(feed, /Kitchen lights turned off/);
  assert.doesNotMatch(P.render('room-feed', { room: 'kitchen' }, hass, NOW), /PLUMB/);
  assert.match(P.render('feed', {}, mk(), NOW), /No decisions seen since HA started/);
});

ok('unknown room and unknown mode fail loudly', () => {
  assert.throws(() => P.render('why', { room: 'attic' }, mk(), NOW), /needs a known room/);
  assert.throws(() => P.render('nope', {}, mk(), NOW), /unknown mode/);
});

ok('write paths are whitelisted; others throw', () => {
  const calls = [];
  const hass = { states: { 'light.a': { state: 'off' }, 'media_player.b': { state: 'playing' } }, callService: (d, s, data) => calls.push([d, s, data]) };
  const el = (act, entity) => ({ dataset: { act, entity } });
  P.handleAction(hass, el('scene', 'scene.parlour_lamps'));
  P.handleAction(hass, el('toggle', 'light.a'));
  P.handleAction(hass, el('brightness', 'light.a'), '40');
  P.handleAction(hass, el('brightness', 'light.a'), '0');
  P.handleAction(hass, el('media-play', 'media_player.b'));
  P.handleAction(hass, el('volume', 'media_player.b'), '28');
  assert.deepEqual(calls.map((c) => `${c[0]}.${c[1]}`), ['scene.turn_on', 'light.turn_on', 'light.turn_on', 'light.turn_off', 'media_player.media_play_pause', 'media_player.volume_set']);
  assert.equal(calls[5][2].volume_level, 0.28);
  assert.throws(() => P.callService(hass, 'mqtt', 'publish', {}), /not an allowed write path/);
  assert.throws(() => P.callService(hass, 'homeassistant', 'restart', {}), /not an allowed write path/);
  assert.throws(() => P.callService(hass, 'light', 'toggle', {}), /not an allowed write path/);
});

// ── YAML: parses, and the apexcharts data_generator strings run against rate lists ───────────
const loadYaml = (rel) => yaml.load(readFileSync(root + rel, 'utf8').replace(/!include /g, ''));
const walk = (node, fn) => { if (Array.isArray(node)) node.forEach((x) => walk(x, fn)); else if (node && typeof node === 'object') { fn(node); Object.entries(node).forEach(([k, x]) => { if (k !== '<<') walk(x, fn); }); } };

ok('dashboard YAML parses', () => {
  for (const f of ['info-dashboard.yaml', 'info_templates.yaml', ...readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((x) => 'views/' + x)]) loadYaml(f);
});

ok('price bar data_generators: empty, 48, 50 and garbage lists', () => {
  const gens = [];
  for (const f of readdirSync(root + 'views').filter((x) => x.startsWith('info-'))) walk(loadYaml('views/' + f), (o) => { if (typeof o.data_generator === 'string') gens.push(o.data_generator); });
  assert.ok(gens.length >= 5, 'expected one generator per price category');
  const slots = (count, startIso) => Array.from({ length: count }, (_, i) => {
    const s = Date.parse(startIso) + i * 1800000;
    return { start: new Date(s).toISOString().replace('Z', '+00:00'), end: new Date(s + 1800000).toISOString().replace('Z', '+00:00'), value_inc_vat: i % 7 === 0 ? 0.08 : i % 5 === 0 ? 0.42 : 0.25 };
  });
  const cases = { empty: [], fortyEight: slots(48, '2026-10-25T00:00:00Z'), fifty: slots(50, '2026-10-24T23:00:00Z'), garbage: [null, 5, { start: 'x' }, { start: '2026-10-25T00:00:00Z', end: '2026-10-25T00:30:00Z', value_inc_vat: 'abc' }] };
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    for (const [name, rates] of Object.entries(cases)) {
      const hass = { states: { 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { attributes: { rates } } } };
      const perSlot = new Map();
      for (const g of gens) {
        const fn = new Function('entity', 'start', 'end', 'hass', 'window', g);
        const out = fn({}, 0, 0, hass, { PulseLib: P });
        assert.ok(Array.isArray(out), name);
        assert.equal(out.length, name === 'garbage' ? 0 : rates.length, `${name}: one point per valid slot, no assumption of 48`);
        out.forEach((p, i) => { if (p.y !== null) perSlot.set(i, (perSlot.get(i) || 0) + 1); });
      }
      for (const c of perSlot.values()) assert.equal(c, 1, `${name}: each slot is in exactly one category`);
      assert.equal(perSlot.size, name === 'garbage' ? 0 : rates.length, `${name}: every slot categorised`);
    }
    // missing entity entirely
    const fn = new Function('entity', 'start', 'end', 'hass', 'window', gens[0]);
    assert.deepEqual(fn({}, 0, 0, { states: {} }, { PulseLib: P }), []);
  } finally { Date.now = realNow; }
});

ok('rateSeries marks the current slot and dims past', () => {
  const rates = [
    { start: '2026-10-25T18:00:00+00:00', end: '2026-10-25T18:30:00+00:00', value_inc_vat: 0.2 },
    { start: '2026-10-25T18:30:00+00:00', end: '2026-10-25T19:00:00+00:00', value_inc_vat: 0.2 },
    { start: '2026-10-25T19:00:00+00:00', end: '2026-10-25T19:30:00+00:00', value_inc_vat: 0.05 },
    { start: '2026-10-25T19:30:00+00:00', end: '2026-10-25T20:00:00+00:00', value_inc_vat: 0.45 },
  ];
  const y = (cat) => P.rateSeries(rates, cat, NOW).map((p) => p.y !== null);
  assert.deepEqual(y('past'), [true, false, false, false]);
  assert.deepEqual(y('current'), [false, true, false, false]);
  assert.deepEqual(y('cheap'), [false, false, true, false]);
  assert.deepEqual(y('peak'), [false, false, false, true]);
  assert.deepEqual(P.rateSeries('nope', 'cheap', NOW), []);
});

console.log(`\n${n} test groups passed`);
