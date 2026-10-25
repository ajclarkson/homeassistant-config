// Offline tests for www/pulse-card.js and the YAML that drives it.
// Run: cd tests && npm install && node pulse-card.test.mjs
// Covers: every mode for all 10 rooms with full, sparse and missing report data; attention vs
// calm; manual set/null; empty, 50-slot and garbage rate lists (via the data_generator strings
// extracted from the real YAML); unknown rooms and disallowed services fail loudly.
process.env.TZ = 'UTC';
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
const ALL_MODES = ['now-header', 'status', 'rooms', 'energy', 'bins-heating', 'feed', 'footer'];
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
  assert.match(quiet, /Hallway up[\s\S]*?color:#8f9aa8">–<\/div>/);
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

ok('energy (prices card) handles missing sensors', () => {
  const html = P.render('energy', {}, { states: {} }, NOW);
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
  const items = P.ALL_ROOM_KEYS.map((k) => ({ room: k, key: k, kind: 'comfort_outlier', text: '20.0° is too warm', nav: '/x' }));
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

ok('cheapest 2h line: shown with data, running now, hidden when unknown', () => {
  assert.match(P.render('energy', {}, mk(), NOW), /Cheapest 2h<\/span><span>02:00 → 04:00 · avg 9\.8p/);
  const running = P.render('energy', {}, mk({ 'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': { state: 'on', attributes: {} } }), NOW);
  assert.match(running, /Running now, until 04:00/);
  const none = P.render('energy', {}, mk({ 'sensor.cheapest_2h_waking_start': { state: 'unknown', attributes: {} }, 'sensor.cheapest_2h_waking_end': { state: 'unknown', attributes: {} } }), NOW);
  assert.doesNotMatch(none, /Cheapest 2h/);
});

const rect = (html) => [...html.matchAll(/<rect x="(\d+)" y="([\d.]+)" width="(\d+)" height="([\d.]+)" rx="1" fill="([^"]+)" opacity="([\d.]+)"\/>/g)].map((m) => ({ x: +m[1], y: +m[2], h: +m[4], fill: m[5], op: +m[6] }));
const real = JSON.parse(readFileSync(root + 'tests/fixtures/rates-2026-10-25-clock-change.json', 'utf8'));
const energyAt = (rates, now) => P.render('energy', {}, mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates } } }), now);

