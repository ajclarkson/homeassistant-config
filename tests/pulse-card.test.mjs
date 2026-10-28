// Offline tests for www/pulse-card.js and the YAML that drives it.
// Run: cd tests && npm install && node pulse-card.test.mjs
// Covers: every mode for all 10 rooms with full, sparse and missing report data; attention vs
// calm; manual set/null; empty, 50-slot and garbage rate lists (via the data_generator strings
// extracted from the real YAML); unknown rooms and disallowed services fail loudly.
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const P = require('../www/pulse-card.js');
const root = new URL('..', import.meta.url).pathname;
let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log('ok', name); };
const okAsync = async (name, fn) => { await fn(); n += 1; console.log('ok', name); };

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
    'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': { state: 'off', attributes: { next_time: '2026-10-26T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.259 } },
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
const ALL_MODES = ['now-header', 'status', 'rooms', 'bins-heating', 'feed', 'footer', 'tabbar', 'energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage'];
const ROOM_MODES = ['room-head', 'why', 'scenes', 'lights', 'media', 'automations', 'room-feed'];
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
  assert.match(out.status, /1 needs attention/);
  assert.match(out['room-head:bedroom'], /Heating suspended/);
  assert.match(out['room-head:bedroom'], /Valve target/);
  assert.match(out.rooms, /Bedroom details/);
  assert.match(out['why:bedroom'], /Bed occupied · Window open/);
});

ok('calm state: no attention, All good', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, verdict: 'Empty · lights off' }));
  const out = renderAll(withRooms(rooms, []));
  noNoise(out, 'calm');
  assert.match(out.status, /All good/);
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
  assert.match(out.status, /No attention report/);
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
  const quiet = P.render('rooms', {}, withRooms([{ k: 'hallway_upstairs', n: 'x', occupied: false, temp: null, humidity: null }], []), NOW);
  const upTile = quiet.match(/<a class="rt tap[^"]*"[^>]*room-hallway_upstairs"[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(upTile, /–/, 'no bare dash for a room without climate');
  assert.doesNotMatch(out['why:hallway_upstairs'], /Heating target/);
  for (const g of ['back_garden', 'front_garden']) {
    assert.match(out[`room-head:${g}`], /Lights only/);
    assert.equal(out[`lights:${g}`], '');
    assert.equal(out[`why:${g}`], '');
  }
});

ok('manual marker set vs null', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T18:40:00+00:00', what: 'Wall button: scene cycled' };
  const set = P.render('scenes', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), manual }], []), NOW);
  assert.match(set, /<span class="tag">Manual · wall button · 2 min ago<\/span>/);
  assert.match(set, /Automation had: sleep hold/);
  assert.doesNotMatch(set, /Automation last acted|may change them again|Wall button: scene cycled/);
  assert.equal((set.match(/Manual/g) || []).length, 1, 'one clear line');
  const dash = P.render('scenes', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), manual: { source: 'dashboard', ts: '2026-10-25T18:40:00+00:00', what: 'lamps scene' }, lights_why: '' }], []), NOW);
  assert.match(dash, /Manual · dashboard · 2 min ago/);
  assert.match(dash, /<div class="note"[^>]*>lamps scene<\/div>/);
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

ok('individual lights: collapsed by default with one chevron, expanded shows sliders/toggles/missing honestly', () => {
  const closed = P.render('lights', { room: 'parlour' }, mk(), NOW);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /2 of 5 on/);
  assert.doesNotMatch(closed, /type="range"|class="tog/);
  assert.equal((closed.match(/<svg/g) || []).length, 1, 'a single chevron, no second dropdown arrow');
  const open = P.render('lights', { room: 'parlour' }, mk(), NOW, { open: true });
  assert.match(open, /aria-expanded="true"/);
  assert.equal((open.match(/data-act="lights-toggle"/g) || []).length, 1);
  assert.match(open, /type="range"[^>]*data-entity="light.parlour_light_floor_lamp"/);
  assert.match(open, /style="--p:40%"/);
  assert.match(open, /data-act="toggle" data-entity="switch.parlour_plug_table_lamp"/);
  assert.match(open, /Not found/);
  assert.match(P.render('lights', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), lights_on: 3, lights_total: 5 }], []), NOW), /3 of 5 on/);
  for (const k of P.ALL_ROOM_KEYS) {
    const want = P.ROOMS[k].lights.length === 0;
    assert.equal(P.render('lights', { room: k }, mk(), NOW) === '', want, `${k} collapsed`);
    assert.equal(P.render('lights', { room: k }, mk(), NOW, { open: true }) === '', want, `${k} open`);
  }
  noNoise({ open }, 'lights open');
  assert.throws(() => P.render('lights-title', { room: 'parlour' }, mk(), NOW), /unknown mode/);
});

