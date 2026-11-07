// Offline tests for www/pulse-card.js and the YAML that drives it.
// Run: cd tests && npm install && node pulse-card.test.mjs
// Covers: every mode for all 10 rooms with full, sparse and missing report data; attention vs
// calm; manual set/null; empty, 50-slot and garbage rate lists (via the data_generator strings
// extracted from the real YAML); unknown rooms and disallowed services fail loudly.
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const Raw = require('../www/pulse-card.js');
// Pages carry var(--pulse-token) rather than hex. Most tests assert on the classic look, so P resolves the
// variables against the theme the config names (classic by default); Raw is the card as shipped.
// The shipped default is rose-pine; these tests name classic unless a config names a theme, so they keep reading
// the original colours. Tests of the default itself call Raw.render with no theme.
const themeName = (config) => (config && config.theme) || 'classic';
// One themed copy per config object: the render gate skips a repaint only when it is handed the same config.
const themed = new WeakMap();
const asTheme = (config) => {
  if (config === null || typeof config !== 'object') return { theme: 'classic' };
  if (!themed.has(config)) themed.set(config, { ...config, theme: themeName(config) });
  return themed.get(config);
};
const P = {
  ...Raw,
  render: (mode, config, ...rest) => Raw.resolveVars(Raw.render(mode, asTheme(config), ...rest), themeName(config)),
  STYLE: Raw.resolveVars(Raw.STYLE, 'classic'),
  makeRenderGate: (...a) => {
    const gate = Raw.makeRenderGate(...a);
    const run = (mode, config, ...rest) => { const out = gate.run(mode, asTheme(config), ...rest); return { ...out, html: Raw.resolveVars(out.html, themeName(config)) }; };
    return Object.create(gate, { run: { value: run } });
  },
};
// Tests that call colour helpers directly (outside a render) read the classic palette too.
Raw.useTheme({ theme: 'classic' });
const root = new URL('..', import.meta.url).pathname;
let n = 0;
// PULSE_GOLDEN_WRITE=1 only defines the helpers and rewrites the golden file (see the end of this file).
const WRITING_GOLDEN = !!process.env.PULSE_GOLDEN_WRITE;
const ok = (name, fn) => { if (WRITING_GOLDEN) return; fn(); n += 1; console.log('ok', name); };
const okAsync = async (name, fn) => { if (WRITING_GOLDEN) return; await fn(); n += 1; console.log('ok', name); };

const NOW = Date.parse('2026-10-25T18:42:00Z');
// The old "why" card is now three subsystem sections; tests about its wording read them together.
const whyAll = (config, hass, now) => ['lights', 'heating', 'presence'].map((m) => P.render(m, config, hass, now)).join('');
// The same without the Room/Target numbers, which word the target on their own ("Minimum from safety").
const whyRows = (config, hass, now) => whyAll(config, hass, now).replace(/<div class="two">.*?<\/div><\/div><\/div>(?=<div class="card">)/s, '');
const BASE = 'sensor.octopus_energy_electricity_24e8140196_1012483035417';
const FULL = (k) => ({
  k, n: k, nav: '/x', occupied: true, occupancy_unavailable: false, unavailable: [], temp: 20.8, target: 5.0,
  mode_target: 18.0, target_reason: 'window open', mode_name: 'baseline day', pres_labels: ['Bed occupied'],
  heat_labels: ['Window open'], humidity: 63, hvac_action: 'idle', heating_active: 'baseline_day',
  heating_source: 'schedule', lights_on: 0, lights_total: 3, scene: 'off', lights_enabled: true,
  heating_enabled: true, override: false, ext_open: true, holds: [], reason_text: 'Bed occupied · Window open',
  override_text: '', labels: ['Bed occupied', 'Window open'], manual: null, verdict: 'Occupied · lights off',
});
// The scenes each room must yield from the HA registry: ordered ids, the off scene last. This is the current
// hand list the card used before it read the registry, so the registry has to reproduce it.
const SCENES = {
  parlour: ['all', 'lamps', 'dining', 'off'], kitchen: ['all', 'cabinets', 'off'], hallway_downstairs: ['daylight', 'low', 'off'],
  hallway_upstairs: ['daylight', 'low', 'off'], bedroom: ['all', 'all_full', 'lamps', 'off'], bathroom: ['full', 'low', 'off'],
  home_office: ['all', 'lamps', 'off'], foreign_office: ['all', 'off'], back_garden: ['all', 'off'], front_garden: ['normal', 'off'],
};
// A registry as hass.entities / hass.devices carry it. Positions are deliberately inserted out of order, kitchen
// scenes take their area from the device, and each area also holds entities that are not scenes.
function registryFixture(want = SCENES) {
  const entities = {}; const devices = { 'dev-kitchen': { area_id: 'kitchen' } };
  for (const [key, ids] of Object.entries(want)) {
    const ordered = ids.filter((id) => id !== 'off');
    [...ordered.entries()].reverse().forEach(([i, id]) => {
      entities[`scene.${key}_${id}`] = key === 'kitchen' ? { entity_id: `scene.${key}_${id}`, device_id: 'dev-kitchen', area_id: null, labels: [`scene_order_${i + 1}`] }
        : { entity_id: `scene.${key}_${id}`, area_id: key, labels: [`scene_order_${i + 1}`, 'other_label'] };
    });
    entities[`scene.${key}_off`] = { entity_id: `scene.${key}_off`, area_id: key, labels: ['scene_control_off'] };
    entities[`switch.${key}_camera_motion`] = { entity_id: `switch.${key}_camera_motion`, area_id: key, labels: [] };
    entities[`scene.${key}_unlabelled`] = { entity_id: `scene.${key}_unlabelled`, area_id: key, labels: [] };
  }
  entities['scene.elsewhere_all'] = { entity_id: 'scene.elsewhere_all', area_id: 'garage', labels: ['scene_order_1'] };
  entities['scene.front_garden_autumn'] = { entity_id: 'scene.front_garden_autumn', area_id: 'front_garden', labels: ['scene_theme_autumn'] };
  return { entities, devices };
}
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
  const hass = { states, ...registryFixture() };
  for (const [id, v] of Object.entries(over)) { if (v === null) delete states[id]; else states[id] = v; }
  return hass;
};
const withRooms = (rooms, attention, extra = {}) => mk({
  'sensor.info_rooms': { state: 'ok', attributes: { rooms: typeof rooms === 'string' ? rooms : JSON.stringify(rooms) } },
  'sensor.info_attention': { state: String(attention.length), attributes: { items: JSON.stringify(attention) } },
  ...extra,
});
// homerun history entries (home.history.v1) and the sensor that carries them. `ago` is minutes before NOW.
const histEntry = (ago, over = {}) => ({
  ts: new Date(NOW - ago * 60000).toISOString(), location: 'kitchen', automation_id: 'kitchen:lighting', subsystem: 'lighting',
  kind: 'decision', decision: 'turn_off', reason: 'occupancy_off', outcome: 'acted', ...over,
});
const histSensor = (key, entries, over = {}) => ({ [`sensor.${key}_history`]: { state: entries.length ? entries[0].ts : 'unknown', attributes: { schema: 'home.history.v1', entries, ...over } } });
const luxHigh = (ago, lux = 85) => histEntry(ago, { decision: 'no_action', reason: 'lux_high', outcome: 'declined', facts: { lux, lux_threshold: 40 } });
// The House page is lists of rows: a row is the <a> (or <div>) that holds a room's path, a title and a subtitle.
const rowOf = (html, path) => { const m = html.match(new RegExp(`<a class="hm-row tap" data-act="nav" data-path="${path.replace(/[/.]/g, '\\$&')}"[\\s\\S]*?</a>`)); assert.ok(m, `no row for ${path}`); return m[0]; };
const rowTitle = (row) => row.match(/class="hm-rt">([^<]*)</)[1];
const rowSub = (row) => row.match(/class="hm-rs"[^>]*>([^<]*)</)[1];
const rowValue = (row) => (row.match(/class="hm-val num">([^<]*)</) || [])[1];
const NOISE = /undefined|NaN|\[object|null/;
const ALL_MODES = ['now-header', 'status', 'rooms', 'house-list', 'feed', 'tabbar', 'energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage'];
const SHARED_MODES = ['room-head', 'automation', 'room-feed'];
const INDOOR_MODES = ['readings', 'lights', 'heating', 'presence', 'media'];
const GARDEN_MODES = ['garden-lights', 'garden-theme'];
const GARDENS = ['front_garden', 'back_garden'];
const INDOOR_KEYS = P.ALL_ROOM_KEYS.filter((k) => !GARDENS.includes(k));
const modesFor = (k) => SHARED_MODES.concat(GARDENS.includes(k) ? GARDEN_MODES : INDOOR_MODES);
const renderAll = (hass) => {
  const out = {};
  for (const m of ALL_MODES) out[m] = P.render(m, {}, hass, NOW);
  for (const k of P.ALL_ROOM_KEYS) for (const m of modesFor(k)) out[`${m}:${k}`] = P.render(m, { room: k }, hass, NOW);
  return out;
};
const noNoise = (out, label) => { for (const [k, v] of Object.entries(out)) assert.ok(!NOISE.test(v), `${label} ${k} contains noise: ${(v.match(NOISE) || [])[0]} in ${v.slice(0, 200)}`); };

ok('10 rooms configured', () => assert.equal(P.ALL_ROOM_KEYS.length, 10));

ok('every mode renders for all 10 rooms with full report data (attention state)', () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const hass = withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }]);
  const out = renderAll(hass);
  noNoise(out, 'full');
  assert.match(out.status, /<h2[^>]*>Needs attention<\/h2>/);
  assert.equal(rowTitle(rowOf(out.status, '/pulse-dashboard/room-bedroom')), 'Bedroom');
  assert.match(out['room-head:bedroom'], /Window open, heating on[\s\S]*Open window while heating/, 'the attention item sits under the header');
  assert.match(out['heating:bedroom'], /class="hm-rt">Window open<\/div><\/div><span class="hm-val num">[\d.]+°/);
  assert.match(out.rooms, /room-bedroom/, 'the room is still listed under Rooms');
  assert.match(out['presence:bedroom'], /Bed occupied/);
  assert.doesNotMatch(out['presence:bedroom'], /Bed occupied · Window open/);
});

ok('calm state: no attention, All good', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, }));
  const out = renderAll(withRooms(rooms, []));
  noNoise(out, 'calm');
  assert.doesNotMatch(out.status, /Needs attention|All good|Nothing needs attention/);
  assert.doesNotMatch(out['room-head:parlour'], /All good|hm-tight/, 'a calm room has no banner and no attention list');
  assert.match(out['room-head:parlour'], /<span class="hm-line">Occupied · lights off<\/span>/);
  assert.match(out['heating:parlour'], /class="hm-rt">[A-Z][^<]*, from [^<]*<\/div><\/div><span class="hm-val num">[\d.]+°/);
  assert.doesNotMatch(out['room-head:parlour'], />Target</, 'the header carries no numbers');
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
  assert.match(out['room-head:bedroom'], /<span class="hm-line">No report<\/span>/);
  assert.equal(out['presence:bedroom'], '');
  assert.equal(out['heating:bedroom'], '');
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
  assert.equal(out['heating:hallway_upstairs'], '', 'no climate: no heating section');
  assert.doesNotMatch(out['room-head:hallway_upstairs'], />Target<|>Room</);
  const quiet = P.render('rooms', {}, withRooms([{ k: 'hallway_upstairs', n: 'x', occupied: false, temp: null, humidity: null }], []), NOW);
  const upRow = rowOf(quiet, '/pulse-dashboard/room-hallway_upstairs');
  assert.equal(rowValue(upRow), undefined, 'no trailing value for a room without climate');
  assert.match(rowSub(upRow), /no temperature sensor/);
  assert.doesNotMatch(out['heating:hallway_upstairs'], /Heating target/);
  for (const g of GARDENS) {
    assert.match(out[`room-head:${g}`], /<span class="hm-line">Lights unknown<\/span>/);
    assert.doesNotMatch(out[`room-head:${g}`], /Lights only|Target|Room</);
    assert.equal(out[`garden-theme:${g}`], '', 'no theme helper data in this fixture');
  }
});

ok('manual marker: the Lights card shows a Manual tag, and its story says who set it and what ends it', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T18:40:00+00:00', what: 'Wall button: scene cycled' };
  const room = (over, extra = {}) => withRooms([{ ...FULL('parlour'), pres_labels: [], labels: [], ...over }], [], extra);
  const set = P.render('lights', { room: 'parlour' }, room({ manual }), NOW);
  assert.match(set, /Manual · Wall button at 18:40 · stays until the room is empty/);
  assert.equal((set.match(/Manual/g) || []).length, 1, 'said once, as the footnote under the scenes');
  assert.doesNotMatch(set, /class="note"|wall button|ago|Stays until|Set by automation|Tap a scene/);
  assert.match(set, /aria-pressed="true"/); // lamps is active
  assert.match(set, /data-entity="scene.parlour_lamps"/);
  const none = P.render('lights', { room: 'parlour' }, room({ manual: null }), NOW);
  assert.doesNotMatch(none, /Manual|class="note"/);
  const why = (over, extra) => whyAll({ room: 'parlour' }, room(over, extra), NOW);
  const wall = why({ manual });
  assert.match(wall, /Manual · Wall button at 18:40 · stays until the room is empty/);
  assert.doesNotMatch(wall, /scene cycled/, 'what the wall button did is not repeated');
  const dash = why({ manual: { source: 'dashboard', ts: '2026-10-25T18:40:00+00:00', what: 'lamps scene' } });
  assert.match(dash, /Dashboard at 18:40: lamps scene · stays until the room is empty/);
  const dark = histEntry(12, { location: 'parlour', decision: 'activate_scene', reason: 'lux_low', facts: { lux: 12, lux_threshold: 40 } });
  const auto = why({ manual: null, lights_on: 2 }, histSensor('parlour', [dark]));
  assert.match(auto, /Auto · Scene set · room occupied and dark \(12 lx, on at 40 or below\) at 18:30 · off when the room empties/);
  const hold = why({ manual: null, lights_on: 2, pres_labels: ['Monitor on'], labels: ['Monitor on'] });
  assert.match(hold, /Hold · /);
  assert.match(hold, /stays on while Monitor on/);
  const off = why({ manual: null, lights_on: 0, pres_labels: ['Monitor on'], labels: ['Monitor on'] });
  assert.doesNotMatch(off, /stays on while/, 'a held room with the lights off does not claim they stay on');
  const disabled = why({ manual, lights_enabled: false });
  assert.match(disabled, /Lights automation is off · they change only by hand/);
  assert.doesNotMatch(disabled, /Auto · |Manual · /, 'the sentence already says it, so no mode prefix');
  assert.match(why({ manual: null }, histSensor('parlour', [])), /No lighting decision recorded yet/);
  assert.match(why({ manual: null }), /Lighting history unavailable/, 'a missing history sensor is said, not passed off as quiet');
});

// ── lightsStory: first matching rule wins ─────────────────────────────────────────────────────
const story = (over = {}, extra = {}, key = 'kitchen') => P.lightsStory(withRooms([{ ...FULL(key), manual: null, pres_labels: [], labels: [], occupied: true, lights_on: 0, ...over }], [], extra), key, NOW);
const kitchenEntity = (id, friendly) => ({ [id]: { state: 'on', attributes: { friendly_name: friendly } } });

ok('lightsStory rule 1: lights automation off beats a declined entry and a manual change', () => {
  const s = story({ lights_enabled: false, manual: { source: 'wall_button', ts: histEntry(1).ts, what: '' } }, histSensor('kitchen', [luxHigh(1)]));
  assert.equal(s.state, 'disabled');
  assert.equal(s.why, 'Lights automation is off · they change only by hand');
});

ok('lightsStory rule 2: a manual change wins only when newer than the last automated action', () => {
  const manual = (ago) => ({ source: 'wall_button', ts: histEntry(ago).ts, what: '' });
  const acted = histEntry(30);
  const newer = story({ manual: manual(10), lights_on: 2 }, histSensor('kitchen', [luxHigh(5), acted]));
  assert.equal(newer.state, 'manual');
  assert.match(newer.why, /^Wall button at 18:32 · stays until the room is empty$/);
  const older = story({ manual: manual(40), lights_on: 2 }, histSensor('kitchen', [acted]));
  assert.equal(older.state, 'acted', 'the automation acted after the hand change, so the hand change no longer explains the lights');
  assert.match(older.why, /^Lights off · room empty at 18:12 · off when the room empties$/);
  assert.equal(story({ manual: manual(10), lights_on: 2 }, histSensor('kitchen', [])).state, 'manual', 'no automated action on record');
});

ok('lightsStory rule 3: lights off in an empty room says since when, notes a disabled motion sensor, flags an unavailable one', () => {
  const occ = (state, changed) => ({ 'binary_sensor.kitchen_occupied': { state, last_changed: changed, attributes: {} } });
  const empty = story({ occupied: false }, { ...occ('off', '2026-10-25T14:03:00+00:00'), ...histSensor('kitchen', [luxHigh(1)]) });
  assert.deepEqual([empty.state, empty.why, empty.tone], ['empty', 'No one detected since 14:03', 'ok'], 'beats a declined entry');
  const noMotion = story({ occupied: false }, { ...occ('off', '2026-10-25T14:03:00+00:00'), 'input_boolean.kitchen_sensor_motion_enabled': { state: 'off', attributes: {} } });
  assert.equal(noMotion.why, 'No one detected since 14:03 · motion sensor is off');
  assert.equal(story({ occupied: false }, occ('off', 'garbage')).why, 'No one detected', 'an unreadable time is dropped, not invented');
  assert.equal(story({ occupied: false }, occ('off', '2030-01-01T00:00:00+00:00')).why, 'No one detected since 18:42', 'a future time is clamped to now');
  const gone = story({ occupied: false, occupancy_unavailable: true });
  assert.deepEqual([gone.why, gone.tone], ['Occupancy sensor unavailable', 'warn']);
  assert.equal(story({ occupied: true, lights_on: 0 }, histSensor('kitchen', [])).state, 'none', 'an occupied room with lights off falls through to history');
  assert.notEqual(story({ occupied: false, lights_on: 2 }, histSensor('kitchen', [])).state, 'empty', 'lights on: not rule 3');
});

ok('lightsStory rule 4: a newer decline, abort or failure is explained in words; an older one is not', () => {
  const declined = story({}, histSensor('kitchen', [luxHigh(1), histEntry(30)]));
  assert.deepEqual([declined.state, declined.tone, declined.why], ['declined', 'muted', 'Stayed off at 18:41: bright enough (85 lx, on at 40 or below)']);
  assert.match(story({}, histSensor('kitchen', [luxHigh(1, null)])).why, /bright enough \(no light reading, on at 40 or below\)/);
  const abort = histEntry(2, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unavailable_input', entity: 'sensor.kitchen_lux' } });
  const a = story({}, { ...histSensor('kitchen', [abort, histEntry(30)]), ...kitchenEntity('sensor.kitchen_lux', 'Lux sensor') });
  assert.deepEqual([a.state, a.tone, a.why], ['problem', 'warn', "Couldn't run: Lux sensor unavailable at 18:40"]);
  const failed = histEntry(2, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'ack_timeout', action: 'light.turn_on', entity: 'light.kitchen_ceiling' } });
  const f = story({}, { ...histSensor('kitchen', [failed, histEntry(30)]), ...kitchenEntity('light.kitchen_ceiling', 'Kitchen ceiling') });
  assert.deepEqual([f.state, f.tone, f.why], ['problem', 'warn', "Kitchen ceiling didn't respond at 18:40"]);
  const old = story({}, histSensor('kitchen', [histEntry(1), luxHigh(30)]));
  assert.equal(old.state, 'acted', 'the decline is older than the last act, so the act explains the lights');
  const heldOn = story({ lights_on: 2, pres_labels: ['Monitor on'] }, histSensor('kitchen', [luxHigh(1)]));
  assert.match(heldOn.why, /^Stayed off at 18:41: bright enough \(85 lx, on at 40 or below\) · stays on while Monitor on$/);
  const other = story({}, histSensor('kitchen', [histEntry(1, { subsystem: 'occupied', decision: 'set_occupied', reason: 'motion_detected' })]));
  assert.equal(other.state, 'none', 'occupancy entries are not lighting explanations');
});

ok('lightsStory rule 5: the last act in words, then an honest empty, then a visible note for a bad payload', () => {
  const s = story({ lights_on: 2 }, histSensor('kitchen', [histEntry(3, { decision: 'turn_on', reason: 'sunset', facts: {} }), histEntry(9, { decision: 'no_action', reason: 'lux_high', outcome: 'declined', facts: { lux: 60, lux_threshold: 40 } })]));
  assert.deepEqual([s.state, s.why], ['acted', 'Lights on · sunset at 18:39 · off when the room empties']);
  assert.equal(story({}, histSensor('kitchen', [])).why, 'No lighting decision recorded yet');
  const bad = story({}, histSensor('kitchen', [], { schema: 'home.history.v9' }));
  assert.deepEqual([bad.why, bad.tone], ['Lighting history unreadable', 'warn']);
  assert.equal(story({}, histSensor('kitchen', [histEntry(1, { subsystem: 'lighting', outcome: undefined, decision: 'turn_on', reason: 'on_by_something' })])).state, 'acted', 'an undeclared decision with actions counts as an act');
});

ok('history parser: malformed payloads give an empty list and a visible note, never a throw', () => {
  const good = histEntry(5);
  assert.deepEqual(P.parseHistory(undefined), { entries: [], note: '' }, 'never received yet');
  assert.deepEqual(P.parseHistory({}), { entries: [], note: '' });
  assert.equal(P.parseHistory({ schema: 'home.history.v1', entries: [] }).note, '');
  for (const bad of [{ schema: 'other', entries: [good] }, { schema: 'home.history.v1', entries: 'not json' }, { schema: 'home.history.v1', entries: { a: 1 } }, { schema: 'home.history.v1' }, 'string', 42]) {
    assert.deepEqual(P.parseHistory(bad), { entries: [], note: 'History unreadable' }, JSON.stringify(bad));
  }
  const mixed = P.parseHistory({ schema: 'home.history.v1', entries: [good, null, 7, { ts: 'x', kind: 'decision', subsystem: 'lighting', location: 'k' }, { ...good, kind: 'mystery' }, { ...good, outcome: 'ignored' }, { ...good, subsystem: '' }] });
  assert.equal(mixed.entries.length, 1);
  assert.equal(mixed.note, '6 entries could not be read');
  const shuffled = P.parseHistory({ schema: 'home.history.v1', entries: JSON.stringify([histEntry(30), histEntry(1), histEntry(10)]) });
  assert.deepEqual(shuffled.entries.map((e) => e.ts), [1, 10, 30].map((m) => histEntry(m).ts), 'sorted newest first whatever the order sent');
  assert.equal(P.parseHistory({ schema: 'home.history.v1', entries: Array.from({ length: 500 }, (_, i) => histEntry(i)) }).entries.length, 200, 'capped at homerun\'s own maximum');
  assert.deepEqual(P.parseHistory({ schema: 'home.history.v1', entries: [{ ...good, facts: { a: 1, b: { x: 1 }, c: [1] } }] }).entries[0].facts, { a: 1 }, 'facts are flat primitives only');
  assert.deepEqual(P.readHistory(mk(), 'sensor.nope_history'), { entries: [], note: 'History unavailable' });
  assert.equal(P.readHistory(mk({ 'sensor.x_history': { state: 'unavailable', attributes: {} } }), 'sensor.x_history').note, 'History unavailable');
});

ok('Recent activity rows by kind: acted plain, declined muted, guard muted, failure amber, repeats collapse', () => {
  const abort = histEntry(4, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'guard' } });
  const failed = histEntry(5, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'error', action: 'scene.turn_on', entity: 'scene.kitchen_all' } });
  const entries = [histEntry(1), histEntry(2), luxHigh(3), abort, failed];
  const html = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', entries, {})), NOW);
  // A row: the time, the dot (kind in the class), then the subject in bold, the verb part and the reason part.
  const line = (time, kind, text) => new RegExp(`<div class="tl-row ${kind}"><span class="tl-t num">${time}</span><span class="tl-rail" aria-hidden="true"><i class="tl-dot"[^>]*></i></span><div class="tl-b" style="color:[^"]*">${text}`);
  assert.match(html, line('18:41', 'acted', '<b class="tl-s">Lights</b> off<span style="color:#a3adba"> · room empty</span> <span class="tl-n">x2</span>'));
  assert.match(html, line('18:39', 'declined', '<b class="tl-s">Lights</b> stayed off: bright enough \\(85 lx, on at 40 or below\\)</div>'));
  assert.match(html, line('18:38', 'declined', '<b class="tl-s">Lights</b> held back</div>'), 'a guard is routine: a quiet row on a room page, not amber');
  assert.match(html, line('18:37', 'problem', '<b class="tl-s">Lights</b> couldn&#39;t be controlled \\(turn on\\)'));
  assert.match(html, /class="tl-row acted">[^]*?class="tl-b" style="color:#e8ebef"/);
  assert.match(html, /class="tl-row declined">[^]*?class="tl-b" style="color:#a3adba"/);
  assert.match(html, /class="tl-row problem">[^]*?class="tl-b" style="color:#f2b84b"/);
  assert.equal((html.match(/class="tl-row /g) || []).length, 4, 'one row per distinct entry; homerun stores no plumbing, so the card has nothing to hide');
  assert.match(html, /<h2>Activity<\/h2>/);
  assert.doesNotMatch(html, /⊘/);
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [])), NOW), /Nothing recorded for this room yet/);
  const unreadable = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [good(), 5])), NOW);
  assert.match(unreadable, /1 entry could not be read/);
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [], { schema: 'nope' })), NOW), /Nothing recorded for this room yet[\s\S]*History unreadable/);
  function good() { return histEntry(2); }
});

ok('scene tiles use the spike scene map and highlight the active scene', () => {
  for (const k of INDOOR_KEYS) {
    const tiles = [...P.render('lights', { room: k }, mk(), NOW).matchAll(/data-act="scene" data-entity="scene\.(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(tiles, SCENES[k].map((id) => `${k}_${id}`), k);
  }
  for (const g of GARDENS) assert.equal(P.ROOMS[g].scenes, undefined, `${g} offers no scenes of its own`);
});

ok('individual lights: a disclosure row with an "N of M on" summary; open, a switch row per light, a slider under a dimmable light that is on, missing honestly', () => {
  const OPEN = { open: { 'parlour:lights': true } };
  const closed = P.render('lights', { room: 'parlour' }, mk(), NOW);
  const html = P.render('lights', { room: 'parlour' }, mk(), NOW, OPEN);
  assert.match(html, /<h2>Scenes<\/h2>/);
  assert.doesNotMatch(html, /<h2>Lights<\/h2>/, 'the row is the label; no section header');
  assert.match(closed, /<button type="button" class="hm-row hm-btn tap" data-act="disclose" data-id="parlour:lights" aria-expanded="false" aria-controls="dp-parlour-lights"><div class="hm-text"><div class="hm-rt">Individual lights<\/div><\/div><span class="hm-val hm-ds">\d+ of \d+ on<\/span>/);
  assert.match(closed, /<div class="hm-dp" id="dp-parlour-lights" hidden>/, 'closed: the panel is in the markup, hidden, so aria-controls names an element');
  assert.match(html, /aria-expanded="true" aria-controls="dp-parlour-lights"/);
  assert.match(html, /<div class="hm-dp" id="dp-parlour-lights">/);
  assert.match(html, /data-act="toggle" data-entity="light.parlour_light_floor_lamp" aria-pressed="true"><div class="hm-text"><div class="hm-rt">Floor lamp<\/div><div class="hm-rs">40%<\/div>/);
  assert.match(html, /type="range"[^>]*data-act="brightness" data-entity="light.parlour_light_floor_lamp"/);
  assert.match(html, /style="--p:40%"/);
  assert.match(html, /data-act="toggle" data-entity="switch.parlour_plug_table_lamp" aria-pressed="true"[\s\S]*?<div class="hm-rs">On<\/div>/);
  assert.match(html, /<div class="hm-rs">Not found<\/div>/);
  const off = P.render('lights', { room: 'parlour' }, mk({ 'light.parlour_light_floor_lamp': { state: 'off', attributes: { supported_color_modes: ['brightness'] } } }), NOW, OPEN);
  assert.doesNotMatch(off, /type="range"/, 'no slider for a light that is off');
  assert.match(off, /data-entity="light.parlour_light_floor_lamp" aria-pressed="false"/);
  for (const k of INDOOR_KEYS) assert.equal(P.render('lights', { room: k }, mk(), NOW).includes('data-id="' + k + ':lights"'), P.ROOMS[k].lights.length > 0, k);
  noNoise({ html }, 'lights');
  assert.throws(() => P.render('lights-title', { room: 'parlour' }, mk(), NOW), /unknown mode/);
});

ok('individual lights summary: "All off" at none, else "N of M on" over the configured lights', () => {
  const lights = P.ROOMS.parlour.lights.map(([id]) => id);
  const sum = (over) => P.render('lights', { room: 'parlour' }, mk(over), NOW).match(/class="hm-val hm-ds">([^<]*)</)[1];
  assert.equal(sum(Object.fromEntries(lights.map((id) => [id, { state: 'off', attributes: {} }]))), 'All off');
  assert.equal(sum(Object.fromEntries(lights.map((id, i) => [id, { state: i === 0 ? 'on' : 'off', attributes: {} }]))), `1 of ${lights.length} on`);
  assert.equal(sum(Object.fromEntries(lights.map((id) => [id, { state: 'on', attributes: {} }]))), `${lights.length} of ${lights.length} on`);
});

ok('disclosure: state is per page, default closed, toggled and persisted; a bad id throws; the render gate sees it', () => {
  const key = 'zz_room:lights';
  assert.equal(P.disclosureStore[key], undefined);
  assert.equal(P.toggleDisclosure(key), true);
  assert.equal(P.disclosureStore[key], true);
  assert.equal(P.toggleDisclosure(key), false);
  assert.equal(key in P.disclosureStore, false);
  for (const bad of ['', 'x', 'a:b:c', '__proto__', undefined, 5, 'A:b']) assert.throws(() => P.toggleDisclosure(bad), /bad disclosure id/);
});

ok('expander-card is gone; Now no longer uses apexcharts', () => {
  for (const f of ['info_templates.yaml', 'info-dashboard.yaml', ...readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((x) => 'views/' + x)]) {
    assert.doesNotMatch(readFileSync(root + f, 'utf8'), /expander-card|lights-title/, f);
  }
  assert.doesNotMatch(readFileSync(root + 'views/info-house.yaml', 'utf8'), /apexcharts-card/, 'House has no apexcharts: energy block is drawn by pulse-card');
});

ok('device mode: fan row shows state and reason, taps toggle, hides when blank, fails loudly when misconfigured', () => {
  const cfg = { entity: 'switch.bathroom_fan_extractor', decision: 'sensor.bathroom_fan_decision', label: 'Extractor fan' };
  const hass = (sw, reason) => mk({
    'switch.bathroom_fan_extractor': sw === null ? null : { state: sw, attributes: {} },
    'sensor.bathroom_fan_decision': { state: 'x', attributes: { reason } },
  });
  const on = P.render('device', cfg, hass('on', 'fan_on_shower_started'), NOW);
  assert.match(on, /Extractor fan/);
  assert.match(on, /On · Shower started/);
  assert.match(on, /data-act="toggle" data-entity="switch.bathroom_fan_extractor" aria-pressed="true"/);
  assert.match(P.render('device', cfg, hass('off', 'fan_off_humidity_normal'), NOW), /Off · Humidity back to normal/);
  const words = { fan_off_max_run: ['off', 'Ran its maximum time'], fan_run_extended: ['on', 'Another shower started'], fan_holding_min_run: ['on', 'Minimum run'], fan_holding_humidity_high: ['on', 'Clearing steam'], fan_not_auto_started: ['on', 'Turned on by hand'], automation_disabled: ['off', 'Fan automation is off'] };
  for (const [r, [st, text]] of Object.entries(words)) assert.match(P.render('device', cfg, hass(st, r), NOW), new RegExp(`${st === 'on' ? 'On' : 'Off'} · ${text}`), r);
  assert.deepEqual(Object.keys(P.DEVICE_REASONS).sort(), ['automation_disabled', 'fan_holding_humidity_high', 'fan_holding_min_run', 'fan_not_auto_started', 'fan_off_humidity_normal', 'fan_off_max_run', 'fan_on_shower_started', 'fan_run_extended']);
  // A stale reason that contradicts the switch, an ignored reason and a missing reason all show state only.
  assert.match(P.render('device', cfg, hass('off', 'fan_on_shower_started'), NOW), /<div class="hm-rs">Off<\/div>/);
  assert.match(P.render('device', cfg, hass('on', 'fan_idle'), NOW), /<div class="hm-rs">On<\/div>/);
  assert.match(P.render('device', cfg, hass('on', undefined), NOW), /<div class="hm-rs">On<\/div>/);
  assert.match(P.render('device', cfg, hass(null, 'fan_idle'), NOW), /Not found/);
  assert.match(P.render('device', cfg, hass('unavailable', 'fan_idle'), NOW), /Unavailable/);
  assert.doesNotMatch(P.render('device', cfg, hass('unavailable', 'fan_idle'), NOW), /data-act/);
  assert.equal(P.render('device', { entity: '', decision: '', label: '' }, mk(), NOW), '');
  assert.throws(() => P.render('device', { entity: 'switch.x', decision: '' }, mk(), NOW), /needs an entity and a decision/);
  assert.throws(() => P.render('device', {}, mk(), NOW), /needs an entity and a decision/);
  assert.throws(() => P.render('device', { entity: 'lock.front', decision: 'sensor.d' }, mk(), NOW), /cannot switch/);
  const calls = [];
  P.handleAction({ states: hass('on', 'x').states, callService: (...a) => calls.push(a) }, { dataset: { act: 'toggle', entity: 'switch.bathroom_fan_extractor' } });
  assert.deepEqual(calls, [['switch', 'turn_off', { entity_id: 'switch.bathroom_fan_extractor' }]]);
});

ok('fan row keeps its on/off toggle and reason and no longer carries steppers', () => {
  const cfg = { entity: 'switch.bathroom_fan_extractor', decision: 'sensor.bathroom_fan_decision', label: 'Extractor fan' };
  const b = (st) => ({ state: st, attributes: {} });
  const hass = mk({
    'switch.bathroom_fan_extractor': b('off'), 'sensor.bathroom_fan_decision': { state: 'no_action', attributes: { reason: 'fan_idle' } },
    'input_number.bathroom_automation_fan_min_run': b('15'),
  });
  const out = P.render('device', cfg, hass, NOW);
  assert.match(out, /data-act="toggle" data-entity="switch\.bathroom_fan_extractor"/);
  assert.doesNotMatch(out, /Minimum run|setting-number|fan-number|<input/);
});

ok('device row sits under the media card and only the bathroom page fills it', () => {
  const tpl = yaml.load(readFileSync(root + 'info_templates.yaml', 'utf8')).pulse_room;
  const modes = tpl.card.cards.map((c) => c.mode).filter(Boolean);
  assert.ok(modes.indexOf('device') === modes.indexOf('media') + 1, 'device directly after media');
  assert.deepEqual(tpl.default.find((d) => 'fan' in d), { fan: '' });
  for (const f of readdirSync(root + 'views').filter((x) => /^info-room-/.test(x))) {
    const cards = yaml.load(readFileSync(root + 'views/' + f, 'utf8')).sections[0].cards;
    const garden = GARDENS.some((g) => f === `info-room-${g}.yaml`);
    assert.equal(cards.some((c) => c.template === 'pulse_garden'), garden, `${f} uses the garden template only for gardens`);
    if (garden) continue;
    const v = cards.find((c) => c.template === 'pulse_room').variables;
    assert.equal(!!v.fan, f === 'info-room-bathroom.yaml', f);
    if (v.fan) assert.deepEqual([v.fan, v.fan_decision], ['switch.bathroom_fan_extractor', 'sensor.bathroom_fan_decision']);
  }
});

// Mirrors streamline-card's evaluateVariables: defaults come only from the template's `default` (list of
// single-key maps or an object), never from a template-level `variables:`; the view's variables win.
const streamlineVars = (tpl, viewVars) => {
  const flat = (d) => (Array.isArray(d) ? Object.assign({}, ...d) : d || {});
  return { ...flat(tpl.default), ...flat(viewVars) };
};
const substitute = (node, vars) => {
  if (typeof node === 'string') return node.replace(/\[\[(\w+)\]\]/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  if (Array.isArray(node)) return node.map((x) => substitute(x, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, vars)]));
  return node;
};

ok('every room and garden view resolves its template with no placeholder left and valid pulse-cards', () => {
  const templates = yaml.load(readFileSync(root + 'info_templates.yaml', 'utf8'));
  for (const t of Object.values(templates)) assert.equal(t.variables, undefined, 'streamline ignores template-level variables');
  const views = readdirSync(root + 'views').filter((x) => /^info-room-/.test(x));
  assert.equal(views.length, P.ALL_ROOM_KEYS.length, 'one room view per room');
  for (const f of views) {
    const call = yaml.load(readFileSync(root + 'views/' + f, 'utf8')).sections[0].cards.find((c) => c.type === 'custom:streamline-card');
    const tpl = templates[call.template];
    assert.ok(tpl, `${f} names a known template`);
    const resolved = substitute(tpl.card, streamlineVars(tpl, call.variables));
    assert.doesNotMatch(JSON.stringify(resolved), /\[\[[^\]]*\]\]/, `${f} leaves no placeholder`);
    const pulse = resolved.cards.filter((c) => c.type === 'custom:pulse-card');
    assert.ok(pulse.length >= 4, `${f} has its pulse-cards`);
    for (const c of pulse) assert.doesNotThrow(() => P.render(c.mode, c, mk(), NOW), `${f} ${c.mode}`);
  }
  // The regression itself: a room that passes no fan must resolve the device card to blank, not "[[fan]]".
  const kitchen = templates.pulse_room;
  const dev = substitute(kitchen.card, streamlineVars(kitchen, { room: 'kitchen' })).cards.find((c) => c.mode === 'device');
  assert.deepEqual([dev.entity, dev.decision, dev.label], ['', '', '']);
});

ok('media only for rooms with players', () => {
  for (const k of INDOOR_KEYS) {
    const html = P.render('media', { room: k }, mk(), NOW);
    assert.equal(html === '', P.ROOMS[k].media.length === 0, k);
  }
  const p = P.render('media', { room: 'parlour' }, mk(), NOW);
  assert.match(p, /data-act="media-play"/);
  assert.match(p, /data-act="volume"/);
  assert.match(p, /data-act="media-power"/);
});