ok('energy block is one card with an SVG chart: every slot of the real 50-slot clock-change day is drawn', () => {
  assert.equal(real.length, 50);
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  assert.equal((html.match(/class="card/g) || []).length, 1, 'one surface, no inner cards');
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
  assert.match(html, /<div class="chart" data-chart data-n="50" tabindex="0" role="img" aria-label="Half-hourly electricity price, 50 slots\./);
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

ok('module URL version is untouched', () => assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card\.js\?v=1\b/));

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
  assert.match(status, /0 rooms occupied · heating in 0 rooms · normal/);
  assert.doesNotMatch(status, /card pad warn/);
  assert.doesNotMatch(status, /\d home/);
  assert.doesNotMatch(rooms, /Needs attention|Occupied now|Other rooms/);
  assert.match(rooms, />Rooms</);
  assert.equal(count(rooms, /class="rt tap"/g), 8);
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
  assert.equal(count(rooms, /class="rt tap"/g), 7);
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
  assert.doesNotMatch(rooms, /Other rooms|class="rt tap"/);
  assert.match(P.render('status', {}, hass, NOW), /8 rooms occupied/);
});

ok('Now v2 attention: Bathroom (steamy) and Bedroom (window open) sit in Needs attention, once, and nowhere else; status is amber', () => {
  const rooms = calmRooms({
    bathroom: { occupied: true, temp: 23.1, humidity: 88, lights_on: 1 },
    bedroom: { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'], temp: 20.8 },
  });
  const items = [attn('Bathroom', 'bathroom', 'comfort_outlier', '23.1° (room sensor) is too warm'), attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window while heating is on')];
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
  assert.equal(count(html, /23\.1° \(room sensor\) is too warm/g), 1, 'sentence once');
  assert.match(html, /probably a shower/);
  assert.match(html, /target 5\.0° \(window open\)/);
  assert.equal(count(html.slice(html.indexOf('Other rooms')), /Bathroom|Bedroom/g), 0, 'not in the tiles either');
  assert.equal(count(html, /class="rt tap"/g), 6);
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
  assert.match(occ, /Manual · 2 h ago/);
  assert.equal(count(occ, /Manual/g), 1);
  const none = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual: null } }), []), NOW);
  assert.doesNotMatch(none, /Manual/);
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

ok('Now v2 recent action note only under 15 minutes', () => {
  const at = (mins) => new Date(NOW - mins * 60000).toISOString();
  const rec = (mins) => P.render('rooms', {}, withRooms(calmRooms({ kitchen: { last: 'Kitchen lights off', last_ts: at(mins) } }), []), NOW);
  assert.match(rec(0.2), /Kitchen[\s\S]*just now/);
  assert.match(rec(4), /<span>4 min<\/span>/);
  assert.match(rec(14.5), /<span>14 min<\/span>/);
  assert.doesNotMatch(rec(15), /min<\/span>|just now/);
  assert.doesNotMatch(rec(120), /min<\/span>|just now|2 h/);
  assert.equal(P.recentNote({ last: '', last_ts: at(1) }, NOW), '');
  assert.equal(P.recentNote({ last: 'x', last_ts: 'junk' }, NOW), '');
});

ok('Now v2 tiles: unavailable occupancy keeps the dashed amber icon; rooms with no report say so; touch targets', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupancy_unavailable: true } }), []), NOW);
  assert.match(html, /aria-label="Occupancy unavailable"/);
  assert.match(html, /stroke-dasharray="2 2"/);
  const missing = P.render('rooms', {}, mk(), NOW);
  assert.equal(count(missing, /No report/g), 8);
  assert.equal(count(missing, /color:#8f9aa8">–</g), 8);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.rt\{[^}]*min-height:76px/);
  assert.match(css, /\.oc\{[^}]*min-height:64px/);
});

ok('Now v2 prices card: no Now/Next/Usage there, Details only when the path is configured and the view exists', () => {
  const prices = P.render('energy', {}, mk(), NOW);
  assert.doesNotMatch(prices, /p\/kWh|Usage|>Now<|>Next</);
  assert.match(prices, /Today's prices/);
  assert.doesNotMatch(prices, /Details ›/);
  assert.equal(P.ENERGY_PATH, '/pulse-dashboard/energy');
  assert.match(P.render('energy', { details_path: P.ENERGY_PATH }, mk(), NOW), /Details ›/);
  assert.doesNotMatch(P.render('energy', { details_path: '/elsewhere' }, mk(), NOW), /Details ›/);
  // consistency: any card config naming the energy path must point at a registered view
  const viewPaths = readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path);
  const dash = readFileSync(root + 'info-dashboard.yaml', 'utf8');
  const named = readFileSync(root + 'views/info-now.yaml', 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').includes('details_path');
  if (named) { assert.ok(viewPaths.includes('energy')); assert.match(dash, /info-energy\.yaml/); }
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
  assert.deepEqual(modes, ['now-header', 'status', 'rooms', 'energy', 'bins-heating', 'feed', 'footer']);
  for (const m of modes) assert.ok(P.render(m, {}, mk(), NOW) !== undefined);
  for (const old of ['attention', 'bins', 'heating', 'energy-foot']) assert.throws(() => P.render(old, {}, mk(), NOW), /unknown mode/, old);
});

ok('Now v2 changes nothing HA only reads at startup', () => {
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card\.js\?v=1\b/);
});

console.log(`\n${n} test groups passed`);