ok('expander-card is gone; Now no longer uses apexcharts', () => {
  for (const f of ['info_templates.yaml', 'info-dashboard.yaml', ...readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((x) => 'views/' + x)]) {
    assert.doesNotMatch(readFileSync(root + f, 'utf8'), /expander-card|lights-title/, f);
  }
  assert.doesNotMatch(readFileSync(root + 'views/info-now.yaml', 'utf8'), /apexcharts-card/, 'Now has no apexcharts: energy block is drawn by pulse-card');
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

ok('bins + heating two-up: what is due next and when; boiler and inside/outside', () => {
  const html = P.render('bins-heating', {}, mk({ 'sensor.house_average_temperature': { state: '19.9', attributes: {} }, 'weather.forecast_home': { state: 'cloudy', attributes: { temperature: 10 } } }), NOW);
  assert.match(html, /Bins[\s\S]*Refuse[\s\S]*tomorrow/);
  assert.ok(html.includes(`background:#2b2415`), 'due tomorrow is highlighted');
  assert.match(html, /Boiler firing/);
  assert.match(html, /in 19\.9° · out 10\.0°/);
  const tie = P.render('bins-heating', {}, mk({ 'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '4', attributes: {} }, 'sensor.st_albans_collect_domestic_food_days_until_collection': { state: '4', attributes: {} }, 'binary_sensor.house_heating_boiler_firing': { state: 'off', attributes: {} } }), NOW);
  assert.match(tie, /Food · Refuse/);
  assert.match(tie, /in 4 days/);
  assert.match(tie, /Boiler idle/);
  const none = P.render('bins-heating', {}, { states: {} }, NOW);
  assert.match(none, /no collection data/);
  assert.match(none, /no readings/);
  noNoise({ none }, 'bins empty');
  assert.match(P.render('bins-heating', {}, mk({ 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } }), NOW), /Heating off/);
});

ok('energy page chart handles missing sensors', () => {
  const html = P.render('energy-day', {}, { states: {} }, NOW, {});
  assert.match(html, /No price data for today/);
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

ok('every nav path targets the registered dashboard (/pulse-dashboard) or Mobile, and each Pulse path is a real view', () => {
  assert.equal(P.DASH, '/pulse-dashboard');
  const viewPaths = new Set(['now', 'classic', 'classic-house']);
  for (const f of readdirSync(root + 'views').filter((x) => x.startsWith('info-'))) {
    const v = yaml.load(readFileSync(root + 'views/' + f, 'utf8'));
    viewPaths.add(v.path);
    if (v.back_path) assert.ok(v.back_path.startsWith(P.DASH + '/'), `${f} back_path ${v.back_path}`);
    assert.doesNotMatch(readFileSync(root + 'views/' + f, 'utf8'), /\/info-dashboard/, f);
  }
  const rooms = P.ROOM_ORDER.map(FULL);
  const items = P.ALL_ROOM_KEYS.map((k) => ({ room: k, key: k, kind: 'warm_heating', text: '20.0° vs 18° target, heating on', nav: '/x' }));
  const hass = withRooms(rooms, items);
  const out = renderAll(hass);
  let seen = 0;
  for (const [k, html] of Object.entries(out)) {
    for (const m of html.matchAll(/data-path="([^"]*)"/g)) {
      seen += 1;
      const p = m[1];
      if (p.startsWith(P.MOBILE)) { assert.match(p, /^\/mobile-dashboard(\/mo)?$/, `${k}: ${p}`); continue; }
      assert.ok(p.startsWith(P.DASH + '/'), `${k}: ${p} must start with ${P.DASH}/`);
      assert.ok(viewPaths.has(p.slice(P.DASH.length + 1)), `${k}: ${p} has no matching view path`);
    }
  }
  assert.ok(seen > 15, 'expected nav links in the rendered output');
  assert.doesNotMatch(readFileSync(root + 'www/pulse-card.js', 'utf8'), /\/info-dashboard/);
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

ok('cheapest 2h: dated window from the binary sensor (Today / Tomorrow), past hidden, running now, never from the date-less template sensors', () => {
  const cw = (attrs, state = 'off') => ({ 'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': { state, attributes: attrs } });
  // a window on a LATER date reads Tomorrow (the template sensors would have printed 20:00 → 22:00 with no day)
  assert.deepEqual(P.cheapestWindow(mk(), NOW).text, 'Tomorrow 20:00 → 22:00');
  assert.ok(Math.abs(P.cheapestWindow(mk(), NOW).avg - 25.9) < 1e-9);
  const energy = P.render('energy-day', {}, mk(), NOW, {});
  assert.match(energy, /Next cheapest 2 hours<\/div><div class="m">Tomorrow 20:00 → 22:00 · avg 25\.9p/);
  assert.match(P.render('status', {}, mk(), NOW), /Cheapest 2h · <b[^>]*>Tomorrow 20:00 → 22:00<\/b>/);
  assert.doesNotMatch(energy + P.render('status', {}, mk(), NOW), /02:00 → 04:00|avg 9\.8p/, 'the template sensors are no longer read');
  // later today
  const later = mk(cw({ next_time: '2026-10-25T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.059 }));
  assert.equal(P.cheapestWindow(later, NOW).dayWord, 'Today');
  assert.match(P.render('status', {}, later, NOW), /Cheapest 2h · <b[^>]*>Today 20:00 → 22:00<\/b>/);
  // further out: a dated label
  const far = mk(cw({ next_time: '2026-10-28T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.1 }));
  assert.equal(P.cheapestWindow(far, NOW).dayWord, 'Wed 28 Oct');
  // already past (the 22:07 bug): hidden on Now, none upcoming on Energy
  const past = mk(cw({ next_time: '2026-10-25T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.259 }));
  const late = Date.parse('2026-10-25T22:07:00Z');
  assert.equal(P.cheapestWindow(past, late).status, 'none');
  assert.doesNotMatch(P.render('status', {}, past, late), /Cheapest 2h/);
  assert.match(P.render('energy-day', {}, past, late, {}), /Next cheapest 2 hours<\/div><div class="m">none upcoming/);
  // running now: from current_end, or current_start + duration; state on without an end still says running
  const run = mk(cw({ current_start: '2026-10-25T18:00:00+00:00', current_end: '2026-10-25T20:00:00+00:00' }, 'on'));
  assert.equal(P.cheapestWindow(run, NOW).endText, '20:00');
  assert.match(P.render('status', {}, run, NOW), /Cheapest 2h · <b[^>]*>running now, until 20:00<\/b>/);
  assert.match(P.render('energy-day', {}, run, NOW, {}), /Running now/);
  assert.equal(P.cheapestWindow(mk(cw({ current_start: '2026-10-25T18:00:00+00:00', current_duration_in_hours: 2 }, 'on')), NOW).endText, '20:00');
  assert.match(P.render('status', {}, mk(cw({}, 'on')), NOW), /Cheapest 2h · <b[^>]*>running now<\/b>/);
  // unknown / garbage / missing -> hidden, never throws
  for (const attrs of [{}, { next_time: 'nope', next_duration_in_hours: 2 }, { next_time: '2026-10-26T20:00:00+00:00' }, { next_time: '2026-10-26T20:00:00+00:00', next_duration_in_hours: 0 }]) {
    assert.equal(P.cheapestWindow(mk(cw(attrs)), NOW).status, 'none', JSON.stringify(attrs));
    assert.doesNotMatch(P.render('status', {}, mk(cw(attrs)), NOW), /Cheapest 2h/);
  }
  assert.equal(P.cheapestWindow({ states: {} }, NOW).status, 'none');
  assert.equal(P.cheapestWindow(mk({ 'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': null }), NOW).status, 'none');
});

const rect = (html) => [...html.matchAll(/<rect x="(\d+)" y="([\d.]+)" width="(\d+)" height="([\d.]+)" rx="1" fill="([^"]+)" opacity="([\d.]+)"\/>/g)].map((m) => ({ x: +m[1], y: +m[2], h: +m[4], fill: m[5], op: +m[6] }));
const real = JSON.parse(readFileSync(root + 'tests/fixtures/rates-2026-10-25-clock-change.json', 'utf8'));
const energyAt = (rates, now) => P.render('energy-day', {}, mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates } } }), now, {});

ok('energy block is one card with an SVG chart: every slot of the real 50-slot clock-change day is drawn', () => {
  assert.equal(real.length, 50);
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  assert.equal((html.match(/data-chart /g) || []).length, 1, 'one chart');
  assert.doesNotMatch(html, /border-radius:0|apexcharts/);
  const bars = rect(html);
  assert.equal(bars.length, 50);
  assert.match(html, /viewBox="0 0 300 96"/); // 50 slots x 6, anchored to first start .. last end
  assert.match(html, /<line x1="0" x2="300"/); // zero baseline spans the whole day
  noNoise({ html }, 'real energy');
});

ok('real data at 18:29Z: slots 0-37 past (dimmed, visible), slot 38 now, 39-49 future; negatives sit below the baseline', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  const bars = rect(html);
  const base = Number(html.match(/<line x1="0" x2="300" y1="([\d.]+)"/)[1]);
  assert.deepEqual(bars.slice(0, 38).map((b) => b.op), Array(38).fill(0.45));
  assert.equal(bars[38].fill, '#e8ebef');
  assert.equal(bars[38].op, 1);
  assert.deepEqual(bars.slice(39).map((b) => b.op), Array(11).fill(1));
  // 16:00-18:30Z (slots 34-37) are 29-33p: mid band, drawn above the baseline, clearly tall
  for (const i of [34, 35, 36, 37]) { assert.equal(bars[i].fill, P.priceColour(real[i].value_inc_vat * 100)); assert.ok(bars[i].y + bars[i].h <= base + 0.5 && bars[i].h > 30, `slot ${i}`); }
  // overnight slots are negative: green, hanging from the baseline
  const neg = bars.slice(0, 34).filter((b) => Math.abs(b.y - base) < 0.6);
  assert.ok(neg.length >= 20, 'negative slots start at the baseline and extend down');
  assert.ok(real.slice(0, 34).every((r, i) => (r.value_inc_vat <= 0 ? bars[i].fill === '#2ee6c8' : bars[i].fill === P.priceColour(r.value_inc_vat * 100))));
  assert.ok(bars.every((b) => b.h >= 1.5));
  const nowX = Number(html.match(/<line x1="([\d.]+)" x2="[\d.]+" y1="0"/)[1]);
  assert.equal(nowX, 38 * 6 + 2.5, 'now marker sits on the current slot');
});

ok('hour labels follow real slot start times in the viewer zone (TZ=UTC here)', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  const labels = [...html.matchAll(/left:([\d.]+)%;transform:translateX\(-50%\)">(\d\d)</g)].map((m) => m[2]);
  assert.deepEqual(labels, ['00', '06', '12', '18', '00'].filter(() => true).slice(0, labels.length));
  assert.ok(labels.includes('06') && labels.includes('12') && labels.includes('18'));
});

ok('energy chart edge cases: empty, garbage, 48 slots, single slot, all negative, flat', () => {
  for (const rates of [[], undefined, 'x', [null, 5, {}], [{ start: 'a', end: 'b', value_inc_vat: 1 }]]) {
    const html = energyAt(rates, NOW);
    assert.match(html, /No price data for today/);
    noNoise({ html }, 'empty energy');
  }
  const slots = (n, f) => Array.from({ length: n }, (_, i) => { const s = Date.parse('2026-10-25T00:00:00Z') + i * 1800000; return { start: new Date(s).toISOString(), end: new Date(s + 1800000).toISOString(), value_inc_vat: f(i) / 100 }; });
  for (const [n, f] of [[48, (i) => (i % 9) - 3], [1, () => 12], [46, () => -5], [48, () => 0], [48, () => 25]]) {
    const html = energyAt(slots(n, f), Date.parse('2026-10-25T05:10:00Z'));
    assert.equal(rect(html).length, n);
    noNoise({ html }, `energy ${n}`);
  }
});

ok('frontend module URL is cache-busted and the card says to bump it', () => {
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /\/local\/pulse-card\.js\?v=\d+/);
  assert.match(readFileSync(root + 'www/pulse-card.js', 'utf8'), /Bump N|Cache busting/);
});

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(...hexRgb(a).map((v, i) => v - hexRgb(b)[i]));
const lum = (h) => { const c = hexRgb(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

ok('priceColour: negative special case, boundaries, never throws', () => {
  const C = P.priceColour;
  for (const bad of [NaN, undefined, null, 'x', '', Infinity, -Infinity, {}, []]) assert.equal(C(bad), '#6b7684', String(bad));
  assert.equal(C(-7.54), '#2ee6c8');
  assert.equal(C(0), '#2ee6c8');
  assert.equal(C(-0.01), C(-100));
  for (const v of [0.01, 15, 25, 35, 44.9, 45, 100, -7.54]) assert.match(C(v), /^#[0-9a-f]{6}$/, String(v));
  assert.equal(C(45), C(100));
  assert.equal(C('12'), C(12));
  assert.notEqual(C(45), C(44.9));
});

ok('priceColour: negative is clearly distinct from the 0-10p greens; extreme is distinct from 35-44.9p', () => {
  for (const v of [0.01, 2, 5, 10]) assert.ok(dist(P.priceColour(-1), P.priceColour(v)) > 60, `neg vs ${v}`);
  for (let v = 35; v < 45; v += 0.3) assert.ok(dist(P.priceColour(45), P.priceColour(v)) > 45, `extreme vs ${v.toFixed(1)}`);
});

ok('priceColour: continuous green -> red hue, monotonic, lightness varies, green/red differ in luminance', () => {
  const hue = (hex) => { const [r, g, b] = hexRgb(hex).map((x) => x / 255); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn; if (d === 0) return 0; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; };
  let prev = 1000;
  let lights = new Set();
  let maxStep = 0;
  let last = null;
  for (let v = 0.5; v < 45; v += 0.5) {
    const c = P.priceColour(v);
    const h = hue(c);
    assert.ok(h <= prev + 0.6, `hue should fall (${v}p: ${h} after ${prev})`);
    prev = h;
    lights.add(Math.round(lum(c) * 20));
    if (last) maxStep = Math.max(maxStep, dist(c, last));
    last = c;
  }
  assert.ok(maxStep < 40, `no jumps within the graded range (max step ${maxStep.toFixed(1)})`);
  assert.ok(lights.size >= 4, 'luminance varies along the scale');
  assert.ok(cr(P.priceColour(1), P.priceColour(44.9)) >= 1.5, 'green and red differ in luminance, not just hue');
});

ok('priceColour: text variant reads on the card (>= 4.5:1) for every price', () => {
  for (const v of [-20, -7.5, 0, 0.5, 5, 10, 15, 20, 25, 30, 35, 40, 44.9, 45, 80, 200, NaN]) assert.ok(cr(P.priceColour(v, { text: true }), '#1a1f26') >= 4.5, `${v}`);
});

ok('Now and Next figures use the price colour (text variant)', () => {
  const html = P.render('status', {}, mk(), NOW); // now 34.8p, next 41.2p in the fixture
  assert.ok(html.includes(`color:${P.priceColour(34.8, { text: true })}`));
  assert.ok(html.includes(`color:${P.priceColour(41.2, { text: true })}`));
  const none = P.render('status', {}, { states: {} }, NOW);
  assert.ok(none.includes(`color:${P.priceColour(NaN, { text: true })}`));
});

ok('chart: per-slot colours from the real rates at 18:29Z; key and aria summary present', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  const bars = rect(html);
  assert.equal(bars.length, 50);
  real.forEach((r, i) => {
    const p = r.value_inc_vat * 100;
    if (i === 38) assert.equal(bars[i].fill, '#e8ebef');
    else assert.equal(bars[i].fill, P.priceColour(p), `slot ${i} ${p.toFixed(2)}p`);
    assert.equal(bars[i].op, i < 38 ? 0.45 : 1);
  });
  assert.match(html, /aria-label="Half-hourly electricity price, 50 slots\. Cheapest -7\.5p at \d\d:\d\d, dearest 33\.4p at \d\d:\d\d\. Now [\d.-]+p\."/);
  assert.match(html, />≤0p</);
  assert.match(html, /<span>0<\/span><span>15<\/span><span>30<\/span><span>45p\+<\/span>/);
  assert.match(html, /linear-gradient\(to right,#/);
  assert.match(html, /stroke-dasharray="2 2"/);
  const emptyKey = energyAt([], NOW);
  assert.doesNotMatch(emptyKey, /linear-gradient/);
});

ok('extreme prices (>= 45p) render in the extreme colour; zero and negative in teal', () => {
  const slots = [-3, 0, 20, 44.9, 45, 60].map((p, i) => { const s = Date.parse('2026-10-25T00:00:00Z') + i * 1800000; return { start: new Date(s).toISOString(), end: new Date(s + 1800000).toISOString(), value_inc_vat: p / 100 }; });
  const bars = rect(energyAt(slots, Date.parse('2026-10-25T23:00:00Z')));
  assert.deepEqual(bars.map((b) => b.fill), ['#2ee6c8', '#2ee6c8', P.priceColour(20), P.priceColour(44.9), '#c2003b', '#c2003b']);
});

const mkSlots = (n, startIso, f) => Array.from({ length: n }, (_, i) => { const t = Date.parse(startIso) + i * 1800000; return { start: new Date(t).toISOString(), end: new Date(t + 1800000).toISOString(), value_inc_vat: f(i) / 100 }; });

ok('slotAt: x -> slot index, clamped, never assumes 48', () => {
  assert.equal(P.slotAt(0, 300, 50), 0);
  assert.equal(P.slotAt(299.9, 300, 50), 49);
  assert.equal(P.slotAt(300, 300, 50), 49); // right edge clamps to the last slot
  assert.equal(P.slotAt(150, 300, 50), 25);
  assert.equal(P.slotAt(-20, 300, 50), 0);
  assert.equal(P.slotAt(900, 300, 50), 49);
  assert.equal(P.slotAt(150, 300, 46), 23);
  assert.equal(P.slotAt(149.9, 300, 48), 23);
  assert.equal(P.slotAt(10, 300, 1), 0);
  for (const bad of [[NaN, 300, 50], [10, 0, 50], [10, -5, 50], [10, 300, 0], [10, 300, -1], [undefined, 300, 50], [10, NaN, 50], [10, 300, NaN], [10, Infinity, 50]]) assert.equal(P.slotAt(...bad), null, JSON.stringify(bad));
  // every pixel maps to exactly its slot for a 50-slot day at 333px
  const seen = new Set();
  for (let x = 0; x < 333; x += 1) { const i = P.slotAt(x, 333, 50); assert.ok(i >= 0 && i <= 49); seen.add(i); }
  assert.equal(seen.size, 50);
});

ok('slotReadout: local range, price, now / paid to use notes, bad input is null', () => {
  const day = P.rateBands(real, Date.parse('2026-10-25T18:29:00Z'));
  assert.equal(day.length, 50);
  const r38 = P.slotReadout(day[38]);
  assert.equal(r38.range, '18:00-18:30');
  assert.equal(r38.price, '31.1p');
  assert.equal(r38.note, 'now');
  assert.equal(r38.colour, P.priceColour(day[38].v, { text: true }));
  const r39 = P.slotReadout(day[39]);
  assert.equal(r39.range, '18:30-19:00');
  assert.equal(r39.price, '26.4p');
  assert.equal(r39.note, '');
  assert.match(r39.spoken, /^18:30 to 19:00, 26\.4 pence$/);
  const neg = day.find((s) => s.v < 0);
  const rn = P.slotReadout(neg);
  assert.match(rn.price, /^-\d/);
  assert.match(rn.note, /paid to use/);
  assert.equal(rn.colour, P.priceColour(neg.v, { text: true }));
  assert.equal(P.slotReadout(day[0]).range, '00:00-00:30'.replace('00:00', '23:00').replace('00:30', '23:30')); // first slot starts 23:00Z (00:00+01:00)
  assert.equal(P.slotReadout(day[49]).range, '23:30-00:00'); // last slot ends at midnight
  const both = P.slotReadout({ start: 0, end: 1800000, v: -2, state: 'current' });
  assert.equal(both.note, 'now · paid to use');
  assert.equal(P.slotReadout({ start: 0, end: 1800000, v: 0, state: 'past' }).note, 'free');
  for (const bad of [null, undefined, {}, 5, { start: 'x', end: 1, v: 1 }, { start: 0, end: 1, v: NaN }]) assert.equal(P.slotReadout(bad), null);
});

ok('slotReadout works on a 46-slot (short) day too', () => {
  const day = P.rateBands(mkSlots(46, '2026-03-29T00:00:00Z', (i) => i - 10), Date.parse('2026-03-29T05:10:00Z'));
  assert.equal(day.length, 46);
  assert.equal(P.slotAt(299, 300, day.length), 45);
  assert.equal(P.slotReadout(day[45]).range, '22:30-23:00');
  assert.equal(P.slotReadout(day[10]).note, 'now · free');
});

ok('tooltipLeft: centred, clamped inside the chart, never negative, bad input is 0', () => {
  assert.equal(P.tooltipLeft(150, 100, 300), 100);
  assert.equal(P.tooltipLeft(5, 100, 300), 0); // left edge
  assert.equal(P.tooltipLeft(299, 100, 300), 200); // right edge
  assert.equal(P.tooltipLeft(150, 400, 300), 0); // wider than the box
  assert.equal(P.tooltipLeft(150, 0, 300), 150);
  for (const bad of [[NaN, 10, 300], [10, NaN, 300], [10, 10, 0], [10, 10, -1], [10, 10, NaN], [Infinity, 10, 300]]) assert.equal(P.tooltipLeft(...bad), 0, JSON.stringify(bad));
  for (let c = -50; c < 400; c += 7) { const l = P.tooltipLeft(c, 120, 300); assert.ok(l >= 0 && l <= 180, `${c} -> ${l}`); }
});

ok('chart markup: focusable, pan-y, one summary label, live region, guide and tooltip hooks; empty rates have none', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  assert.match(html, /<div class="chart" data-chart data-day="today" data-n="50" tabindex="0" role="img" aria-label="Half-hourly electricity price, 50 slots\./);
  assert.match(html, /touch-action:pan-y/);
  assert.equal((html.match(/role="img"/g) || []).length, 1, 'the summary is announced once (svg is aria-hidden)');
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /data-guide[^>]*display:none/);
  assert.match(html, /data-tip class="tip" style="display:none"/);
  assert.match(html, /<span class="sr" aria-live="polite" data-live><\/span>/);
  assert.equal(rect(html).length, 50, 'bar markup unchanged');
  const empty = energyAt([], NOW);
  assert.doesNotMatch(empty, /data-chart|data-tip|aria-live/);
  assert.equal(P.SCRUB_HOLD_MS, 2000);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.sr\{position:absolute;width:1px;height:1px/);
  assert.match(css, /\.chart:focus-visible/);
  assert.match(css, /\.tip\{position:absolute;top:-36px/);
});

ok('module URL carries the current version', () => assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card\.js\?v=2\b/));

// ── Now v2 ─────────────────────────────────────────────────────────────────────────────────────
const quietRoom = (k, over = {}) => ({ ...FULL(k), occupied: false, target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, manual: null, lights_on: 0, lights_why: 'lights back to automatic', lights_ts: '2026-10-25T16:40:00+00:00', last: 'Off', last_ts: '2026-10-25T16:40:00+00:00', humidity: 55, scene: '', verdict: 'Empty', ...over });
const calmRooms = (over = {}) => P.ROOM_ORDER.map((k) => quietRoom(k, over[k] || {}));
const count = (html, re) => (html.match(re) || []).length;
const attn = (room, key, kind, text) => ({ room, key, kind, text, nav: '/x' });

ok('Now v2 all calm: status card not amber, no attention/occupied groups, 8 compact tiles, no humidity or narration', () => {
  const hass = withRooms(calmRooms(), []);
  const status = P.render('status', {}, hass, NOW);
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.match(status, /All good/);
  assert.match(status, /0 rooms occupied · heating idle/);
  assert.doesNotMatch(status, /card pad warn/);
  assert.doesNotMatch(status, /\d home/);
  assert.doesNotMatch(rooms, /Needs attention|Occupied now|Other rooms/);
  assert.match(rooms, />Rooms</);
  assert.equal(count(rooms, /class="rt tap[" ]/g), 8);
  assert.doesNotMatch(rooms, /%|humidity|automatic|ago/);
  assert.match(rooms, /Parlour[\s\S]*Kitchen[\s\S]*Hallway down[\s\S]*Hallway up[\s\S]*Bedroom[\s\S]*Bathroom[\s\S]*Home office[\s\S]*Foreign office/);
  noNoise({ status, rooms }, 'calm v2');
});

ok('Now v2 one occupied: Occupied now card with filled icon, lights badge, reason note, temp; seven tiles remain', () => {
  const hass = withRooms(calmRooms({ parlour: { occupied: true, lights_on: 3, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], temp: 20.4, scene: 'parlour_lamps' } }), [], { 'sensor.parlour_active_scene': { state: 'parlour_lamps', attributes: {} } });
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.match(rooms, />Occupied now</);
  assert.match(rooms, />Other rooms</);
  assert.equal(count(rooms, /class="card oc tap"/g), 1);
  assert.equal(count(rooms, /class="rt tap[" ]/g), 7);
  const card = rooms.match(/<a class="card oc tap"[\s\S]*?<\/a>/)[0];
  assert.match(card, /aria-label="Occupied"[^>]*fill="currentColor"/);
  assert.match(card, /Parlour/);
  assert.match(card, /Lamps/);
  assert.match(card, /20\.4°/);
  assert.match(card, />Sofa occupied</);
  assert.doesNotMatch(card, /Manual|%|humidity/);
  assert.match(P.render('status', {}, hass, NOW), /1 room occupied/);
  assert.doesNotMatch(rooms.replace(card, ''), /Parlour/);
});

ok('Now v2 all rooms occupied: no Other rooms group', () => {
  const hass = withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), []);
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.equal(count(rooms, /class="card oc tap"/g), 8);
  assert.doesNotMatch(rooms, /Other rooms|class="rt tap[" ]/);
  assert.match(P.render('status', {}, hass, NOW), /8 rooms occupied/);
});

ok('Now v2 attention: Bathroom (steamy) and Bedroom (window open) sit in Needs attention, once, and nowhere else; status is amber', () => {
  const rooms = calmRooms({
    bathroom: { occupied: true, temp: 23.1, humidity: 88, lights_on: 1 },
    bedroom: { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'], temp: 20.8 },
  });
  const items = [attn('Bathroom', 'bathroom', 'warm_heating', '23.1° vs 18° target, heating on'), attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window while heating is on')];
  const hass = withRooms(rooms, items);
  const status = P.render('status', {}, hass, NOW);
  assert.match(status, /card pad warn/);
  assert.match(status, /2 need attention/);
  assert.match(status, /Bathroom<\/b> · Steamy/);
  assert.match(status, /Bedroom<\/b> · Window open, heating on/);
  const html = P.render('rooms', {}, hass, NOW);
  const att = html.slice(html.indexOf('Needs attention'), html.indexOf('Other rooms') > 0 ? html.indexOf('Other rooms') : undefined);
  assert.equal(count(html, />Needs attention</g), 1);
  assert.doesNotMatch(html, />Occupied now</, 'attention rooms are not repeated under Occupied now');
  assert.equal(count(html, /Bathroom/g) - count(html.slice(html.indexOf('Other rooms')), /Bathroom/g), count(att, /Bathroom/g));
  assert.equal(count(html, /Bathroom details ›/g), 1);
  assert.equal(count(html, /Bedroom details ›/g), 1);
  assert.equal(count(html, /23\.1° vs 18° target, heating on/g), 1, 'sentence once');
  assert.match(html, /probably a shower/);
  assert.match(html, /target 5\.0° \(window open\)/);
  assert.equal(count(html.slice(html.indexOf('Other rooms')), /Bathroom|Bedroom/g), 0, 'not in the tiles either');
  assert.equal(count(html, /class="rt tap[" ]/g), 6);
  noNoise({ html, status }, 'attention v2');
});

ok('Now v2 groups are a partition of the rooms for every occupied/attention combination', () => {
  const keys = P.ROOM_ORDER;
  for (let occMask = 0; occMask < 256; occMask += 17) for (let attMask = 0; attMask < 256; attMask += 29) {
    const rooms = keys.map((k, i) => quietRoom(k, { occupied: !!(occMask & (1 << i)) }));
    const items = keys.filter((k, i) => attMask & (1 << i)).map((k) => attn(k, k, 'automation_disabled', 'Lights automation off'));
    const g = P.roomGroups(withRooms(rooms, items));
    const all = [...g.attention, ...g.occupied, ...g.other];
    assert.deepEqual([...all].sort(), [...keys].sort(), `mask ${occMask}/${attMask}`);
    assert.equal(new Set(all).size, 8);
    assert.deepEqual(g.attention, keys.filter((k, i) => attMask & (1 << i)));
  }
});

ok('Now v2 manual badge only while the marker exists; attention + manual combine', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T16:40:00+00:00', what: 'Wall button: scene cycled' };
  const occ = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual, lights_on: 2 } }), []), NOW);
  assert.match(occ, /Wall button · 2 h ago/);
  assert.equal(count(occ, /Wall button/g), 1);
  const none = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual: null } }), []), NOW);
  assert.doesNotMatch(none, /Wall button|Manual change/);
  const tile = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { manual } }), []), NOW);
  assert.match(tile, /Kitchen[\s\S]*Manual/);
  const both = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupied: true, manual, target_reason: 'window open', target: 5, heat_labels: ['Window open'], labels: ['Window open'] } }), [attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window')]), NOW);
  assert.match(both, /Needs attention/);
  assert.match(both, /Bedroom details ›/);
  assert.equal(count(both, /class="card oc tap"/g), 0);
});