ok('House list: what is due next and when; boiler and inside/outside', () => {
  const html = P.render('house-list', {}, mk({ 'sensor.house_average_temperature': { state: '19.9', attributes: {} }, 'weather.forecast_home': { state: 'cloudy', attributes: { temperature: 10 } } }), NOW);
  assert.match(html, /<div class="hm-rt">Refuse<\/div><div class="hm-rs" style="color:#f2b84b">Collected tomorrow</);
  assert.match(html, /Boiler firing/);
  assert.match(html, /19\.9° in, 10\.0° out/);
  const tie = P.render('house-list', {}, mk({ 'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '4', attributes: {} }, 'sensor.st_albans_collect_domestic_food_days_until_collection': { state: '4', attributes: {} }, 'binary_sensor.house_heating_boiler_firing': { state: 'off', attributes: {} } }), NOW);
  assert.match(tie, /Food and refuse/);
  assert.match(tie, /Collected in 4 days/);
  assert.match(tie, /Boiler idle/);
  const none = P.render('house-list', {}, { states: {} }, NOW);
  assert.match(none, /No collection data/);
  assert.match(none, /no readings/);
  noNoise({ none }, 'bins empty');
  assert.match(P.render('house-list', {}, mk({ 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } }), NOW), /Heating off/);
});

ok('energy page chart handles missing sensors', () => {
  const html = P.render('energy-day', {}, { states: {} }, NOW, {});
  assert.match(html, /No price data for today/);
  assert.doesNotMatch(html, NOISE);
});

ok('House feed reads sensor.house_history, says where, and a stored info_decision_feed is ignored', () => {
  const house = (entries, over = {}) => mk({ ...histSensor('house', entries, over) });
  const stale = { 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify([{ loc: 'kitchen', ts: '2026-10-25T18:20:00+00:00', sentence: 'OLD FEED SENTENCE' }]) } } };
  const hass = mk({ ...histSensor('house', [histEntry(1, { location: 'kitchen' }), histEntry(5, { location: 'house', subsystem: 'energy', decision: 'spin', reason: 'wheels_spun', automation_id: 'house:wheel' })]), ...stale });
  const feed = P.render('feed', {}, hass, NOW);
  assert.match(feed, /<span class="tl-t num">18:41<\/span>[^]*?<b class="tl-s">Kitchen<\/b> lights off<span style="color:#a3adba"> · room empty<\/span>/);
  assert.match(feed, /<span class="tl-t num">18:37<\/span>[^]*?<b class="tl-s">Energy<\/b> spun the Octopus wheels/, 'whole-house entries carry their subsystem noun');
  assert.doesNotMatch(feed, /OLD FEED SENTENCE/, 'the old feed sensor is no longer read');
  assert.match(P.render('feed', {}, house([]), NOW), /Nothing recorded yet/);
  assert.match(P.render('feed', {}, mk(), NOW), /Nothing recorded yet[\s\S]*History unavailable/, 'no sensor: say so rather than imply a quiet house');
  assert.match(P.render('feed', {}, house([], { schema: 'nope' }), NOW), /History unreadable/);
  const declined = P.render('feed', {}, house([luxHigh(2)]), NOW);
  assert.match(declined, /<b class="tl-s">Kitchen<\/b> stayed off: bright enough/, 'a rule that chose not to act reads muted, as on the room page');
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk({ ...histSensor('kitchen', [histEntry(1)]) }), NOW), /<b class="tl-s">Lights<\/b> off<span style="color:#a3adba"> · room empty/);
});

ok('unknown room and unknown mode fail loudly', () => {
  assert.throws(() => whyAll({ room: 'attic' }, mk(), NOW), /needs a known room/);
  assert.throws(() => P.render('nope', {}, mk(), NOW), /unknown mode/);
});

ok('every nav path targets the registered dashboard (/pulse-dashboard) or Mobile, and each Pulse path is a real view', () => {
  assert.equal(P.DASH, '/pulse-dashboard');
  const viewPaths = new Set();
  for (const f of readdirSync(root + 'views').filter((x) => x.startsWith('info-'))) {
    const v = yaml.load(readFileSync(root + 'views/' + f, 'utf8'));
    viewPaths.add(v.path);
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
      assert.ok(p.startsWith(P.DASH + '/'), `${k}: ${p} must start with ${P.DASH}/`);
      assert.ok(viewPaths.has(p.slice(P.DASH.length + 1)), `${k}: ${p} has no matching view path`);
    }
  }
  assert.ok(seen > 15, 'expected nav links in the rendered output');
  assert.doesNotMatch(readFileSync(root + 'www/pulse-card.js', 'utf8'), /\/info-dashboard/);
});

ok('write paths are whitelisted; others throw', () => {
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
  assert.match(P.render('status', {}, mk(), NOW), /Cheapest 2 hours<\/span><span class="num">Tomorrow 20:00 – 22:00</);
  assert.doesNotMatch(energy + P.render('status', {}, mk(), NOW), /02:00 → 04:00|avg 9\.8p/, 'the template sensors are no longer read');
  // later today
  const later = mk(cw({ next_time: '2026-10-25T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.059 }));
  assert.equal(P.cheapestWindow(later, NOW).dayWord, 'Today');
  assert.match(P.render('status', {}, later, NOW), /Cheapest 2 hours<\/span><span class="num">20:00 – 22:00</);
  // further out: a dated label
  const far = mk(cw({ next_time: '2026-10-28T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.1 }));
  assert.equal(P.cheapestWindow(far, NOW).dayWord, 'Wed 28 Oct');
  // already past (the 22:07 bug): hidden on Now, none upcoming on Energy
  const past = mk(cw({ next_time: '2026-10-25T20:00:00+00:00', next_duration_in_hours: 2, next_average_value: 0.259 }));
  const late = Date.parse('2026-10-25T22:07:00Z');
  assert.equal(P.cheapestWindow(past, late).status, 'none');
  assert.doesNotMatch(P.render('status', {}, past, late), /Cheapest 2 hours/);
  assert.match(P.render('energy-day', {}, past, late, {}), /Next cheapest 2 hours<\/div><div class="m">none upcoming/);
  // running now: from current_end, or current_start + duration; state on without an end still says running
  const run = mk(cw({ current_start: '2026-10-25T18:00:00+00:00', current_end: '2026-10-25T20:00:00+00:00' }, 'on'));
  assert.equal(P.cheapestWindow(run, NOW).endText, '20:00');
  assert.match(P.render('status', {}, run, NOW), /Cheapest 2 hours<\/span><span class="num">Now, until 20:00</);
  assert.match(P.render('energy-day', {}, run, NOW, {}), /Running now/);
  assert.equal(P.cheapestWindow(mk(cw({ current_start: '2026-10-25T18:00:00+00:00', current_duration_in_hours: 2 }, 'on')), NOW).endText, '20:00');
  assert.match(P.render('status', {}, mk(cw({}, 'on')), NOW), /Cheapest 2 hours<\/span><span class="num">Now</);
  // unknown / garbage / missing -> hidden, never throws
  for (const attrs of [{}, { next_time: 'nope', next_duration_in_hours: 2 }, { next_time: '2026-10-26T20:00:00+00:00' }, { next_time: '2026-10-26T20:00:00+00:00', next_duration_in_hours: 0 }]) {
    assert.equal(P.cheapestWindow(mk(cw(attrs)), NOW).status, 'none', JSON.stringify(attrs));
    assert.doesNotMatch(P.render('status', {}, mk(cw(attrs)), NOW), /Cheapest 2 hours/);
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

ok('frontend registers the fixed loader, not a versioned card URL', () => {
  const y = readFileSync(root + 'packages/frontend.yaml', 'utf8');
  assert.match(y, /- \/local\/pulse-card-loader\.js\n/);
  assert.doesNotMatch(y, /pulse-card\.js\?v=/);
  assert.match(readFileSync(root + 'www/pulse-card.js', 'utf8'), /Cache busting: none needed/);
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
  assert.ok(html.includes(`<div class="hm-price num" style="color:${P.priceColour(34.8, { text: true })}">34.8<small>p</small></div>`));
  assert.match(html, /Next 41\.2p</);
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

function mkSlots(n, startIso, f) { return Array.from({ length: n }, (_, i) => { const t = Date.parse(startIso) + i * 1800000; return { start: new Date(t).toISOString(), end: new Date(t + 1800000).toISOString(), value_inc_vat: f(i) / 100 }; }); }

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


// ── Now v2 ─────────────────────────────────────────────────────────────────────────────────────
const quietRoom = (k, over = {}) => ({ ...FULL(k), occupied: false, target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, manual: null, lights_on: 0, lights_why: 'lights back to automatic', lights_ts: '2026-10-25T16:40:00+00:00', last: 'Off', last_ts: '2026-10-25T16:40:00+00:00', humidity: 55, scene: '', verdict: 'Empty', ...over });
const calmRooms = (over = {}) => P.ROOM_ORDER.map((k) => quietRoom(k, over[k] || {}));
const count = (html, re) => (html.match(re) || []).length;
const attn = (room, key, kind, text) => ({ room, key, kind, text, nav: '/x' });

// House page rooms, attention and widget (native list design)
const roomPaths = (html) => [...html.slice(0, html.indexOf('<h2>Outside')).matchAll(/data-path="\/pulse-dashboard\/room-(\w+)"/g)].map((m) => m[1]);
const tileStyle = (row) => row.match(/class="hm-tile" style="([^"]*)"/)[1];

ok('House calm: no attention section, no occupied rooms; Rooms lists all 8 in order with "0 occupied"', () => {
  const hass = withRooms(calmRooms(), []);
  const status = P.render('status', {}, hass, NOW);
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.doesNotMatch(status, /Needs attention|All good|Nothing needs attention/);
  assert.match(rooms, /<h2>Rooms<\/h2><span class="hm-tr">0 occupied<\/span>/);
  assert.doesNotMatch(rooms, /Occupied now|Other rooms/);
  assert.deepEqual(roomPaths(rooms), P.ROOM_ORDER);
  assert.equal(count(rooms, /style="background:#ff9f0a/g), 0, 'no occupied tile');
  assert.equal(count(rooms, /style="background:#2c2c2e;color:#a3adba"/g), 8, 'eight idle tiles');
  assert.doesNotMatch(rooms, /%|humidity|automatic/);
  noNoise({ status, rooms }, 'calm house');
});

ok('House rooms: an occupied room leads the list with the occupied tile, lights line and temperature', () => {
  const hass = withRooms(calmRooms({ bedroom: { occupied: true, lights_on: 3, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], temp: 20.4, scene: 'parlour_lamps' } }), [], { 'sensor.bedroom_active_scene': { state: 'bedroom_lamps', attributes: {} } });
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.match(rooms, /<span class="hm-tr">1 occupied<\/span>/);
  assert.deepEqual(roomPaths(rooms), ['bedroom', ...P.ROOM_ORDER.filter((k) => k !== 'bedroom')]);
  const row = rowOf(rooms, '/pulse-dashboard/room-bedroom');
  assert.equal(rowTitle(row), 'Bedroom');
  assert.equal(tileStyle(row), 'background:#ff9f0a;color:#000000');
  assert.match(row, /<svg[^>]*fill="currentColor"/, 'occupied is a solid person glyph');
  assert.equal(rowSub(row), 'Lamps · sofa occupied');
  assert.equal(rowValue(row), '20.4°');
  const idle = rowOf(rooms, '/pulse-dashboard/room-parlour');
  assert.doesNotMatch(idle, /<svg[^>]*fill="currentColor"/, 'empty is an outline glyph');
  assert.equal(rowSub(idle), 'Lights off');
  assert.doesNotMatch(rooms, /Manual|%|humidity/);
});

ok('House rooms: the bed hold reads "Someone in bed"', () => {
  const rooms = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupied: true, pres_labels: ['Bed occupied'], labels: ['Bed occupied'] } }), []), NOW);
  assert.equal(rowSub(rowOf(rooms, '/pulse-dashboard/room-bedroom')), 'Lights off · someone in bed');
});

ok('House rooms: all occupied gives eight occupied tiles and "8 occupied"', () => {
  const rooms = P.render('rooms', {}, withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), []), NOW);
  assert.match(rooms, /<span class="hm-tr">8 occupied<\/span>/);
  assert.equal(count(rooms, /style="background:#ff9f0a;color:#000000"/g), 8);
});

ok('House attention: one row per item with the room as title, the detail as subtitle and a glyph for the kind; rooms stay listed too', () => {
  const rooms = calmRooms({
    bathroom: { occupied: true, temp: 23.1, humidity: 88, lights_on: 1 },
    bedroom: { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'], temp: 20.8 },
  });
  const items = [attn('Bathroom', 'bathroom', 'warm_heating', '23.1° vs 18° target, heating on'), attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window while heating is on')];
  const hass = withRooms(rooms, items);
  const status = P.render('status', {}, hass, NOW);
  assert.match(status, /<h2 style="color:#f2b84b">Needs attention<\/h2>/);
  const bath = rowOf(status, '/pulse-dashboard/room-bathroom');
  const bed = rowOf(status, '/pulse-dashboard/room-bedroom');
  assert.equal(rowTitle(bath), 'Bathroom');
  assert.match(rowSub(bath), /23\.1° vs 18° target, heating on · 88% humidity, probably a shower/);
  assert.equal(rowSub(bed), 'Open window while heating is on');
  assert.equal(tileStyle(bed), 'background:#f2b84b;color:#000000');
  assert.ok(bed.includes(P.ICON.window), 'a window item gets the window glyph');
  assert.ok(bath.includes(P.ICON.flame), 'a temperature item gets the flame glyph');
  assert.ok(rowOf(status, '/pulse-dashboard/room-bedroom').includes('class="hm-chev"'));
  const html = P.render('rooms', {}, hass, NOW);
  assert.equal(count(html, /data-path="\/pulse-dashboard\/room-bathroom"/g), 1, 'still listed under Rooms, once');
  assert.equal(count(html, /data-path="\/pulse-dashboard\/room-bedroom"/g), 1);
  assert.ok(P.ICON.warn.length > 0);
  const odd = P.render('status', {}, withRooms(calmRooms(), [attn('Parlour', 'parlour', 'automation_disabled', 'Lights automation is off')]), NOW);
  assert.ok(rowOf(odd, '/pulse-dashboard/room-parlour').includes(P.ICON.warn), 'anything else gets the warning glyph');
  noNoise({ html, status }, 'attention house');
});

ok('House rooms: occupied rooms first and the rest in fixed order, for every occupied combination', () => {
  const keys = P.ROOM_ORDER;
  for (let occMask = 0; occMask < 256; occMask += 17) for (let attMask = 0; attMask < 256; attMask += 29) {
    const occupied = keys.filter((k, i) => occMask & (1 << i));
    const items = keys.filter((k, i) => attMask & (1 << i)).map((k) => attn(k, k, 'automation_disabled', 'Lights automation is off'));
    const html = P.render('rooms', {}, withRooms(keys.map((k) => quietRoom(k, { occupied: occupied.includes(k) })), items), NOW);
    assert.deepEqual(roomPaths(html), [...occupied, ...keys.filter((k) => !occupied.includes(k))], `mask ${occMask}/${attMask}`);
  }
});

ok('House rooms: the manual marker shows only while it exists', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T16:40:00+00:00', what: 'Wall button: scene cycled' };
  const on = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual, lights_on: 2 } }), []), NOW);
  assert.match(rowSub(rowOf(on, '/pulse-dashboard/room-parlour')), /manual change/);
  const none = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual: null } }), []), NOW);
  assert.doesNotMatch(none, /manual change/);
});

ok('House rooms: window and door holds read in the subtitle', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { occupied: true, heat_labels: ['Window open'] }, bedroom: { heat_labels: ['Window open'] }, hallway_downstairs: { heat_labels: ['Door open'] } }), []), NOW);
  assert.equal(count(html, /class="hm-rs">Lights off · window open</g), 2);
  assert.equal(count(html, /class="hm-rs">Lights off · door open</g), 1);
});

ok('recent action note stays a phrase with its verb (under 15 minutes) but only a scene change reaches the room subtitle', () => {
  const feedOf = (mins, decision = 'turn_off', sub = 'lighting', loc = 'kitchen') => histSensor(loc, [histEntry(mins, { location: loc, subsystem: sub, decision, reason: 'x', outcome: undefined })]);
  const hassOf = (mins, decision, s) => withRooms(calmRooms(), [], feedOf(mins, decision, s));
  assert.equal(P.recentNote(hassOf(7), 'kitchen', NOW), 'lights off 7 min ago');
  assert.equal(P.recentNote(hassOf(0.2), 'kitchen', NOW), 'lights off just now');
  assert.equal(P.recentNote(hassOf(15), 'kitchen', NOW), '');
  assert.equal(P.recentNote(hassOf(5, 'mystery_decision'), 'kitchen', NOW), '', 'unknown verb: no note rather than a bare duration');
  const sub = (mins, decision, s) => rowSub(rowOf(P.render('rooms', {}, hassOf(mins, decision, s), NOW), '/pulse-dashboard/room-kitchen'));
  for (const [mins, decision, s] of [[0.2], [7], [1, 'turn_on'], [3, 'set_mode', 'heating'], [15], [5, 'no_change'], [4, 'set_occupied', 'occupied'], [4, 'clear_occupied', 'occupied']]) assert.equal(sub(mins, decision, s), 'Lights off', `${decision} stays out of the subtitle`);
  // a scene change on a lit room reads "Cabinets · set 4 min ago"
  const lit = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { lights_on: 2 } }), [], { ...feedOf(4, 'activate_scene'), 'sensor.kitchen_active_scene': { state: 'kitchen_cabinets', attributes: {} } }), NOW);
  assert.equal(rowSub(rowOf(lit, '/pulse-dashboard/room-kitchen')), 'Cabinets · set 4 min ago');
  // a reason replaces the recency
  const held = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { lights_on: 2, occupied: true, pres_labels: ['Doors closed'] } }), [], { ...feedOf(4, 'activate_scene'), 'sensor.kitchen_active_scene': { state: 'kitchen_cabinets', attributes: {} } }), NOW);
  assert.equal(rowSub(rowOf(held, '/pulse-dashboard/room-kitchen')), 'Cabinets · doors closed');
  assert.equal(P.recentNote({ states: {} }, 'kitchen', NOW), '');
});

ok('House rooms: one lights state, at most one reason in priority order, never "marked"', () => {
  const scene = (k, name) => ({ [`sensor.${k}_active_scene`]: { state: `${k}_${name}`, attributes: {} } });
  const sub = (room, extra, k = 'bedroom') => rowSub(rowOf(P.render('rooms', {}, withRooms(calmRooms({ [k]: room }), [], extra), NOW), `/pulse-dashboard/room-${k}`));
  assert.equal(sub({ occupied: true, lights_on: 2, pres_labels: ['Bed occupied'] }, scene('bedroom', 'lamps')), 'Lamps · someone in bed');
  assert.equal(sub({ occupied: true, lights_on: 2, pres_labels: ['Doors closed'] }, scene('bedroom', 'full')), 'Full · doors closed');
  assert.equal(sub({ occupied: true, lights_on: 0, pres_labels: ['Sonos playing'] }), 'Lights off · Sonos playing');
  assert.equal(sub({ lights_on: 0 }), 'Lights off');
  // the priority table, strongest first: heating hold, bed, other presence, Sonos, doors, manual
  const everything = { occupied: true, lights_on: 0, heat_labels: ['Window open'], pres_labels: ['Doors closed', 'Sonos playing', 'Sofa occupied', 'Bed occupied'], manual: { source: 'wall_button', ts: '2026-10-25T16:40:00+00:00', what: 'x' } };
  const order = [['heat_labels', 'Lights off · window open'], ['Bed occupied', 'Lights off · someone in bed'], ['Sofa occupied', 'Lights off · sofa occupied'], ['Sonos playing', 'Lights off · Sonos playing'], ['Doors closed', 'Lights off · doors closed'], ['manual', 'Lights off · manual change']];
  let room = { ...everything };
  for (const [drop, expected] of order) {
    assert.equal(sub(room), expected);
    room = drop === 'heat_labels' ? { ...room, heat_labels: [] } : drop === 'manual' ? { ...room, manual: null } : { ...room, pres_labels: room.pres_labels.filter((l) => l !== drop) };
  }
  assert.equal(sub(room), 'Lights off');
  // a recent occupancy action never shows, with or without a reason
  const marked = histSensor('kitchen', [histEntry(3, { subsystem: 'occupied', decision: 'set_occupied', reason: 'motion_detected', outcome: undefined })]);
  for (const room of [{ lights_on: 0 }, { occupied: true, lights_on: 0, pres_labels: ['Doors closed'] }]) {
    const html = P.render('rooms', {}, withRooms(calmRooms({ kitchen: room }), [], marked), NOW);
    for (const m of html.matchAll(/class="hm-rs"[^>]*>([^<]*)</g)) assert.doesNotMatch(m[1], /marked|\d+ min|just now/i);
  }
  // the upstairs hallway has no temperature sensor: the note is kept when nothing else fills the line
  assert.equal(sub({ lights_on: 0 }, {}, 'hallway_upstairs'), 'Lights off · no temperature sensor');
});

ok('House rooms: unavailable occupancy shows an attention glyph; rooms with no report say so; rows are 60px links', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupancy_unavailable: true } }), []), NOW);
  assert.equal(tileStyle(rowOf(html, '/pulse-dashboard/room-bedroom')), 'background:#2c2c2e;color:#f2b84b');
  const missing = P.render('rooms', {}, mk(), NOW);
  const roomsOnly = missing.slice(0, missing.indexOf('<h2>Outside'));
  assert.equal(count(roomsOnly, /class="hm-rs">No report/g), 8);
  assert.equal(count(roomsOnly, /class="hm-val num">–</g), 7, 'seven rooms with a climate sensor show a dash; the climate-less hallway shows no value');
  assert.match(P.STYLE, /\.hm-row\{[^}]*min-height:60px/);
  assert.match(P.STYLE, /\.hm-tile\{width:30px;height:30px;border-radius:8px/);
});

ok('House electricity widget: one link to the Energy page with the price, next half hour, chart and cheapest window', () => {
  const html = P.render('status', {}, mk(), NOW);
  assert.equal(P.ENERGY_PATH, '/pulse-dashboard/energy');
  const link = html.match(/<a class="hm-card hm-elec tap" data-act="nav" data-path="\/pulse-dashboard\/energy" aria-label="Open energy details">[\s\S]*?<\/a>/);
  assert.ok(link, 'the widget is one link');
  for (const word of ['>Electricity<', 'hm-price num', '<small>p</small>', 'Next 41.2p', 'Cheapest 2 hours']) assert.ok(link[0].includes(word), word);
  assert.equal(count(html, /data-path="\/pulse-dashboard\/energy"/g), 1);
  assert.doesNotMatch(html, /data-chart|<rect|Tomorrow's rates/);
  assert.match(P.STYLE, /\.hm-card\{[^}]*border-radius:20px;padding:16px/);
  assert.match(P.STYLE, /\.hm-price\{font-size:40px/);
  assert.doesNotMatch(P.render('energy-head', {}, mk(), NOW), /Open energy details/);
  const viewPaths = readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path);
  assert.ok(viewPaths.includes('energy'), 'the linked view exists');
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-energy\.yaml/);
  assert.throws(() => P.render('energy', {}, mk(), NOW), /unknown mode/);
});

ok('House electricity widget: a mini chart of the next 9 half-hour slots, current slot highlighted, hidden from assistive tech', () => {
  const at = Date.parse('2026-10-25T18:29:00Z');
  const RATES = 'event.octopus_energy_electricity_24e8140196_1012483035417';
  const hass = mk({ [`${RATES}_current_day_rates`]: { state: 'x', attributes: { rates: real } } });
  const html = P.render('status', {}, hass, at);
  const bars = html.match(/<div class="hm-bars" aria-hidden="true">([\s\S]*?)<\/div>/)[1];
  const each = [...bars.matchAll(/<span class="hm-bar( now)?" style="height:(\d+)px;background:(#[0-9a-f]{6})"><\/span>/g)];
  assert.equal(each.length, 9);
  assert.equal(count(bars, / now"/g), 1);
  assert.equal(each[0][1], ' now', 'the current slot leads');
  const slots = P.rateBands(real, at).filter((s) => s.state !== 'past').slice(0, 9);
  each.forEach((m, i) => assert.equal(m[3], P.priceColour(slots[i].v), `bar ${i} colour`));
  for (const m of each) assert.ok(+m[2] >= 4 && +m[2] <= 44, `bar height ${m[2]}`);
  // from a zero baseline: height is price against the dearest shown slot, so the cheapest slot is not a dot
  const hi = Math.max(...slots.map((x) => x.v));
  each.forEach((m, i) => assert.equal(+m[2], Math.round(Math.max(4, (slots[i].v / hi) * 44)), `bar ${i} height is price / max`));
  assert.match(P.STYLE, /\.hm-bar\{[^}]*opacity:\.55\}/);
  assert.match(P.STYLE, /\.hm-bar\.now\{opacity:1\}/, 'the current slot is full strength');
  assert.doesNotMatch(P.STYLE, /\.hm-bar[^{]*\{[^}]*box-shadow/, 'no ring round the current slot');
  // the last slots of today are followed by tomorrow's
  const withTomorrow = mk({ [`${RATES}_current_day_rates`]: { state: 'x', attributes: { rates: real } }, [`${RATES}_next_day_rates`]: { state: 'x', attributes: { rates: mkSlots(48, '2026-10-26T00:00:00Z', (i) => 10 + i) } } });
  const late = P.render('status', {}, withTomorrow, Date.parse('2026-10-25T23:10:00Z'));
  assert.equal(count(late.match(/<div class="hm-bars"[\s\S]*?<\/div>/)[0], /class="hm-bar[ "]/g), 9);
  assert.doesNotMatch(P.render('status', {}, mk(), NOW), /hm-bars/, 'no rates, no chart');
  const flat = P.render('status', {}, mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates: mkSlots(4, '2026-10-25T18:00:00Z', () => 20) } } }), at);
  assert.equal(count(flat, /height:44px/g), 4, 'equal prices share one full-height bar');
  const neg = P.render('status', {}, mk({ [`${RATES}_current_day_rates`]: { state: 'x', attributes: { rates: mkSlots(3, '2026-10-25T18:00:00Z', (i) => [-5, 0, 20][i]) } } }), at);
  assert.deepEqual([...neg.matchAll(/class="hm-bar[ "][^>]*height:(\d+)px/g)].map((m) => +m[1]), [4, 4, 44], 'zero and negative prices keep a stub; negative keeps its colour');
});

ok('Activity rows: the sentence is 15px/20px with the subject semibold, so a typical sentence fits one line', () => {
  assert.match(P.STYLE, /\.tl-b\{font-size:15px;line-height:20px/);
  assert.match(P.STYLE, /\.tl-s\{font-weight:600\}/);
});

ok('House feed limited to 3 rows, repeats collapse', () => {
  const e = (i, over) => histEntry(i, over);
  const entries = [e(1, { location: 'bathroom' }), e(2, { location: 'bathroom' }), e(3, { location: 'kitchen', decision: 'turn_on', reason: 'occupancy_on' }), e(4, { location: 'hallway_downstairs' }), e(5, { location: 'home_office' })];
  const html = P.render('feed', {}, mk(histSensor('house', entries)), NOW);
  assert.equal(count(html, /class="tl-row /g), 3);
  assert.match(html, /<span class="tl-n">x2<\/span>/);
  assert.doesNotMatch(html, /Home office/);
});

ok('House view layout: header, status, rooms, house list, feed, tab bar; no old modes', () => {
  const v = yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8'));
  const modes = v.sections[0].cards.map((c) => c.mode);
  assert.deepEqual(modes, ['now-header', 'status', 'rooms', 'house-list', 'feed', 'tabbar']);
  for (const m of modes) assert.ok(P.render(m, {}, mk(), NOW) !== undefined);
  for (const old of ['attention', 'bins', 'bins-heating', 'cameras-card', 'energy-foot', 'energy']) assert.throws(() => P.render(old, {}, mk(), NOW), /unknown mode/, old);
});

ok('Now v2 changes nothing HA only reads at startup', () => {
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card-loader\.js/);
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
  assert.equal(count(t, />Free power</g), 1, 'one negative run, not a scrambled list');
  assert.match(t, /Free power<\/div><div class="m">23:00 → 14:30<\/div>[\s\S]*?avg −\d/); // TZ=UTC here; London shows 00:00 → 14:30 (child-process test)
  assert.match(t, /Cheap<\/div><div class="m">/);
  assert.equal(count(t, /→ 01:00/g), 0);
  const m = P.render('energy-day', {}, hass, NOW, { day: 'tomorrow' });
  assert.ok(/Free power<\/div><div class="m">none/.test(m) || /Free power<\/div><div class="m">\d\d:\d\d → \d\d:\d\d/.test(m));
  const e = P.render('energy-day', {}, energyHass({}, real, []), NOW, { day: 'tomorrow' });
  assert.doesNotMatch(e, />Free power<|>Cheap</);
  const quiet = day('2026-03-02T00:00:00Z', 48);
  const q = P.render('energy-day', {}, energyHass({}, quiet, quiet), Date.parse('2026-03-02T12:00:00Z'), {});
  assert.match(q, /Free power<\/div><div class="m">none/);
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

ok('energy page: head has the title (no back link), Now/Next/Usage', () => {
  const html = P.render('energy-head', {}, energyHass({ 'sensor.glow_electricity_power': { state: '0.44', attributes: { unit_of_measurement: 'kW' }, last_updated: '2026-10-25T18:41:50+00:00' } }), NOW);
  assert.doesNotMatch(html, /Back to House/);
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
  assert.deepEqual(v.sections[0].cards.map((c) => c.mode), ['energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage', 'tabbar']);
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-energy\.yaml/);
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card-loader\.js/);
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
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
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
ok('the occupancy row on every room page says Occupied or Empty; no bed icon anywhere on the page', () => {
  const bed = 'M4 20v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M4 16h16M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3';
  for (const k of P.ROOM_ORDER) {
    const hass = withRooms(P.ROOM_ORDER.map((x) => quietRoom(x, { occupied: true, pres_labels: ['Bed occupied'], labels: ['Bed occupied'] })), []);
    assert.match(P.render('presence', { room: k }, hass, NOW), /<h2>Presence<\/h2>[\s\S]*?<div class="hm-rt">Occupied<\/div>/, k);
    assert.ok(!whyAll({ room: k }, hass, NOW).includes(bed), `${k}: no bed icon`);
  }
  const rows = P.render('presence', { room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: true } }), []), NOW);
  assert.equal(count(rows, /class="hm-row/g), 1, 'the occupancy row alone (no override helper in this fixture)');
  assert.match(rows, /Occupied<\/div>/);
});

ok('Presence row: no trailing value when nothing holds the room; a short hold label when something does', () => {
  const pres = (over) => P.render('presence', { room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: true, ...over } }), []), NOW);
  const free = pres({});
  assert.match(free, /No holds · empty a few minutes after the last movement/);
  assert.doesNotMatch(free, /hm-val|Clear/, 'no status word that reads like a button');
  const bed = pres({ pres_labels: ['Bed occupied'], labels: ['Bed occupied'] });
  assert.match(bed, /<span class="hm-val num">Bed<\/span>/);
  assert.match(pres({ pres_labels: ['Doors closed'], labels: ['Doors closed'] }), /<span class="hm-val num">Doors<\/span>/);
  assert.match(pres({ pres_labels: ['Monitor on'], labels: ['Monitor on'] }), /<span class="hm-val num">Monitor on<\/span>/, 'a hold without a short word shows its own label');
  assert.match(pres({ pres_labels: ['Bed occupied', 'Doors closed'] }), /<span class="hm-val num">Bed \+1<\/span>/);
  assert.doesNotMatch(P.render('presence', { room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: false } }), []), NOW), /hm-val|Clear/, 'an empty room with no holds is quiet too');
});

ok('undeclared decisions are worded from one table by sentenceFor, with a prettified fallback', () => {
  const und = (decision, reason, over = {}) => ({ ...histEntry(1), outcome: undefined, subsystem: 'heating', decision, reason, ...over });
  const say = (e) => P.sentenceFor(e, mk()).text;
  assert.equal(say(und('set_mode', 'house_mode_away')), 'Heating mode changed · house away');
  assert.equal(say(und('set_mode', 'brand_new_reason')), 'Heating mode changed · brand new reason', 'an unknown reason is prettified, never blank or thrown');
  assert.equal(say(und('turn_on', 'occupancy_on', { subsystem: 'lighting' })), 'Lights turned on · room occupied');
  assert.equal(say(und('mystery_move', '', { subsystem: 'wfh_inference' })), 'Wfh inference mystery move');
  assert.equal(say(und('constructor', 'toString')), 'Heating constructor · toString', 'slugs cannot reach into object prototypes');
  assert.equal(P.sentenceFor(und('turn_on', 'x'), mk()).tone, 'ok');
  const feed = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'bedroom', subsystem: 'heating', decision: 'set_mode', reason: 'safety_window_open', outcome: undefined })])), NOW);
  assert.match(feed, /<b class="tl-s">Bedroom<\/b> heating mode changed<span style="color:#a3adba"> · window open<\/span>/);
});

ok('media players are labelled by device role from the room config, not the entity name', () => {
  const html = P.render('media', { room: 'parlour' }, mk({ 'media_player.parlour': { state: 'playing', attributes: { friendly_name: 'Parlour', volume_level: 0.3 } }, 'media_player.parlour_tv': { state: 'off', attributes: { friendly_name: 'Bravia KD-55' } } }), NOW);
  assert.match(html, /<div class="hm-rt">Soundbar<\/div>/);
  assert.match(html, /<div class="hm-rt">TV<\/div>/);
  assert.doesNotMatch(html, /<div class="hm-rt">Parlour<\/div>|Bravia/);
  assert.match(P.render('media', { room: 'kitchen' }, mk({ 'media_player.kitchen': { state: 'idle', attributes: { friendly_name: 'Kitchen' } } }), NOW), /Kitchen speaker/);
});

ok('held-occupied wording has no redundancy', () => {
  const m = quietRoom('parlour', { occupied: true, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], lights_on: 2 });
  const hass = withRooms([m], []);
  const why = whyAll({ room: 'parlour' }, hass, NOW);
  assert.match(why, /<div class="hm-rs">Sofa occupied · empty a few minutes after it clears<\/div>/);
  assert.doesNotMatch(why, /Held occupied|Held by|occupied by Sofa occupied|1 reason/);
  const head = P.render('room-head', { room: 'parlour' }, hass, NOW);
  assert.match(head, /Occupied · Lamps on/);
  assert.doesNotMatch(head, /Occupied \(/);
  assert.doesNotMatch(head, /held occupied/i);
  assert.equal(rowSub(rowOf(P.render('rooms', {}, withRooms([m], []), NOW), '/pulse-dashboard/room-parlour')), 'Lamps · sofa occupied');
  const fact = (over) => P.verdictFor({ ...P.roomModel(withRooms([quietRoom('parlour', over)], []), 'parlour') }, '');
  assert.equal(fact({ occupied: true, lights_on: 2, pres_labels: ['Monitor on'] }), 'Occupied (Monitor on) · lights on', 'a hold that does not say occupied folds into the first clause');
  assert.equal(fact({ occupied: true, lights_on: 0, pres_labels: ['Bed occupied'] }), 'Occupied · lights off', 'a hold that already says occupied adds nothing');
  assert.equal(fact({ occupied: false, lights_on: 0, pres_labels: ['Monitor on'] }), 'Empty · lights off · held occupied · Monitor on');
  assert.equal(fact({ occupancy_unavailable: true, lights_on: 1 }), 'Occupancy unavailable · lights on');
  assert.equal(fact({ occupied: true, lights_on: 1, target: 5, target_reason: 'window open' }), 'Occupied · lights on · heating target 5.0° (window open)');
  assert.equal(fact({ occupied: true, lights_on: 1, heat_labels: ['Window open'], override_text: 'Override on' }), 'Occupied · lights on · heating suspended: window open · Override on');
});

// ── House page header, attention and tab bar (native list design) ────────────────────────────────
const NOW_MODES = ['now-header', 'status', 'rooms', 'house-list', 'feed'];
const nowPage = (hass) => NOW_MODES.map((m) => P.render(m, {}, hass, NOW)).join('\n');

ok('House header: large title, mode and occupancy line, two avatars with presence dots, the Mo line; no Pulse title, pill or chips', () => {
  const hdr = P.render('now-header', {}, withRooms(calmRooms({ parlour: { occupied: true }, kitchen: { occupied: true } }), []), NOW);
  assert.match(hdr, /<h1 class="hm-big">Home<\/h1>/);
  assert.match(hdr, />At home<\/a>/);
  assert.doesNotMatch(hdr, /occupied/, 'the occupied count is said once, on the Rooms header');
  assert.doesNotMatch(hdr, />Pulse<|class="tag|class="chip|● /);
  assert.equal(count(hdr, /<a /g), 1, 'the mode line is the only link in the header');
  assert.match(hdr, /data-path="\/pulse-dashboard\/settings" aria-label="Open settings"/);
  const avatars = [...hdr.matchAll(/<span class="hm-av" role="img" aria-label="([^"]*)">(\w)<span class="hm-pd" style="background:(#[0-9a-f]{6})"><\/span><\/span>/g)].map((m) => m.slice(1));
  assert.deepEqual(avatars, [['Adam, home', 'A', '#30d158'], ['Sarah, away', 'S', '#48484a']], 'initials, label and dot colour per presence');
  assert.match(hdr, /<div class="hm-mo">Mo<\/div>/);
  const away = P.render('now-header', {}, mk({ 'person.adam': { state: 'unknown', attributes: {} } }), NOW);
  assert.match(away, /aria-label="Adam, unknown"/);
  assert.match(P.render('now-header', {}, mk({ 'sensor.house_active_mode': { state: 'vacation', attributes: {} } }), NOW), />On holiday<\/a>/);
  assert.match(P.render('now-header', {}, mk({ 'input_select.house_active_mode_modifier': { state: 'guest', attributes: {} } }), NOW), />At home · Guest<\/a>/);
  // avatars sit side by side with a gap, each dot on its own avatar's bottom-right with a ring in the page colour
  assert.match(P.STYLE, /\.hm-avs\{[^}]*gap:6px/);
  assert.doesNotMatch(P.STYLE, /\.hm-av\+\.hm-av/, 'no overlap');
  assert.match(P.STYLE, /\.hm-av\{[^}]*position:relative/);
  assert.match(P.STYLE, /\.hm-pd\{[^}]*position:absolute;right:-2px;bottom:-2px;[^}]*box-shadow:0 0 0 2px #12151a/);
  assert.match(P.STYLE, /\.hm-av\{[^}]*width:36px;height:36px;border-radius:50%;background:#232a33;border:2px solid #12151a/);
  assert.match(P.STYLE, /\.hm-pd\{[^}]*width:10px;height:10px/);
  for (const hass of [mk(), withRooms(calmRooms(), []), withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), [attn('Bedroom', 'bedroom', 'automation_disabled', 't')]), { states: {} }]) assert.doesNotMatch(nowPage(hass), /Updated/);
  assert.equal(count(nowPage(mk()), /data-path="\/mobile-dashboard"/g), 0);
  assert.doesNotMatch(P.render('tabbar', { active: 'house' }, mk(), NOW, {}), /mobile-dashboard|Controls/);
});