ok('Now v2 hold badges (Window / Door) on occupied cards and tiles', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { occupied: true, heat_labels: ['Window open'] }, bedroom: { heat_labels: ['Window open'] }, hallway_downstairs: { heat_labels: ['Door open'] } }), []), NOW);
  assert.equal(count(html, /Window<\/span>/g), 2);
  assert.equal(count(html, /Door<\/span>/g), 1);
  assert.doesNotMatch(html, /Window open/);
});

ok('recent action note is a phrase with its verb ("lights off 7 min ago"), under 15 minutes, never a bare duration', () => {
  const at = (mins) => new Date(NOW - mins * 60000).toISOString();
  const feedOf = (mins, decision = 'turn_off', sub = 'lighting', loc = 'kitchen') => ({ 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify([{ loc, sub, decision, ts: at(mins), sentence: 'x', auto: `${loc}:lighting` }]), by_room: '[]' } } });
  const rec = (mins, decision, sub) => P.render('rooms', {}, withRooms(calmRooms(), [], feedOf(mins, decision, sub)), NOW);
  assert.match(rec(0.2), /<span>off just now<\/span>/);
  assert.match(rec(7), /<span>off 7 min ago<\/span>/);
  assert.match(rec(1, 'turn_on'), /<span>on 1 min ago<\/span>/);
  assert.match(rec(3, 'set_mode', 'heating'), /heating changed 3 min ago/);
  assert.doesNotMatch(rec(15), /min ago|just now/);
  assert.doesNotMatch(rec(120), /min ago|just now/);
  assert.doesNotMatch(rec(5, 'mystery_decision'), /min ago|just now|<span>\d+ min<\/span>/, 'unknown verb: no note rather than a bare duration');
  assert.doesNotMatch(rec(5, 'no_change'), /min ago/);
  for (const m of [0.2, 4, 14.5, 30]) assert.doesNotMatch(rec(m), /<span>\d+ min<\/span>|<span>just now<\/span>/);
  // occupied card carries it too
  const occ = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { occupied: true } }), [], feedOf(7)), NOW);
  assert.match(occ, /<span>off 7 min ago<\/span>/);
  assert.equal(P.recentNote({ states: {} }, 'kitchen', NOW), '');
});

ok('Now v2 tiles: unavailable occupancy keeps the dashed amber icon; rooms with no report say so; touch targets', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupancy_unavailable: true } }), []), NOW);
  assert.match(html, /aria-label="Occupancy unavailable"/);
  assert.match(html, /stroke-dasharray="2 2"/);
  const missing = P.render('rooms', {}, mk(), NOW);
  assert.equal(count(missing, /No report/g), 8);
  assert.equal(count(missing, /color:#8f9aa8">–</g), 7, 'seven rooms with a climate sensor show a muted dash; the climate-less hallway shows none');
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(P.STYLE, /\.rt\{[^\n]*height:104px/);
  assert.match(css, /\.oc\{[^}]*min-height:64px/);
});

ok('Now v2: the price strip is one 44px+ link to the Energy page; the chart is gone from Now; the energy view exists', () => {
  const html = P.render('status', {}, mk(), NOW);
  assert.equal(P.ENERGY_PATH, '/pulse-dashboard/energy');
  const link = html.match(/<a class="tap pstrip" data-act="nav" data-path="\/pulse-dashboard\/energy" aria-label="Open energy details">[\s\S]*?<\/a>/);
  assert.ok(link, 'strip is wrapped in one link');
  for (const word of ['>Now<', '>Next<', '>Usage<', ' p</span>', 'M9 5l7 7-7 7']) assert.ok(link[0].includes(word), word);
  assert.match(readFileSync(root + 'www/pulse-card.js', 'utf8'), /\.pstrip\{[^}]*min-height:56px/);
  assert.equal(count(html, /data-path="\/pulse-dashboard\/energy"/g), 1);
  assert.doesNotMatch(html, /data-chart|<rect|Tomorrow's rates/);
  // the Energy page's own head shows the same strip without linking to itself
  assert.doesNotMatch(P.render('energy-head', {}, mk(), NOW), /Open energy details/);
  const viewPaths = readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path);
  assert.ok(viewPaths.includes('energy'), 'the linked view exists');
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-energy\.yaml/);
  assert.throws(() => P.render('energy', {}, mk(), NOW), /unknown mode/);
});

ok('Now v2 feed limited to 3 rows, collapse kept', () => {
  const e = (i, t) => ({ loc: 'kitchen', ts: `2026-10-25T18:0${i}:00+00:00`, sentence: t, decision: 'turn_on', auto: 'k:l' });
  const entries = [e(9, 'Bathroom lights scene set'), e(8, 'Bathroom lights scene set'), e(7, 'Kitchen on'), e(6, 'Hall off'), e(5, 'Home office on')];
  const html = P.render('feed', {}, mk({ 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify(entries), by_room: '[]' } } }), NOW);
  assert.equal(count(html, /class="feed"/g), 3);
  assert.match(html, /<b>x2<\/b>/);
  assert.doesNotMatch(html, /Home office on/);
});

ok('Now v2 view layout: one status card first, groups, prices, bins/heating, feed, footer; no old modes', () => {
  const v = yaml.load(readFileSync(root + 'views/info-now.yaml', 'utf8'));
  const modes = v.sections[0].cards.map((c) => c.mode);
  assert.deepEqual(modes, ['now-header', 'status', 'rooms', 'bins-heating', 'feed', 'footer', 'tabbar']);
  for (const m of modes) assert.ok(P.render(m, {}, mk(), NOW) !== undefined);
  for (const old of ['attention', 'bins', 'heating', 'energy-foot', 'energy']) assert.throws(() => P.render(old, {}, mk(), NOW), /unknown mode/, old);
});

ok('Now v2 changes nothing HA only reads at startup', () => {
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card\.js\?v=2\b/);
});

// ── Energy page ──────────────────────────────────────────────────────────────────────────────
const tomorrow = JSON.parse(readFileSync(root + 'tests/fixtures/rates-2026-10-26-tomorrow.json', 'utf8'));
const EID = 'sensor.octopus_energy_electricity_24e8140196_1012483035417_previous_accumulative';
const GID = 'sensor.octopus_energy_gas_e6s15257822462_2986733608_previous_accumulative';
const day = (start, n = 48) => Array.from({ length: n }, (_, i) => ({ start: new Date(Date.parse(start) + i * 1800000).toISOString().replace('.000Z', '+00:00'), end: new Date(Date.parse(start) + (i + 1) * 1800000).toISOString().replace('.000Z', '+00:00'), value_inc_vat: 0.2 }));
const charges = (startIso, hours = 24, n = 48) => Array.from({ length: n }, (_, i) => ({ start: new Date(Date.parse(startIso) + i * (hours * 3600000 / n)).toISOString(), end: new Date(Date.parse(startIso) + (i + 1) * (hours * 3600000 / n)).toISOString(), cost: 0.1 }));
const energyHass = (extra = {}, todayRates = real, tomorrowRates = tomorrow) => mk({
  'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates: todayRates } },
  'event.octopus_energy_electricity_24e8140196_1012483035417_next_day_rates': { state: 'x', attributes: { rates: tomorrowRates } },
  'sensor.octopus_today_negative_windows': { state: '00:00–14:30 (-3.4p) · 22:00–23:00 (-0.5p)', attributes: {} },
  'sensor.octopus_today_cheap_windows': { state: '19:00–23:30 (4.9p)', attributes: {} },
  'sensor.octopus_tomorrow_negative_windows': { state: '—', attributes: {} },
  'sensor.octopus_tomorrow_cheap_windows': { state: '07:00–09:30 (6.1p)', attributes: {} },
  ...extra,
});

ok('energyStats: cheapest, dearest, time-weighted average (negatives, clock-change day, uneven slots)', () => {
  const t = P.energyStats(P.rateBands(real, Date.parse('2026-10-25T12:00:00Z')));
  assert.equal(t.slots, 50);
  assert.ok(Math.abs(t.cheapest.v - -7.54) < 1e-9);
  assert.match(t.cheapest.time, /^\d\d:\d\d$/);
  assert.ok(Math.abs(t.dearest.v - 33.35) < 1e-9);
  assert.equal(t.dearest.time, '17:00');
  const mean = real.reduce((a, r) => a + r.value_inc_vat * 100, 0) / real.length;
  assert.ok(Math.abs(t.avg - mean) < 1e-9, 'equal slots: weighted == simple mean');
  const tom = P.energyStats(P.rateBands(tomorrow, NOW));
  assert.equal(tom.slots, 46);
  // uneven slots: 1h at 10p and 30min at -10p -> (10*60 + -10*30)/90 = 3.33p
  const w = P.energyStats([{ start: 0, end: 3600000, v: 10 }, { start: 3600000, end: 5400000, v: -10 }]);
  assert.ok(Math.abs(w.avg - 10 / 3) < 1e-9);
  assert.equal(w.cheapest.v, -10);
  assert.equal(P.energyStats([]), null);
  assert.equal(P.energyStats(undefined), null);
  assert.equal(P.energyStats([null, {}, { start: 1, end: 1, v: 1 }]), null);
  assert.equal(P.penceText(-7.54), '−7.5p');
  assert.equal(P.penceText(NaN), '–');
});

const winOn = (rates) => P.slotWindows(P.rateBands(rates, NOW), 'negative');
const fmtWin = (w) => `${P.windowRange(w)} avg ${P.penceText(w.avg)}`;

ok('windows from the slot list: real clock-change day gives ONE negative run, no overlaps or zero-length windows', () => {
  const slots = P.rateBands(real, NOW);
  const neg = P.slotWindows(slots, 'negative');
  const cheap = P.slotWindows(slots, 'cheap');
  for (const list of [neg, cheap]) {
    list.forEach((w, i) => { assert.ok(w.end > w.start, 'never zero-length'); if (i) assert.ok(w.start > list[i - 1].end, 'no overlap and not adjacent (they would have merged)'); });
  }
  assert.equal(neg.length, 1);
  assert.equal(neg[0].start, Date.parse('2026-10-24T23:00:00Z'));
  assert.equal(neg[0].end, Date.parse('2026-10-25T14:30:00Z'), 'one negative run ending 14:30');
  assert.ok(neg[0].avg < 0);
  const expected = real.filter((r) => r.value_inc_vat < 0).length;
  assert.equal(slots.filter((x) => x.v < 0 && x.end <= neg[0].end).length, expected);
  // cheap = 0 <= p < 10: every cheap window sits outside the negative run and is bounded by dearer or negative slots
  assert.ok(cheap.length >= 1);
  assert.ok(cheap.every((w) => w.start >= neg[0].end || w.end <= neg[0].start));
  // input order must not matter (the template bug was an order bug)
  const shuffled = [...real].reverse();
  assert.deepEqual(P.slotWindows(P.rateBands(shuffled, NOW), 'negative'), neg);
  assert.deepEqual(P.slotWindows([...slots].sort(() => 0.5 - Math.random()), 'cheap').map((w) => w.start), cheap.map((w) => w.start));
});

ok('windows: tomorrow (46 slots), ordinary 48-slot day, empty, one slot, thresholds', () => {
  const tom = P.rateBands(tomorrow, NOW);
  for (const kind of ['negative', 'cheap']) for (const w of P.slotWindows(tom, kind)) assert.ok(w.end > w.start);
  const ord = day('2026-03-02T00:00:00Z', 48).map((r, i) => ({ ...r, value_inc_vat: (i < 4 ? -0.02 : i < 8 ? 0.05 : i < 10 ? 0.1 : i === 12 ? -0.01 : 0.3) }));
  const slots = P.rateBands(ord, Date.parse('2026-03-02T12:00:00Z'));
  const neg = P.slotWindows(slots, 'negative');
  assert.equal(neg.length, 2);
  assert.deepEqual(neg.map((w) => (w.end - w.start) / 1800000), [4, 1]);
  const cheap = P.slotWindows(slots, 'cheap');
  assert.deepEqual(cheap.map((w) => (w.end - w.start) / 1800000), [4], '0.10 is not cheap (< 10p only); adjacent 0.05 slots merge');
  assert.ok(Math.abs(neg[0].avg - -2) < 1e-9);
  assert.ok(Math.abs(cheap[0].avg - 5) < 1e-9);
  assert.deepEqual(P.slotWindows([], 'negative'), []);
  assert.deepEqual(P.slotWindows(undefined, 'cheap'), []);
  assert.deepEqual(P.slotWindows([null, {}, { start: 1, end: 1, v: -1 }], 'negative'), []);
  assert.equal(P.slotWindows([{ start: 0, end: 1800000, v: -1 }], 'negative').length, 1);
  // exactly zero is cheap, not negative
  assert.equal(P.slotWindows([{ start: 0, end: 1800000, v: 0 }], 'negative').length, 0);
  assert.equal(P.slotWindows([{ start: 0, end: 1800000, v: 0 }], 'cheap').length, 1);
  // a gap in the list splits a window
  assert.equal(P.slotWindows([{ start: 0, end: 1800000, v: -1 }, { start: 3600000, end: 5400000, v: -1 }], 'negative').length, 2);
});

ok('windows card renders them for the selected day with graded colour; none / empty days honest', () => {
  const hass = energyHass();
  const t = P.render('energy-day', {}, hass, NOW, {});
  assert.equal(count(t, />Negative</g), 1, 'one negative run, not a scrambled list');
  assert.match(t, /Negative<\/div><div class="m">23:00 → 14:30<\/div>[\s\S]*?avg −\d/); // TZ=UTC here; London shows 00:00 → 14:30 (child-process test)
  assert.match(t, /Cheap<\/div><div class="m">/);
  assert.equal(count(t, /→ 01:00/g), 0);
  const m = P.render('energy-day', {}, hass, NOW, { day: 'tomorrow' });
  assert.ok(/Negative<\/div><div class="m">none/.test(m) || /Negative<\/div><div class="m">\d\d:\d\d → \d\d:\d\d/.test(m));
  const e = P.render('energy-day', {}, energyHass({}, real, []), NOW, { day: 'tomorrow' });
  assert.doesNotMatch(e, />Negative<|>Cheap</);
  const quiet = day('2026-03-02T00:00:00Z', 48);
  const q = P.render('energy-day', {}, energyHass({}, quiet, quiet), Date.parse('2026-03-02T12:00:00Z'), {});
  assert.match(q, /Negative<\/div><div class="m">none/);
  assert.match(q, /Cheap<\/div><div class="m">none/);
});

ok('window labels in Europe/London on the real clock-change day (child process, TZ set before Date is used)', () => {
  const script = `
    const P = require(${JSON.stringify(root + 'www/pulse-card.js')});
    const real = require(${JSON.stringify(root + 'tests/fixtures/rates-2026-10-25-clock-change.json')});
    const tom = require(${JSON.stringify(root + 'tests/fixtures/rates-2026-10-26-tomorrow.json')});
    const f = (r, k) => P.slotWindows(P.rateBands(r, 0), k).map((w) => P.windowRange(w));
    console.log(JSON.stringify({ neg: f(real, 'negative'), cheap: f(real, 'cheap'), tneg: f(tom, 'negative'), tcheap: f(tom, 'cheap') }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Europe/London' } }).toString());
  assert.deepEqual(out.neg, ['00:00 → 14:30']);
  for (const list of Object.values(out)) for (const label of list) { const [a, b] = label.split(' → '); assert.notEqual(a, b, label); assert.doesNotMatch(label, /NaN|undefined/); }
});

ok('windowRange: a window spanning the repeated hour is never printed zero-length', () => {
  const script = `
    const P = require(${JSON.stringify(root + 'www/pulse-card.js')});
    const w = { start: Date.parse('2026-10-25T00:00:00Z'), end: Date.parse('2026-10-25T01:00:00Z') };
    console.log(P.windowRange(w));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Europe/London' } }).toString().trim();
  assert.match(out, /^01:00 [A-Z+0-9:]+ → 01:00 [A-Z+0-9:]+$/);
  assert.notEqual(out.split(' → ')[0], out.split(' → ')[1]);
});

ok('energy page: head has back link, Now/Next/Usage', () => {
  const html = P.render('energy-head', {}, energyHass({ 'sensor.glow_electricity_power': { state: '0.44', attributes: { unit_of_measurement: 'kW' }, last_updated: '2026-10-25T18:41:50+00:00' } }), NOW);
  assert.match(html, /data-path="\/pulse-dashboard\/now" aria-label="Back to Now"/);
  assert.match(html, />Energy</);
  assert.ok(html.includes(`color:${P.priceColour(34.8, { text: true })}`));
  assert.match(html, />Usage<\/div><div[^>]*>440 W/);
});

ok('energy page day toggle: Today (50 slots) <-> Tomorrow (46 slots), pressed state, no now marker tomorrow', () => {
  const hass = energyHass();
  const t = P.render('energy-day', {}, hass, Date.parse('2026-10-25T18:29:00Z'), {});
  assert.match(t, /class="seg on" data-act="energy-day" data-day="today" aria-pressed="true"/);
  assert.match(t, /data-day="tomorrow" aria-pressed="false"/);
  assert.equal(rect(t).length, 50);
  assert.match(t, /data-chart data-day="today" data-n="50"/);
  assert.match(t, /stroke-dasharray="2 2"/, 'now marker today');
  const m = P.render('energy-day', {}, hass, Date.parse('2026-10-25T18:29:00Z'), { day: 'tomorrow' });
  assert.match(m, /class="seg on" data-act="energy-day" data-day="tomorrow" aria-pressed="true"/);
  assert.equal(rect(m).length, 46);
  assert.match(m, /data-day="tomorrow" data-n="46"/);
  assert.doesNotMatch(m, /stroke-dasharray="2 2"[^>]*vector-effect/, 'no now marker on tomorrow');
  assert.ok(rect(m).every((b) => b.op === 1), 'nothing is dimmed as past tomorrow');
  assert.match(m, /viewBox="0 0 276 96"/); // 46 slots x 6
  noNoise({ t, m }, 'energy day');
  assert.equal(P.render('energy-day', {}, hass, NOW, { day: 'bogus' }).includes('data-day="today" aria-pressed="true"'), true);
});

ok('energy page stats tiles follow the selected day', () => {
  const hass = energyHass();
  const t = P.render('energy-day', {}, hass, NOW, {});
  assert.match(t, /Cheapest<\/div><div class="v" style="color:#[0-9a-f]{6}">−7\.5p<\/div><div class="s">at \d\d:\d\d/);
  assert.match(t, /Dearest<\/div><div class="v"[^>]*>33\.4p<\/div><div class="s">at 17:00/);
  assert.match(t, /Average<\/div><div class="v"[^>]*>[−\d.]+p<\/div><div class="s">per kWh/);
  const m = P.render('energy-day', {}, hass, NOW, { day: 'tomorrow' });
  const st = P.energyStats(P.rateBands(tomorrow, NOW));
  assert.ok(m.includes(`>${P.penceText(st.dearest.v)}<`));
  assert.ok(m.includes(`at ${st.dearest.time}`));
});

ok('energy page: tomorrow missing / empty / unavailable shows the honest empty state', () => {
  for (const rates of [[], undefined, 'unavailable', [null], 'x']) {
    const html = P.render('energy-day', {}, energyHass(rates === undefined ? { 'event.octopus_energy_electricity_24e8140196_1012483035417_next_day_rates': null } : {}, real, rates), NOW, { day: 'tomorrow' });
    assert.match(html, /Tomorrow's rates are not in yet/);
    assert.match(html, /published late afternoon/);
    assert.doesNotMatch(html, /<rect|data-chart|Cheapest<\/div>/);
    assert.match(html, /class="seg on" data-act="energy-day" data-day="tomorrow"/);
    noNoise({ html }, 'tomorrow empty');
  }
  const todayEmpty = P.render('energy-day', {}, energyHass({}, [], tomorrow), NOW, {});
  assert.match(todayEmpty, /No price data for today/);
  assert.doesNotMatch(P.render('energy-day', {}, { states: {} }, NOW, {}), NOISE);
});

ok('covered day: derived from charges, otherwise "latest complete day"; never guessed', () => {
  assert.equal(P.isoDayLabel('2026-10-23T00:00:00+01:00'), 'Fri 23 Oct');
  assert.equal(P.isoDayLabel('2026-10-23'), 'Fri 23 Oct');
  for (const bad of [null, undefined, 5, 'x', '2026-13-45']) assert.ok([null, 'Fri 23 Oct'].includes(P.isoDayLabel(bad)) || typeof P.isoDayLabel(bad) === 'string');
  const full = { charges: charges('2026-10-22T23:00:00Z') };
  full.charges = full.charges.map((c, i) => (i === 0 ? { ...c, start: '2026-10-23T00:00:00+01:00' } : c));
  assert.equal(P.coveredDay(full), 'Fri 23 Oct');
  assert.equal(P.coveredDay({ charges: charges('2026-10-22T23:00:00Z', 5, 10).map((c, i) => (i === 0 ? { ...c, start: '2026-10-23T00:00:00+01:00' } : c)) }), null, 'a partial day is not labelled');
  for (const bad of [undefined, null, {}, { charges: [] }, { charges: 'x' }, { charges: [{ start: 'nope' }] }]) assert.equal(P.coveredDay(bad), null);
});

ok('standing charge is only claimed when the attributes prove it (live shapes: rounding tolerant)', () => {
  const at = (without, standing) => ({ total_without_standing_charge: without, standing_charge: standing });
  assert.equal(P.standingNote(3.58, at(3.11, 0.46)), 'incl. standing charge'); // live electricity: sum is 3.57
  assert.equal(P.standingNote(2.84, at(2.56, 0.28)), 'incl. standing charge'); // live gas: exact
  assert.equal(P.standingNote(3.58, at(3.11, 0.46)), P.standingNote(3.57, at(3.11, 0.46)));
  assert.equal(P.standingNote(3.9, at(3.11, 0.46)), '', 'a genuinely different total makes no claim');
  assert.equal(P.standingNote(2.9, at(2.9, 0.52)), 'excl. standing charge');
  assert.equal(P.standingNote(3.58, { total_without_standing_charge: 3.11 }), '', 'standing charge missing');
  assert.equal(P.standingNote(3.58, { standing_charge: 0.46 }), '', 'without-standing missing');
  assert.equal(P.standingNote(3.58, {}), '');
  assert.equal(P.standingNote(null, at(3.11, 0.46)), '');
  assert.equal(P.standingNote(3.58, undefined), '');
  assert.equal(P.standingNote(3.58, at('x', 'y')), '');
});

ok('covered day on a 25-hour clock-change day: 50 charges from 2026-10-25T00:00:00+01:00 still derive the date', () => {
  const c = Array.from({ length: 50 }, (_, i) => {
    const t = Date.parse('2026-10-24T23:00:00Z') + i * 1800000;
    return { start: i === 0 ? '2026-10-25T00:00:00+01:00' : new Date(t).toISOString(), end: new Date(t + 1800000).toISOString(), cost: 0.1 };
  });
  assert.equal(P.coveredDay({ charges: c }), 'Sun 25 Oct');
  assert.equal(P.coveredDay({ charges: c.slice(0, 40) }), null, 'a partial list is still refused');
  const r = P.render('energy-cost', {}, mk({ [`${EID}_cost`]: { state: '3.58', attributes: { unit_of_measurement: 'GBP', charges: c, total_without_standing_charge: 3.11, standing_charge: 0.46 } } }), NOW);
  assert.match(r, /£3\.58<\/div><div[^>]*>Sun 25 Oct · – · incl\. standing charge</);
});

ok('cost card: published values labelled with their day, unavailable dashes, missing date says latest complete day', () => {
  const e = { unit_of_measurement: 'GBP', charges: charges('2026-10-22T23:00:00Z').map((c, i) => (i === 0 ? { ...c, start: '2026-10-23T00:00:00+01:00' } : c)), total_without_standing_charge: 2.9, standing_charge: 0.52 };
  const hass = mk({ [`${EID}_cost`]: { state: '3.42', attributes: e }, [`${EID}_consumption`]: { state: '9.4', attributes: { unit_of_measurement: 'kWh' } }, [`${GID}_cost`]: { state: '1.2', attributes: { unit_of_measurement: 'GBP' } }, [`${GID}_consumption_kwh`]: { state: '10.04', attributes: { unit_of_measurement: 'kWh' } } });
  const html = P.render('energy-cost', {}, hass, NOW);
  assert.match(html, /Electricity<\/div><div class="v">£3\.42<\/div><div[^>]*>Fri 23 Oct · 9\.4 kWh · incl\. standing charge</);
  assert.match(html, /Gas<\/div><div class="v">£1\.20<\/div><div[^>]*>latest complete day · 10\.0 kWh</);
  assert.doesNotMatch(html, /Gas[\s\S]*standing/);
  assert.match(html, /Octopus publishes about 1-2 days late/);
  const dash = P.render('energy-cost', {}, mk({ [`${EID}_cost`]: { state: 'unavailable', attributes: {} } }), NOW);
  assert.equal(count(dash, /class="v">–</g), 2);
  assert.match(dash, /latest complete day · –/);
  assert.match(P.render('energy-cost', {}, mk({ [`${EID}_cost`]: { state: '3.42', attributes: { unit_of_measurement: 'USD' } } }), NOW), /class="v">–</);
  noNoise({ html, dash }, 'cost');
  assert.equal(P.money(-1.5, 'GBP'), '−£1.50');
});

ok('usage card: unit-aware kWh, dashes for unavailable / unknown units, labelled as live meter', () => {
  const g = (v, u) => ({ state: v, attributes: u ? { unit_of_measurement: u } : {} });
  const html = P.render('energy-usage', {}, mk({ 'sensor.glow_electricity_today': g('17.9', 'kWh'), 'sensor.glow_electricity_month': g('142.33', 'kWh'), 'sensor.glow_gas_today': g('3100', 'Wh'), 'sensor.glow_gas_month': g('unavailable', 'kWh') }), NOW);
  assert.match(html, /Electricity today<\/div><div class="v">17\.9 <span>kWh<\/span>/);
  assert.match(html, /Electricity this month<\/div><div class="v">142 <span>kWh<\/span>/);
  assert.match(html, /Gas today<\/div><div class="v">3\.1 <span>kWh<\/span>/);
  assert.match(html, /Gas this month<\/div><div class="v">–</);
  assert.match(html, /smart meter, live/);
  const nounit = P.render('energy-usage', {}, mk({ 'sensor.glow_electricity_today': g('17.9') }), NOW);
  assert.match(nounit, /Electricity today<\/div><div class="v">–</);
  assert.equal(P.energyText('1', 'MWh'), '1000 kWh');
  assert.equal(P.energyText(null, 'kWh'), '–');
  noNoise({ html, nounit }, 'usage');
});

ok('energy page: sparse / missing / garbage data never throws or leaks noise in any energy mode', () => {
  for (const hass of [{ states: {} }, mk(), energyHass({ 'sensor.glow_gas_today': { state: 'x', attributes: null }, [`${EID}_cost`]: { state: '1', attributes: { charges: 5 } } }), energyHass({}, 'junk', 7)]) {
    for (const m of ['energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage']) for (const ui of [{}, { day: 'tomorrow' }, undefined]) noNoise({ x: P.render(m, {}, hass, NOW, ui) }, m);
  }
});

ok('energy view is registered and adds no write paths', () => {
  const v = yaml.load(readFileSync(root + 'views/info-energy.yaml', 'utf8'));
  assert.equal(v.path, 'energy');
  assert.equal(v.subview, true);
  assert.equal(v.back_path, '/pulse-dashboard/now');
  assert.deepEqual(v.sections[0].cards.map((c) => c.mode), ['energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage', 'tabbar']);
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-energy\.yaml/);
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['input_boolean', 'light', 'media_player', 'scene', 'switch']);
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card\.js\?v=2\b/);
});