ok('House header: the Mo line keeps its content (last meal, shortened), unchanged from the old chip', () => {
  const worst = P.render('now-header', {}, mk({ 'sensor.mo_timeline': { state: 'x', attributes: { eating: [{ ts: Date.parse('2026-10-24T18:05:00Z') }] } } }), NOW);
  assert.match(worst, /<div class="hm-mo">Mo · ate yest 18:05<\/div>/);
  assert.doesNotMatch(worst, /yesterday/);
  assert.match(P.STYLE, /\.hm-mo\{[^}]*color:#a3adba/);
});

ok('House type scale: 34/41 title, 20 bold sentence-case section headers, 17 row titles, 14 subtitles, 13 footnote; rounded tabular numerals; no uppercase labels', () => {
  const css = P.STYLE;
  assert.match(css, /\.hm-big\{[^}]*font-size:34px;line-height:41px;font-weight:700/);
  assert.match(css, /\.hm-h h2\{[^}]*font-size:20px[^}]*font-weight:700/);
  assert.match(css, /\.hm-rt\{font-size:17px/);
  assert.match(css, /\.hm-rs\{font-size:14px;line-height:19px;color:#a3adba/);
  assert.match(css, /\.hm-foot\{[^}]*font-size:13px/);
  assert.match(css, /\.hm \.num,\.hm-price,\.hm-val\{font-family:ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums\}/);
  assert.match(css, /\.hm\{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif/);
  const hm = css.split('\n').filter((l) => /^\.hm/.test(l)).join('\n');
  assert.doesNotMatch(hm, /uppercase|letter-spacing:\.[4-9]/);
  const page = nowPage(withRooms(calmRooms(), [attn('Bedroom', 'bedroom', 'automation_disabled', 'x')]));
  assert.doesNotMatch(page, /class="lbl"|text-transform/, 'the House page uses no uppercase label');
  assert.doesNotMatch(css.split('\n').filter((l) => /^\.hm/.test(l)).join('\n'), /textTertiary|#8f9aa8/);
  const sections = [...page.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['Needs attention', 'Rooms', 'Outside', 'House', 'Activity']);
});

ok('House spacing: one 36px gap above every section and widget, whichever card it lives in (markup/CSS only, no browser)', () => {
  const css = P.STYLE;
  // inside a card: every block after the first is 36px below the one before; header to list is 8px
  assert.match(css, /\.hm>\*\+\*\{margin-top:36px\}/);
  assert.match(css, /\.hm-sec\{[^}]*gap:8px/);
  // between cards: HA's grid adds its row gap (--row-gap, 8px unset), so the card's own margin is 36px less that, never negative
  assert.match(css, /\.hm\{[^}]*margin-top:max\(0px,calc\(36px - var\(--row-gap,8px\)\)\)/);
  assert.match(css, /\.hm\.hm-first\{margin-top:0\}/);
  assert.doesNotMatch(css, /\.hm\{[^}]*\bgap:/, 'no other gap between blocks');
  // every section header is a direct child block of its card, so the rule above reaches all five
  const page = nowPage(withRooms(calmRooms({ bathroom: { occupied: true } }), [attn('Bathroom', 'bathroom', 'warm_heating', 'x')], histSensor('house', [histEntry(1)])));
  assert.equal(count(page, /<section class="hm-sec"><div class="hm-h">/g), 5);
  assert.equal(count(page, /<div class="hm hm-first">/g), 1, 'only the title card has no top margin');
  assert.equal(count(page, /<div class="hm">/g), 4);
});

ok('House list: inset grouped list, rows 60px with a 30px tile, hairline starting at the text column, whole row a link', () => {
  const css = P.STYLE;
  assert.doesNotMatch(css.match(/\.hm\{[^}]*\}/)[0], /padding/, 'no side margin on lists or widgets: HA view padding is the inset');
  assert.match(css, /\.hm-h\{[^}]*padding:0 4px/, 'headers sit 4px in from the list edge');
  assert.match(css, /\.hm-top\{[^}]*padding:0 4px/);
  assert.match(css, /\.hm-mo\{padding:0 4px/);
  assert.match(css, /\.hm-list\{background:#1a1f26;border-radius:12px/);
  assert.match(css, /\.hm-row\{[^}]*gap:12px;min-height:60px;padding:0 14px/);
  assert.match(css, /\.hm-row\+\.hm-row::before\{[^}]*left:56px[^}]*height:\.5px;background:#232a33/, '14 + 30 + 12: the hairline starts at the text column');
  assert.match(css, /\.hm-chev\{[^}]*width:14px;color:#5a626d/);
  const page = nowPage(withRooms(calmRooms(), []));
  for (const row of page.match(/<a class="hm-row tap"[^>]*>/g)) assert.match(row, /data-act="nav" data-path="\/pulse-dashboard\//);
  assert.equal(count(page, /<a class="hm-row tap"/g) > 10, true);
  assert.doesNotMatch(page, /<div class="hm-row"[^>]*data-act/, 'a row that navigates is an <a>');
  assert.match(page, /<svg [^>]*aria-hidden="true"/);
  assert.doesNotMatch(page.replace(/<svg[\s\S]*?<\/svg>/g, ''), /<svg/);
});

ok('House attention: no section when calm, a footnote when the report is missing, never an all-good state', () => {
  const calm = nowPage(withRooms(calmRooms(), []));
  assert.doesNotMatch(calm, /Needs attention|card pad warn|All good/);
  assert.match(P.render('status', {}, { states: {} }, NOW), /<p class="hm-foot">No attention report<\/p>/);
  assert.doesNotMatch(P.render('status', {}, withRooms(calmRooms(), []), NOW), /No attention report/);
  assert.match(P.STYLE, /\.hm-foot\{[^}]*color:#a3adba/);
});

ok('attention rows say which way a temperature is off: the detail is the subtitle, steamy adds the humidity', () => {
  const cold = withRooms(calmRooms({ bedroom: { occupied: true, temp: 17.2, target: 19 } }), [attn('Bedroom', 'bedroom', 'cold_not_heating', '17.2° vs 19° target, heating not on')]);
  assert.equal(rowSub(rowOf(P.render('status', {}, cold, NOW), '/pulse-dashboard/room-bedroom')), '17.2° vs 19° target, heating not on');
  const warm = withRooms(calmRooms({ bedroom: { occupied: true, temp: 21.4, target: 19, humidity: 50 } }), [attn('Bedroom', 'bedroom', 'warm_heating', '21.4° vs 19° target, heating on')]);
  assert.doesNotMatch(P.render('status', {}, warm, NOW), /probably a shower/);
  const steamy = withRooms(calmRooms({ bathroom: { occupied: true, temp: 23.1, target: 18, humidity: 88, lights_on: 1 } }), [attn('Bathroom', 'bathroom', 'warm_heating', '23.1° vs 18° target, heating on')]);
  assert.equal(rowSub(rowOf(P.render('status', {}, steamy, NOW), '/pulse-dashboard/room-bathroom')), '23.1° vs 18° target, heating on · 88% humidity, probably a shower');
  // The room page banner still carries the label.
  assert.match(P.render('room-head', { room: 'bathroom' }, steamy, NOW), /Steamy/);
  assert.match(P.render('room-head', { room: 'bedroom' }, cold, NOW), /Too cold, heating off/);
  const stale = withRooms(calmRooms({ bedroom: { occupied: true } }), [attn('Bedroom', 'bedroom', 'sensor_stale', 'climate.bedroom_trv: no update for 5 h 12 min')]);
  assert.equal(rowSub(rowOf(P.render('status', {}, stale, NOW), '/pulse-dashboard/room-bedroom')), 'climate.bedroom_trv: no update for 5 h 12 min');
  assert.match(P.render('room-head', { room: 'bedroom' }, stale, NOW), /Sensor not updating/);
  for (const [kind, label] of [['window_open_heating_on', 'Window open, heating on'], ['automation_disabled', 'Automation is off'], ['hold_active', 'Override on'], ['sensor_unavailable', 'Sensor unavailable']]) {
    const h = withRooms(calmRooms({ bedroom: { occupied: true } }), [attn('Bedroom', 'bedroom', kind, 'detail text')]);
    assert.equal(rowSub(rowOf(P.render('status', {}, h, NOW), '/pulse-dashboard/room-bedroom')), 'detail text');
    assert.match(P.render('room-head', { room: 'bedroom' }, h, NOW), new RegExp(label));
  }
  const bare = withRooms(calmRooms(), [attn('Bedroom', 'bedroom', 'hold_active', '')]);
  assert.equal(rowSub(rowOf(P.render('status', {}, bare, NOW), '/pulse-dashboard/room-bedroom')), 'Override on', 'no detail: the label is the subtitle');
});

ok('House sparse and missing data: every House mode renders cleanly', () => {
  for (const hass of [{ states: {} }, mk(), withRooms(P.ROOM_ORDER.map((k) => ({ k })), [{}]), withRooms('junk', 'junk'), withRooms(P.ROOM_ORDER.map((k) => ({ k, temp: null, manual: 'x', labels: 7 })), [])]) {
    const page = nowPage(hass);
    assert.doesNotMatch(page, NOISE);
    assert.doesNotMatch(page, /Updated/);
  }
});

ok('House rooms: a room with a climate sensor and no reading keeps a dash; one without shows no value and says so', () => {
  const quiet = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { temp: null, humidity: null }, kitchen: { temp: null } }), []), NOW);
  const up = rowOf(quiet, '/pulse-dashboard/room-hallway_upstairs');
  assert.equal(rowValue(up), undefined);
  assert.equal(rowSub(up), 'Lights off · no temperature sensor');
  assert.equal(rowValue(rowOf(quiet, '/pulse-dashboard/room-kitchen')), '–');
  const occ = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { occupied: true, temp: null } }), []), NOW);
  assert.equal(rowValue(rowOf(occ, '/pulse-dashboard/room-hallway_upstairs')), undefined);
  assert.equal(roomPaths(occ)[0], 'hallway_upstairs');
});

ok('status attention: each row links to its own room, a room-less item opens House; +N more opens the first room not already shown', () => {
  const items = [attn('Parlour', 'parlour', 'automation_disabled', 'a'), attn('Kitchen', 'kitchen', 'automation_disabled', 'b'), attn('Bedroom', 'bedroom', 'automation_disabled', 'c'), attn('Bedroom', 'bedroom', 'hold_active', 'd'), attn('Bathroom', 'bathroom', 'hold_active', 'e')];
  const status = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), items), NOW);
  const rows = [...status.matchAll(/<a class="hm-row tap" data-act="nav" data-path="([^"]*)"[\s\S]*?<\/a>/g)].map((m) => [m[1], m[0]]);
  assert.deepEqual(rows.slice(0, 3).map((r) => r[0]), ['/pulse-dashboard/room-parlour', '/pulse-dashboard/room-kitchen', '/pulse-dashboard/room-bedroom']);
  const more = rows[3];
  assert.match(more[1], /hm-rt">\+2 more</);
  assert.equal(more[0], '/pulse-dashboard/room-bathroom', 'the first hidden room not already listed');
  const same = [attn('Parlour', 'parlour', 'automation_disabled', 'a'), attn('Kitchen', 'kitchen', 'automation_disabled', 'b'), attn('Bedroom', 'bedroom', 'automation_disabled', 'c'), attn('Bedroom', 'bedroom', 'hold_active', 'd'), attn('Bedroom', 'bedroom', 'motion_disabled', 'e')];
  const s2 = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), same), NOW);
  assert.match(s2, /data-path="\/pulse-dashboard\/room-bedroom"[^>]*>(?:(?!<\/a>)[\s\S])*\+2 more/);
  const none = [attn('A', 'parlour', 'x', 'a'), attn('B', 'kitchen', 'x', 'b'), attn('C', 'bedroom', 'x', 'c'), attn('Pulse', '', 'unexplained_reason', 'd')];
  assert.match(P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), none), NOW), /data-path="\/pulse-dashboard\/house"[^>]*>(?:(?!<\/a>)[\s\S])*\+1 more/);
});

// ── Tab bar ────────────────────────────────────────────────────────────────────────────────────
const SNAP = (over = {}) => ({ name: 'div', transform: 'none', filter: 'none', perspective: 'none', contain: 'none', willChange: 'auto', backdropFilter: 'none', ...over });

ok('tab bar renders four tabs, one per id, with aria-current on the active one only', () => {
  for (const [active, label] of [['house', 'Home'], ['energy', 'Energy'], ['cameras', 'Cameras'], ['settings', 'Settings']]) {
    const html = P.render('tabbar', { active }, mk(), NOW, {});
    assert.match(html, /<nav class="tabs" aria-label="Pulse">/);
    assert.equal(count(html, /<button type="button" class="tab"/g), 4);
    assert.equal(count(html, /aria-current="page"/g), 1);
    assert.match(html, new RegExp(`aria-current="page">[\\s\\S]*?<span>${label}</span>`));
    for (const t of ['Home', 'Energy', 'Cameras', 'Settings']) assert.match(html, new RegExp(`<span>${t}</span>`));
    assert.equal(count(html, /<svg /g), 4, 'inline SVG icons');
    noNoise({ html }, 'tabbar');
  }
  assert.match(P.render('tabbar', { active: 'bogus' }, mk(), NOW, {}), /aria-current="page">[\s\S]*?<span>Home<\/span>/, 'unknown active falls back to Home');
  for (const cfg of [undefined, null, {}, { active: 5 }]) assert.doesNotMatch(P.render('tabbar', cfg, mk(), NOW, undefined), NOISE);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.tab\{[^\n]*font-size:10px[^\n]*min-height:44px/);
  assert.match(css, /\.tab\[aria-current=page\]\{color:\$\{TOKENS\.tint\}\}/);
  assert.match(css, /\.tabs\{[^\n]*\$\{TOKENS\.tabBar\}[^\n]*backdrop-filter:blur\(20px\);border-top:\.5px solid \$\{TOKENS\.separator\}/);
  const bar = P.render('tabbar', { active: 'energy' }, mk(), NOW, {});
  assert.equal(count(bar, /width="26" height="26"/g), 4, '26px icons');
  assert.equal(count(bar, /<svg [^>]*fill="currentColor"/g), 1, 'only the selected tab is a filled icon');
  assert.match(bar, /aria-current="page"><svg [^>]*fill="currentColor"/);
  assert.equal(Raw.THEMES.classic.tint, '#f2c46b');
  assert.equal(Raw.THEMES.classic.textTertiary, '#8f9aa8');
  assert.equal(Raw.THEMES.classic.tabBar, 'rgba(18,21,26,.82)');
});

ok('tab bar nav paths use the DASH constant and match real views', () => {
  const html = P.render('tabbar', { active: 'house' }, mk(), NOW, {});
  const paths = [...html.matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['/pulse-dashboard/house', '/pulse-dashboard/energy', '/pulse-dashboard/cameras', '/pulse-dashboard/settings']);
  const viewPaths = readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path);
  for (const p of paths) { assert.ok(p.startsWith(P.DASH + '/'), p); assert.ok(viewPaths.includes(p.slice(P.DASH.length + 1)), p); }
  assert.ok(P.TABS.every((t) => t.path.startsWith(P.DASH)));
});