// ── Daily cost history ───────────────────────────────────────────────────────────────────────
const ECOST = P.COST_STAT.electricity;
const GCOST = P.COST_STAT.gas;
// Known-good electricity series from the recorder spike: last_reset UTC instant -> cost (covered local day = UTC date + 1).
const KNOWN = [['2026-10-13T23:00:00Z', 3.07], ['2026-10-14T23:00:00Z', 3.15], ['2026-10-15T23:00:00Z', 3.43], ['2026-10-16T23:00:00Z', 3.16], ['2026-10-17T23:00:00Z', 2.78], ['2026-10-18T23:00:00Z', 3.18], ['2026-10-19T23:00:00Z', 3.56], ['2026-10-20T23:00:00Z', 3.61], ['2026-10-21T23:00:00Z', 2.75], ['2026-10-22T23:00:00Z', 3.58]];
// hourly rows for one covered day: the rows' own `start` is ~27 h after last_reset onward (NOT the covered day)
const hourly = (resetIso, cost, count = 24, form = 'ms') => Array.from({ length: count }, (_, i) => {
  const reset = Date.parse(resetIso);
  const start = reset + (27 + i) * 3600000;
  // the same instant written three ways: Z, +00:00 and the local +01:00 form
  const iso = [new Date(reset).toISOString(), new Date(reset).toISOString().replace('.000Z', '+00:00'), new Date(reset + 3600000).toISOString().replace('.000Z', '+01:00')][i % 3];
  return { start: form === 'iso' ? new Date(start).toISOString() : start, end: start + 3600000, state: cost, last_reset: form === 'iso' ? iso : reset, sum: 100 + i, change: i === 0 ? cost : 0 };
});
const knownRows = (form) => KNOWN.flatMap(([r, c]) => hourly(r, c, 24, form));
const TZ = 'Europe/London';

ok('history: groups by last_reset INSTANT (mixed +00:00 / +01:00 / Z / ms / seconds forms are one group)', () => {
  const reset = Date.parse('2026-10-22T23:00:00Z');
  const forms = [reset, reset / 1000, '2026-10-22T23:00:00Z', '2026-10-22T23:00:00+00:00', '2026-10-23T00:00:00+01:00'];
  const rows = forms.flatMap((f) => hourly('2026-10-22T23:00:00Z', 3.58, 5).map((r) => ({ ...r, last_reset: f })));
  const d = P.groupDailyCost(rows, TZ, { minRows: 20 });
  assert.equal(d.length, 1);
  assert.equal(d[0].rows, 25);
  assert.equal(d[0].date, '2026-10-23');
  assert.equal(d[0].cost, 3.58);
  assert.equal(P.instantMs('2026-10-23T00:00:00+01:00'), P.instantMs('2026-10-22T23:00:00+00:00'));
  assert.equal(P.instantMs(1792885200), 1792885200000);
});

ok('history: the known-good electricity fixture gives covered days 14..23 Oct with the right costs (ms and ISO inputs)', () => {
  for (const form of ['ms', 'iso']) {
    const d = P.groupDailyCost(knownRows(form), TZ);
    assert.deepEqual(d.map((x) => x.date), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'], form);
    assert.deepEqual(d.map((x) => x.cost), KNOWN.map((k) => k[1]));
    assert.ok(d.every((x) => x.rows === 24));
  }
  // `change` on a group's first row equals the new state (sanity, not displayed)
  const rows = hourly('2026-10-22T23:00:00Z', 3.58);
  assert.equal(rows[0].change, rows[0].state);
});

ok('history: covered date across BST, GMT and both clock changes (no last_reset + 1h arithmetic)', () => {
  const date = (iso) => P.localDate(Date.parse(iso), TZ);
  assert.equal(date('2026-10-22T23:00:00Z'), '2026-10-23'); // BST midnight
  assert.equal(date('2026-10-24T23:00:00Z'), '2026-10-25'); // local midnight 25 Oct (still BST)
  assert.equal(date('2026-10-26T00:00:00Z'), '2026-10-26'); // local midnight 26 Oct (GMT)
  assert.equal(date('2026-11-10T00:00:00Z'), '2026-11-10'); // winter
  assert.equal(date('2027-03-28T00:00:00Z'), '2027-03-28'); // spring: local midnight 28 Mar (GMT)
  assert.equal(date('2027-03-28T23:00:00Z'), '2027-03-29'); // local midnight 29 Mar (BST)
  // the 25 Oct day is 25 h long; its group and the next group are different days
  const rows = [...hourly('2026-10-24T23:00:00Z', 4.1, 25), ...hourly('2026-10-26T00:00:00Z', 3.3, 24)];
  const d = P.groupDailyCost(rows, TZ);
  assert.deepEqual(d.map((x) => x.date), ['2026-10-25', '2026-10-26']);
  assert.equal(P.localDate(Date.parse('2026-10-22T23:00:00Z'), 'Not/AZone'), P.localDate(Date.parse('2026-10-22T23:00:00Z'), undefined), 'bad zone falls back');
});

ok('history: partial groups are dropped except the newest (still open); fewer than 14 days just shows fewer', () => {
  const rows = [...hourly('2026-10-19T23:00:00Z', 3.56), ...hourly('2026-10-20T23:00:00Z', 9.99, 5), ...hourly('2026-10-21T23:00:00Z', 2.75), ...hourly('2026-10-22T23:00:00Z', 3.58, 3)];
  const d = P.groupDailyCost(rows, TZ);
  assert.deepEqual(d.map((x) => [x.date, x.cost]), [['2026-10-20', 3.56], ['2026-10-22', 2.75], ['2026-10-23', 3.58]]);
  assert.equal(P.groupDailyCost(hourly('2026-10-22T23:00:00Z', 3.58, 1), TZ).length, 1, 'a lone newest group is kept');
  const many = Array.from({ length: 30 }, (_, i) => hourly(new Date(Date.parse('2026-09-01T23:00:00Z') + i * 86400000).toISOString(), 3 + i / 100)).flat();
  const d14 = P.groupDailyCost(many, TZ);
  assert.equal(d14.length, 14);
  assert.equal(d14[13].cost, 3.29, 'the most recent 14 days');
});

ok('history: empty / garbage / missing inputs never throw or invent days', () => {
  for (const bad of [undefined, null, 5, 'x', {}, [], [null], [{}], [{ state: 'x', last_reset: 'y' }], [{ state: 3, last_reset: null }], [{ state: null, last_reset: 5 }]]) assert.deepEqual(P.groupDailyCost(bad, TZ), [], JSON.stringify(bad));
  assert.deepEqual(P.dailyCostFromWS(undefined, TZ), { electricity: [], gas: [] });
  assert.deepEqual(P.dailyCostFromWS({ [ECOST]: 'x', [GCOST]: [{ junk: 1 }] }, TZ), { electricity: [], gas: [] });
  const both = P.dailyCostFromWS({ [ECOST]: hourly('2026-10-22T23:00:00Z', 3.58), [GCOST]: hourly('2026-10-23T23:00:00Z', 2.84) }, TZ);
  assert.equal(both.electricity[0].date, '2026-10-23');
  assert.equal(both.gas[0].date, '2026-10-24');
});

ok('history request is a read-only recorder statistics call for the two cost sensors (hourly, 21 days)', () => {
  const r = P.histRequest(Date.parse('2026-10-25T12:00:00Z'));
  assert.equal(r.type, 'recorder/statistics_during_period');
  assert.equal(r.period, 'hour');
  assert.deepEqual(r.statistic_ids, [ECOST, GCOST]);
  assert.ok(r.statistic_ids.every((id) => id.startsWith('sensor.') && !id.startsWith('octopus_energy:')));
  assert.equal(r.start_time, '2026-10-04T12:00:00.000Z');
  assert.deepEqual(r.types, ['state', 'last_reset', 'sum', 'change']);
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['input_boolean', 'light', 'media_player', 'scene', 'switch']);
  assert.ok(!('recorder' in P.ALLOWED) && !('mqtt' in P.ALLOWED));
});

const histUi = (fuel, e, g, statusE = 'ok', statusG = 'ok') => ({ fuel, hist: { electricity: { status: statusE, days: e || [] }, gas: { status: statusG, days: g || [] } } });
const elecDays = () => P.groupDailyCost(knownRows('ms'), TZ);

ok('history section: bars, scaling, latest highlighted, ticks, summary, readout text', () => {
  const days = elecDays();
  const hass = mk({ [ECOST]: { state: '3.58', attributes: { unit_of_measurement: 'GBP', total_without_standing_charge: 3.11, standing_charge: 0.46 } } });
  const html = P.render('energy-history', {}, hass, NOW, histUi('electricity', days));
  assert.match(html, />Daily cost</);
  assert.match(html, /class="seg on" data-act="cost-fuel" data-fuel="electricity" aria-pressed="true"/);
  assert.match(html, /data-fuel="gas" aria-pressed="false"/);
  const bars = [...html.matchAll(/<rect x="(\d+)" y="([\d.]+)" width="(\d+)" height="([\d.]+)" rx="2" fill="#7aa7ff" opacity="([\d.]+)"\/>/g)].map((m) => ({ y: +m[2], h: +m[4], op: +m[5] }));
  assert.equal(bars.length, 10);
  assert.equal(bars[9].op, 1);
  assert.ok(bars.slice(0, 9).every((b) => b.op === 0.55));
  const base = Number(html.match(/<line x1="0" x2="240" y1="([\d.]+)"/)[1]);
  assert.ok(bars.every((b) => Math.abs(b.y + b.h - base) < 0.06), 'every bar grows from the zero baseline');
  const hmax = Math.max(...bars.map((b) => b.h));
  assert.ok(Math.abs(bars[7].h / hmax - 1) < 1e-6, 'the dearest day (3.61) is the tallest');
  assert.ok(Math.abs(bars[8].h / hmax - 2.75 / 3.61) < 0.02, 'heights are proportional from zero');
  assert.match(html, /viewBox="0 0 240 96"/);
  assert.match(html, /data-chart data-kind="cost" data-n="10"/);
  assert.match(html, />Fri 23</);
  assert.match(html, /aria-label="Daily cost, 10 days\. Highest £3\.61 on Wed 21 Oct, lowest £2\.75 on Thu 22 Oct, latest £3\.58 on Fri 23 Oct\."/);
  assert.match(html, /10-day average £3\.23 · incl\. standing charge/);
  assert.match(html, /Published about 1-2 days late/);
  const noClaim = P.render('energy-history', {}, mk({ [ECOST]: { state: '3.58', attributes: { unit_of_measurement: 'GBP' } } }), NOW, histUi('electricity', days));
  assert.match(noClaim, /10-day average £3\.23</);
  assert.doesNotMatch(noClaim, /standing/);
  const r = P.dayReadout({ date: '2026-10-23', v: 3.58, state: 'current' });
  assert.equal(`${r.range} · ${r.price}`, 'Fri 23 Oct · £3.58');
  assert.equal(r.note, 'latest');
  assert.equal(P.dayReadout({ date: '2026-10-22', v: 3.58, state: 'past' }).note, '');
  assert.equal(P.dayReadout({ date: 'nope', v: 1 }), null);
  assert.equal(P.dayReadout({ date: '2026-10-23', v: NaN }), null);
  assert.equal(P.dailySummary([], 'incl. standing charge'), '');
  noNoise({ html }, 'history');
});

ok('history section: toggle shows gas, fewer than 14 days, loading / unavailable / empty are honest, never fake bars', () => {
  const g = P.groupDailyCost(hourly('2026-10-23T23:00:00Z', 2.84), TZ);
  const hass = mk({});
  const gas = P.render('energy-history', {}, hass, NOW, histUi('gas', elecDays(), g));
  assert.match(gas, /class="seg on" data-act="cost-fuel" data-fuel="gas" aria-pressed="true"/);
  assert.equal(count(gas, /<rect /g), 1);
  assert.match(gas, /1-day average £2\.84/);
  assert.match(gas, />Sat 24</);
  const loading = P.render('energy-history', {}, hass, NOW, undefined);
  assert.match(loading, /Loading history/);
  assert.doesNotMatch(loading, /<rect/);
  const loading2 = P.render('energy-history', {}, hass, NOW, histUi('electricity', [], [], 'loading', 'loading'));
  assert.match(loading2, /Loading history/);
  for (const ui of [histUi('electricity', [], [], 'unavailable'), histUi('electricity', [], [], 'ok'), { fuel: 'electricity', hist: 'junk' }, { fuel: 'weird', hist: null }]) {
    const html = P.render('energy-history', {}, hass, NOW, ui);
    assert.match(html, /History unavailable|Loading history/);
    assert.doesNotMatch(html, /<rect|data-chart/);
  }
});

await okAsync('history runtime: one WS call on mount, no call per hass update, 30 min refresh, no overlap, stale and unmount guarded, failures swallowed', async () => {
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, window: globalThis.window, warn: console.warn, now: Date.now };
  let Card;
  globalThis.HTMLElement = class { constructor() { this.style = {}; } attachShadow() { return { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, innerHTML: '' }; } };
  globalThis.customElements = { get() { return undefined; }, define(n, c) { if (n === 'pulse-card') Card = c; } };
  globalThis.window = { customCards: [] };
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  let clock = Date.parse('2026-10-25T12:00:00Z');
  Date.now = () => clock;
  try {
    const modPath = new URL('../www/pulse-card.js', import.meta.url).pathname;
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    assert.ok(Card, 'custom element registered');
    const mkCard = (connected = true) => { const c = new Card(); Object.defineProperty(c, 'isConnected', { get: () => connected, configurable: true }); c.setConfig({ mode: 'energy-history' }); return c; };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const calls = [];
    const gate = {};
    const hassWith = (impl) => ({ states: {}, config: { time_zone: 'Europe/London' }, callWS: (req) => { calls.push(req); return impl(req); } });
    const ok1 = { [ECOST]: hourly('2026-10-22T23:00:00Z', 3.58), [GCOST]: hourly('2026-10-23T23:00:00Z', 2.84) };

    // mount -> exactly one call; repeated hass updates do not call again; data lands
    let c = mkCard();
    c.hass = hassWith(async () => ok1);
    c.hass = hassWith(async () => ok1);
    c.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 1, 'overlap guard + once on mount');
    await flush();
    assert.equal(c._ui.hist.electricity.status, 'ok');
    assert.equal(c._ui.hist.electricity.days[0].date, '2026-10-23');
    assert.equal(c._ui.hist.gas.days[0].date, '2026-10-24');
    c.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 1, 'no call per hass update');
    clock += 29 * 60000; c.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 1, 'not before 30 minutes');
    clock += 2 * 60000; c.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 2, 'refresh after 30 minutes');
    await flush();

    // failure -> unavailable + console.warn, retry only after 5 minutes
    calls.length = 0; warns.length = 0;
    c = mkCard();
    c.hass = hassWith(async () => { throw new Error('boom'); });
    await flush();
    assert.equal(c._ui.hist.electricity.status, 'unavailable');
    assert.ok(warns.some((w) => /daily cost history unavailable/.test(w)));
    clock += 60000; c.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 1, 'no hammering after a failure');
    clock += 5 * 60000; c.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 2, 'retries after 5 minutes');
    await flush();
    assert.equal(c._ui.hist.electricity.status, 'ok');

    // empty statistics -> unavailable, never fake bars
    calls.length = 0;
    c = mkCard();
    c.hass = hassWith(async () => ({ [ECOST]: [], [GCOST]: [] }));
    await flush();
    assert.equal(c._ui.hist.electricity.status, 'unavailable');
    assert.equal(c._ui.hist.electricity.days.length, 0);

    // no callWS at all -> unavailable without throwing
    c = mkCard();
    c.hass = { states: {}, config: {} };
    assert.equal(c._ui.hist.gas.status, 'unavailable');

    // unmount while a call is in flight -> the late response is dropped
    c = mkCard();
    let release;
    c.hass = hassWith(() => new Promise((r) => { release = () => r(ok1); }));
    c.disconnectedCallback();
    release();
    await flush();
    assert.equal(c._ui.hist.electricity.status, 'loading', 'stale response after unmount ignored');

    // not connected / wrong mode -> no call
    calls.length = 0;
    const d = mkCard(false);
    d.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 0);
    const w = new Card(); Object.defineProperty(w, 'isConnected', { get: () => true }); w.setConfig({ mode: 'rooms' });
    w.hass = hassWith(async () => ok1);
    assert.equal(calls.length, 0, 'only the history card fetches');
  } finally {
    Object.assign(globalThis, { HTMLElement: saved.HTMLElement, customElements: saved.customElements, window: saved.window });
    if (saved.HTMLElement === undefined) delete globalThis.HTMLElement;
    if (saved.customElements === undefined) delete globalThis.customElements;
    if (saved.window === undefined) delete globalThis.window;
    console.warn = saved.warn; Date.now = saved.now;
    delete require.cache[require.resolve(new URL('../www/pulse-card.js', import.meta.url).pathname)];
    require(new URL('../www/pulse-card.js', import.meta.url).pathname);
  }
});

// ── Correctness fixes ─────────────────────────────────────────────────────────────────────────
ok('person icon for occupancy on every room page; no bed icon anywhere in the Why rows', () => {
  const person = 'M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 20a7 7 0 0 1 14 0';
  const bed = 'M4 20v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M4 16h16M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3';
  for (const k of P.ROOM_ORDER) {
    const why = P.render('why', { room: k }, withRooms(P.ROOM_ORDER.map((x) => quietRoom(x, { occupied: true, pres_labels: ['Bed occupied'], labels: ['Bed occupied'] })), []), NOW);
    assert.ok(why.includes(person), `${k}: person icon on the occupancy row`);
    assert.ok(!why.includes(bed), `${k}: no bed icon`);
    const occRow = why.match(/<div class="item">(?:(?!<div class="item">)[\s\S])*?<div class="h">(Occupied|Empty)<\/div>/)[0];
    assert.ok(occRow.includes(person));
  }
  const rows = P.render('why', { room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: true } }), []), NOW);
  assert.equal(count(rows, /class="item"/g), 3);
  assert.match(rows, /Occupied<\/div>/);
});

ok('feed never shows no-ops (stored too) and rewrites jargon to plain words', () => {
  const e = (decision, reason, sentence, extra = {}) => ({ loc: 'bathroom', sub: 'heating', ts: '2026-10-25T18:0' + (extra.i || 1) + ':00+00:00', decision, reason, sentence, auto: 'bathroom:heating', ...extra });
  const entries = [
    e('maintain', 'no_change', 'Bathroom heating maintain · no change', { i: 9 }),
    e('no_action', 'x', 'Bathroom heating no action', { i: 8 }),
    e('turn_on', 'no_change', 'Bathroom lights turned on · no change', { i: 7 }),
    e('set_mode', 'safety_window_open', 'Bedroom heating set mode · safety window open', { loc: 'bedroom', i: 6 }),
    e('set_mode', 'schedule', 'Kitchen heating set mode · schedule', { loc: 'kitchen', i: 5 }),
    e('turn_off', 'occupancy_off', 'Hallway down lights turned off · room emptied', { sub: 'lighting', loc: 'hallway_downstairs', i: 4 }),
  ];
  const hass = mk({ 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify(entries), by_room: JSON.stringify(entries) } } });
  const feed = P.render('feed', {}, hass, NOW);
  assert.doesNotMatch(feed, /maintain|no change|no action|no_change|set mode|safety/i);
  assert.match(feed, /Bedroom heating mode changed · window open/);
  assert.match(feed, /Kitchen heating mode changed · schedule/);
  assert.match(feed, /Hallway down lights turned off · room emptied/, 'ordinary sentences are untouched');
  assert.equal(count(feed, /class="feed"/g), 3);
  assert.doesNotMatch(P.render('room-feed', { room: 'bathroom' }, hass, NOW), /maintain|no change/i);
  assert.equal(P.entrySentence({ decision: 'turn_on', sentence: 'Kitchen lights turned on', loc: 'kitchen' }), 'Kitchen lights turned on');
  assert.equal(P.entrySentence({ decision: 'set_mode', loc: 'home_office', sub: 'heating', reason: 'house_mode_away' }), 'Home office heating mode changed · house away');
  assert.equal(P.entrySentence({ decision: 'set_mode', loc: 'x', sub: 'heating', reason: 'brand_new_reason' }), 'X heating mode changed · brand new reason');
  assert.equal(P.entrySentence({ decision: 'set_mode', sentence: 'kept' }), 'kept', 'no location: keep the stored sentence');
  assert.equal(P.entrySentence({}), '');
});

ok('media players are labelled by device role from the room config, not the entity name', () => {
  const html = P.render('media', { room: 'parlour' }, mk({ 'media_player.parlour': { state: 'playing', attributes: { friendly_name: 'Parlour', volume_level: 0.3 } }, 'media_player.parlour_tv': { state: 'off', attributes: { friendly_name: 'Bravia KD-55' } } }), NOW);
  assert.match(html, /<div class="h">Soundbar<\/div>/);
  assert.match(html, /<div class="h">TV<\/div>/);
  assert.doesNotMatch(html, /<div class="h">Parlour<\/div>|Bravia/);
  assert.match(P.render('media', { room: 'kitchen' }, mk({ 'media_player.kitchen': { state: 'idle', attributes: { friendly_name: 'Kitchen' } } }), NOW), /Kitchen speaker/);
});

ok('held-occupied wording has no redundancy', () => {
  const m = quietRoom('parlour', { occupied: true, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], verdict: 'Occupied · lights on · held occupied by Sofa occupied' });
  const hass = withRooms([m], []);
  const why = P.render('why', { room: 'parlour' }, hass, NOW);
  assert.match(why, /Held occupied · Sofa occupied\./);
  assert.doesNotMatch(why, /Held by|occupied by Sofa occupied/);
  const head = P.render('room-head', { room: 'parlour' }, hass, NOW);
  assert.match(head, /held occupied · Sofa occupied/);
  assert.doesNotMatch(head, /held occupied by/);
  const att = P.render('rooms', {}, withRooms([m], [attn('Parlour', 'parlour', 'automation_disabled', 'Lights automation off')]), NOW);
  assert.match(att, /<b>Held occupied<\/b><span>Sofa occupied<\/span>/);
  assert.equal(P.tidyVerdict('a · held occupied by X'), 'a · held occupied · X');
});

ok('rooms without a climate sensor show no temperature at all; rooms with one but no reading keep a muted dash', () => {
  const quiet = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { temp: null, humidity: null }, kitchen: { temp: null } }), []), NOW);
  const tile = (html, name) => html.match(new RegExp(`<a class="rt tap[^"]*"[^>]*>(?:(?!<a class="rt tap[" ]).)*?${name}[\\s\\S]*?</a>`))[0];
  const up = tile(quiet, 'Hallway up');
  assert.doesNotMatch(up, /–/);
  assert.match(up, />no climate</);
  assert.match(tile(quiet, 'Kitchen'), /color:#8f9aa8">–</);
  const occ = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { occupied: true, temp: null } }), []), NOW);
  const occCard = occ.match(/<a class="card oc tap"[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(occCard, /–/);
  assert.match(occCard, />no climate</);
  const att = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { temp: null } }), [attn('Hallway upstairs', 'hallway_upstairs', 'automation_disabled', 'Lights automation off')]), NOW);
  assert.match(att.match(/<div class="card warn pad">[\s\S]*?details ›/)[0], />no climate</);
});

// ── Now v3 ─────────────────────────────────────────────────────────────────────────────────────
const NOW_MODES = ['now-header', 'status', 'rooms', 'bins-heating', 'feed', 'footer'];
const nowPage = (hass) => NOW_MODES.map((m) => P.render(m, {}, hass, NOW)).join('\n');

ok('Now v3 header is the title and mode pill only; no "Updated" text anywhere on Now; Mobile link stays at the bottom', () => {
  const hdr = P.render('now-header', {}, mk(), NOW);
  assert.match(hdr, />Pulse</);
  assert.match(hdr, /● Normal/);
  assert.doesNotMatch(hdr, /<a |data-path|sliders/, 'no link or icon in the title row');
  for (const hass of [mk(), withRooms(calmRooms(), []), withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), [attn('Bedroom', 'bedroom', 'automation_disabled', 't')]), { states: {} }]) assert.doesNotMatch(nowPage(hass), /Updated/);
  assert.equal(P.render('footer', {}, mk(), NOW), '', 'the Controls tab carries the Mobile link now');
  assert.equal(count(nowPage(mk()), /data-path="\/mobile-dashboard"/g), 0);
  assert.match(P.render('tabbar', { active: 'now' }, mk(), NOW, {}), /data-path="\/mobile-dashboard"[^>]*>[\s\S]*Controls/);
  const view = yaml.load(readFileSync(root + 'views/info-now.yaml', 'utf8'));
  assert.deepEqual(view.sections[0].cards.map((c) => c.mode), ['now-header', 'status', 'rooms', 'bins-heating', 'feed', 'footer', 'tabbar']);
});

ok('Now v3 status card: verdict row with the sentence right-aligned, ONE chip row (nowrap, 30px), price strip link, cheapest line', () => {
  const hass = withRooms(calmRooms({ parlour: { occupied: true }, kitchen: { occupied: true }, bedroom: { occupied: true }, bathroom: { occupied: true } }), []);
  const st = P.render('status', {}, hass, NOW);
  assert.match(st, /<div style="font-size:15px;font-weight:700">All good<\/div><div style="flex:1"><\/div><div style="font-size:12px;color:#a3adba;text-align:right">4 rooms occupied · heating idle<\/div>/);
  const chips = st.match(/<div class="chips">[\s\S]*?<\/a><\/div>/)[0];
  assert.equal(count(chips, /class="chip[" ]/g), 3, 'Adam, Sarah, Mo in one row');
  assert.doesNotMatch(chips, /flex-wrap:wrap/);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.chips\{[^\n]*display:flex[^\n]*flex-wrap:nowrap/);
  assert.match(css, /\.chip\{[^\n]*min-height:30px[^\n]*white-space:nowrap/);
  assert.match(css, /\.chip\{[^\n]*font-size:12px/);
  assert.match(chips, /Adam · WFH/);
  assert.match(chips, />Mo</);
  // the long variants are shortened rather than wrapped
  const worst = P.render('status', {}, mk({ 'person.adam': { state: 'not_home', attributes: {} }, 'input_boolean.wfh_adam': { state: 'on', attributes: {} }, 'sensor.mo_timeline': { state: 'x', attributes: { eating: [{ ts: Date.parse('2026-10-24T18:05:00Z') }] } } }), NOW);
  const wc = worst.match(/<div class="chips">[\s\S]*?<\/a><\/div>/)[0];
  assert.match(wc, /Adam · Away/);
  assert.match(wc, /Mo · ate yest 18:05/);
  assert.doesNotMatch(wc, /yesterday|Away · WFH/);
  assert.ok(wc.replace(/<[^>]+>/g, '').length < 60, 'chip text fits one 390px row');
  // price strip: one 56px+ link, chevron, aria-label, graded colours; cheapest line under it
  const strip = st.match(/<a class="tap pstrip"[\s\S]*?<\/a>/)[0];
  assert.match(strip, /data-path="\/pulse-dashboard\/energy" aria-label="Open energy details"/);
  assert.ok(strip.includes(`color:${P.priceColour(34.8, { text: true })}`));
  assert.ok(strip.includes(`color:${P.priceColour(41.2, { text: true })}`));
  assert.match(strip, /M9 5l7 7-7 7/);
  assert.match(st, /<\/a><div style="font-size:12px;color:#a3adba;margin-top:2px">Cheapest 2h · <b[^>]*>Tomorrow 20:00 → 22:00<\/b><\/div>/);
  assert.ok(st.indexOf('class="chips"') > st.indexOf('All good') && st.indexOf('pstrip') > st.indexOf('class="chips"'), 'verdict, chips, strip in that order');
});

ok('Now v3 calm / 4 occupied / attention: partition rules and the amber state', () => {
  const calm = nowPage(withRooms(calmRooms(), []));
  assert.doesNotMatch(calm, /Needs attention|Occupied now|card pad warn/);
  assert.match(calm, />Rooms</);
  assert.equal(count(calm, /class="rt tap[" ]/g), 8);
  const four = withRooms(calmRooms({ parlour: { occupied: true, lights_on: 2 }, kitchen: { occupied: true }, bathroom: { occupied: true, temp: 19.8 }, hallway_upstairs: { occupied: true, temp: null } }), []);
  const rooms = P.render('rooms', {}, four, NOW);
  assert.equal(count(rooms, /class="card oc tap"/g), 4);
  assert.equal(count(rooms, /class="rt tap[" ]/g), 4);
  assert.match(rooms, />Occupied now</);
  assert.match(rooms, />Other rooms</);
  assert.match(P.render('status', {}, four, NOW), /4 rooms occupied · heating idle/);
  const att = withRooms(calmRooms({ bathroom: { occupied: true, temp: 23.1, humidity: 88, lights_on: 1 }, bedroom: { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'] } }), [attn('Bathroom', 'bathroom', 'warm_heating', '23.1° vs 18° target, heating on'), attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window while heating is on')]);
  const status = P.render('status', {}, att, NOW);
  assert.match(status, /card pad warn/);
  assert.match(status, /2 need attention<\/span><div style="flex:1"><\/div><div style="font-size:12px;color:#a3adba;text-align:right">2 rooms occupied · heating idle/);
  assert.match(status, /Bathroom<\/b> · Steamy/);
  assert.match(status, /class="chips"/);
  assert.match(status, /pstrip/);
  const r = P.render('rooms', {}, att, NOW);
  assert.equal(count(r, />Needs attention</g), 1);
  assert.doesNotMatch(r, />Occupied now</);
  assert.equal(count(r, /class="rt tap[" ]/g), 6);
  const heating = withRooms(calmRooms({ kitchen: { hvac_action: 'heating' }, parlour: { hvac_action: 'heating' } }), []);
  assert.match(P.render('status', {}, heating, NOW), /heating in 2 rooms/);
});