ok('all Pulse views are normal views; room and garden views are hidden from the tab strip (visible: false), still reachable by path', () => {
  const load = (f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8'));
  for (const f of ['info-house', 'info-energy', 'info-cameras', 'info-settings']) {
    const v = load(f + '.yaml');
    assert.ok(!('subview' in v), `${f} must not be a subview`);
    assert.ok(!('back_path' in v), `${f} must not have a back_path`);
    assert.ok(!('visible' in v), `${f} stays in the tab strip`);
  }
  const rooms = readdirSync(root + 'views').filter((x) => x.startsWith('info-room-'));
  assert.equal(rooms.length, P.ALL_ROOM_KEYS.length);
  for (const f of rooms) {
    const v = load(f);
    assert.strictEqual(v.visible, false, f);
    assert.ok(!('subview' in v), `${f} must not be a subview`);
    assert.ok(!('back_path' in v), `${f} must not have a back_path`);
    assert.match(v.path, /^room-[a-z_]+$/, f);
  }
});

ok('tab pages render a title and no back link; the heading is the only title (HA shows tabs, not a view title)', () => {
  for (const [mode, name] of [['energy-head', 'Energy'], ['house-head', 'Settings'], ['cameras-head', 'Cameras']]) {
    const html = P.render(mode, {}, mk(), NOW, {});
    assert.doesNotMatch(html, /Back to House|data-act="nav"/, mode);
    assert.equal(html.split(`>${name}</div>`).length - 1, 1, `${mode}: exactly one visible title`);
  }
});

ok('no headerOverlap workaround is left in the card', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /headerOverlap|headPad|MAX_HEADER_OVERLAP|_headerProbe|_hpTimers|_huiRoot/);
  assert.equal(P.headerOverlap, undefined);
  assert.equal(P.headPadStyle, undefined);
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
  const inflow = P.render('tabbar', { active: 'house' }, mk(), NOW, {});
  const inflow2 = P.render('tabbar', { active: 'house' }, mk(), NOW, { tb: 'inflow' });
  assert.equal(inflow, inflow2);
  assert.doesNotMatch(inflow, /tabbar-spacer|class="tabs fixed"/);
  const fixed = P.render('tabbar', { active: 'house' }, mk(), NOW, { tb: 'fixed' });
  assert.match(fixed, /<div class="tabbar-spacer" style="--tbh:calc\(49px \+ max\(34px, env\(safe-area-inset-bottom, 0px\)\)\)" aria-hidden="true"><\/div>/);
  assert.match(fixed, /<nav class="tabs fixed" aria-label="Pulse">/);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const barH = P.STYLE.match(/\.tabs\{--tbh:(calc\([^;]*\));/)[1];
  const spacerH = fixed.match(/--tbh:(calc\(.*?\))" aria-hidden/)[1];
  assert.equal(spacerH, barH, 'spacer height equals bar height');
  assert.match(src, /\.tabs\{[^\n]*height:var\(--tbh\)/);
  assert.match(src, /\.tabbar-spacer\{height:var\(--tbh\)\}/);
  assert.match(src, /\.tabs\.fixed\{position:fixed;left:0;right:0;bottom:0;z-index:100\}/);
  assert.match(src, /padding:0 8px max\(34px, env\(safe-area-inset-bottom, 0px\)\)/);
});

ok('TABBAR_ENABLED=false renders nothing (one-line switch)', () => {
  assert.equal(P.TABBAR_ENABLED, true);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(src, /^  const TABBAR_ENABLED = true;$/m, 'a single line to flip');
  const off = src.replace(/^  const TABBAR_ENABLED = true;$/m, '  const TABBAR_ENABLED = false;');
  const tmp = new URL('./pulse-card.tabbar-off.tmp.cjs', import.meta.url).pathname;
  writeFileSync(tmp, off);
  try {
    const Off = require(tmp);
    assert.equal(Off.TABBAR_ENABLED, false);
    assert.equal(Off.render('tabbar', { active: 'house' }, mk(), NOW, { tb: 'fixed' }), '');
  } finally { unlinkSync(tmp); }
});

ok('every Pulse view has exactly one tabbar card, last in its section, with its own active tab', () => {
  const files = readdirSync(root + 'views').filter((x) => x.startsWith('info-'));
  assert.equal(files.length, 14); // house, energy, settings, cameras, 10 rooms (no classic views)
  const modes = (node, out = []) => { if (Array.isArray(node)) node.forEach((x) => modes(x, out)); else if (node && typeof node === 'object') { if (node.mode === 'tabbar') out.push(node); Object.values(node).forEach((x) => modes(x, out)); } return out; };
  // Rooms and gardens are reached from the House page's room list, so they sit under House.
  const own = { 'info-energy.yaml': 'energy', 'info-cameras.yaml': 'cameras', 'info-settings.yaml': 'settings' };
  const seen = new Set();
  for (const f of files) {
    const v = yaml.load(readFileSync(root + 'views/' + f, 'utf8'));
    const bars = modes(v);
    assert.equal(bars.length, 1, f);
    const cards = v.sections[0].cards;
    assert.equal(cards[cards.length - 1].mode, 'tabbar', `${f}: last card`);
    assert.equal(bars[0].active, own[f] || 'house', f);
    assert.ok(P.TABS.some((t) => t.id === bars[0].active), `${f}: active names a tab`);
    seen.add(bars[0].active);
    assert.equal(bars[0].type, 'custom:pulse-card');
  }
  assert.deepEqual([...seen].sort(), ['cameras', 'energy', 'house', 'settings']);
});

ok('tab bar: exactly House, Energy, Cameras, Settings, each a real Pulse view, each activatable', () => {
  assert.deepEqual(P.TABS.map((t) => t.id), ['house', 'energy', 'cameras', 'settings']);
  assert.deepEqual(P.TABS.map((t) => t.label), ['Home', 'Energy', 'Cameras', 'Settings']);
  assert.deepEqual(P.TABS.map((t) => t.path), ['/pulse-dashboard/house', '/pulse-dashboard/energy', '/pulse-dashboard/cameras', '/pulse-dashboard/settings']);
  const paths = new Set(readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path));
  for (const t of P.TABS) assert.ok(paths.has(t.path.slice(P.DASH.length + 1)), t.path);
  for (const t of P.TABS) {
    const html = P.render('tabbar', { active: t.id }, mk(), NOW, {});
    assert.match(html, new RegExp(`aria-current="page"[^>]*>[\\s\\S]*?<span>${t.label}</span>`));
  }
});

ok('no Pulse page renders a Mobile dashboard link (every mode, rooms with attention, Mo chip kept)', () => {
  const items = P.ALL_ROOM_KEYS.map((k) => ({ room: k, key: k, kind: 'warm_heating', text: 't', nav: '/x' })).concat([{ room: 'House', key: '', kind: 'unexplained_reason', text: 'x', nav: '' }]);
  const hass = withRooms(P.ROOM_ORDER.map(FULL), items);
  for (const [k, html] of Object.entries(renderAll(hass))) assert.doesNotMatch(html, /mobile-dashboard/, k);
  assert.match(P.render('now-header', {}, hass, NOW), /class="hm-mo">Mo/);
  assert.doesNotMatch(readFileSync(root + 'views/info-house.yaml', 'utf8'), /footer/);
});

ok('info_rooms cfg: every nav is /pulse-dashboard/room-<key> and names a real view; classic views and occupied/decision sensors are gone', () => {
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  const navs = [...rooms.matchAll(/\{'k': '(\w+)', 'n': '[^']+', 'nav': '([^']+)'/g)];
  assert.equal(navs.length, 8);
  const paths = new Set(readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path));
  for (const [, k, nav] of navs) { assert.equal(nav, `/pulse-dashboard/room-${k}`); assert.ok(paths.has(`room-${k}`), nav); }
  assert.doesNotMatch(rooms, /mobile-dashboard/);
  const dash = readFileSync(root + 'info-dashboard.yaml', 'utf8');
  assert.doesNotMatch(dash, /!include views\/info-classic/);
  assert.ok(!readdirSync(root + 'views').some((f) => f.startsWith('info-classic')));
  assert.doesNotMatch(readFileSync(root + 'packages/mqtt.yaml', 'utf8'), /occupied\/decision|occupied_decision/);
});

ok('tab bar adds no write path and the module URL is untouched', () => {
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card-loader\.js/);
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

// ── List geometry (fixed shapes only, no clipping of content) ───────────────────────────────────
const cssRules = () => [...P.STYLE.matchAll(/^([^{\n]+)\{([^\n]*)\}$/gm)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const decl = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)${prop}:([^;]+)`)); return m ? m[1].trim() : null; };
const px = (v) => (v && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);
const rule = (sel) => cssRules().find((r) => r.sel === sel);

ok('list rows have their arithmetic: a 60px row holds the 30px tile and the 22px + 19px text lines; the activity row grows with its text', () => {
  const row = rule('.hm-row').body;
  const min = px(decl(row, 'min-height'));
  const tile = px(decl(rule('.hm-tile').body, 'height'));
  const title = px(decl(rule('.hm-rt').body, 'line-height'));
  const sub = px(decl(rule('.hm-rs').body, 'line-height'));
  assert.equal(min, 60);
  assert.ok(tile + 2 * 8 <= min && title + sub + 2 * 8 <= min, 'tile and the two text lines fit with 8px above and below');
  assert.equal(px(decl(rule('.hm-tile').body, 'width')), tile, 'the tile is square');
  assert.ok(min >= 44, 'tap target');
  assert.equal(decl(row, 'height'), null, 'rows grow with their content; only min-height is set');
  const pad = decl(row, 'padding').split(/\s+/);
  const gap = px(decl(row, 'gap'));
  assert.equal(pad[1], '14px');
  assert.equal(px(decl(rule('.hm-row+.hm-row::before').body, 'left')), px(pad[1]) + tile + gap, 'separator starts at the text column');
});

ok('every fixed height or clipping rule is accounted for (a new one needs its arithmetic)', () => {
  const fixed = cssRules().filter((r) => px(decl(r.body, 'height'))).map((r) => r.sel).sort();
  // Fixed SHAPES that hold no text: dots, icons, avatars, tiles, bars, switch track and knob, slider track and
  // thumb, the 1px visually-hidden helper. No content box has a fixed height.
  const shapes = ['.clip img', '.dot', '.sw', '.sw::after', '.sr', '.hm-sw', '.hm-sw::after', '.hm-step', '.hm-step-div', '.hm-slider', '.hm-slider::-webkit-slider-runnable-track', '.hm-slider::-webkit-slider-thumb', '.hm-slider::-moz-range-track', '.hm-slider::-moz-range-progress', '.hm-slider::-moz-range-thumb', '.hm-av', '.hm-pd', '.hm-tile', '.hm-bars', '.hm-row+.hm-row::before', '.hm-dp .hm-row::before', '.ptz button', '.tl-dot', '.tl-row:last-child .tl-rail::before'];
  assert.deepEqual(fixed.filter((f) => f !== '.ptz button'), shapes.filter((f) => f !== '.ptz button').sort());
  const sw = px(decl(rule('.sw').body, 'height'));
  const knob = P.STYLE.match(/\.sw::after\{[^\n]*top:(\d+)px[^\n]*height:(\d+)px/);
  assert.ok(sw >= +knob[1] * 2 + +knob[2]);
  // The native switch is 51x31 with a 27px knob inset 2px; the stepper pill 94x32 with 47px halves; both sliders 44px high.
  const nsw = px(decl(rule('.hm-sw').body, 'height'));
  const nknob = P.STYLE.match(/\.hm-sw::after\{[^\n]*top:(\d+)px[^\n]*height:(\d+)px/);
  assert.equal([px(decl(rule('.hm-sw').body, 'width')), nsw, +nknob[2]].join('x'), '51x31x27');
  assert.ok(nsw >= +nknob[1] * 2 + +nknob[2]);
  assert.equal([px(decl(rule('.hm-step').body, 'width')), px(decl(rule('.hm-step').body, 'height'))].join('x'), '94x32');
  assert.equal(px(decl(rule('.hm-step button').body, 'width')) * 2 + px(decl(rule('.hm-step-div').body, 'width')) >= 94 - 2, true, 'two halves and the hairline fill the pill');
  assert.ok(px(decl(rule('.hm-step button').body, 'min-height')) >= 44, 'stepper buttons are 44px targets');
  assert.ok(px(decl(rule('.hm-slider').body, 'height')) >= 24);
  for (const sel of ['.hm-back', '.hm-scene']) assert.ok(px(decl(rule(sel).body, 'min-height')) >= 44 && px(decl(rule(sel).body, 'height')) === null, sel);
  assert.equal(px(decl(rule('.hm-scene').body, 'min-height')), 76);
  const clip = cssRules().filter((r) => /overflow:hidden/.test(r.body)).map((r) => r.sel).sort();
  assert.deepEqual(clip, ['.card', '.hm-list', '.hm-rs', '.hm-rt', '.sr'].sort()); // .hm-rt/.hm-rs: single lines that ellipsise; .hm-list clips the row corners to its 12px radius
  for (const r of cssRules().filter((x) => /overflow:hidden/.test(x.body) && x.sel !== '.sr')) assert.equal(px(decl(r.body, 'height')), null, r.sel);
  for (const sel of ['.hm-row', '.tog', '.link', '.seg', '.wrow', '.row']) assert.ok(px(decl(rule(sel).body, 'min-height')) > 0 && px(decl(rule(sel).body, 'height')) === null, sel);
  // The bar chart: the tallest bar fits its 44px box and a zero or negative price keeps a 4px stub.
  assert.equal(px(decl(rule('.hm-bars').body, 'height')), 44);
  const barHeights = [...P.render('status', {}, mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates: mkSlots(9, '2026-10-25T18:00:00Z', (i) => i * 5 - 5) } } }), Date.parse('2026-10-25T18:00:00Z')).matchAll(/class="hm-bar[^"]*" style="height:(\d+)px/g)].map((m) => +m[1]);
  assert.equal(Math.min(...barHeights), 4);
  assert.equal(Math.max(...barHeights), 44);
});

ok('tab bar fixed height has its arithmetic: 83px with a home indicator, bar content area (49px) holds the 44px tab, its 26px icon and 10px label; spacer matches', () => {
  const bar = rule('.tabs').body;
  const calc = decl(bar, '--tbh').match(/calc\((\d+)px \+ max\((\d+)px/);
  const base = Number(calc[1]);
  const minInset = Number(calc[2]);
  assert.equal(base + minInset, 83, 'a phone with a home indicator gets the 83px iOS tab bar');
  const pad = bar.match(/padding:(\d+) (\d+)px max\((\d+)px/);
  assert.equal(Number(pad[1]), 0);
  assert.equal(minInset, Number(pad[3]), 'bottom padding uses the same max(...) as the height');
  const border = Number((bar.match(/border-top:([\d.]+)px/) || [])[1]);
  assert.equal(border, 0.5, 'hairline top border');
  const content = base - border;
  const tabMin = px(decl(rule('.tab').body, 'min-height'));
  assert.ok(content >= tabMin, `${content}px content area holds a ${tabMin}px tab`);
  const gap = px(decl(rule('.tab').body, 'gap'));
  const label = px(decl(rule('.tab').body, 'line-height'));
  assert.ok(26 + gap + label <= tabMin, 'icon + gap + label fit the tab');
  assert.ok(decl(rule('.tabbar-spacer').body, 'height') === 'var(--tbh)' && decl(bar, 'height') === 'var(--tbh)', 'spacer and bar share --tbh');
  const varHeights = cssRules().filter((r) => /(^|;)height:var\(/.test(r.body)).map((r) => r.sel).sort();
  assert.deepEqual(varHeights, ['.tabbar-spacer', '.tabs']);
  assert.deepEqual(cssRules().filter((r) => /position:fixed/.test(r.body)).map((r) => r.sel), ['.tabs.fixed']);
});

ok('room heating tile says whether the room is heating right now; unknown action says nothing', () => {
  const head = (over) => P.render('heating', { room: 'parlour' }, withRooms([quietRoom('parlour', { target: 20, mode_target: 20, mode_name: 'comfort', heating_active: 'comfort', heating_source: 'schedule', ...over })], []), NOW);
  const on = head({ hvac_action: 'heating' });
  // One row: the mode and its source in words, the target trailing. Heating-now is the widget's sub line only.
  assert.match(on, /class="hm-rt">Comfort, from schedule<\/div><\/div><span class="hm-val num">20\.0°<\/span>/);
  assert.doesNotMatch(on, /Comfort 20\.0°|Right now|Heating now|class="hm-rt">Target</);
  for (const a of ['heating', 'idle', 'off', null]) assert.doesNotMatch(head({ hvac_action: a }), /Right now|Heating now|Not heating|Heating off/);
  const widget = (a) => P.render('readings', { room: 'parlour' }, withRooms([quietRoom('parlour', { temp: 19, target: 20, hvac_action: a })], []), NOW);
  assert.match(widget('heating'), /Heating to 20\.0°/);
});

ok('room chart overlays heat demand from hvac_action on a hidden 0..1 axis, with a legend', () => {
  const t = loadYaml('info_templates.yaml').pulse_room.card.cards;
  const chart = t.find((c) => c.type === 'conditional').card.cards.find((c) => c.type === 'custom:apexcharts-card');
  const demand = chart.series.find((x) => x.attribute === 'hvac_action');
  assert.equal(demand.entity, '[[climate]]');
  assert.equal(demand.yaxis_id, 'demand');
  assert.equal(demand.type, 'area');
  const run = (x) => new Function('x', demand.transform)(x);
  assert.deepEqual(['heating', 'idle', 'off', 'unavailable', null].map(run), [1, 0, 0, null, null]);
  const ids = chart.yaxis.map((a) => a.id);
  assert.deepEqual(ids, ['temp', 'demand']);
  assert.equal(chart.apex_config.yaxis, undefined, 'apexcharts-card forbids yaxis in apex_config beside the yaxis list');
  assert.ok(chart.series.every((x) => ids.includes(x.yaxis_id)), 'every series names a declared axis');
  assert.equal(chart.apex_config.legend.show, true);
  const fmt = chart.yaxis.find((x) => x.id === 'temp').apex_config.labels.formatter;
  assert.match(fmt, /^EVAL:function/);
  assert.equal(new Function(`return (${fmt.replace(/^EVAL:/, '')})`)()(18.6), '19°', 'temperature axis labels carry the degree sign');
});

ok('heating holds read as heating, not occupancy: banner, heating row and occupied row', () => {
  const bed = quietRoom('bedroom', { occupied: true, lights_on: 2, target: 5, mode_target: 5, mode_name: 'minimum', heating_active: 'minimum', heating_source: 'safety', hvac_action: 'idle', pres_labels: ['Bed occupied'], heat_labels: ['Window open'], labels: ['Bed occupied', 'Window open'], verdict: 'Occupied · lights on · held occupied by Bed occupied · heating suspended: window open' });
  const hass = withRooms([bed], []);
  const why = whyRows({ room: 'bedroom' }, hass, NOW);
  assert.match(why, /Held at minimum 5\.0° · window open/);
  assert.doesNotMatch(why, /from safety/);
  assert.match(why, /Status<\/div><\/div><span class="hm-val num">Suspended</);
  assert.match(why, /<div class="hm-rs">Bed occupied · empty a few minutes after it clears<\/div>/);
  assert.doesNotMatch(why, /Bed occupied · Window open|All are true/);
  // Window just opened: the hold is true but the controller has not forced the minimum yet.
  const grace = { ...bed, heating_source: 'schedule', heating_active: 'baseline_day', mode_name: 'baseline day', mode_target: 18, target: 18 };
  const gw = whyAll({ room: 'bedroom' }, withRooms([grace], []), NOW);
  assert.doesNotMatch(gw, /Suspended/);
  assert.match(gw, /Status<\/div><div class="hm-rs">Heating drops to minimum if it stays open<\/div><\/div><span class="hm-val num">Pending</);
  // House heating off forces the minimum with no window: name that cause.
  const off = { ...bed, heat_labels: [], labels: ['Bed occupied'] };
  const offHass = withRooms([off], [], { 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } });
  assert.match(whyAll({ room: 'bedroom' }, offHass, NOW), /Held at minimum 5\.0° · house heating off/);
  const calm = P.render('room-head', { room: 'bedroom' }, withRooms([{ ...bed, heat_labels: [], labels: ['Bed occupied'] }], []), NOW);
  assert.match(calm, /Occupied · lights on</);
  assert.doesNotMatch(calm, /Occupied \(|All good/);
});

ok('room page puts readings and lighting straight under the head, before the chart; Automation sits before Activity', () => {
  const cards = loadYaml('info_templates.yaml').pulse_room.card.cards;
  const order = cards.map((c) => (c.type === 'conditional' ? 'chart' : c.mode));
  assert.deepEqual(order, ['room-head', 'readings', 'lights', 'heating', 'chart', 'presence', 'media', 'device', 'automation', 'room-feed']);
});

ok('speaker play button is quiet unless playing; the amber pause button marks active playback', () => {
  const media = (state) => P.render('media', { room: 'kitchen' }, mk({ 'media_player.kitchen': { state, attributes: { friendly_name: 'Kitchen', volume_level: 0.2 } } }), NOW);
  assert.match(media('idle'), /class="round quiet" data-act="media-play"/);
  assert.match(media('paused'), /class="round quiet"/);
  assert.match(media('playing'), /class="round" data-act="media-play"/);
});

ok('recent_auto_off is worded as a return after switch-off, not as the lights being off', () => {
  const text = P.REASON_TEXT['lighting:recent_auto_off']({}, { name: () => '' });
  assert.match(text, /back soon after lights went off/);
  assert.doesNotMatch(text, /just switched off/);
});

ok('room page copy: subtitle lines have no trailing full stops; no Why card; Individual lights is a disclosure row', () => {
  const m = quietRoom('kitchen', { occupied: true, pres_labels: ['Monitor on'], labels: ['Monitor on'], heat_labels: ['Window open'], hvac_action: 'idle', target: 18, mode_target: 18, mode_name: 'baseline day', heating_active: 'baseline_day', heating_source: 'schedule' });
  const hass = withRooms([m], []);
  const why = whyAll({ room: 'kitchen' }, hass, NOW);
  assert.doesNotMatch(why, /Why it('|&#39;)?s like this|Why it is like this/, 'the separate Why card is gone: each subsystem explains itself');
  assert.match(why, /<h2>Scenes<\/h2>[\s\S]*Individual lights[\s\S]*<h2>Heating<\/h2>[\s\S]*<h2>Presence<\/h2>/, 'one titled list per subsystem');
  assert.equal((why.match(/<div class="hm-rs">[^<]*\.<\/div>/g) || []).length, 0, 'no subtitle ends in a full stop');
  assert.match(why, /Window open · Baseline day, from schedule/);
  const lights = P.render('lights', { room: 'kitchen' }, hass, NOW);
  assert.match(lights, /Individual lights/);
  assert.doesNotMatch(lights, /\.<\/p>/, 'footnotes end without a full stop');
  const energy = P.render('energy-day', {}, mk(), NOW, { day: 'today' });
  assert.doesNotMatch(energy, /\.<\/div>/, 'energy notes end without a full stop');
});

ok('why card says what ends a heating hold and an occupancy hold', () => {
  const bed = quietRoom('bedroom', { occupied: true, target: 5, mode_target: 5, mode_name: 'minimum', heating_active: 'minimum', heating_source: 'safety', hvac_action: 'idle', pres_labels: ['Bed occupied'], heat_labels: ['Window open'], labels: ['Bed occupied', 'Window open'] });
  const why = whyAll({ room: 'bedroom' }, withRooms([bed], []), NOW);
  assert.match(why, /Held at minimum 5\.0° · window open · normal heating resumes when it closes/);
  assert.match(why, /Bed occupied · empty a few minutes after it clears/);
  const off = whyAll({ room: 'bedroom' }, withRooms([bed], [], { 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } }), NOW);
  assert.match(off, /stays at minimum while house heating is off/);
  assert.doesNotMatch(off, /resumes when it closes/);
  const two = whyAll({ room: 'bedroom' }, withRooms([{ ...bed, pres_labels: ['Bed occupied', 'Monitor on'] }], []), NOW);
  assert.match(two, /Bed occupied · Monitor on · empty a few minutes after the last one clears/);
  const motion = whyAll({ room: 'bedroom' }, withRooms([{ ...bed, pres_labels: [], heat_labels: [] }], []), NOW);
  assert.match(motion, /No holds · empty a few minutes after the last movement/);
  const empty = whyAll({ room: 'bedroom' }, withRooms([{ ...bed, occupied: false, pres_labels: [], heat_labels: [] }], []), NOW);
  assert.match(empty, /<div class="hm-rs">No holds<\/div>/);
});

ok('top guard: a hit-testable invisible header button pushes the back link and gear down; clear targets are left alone', () => {
  // Material You: ha-menu-button has opacity 0 but pointer-events all, over the top-left of the page.
  const menu = { left: 16, top: 59, right: 64, bottom: 107 };
  const back = { left: 8, top: 70, right: 52, bottom: 114 };
  const title = { left: 60, top: 70, right: 300, bottom: 114 };
  assert.equal(P.coverNeed([menu], [back], 0), 107 - 70);
  assert.equal(P.coverNeed([menu], [{ ...back, top: 107, bottom: 151 }], 37), 37, 'with the guard in place, the answer is about the natural position, so it is stable');
  assert.equal(P.coverNeed([menu], [{ left: 120, top: 70, right: 200, bottom: 100 }], 0), 0, 'a target clear of the button to the right');
  assert.equal(P.coverNeed([menu], [{ left: 8, top: 120, right: 52, bottom: 160 }], 0), 0, 'a target below it');
  assert.equal(P.coverNeed([], [back], 0), 0);
  assert.equal(P.coverNeed([menu], [], 0), 0);
  assert.equal(P.coverNeed([menu, null, { left: NaN }], [null, back, title], undefined), 37, 'garbage rects are ignored');
  assert.equal(P.coverNeed([{ left: 0, top: 0, right: 99, bottom: 9999 }], [back], 0), P.TOP_GUARD_MAX, 'clamped');
  assert.equal(P.takesTaps({ pointerEvents: 'all', display: 'flex', visibility: 'visible', opacity: '0' }), true, 'opacity is not what stops a tap');
  assert.equal(P.takesTaps({ pointerEvents: 'none', display: 'flex', visibility: 'visible' }), false);
  assert.equal(P.takesTaps({ pointerEvents: 'auto', display: 'none', visibility: 'visible' }), false);
  assert.equal(P.takesTaps({ pointerEvents: 'auto', display: 'flex', visibility: 'hidden' }), false);
  assert.equal(P.takesTaps(null), false);
});

ok('top guard: the heading cards (and only they) get the empty row above everything, sized from ui.top', () => {
  const hass = withRooms([quietRoom('bedroom')], []);
  for (const mode of P.HEAD_MODES) {
    const cfg = { room: 'bedroom' };
    const plain = P.render(mode, cfg, hass, NOW, { top: 0 });
    const guarded = P.render(mode, cfg, hass, NOW, { top: 63 });
    if (!plain) continue;
    assert.doesNotMatch(plain, /data-top-guard/, `${mode}: no row when nothing overlaps`);
    assert.match(guarded, /^<div class="p"><div data-top-guard style="height:63px;margin-bottom:-14px" aria-hidden="true"><\/div>/, `${mode}: the row is the first thing in the card`);
  }
  const back = P.render('room-head', { room: 'bedroom' }, hass, NOW, { top: 63 });
  assert.ok(back.indexOf('data-top-guard') < back.indexOf('aria-label="Back to House"'), 'the back control comes after the guard row');
  assert.match(P.render('lights', { room: 'bedroom' }, hass, NOW, { top: 63 }), /^(?!.*data-top-guard)/s, 'other cards get none');
  assert.match(P.render('room-head', { room: 'bedroom' }, hass, NOW, { top: 1e6 }), /height:200px/, 'clamped');
  assert.match(P.render('room-head', { room: 'bedroom' }, hass, NOW, { top: NaN }), /^(?!.*data-top-guard)/s);
});

ok('no "valve" wording in anything the user reads', () => {
  const bed = quietRoom('bedroom', { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'] });
  const hass = withRooms([bed], [], { 'input_boolean.bedroom_automation_heating_enabled': { state: 'on', attributes: {} } });
  const out = ['room-head', 'readings', 'lights', 'heating', 'presence', 'automation'].map((m) => P.render(m, { room: 'bedroom' }, hass, NOW)).join('');
  assert.doesNotMatch(out, /valve/i);
  assert.match(out, /Sets the target from mode, windows and schedule/);
  assert.match(out, /Normal target<\/div><div class="hm-rs">Baseline day<\/div><\/div><span class="hm-val num">18\.0°</);
});

ok('Presence holds Keep room occupied and says when the motion sensor is off; the switch itself is under Automation', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const hass = withRooms([quietRoom('bedroom')], [], {
    'input_boolean.bedroom_sensor_motion_enabled': b('off'),
    'input_boolean.bedroom_automation_presence_override': b('on'),
  });
  const pres = P.render('presence', { room: 'bedroom' }, hass, NOW);
  assert.match(pres, /data-entity="input_boolean\.bedroom_automation_presence_override"[^>]*aria-pressed="true"/);
  assert.match(pres, /Keep room occupied/);
  assert.match(pres, /Room held occupied · lights and heating treat it as in use/);
  assert.match(pres, /Motion sensor off, so movement is ignored/);
  assert.doesNotMatch(pres, /settings-open|data-key="motion"/, 'the motion switch is under Automation, not in Presence');
  assert.match(P.render('automation', { room: 'bedroom' }, hass, NOW), /data-act="setting-toggle" data-room="bedroom" data-group="presence" data-key="motion" aria-pressed="false"/);
  const guestHass = withRooms([quietRoom('home_office')], [], {
    'input_boolean.home_office_automation_presence_override': b('on'),
    'input_select.house_active_mode_modifier': b('guest'),
  });
  assert.match(P.render('presence', { room: 'home_office' }, guestHass, NOW), /Set by guest mode/);
  const on = withRooms([quietRoom('bedroom')], [], { 'input_boolean.bedroom_sensor_motion_enabled': b('on') });
  const quiet = P.render('presence', { room: 'bedroom' }, on, NOW);
  assert.doesNotMatch(quiet, /Motion sensor off/);
  // The toggle is hidden without its helper, and Presence is empty when there is neither a report nor a toggle.
  assert.doesNotMatch(quiet, /Keep room occupied/);
  assert.equal(P.render('presence', { room: 'bedroom' }, mk(), NOW), '');
});

ok('attention feed labels a motion sensor left off', () => {
  const hass = withRooms([quietRoom('bedroom')], [attn('Bedroom', 'bedroom', 'motion_disabled', 'Motion ignored, the room relies on holds')]);
  assert.match(P.render('room-head', { room: 'bedroom' }, hass, NOW), /Motion sensor off/);
  assert.doesNotMatch(P.render('room-head', { room: 'bedroom' }, hass, NOW), /Motion disabled/);
  assert.equal(rowSub(rowOf(P.render('status', {}, hass, NOW), '/pulse-dashboard/room-bedroom')), 'Motion ignored, the room relies on holds');
});

ok('house page: mode banner, modifier picker and holiday threshold write only to their fixed helpers', () => {
  const b = (st, extra = {}) => ({ state: st, attributes: {}, ...extra });
  const hass = mk({
    'sensor.house_active_mode': b('away', { last_changed: '2026-10-29T10:00:00+00:00' }),
    'input_select.house_active_mode_modifier': b('sitter'),
    'input_number.house_automation_vacation_threshold_hours': b('48'),
    'input_boolean.wfh_sarah': b('off'),
  });
  const at = Date.parse('2026-10-29T14:00:00+00:00');
  const head = P.render('house-head', {}, hass, at);
  assert.match(head, />Settings</);
  assert.match(head, /Away/);
  assert.match(head, /holiday heating in 44 h/);
  assert.match(head, /Sitter modifier/);
  const mode = P.render('house-mode', {}, hass, at);
  assert.match(mode, /data-option="sitter"/);
  assert.match(mode, /seg on" data-act="house-modifier" data-option="sitter"/);
  assert.match(mode, /never goes to away or holiday/);
  assert.match(mode, /48 h/);
  const people = P.render('house-people', {}, hass, at);
  assert.match(people, /data-entity="input_boolean\.wfh_adam"[^>]*aria-pressed="true"/);
  assert.match(people, /data-entity="input_boolean\.wfh_sarah"[^>]*aria-pressed="false"/);
  const calls = [];
  const h2 = { ...hass, callService: (d, s, data) => calls.push([d, s, data]) };
  P.handleAction(h2, { dataset: { act: 'house-modifier', option: 'guest' } });
  P.handleAction(h2, { dataset: { act: 'house-threshold', delta: '-1' } });
  P.handleAction(h2, { dataset: { act: 'house-threshold', delta: '1' } });
  assert.deepEqual(calls, [
    ['input_select', 'select_option', { entity_id: 'input_select.house_active_mode_modifier', option: 'guest' }],
    ['input_number', 'set_value', { entity_id: 'input_number.house_automation_vacation_threshold_hours', value: 42 }],
    ['input_number', 'set_value', { entity_id: 'input_number.house_automation_vacation_threshold_hours', value: 54 }],
  ]);
  assert.throws(() => P.handleAction(h2, { dataset: { act: 'house-modifier', option: 'bogus' } }), /unknown modifier/);
  const edge = { ...h2, states: { ...h2.states, 'input_number.house_automation_vacation_threshold_hours': b('168') } };
  calls.length = 0;
  P.handleAction(edge, { dataset: { act: 'house-threshold', delta: '1' } });
  assert.equal(calls[0][2].value, 168);
});

ok('settings page is reachable from the House header pill and the Heating card, and registered in the dashboard', () => {
  const hdr = P.render('now-header', {}, mk(), NOW);
  assert.match(hdr, new RegExp(`data-act="nav" data-path="${P.SETTINGS_PATH}"`));
  assert.match(P.render('house-list', {}, mk(), NOW), new RegExp(`data-path="${P.SETTINGS_PATH}"`));
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-settings\.yaml/);
  const v = yaml.load(readFileSync(root + 'views/info-settings.yaml', 'utf8'));
  assert.deepEqual(v.sections[0].cards.map((c) => c.mode), ['house-head', 'house-mode', 'house-people', 'house-heating', 'house-mo', 'tabbar']);
  assert.equal(v.path, 'settings');
});

ok('house heating section: central heating toggle, temperature steppers and window grace write to fixed helpers within range', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const hass = mk({
    'input_boolean.house_heating_enabled': b('off'),
    'input_number.global_temperature_baseline_day': b('19.5'),
    'input_number.global_temperature_baseline_night': b('17'),
    'input_number.global_temperature_comfort': b('24.5'),
    'input_number.global_temperature_minimum': b('0'),
    'input_number.global_heating_window_open_grace_minutes': b('5'),
  });
  const out = P.render('house-heating', {}, hass, NOW);
  assert.match(out, /data-entity="input_boolean\.house_heating_enabled"[^>]*aria-pressed="false"/);
  assert.match(out, /Off · every room drops to its minimum/);
  assert.match(out, /Day baseline[\s\S]*19\.5°/);
  assert.match(out, /Window open grace[\s\S]*5 min/);
  assert.match(out, /Applies to every room that uses the global setpoints/);
  assert.doesNotMatch(P.render('house-heating', {}, mk(), NOW), /Temperature modes/, 'hides what it cannot read');
  const calls = [];
  const h2 = { ...hass, callService: (d, s, data) => calls.push([d, s, data]) };
  const step = (key, delta) => P.handleAction(h2, { dataset: { act: 'house-number', key, delta } });
  step('baseline_day', '1');
  step('baseline_night', '-1');
  step('comfort', '1');
  step('minimum', '-1');
  step('window_grace', '1');
  assert.deepEqual(calls.map((c) => c[2].value), [20, 16.5, 25, 0, 6]);
  assert.ok(calls.every((c) => c[0] === 'input_number' && c[1] === 'set_value' && /^input_number\.global_/.test(c[2].entity_id)));
  assert.throws(() => step('house_heating_enabled', '1'), /unknown house setting/);
  assert.throws(() => step('__proto__', '1'), /unknown house setting/);
});

ok('cameras: per-camera status from the privacy switch, master state ignores the group, house-mode rule and offline camera shown', () => {
  const b = (st, extra = {}) => ({ state: st, attributes: {}, ...extra });
  const base = {
    'switch.parlour_privacy': b('on'), 'switch.kitchen_privacy': b('on'), 'switch.home_office_privacy': b('on'),
    'group.cameras_privacy': b('off'),
  };
  const allOff = mk({ ...base, 'sensor.house_active_mode': b('normal') });
  const head = P.render('cameras-head', {}, allOff, NOW);
  assert.match(head, />Cameras</);
  assert.match(head, /All cameras off/, 'a lying group state does not make cameras look on');
  assert.match(head, /House is at home · cameras off/);
  assert.doesNotMatch(head, /set by hand/);
  assert.match(head, /data-act="cameras-all"[^>]*aria-pressed="false"/);
  assert.match(P.render('camera', { camera: 'kitchen' }, allOff, NOW), /Privacy on/);

  const sleep = mk({ ...base, 'switch.kitchen_privacy': b('off'), 'binary_sensor.kitchen_person_occupancy': b('on'), 'sensor.house_active_mode': b('sleep') });
  assert.match(P.render('cameras-head', {}, sleep, NOW), /Kitchen on/);
  assert.match(P.render('cameras-head', {}, sleep, NOW), /only the kitchen camera is on, for Mo/);
  assert.doesNotMatch(P.render('cameras-head', {}, sleep, NOW), /set by hand/);
  const kitchen = P.render('camera', { camera: 'kitchen' }, sleep, NOW);
  assert.match(kitchen, /Live · person/);
  assert.match(kitchen, /data-act="camera-toggle" data-camera="kitchen" aria-pressed="true"/);
  assert.match(kitchen, /data-stream="kitchen"/, 'a live camera has a stream slot');
  assert.doesNotMatch(P.render('camera', { camera: 'parlour' }, sleep, NOW), /data-stream/, 'no stream slot while privacy is on');

  const hand = mk({ ...base, 'switch.parlour_privacy': b('off'), 'sensor.house_active_mode': b('normal') });
  assert.match(P.render('cameras-head', {}, hand, NOW), /set by hand/);

  const guestAway = mk({ ...base, 'sensor.house_active_mode': b('away'), 'input_select.house_active_mode_modifier': b('guest') });
  assert.match(P.render('cameras-head', {}, guestAway, NOW), /guest is staying/);
  assert.doesNotMatch(P.render('cameras-head', {}, guestAway, NOW), /set by hand/);

  const offline = mk({ ...base, 'switch.home_office_privacy': b('unavailable', { last_changed: '2026-10-26T12:00:00+00:00' }), 'sensor.house_active_mode': b('normal') });
  const oh = P.render('cameras-head', {}, offline, NOW);
  assert.match(oh, /Home office offline/);
  assert.match(oh, /card pad warn/);
  const oc = P.render('camera', { camera: 'home_office' }, offline, NOW);
  assert.match(oc, /Offline/);
  assert.doesNotMatch(oc, /data-act="camera-toggle"/, 'no switch for an offline camera');
  const now = P.render('house-list', {}, offline, NOW);
  assert.match(now, new RegExp(`data-path="${P.CAMERAS_PATH}"`));
  assert.match(now, /Home office offline/);
  assert.equal(count(P.render('house-list', {}, { states: {} }, NOW), /data-path="\/pulse-dashboard\/cameras"/g), 0, 'no camera entities, no cameras row');
  assert.throws(() => P.render('camera', { camera: 'garage' }, allOff, NOW), /known camera/);
});

ok('cameras-all turns every readable camera off when any is live, otherwise on; writes only switch services', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const calls = [];
  const run = (states) => { calls.length = 0; P.handleAction({ states, callService: (d, s, data) => calls.push(`${d}.${s}:${data.entity_id}`) }, { dataset: { act: 'cameras-all' } }); return calls.slice(); };
  assert.deepEqual(run({ 'switch.parlour_privacy': b('off'), 'switch.kitchen_privacy': b('on'), 'switch.home_office_privacy': b('unavailable') }),
    ['switch.turn_on:switch.parlour_privacy', 'switch.turn_on:switch.kitchen_privacy']);
  assert.deepEqual(run({ 'switch.parlour_privacy': b('on'), 'switch.kitchen_privacy': b('on'), 'switch.home_office_privacy': b('on') }),
    ['switch.turn_off:switch.parlour_privacy', 'switch.turn_off:switch.kitchen_privacy', 'switch.turn_off:switch.home_office_privacy']);
});

ok('cameras page is registered, linked from Now, and keeps its tab bar last', () => {
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-cameras\.yaml/);
  const v = yaml.load(readFileSync(root + 'views/info-cameras.yaml', 'utf8'));
  assert.equal(v.path, 'cameras');
  const cards = v.sections[0].cards;
  assert.equal(cards[0].mode, 'cameras-head');
  assert.equal(cards[cards.length - 1].mode, 'tabbar');
  assert.deepEqual(cards.filter((c) => c.mode === 'camera').map((c) => c.camera), ['parlour', 'kitchen', 'home_office']);
  assert.ok(!JSON.stringify(v).includes('camera-events-card'), 'the page is native; the old card is not embedded');
});

ok('camera toggle is a request: pending until the state arrives, repeat taps ignored, a silent camera says so', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const calls = [];
  const mkh = (priv) => ({ states: { 'switch.kitchen_privacy': b(priv), 'binary_sensor.kitchen_person_occupancy': b('off') }, callService: (d, sv, data) => calls.push(`${d}.${sv}:${data.entity_id}`) });
  const ui = { pending: {}, cam: { rec: {} } };
  const T0 = NOW;
  // live (privacy off): a tap asks for privacy on
  P.cameraToggle(mkh('off'), ui, 'kitchen', T0);
  assert.deepEqual(calls, ['switch.turn_on:switch.kitchen_privacy']);
  // second tap 2 s later, state has not moved: ignored, and the card says it is waiting
  P.cameraToggle(mkh('off'), ui, 'kitchen', T0 + 2000);
  assert.equal(calls.length, 1);
  const waiting = P.render('camera', { camera: 'kitchen' }, mkh('off'), T0 + 2000, ui);
  assert.match(waiting, /Turning off…/);
  assert.match(waiting, /aria-busy="true"/);
  // state arrives: pending clears itself
  assert.match(P.render('camera', { camera: 'kitchen' }, mkh('on'), T0 + 3000, ui), /Privacy on/);
  assert.equal(P.cameraPending(ui, mkh('on'), 'kitchen', T0 + 3000), null);
  assert.deepEqual({ ...P.cameraPending(ui, mkh('off'), 'kitchen', T0 + 3000) }, { waiting: true, timedOut: false, want: 'private' });
  // never arrives: after PENDING_MS it says so and a tap tries again
  const late = P.render('camera', { camera: 'kitchen' }, mkh('off'), T0 + P.PENDING_MS + 1, ui);
  assert.match(late, /No response/);
  assert.match(late, /It did not change · tap to try again/);
  P.cameraToggle(mkh('off'), ui, 'kitchen', T0 + P.PENDING_MS + 1);
  assert.equal(calls.length, 2);
  // an offline camera cannot be toggled; unknown cameras throw
  assert.equal(P.cameraToggle({ states: { 'switch.kitchen_privacy': b('unavailable') }, callService: () => assert.fail('called') }, { pending: {}, cam: { rec: {} } }, 'kitchen', T0), undefined);
  assert.throws(() => P.cameraToggle(mkh('off'), ui, 'garage', T0), /unknown camera/);
});

ok('camera pan/tilt writes only that camera\'s move buttons; the pad hides when none are available', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const live = (extra) => ({ states: { 'switch.parlour_privacy': b('off'), ...extra } });
  assert.doesNotMatch(P.render('camera', { camera: 'parlour' }, mk({ ...live({}).states, 'button.parlour_move_up': b('unavailable') }), NOW), /class="ptz"/);
  const some = mk({ ...live({}).states, 'button.parlour_move_up': b('unknown'), 'button.parlour_move_left': b('unknown'), 'button.parlour_move_right': b('unknown'), 'button.parlour_move_down': b('unknown') });
  assert.match(P.render('camera', { camera: 'parlour' }, some, NOW), /class="ptz"/);
  const calls = [];
  const h = { states: {}, callService: (d, s, data) => calls.push(`${d}.${s}:${data.entity_id}`) };
  P.handleAction(h, { dataset: { act: 'camera-ptz', camera: 'home_office', dir: 'left' } });
  assert.deepEqual(calls, ['button.press:button.home_office_move_left']);
  assert.throws(() => P.handleAction(h, { dataset: { act: 'camera-ptz', camera: 'garage', dir: 'up' } }), /unknown pan\/tilt/);
  assert.throws(() => P.handleAction(h, { dataset: { act: 'camera-ptz', camera: 'parlour', dir: 'reboot' } }), /unknown pan\/tilt/);
});

ok('camera recordings: Frigate clips are parsed defensively and rendered as loading, empty, error and list states', () => {
  const ev = (id, over = {}) => ({ media_content_id: `media-source://frigate/x/${id}`, frigate: { event: { id, has_clip: true, start_time: (NOW - 600000) / 1000, label: 'person', zones: ['patio'], ...over } } });
  const clips = P.parseClips({ children: [ev('a'), ev('b', { has_clip: false }), { media_content_id: 'x' }, null, ev('c', { zones: undefined, label: '' }), ev('', {})] });
  assert.deepEqual(clips.map((c) => c.id), ['a', 'c']);
  assert.equal(clips[0].mediaId, 'media-source://frigate/x/a');
  assert.equal(clips[1].label, 'movement');
  assert.equal(P.parseClips(null).length, 0);
  assert.equal(P.parseClips({ children: Array.from({ length: 50 }, (_, i) => ev(String(i + 1))) }).length, 20);
  assert.equal(P.frigateClipsId('home_office'), 'media-source://frigate/frigate/event-search/clips////home_office/');
  const b = (st) => ({ state: st, attributes: {} });
  const hass = mk({ 'switch.parlour_privacy': b('on') });
  const at = (rec) => P.render('camera', { camera: 'parlour' }, hass, NOW, { cam: { pending: {}, rec: { parlour: rec } } });
  assert.match(P.render('camera', { camera: 'parlour' }, hass, NOW), /aria-expanded="false"/);
  assert.match(at({ open: true, status: 'loading', items: [] }), /Loading recordings…/);
  assert.match(at({ open: true, status: 'ok', items: [] }), /No recordings yet/);
  assert.match(at({ open: true, status: 'error', items: [] }), /Couldn't load recordings[\s\S]*data-act="camera-rec-refresh"/);
  const list = at({ open: true, status: 'ok', items: clips });
  assert.match(list, /2 recent/);
  assert.match(list, /data-act="camera-clip" data-camera="parlour" data-clip="a"/);
  assert.match(list, /10 min ago/);
  assert.match(list, /Person · patio/);
  assert.match(list, /snapshot\.jpg/);
  assert.doesNotMatch(list, /<script/i);
});


// ── Gardens: lights row, theme picker, Now "Outside" group ───────────────────────────────────────
const b = (state, attributes = {}, last_changed) => ({ state, attributes, ...(last_changed ? { last_changed } : {}) });
const DAY = Date.parse('2026-11-02T12:00:00Z');
const EVENING = Date.parse('2026-11-02T19:00:00Z');
const NIGHT = Date.parse('2026-11-03T02:00:00Z');
const FG = 'front_garden';
const OPTIONS = ['normal', 'autumn', 'halloween', 'bonfire', 'christmas'];
const FG_THEME = (theme, last_changed) => ({ 'input_select.front_garden_light_theme': b(theme, { options: OPTIONS }, last_changed) });
// A front garden as the live registry describes it (Spike A): lights off, autumn picked, calendar following.
const frontGarden = (over = {}) => mk({
  'sensor.front_garden_lighting_scenes': b('scene.front_garden_autumn', { theme: 'autumn', off_scene: 'scene.front_garden_off', missing_themes: [], lights: ['light.a', 'light.b', 'light.c', 'light.d'], lights_on: 0 }),
  'sensor.front_garden_lighting_window': b('00:00', { off: '00:00', preview_min: 10 }),
  ...FG_THEME('autumn', '2026-11-01T08:00:00+00:00'),
  'input_boolean.front_garden_light_theme_calendar_enabled': b('on'),
  'sensor.front_garden_light_theme_calendar': b('autumn', { next: { date: '2026-11-05', theme: 'bonfire' }, unknown_themes: [] }),
  'input_boolean.front_garden_automation_lights_enabled': b('on'),
  'sun.sun': b('above_horizon'),
  'sensor.sun_next_setting': b('2026-11-02T16:30:00+00:00'),
  'scene.front_garden_off': b('2026-11-01T23:59:00+00:00'),
  'scene.front_garden_autumn': b('2026-11-01T17:00:00+00:00'),
  ...over,
});
const backGarden = (over = {}) => mk({
  'sensor.back_garden_lighting_scenes': b('scene.back_garden_all', { theme: 'normal', off_scene: 'scene.back_garden_off', missing_themes: [], lights: ['switch.back_garden_plug_fence_lights'], lights_on: 0 }),
  'sensor.back_garden_lighting_window': b('22:00', { off: '22:00', preview_min: null }),
  'input_boolean.back_garden_automation_lights_enabled': b('on'),
  'sun.sun': b('above_horizon'),
  'sensor.sun_next_setting': b('2026-11-02T16:30:00+00:00'),
  ...over,
});
const litScenes = (off = 2) => ({ 'sensor.front_garden_lighting_scenes': b('scene.front_garden_autumn', { theme: 'autumn', off_scene: 'scene.front_garden_off', missing_themes: [], lights: ['light.a', 'light.b'], lights_on: off }) });
const dark = { 'sun.sun': b('below_horizon'), 'sensor.sun_next_setting': b('2026-11-03T16:28:00+00:00') };
const gr = (hass, mode = 'garden-lights', t = DAY, room = FG) => P.render(mode, { room }, hass, t);
// The garden Lights row: its switch state, its subtitle, which way the switch would turn, and whether it is disabled.
const rowText = (html) => ({ on: /aria-pressed="true"/.test(html), s: (html.match(/class="hm-rs">([^<]*)</) || [])[1], btn: { on: 'Turn on', off: 'Turn off' }[(html.match(/data-want="(on|off)"/) || [])[1]], disabled: /<button[^>]*\bdisabled/.test(html) });
const optionsOf = (html) => [...html.matchAll(/data-option="([^"]*)"/g)].map((m) => m[1]);

ok('garden config: two gardens with a theme or none, no scenes, climate or lights of their own', () => {
  assert.deepEqual(P.GARDEN_ORDER, ['front_garden', 'back_garden']);
  for (const g of GARDENS) {
    assert.equal(P.ROOMS[g].kind, 'garden');
    for (const k of ['scenes', 'climate', 'temp', 'hum', 'lights', 'media']) assert.equal(P.ROOMS[g][k], undefined, `${g}.${k}`);
  }
  assert.equal(P.ROOMS.front_garden.theme, 'input_select.front_garden_light_theme');
  assert.equal(P.ROOMS.back_garden.theme, '');
});

ok('garden lights row: off by day says when it comes on, and the button turns the theme on', () => {
  assert.deepEqual(rowText(gr(frontGarden())), { on: false, s: 'On at sunset · 16:30', btn: 'Turn on', disabled: false });
});

ok('garden lights row: on in the evening window says until when', () => {
  const r = rowText(gr(frontGarden({ ...litScenes(), ...dark }), 'garden-lights', EVENING));
  assert.deepEqual(r, { on: true, s: 'Until 00:00 or bedtime', btn: 'Turn off', disabled: false });
});

ok('garden lights row: on by day is a preview ending preview_min after the latest activation', () => {
  const at = (extra) => rowText(gr(frontGarden({ ...litScenes(), ...extra }))).s;
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-02T11:58:00+00:00') }), 'Preview · off by 12:08');
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-02T11:00:00+00:00') }), 'Preview · ending');
  assert.equal(at({ 'scene.front_garden_autumn': b('unavailable') }), 'Preview · off within 10 min');
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-02T11:00:00+00:00'), 'scene.front_garden_bonfire': b('2026-11-02T11:59:00+00:00') }), 'Preview · off by 12:09', 'the latest garden scene counts');
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-01T11:00:00+00:00'), 'scene.front_garden_off': b('2026-11-02T11:59:00+00:00') }), 'Preview · ending', 'the off scene is not an activation');
});

ok('garden lights row: no preview limit says until the off time; an unknown window drops the time', () => {
  const backOn = { 'sensor.back_garden_lighting_scenes': b('scene.back_garden_all', { off_scene: 'scene.back_garden_off', lights: ['switch.back_garden_plug_fence_lights'], lights_on: 1 }) };
  assert.deepEqual(rowText(gr(backGarden(backOn), 'garden-lights', DAY, 'back_garden')), { on: true, s: 'Until 22:00', btn: 'Turn off', disabled: false });
  const noWindow = { 'sensor.back_garden_lighting_window': b('unknown') };
  assert.equal(rowText(gr(backGarden({ ...backOn, ...noWindow }), 'garden-lights', DAY, 'back_garden')).s, 'Until bedtime');
  assert.equal(rowText(gr(frontGarden({ ...litScenes(), ...dark, 'sensor.front_garden_lighting_window': b('unknown') }), 'garden-lights', EVENING)).s, 'Until bedtime');
  assert.equal(rowText(gr(backGarden(noWindow), 'garden-lights', DAY, 'back_garden')).s, 'On at sunset · 16:30');
});

ok('garden lights row: an off time after midnight keeps the window open; past it the lights are a preview again', () => {
  const window = { 'sensor.front_garden_lighting_window': b('01:30', { off: '01:30', preview_min: 10 }) };
  assert.equal(rowText(gr(frontGarden({ ...litScenes(), ...dark, ...window }), 'garden-lights', Date.parse('2026-11-03T00:30:00Z'))).s, 'Until 01:30 or bedtime');
  const late = { ...litScenes(), ...dark, 'scene.front_garden_autumn': b('2026-11-03T01:58:00+00:00') };
  assert.equal(rowText(gr(frontGarden(late), 'garden-lights', NIGHT)).s, 'Preview · off by 02:08');
});

ok('garden lights row: asleep, tomorrow, automation off, missing scene and no report', () => {
  assert.equal(rowText(gr(frontGarden({ 'sensor.house_active_mode': b('sleep') }), 'garden-lights', EVENING)).s, 'House asleep · back at sunset');
  assert.equal(rowText(gr(frontGarden(dark), 'garden-lights', EVENING)).s, 'On at sunset tomorrow');
  assert.equal(rowText(gr(frontGarden({ 'sensor.sun_next_setting': b('unknown') }))).s, 'On at sunset tomorrow', 'no sunset time is invented');
  const manual = rowText(gr(frontGarden({ 'input_boolean.front_garden_automation_lights_enabled': b('off') })));
  assert.deepEqual([manual.s, manual.btn], ['Lights automation is off · they change only by hand', 'Turn on']);
  const noScene = { 'sensor.front_garden_lighting_scenes': b('missing', { theme: 'christmas', off_scene: 'scene.front_garden_off', missing_themes: ['christmas'], lights: [], lights_on: 0 }), ...FG_THEME('christmas') };
  assert.deepEqual(rowText(gr(frontGarden(noScene))), { on: false, s: 'No scene for Christmas', btn: 'Turn on', disabled: true });
  assert.deepEqual(rowText(gr(mk())), { on: false, s: 'No lighting report from Home Assistant', btn: 'Turn on', disabled: true });
});

ok('garden lights row: a lit garden whose theme scene went missing can still be turned off', () => {
  const r = rowText(gr(frontGarden({ 'sensor.front_garden_lighting_scenes': b('missing', { theme: 'christmas', off_scene: 'scene.front_garden_off', missing_themes: ['christmas'], lights: ['light.a'], lights_on: 1 }) })));
  assert.deepEqual([r.btn, r.disabled], ['Turn off', false]);
});

ok('garden lights: count whatever the off scene lists (switches too), clamped to the list', () => {
  const scenes = (lights, lights_on) => ({ 'sensor.back_garden_lighting_scenes': b('scene.back_garden_all', { off_scene: 'scene.back_garden_off', lights, lights_on }) });
  const model = (lights, n) => P.gardenModel(backGarden(scenes(lights, n)), 'back_garden', DAY);
  const one = model(['switch.back_garden_plug_fence_lights'], 1);
  assert.deepEqual([one.lights.length, one.lightsOn, one.on], [1, 1, true]);
  assert.equal(model(['switch.x'], 9).lightsOn, 1);
  assert.equal(model([], 3).on, false, 'no listed lights means nothing can be on');
});

ok('garden scene targets outside the garden are refused', () => {
  const g = P.gardenModel(frontGarden({ 'sensor.front_garden_lighting_scenes': b('scene.parlour_all', { off_scene: 'light.front_garden_off', lights: [], lights_on: 0 }) }), FG, DAY);
  assert.deepEqual([g.onScene, g.offScene], ['', '']);
});

ok('garden theme tiles come from the helper options, with the helper state active', () => {
  const html = gr(frontGarden(), 'garden-theme');
  assert.deepEqual(optionsOf(html), OPTIONS);
  assert.match(html, /<button type="button" class="hm-row hm-btn tap" data-act="garden-theme" data-garden="front_garden" data-option="autumn" aria-pressed="true"><div class="hm-text"><div class="hm-rt">Autumn<\/div><\/div><span class="hm-check"><svg[^>]*><path d="M5 12\.5l4\.5 4\.5L19 7\.5"\/><\/svg><\/span><\/button>/);
  assert.equal((html.match(/class="hm-check"/g) || []).length, 1, 'one checkmark, on the chosen option');
  assert.match(html, /<h2>Theme<\/h2>/);
  const custom = gr(frontGarden({ 'input_select.front_garden_light_theme': b('spring', { options: ['spring', 'summer_party'] }) }), 'garden-theme');
  assert.deepEqual(optionsOf(custom), ['spring', 'summer_party']);
  assert.match(custom, /Summer party/, 'unknown options get a prettified label');
  assert.equal(gr(backGarden(), 'garden-theme', DAY, 'back_garden'), '', 'a garden without a theme helper renders nothing');
  assert.equal(gr(mk(), 'garden-theme'), '', 'no helper data renders nothing');
});

ok('every theme option in helpers.yaml has an icon and a label', () => {
  const helpers = yaml.load(readFileSync(root + 'packages/helpers.yaml', 'utf8'));
  const themes = Object.entries(helpers.input_select).filter(([id]) => id.endsWith('_light_theme'));
  assert.ok(themes.length > 0);
  for (const [id, h] of themes) {
    for (const o of h.options) {
      assert.ok(P.THEME_ICON[o] && P.ICON[P.THEME_ICON[o]], `${id}: option "${o}" has no icon`);
      assert.ok(P.THEME_LABELS[o], `${id}: option "${o}" has no label`);
    }
  }
});

ok('theme source line: paused, from calendar, picked by hand, and no next date', () => {
  const src = (over) => P.themeSource(P.gardenModel(frontGarden(over), FG, DAY));
  assert.equal(src({}), 'From calendar · Bonfire from Thu 5 Nov');
  assert.equal(src({ 'input_boolean.front_garden_light_theme_calendar_enabled': b('off') }), 'Calendar paused · stays until you change it');
  assert.equal(src(FG_THEME('halloween')), 'Picked by hand · calendar resumes Thu 5 Nov with Bonfire');
  const never = { 'sensor.front_garden_light_theme_calendar': b('autumn', { next: null, unknown_themes: [] }) };
  assert.equal(src(never), 'From calendar');
  assert.equal(src({ ...never, ...FG_THEME('halloween') }), 'Picked by hand');
  assert.equal(src({ 'sensor.front_garden_light_theme_calendar': b('unknown') }), '', 'no calendar report, no claim');
  assert.equal(src({ 'sensor.front_garden_light_theme_calendar': b('autumn', { next: '{"date":"2026-11-05","theme":"bonfire"}' }) }), 'From calendar · Bonfire from Thu 5 Nov');
  assert.equal(src({ 'sensor.front_garden_light_theme_calendar': b('autumn', { next: { date: '2026-13-45', theme: 'bonfire' } }) }), 'From calendar');
});

ok('theme card: applies at sunset only when the garden is off and the pick has not been seen yet', () => {
  const picked = FG_THEME('bonfire', '2026-11-02T11:00:00+00:00');
  assert.match(gr(frontGarden(picked), 'garden-theme'), /Applies at sunset · 16:30/);
  assert.doesNotMatch(gr(frontGarden(), 'garden-theme'), /Applies at sunset/, 'the autumn look was seen after the pick');
  assert.doesNotMatch(gr(frontGarden({ ...litScenes(), ...picked }), 'garden-theme'), /Applies at sunset/, 'on now');
  assert.doesNotMatch(gr(frontGarden({ ...picked, 'input_boolean.front_garden_automation_lights_enabled': b('off') }), 'garden-theme'), /Applies at sunset/, 'automation off');
});

ok('theme card: Use calendar only when the calendar is not in charge; the follow toggle moved to settings', () => {
  assert.doesNotMatch(gr(frontGarden(), 'garden-theme'), /Use calendar/);
  assert.doesNotMatch(gr(frontGarden(), 'garden-theme'), /Follow calendar|calendar_enabled/);
  const paused = gr(frontGarden({ 'input_boolean.front_garden_light_theme_calendar_enabled': b('off') }), 'garden-theme');
  assert.match(paused, /data-act="use-calendar" data-garden="front_garden"/);
  assert.match(paused, /Back to Autumn/);
  assert.match(gr(frontGarden(FG_THEME('halloween')), 'garden-theme'), /data-act="use-calendar"/);
});

ok('garden writes: power uses the sensor scenes, themes use the helper, Use calendar toggles then selects', async () => {
  const calls = [];
  const wrap = (h) => ({ ...h, callService: (d, s, data) => { calls.push([d, s, data]); return Promise.resolve(); } });
  const el = (dataset) => ({ dataset });
  const h = wrap(frontGarden());
  await P.handleAction(h, el({ act: 'garden-power', garden: FG, want: 'on' }));
  await P.handleAction(h, el({ act: 'garden-power', garden: FG, want: 'off' }));
  await P.handleAction(h, el({ act: 'garden-theme', garden: FG, option: 'bonfire' }));
  assert.deepEqual(calls, [
    ['scene', 'turn_on', { entity_id: 'scene.front_garden_autumn' }],
    ['scene', 'turn_on', { entity_id: 'scene.front_garden_off' }],
    ['input_select', 'select_option', { entity_id: 'input_select.front_garden_light_theme', option: 'bonfire' }],
  ]);
  calls.length = 0;
  await P.handleAction(wrap(frontGarden({ 'input_boolean.front_garden_light_theme_calendar_enabled': b('off'), ...FG_THEME('halloween') })), el({ act: 'use-calendar', garden: FG }));
  assert.deepEqual(calls, [
    ['input_boolean', 'turn_on', { entity_id: 'input_boolean.front_garden_light_theme_calendar_enabled' }],
    ['input_select', 'select_option', { entity_id: 'input_select.front_garden_light_theme', option: 'autumn' }],
  ]);
  calls.length = 0;
  await P.handleAction(wrap(frontGarden(FG_THEME('halloween'))), el({ act: 'use-calendar', garden: FG }));
  assert.deepEqual(calls, [['input_select', 'select_option', { entity_id: 'input_select.front_garden_light_theme', option: 'autumn' }]], 'the toggle is already on');
});

ok('garden writes fail loudly: bad option, no theme, not a garden, no scene, calendar theme not an option', async () => {
  const noop = (h) => ({ ...h, callService: () => assert.fail('must not call') });
  const el = (dataset) => ({ dataset });
  const fg = noop(frontGarden());
  assert.throws(() => P.handleAction(fg, el({ act: 'garden-theme', garden: FG, option: 'diwali' })), /not a theme/);
  assert.throws(() => P.handleAction(fg, el({ act: 'garden-theme', garden: 'back_garden', option: 'normal' })), /no theme/);
  assert.throws(() => P.handleAction(fg, el({ act: 'garden-power', garden: 'parlour', want: 'on' })), /unknown garden/);
  assert.throws(() => P.handleAction(fg, el({ act: 'garden-power', garden: FG, want: 'maybe' })), /unknown garden power/);
  const missing = noop(frontGarden({ 'sensor.front_garden_lighting_scenes': b('missing', { off_scene: 'scene.front_garden_off', lights: [], lights_on: 0 }) }));
  assert.throws(() => P.handleAction(missing, el({ act: 'garden-power', garden: FG, want: 'on' })), /no scene to turn on/);
  const odd = noop(frontGarden({ 'input_boolean.front_garden_light_theme_calendar_enabled': b('off'), 'sensor.front_garden_light_theme_calendar': b('diwali') }));
  await assert.rejects(async () => P.handleAction(odd, el({ act: 'use-calendar', garden: FG })), /not an option/);
});

ok('validate: garden modes need a garden, indoor modes need a room, shared modes take either', () => {
  for (const m of GARDEN_MODES) {
    assert.throws(() => P.render(m, { room: 'parlour' }, mk(), NOW), /for gardens/, m);
    assert.throws(() => P.render(m, {}, mk(), NOW), /known room/, m);
    for (const g of GARDENS) assert.doesNotThrow(() => P.render(m, { room: g }, mk(), NOW), `${m} ${g}`);
  }
  for (const m of INDOOR_MODES) {
    for (const g of GARDENS) assert.throws(() => P.render(m, { room: g }, mk(), NOW), /for indoor rooms/, `${m} ${g}`);
    assert.doesNotThrow(() => P.render(m, { room: 'parlour' }, mk(), NOW), m);
  }
  for (const m of SHARED_MODES) for (const k of P.ALL_ROOM_KEYS) assert.doesNotThrow(() => P.render(m, { room: k }, mk(), NOW), `${m} ${k}`);
});

ok('garden page: the header says whether the lights are on, the Lights row names the window, attention has its own label', () => {
  const head = gr(frontGarden(), 'room-head');
  assert.match(head, /<h1 class="hm-big">Front garden<\/h1><span class="hm-line">Lights off<\/span>/);
  assert.doesNotMatch(head, /Evening lighting|hm-tight/, 'no banner');
  assert.match(gr(frontGarden({ ...litScenes(), ...dark }), 'room-head', EVENING), /<span class="hm-line">Lights on<\/span>/);
  assert.match(gr(mk(), 'room-head'), /<span class="hm-line">Lights unknown<\/span>/);
  assert.match(gr(frontGarden({ ...litScenes(), ...dark }), 'garden-lights', EVENING), /Until 00:00 or bedtime/);
  const auto = gr(frontGarden(), 'automation');
  assert.match(auto, /data-act="setting-toggle" data-room="front_garden" data-group="lights" data-key="automation"/);
  assert.match(auto, /On from sunset; off when the house is set to asleep/);
  assert.throws(() => gr(frontGarden(), 'automations'), /unknown mode/, 'the Automations section is gone');
  const item = { room: 'Front garden', key: FG, kind: 'garden_theme_config', text: 'No scene for Christmas', nav: '/pulse-dashboard/room-front_garden' };
  const warn = gr(frontGarden({ 'sensor.info_attention': b('1', { items: JSON.stringify([item]) }) }), 'room-head');
  assert.match(warn, /Theme setup/);
  assert.match(warn, /No scene for Christmas/);
});

ok('House page: an Outside list with both gardens linking to their Pulse pages, apart from the indoor rooms', () => {
  const states = { ...frontGarden().states, ...backGarden().states };
  const calm = withRooms(calmRooms(), [], states);
  const rooms = P.render('rooms', {}, calm, DAY);
  assert.match(rooms, /<h2>Outside<\/h2>/);
  const outside = rooms.slice(rooms.indexOf('<h2>Outside'));
  assert.equal(count(outside, /class="hm-row tap"/g), 2);
  assert.ok(rooms.indexOf('<h2>Outside') > rooms.indexOf('<h2>Rooms'), 'after the indoor list');
  const front = rowOf(rooms, '/pulse-dashboard/room-front_garden');
  assert.equal(rowTitle(front), 'Front garden');
  assert.equal(rowSub(front), 'On at sunset · 16:30');
  assert.equal(rowValue(front), 'Off');
  assert.equal(tileStyle(front), 'background:#30d158;color:#000000');
  assert.ok(front.includes(P.ICON.sunset), 'sunset glyph');
  rowOf(rooms, '/pulse-dashboard/room-back_garden');
  assert.deepEqual(roomPaths(rooms), P.ROOM_ORDER, 'gardens are not in the indoor list');
  const flagged = withRooms(calmRooms(), [attn('Front garden', FG, 'garden_theme_config', 'No scene for Christmas')], states);
  const status = P.render('status', {}, flagged, DAY);
  assert.match(status, /<h2[^>]*>Needs attention<\/h2>/);
  assert.equal(rowTitle(rowOf(status, '/pulse-dashboard/room-front_garden')), 'Front garden');
  assert.equal(rowSub(rowOf(status, '/pulse-dashboard/room-front_garden')), 'No scene for Christmas');
  noNoise({ rooms, status }, 'outside');
});

ok('a theme switch reads in words (the daily calendar publish is declared ignored, so homerun never stores it)', () => {
  const cal = { location: FG, automation_id: 'front_garden:lighting:theme_calendar' };
  const entries = [histEntry(1, { ...cal, decision: 'switch_theme', reason: 'calendar_boundary', facts: { theme: 'halloween' } })];
  const html = gr(frontGarden(histSensor(FG, entries)), 'room-feed');
  assert.doesNotMatch(html, /publish|calendar publish|not a calendar boundary/i);
  assert.match(html, /<b class="tl-s">Lights<\/b> theme switched to Halloween<span style="color:#a3adba"> · calendar/);
  assert.equal((html.match(/class="tl-row /g) || []).length, 1);
});

ok('garden YAML: views use the garden template, Mobile links to Pulse, feed and attention wording are in place', () => {
  const tpl = yaml.load(readFileSync(root + 'info_templates.yaml', 'utf8'));
  assert.deepEqual(tpl.pulse_garden.card.cards.map((c) => c.mode), ['room-head', 'garden-lights', 'garden-theme', 'automation', 'room-feed']);
  for (const c of tpl.pulse_garden.card.cards) assert.doesNotThrow(() => P.render(c.mode, { room: FG }, mk(), NOW), c.mode);
  for (const g of GARDENS) {
    const v = yaml.load(readFileSync(root + `views/info-room-${g}.yaml`, 'utf8'));
    assert.deepEqual(v.sections[0].cards.find((c) => c.template === 'pulse_garden').variables, { room: g });
  }
  const mobile = readFileSync(root + 'views/front-garden.yaml', 'utf8');
  assert.match(mobile, /name: Lights and themes[\s\S]*navigation_path: \/pulse-dashboard\/room-front_garden/);
  assert.doesNotMatch(mobile, /scene_card|light_theme_option|Follow calendar|title: Theme/);
  assert.match(mobile, /lighting_automation_section_sleep_hold/);
  assert.match(readFileSync(root + 'views/back-garden.yaml', 'utf8'), /scene\.back_garden_all/, 'back garden Mobile unchanged');
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  assert.ok(!/\/mobile-dashboard\/(front|back)-garden'\]/.test(rooms), 'garden attention no longer links to Mobile');
  assert.ok(rooms.includes("'kind': 'garden_theme_config'"));
});

ok('garden sensors: MQTT topics and the lighting scenes template per garden', () => {
  const mqtt = yaml.load(readFileSync(root + 'packages/mqtt.yaml', 'utf8')).mqtt.sensor;
  const by = (id) => mqtt.find((x) => x.unique_id === id);
  for (const g of GARDENS) {
    const w = by(`${g}_lighting_window`);
    assert.deepEqual([w.state_topic, w.json_attributes_topic, w.value_template], [`${g}/lighting/window`, `${g}/lighting/window`, '{{ value_json.off }}']);
  }
  const c = by('front_garden_light_theme_calendar');
  assert.deepEqual([c.state_topic, c.json_attributes_topic, c.value_template], ['front_garden/lighting/theme_calendar', 'front_garden/lighting/theme_calendar', '{{ value_json.today }}']);
  assert.equal(by('back_garden_light_theme_calendar'), undefined);
  const templates = yaml.load(readFileSync(root + 'packages/templates.yaml', 'utf8')).template.flatMap((t) => t.sensor || []);
  for (const g of GARDENS) {
    const t = templates.find((x) => x.unique_id === `${g}_lighting_scenes`);
    assert.ok(t, g);
    assert.deepEqual(Object.keys(t.attributes), ['theme', 'off_scene', 'missing_themes', 'lights', 'lights_on']);
    assert.match(t.state, new RegExp(`area_entities\\('${g}'\\)`));
    assert.match(t.state, /'missing'/);
    assert.match(t.attributes.off_scene, /scene_control_off/);
    assert.doesNotMatch(JSON.stringify(t), /scene\.(front|back)_garden/, 'no scene id is written in the template');
    assert.doesNotMatch(t.attributes.lights, /light\./, 'lights are whatever the off scene lists, not only light.*');
  }
  assert.match(templates.find((x) => x.unique_id === 'front_garden_lighting_scenes').state, /input_select\.front_garden_light_theme/);
  assert.doesNotMatch(templates.find((x) => x.unique_id === 'back_garden_lighting_scenes').state, /light_theme/);
});

ok('Christmas scene exists, Normal keeps its entity id, scene ids stay unique', () => {
  const scenes = yaml.load(readFileSync(root + 'scenes.yaml', 'utf8'));
  const byId = Object.fromEntries(scenes.map((x) => [x.id, x]));
  assert.equal(byId['1792000000002'].name, 'Front Garden Normal');
  assert.equal(byId['1792000000006'].name, 'Front Garden Christmas');
  assert.deepEqual(Object.keys(byId['1792000000006'].entities).sort(), Object.keys(byId['1792000000003'].entities).sort());
  assert.equal(new Set(scenes.map((x) => x.id)).size, scenes.length);
});

// ── Wording table against the catalogue snapshot ──────────────────────────────────────────────
const catalog = JSON.parse(readFileSync(root + 'tests/fixtures/catalog.json', 'utf8'));
const declared = new Map(); // 'subsystem:reason' -> {outcomes, facts}
for (const a of catalog.automations) {
  for (const [reason, v] of Object.entries(a.reasons)) {
    const key = `${a.subsystem}:${reason}`;
    const seen = declared.get(key);
    const facts = [...v.facts].sort().join(',');
    if (seen) { assert.equal(seen.outcome, v.outcome, `${key}: automations disagree on outcome`); assert.equal(seen.facts, facts, `${key}: automations disagree on facts`); }
    else declared.set(key, { outcome: v.outcome, facts });
  }
}
const worded = [...declared].filter(([, v]) => v.outcome !== 'ignored');

ok('wording table: every acted or declined reason in the catalogue snapshot has a sentence, and no sentence is stale', () => {
  assert.ok(worded.length >= 29, 'the snapshot is the real catalogue');
  const missing = worded.map(([k]) => k).filter((k) => !P.REASON_TEXT[k]);
  assert.deepEqual(missing, [], 'reasons with no wording');
  const stale = Object.keys(P.REASON_TEXT).filter((k) => !declared.has(k) || declared.get(k).outcome === 'ignored');
  assert.deepEqual(stale, [], 'wording for reasons the catalogue no longer declares as acted or declined');
});

ok('wording table: sentences read only declared facts, never print a placeholder, and survive null facts', () => {
  const SAMPLE = { lux: 85, lux_threshold: 40, source: 'input_boolean.kitchen_cooking', hold: 'binary_sensor.kitchen_monitor', theme: 'halloween', minutes: 30, scene: 'cosy_evening', mode: 'baseline_night', rooms: 'parlour,home_office', skipped: 'bedroom', room: 'home_office', temp: 31.26, target: 21, clamped_from: 27, credited: 120, balance: 3400, count: 2, indoor: 26.4, outdoor: 18.2, problem: 'unreadable', modifier: 'guest', cause: 'boundary', privacy: 'on', person: 'adam', time: '07:15', hours: 12 };
  const hass = mk({ 'binary_sensor.kitchen_monitor': { state: 'on', attributes: { friendly_name: 'Kitchen monitor' } } });
  const strict = (declaredKeys, values) => new Proxy(Object.fromEntries(declaredKeys.map((k) => [k, values(k)])), {
    get(target, prop) { if (typeof prop === 'string' && !(prop in target)) throw new Error(`reads undeclared fact "${prop}"`); return target[prop]; },
  });
  for (const [key, v] of worded) {
    const [subsystem, reason] = key.split(':');
    const keys = v.facts ? v.facts.split(',') : [];
    for (const [label, values] of [['sample', (k) => SAMPLE[k]], ['null', () => null]]) {
      const raw = { ts: histEntry(1).ts, location: 'kitchen', automation_id: 'kitchen:x', subsystem, kind: 'decision', decision: 'd', reason, outcome: v.outcome, facts: Object.fromEntries(keys.map((k) => [k, values(k)])) };
      const entry = P.parseHistory({ schema: 'home.history.v1', entries: [raw] }).entries[0];
      entry.facts = strict(keys, values);
      const { text, tone } = P.sentenceFor(entry, hass);
      assert.ok(text.length > 8, `${key} (${label}) is a sentence`);
      assert.doesNotMatch(text, /undefined|NaN|\[object|null|\{|\}/, `${key} (${label}): ${text}`);
      assert.equal(tone, v.outcome === 'declined' ? 'muted' : 'ok', key);
    }
  }
  const text = (key, facts) => P.sentenceFor({ ts: histEntry(1).ts, location: 'k', automation_id: 'k', subsystem: key.split(':')[0], kind: 'decision', decision: 'd', reason: key.split(':')[1], outcome: declared.get(key).outcome, facts, detail: {} }, hass).text;
  assert.equal(text('lighting:lux_high', { lux: 85, lux_threshold: 40 }), 'Stayed off: bright enough (85 lx, on at 40 or below)');
  assert.equal(text('lighting:lux_high', { lux: null, lux_threshold: 40 }), 'Stayed off: bright enough (no light reading, on at 40 or below)');
  assert.equal(text('lighting:lux_high', { lux: 1e12, lux_threshold: -5 }), 'Stayed off: bright enough (200000 lx, on at 0 or below)', 'formatted numbers are clamped');
  assert.equal(text('lighting:external_suppress_active', { source: 'binary_sensor.kitchen_monitor' }), 'Stayed off: held off by Kitchen monitor', 'entities are worded by friendly name');
  assert.equal(text('lighting:external_suppress_active', { source: 'input_boolean.unknown_thing' }), 'Stayed off: held off by input_boolean.unknown_thing', 'falls back to the id');
  assert.equal(text('occupied:strong_hold_started', { hold: 'binary_sensor.kitchen_monitor' }), 'Marked occupied · held by Kitchen monitor');
  assert.equal(text('occupied:strong_hold_active', { hold: 'binary_sensor.kitchen_monitor' }), 'Stayed occupied: held by Kitchen monitor');
  assert.equal(text('lighting:on_outside_evening_window', { minutes: 30 }), 'Off in 30 min · turned on by hand outside lighting hours');
});

ok('wording table: the garden and feed sentences carry over, so the wording does not change', () => {
  const carried = { 'lighting:calendar_boundary': 'calendar', 'lighting:calendar_boundary_catch_up': 'calendar, after a restart', 'lighting:on_outside_evening_window': 'turned on by hand outside lighting hours', 'lighting:preview_ended': 'preview over', 'lighting:theme_scene_missing': 'no x scene set up', 'lighting:lux_low': 'room occupied and dark', 'lighting:lux_high': 'bright enough', 'lighting:recent_auto_off': 'back soon after lights went off', 'occupied:containment_failsafe_expired': 'door shut but no movement', 'lighting:house_sleep_mode': 'house set to asleep', 'lighting:sunset': 'sunset', 'lighting:sunrise': 'sunrise', 'lighting:schedule_off': 'end of the evening', 'occupied:motion_detected': 'motion detected', 'occupied:timer_expired': 'no one seen for', 'lighting:button_cycle': 'button pressed' };
  for (const [key, phrase] of Object.entries(carried)) {
    const raw = P.REASON_TEXT[key]({ lux: 1, lux_threshold: 2, theme: 'x', minutes: 1, scene: '', hold: '' }, { name: () => '' });
    assert.ok(raw.toLowerCase().includes(phrase.toLowerCase()), `${key} keeps "${phrase}": ${raw}`);
  }
});

ok('wording table: sentences for the garden, heating, house, energy and cat reasons read their facts, and survive null ones', () => {
  const text = (key, facts) => P.sentenceFor({ ts: histEntry(1).ts, location: 'k', automation_id: 'k', subsystem: key.split(':')[0], kind: 'decision', decision: 'd', reason: key.split(':')[1], outcome: declared.get(key).outcome, facts, detail: {} }, mk()).text;
  assert.equal(text('heating:safety_window_open', { mode: 'minimum' }), 'Heating set to minimum · window open');
  assert.equal(text('heating:house_mode_away', { mode: 'baseline_night' }), 'Heating set to night baseline · house away');
  assert.equal(text('heating:house_mode_away', { mode: null }), 'Heating mode changed · house away');
  assert.equal(text('heating:demand_started', { rooms: 'parlour,home_office' }), 'Boiler on · Parlour, Home office calling for heat');
  assert.equal(text('heating:demand_started', { rooms: null }), 'Boiler on · a room calling for heat');
  assert.equal(text('heating:trvs_not_set', { skipped: 'hallway_downstairs' }), 'Radiators left as they are: no temperature for the mode in Hallway downstairs');
  assert.equal(text('heating:trvs_not_set', { skipped: null }), 'Radiators left as they are: no temperature for the mode in some rooms');
  assert.equal(text('heating:valve_characteristic_lost', { room: 'home office' }), 'Notification sent · home office radiator valve needs recalibrating');
  assert.equal(text('heating:valve_characteristic_lost', { room: null }), 'Notification sent · a radiator valve needs recalibrating');
  assert.equal(text('heating:overtemp_heater_on', { temp: 31.26 }), 'Heater off · too hot (31.3°)');
  assert.equal(text('heating:overtemp_heater_on', { temp: 1e9 }), 'Heater off · too hot (50°)', 'clamped');
  assert.equal(text('heating:overtemp_heater_on', { temp: null }), 'Heater off · too hot');
  assert.equal(text('heating:temperature_set_arbitrage', { mode: 'comfort', target: 21, clamped_from: 27 }), 'Heating set to comfort (21°) · free power, room empty, limited from 27°');
  assert.equal(text('heating:temperature_set_arbitrage', { mode: 'comfort', target: null, clamped_from: null }), 'Heating set to comfort · free power, room empty');
  assert.equal(text('house_mode:parlour_active', {}), 'Not set to asleep: parlour in use');
  assert.equal(text('lighting:theme_scene_settled', { theme: 'halloween' }), 'Light effects started · Halloween scene on');
  assert.equal(text('lighting:theme_scene_settled', { theme: null }), 'Light effects started · theme scene on');
  assert.equal(text('lighting:no_lights_in_theme_roles', { theme: null }), 'Effects not started: no lights set up for this theme');
  assert.equal(text('lighting:automation_disabled_restore', {}), 'Porch light back to its look · porch automation is off');
  assert.equal(text('energy:points_increased', { credited: 120, balance: 3400 }), 'Octopus points credited (+120) · balance 3400');
  assert.equal(text('energy:points_increased', { credited: null, balance: null }), 'Octopus points credited');
  assert.equal(text('energy:sessions_joined', { count: 1 }), 'Joined 1 power down session');
  assert.equal(text('energy:sessions_joined', { count: 1e9 }), 'Joined 1000 power down sessions', 'clamped');
  assert.equal(text('energy:wheels_spun', { count: null }), 'Spun the Octopus wheels');
  assert.equal(text('mo:eating', { room: 'Home Office' }), 'Mo eating · Home office');
  assert.equal(text('mo:spotted', { room: null }), 'Mo spotted');
  assert.equal(text('thermal:open_door', { indoor: 26.4, outdoor: 18.2 }), 'Told to open the door · inside 26.4°, outside 18.2°');
  assert.equal(text('thermal:close_door', { indoor: null, outdoor: null }), 'Told to close the door · outside warmer');
});

ok('wording table: audit wording for lighting, occupancy, house, cameras, wfh and the rest, with missing facts handled', () => {
  const text = (key, facts) => P.sentenceFor({ ts: histEntry(1).ts, location: 'k', automation_id: 'k', subsystem: key.split(':')[0], kind: 'decision', decision: 'd', reason: key.split(':')[1], outcome: declared.get(key).outcome, facts, detail: {} }, mk()).text;
  assert.equal(text('lighting:lux_low', { lux: 12, lux_threshold: 30, scene: 'cosy_evening' }), 'Scene set (cosy evening) · room occupied and dark (12 lx, on at 30 or below)');
  assert.equal(text('lighting:lux_low', { lux: 12, lux_threshold: 30, scene: null }), 'Scene set · room occupied and dark (12 lx, on at 30 or below)');
  assert.equal(text('lighting:lux_low', { lux: null, lux_threshold: 30, scene: null }), 'Scene set · room occupied (no light reading)');
  assert.equal(text('lighting:recent_auto_off', { scene: 'cosy_evening' }), 'Scene set (cosy evening) · back soon after lights went off');
  assert.equal(text('lighting:recent_auto_off', { scene: null }), 'Scene set · back soon after lights went off');
  assert.equal(text('lighting:theme_scene_missing', { theme: 'halloween' }), 'Normal scene used · no Halloween scene set up');
  assert.equal(text('lighting:theme_scene_missing', { theme: null }), 'Normal scene used · no scene set up for this theme');
  assert.equal(text('lighting:theme_effects_stopped', { theme: 'bonfire' }), 'Light effects stopped · Bonfire scene replaced');
  assert.equal(text('lighting:theme_effects_stopped', { theme: null }), 'Light effects stopped · theme scene replaced');
  assert.equal(text('lighting:theme_scene_settled', { theme: 'halloween' }), 'Light effects started · Halloween scene on');
  assert.equal(text('lighting:theme_scene_settled', { theme: null }), 'Light effects started · theme scene on');
  assert.equal(text('lighting:on_outside_evening_window', { minutes: null }), 'Off in a few minutes · turned on by hand outside lighting hours');
  assert.equal(text('lighting:guest_room_sleep_bypass', {}), 'Not switched off at bedtime: room kept for a guest');
  assert.equal(text('lighting:button_off', {}), 'Lights off · button held');
  assert.equal(text('lighting:schedule_off', {}), 'Lights off · end of the evening');
  assert.equal(text('lighting:automation_disabled_restore', {}), 'Porch light back to its look · porch automation is off');
  assert.equal(text('lighting:restore_look_missing', {}), 'Porch light left warm: no saved look to go back to');
  assert.equal(text('lighting:halloween_scene_activated', {}), 'Halloween animation started · Halloween scene on');
  assert.equal(text('lighting:no_feature_lights', {}), 'Halloween effects not started: no lights labelled for them');
  assert.equal(text('occupied:timer_expired', { minutes: 5 }), 'Marked empty · no one seen for 5 min');
  assert.equal(text('occupied:timer_expired', { minutes: null }), 'Marked empty · no one seen for a few minutes');
  assert.equal(text('occupied:containment_failsafe_expired', { hours: 12 }), 'Marked empty · door shut but no movement for 12 h');
  assert.equal(text('occupied:containment_failsafe_expired', { hours: null }), 'Marked empty · door shut but no movement for a long time');
  assert.equal(text('wfh_inference:home_at_inference_time', { person: 'sarah', time: '07:15' }), 'Sarah marked as working from home · home at 07:15');
  assert.equal(text('wfh_inference:home_at_inference_time', { person: null, time: null }), 'Marked as working from home · home when checked');
  assert.equal(text('wfh_inference:home_at_inference_time', { person: 'adam', time: 'soon' }), 'Adam marked as working from home · home when checked', 'a time that is not HH:MM is not printed');
  assert.equal(text('wfh_inference:always_wfh_wed_fri', { person: 'adam' }), 'Adam marked as working from home · always Wed to Fri');
  assert.equal(text('wfh_inference:always_wfh_wed_fri', { person: null }), 'Marked as working from home · always Wed to Fri');
  assert.equal(text('cameras:button_double_press', { privacy: 'on' }), 'Cameras off · button double-pressed', 'privacy on means cameras off');
  assert.equal(text('cameras:button_double_press', { privacy: 'off' }), 'Cameras on · button double-pressed');
  assert.equal(text('cameras:button_double_press', { privacy: null }), 'Cameras switched on or off · button double-pressed');
  assert.equal(text('cameras:guest_arrived_while_away', {}), 'Cameras off · guest arrived while away');
  assert.equal(text('cameras:away_but_guest_present', {}), 'Cameras left off: house away, guest staying');
  assert.equal(text('modifier:guest_present', { modifier: 'guest' }), 'Home office kept occupied · guest staying');
  assert.equal(text('modifier:guest_absent', { modifier: 'normal' }), 'Home office released · guest mode off');
  assert.equal(text('heating:door_open_heating_on', {}), 'House heating paused · patio door left open');
  assert.equal(text('heating:door_closed_was_suspended', {}), 'House heating back on · patio door closed');
  assert.equal(text('heating:heating_disabled', {}), 'Boiler off · house heating switched off');
  assert.equal(text('heating:safety_heating_disabled', { mode: 'minimum' }), 'Heating set to minimum · house heating switched off');
  assert.equal(text('house_mode:bed_occupied', {}), 'Stayed asleep: bed occupied');
  assert.equal(text('house_mode:bed_not_occupied', {}), 'Not set to asleep: bed empty');
  assert.equal(text('house_mode:guest_mode_active', {}), 'Stayed asleep: guest mode');
  assert.equal(text('house_mode:button_hold_bed_occupied', {}), 'House set to asleep · button held, bed occupied');
  assert.equal(text('house_mode:double_press_bypass', {}), 'House set to asleep · button double-pressed, bed sensor skipped');
  assert.equal(text('house_mode:button_pressed', {}), 'House set to at home · button pressed');
  assert.equal(text('house_mode:kitchen_motion_detected', {}), 'House set to at home · kitchen in use in the morning');
  assert.equal(text('fan:automation_disabled', {}), 'Fan not started: fan automation is off');
  assert.equal(text('fan:fan_not_auto_started', {}), 'Fan left alone: already on by hand');
  assert.equal(text('sonos:automation_enabled', {}), 'Joined the speaker group · grouping switched on');
  assert.equal(text('sonos:automation_disabled', {}), 'Left the speaker group · grouping switched off');
  assert.equal(text('shower:shower_started', {}), 'Shower detected · humidity rising fast');
  assert.equal(text('shower:shower_ended', {}), 'Shower over · humidity falling');
  assert.equal(text('shower:shower_max_duration', {}), 'Shower marked over · on longer than any real shower');
});

ok('wording table: every heating cause is worded, `other` and a missing cause say nothing, and a cause never repeats its reason', () => {
  const text = (key, facts) => P.sentenceFor({ ts: histEntry(1).ts, location: 'k', automation_id: 'k', subsystem: 'heating', kind: 'decision', decision: 'd', reason: key, outcome: 'acted', facts, detail: {} }, mk()).text;
  const expected = {
    boundary: 'schedule time reached', window_closed: 'window closed', house_mode: 'house mode changed', manual_ended: 'manual setting ended',
    manual_set: 'set by hand', occupancy: 'room occupancy changed', heating_on: 'heating switched on', wfh: 'working from home', startup: 'after a restart',
  };
  for (const [cause, words] of Object.entries(expected)) assert.equal(text('schedule', { mode: 'comfort', cause }), `Heating set to comfort · schedule, ${words}`, cause);
  assert.equal(text('schedule', { mode: 'comfort', cause: 'other' }), 'Heating set to comfort · schedule');
  assert.equal(text('schedule', { mode: 'comfort', cause: null }), 'Heating set to comfort · schedule');
  assert.equal(text('schedule', { mode: 'comfort', cause: 'surprise' }), 'Heating set to comfort · schedule', 'an unknown cause is not printed');
  assert.equal(text('schedule_occupied', { mode: 'comfort', cause: 'occupancy' }), 'Heating set to comfort · schedule, room occupied, room occupancy changed');
  assert.equal(text('house_mode_sleep', { mode: 'baseline_night', cause: 'house_mode' }), 'Heating set to night baseline · house asleep', 'a house-mode cause repeats its reason');
  assert.equal(text('house_mode_sleep', { mode: 'baseline_night', cause: 'startup' }), 'Heating set to night baseline · house asleep, after a restart');
  assert.equal(text('house_mode_vacation', { mode: 'minimum', cause: 'house_mode' }), 'Heating set to minimum · house on holiday');
  assert.equal(text('house_mode_away', { mode: 'minimum', cause: 'wfh' }), 'Heating set to minimum · house away, working from home');
  assert.equal(text('manual_override', { mode: 'comfort', cause: 'manual_set' }), 'Heating set to comfort · manual setting', 'a manual set repeats its reason');
  assert.equal(text('manual_override', { mode: 'comfort', cause: 'window_closed' }), 'Heating set to comfort · manual setting, window closed');
});

ok('wording table: every key the catalogue adds for the audit is either worded or ignored, never the other way round', () => {
  for (const k of ['lighting:occupancy_off_already_off', 'lighting:house_sleep_mode_already_off', 'lighting:sunrise_already_off', 'lighting:schedule_off_already_off', 'lighting:sleep_mode_idle', 'lighting:scene_without_effects_activated', 'modifier:not_guest', 'thermal:nobody_home']) {
    assert.equal(declared.get(k).outcome, 'ignored', `${k} is ignored, so it appears in no history and has no wording`);
    assert.equal(P.REASON_TEXT[k], undefined, k);
  }
  for (const k of ['lighting:theme_effects_stopped', 'cameras:guest_arrived_while_away']) assert.equal(declared.get(k).outcome, 'acted', k);
  assert.equal(declared.has('lighting:sleep_mode_button'), false, 'no button split: buttons are not declined in sleep');
  assert.equal(declared.get('lighting:sleep_mode').outcome, 'declined');
});

ok('terms: no visible string says vacation, sleep mode, getting dark or emptied', () => {
  const banned = /vacation|sleep mode|getting dark|emptied/i;
  // Entity ids and the card's own identifiers keep their names; only what a reader sees is scanned.
  const strip = (t) => t.replace(/[a-z_]+\.[a-z0-9_]+/g, '');
  const seen = [];
  const facts = { lux: 12, lux_threshold: 30, scene: 'cosy_evening', theme: 'bonfire', minutes: 5, hours: 12, hold: '', source: '', mode: 'comfort', rooms: 'parlour', skipped: 'parlour', room: 'parlour', temp: 30, target: 21, clamped_from: 27, credited: 1, balance: 2, count: 2, indoor: 25, outdoor: 18, modifier: 'guest', person: 'adam', time: '07:15', privacy: 'on', cause: 'house_mode' };
  for (const key of Object.keys(P.REASON_TEXT)) {
    for (const f of [facts, {}, ...['boundary', 'window_closed', 'house_mode', 'manual_ended', 'manual_set', 'occupancy', 'heating_on', 'wfh', 'startup', 'other'].map((cause) => ({ ...facts, cause })), { ...facts, privacy: 'off' }]) seen.push(P.REASON_TEXT[key](f, { name: () => '' }));
  }
  for (const d of Object.values(P.UNDECLARED.decisions)) seen.push(d.verb, ...Object.values(d.note || {}));
  seen.push(...Object.values(P.UNDECLARED.reasons));
  const hass = mk({
    'input_number.house_automation_vacation_threshold_hours': { state: '48', attributes: {} }, 'sensor.house_active_mode': { state: 'away', attributes: {}, last_changed: '2026-10-29T10:00:00+00:00' },
    'input_select.house_active_mode_modifier': { state: 'sitter', attributes: {} },
  });
  const at = Date.parse('2026-10-29T14:00:00+00:00');
  for (const sec of ['house-head', 'house-mode', 'house-people', 'house-heating', 'house-mo']) seen.push(P.render(sec, {}, hass, at));
  seen.push(JSON.stringify(P.ROOM_SETTINGS), JSON.stringify(P.HOUSE_NUMBERS));
  for (const t of seen) assert.doesNotMatch(strip(t).replace(/<[^>]*>/g, ' '), banned, t.slice(0, 120));
  assert.ok(seen.length > 100);
  assert.match(P.render('house-mode', {}, hass, at), /Holiday threshold/);
});

ok('unexplained_reason: a catalogue reason with no wording raises attention; the real catalogue raises none', () => {
  const keys = worded.map(([k]) => k).sort();
  const cat = (reasons) => ({ 'sensor.homerun_catalog': { state: '19', attributes: { schema: 'home.catalog.v1', reasons } } });
  assert.deepEqual(P.unexplainedReasons(mk(cat(keys))), []);
  assert.equal(P.attentionItems(withRooms(P.ROOM_ORDER.map(FULL), [], cat(keys))).length, 0);
  const hass = withRooms(P.ROOM_ORDER.map(FULL), [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window', nav: '/x' }], cat([...keys, 'lighting:brand_new_reason', 'occupied:another_one']));
  const items = P.attentionItems(hass);
  assert.deepEqual(items.map((i) => i.kind), ['window_open_heating_on', 'unexplained_reason'], 'a room problem still leads');
  assert.match(items[1].text, /No wording for lighting:brand_new_reason, occupied:another_one/);
  const status = P.render('status', {}, hass, NOW);
  assert.equal(count(status, /class="hm-row tap"/g), 2);
  assert.equal(rowTitle(rowOf(status, '/pulse-dashboard/house')), 'Pulse');
  assert.match(rowSub(rowOf(status, '/pulse-dashboard/house')), /^No wording for lighting:brand_new_reason, occupied:another_one$/);
  assert.match(status, /data-path="\/pulse-dashboard\/room-bedroom"/, 'the link goes to the real room first');
  const only = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), [], cat(['lighting:brand_new_reason'])), NOW);
  assert.match(only, /No wording for lighting:brand_new_reason/);
  assert.match(only, /data-path="\/pulse-dashboard\/house"/);
  for (const bad of ['nope', 7, [1, null, 'bad key', 'lighting:ok_but_unknown', '../etc:x']]) assert.deepEqual(P.unexplainedReasons(mk(cat(bad))).filter((k) => k !== 'lighting:ok_but_unknown'), [], 'only well-formed keys are reported');
  assert.deepEqual(P.unexplainedReasons(mk()), [], 'no catalogue sensor: an unknown is not a gap');
  const flood = P.unexplainedReasons(mk(cat(Array.from({ length: 500 }, (_, i) => `lighting:r${i}`))));
  assert.equal(flood.length, 50, 'capped');
  noNoise({ s: P.render('status', {}, hass, NOW) }, 'unexplained');
});

ok('history, catalogue and feed YAML: one history sensor per location plus house, the catalogue projection, the feed lost by_room and lights', () => {
  const mqtt = yaml.load(readFileSync(root + 'packages/mqtt.yaml', 'utf8')).mqtt.sensor;
  const by = (id) => mqtt.find((x) => x.unique_id === id);
  const locations = [...P.ALL_ROOM_KEYS];
  const catalogLocations = [...locations, 'house']; // whole-house automations publish to sensor.house_history
  for (const loc of new Set(catalog.automations.map((a) => a.location))) assert.ok(catalogLocations.includes(loc), `catalogue location ${loc} is a room, garden or house key in the card`);
  for (const k of locations) {
    const s = by(`${k}_history`);
    assert.ok(s, k);
    assert.deepEqual([s.state_topic, s.json_attributes_topic], [`homerun/${k}/history`, `homerun/${k}/history`]);
    assert.equal(s.name, `${k.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')} History`, 'the entity id is sensor.<location>_history');
  }
  assert.deepEqual([by('house_history').state_topic, by('house_history').json_attributes_topic], ['homerun/history', 'homerun/history']);
  const cat = by('homerun_catalog');
  assert.deepEqual([cat.state_topic, cat.json_attributes_topic], ['homerun/catalog', 'homerun/catalog']);
  assert.match(cat.json_attributes_template, /'acted', 'declined'/, 'only the reasons worth explaining are kept, under the 16 KB recorder cap');
  assert.ok(JSON.stringify(catalog).length > 16384, 'the raw catalogue would exceed the recorder attribute cap');
  for (const s of mqtt.filter((x) => /_history$/.test(x.unique_id))) assert.match(s.value_template, /entries\[0\]\.ts if value_json\.entries else none/, 'an empty history is unknown, not an error');
  assert.ok(!existsSync(root + 'packages/info_surface_feed.yaml'), 'the feed trigger template is gone: House reads sensor.house_history');
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  assert.doesNotMatch(rooms, /info_decision_feed/);
  for (const f of ['info_surface_rooms', 'mqtt']) assert.doesNotThrow(() => yaml.load(readFileSync(root + `packages/${f}.yaml`, 'utf8')), f);
});

ok('this step adds no write paths', () => {
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
});

// ── Step 5: tap feedback, one lights wording, room page by subsystem ─────────────────────────────
const fakeEl = (dataset, extra = {}) => ({ dataset, ...extra });
const scenesHass = (over = {}) => ({
  ...withRooms([quietRoom('parlour', { lights_on: 2, scene: 'parlour lamps' })], [], { 'scene.parlour_lamps': { state: '2026-10-25T18:00:00+00:00', last_changed: '2026-10-25T18:00:00+00:00', attributes: { friendly_name: 'Parlour lamps' } }, ...over }),
});
const SCENE_TAP = { act: 'scene', entity: 'scene.parlour_lamps' };
const tileBusy = (html) => /<button type="button" class="hm-scene[^"]*" data-act="scene" data-entity="scene\.parlour_lamps" aria-pressed="[a-z]+" aria-busy="true">/.test(html);

await okAsync('pending: a tap marks the control busy at once; a state change clears it', async () => {
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

ok('pending: cleared by the 8 s timeout, and a skewed clock cannot make it immortal or negative', () => {
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

ok('pending: every kind of write is covered (toggle, select, number, slider, media, garden) and keys differ per control', () => {
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

await okAsync('pending: a rejected service call renders the inline error and clears the pending state', async () => {
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

await okAsync('pending: disallowed writes still fail loudly, and are reported on the card', async () => {
  const hass = { ...scenesHass(), callService: () => assert.fail('must not be called') };
  const ui = { pending: {} };
  const warn = console.warn;
  console.warn = () => {};
  try { await P.perform(hass, ui, fakeEl({ act: 'toggle', entity: 'automation.x' }), undefined, NOW); } finally { console.warn = warn; }
  assert.match(P.render('lights', { room: 'parlour' }, hass, NOW, ui), /class="err"/);
});

ok('lights wording: every lights phrase comes from lightsState', () => {
  const room = (over) => quietRoom('parlour', { occupied: true, ...over });
  const cases = [
    [{ lights_on: 0, scene: '' }, 'off', { on: false, badge: 'Off', clause: 'lights off' }],
    [{ lights_on: 2, scene: '' }, '', { on: true, badge: 'On', clause: 'lights on' }],
    [{ lights_on: 2, scene: 'lamps' }, 'lamps', { on: true, badge: 'Lamps', clause: 'lights on' }],
    [{ lights_on: 1, scene: 'off' }, 'off', { on: true, badge: 'On', clause: 'lights on' }],
  ];
  for (const [over, scene, want] of cases) {
    const m = P.roomModel(withRooms([room(over)], []), 'parlour');
    assert.deepEqual(P.lightsState(m, scene), want, JSON.stringify(over));
    const hass = withRooms([room(over)], [], { 'sensor.parlour_active_scene': { state: scene ? `parlour_${scene}` : 'unknown', attributes: {} } });
    const sceneState = { 'sensor.parlour_active_scene': { state: scene ? `parlour_${scene}` : 'unknown', attributes: {} } };
    const line = want.on ? (want.badge === 'On' ? 'Lights on' : want.badge) : 'Lights off';
    for (const occupied of [false, true]) {
      const list = P.render('rooms', {}, withRooms([room({ ...over, occupied })], [], sceneState), NOW);
      assert.equal(rowSub(rowOf(list, '/pulse-dashboard/room-parlour')), line, `room row says "${line}"`);
    }
    const said = want.on ? (want.badge === 'On' ? 'lights on' : `${want.badge} on`) : 'lights off';
    assert.ok(P.render('room-head', { room: 'parlour' }, hass, NOW).includes(`<span class="hm-line">Occupied · ${said}</span>`), `subtitle says "${said}"`);
  }
  // No second source of lights words: the old functions are gone and the phrases appear only inside lightsState.
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /lightsPhrase|lightsBadgeText|tidyVerdict|lightsExplain/);
  assert.equal((src.match(/function lightsState/g) || []).length, 1, 'one definition');
});

ok('room page order: header, readings, Scenes, Individual lights, Heating, Presence, Media, Automation, Activity', () => {
  const cards = loadYaml('info_templates.yaml').pulse_room.card.cards.filter((c) => c.mode !== 'device').map((c) => (c.type === 'conditional' ? 'chart' : c.mode));
  assert.deepEqual(cards, ['room-head', 'readings', 'lights', 'heating', 'chart', 'presence', 'media', 'automation', 'room-feed']);
  // Rendered in template order for a room that has every section, the headings come out in that order.
  const hass = withRooms([quietRoom('parlour', { occupied: true, lights_on: 2, target: 20, mode_target: 20, mode_name: 'comfort' })], [], {
    'input_boolean.parlour_automation_lights_enabled': { state: 'on', attributes: {} },
  });
  const html = cards.map((m) => (m === 'chart' ? P.render('chart-head', {}, hass, NOW) : P.render(m, { room: 'parlour' }, hass, NOW))).join('');
  // Lights and Automation are disclosure rows, which stand in for their section headers.
  const heads = [...html.matchAll(/<h2>([^<]+)<\/h2>|data-act="disclose" data-id="parlour:(\w+)"/g)].map((m) => m[1] || `row:${m[2]}`);
  assert.deepEqual(heads, ['Scenes', 'row:lights', 'Heating', 'Last 24 hours', 'Presence', 'Media', 'row:automation', 'Activity']);
  assert.match(html.slice(0, html.indexOf('<h2>Scenes')), /^<div class="p"><div class="hm hm-first"><div class="hm-head"><a [^>]*Back to House[\s\S]*<h1 class="hm-big">Parlour<\/h1><span class="hm-line">Occupied · Lamps on<\/span>/, 'the back link, the title and the subtitle come first');
  assert.doesNotMatch(html, /Why it/, 'no separate explanation card');
  // The bathroom puts the fan row beside Media, so the order of the named sections is unchanged.
  const bath = loadYaml('info_templates.yaml').pulse_room.card.cards.map((c) => (c.type === 'conditional' ? 'chart' : c.mode));
  assert.deepEqual(bath.filter((m) => m !== 'device'), cards);
  // Every room view still calls the one template.
  for (const f of readdirSync(root + 'views').filter((x) => /^info-room-/.test(x) && !/garden/.test(x))) {
    assert.equal(yaml.load(readFileSync(root + 'views/' + f, 'utf8')).sections[0].cards[0].template, 'pulse_room', f);
  }
});

ok('House feed card is wired to sensor.house_history and the old feed entity is referenced nowhere', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(src, /readHistory\(hass, 'sensor\.house_history'\)/);
  const files = ['info-dashboard.yaml', 'info_templates.yaml', 'wallboard.yaml', 'dashboard.yaml', 'www/pulse-card.js']
    .concat(readdirSync(root + 'views').map((f) => 'views/' + f), readdirSync(root + 'packages').map((f) => 'packages/' + f));
  for (const f of files) assert.doesNotMatch(readFileSync(root + f, 'utf8'), /info_decision_feed|plumbing_decisions|PLUMBING_|'verdict'|verdict: /, f);
  assert.ok(yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8')).sections[0].cards.some((c) => c.mode === 'feed'));
});

// ── Room settings: the inline Automation list (step 5b) ────────────────────────────────────────────────────────────────────
const helpersYaml = loadYaml('packages/helpers.yaml');
const helperIds = new Set([...Object.keys(helpersYaml.input_boolean).map((k) => `input_boolean.${k}`), ...Object.keys(helpersYaml.input_number).map((k) => `input_number.${k}`)]);
const settingRows = () => Object.entries(P.ROOM_SETTINGS).flatMap(([room, groups]) => groups.flatMap((g) => g.rows.map((row) => ({ room, group: g.key, row }))));
// What each stepper must equal. Fan: the clamps in homerun-automations lib/bathroom/steam.ts. Foreign office door numbers
// and the lux threshold: the automations do not clamp them, so these are the helpers' own packages/helpers.yaml ranges.
const EXPECTED_CLAMPS = {
  'input_number.bathroom_automation_fan_min_run': [5, 30],
  'input_number.bathroom_automation_fan_max_run': [15, 120],
  'input_number.bathroom_automation_fan_humidity_margin': [2, 30],
  'input_number.foreign_office_automation_door_open_delta': [0.5, 10],
  'input_number.foreign_office_automation_door_open_min_outdoor': [0, 20],
  'input_number.foreign_office_automation_door_indoor_comfort_threshold': [18, 28],
  'input_number.foreign_office_automation_door_notification_cooldown_mins': [15, 240],
};
const luxId = /^input_number\.\w+_automation_lux_threshold_dark$/;
const sheetHass = (over = {}) => {
  const states = {};
  for (const { row } of settingRows()) states[row.id] = b(row.kind === 'toggle' ? 'on' : String(row.min));
  return mk({ ...states, ...over });
};
// Open, so the rows are visible; `closedSheet` is the default-closed render.
const sheet = (room, hass = sheetHass()) => P.render('automation', { room }, hass, NOW, { open: { [`${room}:automation`]: true } });
const closedSheet = (room, hass = sheetHass()) => P.render('automation', { room }, hass, NOW);
// The settings groups (ROOM_TABLE) a rendered Automation list draws from, in order.
const groupsOf = (html) => [...new Set([...html.matchAll(/data-act="setting-(?:toggle|number)" data-room="\w+" data-group="(\w+)"/g)].map((m) => m[1]))];

ok('Automation: one disclosure row on every room and garden page, rows explain themselves with a subtitle, no footnotes', () => {
  for (const k of P.ALL_ROOM_KEYS) {
    const html = sheet(k);
    assert.doesNotMatch(html, /<h2>/, `${k}: the row is the header`);
    assert.match(html, new RegExp(`data-act="disclose" data-id="${k}:automation" aria-expanded="true" aria-controls="dp-${k}-automation"><div class="hm-text"><div class="hm-rt">Automation</div></div><span class="hm-val hm-ds">All on</span>`), k);
    assert.equal((html.match(/<section class="hm-sec">/g) || []).length, 1, `${k}: a single list`);
    assert.doesNotMatch(html, /hm-foot|role="dialog"|class="sheet"|settings-open|settings-close/, k);
    assert.doesNotMatch(html, NOISE, k);
    assert.doesNotMatch(P.render('room-head', { room: k }, sheetHass(), NOW, { settings: true }), /settings|dialog|class="ovl"/, `${k}: no gear and no sheet`);
    assert.match(closedSheet(k), /aria-expanded="false"[^>]*>[\s\S]*<div class="hm-dp" id="dp-[\w-]+" hidden>/, `${k}: closed by default`);
  }
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /settingsSheet|splitSheet|portalShow|settings-open|settings-close|pulse-card:settings/, 'no sheet code left');
  // Each row carries its explanation as a subtitle under its label (14px textSecondary, the .hm-rs line).
  const bath = sheet('bathroom');
  assert.match(bath, /<div class="hm-rt">Fan automation<\/div><div class="hm-rs">Runs the extractor fan after a shower until the steam clears<\/div>/);
  assert.match(bath, /<div class="hm-rt">Minimum run<span class="hm-tv num">[^<]*<\/span><\/div><div class="hm-rs">After the last shower ends<\/div>/);
  assert.equal(count(bath, /class="hm-rs"/g), count(bath, /data-act="setting-toggle"/g) + count(bath, /data-act="setting-number"/g) / 2, 'one subtitle per row (a stepper has two buttons)');
  assert.match(rule('.hm-rs').body, /font-size:14px[^}]*color:#a3adba/);
  assert.match(P.render('room-head', { room: 'bedroom' }, sheetHass(), NOW), /<h1 class="hm-big">Bedroom<\/h1>/);
});

ok('Automation summary: "All on", or what is off in the attention colour (one by name, several by count)', () => {
  const sum = (room, over) => closedSheet(room, sheetHass(over)).match(/<span class="hm-val hm-ds"([^>]*)>([^<]*)</).slice(1);
  assert.deepEqual(sum('bathroom', {}), ['', 'All on']);
  assert.deepEqual(sum('bathroom', { 'input_boolean.bathroom_automation_fan_enabled': b('off') }), [' style="color:#f2b84b"', 'Fan automation off']);
  assert.deepEqual(sum('kitchen', { 'input_boolean.kitchen_automation_lights_enabled': b('off') }), [' style="color:#f2b84b"', 'Lights automation off']);
  assert.deepEqual(sum('kitchen', { 'input_boolean.kitchen_automation_lights_enabled': b('off'), 'input_boolean.kitchen_automation_heating_enabled': b('off') }), [' style="color:#f2b84b"', '2 off']);
  assert.deepEqual(sum('kitchen', { 'input_boolean.kitchen_automation_lights_enabled': b('off'), 'input_boolean.kitchen_automation_heating_enabled': b('off'), 'input_boolean.kitchen_sensor_motion_enabled': b('off') }), [' style="color:#f2b84b"', '3 off']);
  assert.equal(sum('front_garden', { 'input_boolean.front_garden_automation_lights_enabled': b('off') })[1], 'Lights automation off');
});

ok('disclosure row: a real button, aria-expanded and aria-controls, a chevron that turns 90 degrees, one definition', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.equal((src.match(/function hmDisclosure\(/g) || []).length, 1, 'defined once');
  assert.equal((src.match(/data-act="disclose"/g) || []).length, 1, 'only the one definition draws the row');
  const html = closedSheet('bathroom');
  assert.match(html, /<button type="button" class="hm-row hm-btn tap" data-act="disclose" data-id="bathroom:automation" aria-expanded="false" aria-controls="dp-bathroom-automation">/);
  assert.match(html, /<span class="hm-chev" aria-hidden="true"><svg[^>]*><path d="M9 5l7 7-7 7"\/><\/svg><\/span><\/button><div class="hm-dp" id="dp-bathroom-automation" hidden>/);
  assert.match(rule('.hm-row').body, /min-height:60px/, 'at least 44px');
  assert.match(P.STYLE, /\.hm-btn\[aria-expanded="true"\] \.hm-chev\{transform:rotate\(90deg\)\}/);
  assert.doesNotMatch(P.STYLE, /transition|animation/, 'nothing animates, so a repaint cannot replay anything');
  assert.match(rule('.hm-ds').body, /min-width:0/);
  assert.match(rule('.hm-val').body, /color:#a3adba/, 'the summary is textSecondary');
});

ok('native controls: a switch row is a button with aria-pressed; a stepper has two labelled buttons, its value in the row title', () => {
  const html = sheet('bathroom');
  assert.match(html, /<button type="button" class="hm-row hm-btn tap" data-act="setting-toggle" data-room="bathroom" data-group="fan" data-key="automation" aria-pressed="true"><div class="hm-text"><div class="hm-rt">Fan automation<\/div><div class="hm-rs">[^<]+<\/div><\/div><span class="hm-sw" aria-hidden="true"><\/span><\/button>/);
  assert.match(sheet('bathroom', sheetHass({ 'input_boolean.bathroom_automation_fan_enabled': b('off') })), /data-key="automation" aria-pressed="false"><div class="hm-text"><div class="hm-rt">Fan automation<\/div><div class="hm-rs">[^<]+<\/div><\/div><span class="hm-sw off"/);
  const stepper = sheet('bathroom', sheetHass({ 'input_number.bathroom_automation_fan_min_run': b('15') }));
  assert.match(stepper, /<div class="hm-rt">Minimum run<span class="hm-tv num">15 min<\/span><\/div>/);
  assert.match(stepper, /<span class="hm-step"><button type="button" data-act="setting-number" data-room="bathroom" data-group="fan" data-key="min_run" data-delta="-1" aria-label="Minimum run lower">[\s\S]*?<\/button><i class="hm-step-div" aria-hidden="true"><\/i><button type="button" data-act="setting-number" data-room="bathroom" data-group="fan" data-key="min_run" data-delta="1" aria-label="Minimum run higher">/);
  // One implementation: every control on the room and garden pages is drawn by the same three helpers.
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  for (const name of ['hmSwitch', 'hmStepper', 'hmSliderRow']) assert.equal((src.match(new RegExp(`const ${name} =|function ${name}\\(`, 'g')) || []).length, 1, `${name} is defined once`);
  assert.doesNotMatch(src.slice(src.indexOf('// ── Room page sections'), src.indexOf('// ── Settings page')), /class="sw|class="tog|class="round quiet" data-act="setting/, 'the room pages use no older switch or row');
  // Colours come from tokens: on / off / knob for the switch, control for the pill, tint over sliderTrack for a slider.
  assert.match(rule('.hm-sw').body, /background:#3a8f63/);
  assert.match(rule('.hm-sw.off').body, /background:#3a424d/);
  assert.match(rule('.hm-sw::after').body, /background:#fff/);
  assert.match(rule('.hm-step').body, /background:#232a33/);
  assert.match(rule('.hm-slider::-webkit-slider-runnable-track').body, /linear-gradient\(to right,#f2c46b var\(--p,0%\),#3a424d var\(--p,0%\)\)/);
});

ok('room head: a tint back link, the large title, a plain-words subtitle; attention items sit right under it', () => {
  const full = withRooms(P.ROOM_ORDER.map(FULL), [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }, { room: 'Bedroom', key: 'bedroom', kind: 'cold_not_heating', text: 'Cold, heating off', nav: '/x' }]);
  for (const k of P.ALL_ROOM_KEYS) {
    const html = P.render('room-head', { room: k }, full, NOW, {});
    assert.match(html, new RegExp(`<a class="hm-back tap" data-act="nav" data-path="${P.HOUSE_PATH}" aria-label="Back to House"><svg[^>]*><path d="M15 5l-7 7 7 7"/></svg><span>Home</span></a>`), k);
    assert.match(html, new RegExp(`<h1 class="hm-big">${P.ROOMS[k].name}</h1><span class="hm-line">[^<]+</span>`), k);
    assert.equal((html.match(/Back to House/g) || []).length, 1, k);
  }
  assert.match(rule('.hm-back').body, /color:#f2c46b/, 'the back link is in the tint colour');
  assert.match(rule('.hm-big').body, /font-size:34px;line-height:41px;font-weight:700/);
  assert.match(rule('.hm-line').body, /font-size:15px[^}]*color:#a3adba/);
  // Subtitles in plain words.
  const sub = (over, extra) => P.render('room-head', { room: 'parlour' }, withRooms([quietRoom('parlour', over)], [], extra), NOW).match(/<span class="hm-line">([^<]*)</)[1];
  assert.equal(sub({ occupied: true, lights_on: 2 }), 'Occupied · Lamps on');
  assert.equal(sub({ occupied: false, lights_on: 0 }), 'Empty · lights off');
  assert.equal(sub({ occupancy_unavailable: true, lights_on: 1 }, { 'sensor.parlour_active_scene': { state: 'unknown', attributes: {} } }), 'Occupancy unavailable · lights on');
  // Attention: one row each, filled tile with the attention ink glyph, short label in the attention colour, the detail beneath.
  const bed = P.render('room-head', { room: 'bedroom' }, full, NOW, {});
  assert.equal((bed.match(/<div class="hm-row">/g) || []).length, 2);
  assert.match(bed, /<section class="hm-sec hm-tight"><div class="hm-list"><div class="hm-row"><span class="hm-tile" style="background:#f2b84b;color:#000000"><svg[^>]*><path d="M4 4h16v16H4zM12 4v16M4 12h16"\/><\/svg><\/span><div class="hm-text"><div class="hm-rt" style="color:#f2b84b;font-weight:600">Window open, heating on<\/div><div class="hm-rs">Open window while heating<\/div>/);
  assert.match(bed, new RegExp(`<path d="${P.ICON.flame.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"/></svg></span><div class="hm-text"><div class="hm-rt" style="color:#f2b84b;font-weight:600">Too cold, heating off`));
  assert.doesNotMatch(P.render('room-head', { room: 'kitchen' }, full, NOW, {}), /hm-tight/, 'a room with nothing to flag has no list');
  assert.match(rule('.hm .hm-tight').body, /margin-top:16px/);
});

ok('Readings: Temperature and Light level widgets, each omitted when the room lacks the sensor, a lone widget full width', () => {
  const LUX = 'sensor.parlour_sensor_motion_illuminance';
  const lx = (v, unit = 'lx') => ({ [LUX]: b(v, { unit_of_measurement: unit }), 'input_number.parlour_automation_lux_threshold_dark': b('40') });
  const room = (over, extra = lx('85')) => withRooms([quietRoom('parlour', { target: 19, hvac_action: 'heating', temp: 18.4, ...over })], [], extra);
  const html = P.render('readings', { room: 'parlour' }, room({}), NOW);
  assert.match(html, /<div class="hm-wgrid"><div class="hm-w"><div class="hm-wl" style="color:#f08a4b">Temperature<\/div><div class="hm-wv num">18\.4°<\/div><div class="hm-ws">Heating to 19\.0°<\/div><\/div>/);
  assert.match(html, /<div class="hm-wl" style="color:#ffd60a">Light level<\/div><div class="hm-wv num">85<small>lx<\/small><\/div><div class="hm-ws">Bright enough<\/div>/);
  const light = (v, unit) => P.render('readings', { room: 'parlour' }, room({}, lx(v, unit)), NOW).match(/Light level[\s\S]*?<\/div><div class="hm-wv num">(.*?)<\/div><div class="hm-ws">([^<]*)</);
  assert.deepEqual(light('12').slice(1), ['12<small>lx</small>', 'Dark, lights come on']);
  assert.deepEqual(light('40').slice(1), ['40<small>lx</small>', 'Dark, lights come on'], 'at the threshold counts as dark');
  assert.deepEqual(light('41').slice(1), ['41<small>lx</small>', 'Bright enough']);
  assert.deepEqual(light('1e12').slice(1), ['200000<small>lx</small>', 'Bright enough'], 'clamped');
  // A sensor that is there but unusable shows a dash, never a guess.
  for (const [v, unit] of [['unavailable', 'lx'], ['unknown', 'lx'], ['abc', 'lx'], ['85', 'klx'], ['85', null]]) assert.deepEqual(light(v, unit).slice(1), ['–', ''], `${v} ${unit}`);
  // No threshold helper: the reading without a verdict.
  assert.deepEqual(P.render('readings', { room: 'parlour' }, room({}, { [LUX]: b('85', { unit_of_measurement: 'lx' }) }), NOW).match(/85<small>lx<\/small><\/div><div class="hm-ws">([^<]*)</).slice(1), ['']);
  // The decision-time lux in the history is no longer read.
  assert.doesNotMatch(P.render('readings', { room: 'parlour' }, room({}, histSensor('parlour', [histEntry(10, { location: 'parlour', subsystem: 'lighting', decision: 'no_action', reason: 'lux_high', outcome: 'declined', facts: { lux: 85, lux_threshold: 40 } })])), NOW), /Light level/);
  // A missing temperature sensor or entity drops that widget; a lone widget has the row to itself.
  assert.doesNotMatch(P.render('readings', { room: 'hallway_upstairs' }, withRooms([quietRoom('hallway_upstairs')], [], { 'sensor.hallway_upstairs_sensor_motion_illuminance': b('5', { unit_of_measurement: 'lx' }) }), NOW), /Temperature/);
  assert.match(P.render('readings', { room: 'hallway_upstairs' }, withRooms([quietRoom('hallway_upstairs')], [], { 'sensor.hallway_upstairs_sensor_motion_illuminance': b('5', { unit_of_measurement: 'lx' }) }), NOW), /Light level/);
  assert.doesNotMatch(P.render('readings', { room: 'parlour' }, room({}, {}), NOW), /Light level/);
  const sub = (over) => P.render('readings', { room: 'parlour' }, room(over), NOW).match(/Temperature[\s\S]*?hm-ws">([^<]*)</)[1];
  assert.equal(sub({ hvac_action: 'idle' }), 'Target 19.0°');
  assert.equal(sub({ hvac_action: 'off' }), 'Not heating');
  assert.equal(sub({ hvac_action: null }), 'Target 19.0°');
  assert.equal(sub({ hvac_action: 'idle', target: null }), 'Not heating');
  assert.equal(P.render('readings', { room: 'hallway_upstairs' }, withRooms([quietRoom('hallway_upstairs')], []), NOW), '', 'nothing to show, nothing drawn');
  for (const k of INDOOR_KEYS) {
    assert.equal(P.ROOMS[k].lux, `sensor.${k}_sensor_motion_illuminance`, k);
    assert.ok(helperIds.has(`input_number.${k}_automation_lux_threshold_dark`), `${k}: its threshold is a real helper`);
  }
  for (const g of GARDENS) assert.equal(P.ROOMS[g].lux, undefined);
  assert.match(rule('.hm-wgrid').body, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(rule('.hm-w:only-child').body, /grid-column:1\/-1/);
  assert.match(rule('.hm-w').body, /background:#1a1f26;border-radius:20px;padding:14px 16px/);
  assert.match(rule('.hm-wv').body, /font-size:34px/);
  assert.throws(() => P.render('readings', { room: 'front_garden' }, mk(), NOW), /indoor rooms/);
});

ok('Scenes: a two-column grid of real buttons, the active one in the tint; the lights note sits under it', () => {
  const html = P.render('lights', { room: 'parlour' }, mk(), NOW);
  assert.match(html, /<h2>Scenes<\/h2><\/div><div class="hm-scenes"><button type="button" class="hm-scene" data-act="scene" data-entity="scene\.parlour_all" aria-pressed="false"><svg/);
  assert.match(html, /<button type="button" class="hm-scene on" data-act="scene" data-entity="scene\.parlour_lamps" aria-pressed="true">/);
  assert.match(rule('.hm-scenes').body, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(rule('.hm-scene').body, /min-height:76px;padding:12px 14px;border:0;border-radius:16px/);
  assert.match(rule('.hm-scene').body, /font-size:15px[^}]*font-weight:600/);
  assert.match(rule('.hm-scene').body, /background:#1a1f26/);
  assert.match(rule('.hm-scene.on').body, /background:#f2c46b;color:#1d1708/);
});

ok('settings: groups per room, in subsystem order, with the plan rows', () => {
  const groups = (k) => groupsOf(sheet(k));
  for (const k of ['parlour', 'hallway_downstairs', 'bedroom']) assert.deepEqual(groups(k), ['lights', 'heating', 'presence'], k);
  assert.deepEqual(groups('hallway_upstairs'), ['lights', 'presence']);
  assert.deepEqual(groups('kitchen'), ['lights', 'heating', 'presence', 'media']);
  assert.deepEqual(groups('home_office'), ['lights', 'heating', 'presence', 'media']);
  assert.deepEqual(groups('bathroom'), ['lights', 'heating', 'presence', 'fan']);
  assert.deepEqual(groups('foreign_office'), ['lights', 'heating', 'presence']);
  assert.deepEqual(groups('front_garden'), ['lights']);
  assert.deepEqual(groups('back_garden'), ['lights']);
  const ids = (k) => [...sheet(k).matchAll(/data-act="setting-(?:toggle|number)" data-room="(\w+)" data-group="(\w+)" data-key="(\w+)"/g)].map((m) => `${m[2]}/${m[3]}`);
  assert.ok(ids('bathroom').includes('fan/automation') && ids('bathroom').includes('fan/min_run') && ids('bathroom').includes('lights/lux_dark'));
  assert.ok(ids('front_garden').includes('lights/calendar'), 'Follow calendar is a front garden setting');
  assert.ok(!ids('back_garden').includes('lights/calendar'));
  assert.ok(!ids('bedroom').some((x) => x.startsWith('fan/')), 'a room with no fan has no Fan group');
  assert.doesNotMatch(sheet('bedroom'), /Fan automation/);
  assert.ok(!ids('parlour').includes('media/sonos'));
  // Keep room occupied acts now, so it is not a setting.
  for (const k of P.ALL_ROOM_KEYS) assert.doesNotMatch(sheet(k), /presence_override|Keep room occupied/, k);
  // Shower calibration stays in HA settings.
  assert.doesNotMatch(sheet('bathroom'), /shower_rise|above_baseline|end_drop|end_confirm/);
  assert.doesNotMatch(JSON.stringify(P.ROOM_SETTINGS), /shower_/);
});

ok('settings: foreign office door heating steppers and the Sonos follow toggles', () => {
  const html = sheet('foreign_office', sheetHass({
    'input_number.foreign_office_automation_door_open_delta': b('2.5'), 'input_number.foreign_office_automation_door_open_min_outdoor': b('8'),
    'input_number.foreign_office_automation_door_indoor_comfort_threshold': b('24'), 'input_number.foreign_office_automation_door_notification_cooldown_mins': b('60'),
  }));
  const heating = html;
  for (const [key, shown] of [['door_delta', '2.5°'], ['door_min_outdoor', '8.0°'], ['door_comfort', '24.0°'], ['door_cooldown', '60 min']]) {
    assert.match(heating, new RegExp(`data-act="setting-number" data-room="foreign_office" data-group="heating" data-key="${key}" data-delta="1"`), key);
    assert.ok(heating.includes(shown), `${key} shows ${shown}`);
  }
  for (const k of ['kitchen', 'home_office']) {
    const media = sheet(k);
    assert.match(media, new RegExp(`data-act="setting-toggle" data-room="${k}" data-group="media" data-key="sonos" aria-pressed="true"`), k);
    const calls = [];
    const h = { ...sheetHass({ [`input_boolean.${k}_automation_sonos_enabled`]: b('on') }), callService: (...a) => calls.push(a) };
    P.handleAction(h, { dataset: { act: 'setting-toggle', room: k, group: 'media', key: 'sonos' } });
    assert.deepEqual(calls, [['input_boolean', 'turn_off', { entity_id: `input_boolean.${k}_automation_sonos_enabled` }]], k);
  }
  assert.doesNotMatch(sheet('bedroom'), /Follow the speaker group/);
  const calls = [];
  const h = { ...sheetHass(), callService: (...a) => calls.push(a) };
  const tap = (key, delta) => P.handleAction(h, { dataset: { act: 'setting-number', room: 'foreign_office', group: 'heating', key, delta } });
  h.states['input_number.foreign_office_automation_door_open_delta'] = b('10');
  h.states['input_number.foreign_office_automation_door_notification_cooldown_mins'] = b('15');
  tap('door_delta', '1'); tap('door_cooldown', '-1'); tap('door_delta', '-1'); tap('door_cooldown', '1');
  assert.deepEqual(calls.map((c) => c[2].value), [10, 15, 9.5, 30], 'clamped at the ends, stepped in between');
});

ok('settings: the stepper ranges equal the expected clamps, and sit inside the helper ranges HA enforces', () => {
  const steppers = settingRows().filter((x) => x.row.kind === 'number').map((x) => x.row);
  for (const r of steppers) {
    const want = luxId.test(r.id) ? [0, 500] : EXPECTED_CLAMPS[r.id];
    assert.ok(want, `${r.id} has an expected clamp`);
    assert.deepEqual([r.min, r.max], want, r.id);
    const h = helpersYaml.input_number[r.id.split('.')[1]];
    assert.ok(h, `${r.id} is a helper`);
    assert.ok(r.min >= h.min && r.max <= h.max, `${r.id} stays inside the helper's ${h.min}..${h.max}`);
    assert.ok(r.step >= h.step && Math.abs(r.step / h.step - Math.round(r.step / h.step)) < 1e-9, `${r.id} steps in multiples of the helper step`);
  }
  for (const id of Object.keys(EXPECTED_CLAMPS)) assert.ok(steppers.some((r) => r.id === id), `${id} is offered`);
  // The fan clamps are the controller's (homerun-automations lib/bathroom/steam.ts): 5-30, 15-120, 2-30.
  assert.ok(Object.keys(EXPECTED_CLAMPS).filter((id) => /foreign_office/.test(id)).length === 4, 'the clamp list includes the foreign office numbers');
});

ok('settings: steppers clamp to the table and snap to the step; a toggle flips only its helper', () => {
  const calls = [];
  const h = { ...sheetHass({ 'input_number.bathroom_automation_fan_min_run': b('30'), 'input_number.bathroom_automation_fan_max_run': b('15'), 'input_number.bathroom_automation_fan_humidity_margin': b('10'), 'input_number.bathroom_automation_lux_threshold_dark': b('499'), 'input_boolean.bathroom_automation_fan_enabled': b('off') }), callService: (...a) => calls.push(a) };
  const num = (key, delta, group = 'fan') => P.handleAction(h, { dataset: { act: 'setting-number', room: 'bathroom', group, key, delta } });
  num('min_run', '1'); num('max_run', '-1'); num('margin', '1'); num('lux_dark', '1', 'lights'); num('lux_dark', '1', 'lights');
  assert.deepEqual(calls.map((c) => [c[0], c[1], c[2].entity_id, c[2].value]), [
    ['input_number', 'set_value', 'input_number.bathroom_automation_fan_min_run', 30],
    ['input_number', 'set_value', 'input_number.bathroom_automation_fan_max_run', 15],
    ['input_number', 'set_value', 'input_number.bathroom_automation_fan_humidity_margin', 11],
    ['input_number', 'set_value', 'input_number.bathroom_automation_lux_threshold_dark', 500],
    ['input_number', 'set_value', 'input_number.bathroom_automation_lux_threshold_dark', 500],
  ]);
  calls.length = 0;
  P.handleAction(h, { dataset: { act: 'setting-toggle', room: 'bathroom', group: 'fan', key: 'automation' } });
  assert.deepEqual(calls, [['input_boolean', 'turn_on', { entity_id: 'input_boolean.bathroom_automation_fan_enabled' }]]);
  // The step snaps an off-grid value (the helper is stepped by 1, the card by 5).
  calls.length = 0;
  h.states['input_number.bathroom_automation_fan_min_run'] = b('12');
  num('min_run', '1');
  assert.equal(calls[0][2].value, 15);
});

ok('settings: every row writes only its own table helper; unknown and prototype keys, and a kind mismatch, throw', () => {
  for (const { room, group, row } of settingRows()) {
    const calls = [];
    const h = { ...sheetHass({ [row.id]: b(row.kind === 'toggle' ? 'off' : String((row.min + row.max) / 2)) }), callService: (...a) => calls.push(a) };
    const act = row.kind === 'toggle' ? 'setting-toggle' : 'setting-number';
    P.handleAction(h, { dataset: { act, room, group, key: row.key, delta: '1' } });
    assert.equal(calls.length, 1, `${room}/${group}/${row.key}`);
    assert.equal(calls[0][2].entity_id, row.id, `${room}/${group}/${row.key} writes ${row.id}`);
    assert.equal(calls[0][0], row.kind === 'toggle' ? 'input_boolean' : 'input_number');
    assert.deepEqual(P.pendingStart({ pending: {} }, h, { act, room, group, key: row.key, delta: '1' }, NOW) && true, true, 'pending tracks the same helper');
  }
  const h = { ...sheetHass(), callService: () => assert.fail('must not write') };
  const bad = (ds) => assert.throws(() => P.handleAction(h, { dataset: ds }), /unknown setting|not a (toggle|number)/);
  bad({ act: 'setting-toggle', room: 'bathroom', group: 'fan', key: 'nope' });
  bad({ act: 'setting-toggle', room: 'bathroom', group: 'fan', key: '__proto__' });
  bad({ act: 'setting-toggle', room: 'bathroom', group: 'fan', key: 'constructor' });
  bad({ act: 'setting-toggle', room: 'bathroom', group: '__proto__', key: 'automation' });
  bad({ act: 'setting-toggle', room: '__proto__', group: 'fan', key: 'automation' });
  bad({ act: 'setting-toggle', room: 'toString', group: 'fan', key: 'automation' });
  bad({ act: 'setting-toggle', room: 'bedroom', group: 'fan', key: 'automation' });
  bad({ act: 'setting-toggle', room: 'bathroom', group: 'fan', key: 'min_run' });
  bad({ act: 'setting-number', room: 'bathroom', group: 'fan', key: 'automation', delta: '1' });
  bad({ act: 'setting-number', room: 'bathroom', group: 'fan', key: 'shower_rise', delta: '1' });
});

ok('settings: a tap on a settings control writes nothing outside the table even if the element names another entity', () => {
  const calls = [];
  const h = { ...sheetHass(), callService: (...a) => calls.push(a) };
  P.handleAction(h, { dataset: { act: 'setting-toggle', room: 'bathroom', group: 'fan', key: 'automation', entity: 'light.bathroom_light_ceiling' } });
  assert.equal(calls[0][2].entity_id, 'input_boolean.bathroom_automation_fan_enabled');
});

ok('settings: rows with a missing or unusable helper are hidden and an empty list is not shown', () => {
  // hallway_upstairs has no heating automation: its table has no Heating group.
  assert.deepEqual(groupsOf(sheet('hallway_upstairs')), ['lights', 'presence']);
  const noLux = sheet('bedroom', sheetHass({ 'input_number.bedroom_automation_lux_threshold_dark': null }));
  assert.doesNotMatch(noLux, /Dark below/);
  assert.match(noLux, /Lights automation/, 'the other Lights row stays');
  const unusable = sheet('bedroom', sheetHass({ 'input_number.bedroom_automation_lux_threshold_dark': b('unavailable'), 'input_boolean.bedroom_sensor_motion_enabled': b('unknown') }));
  assert.doesNotMatch(unusable, /Dark below|Motion sensor/);
  assert.deepEqual(groupsOf(unusable), ['lights', 'heating'], 'Presence has no usable row');
  const fanGone = sheet('bathroom', sheetHass(Object.fromEntries(['input_boolean.bathroom_automation_fan_enabled', 'input_number.bathroom_automation_fan_min_run', 'input_number.bathroom_automation_fan_max_run', 'input_number.bathroom_automation_fan_humidity_margin'].map((x) => [x, null]))));
  assert.doesNotMatch(groupsOf(fanGone).join(), /fan/);
  const partial = sheet('bathroom', sheetHass({ 'input_number.bathroom_automation_fan_max_run': b('unknown') }));
  assert.match(partial, /Minimum run/);
  assert.doesNotMatch(partial, /Maximum run/);
  assert.doesNotMatch(partial, /Maximum run: /, 'and no footnote for a row that is not shown');
  // Nothing readable at all: no list rather than a blank one.
  assert.equal(P.render('automation', { room: 'kitchen' }, mk(), NOW), '');
});

ok('settings: every row names a helper that exists in packages/helpers.yaml, with no exceptions', () => {
  const missing = settingRows().filter(({ row }) => !helperIds.has(row.id)).map(({ room, group, row }) => `${room}/${group}/${row.key}`);
  assert.deepEqual(missing, []);
  for (const { row } of settingRows()) assert.match(row.id, row.kind === 'toggle' ? /^input_boolean\.\w+$/ : /^input_number\.\w+$/);
});

ok('settings: the room page no longer renders Automations, the fan steppers, or Follow calendar', () => {
  assert.throws(() => P.render('automations', { room: 'bedroom' }, mk(), NOW), /unknown mode/);
  const tpl = loadYaml('info_templates.yaml');
  for (const t of ['pulse_room', 'pulse_garden']) assert.ok(!tpl[t].card.cards.some((c) => c.mode === 'automations'), t);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /FAN_NUMBERS|fan-number|sectionAutomations/);
  for (const k of P.ALL_ROOM_KEYS) {
    const page = ['room-head', ...(GARDENS.includes(k) ? GARDEN_MODES : INDOOR_MODES), 'room-feed'].map((m) => P.render(m, { room: k }, sheetHass(), NOW)).join('');
    assert.doesNotMatch(page, /Automations<|Lights automation|Heating automation|Fan automation|Follow calendar|data-act="setting-/, k);
  }
});

ok('settings: the streamline defaults still live in `default` and the template substitution leaves no placeholder', () => {
  const tpl = loadYaml('info_templates.yaml');
  for (const [name, t] of Object.entries(tpl)) {
    assert.equal(t.variables, undefined, name);
    const vars = streamlineVars(t, { room: 'bathroom' });
    assert.doesNotMatch(JSON.stringify(substitute(t.card, vars)), /\[\[[^\]]*\]\]/, name);
  }
  assert.ok(Array.isArray(tpl.pulse_room.default) && Array.isArray(tpl.pulse_garden.default));
});

ok('Mo toggles: two switches on the Settings page that write only their own helpers', () => {
  const hass = mk({ 'input_boolean.mo_notifications_spotted_enabled': b('on'), 'input_boolean.mo_notifications_eating_enabled': b('off') });
  const html = P.render('house-mo', {}, hass, NOW);
  assert.deepEqual([...html.matchAll(/class="lbl"[^>]*>([^<]+)</g)].map((m) => m[1]), ['Mo']);
  assert.match(html, /data-act="mo-toggle" data-key="spotted" aria-pressed="true"/);
  assert.match(html, /data-act="mo-toggle" data-key="eating" aria-pressed="false"/);
  assert.doesNotMatch(html, /data-entity/, 'the page never names an entity id');
  assert.equal(P.render('house-mo', {}, mk(), NOW), '', 'hidden when neither helper exists');
  assert.doesNotMatch(P.render('house-mo', {}, mk({ 'input_boolean.mo_notifications_eating_enabled': b('unavailable') }), NOW), /eating/);
  const calls = [];
  const h = { ...hass, callService: (...a) => calls.push(a) };
  P.handleAction(h, { dataset: { act: 'mo-toggle', key: 'spotted' } });
  P.handleAction(h, { dataset: { act: 'mo-toggle', key: 'eating', entity: 'light.parlour_light_floor_lamp' } });
  assert.deepEqual(calls, [
    ['input_boolean', 'turn_off', { entity_id: 'input_boolean.mo_notifications_spotted_enabled' }],
    ['input_boolean', 'turn_on', { entity_id: 'input_boolean.mo_notifications_eating_enabled' }],
  ]);
  for (const key of ['nope', '__proto__', 'constructor', 'toString', '']) assert.throws(() => P.handleAction(h, { dataset: { act: 'mo-toggle', key } }), /unknown Mo setting/, key);
  assert.deepEqual(Object.values(P.MO_TOGGLES).map((d) => d.id), ['input_boolean.mo_notifications_spotted_enabled', 'input_boolean.mo_notifications_eating_enabled']);
  for (const d of Object.values(P.MO_TOGGLES)) assert.ok(helperIds.has(d.id), d.id);
  const settingsView = loadYaml('views/info-settings.yaml');
  assert.ok(settingsView.sections[0].cards.some((c) => c.mode === 'house-mo'), 'on the Settings page');
  assert.ok(!settingsView.sections[0].cards.some((c) => c.mode === 'house-mo' && c.room), 'not a room setting');
});

await okAsync('card element: a repaint puts keyboard focus back on the control that had it (a stepper tapped twice)', async () => {
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

await okAsync('card element: tapping a disclosure row opens it, remembers it in localStorage, and a hass update keeps it open', async () => {
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

ok('lights note: a declined decision reads time first, no "Didn\'t act" prefix', () => {
  const hass = withRooms([{ ...FULL('kitchen'), manual: null, pres_labels: [], labels: [], occupied: true, lights_on: 0 }], [], histSensor('kitchen', [luxHigh(1), histEntry(30)]));
  const html = P.render('lights', { room: 'kitchen' }, hass, NOW);
  assert.match(html, /<p class="hm-foot">Stayed off at 18:41: bright enough \(85 lx, on at 40 or below\)<\/p>/);
  assert.doesNotMatch(html, /Didn.t act|Didn&#39;t act/);
  assert.equal(P.REASON_TEXT['lighting:lux_high']({ lux: 85, lux_threshold: 40 }, {}), 'Stayed off: bright enough (85 lx, on at 40 or below)', 'REASON_TEXT is untouched');
});

ok('presence: no trailing value when nothing holds the room, and no action either (supersedes the old Clear pin)', () => {
  const html = P.render('presence', { room: 'parlour' }, withRooms([quietRoom('parlour', { occupied: false, pres_labels: [] })], []), NOW);
  assert.doesNotMatch(html, /hm-val|Clear/);
  assert.doesNotMatch(html, /data-act="clear/);
  const held = P.render('presence', { room: 'parlour' }, withRooms([quietRoom('parlour', { occupied: true, pres_labels: ['Bed occupied'] })], []), NOW);
  assert.match(held, /<span class="hm-val num">Bed<\/span>/, 'a hold keeps a value: its short label');
});

// ── Render cost: memoised parses, per-pass room models, skipped renders ──────────────────────────
// HA hands the card a new hass object on every update, with a new state object only for entities that changed.
const update = (hass, over = {}, extra = {}) => {
  const states = { ...hass.states };
  for (const [id, v] of Object.entries(over)) { if (v === null) delete states[id]; else states[id] = v; }
  return { ...hass, ...extra, states };
};
const richHass = () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const hist = Object.assign({}, ...P.ALL_ROOM_KEYS.map((k) => histSensor(k, [histEntry(3, { location: k }), luxHigh(9)])), histSensor('house', [histEntry(5, { location: 'house' })]));
  return withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }], {
    ...hist,
    'switch.kitchen_camera_privacy': { state: 'off', attributes: {} },
    'sensor.unrelated_0': { state: '0', attributes: {} },
  });
};
// Every section the harness can render, as [label, mode, config, ui].
const allCards = () => {
  const cards = [];
  for (const m of ALL_MODES) cards.push([m, m, {}, {}]);
  for (const k of P.ALL_ROOM_KEYS) for (const m of modesFor(k)) cards.push([`${m}:${k}`, m, { room: k }, {}]);
  for (const c of ['parlour', 'kitchen', 'home_office']) cards.push([`camera:${c}`, 'camera', { camera: c }, {}]);
  cards.push(['cameras-head', 'cameras-head', {}, {}]);
  for (const m of ['house-head', 'house-mode', 'house-people', 'house-heating', 'house-mo']) cards.push([m, m, {}, {}]);
  return cards;
};

ok('render cost: a parsed attribute is the same object for the same state object, and re-parsed after replacement', () => {
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

ok('render cost: output is byte-identical with and without the optimisations, for every section and the gate', () => {
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

ok('disclosure: the render gate skips an unchanged repaint, redraws on a toggle and keeps the state across a hass update', () => {
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

ok('render cost: an unrelated entity change skips, a read entity, the registry, config or ui re-render', () => {
  const hass = richHass();
  const g = P.makeRenderGate();
  const cfg = { room: 'bedroom' };
  const ui = {};
  assert.equal(g.run('readings', cfg, hass, NOW, ui, false).skipped, false, 'first run renders');
  const un = update(hass, { 'sensor.unrelated_0': { state: '5', attributes: {} }, 'sensor.brand_new': { state: 'x', attributes: {} } });
  assert.equal(g.run('readings', cfg, un, NOW + 1000, ui, false).skipped, true, 'unrelated change');
  assert.equal(g.run('readings', cfg, hass, NOW + 2000, ui, false).skipped, true, 'same hass');
  assert.equal(g.run('readings', cfg, un, NOW + 3000, ui, true).skipped, false, 'forced');
  // A read entity: the room report, then a plain state the model falls back on.
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), temp: k === 'bedroom' ? 23.1 : 20.8 }));
  const changed = update(un, { 'sensor.info_rooms': { state: 'ok', attributes: { rooms: JSON.stringify(rooms) } } });
  const r = g.run('readings', cfg, changed, NOW + 4000, ui, false);
  assert.equal(r.skipped, false, 'read entity');
  assert.match(r.html, /23\.1°/);
  assert.equal(g.run('readings', cfg, update(changed, {}), NOW + 5000, ui, false).skipped, true);
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
  assert.equal(g.run('readings', { room: 'bedroom' }, afterReg, NOW + 7000, ui, false).skipped, false, 'a new mode');
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

ok('render cost: listing the states is tracked by the ids, so a new scene shows', () => {
  const hass = richHass();
  const g = P.makeRenderGate();
  const cfg = { room: 'front_garden' };
  g.run('garden-theme', cfg, hass, NOW, {}, false);
  assert.equal(g.run('garden-theme', cfg, update(hass, { 'sensor.unrelated_0': { state: '9', attributes: {} } }), NOW + 1, {}, false).skipped, true);
  const scene = { state: '2026-10-25T18:00:00+00:00', attributes: {} };
  assert.equal(g.run('garden-theme', cfg, update(hass, { 'scene.front_garden_normal': scene }), NOW + 2, {}, false).skipped, false);
});

ok('render cost: relative-time text refreshes after the maximum age and never goes backwards in time', () => {
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

ok('render cost: a throwing render is not cached, and the pass state is restored', () => {
  const hass = richHass();
  const g = P.makeRenderGate();
  assert.throws(() => g.run('heating', { room: 'nowhere' }, hass, NOW, {}, false), /known room/);
  assert.throws(() => g.run('heating', { room: 'nowhere' }, hass, NOW, {}, false), /known room/);
  assert.equal(g.run('heating', { room: 'bedroom' }, hass, NOW, {}, false).skipped, false);
  // After a render has thrown, a direct roomModel call is fresh, not served from a finished pass.
  const a = P.roomModel(hass, 'bedroom');
  assert.notEqual(P.roomModel(hass, 'bedroom'), a);
});

ok('render cost: measured skip rate over hass updates where only unrelated entities change', () => {
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

ok('render cost: the card only skips on a hass update', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const paints = [...src.matchAll(/this\._paint\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(paints.filter((a) => a === 'true').length, 1, 'only `set hass` passes true');
  assert.match(src, /set hass\(hass\) \{[^}]*this\._paint\(true\)/s);
  assert.match(src, /!fromHass/);
});

// ── Pulse home-page UX tweaks ───────────────────────────────────────────────────────────────────
ok('House list: Heating, Cameras, Bins in that order under one "House" header, after the rooms card that ends with Outside', () => {
  const html = P.render('house-list', {}, mk(), NOW);
  assert.match(html, /^<div class="p"><div class="hm"><section class="hm-sec"><div class="hm-h"><h2>House<\/h2><\/div>/);
  const rooms = P.render('rooms', {}, withRooms(calmRooms(), []), NOW);
  assert.ok(rooms.lastIndexOf('<h2>Outside') > -1 && !rooms.includes('<h2>House'));
  const cams = mk({ 'switch.parlour_privacy': { state: 'on', attributes: {} } });
  const titles = [...P.render('house-list', {}, cams, NOW).matchAll(/class="hm-rt">([^<]*)</g)].map((m) => m[1]);
  assert.equal(titles.length, 3);
  assert.match(titles[0], /^Boiler|^Heating off$/);
  assert.match(titles[1], /cameras/i);
  assert.equal(titles[2], 'Refuse');
  const modes = yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8')).sections[0].cards.map((c) => c.mode);
  assert.deepEqual(modes.slice(modes.indexOf('rooms')), ['rooms', 'house-list', 'feed', 'tabbar']);
});

ok('House list tiles and trailing links: heating tile, cameras tile, bins tile; heating and cameras link, bins does not', () => {
  const cams = mk({ 'switch.parlour_privacy': { state: 'on', attributes: {} }, 'switch.kitchen_privacy': { state: 'on', attributes: {} }, 'switch.home_office_privacy': { state: 'on', attributes: {} } });
  const html = P.render('house-list', {}, cams, NOW);
  const heat = rowOf(html, P.SETTINGS_PATH);
  assert.equal(tileStyle(heat), 'background:#ff6b35;color:#000000');
  assert.ok(heat.includes(P.ICON.flameFull), 'the heating tile uses the full-size flame, not the small inline one');
  assert.doesNotMatch(heat, /d="M12 3c1 3 4/);
  assert.match(heat, /<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"/, 'an 18px solid glyph like the other tiles');
  assert.match(P.ICON.flameFull, /^M12 2\.5c/, 'spans nearly the full 24 box (top at 2.5)');
  const camRow = rowOf(html, P.CAMERAS_PATH);
  assert.equal(tileStyle(camRow), 'background:#636366;color:#ffffff');
  const bins = html.match(/<div class="hm-row"><span class="hm-tile"[^>]*>[\s\S]*?<\/div><\/div>/)[0];
  assert.match(bins, /background:#32ade6;color:#000000/);
  assert.doesNotMatch(bins, /hm-chev|data-path/, 'bins has no page to open');
  const offline = P.render('house-list', {}, mk({ 'switch.parlour_privacy': { state: 'unavailable', attributes: {}, last_changed: '2026-10-26T12:00:00+00:00' }, 'switch.kitchen_privacy': { state: 'on', attributes: {} }, 'switch.home_office_privacy': { state: 'on', attributes: {} } }), NOW);
  assert.equal(tileStyle(rowOf(offline, P.CAMERAS_PATH)), 'background:#f2b84b;color:#000000', 'an offline camera takes the attention tile');
  assert.match(rowSub(rowOf(offline, P.CAMERAS_PATH)), /offline$/);
  const today = P.render('house-list', {}, mk({ 'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '0', attributes: {} } }), NOW);
  assert.match(today, /Collected today/);
  const far = P.render('house-list', {}, mk({ 'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '5', attributes: {} }, 'sensor.st_albans_collect_domestic_food_days_until_collection': { state: '9', attributes: {} } }), NOW);
  assert.match(far, /<div class="hm-rt">Refuse<\/div><div class="hm-rs">Collected in 5 days</, 'not soon: the subtitle keeps the secondary colour');
});

ok('heating row: short title; the room count leads the subtitle only when heating is on and rooms are calling', () => {
  const heat = (extra, rooms) => P.render('house-list', {}, withRooms(calmRooms(rooms), [], { 'sensor.house_average_temperature': { state: '17.7', attributes: {} }, 'weather.forecast_home': { state: 'cloudy', attributes: { temperature: 3.7 } }, ...extra }), NOW);
  const sub = (html) => rowSub(rowOf(html, P.SETTINGS_PATH));
  const three = heat({}, { kitchen: { hvac_action: 'heating' }, parlour: { hvac_action: 'heating' }, bedroom: { hvac_action: 'heating' } });
  assert.equal(rowTitle(rowOf(three, P.SETTINGS_PATH)), 'Boiler firing');
  assert.equal(sub(three), '3 rooms heating · 17.7° in, 3.7° out');
  assert.equal(sub(heat({}, { kitchen: { hvac_action: 'heating' } })), '1 room heating · 17.7° in, 3.7° out');
  assert.equal(sub(heat({}, {})), '17.7° in, 3.7° out', 'no count at 0');
  const off = heat({ 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } }, { kitchen: { hvac_action: 'heating' } });
  assert.equal(rowTitle(rowOf(off, P.SETTINGS_PATH)), 'Heating off');
  assert.equal(sub(off), '17.7° in, 3.7° out', 'no count when heating is off');
  assert.equal(sub(heat({ 'input_boolean.patio_door_heating_suspended': { state: 'on', attributes: {} } }, { kitchen: { hvac_action: 'heating' } })), '1 room heating · 17.7° in, 3.7° out · patio open');
  assert.equal(sub(heat({ 'input_boolean.patio_door_heating_suspended': { state: 'on', attributes: {} } }, {})), '17.7° in, 3.7° out · patio open');
  assert.equal(rowTitle(rowOf(heat({ 'binary_sensor.house_heating_boiler_firing': { state: 'off', attributes: {} } }, {}), P.SETTINGS_PATH)), 'Boiler idle');
  assert.equal(sub(P.render('house-list', {}, { states: {} }, NOW)), 'no readings');
  assert.match(P.STYLE, /\.hm-rs\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap/, 'a long subtitle ellipsises on one line');
});

ok('feed: suppress sources get a plain phrase from a table, unknown sources keep the friendly name', () => {
  assert.equal(P.SUPPRESS_SOURCES['binary_sensor.hallway_upstairs_bed_occupied_sync'], 'someone in bed');
  const hass = mk({ 'binary_sensor.kitchen_monitor': { state: 'on', attributes: { friendly_name: 'Kitchen monitor' } } });
  const text = (source) => P.sentenceFor(histEntry(1, { subsystem: 'lighting', decision: 'no_action', reason: 'external_suppress_active', outcome: 'declined', facts: { source } }), hass).text;
  assert.equal(text('binary_sensor.hallway_upstairs_bed_occupied_sync'), 'Stayed off: someone in bed');
  assert.equal(text('binary_sensor.kitchen_monitor'), 'Stayed off: held off by Kitchen monitor');
  assert.equal(text('input_boolean.unknown_thing'), 'Stayed off: held off by input_boolean.unknown_thing');
  assert.equal(text(undefined), 'Stayed off: held off by something else');
  assert.equal(text('toString'), 'Stayed off: held off by toString', 'inherited object keys are not sources');
});

const tlRows = (html) => html.split('<div class="tl-row ').slice(1).map((r) => '<div class="tl-row ' + r);
const dotOf = (row) => row.match(/<i class="tl-dot"([^>]*)><\/i>/)[1];

ok('room feed rows: the timeline, led by the subsystem the entry is about', () => {
  const html = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [histEntry(1), luxHigh(2), histEntry(3, { subsystem: 'weird_new' })])), NOW);
  assert.match(html, /<h2>Activity<\/h2>/);
  const rows = tlRows(html);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.match(/<b class="tl-s">([^<]+)</)[1]), ['Lights', 'Lights', 'Weird'], 'the subsystem noun, not the room the page is about');
  assert.match(rows[1], /class="tl-b" style="color:#a3adba"/, 'a declined decision reads in secondary text');
  assert.match(html, /<b class="tl-s">Weird<\/b> new occupancy off/, 'an unknown subsystem: its prettified id leads');
  assert.doesNotMatch(html, /hm-tile|<svg/, 'no subsystem tiles on activity rows');
  const quiet = P.render('room-feed', { room: 'kitchen' }, mk(), NOW);
  assert.match(quiet, /<div class="hm-row"><div class="hm-text"><div class="hm-rs">Nothing recorded for this room yet<\/div>/);
  assert.match(P.STYLE, /\.feed\{[^\n]*grid-template-columns:44px 16px minmax\(0,1fr\)/, 'the camera card still uses the older feed line');
});

ok('House activity rows: subject, verb part, reason part; dot in the subsystem colour', () => {
  const house = [histEntry(1, { location: 'hallway_upstairs' }), luxHigh(2), histEntry(3, { location: 'house', subsystem: 'weird_new' })];
  const html = P.render('feed', {}, mk(histSensor('house', house)), NOW);
  const rows = tlRows(html);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /<b class="tl-s">Hallway up<\/b> lights off<span style="color:#a3adba"> · room empty<\/span>/);
  assert.match(rows[2], /<b class="tl-s">Weird<\/b> new occupancy off/);
  assert.equal(dotOf(rows[0]), ' style="background:#ffd60a"', 'acted: filled with the subsystem colour');
  assert.equal(dotOf(rows[1]), ' style="border-color:#ffd60a"', 'declined: a ring in the subsystem colour');
  assert.match(rows[1], /class="tl-row declined">/);
  assert.match(rows[1], /class="tl-b" style="color:#a3adba"><b class="tl-s">Kitchen<\/b> stayed off/, 'declined sentence is secondary text');
  assert.equal(dotOf(rows[2]), ' style="background:#a3adba"', 'no subsystem colour: secondary text');
  const quiet = P.render('feed', {}, mk(), NOW);
  assert.match(quiet, /Nothing recorded yet/);
  assert.match(quiet, /<h2>Activity<\/h2>/);
  // A subsystem colour that would vanish on the surface falls back to secondary text.
  const cams = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'house', subsystem: 'cameras', decision: 'no_action', reason: 'x', outcome: 'declined' })])), NOW);
  assert.equal(dotOf(tlRows(cams)[0]), ' style="border-color:#a3adba"');
  const problem = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unhandled_error' }, location: 'house' })])), NOW);
  assert.match(problem, /class="tl-row problem"><span class="tl-t num">18:41<\/span><span class="tl-rail" aria-hidden="true"><i class="tl-dot"><\/i><\/span><div class="tl-b" style="color:#f2b84b"><b class="tl-s">[^<]*<\/b>[^<]*Couldn&#39;t run|couldn&#39;t run: it failed unexpectedly/, 'a problem: attention dot and text');
  assert.match(P.STYLE, /\.tl-row\.problem \.tl-dot\{[^}]*background:#f2b84b/);
});

ok('timeline CSS: 52px time, 20px rail, 12px dots, 10px gap, 14/12 padding, 2px rail line from the first dot to the last', () => {
  const row = rule('.tl-row').body;
  assert.equal(decl(row, 'grid-template-columns'), '52px 20px minmax(0,1fr)');
  assert.equal(px(decl(row, 'column-gap')), 10);
  assert.equal(decl(row, 'padding'), '6px 14px 6px 12px');
  assert.equal(px(decl(rule('.hm-list.tl').body, 'padding').split(' ')[0]), 6, 'the container keeps its 6px vertical padding');
  const t = rule('.tl-t').body;
  assert.match(t, /text-align:right/);
  assert.equal(px(decl(t, 'font-size')), 14);
  assert.equal(px(decl(t, 'line-height')), px(decl(rule('.tl-b').body, 'line-height')), 'the time shares the first text line');
  const dot = rule('.tl-dot').body;
  assert.equal([px(decl(dot, 'width')), px(decl(dot, 'height'))].join('x'), '12x12');
  const rail = rule('.tl-rail::before').body;
  assert.equal(px(decl(rail, 'width')), 2);
  assert.equal(px(decl(rail, 'left')) + 1, 10, 'the line is centred in the 20px column');
  assert.equal(px(decl(dot, 'left')) + 6, 10, 'and so is the dot');
  // Line ends sit on the dot centres: the rail cell reaches the row edges, the dot top plus 6 is its centre.
  assert.equal(px(decl(rule('.tl-rail').body, 'margin').split(' ')[0]), -6);
  const centre = px(decl(dot, 'top')) + 6;
  assert.equal(px(decl(rule('.tl-row:first-child .tl-rail::before').body, 'top')), centre);
  assert.equal(px(decl(rule('.tl-row:last-child .tl-rail::before').body, 'height')), centre);
  assert.equal(decl(rail, 'background'), '#2f3843');
  assert.equal(px(decl(rule('.tl-h').body, 'font-size')), 15);
  assert.match(rule('.tl-h').body, /font-weight:600;color:#a3adba/);
  assert.match(rule('.tl-b').body, /min-width:0/, 'a long sentence wraps inside its column at 360px');
});

ok('timeline: day groups, time shown once per minute, subject sharing, hidden decoration', () => {
  const mins = (m, over) => histEntry(m, over);
  const day = 24 * 60;
  const entries = [mins(1), mins(1, { decision: 'turn_on', reason: 'sunset' }), mins(5), mins(day), mins(day + 3), mins(3 * day)];
  const html = P.render('feed', {}, mk(histSensor('house', entries)), NOW);
  assert.match(html, /<div class="tl-h">Today<\/div>/);
  const all = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', entries.map((e, i) => ({ ...e, reason: 'r' + i })))), NOW);
  assert.deepEqual([...all.matchAll(/<div class="tl-h">([^<]*)<\/div>/g)].map((m) => m[1]), ['Today', 'Yesterday', 'Thu 22 Oct']);
  assert.equal(count(all, /<div class="hm-list tl">/g), 3, 'each day is its own container');
  const times = [...all.matchAll(/<span class="tl-t num">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(times, ['18:41', '', '18:37', '18:42', '18:39', '18:42'], 'a repeated minute in a day group leaves the cell empty');
  assert.equal(count(all, /<i class="tl-dot"[^>]*><\/i>/g), 6);
  assert.equal(count(all, /<span class="tl-rail" aria-hidden="true">/g), 6, 'rail and dot are hidden from assistive tech');
  // The day follows the HA time zone, not the viewer's.
  const late = [histEntry(1, { ts: '2026-10-25T23:30:00+00:00' })];
  const nzHass = { ...mk(histSensor('house', late)), config: { time_zone: 'Pacific/Auckland' } };
  assert.match(P.render('feed', {}, nzHass, Date.parse('2026-10-25T23:45:00Z')), /<div class="tl-h">Today<\/div>[^]*?<span class="tl-t num">12:30<\/span>/);
  assert.match(P.render('feed', {}, nzHass, Date.parse('2026-10-26T23:45:00Z')), /<div class="tl-h">Yesterday<\/div>/);
  assert.match(P.render('feed', {}, nzHass, Date.parse('2026-11-05T23:45:00Z')), /<div class="tl-h">Mon 26 Oct<\/div>/);
});

ok('problem rows never show an entity id: friendly name (case kept), else the room on Home or the noun on a room page', () => {
  const failed = histEntry(1, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'error', action: 'scene.turn_on', entity: 'scene.kitchen_all' } });
  const named = (name) => mk({ ...histSensor('house', [failed]), 'scene.kitchen_all': { state: 'unknown', attributes: name ? { friendly_name: name } : {} } });
  const house = (name) => tlRows(P.render('feed', {}, named(name), NOW))[0];
  assert.match(house('Kitchen Cabinets'), /<b class="tl-s">Kitchen<\/b> Cabinets couldn&#39;t be controlled \(turn on\)/, 'a capitalised friendly name keeps its case');
  assert.match(house('hall lamp'), /<b class="tl-s">Kitchen<\/b> hall lamp couldn&#39;t be controlled/, 'a lower-case friendly name is left as it is');
  assert.match(house(''), /<b class="tl-s">Kitchen<\/b> couldn&#39;t be controlled \(turn on\)/, 'no friendly name: the room');
  assert.doesNotMatch(house(''), /scene\.kitchen_all/);
  const roomPage = tlRows(P.render('room-feed', { room: 'kitchen' }, mk({ ...histSensor('kitchen', [failed]) }), NOW))[0];
  assert.match(roomPage, /<b class="tl-s">Lights<\/b> couldn&#39;t be controlled \(turn on\)/, 'a room page falls back to the subsystem noun');
  const whole = tlRows(P.render('feed', {}, mk(histSensor('house', [{ ...failed, location: 'house', subsystem: 'energy' }])), NOW))[0];
  assert.match(whole, /<b class="tl-s">Energy<\/b> couldn&#39;t be controlled/, 'a whole-house entry falls back to the noun');
  const timeout = histEntry(1, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'ack_timeout', entity: 'light.x' } });
  assert.match(tlRows(P.render('feed', {}, mk(histSensor('house', [timeout])), NOW))[0], /<b class="tl-s">Kitchen<\/b> didn&#39;t respond/);
  const guard = histEntry(1, { kind: 'abort', decision: '', reason: 'bed_occupied', outcome: undefined, detail: { abort_kind: 'guard', entity: 'light.unnamed' } });
  const g = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [guard])), NOW);
  assert.doesNotMatch(g, /light\.unnamed/, 'a guard leaves out a device it cannot name');
  const unavailable = histEntry(1, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unavailable_input', entity: 'sensor.nameless' } });
  assert.doesNotMatch(P.render('feed', {}, mk(histSensor('house', [unavailable])), NOW), /sensor\.nameless/);
});

ok('a subsystem word that only names the room state is dropped after a room subject', () => {
  assert.deepEqual(P.timelineLead('Parlour', 'Occupancy marked occupied', { noun: 'Occupancy', implied: true }), { lead: 'Parlour', rest: ' marked occupied' });
  assert.deepEqual(P.timelineLead('Parlour', 'Lights off', { noun: 'Lights' }), { lead: 'Parlour', rest: ' lights off' }, 'a thing (lights) is kept');
  assert.deepEqual(P.timelineLead('Occupancy', 'Occupancy marked occupied', { noun: 'Occupancy', implied: true }), { lead: 'Occupancy', rest: ' marked occupied' }, 'a subsystem subject is not dropped');
  const e = histEntry(1, { location: 'parlour', subsystem: 'occupied', decision: 'set_occupied', reason: 'kitchen_motion_detected', outcome: undefined });
  assert.match(P.render('feed', {}, mk(histSensor('house', [e])), NOW), /<b class="tl-s">Parlour<\/b> marked occupied<span style="color:#a3adba"> · kitchen motion<\/span>/);
  assert.match(P.render('room-feed', { room: 'parlour' }, mk(histSensor('parlour', [e])), NOW), /<b class="tl-s">Occupancy<\/b> marked occupied/);
});

ok('sentence split: the first " · " divides the verb part from the reason part; no separator shows it whole', () => {
  assert.deepEqual(P.splitSentence('Lights off · room empty'), { what: 'Lights off', why: 'room empty' });
  assert.deepEqual(P.splitSentence('Held back · Hall light · bed occupied'), { what: 'Held back', why: 'Hall light · bed occupied' });
  assert.deepEqual(P.splitSentence('Stayed off: bright enough (85 lx)'), { what: 'Stayed off: bright enough (85 lx)', why: '' });
  const lead = (subject, what) => P.timelineLead(subject, what);
  assert.deepEqual(lead('Parlour', 'Lights off'), { lead: 'Parlour', rest: ' lights off' });
  assert.deepEqual(lead('Lights', 'Lights off'), { lead: 'Lights', rest: ' off' }, 'the subject is not repeated');
  assert.deepEqual(lead('House mode', 'House set to away'), { lead: 'House', rest: ' set to away' });
  assert.deepEqual(lead('Cameras', 'Cameras on'), { lead: 'Cameras', rest: ' on' });
  assert.deepEqual(lead('Kitchen', 'Halloween animation started'), { lead: 'Kitchen', rest: ' Halloween animation started' }, 'a proper noun keeps its capital');
  assert.deepEqual(lead('Moments', 'Mo spotted'), { lead: 'Moments', rest: ' Mo spotted' });
  assert.deepEqual(lead('Mo', 'Moment of truth'), { lead: 'Mo', rest: ' moment of truth' }, 'a word that merely begins with the subject is not the subject');
  assert.deepEqual(lead('Energy', 'Spun 2 Octopus wheels'), { lead: 'Energy', rest: ' spun 2 Octopus wheels' });
});

ok('subsystem table: every catalogue subsystem has a noun and an icon that exists; unknown ones fall back', () => {
  const missing = [...new Set(catalog.automations.map((a) => a.subsystem))].filter((x) => !Object.prototype.hasOwnProperty.call(P.SUBSYSTEMS, x));
  assert.deepEqual(missing, [], `subsystems in the catalogue with no feed noun/icon in SUBSYSTEMS: ${missing.join(', ')}`);
  for (const [id, v] of Object.entries(P.SUBSYSTEMS)) {
    assert.ok(typeof v.noun === 'string' && /^[A-Z]/.test(v.noun), `${id}: noun`);
    assert.ok(Object.prototype.hasOwnProperty.call(P.ICON, v.icon), `${id}: icon ${v.icon} is in ICON`);
    for (const t of [v.tile, v.ink]) assert.ok(P.COLOUR_KEYS.includes(t), `${id}: tile token ${t} exists in every theme`);
  }
  assert.deepEqual(P.subsystemOf('brand_new_thing'), { noun: 'Brand new thing', icon: 'dot', tile: '', ink: '' });
  assert.deepEqual(P.subsystemOf('toString'), { noun: 'ToString', icon: 'dot', tile: '', ink: '' }, 'inherited object keys are not subsystems');
});

ok('house feed subject: whole-house rows get the subsystem noun, unless the sentence already opens with it', () => {
  const at = (over) => P.placed(over.location || 'house', over.text, over.subsystem);
  assert.equal(at({ subsystem: 'energy', text: 'Spun 2 Octopus wheels' }), 'Energy · Spun 2 Octopus wheels');
  assert.equal(at({ subsystem: 'house_mode', text: 'Not set to asleep: bed empty' }), 'House mode · Not set to asleep: bed empty');
  assert.equal(at({ subsystem: 'house_mode', text: 'House set to away · everyone left' }), 'House set to away · everyone left', 'first word of the noun counts');
  assert.equal(at({ subsystem: 'lighting', text: 'Lights off · sunrise' }), 'Lights off · sunrise');
  assert.equal(at({ subsystem: 'cameras', text: 'Cameras on · house away' }), 'Cameras on · house away');
  assert.equal(at({ subsystem: 'mo', text: 'Mo spotted · Kitchen' }), 'Mo spotted · Kitchen');
  assert.equal(at({ subsystem: 'mo', text: 'Moment of truth' }), 'Mo · Moment of truth', 'a word that merely begins with the noun is not the noun');
  assert.equal(at({ subsystem: 'lighting', text: 'Stayed off: house asleep' }), 'Lights · Stayed off: house asleep');
  assert.equal(at({ subsystem: 'shower', text: 'Shower detected · humidity rising fast' }), 'Shower detected · humidity rising fast');
  assert.equal(at({ subsystem: 'fan', text: 'Fan on · shower started' }), 'Fan on · shower started');
  assert.equal(at({ subsystem: 'modifier', text: 'Home office released · guest mode off' }), 'Guest mode · Home office released · guest mode off');
  assert.equal(at({ subsystem: 'x_y', text: 'Did a thing' }), 'X y · Did a thing');
  assert.equal(at({ location: 'kitchen', subsystem: 'lighting', text: 'Lights off' }), 'Kitchen · Lights off', 'rooms keep their short name');
  assert.equal(at({ location: '', subsystem: 'energy', text: 'Hi' }), 'Energy · Hi');
  // End to end, from a stored entry: the real wording under its subject.
  const wheel = histEntry(5, { location: 'house', subsystem: 'energy', decision: 'spin', reason: 'wheels_spun', facts: { count: 2 } });
  const mode = histEntry(6, { location: 'house', subsystem: 'house_mode', decision: 'x', reason: 'bed_not_occupied', outcome: 'declined' });
  const sun = histEntry(7, { location: 'house', subsystem: 'lighting', decision: 'turn_off', reason: 'sunrise' });
  const rows = P.houseActivity(mk(histSensor('house', [wheel, mode, sun]))).rows.map((r) => r.text);
  assert.deepEqual(rows, ['Energy · Spun 2 Octopus wheels', 'House mode · Not set to asleep: bed empty', 'Lights off · sunrise']);
  // Every wording the card has, under its own noun, never doubles the noun.
  for (const key of Object.keys(P.REASON_TEXT)) {
    const [sub] = key.split(':');
    const text = P.REASON_TEXT[key]({}, { name: () => '' });
    const noun = P.subsystemOf(sub).noun;
    assert.doesNotMatch(P.placed('house', text, sub), new RegExp(`^${noun} · ${noun.split(' ')[0]}\\b`, 'i'), `${key} doubles its subject`);
  }
});

ok('guard aborts: hidden from the House feed, muted on room pages, never a problem', () => {
  const guard = (ago, over = {}) => histEntry(ago, { kind: 'abort', decision: '', reason: 'bed_occupied', outcome: undefined, detail: { abort_kind: 'guard' }, ...over });
  const unhandled = histEntry(8, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unhandled_error' }, location: 'house' });
  const unavailable = histEntry(9, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unavailable_input', entity: 'sensor.x' }, location: 'house' });
  const houseGuard = guard(3, { location: 'house', subsystem: 'energy' });
  const house = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'house', subsystem: 'energy', decision: 'spin', reason: 'wheels_spun' }), houseGuard, guard(4), unhandled, unavailable])), NOW);
  assert.doesNotMatch(house, /Held back/, 'guards never reach the House feed');
  assert.equal(count(house, /class="tl-row /g), 3, 'the other rows stay');
  assert.match(house, /class="tl-row problem">[^]*?style="color:#f2b84b"><b class="tl-s">[^<]*<\/b> [Cc]ouldn&#39;t run: it failed unexpectedly/, 'real aborts stay in the attention colour');
  assert.match(house, /class="tl-row problem">[^]*?style="color:#f2b84b"><b class="tl-s">[^<]*<\/b> [Cc]ouldn&#39;t run: .*unavailable/);
  const room = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [guard(2)])), NOW);
  assert.match(room, /class="tl-row declined">[^]*?style="color:#a3adba"><b class="tl-s">[^<]*<\/b> held back/);
  assert.doesNotMatch(room, /color:#f2b84b/);
  assert.equal(P.sentenceFor(guard(1), mk()).tone, 'muted');
  assert.equal(P.sentenceFor(unhandled, mk()).tone, 'warn');
  // The lights story and tag must not call a guard a problem.
  const held = story({}, histSensor('kitchen', [guard(1), histEntry(60)]));
  assert.deepEqual([held.state, held.tone], ['declined', 'muted'], 'a held-back run reads as a decline, not a Problem');
  assert.match(held.why, /^Held back/);
  const failedStory = story({}, histSensor('kitchen', [unhandled, histEntry(60)]));
  assert.deepEqual([failedStory.state, failedStory.tone], ['problem', 'warn'], 'a genuine failure still is one');
});

ok('narrow phone (360px): row titles and subtitles ellipsise in their own column; the trailing value and chevron never shrink', () => {
  assert.match(rule('.hm-text').body, /flex:1;min-width:0/);
  for (const sel of ['.hm-rt', '.hm-rs']) assert.match(rule(sel).body, /overflow:hidden;text-overflow:ellipsis/, sel);
  assert.match(rule('.hm-rt').body, /white-space:nowrap/);
  assert.match(rule('.hm-val').body, /flex:none/);
  assert.match(rule('.hm-chev').body, /flex:none/);
  assert.match(rule('.hm-tile').body, /flex:none/);
  assert.match(rule('.hm-bars').body, /flex:none/);
  assert.match(rule('.hm-ep').body, /min-width:0/, 'the price column can shrink beside the chart');
  // 360px: 2 x 16 page margin leaves 328px; a row's text column is 328 - 28 padding - 30 tile - 12 gap - 12 gap - 14 chevron = 232px
  // before any trailing value. The widget: 328 - 32 padding leaves 296px for the price block and a 9-bar chart of 9 x 7 + 8 x 3 = 87px.
  assert.ok(328 - 28 - 30 - 12 - 12 - 14 >= 200);
  assert.ok(296 - (9 * 7 + 8 * 3) - 12 >= 190, 'the price and its sentence keep room beside the chart');
  assert.match(P.STYLE, /@media \(max-width:359px\)\{\.hm-price\{font-size:36px\}\}/);
  for (const t of ['Boiler firing', 'Boiler idle', 'Heating off']) assert.ok(t.length <= 14);
});

ok('cameras row subtitle gives the reason per state, never restating the title', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const privacy = (on, mode, extra = {}) => mk({ 'switch.parlour_privacy': b(on.parlour ? 'on' : 'off'), 'switch.kitchen_privacy': b(on.kitchen ? 'on' : 'off'), 'switch.home_office_privacy': b(on.home_office ? 'on' : 'off'), 'sensor.house_active_mode': b(mode), ...extra });
  const allPriv = { parlour: 1, kitchen: 1, home_office: 1 };
  const card = (hass) => rowOf(P.render('house-list', {}, hass, NOW), P.CAMERAS_PATH);
  const sub = (hass) => rowSub(card(hass));
  assert.equal(rowTitle(card(privacy(allPriv, 'normal'))), 'All cameras off');
  assert.equal(sub(privacy(allPriv, 'normal')), 'Off while someone&#39;s home');
  assert.equal(sub(privacy({}, 'away')), 'On while the house is away');
  const guestAway = { 'input_select.house_active_mode_modifier': b('guest') };
  assert.equal(sub(privacy(allPriv, 'away', guestAway)), 'Off while a guest is staying');
  assert.equal(sub(privacy({}, 'away', guestAway)), 'Changed by hand · usually off while a guest is staying', 'cameras on with a guest while away is a deviation');
  assert.match(P.render('cameras-head', {}, privacy(allPriv, 'away', guestAway), NOW), /House is away, but a guest is staying · cameras off/);
  assert.equal(sub(privacy({ parlour: 1, home_office: 1 }, 'sleep')), 'Only the kitchen is on overnight, for Mo');
  assert.equal(sub(privacy(allPriv, 'unknown_mode')), 'Following the house mode');
  assert.equal(sub(privacy({ parlour: 1, kitchen: 1 }, 'normal')), 'Changed by hand · usually off while someone&#39;s home');
  for (const hass of [privacy(allPriv, 'normal'), privacy({}, 'away'), privacy({}, 'normal')]) assert.doesNotMatch(sub(hass), /cameras (on|off)/i);
  assert.match(P.render('cameras-head', {}, privacy(allPriv, 'normal'), NOW), /House is at home · cameras off/, 'the Cameras page keeps its fuller wording');
});


ok('Pulse page paths: info-dashboard.yaml lists House first then Energy, Settings, Cameras; the old Now path is gone everywhere', () => {
  const dash = readFileSync(root + 'info-dashboard.yaml', 'utf8');
  const includes = [...dash.matchAll(/!include (views\/info-[a-z_-]+\.yaml)/g)].map((m) => m[1]);
  const viewPaths = includes.map((f) => yaml.load(readFileSync(root + f, 'utf8')).path);
  assert.deepEqual(viewPaths.slice(0, 4), ['house', 'energy', 'settings', 'cameras']);
  assert.equal(new Set(viewPaths).size, viewPaths.length, 'view paths are unique');
  assert.equal(yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8')).title, 'House');
  assert.equal(yaml.load(readFileSync(root + 'views/info-settings.yaml', 'utf8')).title, 'Settings');
  assert.ok(P.ICON.gear && P.ICON.home);
  const files = [...includes, 'info-dashboard.yaml', 'info_templates.yaml', 'www/pulse-card.js', 'wallboard.yaml', 'dashboard.yaml', 'views/home.yaml', 'views/wallboard.yaml', 'views/mo.yaml']
    .concat(readdirSync(root + 'packages').map((f) => 'packages/' + f));
  const known = new Set(viewPaths);
  for (const f of files) {
    const text = readFileSync(root + f, 'utf8');
    assert.doesNotMatch(text, /pulse-dashboard\/now\b/, `${f} references the old Now path`);
    for (const m of text.matchAll(/pulse-dashboard\/([a-z_-]+)/g)) assert.ok(known.has(m[1]), `${f}: /pulse-dashboard/${m[1]} is not a view path`);
  }
  const everyMode = Object.entries(renderAll(withRooms(P.ROOM_ORDER.map(FULL), []))).map(([, html]) => html).join('');
  assert.doesNotMatch(everyMode, /pulse-dashboard\/now\b|Back to Now/);
});





// ── Room registry (step 7.1) ─────────────────────────────────────────────────────────────────
ok('scenes derive from the registry: ordered by scene_order_N, off last, device area fallback, other areas and unlabelled scenes ignored', () => {
  const { entities, devices } = registryFixture();
  const d = P.deriveScenes(entities, devices);
  assert.deepEqual(d.problems, []);
  for (const [k, ids] of Object.entries(SCENES)) assert.deepEqual(d.rooms[k].ids, ids, k);
  for (const k of Object.keys(SCENES)) assert.equal(d.rooms[k].off, `${k}_off`.replace(`${k}_`, ''), k);
  assert.deepEqual(d.rooms.front_garden.themes, { autumn: 'autumn' });
  // Position, not name order: scene_order_10 sorts after scene_order_2.
  const wide = registryFixture({ ...SCENES, parlour: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'off'] });
  assert.deepEqual(P.deriveScenes(wide.entities, wide.devices).rooms.parlour.ids, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'off']);
  // An off scene that also carries a position is still the last tile.
  const both = registryFixture(); both.entities['scene.parlour_off'].labels.push('scene_order_1');
  assert.deepEqual(P.deriveScenes(both.entities, both.devices).rooms.parlour.ids, ['all', 'lamps', 'dining', 'off']);
  // No registry yet: nothing and no problems, never a throw.
  assert.deepEqual(P.sceneRegistry({ states: {} }), { rooms: {}, problems: [] });
});

ok('registry problems fail loudly: bad label, missing or duplicate off scene, duplicate position, foreign scene id', () => {
  const run = (edit) => { const f = registryFixture(); edit(f.entities); return P.deriveScenes(f.entities, f.devices).problems; };
  assert.match(run((e) => e['scene.parlour_all'].labels.push('scene_order_x'))[0], /scene\.parlour_all has label "scene_order_x"/);
  assert.match(run((e) => e['scene.parlour_all'].labels.push('scene_order_0'))[0], /scene_order_0/);
  assert.match(run((e) => e['scene.parlour_all'].labels.push('scene_theme_'))[0], /scene_theme_/);
  assert.match(run((e) => e['scene.parlour_all'].labels.push('scene_nonsense'))[0], /scene_nonsense/);
  assert.match(run((e) => { delete e['scene.bedroom_off']; })[0], /bedroom: expected one scene labelled scene_control_off, found 0/);
  assert.match(run((e) => e['scene.bedroom_lamps'].labels.push('scene_control_off'))[0], /bedroom: expected one scene labelled scene_control_off, found 2/);
  assert.match(run((e) => { e['scene.parlour_lamps'].labels = ['scene_order_1']; })[0], /parlour: scenes lamps and all are both scene_order_1|parlour: scenes all and lamps are both scene_order_1/);
  assert.match(run((e) => { e['scene.other_thing'] = { area_id: 'parlour', labels: ['scene_order_9'] }; })[0], /scene\.other_thing is in parlour but its id does not start with scene\.parlour_/);
  // Other control labels are the automations' business: no problem, no change to the tiles.
  const ctl = registryFixture(); ctl.entities['scene.kitchen_cabinets'].labels.push('scene_control_daylight', 'scene_control_night', 'scene_control_evening');
  const cd = P.deriveScenes(ctl.entities, ctl.devices);
  assert.deepEqual(cd.problems, []);
  assert.deepEqual(cd.rooms.kitchen.ids, SCENES.kitchen);
  // Theme scenes without a position (front garden) raise nothing and are not tiles.
  assert.deepEqual(cd.rooms.front_garden.ids, SCENES.front_garden);
  assert.match(run((e) => e['scene.parlour_all'].labels.push('scene_control_'))[0], /scene_control_/);
  // The card surfaces them as an attention item and in the console.
  const f = registryFixture(); delete f.entities['scene.bedroom_off'];
  const errs = []; const orig = console.error; console.error = (m) => errs.push(m);
  try {
    const hass = { ...mk(), entities: f.entities, devices: f.devices };
    const html = P.render('status', {}, hass, NOW);
    assert.match(html, /Scene labels|bedroom: expected one scene labelled scene_control_off/);
  } finally { console.error = orig; }
  assert.ok(errs.some((m) => /scene registry: bedroom: expected one scene/.test(m)), 'logged to the console');
});

ok('room keys agree across the card table, info_rooms and the info-room views', () => {
  const tableKeys = P.ROOM_TABLE.map((r) => r.key);
  assert.equal(new Set(tableKeys).size, tableKeys.length, 'unique keys');
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  const cfgKeys = [...rooms.matchAll(/\{'k': '(\w+)', 'n': '[^']+', 'nav': '([^']+)'/g)].map((m) => m[1]);
  const gardenKeys = P.ROOM_TABLE.filter((r) => r.kind === 'garden').map((r) => r.key);
  assert.deepEqual([...cfgKeys].sort(), P.ROOM_TABLE.filter((r) => r.kind === 'room').map((r) => r.key).sort(), 'info_rooms rooms = table rooms');
  for (const g of gardenKeys) assert.match(rooms, new RegExp(`\\['${g}', '[^']+', '/pulse-dashboard/room-${g}'\\]`), `info_attention garden ${g}`);
  const paths = readdirSync(root + 'views').filter((x) => /^info-room-/.test(x)).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path).sort();
  assert.deepEqual(paths, tableKeys.map((k) => `room-${k}`).sort(), 'views = table');
  // Display order is explicit and unique within each kind; areas are unique (a scene belongs to one room).
  for (const kind of ['room', 'garden']) {
    const orders = P.ROOM_TABLE.filter((r) => r.kind === kind).map((r) => r.order);
    assert.deepEqual([...orders].sort((a, b) => a - b), orders.map((_, i) => i + 1), `${kind} order is 1..n`);
  }
  assert.equal(new Set(P.ROOM_TABLE.map((r) => r.area)).size, tableKeys.length, 'one area per room');
  assert.deepEqual(P.ROOM_ORDER, ['parlour', 'kitchen', 'hallway_downstairs', 'hallway_upstairs', 'bedroom', 'bathroom', 'home_office', 'foreign_office']);
});

ok('info_rooms emits only the fields its own template or the card reads', () => {
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  for (const gone of ['lights_why', 'lights_ts', "'last'", 'last_ts']) assert.ok(!rooms.includes(gone), gone);
  assert.ok(!/_history/.test(rooms), 'no homerun history read left in info_rooms');
});

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

ok('every entity the card can write passes callService', () => {
  const sent = [];
  const hass = { callService: (...a) => sent.push(a) };
  const all = writableEntities();
  assert.ok(all.length > 150, `enumerated ${all.length} writes`);
  for (const [d, s, id] of all) P.callService(hass, d, s, { entity_id: id });
  assert.equal(sent.length, all.length);
});

ok('the fan switch the bathroom view passes to the device row is writable', () => {
  const view = readFileSync(root + 'views/info-room-bathroom.yaml', 'utf8');
  const fan = /fan: (switch\.\S+)/.exec(view)[1];
  assert.ok(P.writeAllowed('switch', 'turn_on', fan) && P.writeAllowed('switch', 'turn_off', fan), fan);
});

ok('every settings and house helper the card writes exists in packages/helpers.yaml', () => {
  const helpers = yaml.load(readFileSync(root + 'packages/helpers.yaml', 'utf8'));
  for (const [d, s, id] of writableEntities()) {
    const [dom, name] = id.split('.');
    if (!dom.startsWith('input_')) continue;
    assert.ok(name in helpers[dom], `${id} (${d}.${s}) has no helper in packages/helpers.yaml`);
  }
});

ok('writes outside the patterns throw', () => {
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
    ['input_select', 'select_option', 'input_select.parlour_heating_manual_mode'],
    ['input_select', 'select_option', 'input_select.anything'],
    ['input_boolean', 'turn_on', 'input_boolean.house_heating_enabled\n'], // anchored
    ['input_boolean', 'turn_on', 'xinput_boolean.house_heating_enabled'],
  ];
  for (const [d, s, id] of bad) assert.throws(() => P.callService(hass, d, s, { entity_id: id }), /not an allowed write path/, `${d}.${s} ${id}`);
});

ok('a call without a usable entity_id throws, for every domain and service', () => {
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

ok('scene patterns come from the room table, gardens included', () => {
  for (const k of ['front_garden', 'back_garden', 'parlour', 'home_office']) assert.ok(P.writeAllowed('scene', 'turn_on', `scene.${k}_all`), k);
  assert.ok(P.ROOM_TABLE.filter((r) => r.kind === 'garden').length >= 2);
  assert.ok(!P.writeAllowed('scene', 'turn_on', 'scene.shed_all'));
});

ok('handleAction cannot be steered at an entity outside the table by a forged data-entity', () => {
  const hass = { states: {}, callService: () => assert.fail('must not be called') };
  for (const act of ['toggle', 'scene', 'brightness', 'media-play', 'media-power', 'volume']) {
    assert.throws(() => P.handleAction(hass, { dataset: { act, entity: 'lock.front_door' } }, '50'), /not an allowed write path|is not/, act);
  }
  assert.throws(() => P.handleAction(hass, { dataset: { act: 'toggle', entity: 'input_boolean.anything' } }), /not an allowed write path/);
  assert.throws(() => P.handleAction(hass, { dataset: { act: 'scene' } }), /not an allowed write path/);
});

ok('every service call in the card goes through callService', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const direct = [...src.matchAll(/\.callService\s*\(/g)];
  assert.equal(direct.length, 1, 'hass.callService is called in exactly one place');
  const fn = src.slice(src.indexOf('function callService(hass'));
  assert.ok(fn.indexOf('.callService(') < fn.indexOf('\n  }\n'), 'and that place is callService itself');
  assert.ok(fn.indexOf('writeAllowed(domain, service, entity)') < fn.indexOf('.callService('), 'after the entity check');
  for (const other of ['callApi', 'fireEvent', 'callWS({ type: \'call_service', 'hass.connection.sendMessage', 'publish(']) assert.ok(!src.includes(other), `no ${other}`);
  for (const m of src.matchAll(/callWS\(\s*\{([^}]*)\}/g)) assert.match(m[1], /type:\s*'(history|recorder|media_source|config)\//, `callWS reads only: ${m[1]}`);
});
// ── Classic theme is byte-identical to the pre-theme card ────────────────────────────────────────
// tests/fixtures/classic-golden.json holds a sha256 per rendered page (and for the stylesheet), taken from the
// card as it was before design tokens existed. Pages now carry var(--pulse-token) instead of hex, so each page
// is first resolved against the classic theme's values; a changed colour, class or word then shows as a changed hash.
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const goldenPages = () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const calmRooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false }));
  const scenarios = {
    attention: withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }]),
    calm: withRooms(calmRooms, []),
    bare: mk(),
  };
  const pages = {};
  for (const [name, hass] of Object.entries(scenarios)) for (const [k, v] of Object.entries(renderAll(hass))) pages[`${name}/${k}`] = v;
  // The full card list (every mode, room sheets open, cameras, house pages) on the richest fixture.
  const rich = richHass();
  for (const [label, m, c, ui] of allCards()) pages[`rich/${label}`] = Raw.render(m, asTheme(c), rich, NOW, ui);
  return pages;
};
const goldenFile = new URL('./fixtures/classic-golden.json', import.meta.url).pathname;
if (process.env.PULSE_GOLDEN_WRITE) {
  const pages = Object.fromEntries(Object.entries(goldenPages()).map(([k, v]) => [k, Raw.resolveVars ? Raw.resolveVars(v, 'classic') : v]));
  writeFileSync(goldenFile, JSON.stringify({ style: sha(Raw.resolveVars ? Raw.resolveVars(Raw.STYLE, 'classic') : Raw.STYLE), pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, sha(v)])) }, null, 1) + '\n');
  console.log('wrote', goldenFile);
} else {
  ok('classic theme renders the same pages and stylesheet as the card did before themes', () => {
    const golden = JSON.parse(readFileSync(goldenFile, 'utf8'));
    const resolve = (s) => (P.resolveVars ? P.resolveVars(s, 'classic') : s);
    assert.equal(sha(resolve(P.STYLE)), golden.style, 'stylesheet changed');
    const pages = goldenPages();
    assert.deepEqual(Object.keys(pages).sort(), Object.keys(golden.pages).sort());
    const changed = Object.keys(pages).filter((k) => sha(resolve(pages[k])) !== golden.pages[k]);
    assert.deepEqual(changed, [], `pages changed under the classic theme: ${changed.slice(0, 8).join(', ')}`);
  });
}

// ── Themes ───────────────────────────────────────────────────────────────────────────────────────
const cardSrc = readFileSync(new URL('../www/pulse-card.js', import.meta.url), 'utf8');
const ratio = (a, b) => { for (const c of [a, b]) assert.match(c, /^#[0-9a-f]{6}$/i, `${c} is a 6-digit hex`); return cr(a, b); };

ok('colour literals appear only inside the THEMES block', () => {
  const start = cardSrc.indexOf('  const THEMES = {');
  const end = cardSrc.indexOf('  const DEFAULT_THEME');
  assert.ok(start > 0 && end > start);
  const outside = (cardSrc.slice(0, start) + cardSrc.slice(end)).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const stray = outside.match(/(?<![&\w])#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
  assert.equal(stray, null, `colour literals outside THEMES: ${stray}`);
});

ok('every theme defines exactly the same tokens, and at least classic and rose-pine exist', () => {
  assert.ok(Raw.THEMES.classic && Raw.THEMES['rose-pine']);
  const want = Object.keys(Raw.THEMES.classic).sort();
  for (const [name, t] of Object.entries(Raw.THEMES)) assert.deepEqual(Object.keys(t).sort(), want, name);
  for (const k of Raw.COLOUR_KEYS) assert.ok(cardSrc.includes(`TOKENS.${k}`) || cardSrc.includes(`colour('${k}')`) || cardSrc.includes(`'${k}'`), `token ${k} is used by the card`);
});

ok('every theme is readable: text and textSecondary 4.5:1 on bg and surface, tint 3:1 on surface, inks on their fills', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    for (const fg of ['text', 'textSecondary']) for (const bg of ['bg', 'surface']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: ${fg} on ${bg} ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t.tint, t.surface) >= 3, `${name}: tint on surface ${ratio(t.tint, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.tintInk, t.tint) >= 4.5, `${name}: tintInk on tint ${ratio(t.tintInk, t.tint).toFixed(2)}`);
    assert.ok(ratio(t.attention, t.attentionBg) >= 4.5, `${name}: attention on attentionBg ${ratio(t.attention, t.attentionBg).toFixed(2)}`);
    assert.ok(ratio(t.attention, t.attentionChip) >= 4.5, `${name}: attention on attentionChip ${ratio(t.attention, t.attentionChip).toFixed(2)}`);
    assert.ok(ratio(t.text, t.control) >= 4.5, `${name}: text on control`);
    assert.ok(ratio(t.textSoft, t.control) >= 4.5, `${name}: textSoft on control`);
  }
});

ok('every theme: tile glyphs read on their fills (3:1), including the declined, empty-room and presence colours', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    const pairs = Object.entries(Raw.SUBSYSTEMS).map(([id, s]) => [`subsystem ${id}`, t[s.tile], t[s.ink]])
      .concat([['outside', t.outside, t.outsideInk], ['bins', t.bins, t.binsInk], ['attention', t.attention, t.attentionInk], ['occupied room', t.occupied, t.occupiedInk]]);
    assert.equal(Object.keys(Raw.SUBSYSTEMS).length, 13, 'all 13 homerun subsystems have tile tokens');
    for (const [what, fill, ink] of pairs) assert.ok(ratio(ink, fill) >= 3, `${name}: ${what} glyph on tile ${ratio(ink, fill).toFixed(2)}`);
    assert.ok(ratio(t.textSecondary, t.tileIdle) >= 3, `${name}: empty-room glyph on the idle tile`);
    assert.ok(ratio(t.text, t.tileIdle) >= 4.5, `${name}: text on the idle tile`);
    // A declined row draws its glyph in the subsystem colour on the idle tile, or in secondary text where that colour would vanish.
    for (const [id, s] of Object.entries(Raw.SUBSYSTEMS)) {
      const glyph = ratio(t[s.tile], t.tileIdle) >= 3 ? t[s.tile] : t.textSecondary;
      assert.ok(ratio(glyph, t.tileIdle) >= 3, `${name}: declined ${id} glyph`);
    }
    assert.ok(ratio(t.present, t.bg) >= 3, `${name}: the present dot on the page`);
    assert.notEqual(t.present, t.presenceAway);
    assert.ok(ratio(t.presenceAway, t.bg) >= 1.5, `${name}: the away dot is dim but still there`);
    assert.notEqual(t.chevron, t.surface);
    assert.ok(ratio(t.chevron, t.surface) >= 1.5, `${name}: the chevron is dim but still there`);
    assert.ok(ratio(t.subEnergy, t.surface) >= 3, `${name}: the Electricity heading on the widget`);
    // Timeline: the rail is quieter than the dots and text but still visible; every dot reads on the surface (3:1), in its
    // subsystem colour or, where that would vanish, in secondary text (the attention dot is checked just below).
    assert.notEqual(t.rail, t.surface);
    assert.ok(ratio(t.rail, t.surface) >= 1.1 && ratio(t.rail, t.surface) < ratio(t.chevron, t.surface), `${name}: the rail is subtle but there ${ratio(t.rail, t.surface).toFixed(2)}`);
    for (const [id, s] of Object.entries(Raw.SUBSYSTEMS)) {
      const dot = ratio(t[s.tile], t.surface) >= 3 ? t[s.tile] : t.textSecondary;
      assert.ok(ratio(dot, t.surface) >= 3, `${name}: ${id} timeline dot`);
    }
    assert.ok(ratio(t.attention, t.surface) >= 3, `${name}: the Needs attention header on the page`);
  }
  assert.equal(ratio('#000000', '#ffffff'), 21);
});

ok('every Pulse view paints the default theme\'s background, so the page reads as bg end to end', () => {
  const views = readdirSync(root + 'views').filter((x) => x.startsWith('info-'));
  assert.ok(views.length >= 14);
  for (const f of views) assert.equal(yaml.load(readFileSync(root + 'views/' + f, 'utf8')).background, Raw.THEMES[Raw.DEFAULT_THEME].bg, f);
});

ok('the House page under the default theme: every variable resolves, no tertiary text, every glyph hidden from assistive tech', () => {
  const hass = richHass();
  for (const mode of ['now-header', 'status', 'rooms', 'house-list', 'feed', 'tabbar']) {
    const html = Raw.render(mode, { active: 'house' }, hass, NOW, {});
    assert.doesNotThrow(() => Raw.resolveVars(html, 'rose-pine'), mode);
    assert.doesNotMatch(html, /textTertiary|--pulse-textTertiary/, `${mode}: no tertiary text`);
    for (const tag of html.match(/<svg[^>]*>/g) || []) assert.match(tag, /aria-hidden="true"/, `${mode}: ${tag.slice(0, 40)}`);
    assert.doesNotMatch(html, /<(?:a|button)[^>]*>\s*<\/(?:a|button)>/, `${mode}: no empty links`);
  }
  const house = ['now-header', 'status', 'rooms', 'house-list', 'feed'].map((m) => Raw.render(m, {}, hass, NOW, {})).join('');
  assert.doesNotMatch(Raw.resolveVars(house, 'rose-pine'), /#12151a|#f2b84b/, 'no classic colour leaks into the default theme');
  assert.match(Raw.resolveVars(house, 'rose-pine'), /background:#9ccfd8;color:#191724/, 'an occupied room takes Foam');
  assert.doesNotMatch(Raw.STYLE.split('\n').filter((l) => /^\.hm|^\.tab/.test(l)).join('\n'), /textTertiary/);
  // Every House-page rule uses tokens only (the colour-literal test covers the file; this holds the page's own rules to it).
  assert.doesNotMatch(Raw.STYLE.split('\n').filter((l) => /^\.hm/.test(l)).join('\n'), /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(P.STYLE, /\.hm-row:focus-visible/, 'rows show focus');
});

// ── Room and garden pages (native design) ─────────────────────────────────────────────────────────
const roomPageHass = () => {
  const base = richHass();
  const fg = frontGarden({ ...litScenes(), ...dark });
  const helpers = Object.fromEntries(settingRows().map(({ row }) => [row.id, b(row.kind === 'toggle' ? 'on' : String(row.min))]));
  return { ...base, states: { ...base.states, ...helpers, ...fg.states, ...backGarden().states, 'switch.bathroom_fan_extractor': b('on'), 'sensor.bathroom_fan_decision': b('x', { reason: 'fan_on_shower_started' }), 'input_boolean.bedroom_automation_presence_override': b('off') } };
};
const ROOM_PAGE_MODES = (k) => ['room-head', 'readings', 'lights', 'heating', 'presence', 'media', 'automation', 'room-feed', 'garden-lights', 'garden-theme'].filter((m) => (GARDENS.includes(k) ? !['readings', 'lights', 'heating', 'presence', 'media'].includes(m) : !m.startsWith('garden-')));

ok('room and garden pages under the default theme: variables resolve, no tertiary text, glyphs hidden, no empty controls, no classic colour', () => {
  const hass = roomPageHass();
  let seen = 0;
  for (const k of P.ALL_ROOM_KEYS) {
    for (const mode of ROOM_PAGE_MODES(k)) {
      const html = Raw.render(mode, { room: k }, hass, NOW, {});
      if (!html) continue;
      seen += 1;
      assert.doesNotThrow(() => Raw.resolveVars(html, 'rose-pine'), `${k}/${mode}`);
      assert.doesNotMatch(html, /textTertiary/, `${k}/${mode}: no tertiary text`);
      for (const tag of html.match(/<svg[^>]*>/g) || []) assert.match(tag, /aria-hidden="true"/, `${k}/${mode}`);
      assert.doesNotMatch(html, /<(?:a|button)[^>]*>\s*<\/(?:a|button)>/, `${k}/${mode}: no empty links`);
      assert.doesNotMatch(Raw.resolveVars(html, 'rose-pine'), /#12151a|#f2c46b|#1a1f26/, `${k}/${mode}: no classic colour in the default theme`);
      // Same side margins and the same section gap as the House page: every card is an `.hm` block.
      assert.match(html, /^<div class="p"><div class="hm( hm-first)?">/, `${k}/${mode}: built on the House page block`);
    }
  }
  assert.ok(seen >= 55, `rendered ${seen} room cards`);
  assert.doesNotMatch(Raw.STYLE.split('\n').filter((l) => /^\.hm/.test(l)).join('\n'), /textTertiary/, 'no hm rule uses the tertiary colour');
});

ok('every control on the room and garden pages is a button or link with a name, a 44px target, and writes only inside the allowlist', () => {
  const hass = roomPageHass();
  const seen = new Set();
  for (const k of P.ALL_ROOM_KEYS) {
    for (const mode of ROOM_PAGE_MODES(k)) {
      const html = P.render(mode, { room: k, entity: 'switch.bathroom_fan_extractor', decision: 'sensor.bathroom_fan_decision', label: 'Extractor fan' }, hass, NOW, {});
      for (const tag of html.match(/<(?:button|a|input)\b[^>]*\bdata-act="[^"]*"[^>]*>/g) || []) {
        const ds = {};
        for (const m of tag.matchAll(/\bdata-([a-z][a-z0-9-]*)="([^"]*)"/g)) ds[m[1].replace(/-([a-z0-9])/g, (x, c) => c.toUpperCase())] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        assert.match(tag, /^<(button|a|input)\b/, `${k}/${mode}`);
        if (ds.act === 'nav') continue;
        // A disclosure row writes nothing: it only flips the viewer's own open/closed state.
        if (ds.act === 'disclose') { assert.match(ds.id, /^[a-z0-9_]+:[a-z0-9_]+$/, `${k}/${mode}`); assert.match(tag, /aria-expanded="(true|false)" aria-controls="dp-[\w-]+"/); continue; }
        seen.add(ds.act);
        const calls = [];
        const h = { ...hass, callService: (...a) => calls.push(a) };
        assert.doesNotThrow(() => P.handleAction(h, { dataset: ds }, '50'), `${k}/${mode}: ${JSON.stringify(ds)} writes outside the allowlist`);
        assert.ok(calls.length >= 1, `${k}/${mode}: ${ds.act} makes a call`);
      }
      // Buttons that carry no text of their own name themselves.
      for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) assert.ok(/aria-label="[^"]+"/.test(m[1]) || m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim() !== '', `${k}/${mode}: an unnamed button ${m[1]}`);
    }
  }
  assert.deepEqual([...seen].sort(), ['brightness', 'garden-power', 'garden-theme', 'media-play', 'media-power', 'scene', 'setting-number', 'setting-toggle', 'toggle', 'volume'].sort());
});

ok('the apexcharts config cannot read CSS variables, so each literal in info_templates.yaml is pinned to the default theme\'s token', () => {
  const t = Raw.THEMES[Raw.DEFAULT_THEME];
  const stack = loadYaml('info_templates.yaml').pulse_room.card.cards.find((c) => c.type === 'conditional').card;
  assert.equal(stack.type, 'vertical-stack');
  assert.deepEqual(stack.cards.map((c) => c.mode || c.type), ['chart-head', 'custom:apexcharts-card'], 'the section header is the pulse-card one, the chart has none');
  const chart = stack.cards[1];
  assert.equal(chart.header.show, false);
  const ax = chart.apex_config;
  assert.equal(ax.chart.background, t.surface, 'card background = surface');
  assert.match(chart.card_mod.style, new RegExp(`border: none; border-radius: 20px; box-shadow: none; background: ${t.surface};`), '20px radius, no border, no shadow');
  assert.equal(ax.grid.borderColor, t.separator, 'grid = separator');
  assert.equal(ax.legend.labels.colors, t.textSecondary);
  assert.equal(ax.xaxis.labels.style.colors, t.textSecondary, 'axis = textSecondary');
  assert.equal(chart.yaxis.find((a) => a.id === 'temp').apex_config.labels.style.colors, t.textSecondary);
  const colourOf = (name) => chart.series.find((x) => x.name === name).color;
  assert.equal(colourOf('Room'), t.text, 'room temperature = text');
  assert.equal(colourOf('Target'), t.tint, 'target = tint');
  assert.equal(colourOf('Heating'), t.heat, 'heating band = heating colour');
  // No other colour literal hides in the chart.
  const literals = JSON.stringify(chart).match(/#[0-9a-fA-F]{6}\b|rgba?\([^)]*\)/g);
  const allowed = new Set([t.surface, t.text, t.tint, t.heat, t.textSecondary, t.separator]);
  for (const l of literals) assert.ok(allowed.has(l), `${l} is a default-theme token value`);
  assert.equal(P.render('chart-head', {}, mk(), NOW).match(/<h2>([^<]+)<\/h2>/)[1], 'Last 24 hours');
});

const long = (c) => (c.length === 4 ? `#${[...c.slice(1)].map((x) => x + x).join('')}` : c); // classic writes its white knob as #fff
ok('the new tokens: a slider track that shows on the surface and under the tint fill; the switch knob reads on both tracks; labels read on cards', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    assert.ok(ratio(t.sliderTrack, t.surface) >= 1.3, `${name}: sliderTrack on surface ${ratio(t.sliderTrack, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.tint, t.sliderTrack) >= 3, `${name}: the tint fill on the track ${ratio(t.tint, t.sliderTrack).toFixed(2)}`);
    assert.ok(ratio(long(t.knob), t.on) >= 3, `${name}: knob on the on track ${ratio(long(t.knob), t.on).toFixed(2)}`);
    assert.ok(ratio(long(t.knob), t.off) >= 3, `${name}: knob on the off track ${ratio(long(t.knob), t.off).toFixed(2)}`);
    assert.notEqual(t.on, t.off);
    assert.ok(ratio(t.heat, t.surface) >= 4.5, `${name}: the Temperature label on a widget ${ratio(t.heat, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.subLighting, t.surface) >= 4.5, `${name}: the Light level label on a widget ${ratio(t.subLighting, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.text, t.control) >= 4.5 && ratio(t.link, t.bg) >= 3, `${name}: stepper glyphs on the pill`);
    assert.ok(ratio(t.tintInk, t.tint) >= 4.5, `${name}: scene name on the active button`);
  }
  assert.match(Raw.STYLE, /\.hm-check\{[^}]*color:var\(--pulse-tint\)/, 'the picker checkmark is the tint');
});


ok('the theme is chosen by config, defaults to rose-pine (classic stays selectable), and an unknown name fails loudly', () => {
  const hass = withRooms(P.ROOM_ORDER.map(FULL), []);
  assert.equal(Raw.DEFAULT_THEME, 'rose-pine');
  assert.equal(Raw.themeOf({}), Raw.THEMES['rose-pine']);
  assert.equal(Raw.themeOf({ theme: 'classic' }), Raw.THEMES.classic);
  assert.equal(Raw.render('rooms', {}, hass, NOW), Raw.render('rooms', { theme: 'rose-pine' }, hass, NOW));
  assert.equal(Raw.styleFor({}), Raw.styleFor({ theme: 'rose-pine' }));
  assert.notEqual(Raw.styleFor({ theme: 'classic' }), Raw.styleFor({}));
  assert.match(Raw.styleFor({ theme: 'classic' }), /^:host\{--pulse-bg:#12151a;/);
  assert.doesNotThrow(() => Raw.render('rooms', { theme: 'rose-pine' }, hass, NOW));
  for (const bad of ['nord', '', 'Classic', null, 3]) assert.throws(() => Raw.render('rooms', { theme: bad }, hass, NOW), /unknown theme/, String(bad));
  assert.throws(() => Raw.themeOf({ theme: 'nord' }), /known: classic, rose-pine/);
  assert.throws(() => Raw.styleFor({ theme: 'nord' }), /unknown theme/);
});

ok('a theme missing a token, or with a stray one, fails at validation', () => {
  const full = Raw.THEMES.classic;
  const without = (k) => { const { [k]: _gone, ...rest } = full; return rest; };
  for (const k of Raw.COLOUR_KEYS.concat('priceStops')) assert.throws(() => Raw.checkThemes({ classic: full, odd: without(k) }), new RegExp(`missing: ${k}`), k);
  assert.throws(() => Raw.checkThemes({ classic: full, odd: { ...full, extra: '#000000' } }), /unknown: extra/);
  assert.throws(() => Raw.checkThemes({ classic: full, odd: { ...full, bg: '' } }), /token "bg"/);
  assert.throws(() => Raw.checkThemes({ classic: full, odd: { ...full, priceStops: [[1, 2, 3]] } }), /priceStops/);
  assert.throws(() => Raw.TOKENS.nope, /unknown colour token "nope"/);
  assert.throws(() => Raw.colour('nope'), /unknown colour token/);
});

ok('the stylesheet carries the theme as --pulse-* variables on :host and the markup only references them', () => {
  const css = Raw.styleFor({ theme: 'rose-pine' });
  assert.match(css, /^:host\{--pulse-bg:#191724;/);
  for (const k of Raw.COLOUR_KEYS) assert.ok(css.includes(`--pulse-${k}:${Raw.THEMES['rose-pine'][k]}`), k);
  assert.ok(!Raw.styleFor({ theme: 'classic' }).includes('#191724'));
  const vars = new Set([...Raw.STYLE.matchAll(/var\(--pulse-(\w+)\)/g)].map((m) => m[1]));
  for (const v of vars) assert.ok(Raw.COLOUR_KEYS.includes(v), v);
});

ok('price colours follow the theme: same algorithm, the theme\'s stops, and readable figures on its surface', () => {
  const day = mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates: real } } });
  const fills = (theme) => Raw.render('energy-day', { theme }, day, Date.parse('2026-10-25T18:29:00Z'), {}).match(/fill="#[0-9a-f]{6}"/g).join();
  assert.notEqual(fills('rose-pine'), fills('classic'));
  assert.equal(fills('rose-pine'), fills(undefined), 'no theme means the default');
  assert.notEqual(fills('classic'), fills(undefined));
  const roseNow = (cents) => Raw.render('energy-head', { theme: 'rose-pine' }, mk({ [`${BASE}_current_rate`]: { state: String(cents / 100), attributes: {} } }), NOW);
  const colourOf = (html) => html.match(/line-height:1.15;color:(#[0-9a-f]{6})/)[1];
  assert.equal(colourOf(roseNow(-2)), Raw.THEMES['rose-pine'].priceNegative);
  assert.notEqual(colourOf(roseNow(60)), colourOf(roseNow(-2)), 'the extreme price is its own colour (lightened for text until readable)');
  for (const v of [-5, 0, 5, 15, 25, 35, 44, 50]) assert.ok(ratio(colourOf(roseNow(v)), Raw.THEMES['rose-pine'].surface) >= 4.5, `${v}p`);
});

// ── Copy table ───────────────────────────────────────────────────────────────────────────────────
ok('every COPY key is used by the card and every COPY reference names a key', () => {
  const body = cardSrc.replace(/^\s*(\/\/|\*).*$/gm, '');
  const refs = new Set([...body.matchAll(/\bCOPY\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`));
  const keys = new Set();
  for (const area of Object.keys(Raw.COPY)) for (const key of Object.keys(Raw.COPY[area])) keys.add(`${area}.${key}`);
  assert.deepEqual([...refs].filter((r) => !keys.has(r)), [], 'references without a key');
  assert.deepEqual([...keys].filter((k) => !refs.has(k)), [], 'keys nothing references');
  assert.deepEqual(Object.keys(Raw.COPY).sort(), ['cameras', 'common', 'energy', 'feed', 'home', 'room', 'settings']);
});

ok('a missing COPY key throws at runtime instead of printing undefined', () => {
  assert.throws(() => Raw.COPY.home.nope, /no COPY\.home\.nope/);



  assert.equal(Raw.COPY.home.headerLine('At home', ''), 'At home');
  assert.equal(Raw.COPY.home.headerLine('At home', 'Guest'), 'At home · Guest');
  assert.equal(Raw.COPY.home.roomsOccupiedCount(3), '3 occupied');
  assert.equal(Raw.COPY.home.personLabel('Adam', 'home'), 'Adam, home');
  assert.equal(Raw.COPY.home.moreItems(2), '+2 more');
  assert.equal(Raw.COPY.home.reasonText('Bed occupied'), 'someone in bed');
  assert.equal(Raw.COPY.home.reasonText('Sofa occupied'), 'sofa occupied');
  assert.equal(Raw.COPY.home.reasonText('Sonos playing'), 'Sonos playing');
  assert.equal(Raw.COPY.home.reasonText('Doors closed'), 'doors closed');
  assert.equal(Raw.COPY.home.roomLine('Lamps', 'someone in bed', 'scene set 4 min ago'), 'Lamps · someone in bed');
  assert.equal(Raw.COPY.home.roomLine('Full', 'doors closed', ''), 'Full · doors closed');
  assert.equal(Raw.COPY.home.roomLine('Lamps', '', 'scene set 4 min ago'), 'Lamps · set 4 min ago');
  assert.equal(Raw.COPY.home.roomLine('Lights off', '', ''), 'Lights off');
  assert.equal(Raw.COPY.home.heatingLine(3, '17.7°', '3.7°', false), '3 rooms heating · 17.7° in, 3.7° out');
  assert.equal(Raw.COPY.home.heatingLine(0, '', '', true), 'no readings · patio open');
  assert.equal(Raw.COPY.home.binNames(['Food']), 'Food');
  assert.equal(Raw.COPY.home.binNames(['Food', 'Garden', 'Refuse']), 'Food, garden and refuse');
  assert.deepEqual([0, 1, 5].map(Raw.COPY.home.collected), ['Collected today', 'Collected tomorrow', 'Collected in 5 days']);
  assert.equal(Raw.COPY.energy.nextHalfHour('38.8p', '188 W'), 'Next 38.8p · using 188 W');
  assert.equal(Raw.COPY.energy.nextHalfHour('', '188 W'), 'using 188 W');
  assert.equal(Raw.COPY.energy.windowOn('Today', '09:00', '11:00'), '09:00 – 11:00');
  assert.equal(Raw.COPY.energy.windowOn('Tomorrow', '09:00', '11:00'), 'Tomorrow 09:00 – 11:00');
  assert.equal(Raw.COPY.cameras.recent(4), '4 recent');
});

ok('the wording tables sit together after COPY, ahead of any render code', () => {
  const at = (needle) => { const i = cardSrc.indexOf(needle); assert.ok(i > 0, needle); return i; };
  const copyAt = at('  const COPY = {');
  const firstSection = at('  function sectionNowHeader');
  for (const t of ['  const SUBSYSTEMS = {', '  const REASON_TEXT = {', '  const UNDECLARED = {']) assert.ok(at(t) > copyAt && at(t) < firstSection, t);
  assert.ok(at('  const REASON_TEXT = {') - copyAt < 40000, 'the wording region is one block');
});

console.log(`\n${n} test groups passed`);