ok('attention labels: temperature kinds say which way and whether heating is on; Steamy only for warm with shower evidence', () => {
  const cold = withRooms(calmRooms({ bedroom: { occupied: true, temp: 17.2, target: 19 } }), [attn('Bedroom', 'bedroom', 'cold_not_heating', '17.2° vs 19° target, heating not on')]);
  const status = P.render('status', {}, cold, NOW);
  assert.match(status, /Bedroom<\/b> · Too cold, heating off/);
  assert.doesNotMatch(status, /Steamy/);
  assert.match(P.render('rooms', {}, cold, NOW), /17\.2° vs 19° target, heating not on/);
  const warm = withRooms(calmRooms({ bedroom: { occupied: true, temp: 21.4, target: 19, humidity: 50 } }), [attn('Bedroom', 'bedroom', 'warm_heating', '21.4° vs 19° target, heating on')]);
  const ws = P.render('status', {}, warm, NOW);
  assert.match(ws, /Bedroom<\/b> · Too warm, heating on/);
  assert.doesNotMatch(ws, /Steamy|probably a shower/);
  const steamy = withRooms(calmRooms({ bathroom: { occupied: true, temp: 23.1, target: 18, humidity: 88, lights_on: 1 } }), [attn('Bathroom', 'bathroom', 'warm_heating', '23.1° vs 18° target, heating on')]);
  assert.match(P.render('status', {}, steamy, NOW), /Bathroom<\/b> · Steamy/);
  assert.match(P.render('rooms', {}, steamy, NOW), /23\.1° vs 18° target, heating on · 88% humidity, probably a shower/);
  // A cold room is never steamy, even with high humidity.
  const wet = withRooms(calmRooms({ bathroom: { occupied: true, temp: 15, target: 18, humidity: 90, lights_on: 1 } }), [attn('Bathroom', 'bathroom', 'cold_not_heating', '15° vs 18° target, heating not on')]);
  assert.match(P.render('status', {}, wet, NOW), /Bathroom<\/b> · Too cold, heating off/);
});

ok('Now v3 occupied card is two lines: icon + name + temperature, then badges (amber manual badge, holds, phrase)', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T15:42:00+00:00', what: 'x' };
  const feed = { 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify([{ loc: 'parlour', sub: 'lighting', decision: 'turn_on', ts: new Date(NOW - 60000).toISOString(), sentence: 'x', auto: 'p:l' }]), by_room: '[]' } } };
  const hass = withRooms(calmRooms({ parlour: { occupied: true, lights_on: 2, temp: 20.3, manual, heat_labels: ['Window open'], pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'] }, hallway_upstairs: { occupied: true, temp: null } }), [], { ...feed, 'sensor.parlour_active_scene': { state: 'parlour_lamps', attributes: {} } });
  const html = P.render('rooms', {}, hass, NOW);
  const card = html.match(/<a class="card oc tap"[\s\S]*?<\/a>/)[0];
  assert.match(card, /^<a class="card oc tap"[^>]*><svg class="occ"[^>]*width="20" height="20"[^>]*fill="currentColor"/);
  assert.match(card, /<div class="nm">Parlour<\/div><div class="t"><div style="font-size:20px;font-weight:700[^>]*>20\.3°<\/div><\/div><div class="sub">/);
  assert.match(card, /Lamps<\/span>/);
  assert.match(card, /style="color:#f2b84b;background:#2b2415"[^>]*>[\s\S]*Wall button · 3 h ago/);
  assert.match(card, /Window<\/span>/);
  assert.match(card, /Sofa occupied/);
  assert.match(card, /<span>on 1 min ago<\/span>/);
  const up = html.match(/<a class="card oc tap"[^>]*room-hallway_upstairs[\s\S]*?<\/a>/)[0];
  assert.match(up, /<div class="t"><div style="font-size:12px;font-weight:500;color:#8f9aa8">no climate<\/div><\/div>/);
  assert.doesNotMatch(up, /–/);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.oc\{[^\n]*grid-template-columns:20px 1fr auto/);
  assert.match(css, /\.oc \.sub\{grid-column:2 \/ 4/);
});

ok('Now v3 tiles: fixed height, name / temperature / status-line grid, identical structure with or without badges, nothing wraps', () => {
  const plain = P.render('rooms', {}, withRooms(calmRooms(), []), NOW);
  const busy = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { heat_labels: ['Window open'], labels: ['Window open'], manual: { source: 'dashboard', ts: new Date(NOW - 600000).toISOString(), what: 'x' } }, kitchen: { lights_on: 3 } }), []), NOW);
  const tiles = (h) => [...h.matchAll(/<a class="rt tap[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[0]);
  const shape = (t) => t.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').match(/<(?:a|div)[^>]*>/g).map((x) => x.replace(/data-path="[^"]*"/, '').replace(/style="[^"]*"/, 'style').trim());
  const a = tiles(plain);
  const b = tiles(busy);
  assert.equal(a.length, 8);
  assert.equal(b.length, 8);
  for (const t of [...a, ...b]) {
    assert.match(t, /^<a class="rt tap[^"]*"[^>]*><div class="nm">[\s\S]*?<\/div><div class="t">[\s\S]*?<\/div><div class="b">[\s\S]*<\/div><\/a>$/);
    assert.equal((t.match(/class="rt/g) || []).length, 1);
    assert.doesNotMatch(t, /(^|[;"\s])(min-)?height:|flex-wrap:wrap/, 'height comes from CSS only, never from content or inline style');
  }
  const bedroom = b.find((t) => t.includes('Bedroom'));
  assert.match(bedroom, /Window<\/span>/);
  assert.doesNotMatch(bedroom, /Dashboard/, 'a hold wins over the manual badge so the status line stays one line');
  assert.deepEqual(shape(b[4]).slice(0, 3), shape(a[4]).slice(0, 3));
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(P.STYLE, /\.rt\{[^\n]*grid-template-rows:auto 1fr auto[^\n]*height:104px/);
  assert.doesNotMatch(P.STYLE.match(/\.rt\{[^\n]*/)[0], /overflow:hidden/, 'the tile itself never clips');
  assert.match(P.STYLE, /\.rt \.b\{[^\n]*flex-wrap:nowrap[^\n]*white-space:nowrap/);
  assert.doesNotMatch(P.STYLE.match(/\.rt \.b\{[^\n]*/)[0], /overflow:hidden/, 'the status line row does not clip; only text ellipsises');
  assert.match(P.STYLE, /\.rt \.t\{align-self:center;text-align:left;/);
  assert.doesNotMatch(plain + busy, /%|humidity/);
  const kitchen = a.find((t) => t.includes('Kitchen'));
  assert.match(kitchen, /Off<\/span>/);
});

ok('Now v3 sparse and missing data: every Now mode renders cleanly', () => {
  for (const hass of [{ states: {} }, mk(), withRooms(P.ROOM_ORDER.map((k) => ({ k })), [{}]), withRooms('junk', 'junk'), withRooms(P.ROOM_ORDER.map((k) => ({ k, temp: null, manual: 'x', labels: 7 })), [])]) {
    const page = nowPage(hass);
    assert.doesNotMatch(page, NOISE);
    assert.doesNotMatch(page, /Updated/);
  }
});

// ── Tab bar ────────────────────────────────────────────────────────────────────────────────────
const SNAP = (over = {}) => ({ name: 'div', transform: 'none', filter: 'none', perspective: 'none', contain: 'none', willChange: 'auto', backdropFilter: 'none', ...over });

ok('tab bar renders three tabs for active=now and active=energy with aria-current on the active one only', () => {
  for (const [active, label] of [['now', 'Now'], ['energy', 'Energy']]) {
    const html = P.render('tabbar', { active }, mk(), NOW, {});
    assert.match(html, /<nav class="tabs" aria-label="Pulse">/);
    assert.equal(count(html, /<button type="button" class="tab"/g), 3);
    assert.equal(count(html, /aria-current="page"/g), 1);
    assert.match(html, new RegExp(`aria-current="page">[\\s\\S]*?<span>${label}</span>`));
    for (const t of ['Now', 'Energy', 'Controls']) assert.match(html, new RegExp(`<span>${t}</span>`));
    assert.equal(count(html, /<svg /g), 3, 'inline SVG icons');
    noNoise({ html }, 'tabbar');
  }
  assert.match(P.render('tabbar', { active: 'bogus' }, mk(), NOW, {}), /aria-current="page">[\s\S]*?<span>Now<\/span>/, 'unknown active falls back to Now');
  for (const cfg of [undefined, null, {}, { active: 5 }]) assert.doesNotMatch(P.render('tabbar', cfg, mk(), NOW, undefined), NOISE);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.tab\{[^\n]*font-size:10\.5px[^\n]*min-height:44px/);
  assert.match(css, /\.tab\[aria-current=page\]\{color:\$\{TOKENS\.sceneActive\}\}/);
  assert.match(css, /\.tabs\{[^\n]*rgba\(18,21,26,\.94\)[^\n]*border-top:1px solid \$\{TOKENS\.divider\}/);
  assert.equal(P.TOKENS.sceneActive, '#f2c46b');
  assert.equal(P.TOKENS.text3, '#8f9aa8');
});

ok('tab bar nav paths use the DASH / MOBILE constants and match real views', () => {
  const html = P.render('tabbar', { active: 'now' }, mk(), NOW, {});
  const paths = [...html.matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['/pulse-dashboard/now', '/pulse-dashboard/energy', '/mobile-dashboard']);
  const viewPaths = readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path);
  for (const p of paths) if (p.startsWith(P.DASH)) assert.ok(viewPaths.includes(p.slice(P.DASH.length + 1)), p); else assert.equal(p, P.MOBILE);
  assert.ok(P.TABS.every((t) => t.path.startsWith(P.DASH) || t.path === P.MOBILE));
});

ok('placement: fixed in-flow decision from ancestor snapshots, naming the offender', () => {
  assert.deepEqual(P.tabbarPlacement([SNAP({ name: 'hui-card' }), SNAP({ name: 'body' })]), { mode: 'fixed', offender: null });
  assert.deepEqual(P.tabbarPlacement([]), { mode: 'fixed', offender: null });
  assert.deepEqual(P.tabbarPlacement(undefined), { mode: 'fixed', offender: null });
  const cases = [
    [{ transform: 'matrix(1, 0, 0, 1, 0, 0)' }, 'transform'],
    [{ filter: 'blur(2px)' }, 'filter'],
    [{ backdropFilter: 'blur(4px)' }, 'backdrop-filter'],
    [{ perspective: '100px' }, 'perspective'],
    [{ contain: 'layout' }, 'contain'],
    [{ contain: 'strict' }, 'contain'],
    [{ contain: 'content' }, 'contain'],
    [{ contain: 'paint' }, 'contain'],
    [{ willChange: 'transform' }, 'will-change'],
    [{ willChange: 'opacity, filter' }, 'will-change'],
  ];
  for (const [over, why] of cases) {
    const r = P.tabbarPlacement([SNAP({ name: 'a' }), SNAP({ name: 'hui-view#main', ...over }), SNAP({ name: 'body' })]);
    assert.deepEqual(r, { mode: 'inflow', offender: `hui-view#main (${why})` }, JSON.stringify(over));
  }
  // harmless values do not trip it
  for (const over of [{ contain: 'size' }, { contain: 'style' }, { willChange: 'opacity' }, { willChange: 'scroll-position' }, { transform: '' }, { filter: undefined }]) assert.equal(P.tabbarPlacement([SNAP(over)]).mode, 'fixed', JSON.stringify(over));
  // the first offender is reported, garbage entries are skipped
  assert.equal(P.tabbarPlacement([null, 5, SNAP({ name: 'x', filter: 'blur(1px)' }), SNAP({ name: 'y', transform: 'scale(1)' })]).offender, 'x (filter)');
});

ok('tab bar markup: in-flow by default (fail safe), fixed + spacer of the same height only when the probe says fixed', () => {
  const inflow = P.render('tabbar', { active: 'now' }, mk(), NOW, {});
  const inflow2 = P.render('tabbar', { active: 'now' }, mk(), NOW, { tb: 'inflow' });
  assert.equal(inflow, inflow2);
  assert.doesNotMatch(inflow, /tabbar-spacer|class="tabs fixed"/);
  const fixed = P.render('tabbar', { active: 'now' }, mk(), NOW, { tb: 'fixed' });
  assert.match(fixed, /<div class="tabbar-spacer" style="--tbh:calc\(58px \+ max\(10px, env\(safe-area-inset-bottom, 0px\)\)\)" aria-hidden="true"><\/div>/);
  assert.match(fixed, /<nav class="tabs fixed" aria-label="Pulse">/);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const barH = src.match(/\.tabs\{--tbh:(calc\([^;]*\));/)[1];
  const spacerH = fixed.match(/--tbh:(calc\(.*?\))" aria-hidden/)[1];
  assert.equal(spacerH, barH, 'spacer height equals bar height');
  assert.match(src, /\.tabs\{[^\n]*height:var\(--tbh\)/);
  assert.match(src, /\.tabbar-spacer\{height:var\(--tbh\)\}/);
  assert.match(src, /\.tabs\.fixed\{position:fixed;left:0;right:0;bottom:0;z-index:100\}/);
  assert.match(src, /padding:8px 16px max\(10px, env\(safe-area-inset-bottom, 0px\)\)/);
});

ok('TABBAR_ENABLED=false renders nothing and brings the Now footer link back (one-line switch)', () => {
  assert.equal(P.TABBAR_ENABLED, true);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(src, /^  const TABBAR_ENABLED = true;$/m, 'a single line to flip');
  const off = src.replace(/^  const TABBAR_ENABLED = true;$/m, '  const TABBAR_ENABLED = false;');
  const tmp = new URL('./pulse-card.tabbar-off.tmp.cjs', import.meta.url).pathname;
  writeFileSync(tmp, off);
  try {
    const Off = require(tmp);
    assert.equal(Off.TABBAR_ENABLED, false);
    assert.equal(Off.render('tabbar', { active: 'now' }, mk(), NOW, { tb: 'fixed' }), '');
    assert.match(Off.render('footer', {}, mk(), NOW), /Open Mobile controls ›/);
  } finally { unlinkSync(tmp); }
});

ok('every non-classic Pulse view has exactly one tabbar card, last in its section; Classic has none', () => {
  const files = readdirSync(root + 'views').filter((x) => x.startsWith('info-'));
  assert.ok(files.length >= 13);
  const modes = (node, out = []) => { if (Array.isArray(node)) node.forEach((x) => modes(x, out)); else if (node && typeof node === 'object') { if (node.mode === 'tabbar') out.push(node); Object.values(node).forEach((x) => modes(x, out)); } return out; };
  for (const f of files) {
    const v = yaml.load(readFileSync(root + 'views/' + f, 'utf8'));
    const bars = modes(v);
    if (f.startsWith('info-classic')) { assert.equal(bars.length, 0, f); continue; }
    assert.equal(bars.length, 1, f);
    const cards = v.sections[0].cards;
    assert.equal(cards[cards.length - 1].mode, 'tabbar', `${f}: last card`);
    assert.equal(bars[0].active, f === 'info-energy.yaml' ? 'energy' : 'now', f);
    assert.equal(bars[0].type, 'custom:pulse-card');
  }
  assert.equal(files.filter((f) => !f.startsWith('info-classic')).length, 12); // now, energy, 10 rooms
});

ok('tab bar adds no write path and the module URL is untouched', () => {
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['input_boolean', 'light', 'media_player', 'scene', 'switch']);
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card\.js\?v=2\b/);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('function sectionTabbar'), src.indexOf('function sectionTabbar') + 900), /callService|callWS/);
});

await okAsync('tab bar probe wiring (stubbed DOM): clean ancestors -> fixed with spacer; offending ancestor -> stays in-flow and warns once', async () => {
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle, warn: console.warn };
  let Card;
  const roots = [];
  globalThis.HTMLElement = class { constructor() { this.style = {}; this.nodeType = 1; this.tagName = 'PULSE-CARD'; } attachShadow() { const r = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, innerHTML: '' }; roots.push(r); return r; } };
  globalThis.customElements = { get() { return undefined; }, define(n, c) { if (n === 'pulse-card') Card = c; } };
  globalThis.window = { customCards: [] };
  globalThis.getComputedStyle = (n) => n.__cs || {};
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const modPath = new URL('../www/pulse-card.js', import.meta.url).pathname;
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    const chain = (cs) => { const body = { nodeType: 1, tagName: 'BODY', id: '', parentNode: null, __cs: {} }; const view = { nodeType: 1, tagName: 'HUI-VIEW', id: 'main', parentNode: body, __cs: cs }; return { body, view }; };
    const mk2 = (cs) => { const c = new Card(); const { view } = chain(cs); c.parentNode = view; Object.defineProperty(c, 'isConnected', { value: true }); c.setConfig({ mode: 'tabbar', active: 'now' }); c.hass = { states: {} }; return c; };
    const flush = () => new Promise((r) => setTimeout(r, 20));
    const ok1 = mk2({ transform: 'none', filter: 'none', contain: 'none', willChange: 'auto' });
    assert.equal(ok1._ui.tb, 'inflow', 'in-flow until the probe has run (fail safe)');
    assert.doesNotMatch(roots[roots.length - 1].innerHTML, /<nav class="tabs fixed"/);
    await flush();
    assert.equal(ok1._ui.tb, 'fixed');
    assert.match(roots[roots.length - 1].innerHTML, /<div class="tabbar-spacer"/);
    assert.match(roots[roots.length - 1].innerHTML, /nav class="tabs fixed"/);
    assert.equal(warns.length, 0);
    const bad = mk2({ transform: 'matrix(1, 0, 0, 1, 0, 0)' });
    await flush();
    assert.equal(bad._ui.tb, 'inflow');
    assert.doesNotMatch(roots[roots.length - 1].innerHTML, /<nav class="tabs fixed"|<div class="tabbar-spacer"/);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /hui-view#main \(transform\)/);
    await new Promise((r) => setTimeout(r, 900)); // the second probe must not warn again
    assert.equal(warns.length, 1, 'warns once');
    bad.disconnectedCallback(); ok1.disconnectedCallback();
    // other modes never probe
    const other = new Card(); Object.defineProperty(other, 'isConnected', { value: true }); other.setConfig({ mode: 'rooms' }); other.hass = { states: {} };
    await flush();
    assert.equal(other._tbProbed, undefined);
  } finally {
    Object.assign(globalThis, { HTMLElement: saved.HTMLElement, customElements: saved.customElements, window: saved.window, getComputedStyle: saved.getComputedStyle });
    for (const k of ['HTMLElement', 'customElements', 'window', 'getComputedStyle']) if (saved[k] === undefined) delete globalThis[k];
    console.warn = saved.warn;
    delete require.cache[require.resolve(new URL('../www/pulse-card.js', import.meta.url).pathname)];
    require(new URL('../www/pulse-card.js', import.meta.url).pathname);
  }
});

// ── Tile geometry (no clipping, left-aligned temperature, odd count) ────────────────────────────
const cssRules = () => [...P.STYLE.matchAll(/^([^{\n]+)\{([^\n]*)\}$/gm)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const decl = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)${prop}:([^;]+)`)); return m ? m[1].trim() : null; };
const px = (v) => (v && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);
const rule = (sel) => cssRules().find((r) => r.sel === sel);

ok('tile height is at least what its rows need (arithmetic from the CSS itself, not the constants)', () => {
  const rt = rule('.rt').body;
  const pad = decl(rt, 'padding').split(/\s+/).map(px);
  const gap = px(decl(rt, 'row-gap'));
  const name = px(decl(rule('.rt .nm').body, 'line-height'));
  const temp = px(decl(rule('.rt .t').body, 'line-height'));
  const status = Math.max(px(decl(rule('.rt .b').body, 'line-height')), px(decl(rule('.rt .b').body, 'min-height')));
  const needed = pad[0] * 2 + name + temp + status + 2 * gap;
  const height = px(decl(rt, 'height'));
  assert.equal(needed, 102);
  assert.ok(height >= needed, `tile ${height}px must hold ${needed}px of content`);
  assert.equal(height, P.TILE_H);
  assert.equal(P.tileNeededHeight(false), needed);
  // the temperature text itself is styled with the same line-height the arithmetic used
  assert.match(P.render('rooms', {}, withRooms(calmRooms(), []), NOW), new RegExp(`font-size:20px;font-weight:700;letter-spacing:-\\.3px;line-height:${temp}px`));
  // wide tile: padding + the taller of name/temperature + gap + status line
  const wide = rule('.rt.wide').body;
  const wneeded = pad[0] * 2 + Math.max(name, temp) + gap + status;
  assert.equal(wneeded, 76);
  assert.ok(px(decl(wide, 'height')) >= wneeded);
  assert.equal(px(decl(wide, 'height')), P.TILE_WIDE_H);
  assert.ok(P.TILE_H >= P.tileNeededHeight(false) && P.TILE_WIDE_H >= P.tileNeededHeight(true));
  // the status line contents fit their line: 14px icon, 14px-line badges, 20px line
  assert.ok(14 <= status);
  assert.ok(px(decl(rule('.rt .b .badge').body, 'line-height')) + 2 * 3 <= status, 'badge (14px line + 3px padding) fits the 20px status line');
});

ok('tile never clips: no overflow hidden on the tile or its status row; only text ellipsises, icons and badge boxes keep their size', () => {
  assert.doesNotMatch(rule('.rt').body, /overflow/);
  assert.doesNotMatch(rule('.rt .b').body, /overflow/);
  assert.match(rule('.rt .b>*').body, /flex:none/);
  assert.match(rule('.rt .b>span:not(.badge)').body, /overflow:hidden;text-overflow:ellipsis/);
  assert.match(rule('.rt .nm span').body, /overflow:hidden;text-overflow:ellipsis/);
  const html = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { heat_labels: ['Window open'], labels: ['Window open'] } }), []), NOW);
  const bedroom = html.match(/<a class="rt tap[^"]*"[^>]*room-bedroom"[\s\S]*?<\/a>/)[0];
  assert.match(bedroom, /<svg[^>]*width="14" height="14"[\s\S]*?<span>Off<\/span><span class="badge"[^>]*>[\s\S]*Window<\/span>/);
  const manual = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { manual: { source: 'wall_button', ts: new Date(NOW - 3 * 3600000).toISOString(), what: 'x' } } }), []), NOW);
  const k = manual.match(/<a class="rt tap[^"]*"[^>]*room-kitchen"[\s\S]*?<\/a>/)[0];
  assert.match(k, /Wall button<\/span>/);
  assert.doesNotMatch(k, /Wall button · /, 'the tile badge drops its age so the status line stays short');
});

ok('every fixed height or clipping rule is accounted for (a new one needs its arithmetic)', () => {
  const fixed = cssRules().filter((r) => px(decl(r.body, 'height'))).map((r) => r.sel).sort();
  // content boxes with a fixed height (need the arithmetic above): .rt and .rt.wide only. The rest are fixed SHAPES
  // (dots, icons, switch track and knob, slider track and thumb, the 1px visually-hidden helper) that hold no text.
  const shapes = ['.dot', '.item svg,.ic', '.sw', '.sw::after', '.sr', '.lt input[type=range]', '.lt input[type=range]::-webkit-slider-runnable-track', '.lt input[type=range]::-webkit-slider-thumb', '.lt input[type=range]::-moz-range-track', '.lt input[type=range]::-moz-range-progress', '.lt input[type=range]::-moz-range-thumb'];
  assert.deepEqual(fixed, [...shapes, '.rt', '.rt.wide'].sort());
  // .sw: a 28px track holds a 22px knob with 3px above and below
  const sw = px(decl(rule('.sw').body, 'height'));
  const knob = P.STYLE.match(/\.sw::after\{[^\n]*top:(\d+)px[^\n]*height:(\d+)px/);
  assert.ok(sw >= +knob[1] * 2 + +knob[2]);
  // range input: 44px row holds the 24px thumb
  assert.ok(px(decl(rule('.lt input[type=range]').body, 'height')) >= 24);
  const clip = cssRules().filter((r) => /overflow:hidden/.test(r.body)).map((r) => r.sel).sort();
  assert.deepEqual(clip, ['.card', '.chip', '.rt .b .badge', '.rt .b>span:not(.badge)', '.rt .nm span', '.sr'].sort());
  // none of the clipping rules also fixes a height except the visually-hidden helper
  for (const r of cssRules().filter((x) => /overflow:hidden/.test(x.body) && x.sel !== '.sr')) assert.equal(px(decl(r.body, 'height')), null, r.sel);
  // flexible regions use min-height only
  for (const sel of ['.oc', '.pstrip', '.chip', '.row', '.tog', '.link', '.seg', '.wrow', '.lh']) assert.ok(px(decl(rule(sel).body, 'min-height')) > 0 && px(decl(rule(sel).body, 'height')) === null, sel);
  assert.equal(px(decl(rule('.chip').body, 'min-height')), 30);
});

ok('tile temperature is left-aligned with the name; no climate is left-aligned muted text in the same slot', () => {
  assert.match(rule('.rt .t').body, /text-align:left/);
  assert.match(rule('.rt .t').body, /align-self:center/);
  assert.doesNotMatch(rule('.rt .t').body, /text-align:right/);
  assert.match(rule('.rt.wide .t').body, /text-align:right/);
  const html = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { temp: null } }), []), NOW);
  const up = html.match(/<a class="rt tap[^"]*"[^>]*room-hallway_upstairs"[\s\S]*?<\/a>/)[0];
  assert.match(up, /<div class="t"><div style="font-size:12px;font-weight:500;color:#8f9aa8">no climate<\/div><\/div>/);
  assert.doesNotMatch(up, /text-align:right/);
});

ok('odd tile counts: the last tile spans both columns as a wide row; even counts are unchanged (1, 2, 7, 8)', () => {
  const others = (n) => { const occ = Object.fromEntries(P.ROOM_ORDER.slice(0, 8 - n).map((k) => [k, { occupied: true }])); return P.render('rooms', {}, withRooms(calmRooms(occ), []), NOW); };
  for (const [n, wide] of [[1, 1], [2, 0], [7, 1], [8, 0]]) {
    const html = others(n);
    assert.equal(count(html, /<a class="rt tap[" ]/g), n, `${n} tiles`);
    assert.equal(count(html, /class="rt tap wide"/g), wide, `${n}: wide tiles`);
    if (wide) {
      const tiles = [...html.matchAll(/<a class="rt tap[^"]*"[^>]*>/g)].map((m) => m[0]);
      assert.match(tiles[tiles.length - 1], /rt tap wide/, 'the LAST tile is the wide one');
      assert.ok(tiles.slice(0, -1).every((t) => !t.includes('wide')));
    }
  }
  const seven = others(7);
  const w = seven.match(/<a class="rt tap wide"[\s\S]*?<\/a>/)[0];
  assert.match(w, /^<a class="rt tap wide"[^>]*><div class="nm">[\s\S]*?<\/div><div class="t">[\s\S]*?<\/div><div class="b">[\s\S]*<\/div><\/a>$/);
  assert.match(w, /Foreign office/);
  assert.match(rule('.rt.wide').body, /grid-column:1 \/ -1/);
  assert.match(rule('.rt.wide .b').body, /grid-column:1 \/ -1/);
  assert.match(rule('.rt.wide .nm').body, /grid-column:1/);
  noNoise({ seven }, 'odd tiles');
});

ok('tab bar fixed height has its arithmetic: bar content area (49px) holds the 44px tab and its icon + label; spacer matches; audit knows the var() heights', () => {
  const bar = rule('.tabs').body;
  const base = Number(decl(bar, '--tbh').match(/calc\((\d+)px \+ max\((\d+)px/)[1]);
  const minInset = Number(decl(bar, '--tbh').match(/max\((\d+)px/)[1]);
  const pad = bar.match(/padding:(\d+)px (\d+)px max\((\d+)px/);
  const top = Number(pad[1]);
  const border = Number((bar.match(/border-top:(\d+)px/) || [])[1]);
  assert.equal(minInset, Number(pad[3]), 'bottom padding uses the same max(...) as the height');
  // height = base + bottomPad; content area = height - top padding - bottom padding - top border (the inset cancels out)
  const content = base - top - border;
  assert.equal(content, 49);
  const tabMin = px(decl(rule('.tab').body, 'min-height'));
  assert.ok(content >= tabMin, `${content}px content area holds a ${tabMin}px tab`);
  const icon = 24;
  const gap = px(decl(rule('.tab').body, 'gap'));
  const label = Math.ceil(10.5 * 1.25); // generous line for a 10.5px label
  assert.ok(icon + gap + label <= tabMin, 'icon + gap + label fit the tab');
  assert.ok(decl(rule('.tabbar-spacer').body, 'height') === 'var(--tbh)' && decl(bar, 'height') === 'var(--tbh)', 'spacer and bar share --tbh');
  // every var()-based height in the stylesheet is one of these two, and each has arithmetic above
  const varHeights = cssRules().filter((r) => /(^|;)height:var\(/.test(r.body)).map((r) => r.sel).sort();
  assert.deepEqual(varHeights, ['.tabbar-spacer', '.tabs']);
  // the tab bar is the only fixed-position element and stays out of the tile/occupied card rules
  assert.deepEqual(cssRules().filter((r) => /position:fixed/.test(r.body)).map((r) => r.sel), ['.tabs.fixed']);
});

console.log(`\n${n} test groups passed`);
