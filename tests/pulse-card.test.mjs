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
const P = require('../www/pulse-card.js');
const root = new URL('..', import.meta.url).pathname;
let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log('ok', name); };
const okAsync = async (name, fn) => { await fn(); n += 1; console.log('ok', name); };

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
const NOISE = /undefined|NaN|\[object|null/;
const ALL_MODES = ['now-header', 'status', 'rooms', 'bins-heating', 'feed', 'tabbar', 'energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage'];
const SHARED_MODES = ['room-head', 'room-feed'];
const INDOOR_MODES = ['lights', 'heating', 'presence', 'media'];
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
  assert.match(out.status, /1 needs attention/);
  assert.match(out['room-head:bedroom'], /Heating suspended/);
  assert.match(out['heating:bedroom'], /class="lbl">Target</);
  assert.match(out.rooms, /Bedroom details/);
  assert.match(out['presence:bedroom'], /Bed occupied/);
  assert.doesNotMatch(out['presence:bedroom'], /Bed occupied · Window open/);
});

ok('calm state: no attention, All good', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, }));
  const out = renderAll(withRooms(rooms, []));
  noNoise(out, 'calm');
  assert.match(out.status, /All good/);
  assert.doesNotMatch(out.rooms, /details ›/);
  assert.match(out['room-head:parlour'], /All good/);
  assert.match(out['heating:parlour'], /class="lbl">Target<\/div>/);
  assert.doesNotMatch(out['room-head:parlour'], /class="lbl">Target<\/div>/, 'the banner no longer carries the numbers');
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
  assert.doesNotMatch(out['room-head:hallway_upstairs'], /class="lbl">Target|class="lbl">Room/);
  const quiet = P.render('rooms', {}, withRooms([{ k: 'hallway_upstairs', n: 'x', occupied: false, temp: null, humidity: null }], []), NOW);
  const upTile = quiet.match(/<a class="rt tap[^"]*"[^>]*room-hallway_upstairs"[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(upTile, /–/, 'no bare dash for a room without climate');
  assert.doesNotMatch(out['heating:hallway_upstairs'], /Heating target/);
  for (const g of GARDENS) {
    assert.match(out[`room-head:${g}`], /Lights from sunset until bedtime/);
    assert.doesNotMatch(out[`room-head:${g}`], /Lights only|Target|Room</);
    assert.equal(out[`garden-theme:${g}`], '', 'no theme helper data in this fixture');
  }
});

ok('manual marker: the Lights card shows a Manual tag, and its story says who set it and what ends it', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T18:40:00+00:00', what: 'Wall button: scene cycled' };
  const room = (over, extra = {}) => withRooms([{ ...FULL('parlour'), pres_labels: [], labels: [], ...over }], [], extra);
  const set = P.render('lights', { room: 'parlour' }, room({ manual }), NOW);
  assert.match(set, /<span class="tag">Manual<\/span>/);
  assert.equal((set.match(/Manual/g) || []).length, 1, 'a bare chip, no explanation');
  assert.doesNotMatch(set, /class="note"|wall button|ago|Stays until|Set by automation|Tap a scene/);
  assert.match(set, /aria-pressed="true"/); // lamps is active
  assert.match(set, /data-entity="scene.parlour_lamps"/);
  const none = P.render('lights', { room: 'parlour' }, room({ manual: null }), NOW);
  assert.doesNotMatch(none, /Manual|class="note"/);
  const why = (over, extra) => whyAll({ room: 'parlour' }, room(over, extra), NOW);
  const wall = why({ manual });
  assert.match(wall, /<span class="tag">Manual<\/span>/);
  assert.match(wall, /Wall button at 18:40 · stays until the room is empty/);
  assert.doesNotMatch(wall, /scene cycled/, 'what the wall button did is not repeated');
  const dash = why({ manual: { source: 'dashboard', ts: '2026-10-25T18:40:00+00:00', what: 'lamps scene' } });
  assert.match(dash, /Dashboard at 18:40: lamps scene · stays until the room is empty/);
  const dark = histEntry(12, { location: 'parlour', decision: 'activate_scene', reason: 'lux_low', facts: { lux: 12, lux_threshold: 40 } });
  const auto = why({ manual: null, lights_on: 2 }, histSensor('parlour', [dark]));
  assert.match(auto, /<span class="tag ok">Auto<\/span>/);
  assert.match(auto, /Scene set · getting dark \(12 lx, on below 40\) at 18:30 · off when the room empties/);
  const hold = why({ manual: null, lights_on: 2, pres_labels: ['Monitor on'], labels: ['Monitor on'] });
  assert.match(hold, /<span class="tag off">Hold<\/span>/);
  assert.match(hold, /stays on while Monitor on/);
  const off = why({ manual: null, lights_on: 0, pres_labels: ['Monitor on'], labels: ['Monitor on'] });
  assert.doesNotMatch(off, /stays on while/, 'a held room with the lights off does not claim they stay on');
  const disabled = why({ manual, lights_enabled: false });
  assert.match(disabled, /<span class="tag">Automation off<\/span>/);
  assert.match(disabled, /Lights automation is off · they change only by hand/);
  assert.doesNotMatch(disabled, /<span class="tag ok">Auto<\/span>/);
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
  assert.match(older.why, /^Lights off · room emptied at 18:12 · off when the room empties$/);
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
  assert.deepEqual([declined.state, declined.tone, declined.why], ['declined', 'muted', 'Stayed off: bright enough (85 lx, on below 40) at 18:41']);
  assert.match(story({}, histSensor('kitchen', [luxHigh(1, null)])).why, /bright enough \(no light reading, on below 40\)/);
  const abort = histEntry(2, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unavailable_input', entity: 'sensor.kitchen_lux' } });
  const a = story({}, { ...histSensor('kitchen', [abort, histEntry(30)]), ...kitchenEntity('sensor.kitchen_lux', 'Lux sensor') });
  assert.deepEqual([a.state, a.tone, a.why], ['problem', 'warn', "Couldn't run: Lux sensor unavailable at 18:40"]);
  const failed = histEntry(2, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'ack_timeout', action: 'light.turn_on', entity: 'light.kitchen_ceiling' } });
  const f = story({}, { ...histSensor('kitchen', [failed, histEntry(30)]), ...kitchenEntity('light.kitchen_ceiling', 'Kitchen ceiling') });
  assert.deepEqual([f.state, f.tone, f.why], ['problem', 'warn', "Kitchen ceiling didn't respond at 18:40"]);
  const old = story({}, histSensor('kitchen', [histEntry(1), luxHigh(30)]));
  assert.equal(old.state, 'acted', 'the decline is older than the last act, so the act explains the lights');
  const heldOn = story({ lights_on: 2, pres_labels: ['Monitor on'] }, histSensor('kitchen', [luxHigh(1)]));
  assert.match(heldOn.why, /\(85 lx, on below 40\) at 18:41 · stays on while Monitor on$/);
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

ok('Recent activity rows by kind: acted plain, declined muted with the didn\'t glyph, abort and failure amber, repeats collapse', () => {
  const abort = histEntry(4, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'guard' } });
  const failed = histEntry(5, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'error', action: 'scene.turn_on', entity: 'scene.kitchen_all' } });
  const entries = [histEntry(1), histEntry(2), luxHigh(3), abort, failed];
  const html = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', entries, {})), NOW);
  assert.match(html, /<div class="feed ok"><span class="a">18:41<\/span><span>Lights off · room emptied <b>x2<\/b>/);
  assert.match(html, /<div class="feed muted"><span class="a">18:39<\/span><span><span class="g"><svg[^>]*>[\s\S]*?<\/svg><\/span>Stayed off: bright enough \(85 lx, on below 40\)/);
  assert.match(html, /<div class="feed warn"><span class="a">18:38<\/span><span>Held back/);
  assert.match(html, /<div class="feed warn"><span class="a">18:37<\/span><span>scene\.kitchen_all couldn&#39;t be controlled \(turn on\)/);
  assert.equal((html.match(/class="feed /g) || []).length, 4, 'one row per distinct entry; homerun stores no plumbing, so the card has nothing to hide');
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

ok('individual lights: collapsed by default inside the Lighting card with one chevron, expanded shows sliders/toggles/missing honestly', () => {
  const closed = P.render('lights', { room: 'parlour' }, mk(), NOW);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /Individual lights<span[^>]*> · 2 of 5 on/);
  assert.equal((closed.match(/Lights<\/div>/g) || []).length, 1, 'no second section header');
  assert.doesNotMatch(closed, /type="range"|class="tog/);
  assert.equal((closed.match(/M6 9l6 6 6-6/g) || []).length, 1, 'a single chevron, no second dropdown arrow');
  const open = P.render('lights', { room: 'parlour' }, mk(), NOW, { open: true });
  assert.match(open, /aria-expanded="true"/);
  assert.equal((open.match(/data-act="lights-toggle"/g) || []).length, 1);
  assert.match(open, /type="range"[^>]*data-entity="light.parlour_light_floor_lamp"/);
  assert.match(open, /style="--p:40%"/);
  assert.match(open, /data-act="toggle" data-entity="switch.parlour_plug_table_lamp"/);
  assert.match(open, /Not found/);
  assert.match(P.render('lights', { room: 'parlour' }, withRooms([{ ...FULL('parlour'), lights_on: 3, lights_total: 5 }], []), NOW), /3 of 5 on/);
  for (const k of INDOOR_KEYS) {
    const want = P.ROOMS[k].lights.length === 0;
    assert.equal(P.render('lights', { room: k }, mk(), NOW).includes('lights-toggle'), !want, `${k} collapsed`);
    assert.equal(P.render('lights', { room: k }, mk(), NOW, { open: true }).includes('lights-toggle'), !want, `${k} open`);
  }
  noNoise({ open }, 'lights open');
  assert.throws(() => P.render('lights-title', { room: 'parlour' }, mk(), NOW), /unknown mode/);
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
  const words = { fan_off_max_run: ['off', 'Ran its maximum time'], fan_run_extended: ['on', 'Another shower started'], fan_holding_min_run: ['on', 'Minimum run'], fan_holding_humidity_high: ['on', 'Clearing steam'], fan_not_auto_started: ['on', 'Turned on by hand'], automation_disabled: ['off', 'Automation off'] };
  for (const [r, [st, text]] of Object.entries(words)) assert.match(P.render('device', cfg, hass(st, r), NOW), new RegExp(`${st === 'on' ? 'On' : 'Off'} · ${text}`), r);
  assert.deepEqual(Object.keys(P.DEVICE_REASONS).sort(), ['automation_disabled', 'fan_holding_humidity_high', 'fan_holding_min_run', 'fan_not_auto_started', 'fan_off_humidity_normal', 'fan_off_max_run', 'fan_on_shower_started', 'fan_run_extended']);
  // A stale reason that contradicts the switch, an ignored reason and a missing reason all show state only.
  assert.match(P.render('device', cfg, hass('off', 'fan_on_shower_started'), NOW), /<div class="s">Off<\/div>/);
  assert.match(P.render('device', cfg, hass('on', 'fan_idle'), NOW), /<div class="s">On<\/div>/);
  assert.match(P.render('device', cfg, hass('on', undefined), NOW), /<div class="s">On<\/div>/);
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

ok('House feed reads sensor.house_history, says where, and a stored info_decision_feed is ignored', () => {
  const house = (entries, over = {}) => mk({ ...histSensor('house', entries, over) });
  const stale = { 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify([{ loc: 'kitchen', ts: '2026-10-25T18:20:00+00:00', sentence: 'OLD FEED SENTENCE' }]) } } };
  const hass = mk({ ...histSensor('house', [histEntry(1, { location: 'kitchen' }), histEntry(5, { location: 'house', subsystem: 'energy', decision: 'spin', reason: 'wheels_spun', automation_id: 'house:wheel' })]), ...stale });
  const feed = P.render('feed', {}, hass, NOW);
  assert.match(feed, /<span class="a">18:41<\/span><span>Kitchen · Lights off · room emptied/);
  assert.match(feed, /<span class="a">18:37<\/span><span>Spun the Octopus wheels/, 'whole-house entries carry no place');
  assert.doesNotMatch(feed, /OLD FEED SENTENCE/, 'the old feed sensor is no longer read');
  assert.match(P.render('feed', {}, house([]), NOW), /Nothing recorded yet/);
  assert.match(P.render('feed', {}, mk(), NOW), /Nothing recorded yet[\s\S]*History unavailable/, 'no sensor: say so rather than imply a quiet house');
  assert.match(P.render('feed', {}, house([], { schema: 'nope' }), NOW), /History unreadable/);
  const declined = P.render('feed', {}, house([luxHigh(2)]), NOW);
  assert.match(declined, /class="feed muted"[\s\S]*Kitchen · Stayed off: bright enough/, 'a rule that chose not to act reads muted, as on the room page');
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk({ ...histSensor('kitchen', [histEntry(1)]) }), NOW), /Lights off · room emptied/);
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
  const feedOf = (mins, decision = 'turn_off', sub = 'lighting', loc = 'kitchen') => histSensor(loc, [histEntry(mins, { location: loc, subsystem: sub, decision, reason: 'x', outcome: undefined })]);
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

ok('House feed limited to 3 rows, repeats collapse', () => {
  const e = (i, over) => histEntry(i, over);
  const entries = [e(1, { location: 'bathroom' }), e(2, { location: 'bathroom' }), e(3, { location: 'kitchen', decision: 'turn_on', reason: 'occupancy_on' }), e(4, { location: 'hallway_downstairs' }), e(5, { location: 'home_office' })];
  const html = P.render('feed', {}, mk(histSensor('house', entries)), NOW);
  assert.equal(count(html, /class="feed ok"/g), 3);
  assert.match(html, /<b>x2<\/b>/);
  assert.doesNotMatch(html, /Home office/);
});

ok('Now v2 view layout: one status card first, groups, prices, bins/heating, feed; no old modes', () => {
  const v = yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8'));
  const modes = v.sections[0].cards.map((c) => c.mode);
  assert.deepEqual(modes, ['now-header', 'status', 'rooms', 'bins-heating', 'cameras-card', 'feed', 'tabbar']);
  for (const m of modes) assert.ok(P.render(m, {}, mk(), NOW) !== undefined);
  for (const old of ['attention', 'bins', 'energy-foot', 'energy']) assert.throws(() => P.render(old, {}, mk(), NOW), /unknown mode/, old);
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
ok('person icon for occupancy on every room page; no bed icon anywhere in the Why rows', () => {
  const person = 'M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 20a7 7 0 0 1 14 0';
  const bed = 'M4 20v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M4 16h16M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3';
  for (const k of P.ROOM_ORDER) {
    const why = whyAll({ room: k }, withRooms(P.ROOM_ORDER.map((x) => quietRoom(x, { occupied: true, pres_labels: ['Bed occupied'], labels: ['Bed occupied'] })), []), NOW);
    assert.ok(why.includes(person), `${k}: person icon on the occupancy row`);
    assert.ok(!why.includes(bed), `${k}: no bed icon`);
    const occRow = why.match(/<div class="item">(?:(?!<div class="item">)[\s\S])*?<div class="h">(Occupied|Empty)<\/div>/)[0];
    assert.ok(occRow.includes(person));
  }
  const rows = whyAll({ room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: true } }), []), NOW);
  assert.equal(count(rows, /class="item"/g), 3);
  assert.match(rows, /Occupied<\/div>/);
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
  assert.match(feed, /Bedroom · Heating mode changed · window open/);
});

ok('media players are labelled by device role from the room config, not the entity name', () => {
  const html = P.render('media', { room: 'parlour' }, mk({ 'media_player.parlour': { state: 'playing', attributes: { friendly_name: 'Parlour', volume_level: 0.3 } }, 'media_player.parlour_tv': { state: 'off', attributes: { friendly_name: 'Bravia KD-55' } } }), NOW);
  assert.match(html, /<div class="h">Soundbar<\/div>/);
  assert.match(html, /<div class="h">TV<\/div>/);
  assert.doesNotMatch(html, /<div class="h">Parlour<\/div>|Bravia/);
  assert.match(P.render('media', { room: 'kitchen' }, mk({ 'media_player.kitchen': { state: 'idle', attributes: { friendly_name: 'Kitchen' } } }), NOW), /Kitchen speaker/);
});

ok('held-occupied wording has no redundancy', () => {
  const m = quietRoom('parlour', { occupied: true, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], lights_on: 2 });
  const hass = withRooms([m], []);
  const why = whyAll({ room: 'parlour' }, hass, NOW);
  assert.match(why, /<div class="s">Sofa occupied · empty a few minutes after it clears<\/div>/);
  assert.doesNotMatch(why, /Held occupied|Held by|occupied by Sofa occupied|1 reason/);
  const head = P.render('room-head', { room: 'parlour' }, hass, NOW);
  assert.match(head, /Occupied · lights on/);
  assert.doesNotMatch(head, /Occupied \(/);
  assert.doesNotMatch(head, /held occupied/i);
  const att = P.render('rooms', {}, withRooms([m], [attn('Parlour', 'parlour', 'automation_disabled', 'Lights automation off')]), NOW);
  assert.match(att, /<b>Held occupied<\/b><span>Sofa occupied<\/span>/);
  const fact = (over) => P.verdictFor({ ...P.roomModel(withRooms([quietRoom('parlour', over)], []), 'parlour') }, '');
  assert.equal(fact({ occupied: true, lights_on: 2, pres_labels: ['Monitor on'] }), 'Occupied (Monitor on) · lights on', 'a hold that does not say occupied folds into the first clause');
  assert.equal(fact({ occupied: true, lights_on: 0, pres_labels: ['Bed occupied'] }), 'Occupied · lights off', 'a hold that already says occupied adds nothing');
  assert.equal(fact({ occupied: false, lights_on: 0, pres_labels: ['Monitor on'] }), 'Empty · lights off · held occupied · Monitor on');
  assert.equal(fact({ occupancy_unavailable: true, lights_on: 1 }), 'Occupancy unavailable · lights on');
  assert.equal(fact({ occupied: true, lights_on: 1, target: 5, target_reason: 'window open' }), 'Occupied · lights on · heating target 5.0° (window open)');
  assert.equal(fact({ occupied: true, lights_on: 1, heat_labels: ['Window open'], override_text: 'Override on' }), 'Occupied · lights on · heating suspended: window open · Override on');
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
const NOW_MODES = ['now-header', 'status', 'rooms', 'bins-heating', 'cameras-card', 'feed'];
const nowPage = (hass) => NOW_MODES.map((m) => P.render(m, {}, hass, NOW)).join('\n');

ok('Now v3 header is the title and mode pill only; no "Updated" text anywhere on Now; Mobile link stays at the bottom', () => {
  const hdr = P.render('now-header', {}, mk(), NOW);
  assert.match(hdr, />Pulse</);
  assert.match(hdr, /● Normal/);
  assert.equal(count(hdr, /<a /g), 1, 'the mode pill is the only link in the title row');
  assert.doesNotMatch(hdr, /sliders/, 'no icon in the title row');
  for (const hass of [mk(), withRooms(calmRooms(), []), withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), [attn('Bedroom', 'bedroom', 'automation_disabled', 't')]), { states: {} }]) assert.doesNotMatch(nowPage(hass), /Updated/);
  assert.equal(count(nowPage(mk()), /data-path="\/mobile-dashboard"/g), 0);
  assert.doesNotMatch(P.render('tabbar', { active: 'house' }, mk(), NOW, {}), /mobile-dashboard|Controls/);
  const view = yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8'));
  assert.deepEqual(view.sections[0].cards.map((c) => c.mode), ['now-header', 'status', 'rooms', 'bins-heating', 'cameras-card', 'feed', 'tabbar']);
});

ok('Now v3 status card: verdict row with the sentence right-aligned, ONE chip row (nowrap, 30px), price strip link, cheapest line', () => {
  const hass = withRooms(calmRooms({ parlour: { occupied: true }, kitchen: { occupied: true }, bedroom: { occupied: true }, bathroom: { occupied: true } }), []);
  const st = P.render('status', {}, hass, NOW);
  assert.match(st, /<div style="font-size:15px;font-weight:700">All good<\/div><div style="flex:1"><\/div><div style="font-size:12px;color:#a3adba;text-align:right">4 rooms occupied · heating idle<\/div>/);
  const chips = st.match(/<div class="chips">[\s\S]*?<\/div><\/div>/)[0];
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
  const wc = worst.match(/<div class="chips">[\s\S]*?<\/div><\/div>/)[0];
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

ok('attention labels: sensor_stale names the entity and age; the original four labels are unchanged', () => {
  const stale = withRooms(calmRooms({ bedroom: { occupied: true } }), [attn('Bedroom', 'bedroom', 'sensor_stale', 'climate.bedroom_trv: no update for 5 h 12 min')]);
  assert.match(P.render('status', {}, stale, NOW), /Bedroom<\/b> · Sensor not updating/);
  assert.match(P.render('rooms', {}, stale, NOW), /climate\.bedroom_trv: no update for 5 h 12 min/);
  const four = [['window_open_heating_on', 'Window open, heating on'], ['automation_disabled', 'Automation off'], ['hold_active', 'Override on'], ['sensor_unavailable', 'Sensor unavailable']];
  for (const [kind, label] of four) {
    const h = withRooms(calmRooms({ bedroom: { occupied: true } }), [attn('Bedroom', 'bedroom', kind, 'detail text')]);
    assert.match(P.render('status', {}, h, NOW), new RegExp(`Bedroom</b> · ${label}`));
    assert.match(P.render('rooms', {}, h, NOW), /detail text/);
  }
});

ok('Now v3 occupied card is two lines: icon + name + temperature, then badges (amber manual badge, holds, phrase)', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T15:42:00+00:00', what: 'x' };
  const feed = histSensor('parlour', [histEntry(1, { location: 'parlour', decision: 'turn_on', reason: 'x', outcome: undefined })]);
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

ok('tab bar renders four tabs, one per id, with aria-current on the active one only', () => {
  for (const [active, label] of [['house', 'House'], ['energy', 'Energy'], ['cameras', 'Cameras'], ['settings', 'Settings']]) {
    const html = P.render('tabbar', { active }, mk(), NOW, {});
    assert.match(html, /<nav class="tabs" aria-label="Pulse">/);
    assert.equal(count(html, /<button type="button" class="tab"/g), 4);
    assert.equal(count(html, /aria-current="page"/g), 1);
    assert.match(html, new RegExp(`aria-current="page">[\\s\\S]*?<span>${label}</span>`));
    for (const t of ['House', 'Energy', 'Cameras', 'Settings']) assert.match(html, new RegExp(`<span>${t}</span>`));
    assert.equal(count(html, /<svg /g), 4, 'inline SVG icons');
    noNoise({ html }, 'tabbar');
  }
  assert.match(P.render('tabbar', { active: 'bogus' }, mk(), NOW, {}), /aria-current="page">[\s\S]*?<span>House<\/span>/, 'unknown active falls back to House');
  for (const cfg of [undefined, null, {}, { active: 5 }]) assert.doesNotMatch(P.render('tabbar', cfg, mk(), NOW, undefined), NOISE);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.tab\{[^\n]*font-size:10\.5px[^\n]*min-height:44px/);
  assert.match(css, /\.tab\[aria-current=page\]\{color:\$\{TOKENS\.sceneActive\}\}/);
  assert.match(css, /\.tabs\{[^\n]*rgba\(18,21,26,\.94\)[^\n]*border-top:1px solid \$\{TOKENS\.divider\}/);
  assert.equal(P.TOKENS.sceneActive, '#f2c46b');
  assert.equal(P.TOKENS.text3, '#8f9aa8');
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
  assert.deepEqual(P.TABS.map((t) => t.label), ['House', 'Energy', 'Cameras', 'Settings']);
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
  assert.match(P.render('status', {}, hass, NOW), /class="chip"[^>]*>Mo/);
  assert.doesNotMatch(readFileSync(root + 'views/info-house.yaml', 'utf8'), /footer/);
});

ok('status card: each attention row links to its own room; +N more opens the first room not already shown', () => {
  const keys = ['kitchen', 'parlour', 'bedroom', 'bathroom', 'home_office'];
  const items = keys.map((k) => attn(k, k, 'automation_disabled', 't'));
  const status = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), items), NOW);
  const links = [...status.matchAll(/<a class="tap" data-act="nav" data-path="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], m[2]]);
  const rows = links.filter(([, t]) => !/more/.test(t) && /<b>/.test(t));
  assert.deepEqual(rows.map(([p]) => p), ['kitchen', 'parlour', 'bedroom'].map((k) => `/pulse-dashboard/room-${k}`));
  for (const [i, [, t]] of rows.entries()) assert.match(t, new RegExp(`<b>${keys[i]}</b>`));
  const more = links.find(([, t]) => /\+2 more/.test(t));
  assert.equal(more[0], '/pulse-dashboard/room-bathroom');
  assert.equal(count(status, /data-path="\/pulse-dashboard\/room-bathroom"/g), 1);
});

ok('status card: +N more skips rooms already shown and falls back to Now for room-less items', () => {
  const dup = [attn('a', 'kitchen', 'k1', 't'), attn('b', 'kitchen', 'k2', 't'), attn('c', 'parlour', 'k3', 't'), attn('d', 'kitchen', 'k4', 't'), attn('e', 'bedroom', 'k5', 't')];
  const s1 = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), dup), NOW);
  assert.match(s1, /data-path="\/pulse-dashboard\/room-bedroom"[^>]*>\+2 more/);
  const same = [attn('a', 'kitchen', 'k1', 't'), attn('b', 'kitchen', 'k2', 't'), attn('c', 'kitchen', 'k3', 't'), attn('d', 'kitchen', 'k4', 't')];
  const s2 = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), same), NOW);
  assert.match(s2, /data-path="\/pulse-dashboard\/room-kitchen"[^>]*>\+1 more/);
  const none = [attn('a', 'kitchen', 'k1', 't'), attn('b', 'kitchen', 'k2', 't'), attn('c', 'kitchen', 'k3', 't'), { room: 'House', key: '', kind: 'unexplained_reason', text: 'x', nav: '' }];
  assert.match(P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), none), NOW), /data-path="\/pulse-dashboard\/house"[^>]*>\+1 more/);
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
  const shapes = ['.clip img', '.dot', '.item svg,.ic', '.sw', '.sw::after', '.sr', '.lt input[type=range]', '.lt input[type=range]::-webkit-slider-runnable-track', '.lt input[type=range]::-webkit-slider-thumb', '.lt input[type=range]::-moz-range-track', '.lt input[type=range]::-moz-range-progress', '.lt input[type=range]::-moz-range-thumb'];
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
  // the tab bar and the settings sheet's overlay are the only fixed-position elements and stay out of the tile/occupied card rules
  assert.deepEqual(cssRules().filter((r) => /position:fixed/.test(r.body)).map((r) => r.sel), ['.tabs.fixed', '.ovl']);
});

ok('room heating tile says whether the room is heating right now; unknown action says nothing', () => {
  const head = (over) => P.render('heating', { room: 'parlour' }, withRooms([quietRoom('parlour', { target: 20, mode_target: 20, mode_name: 'comfort', heating_active: 'comfort', heating_source: 'schedule', ...over })], []), NOW);
  const on = head({ hvac_action: 'heating' });
  assert.match(on, /Heating now/);
  assert.match(on, /class="lbl">Target</);
  assert.match(on, /Comfort from schedule/);
  assert.match(head({ hvac_action: 'idle' }), /Not heating/);
  assert.match(head({ hvac_action: 'off' }), /Heating off/);
  assert.doesNotMatch(head({ hvac_action: null }), /Heating now|Not heating|Heating off/);
  const why = (a) => whyAll({ room: 'parlour' }, withRooms([quietRoom('parlour', { target: 20, hvac_action: a })], []), NOW);
  assert.match(why('heating'), /<span class="tag heat">Heating<\/span>/);
  assert.match(why('idle'), /<span class="tag off">Idle<\/span>/);
  assert.doesNotMatch(why('idle'), /On target/);
});

ok('room chart overlays heat demand from hvac_action on a hidden 0..1 axis, with a legend', () => {
  const t = loadYaml('info_templates.yaml').pulse_room.card.cards;
  const chart = t.find((c) => c.type === 'conditional').card;
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
  const head = P.render('room-head', { room: 'bedroom' }, hass, NOW);
  assert.match(head, /Heating suspended/);
  assert.match(head, /Window open · set to 5\.0° until all clear</);
  const why = whyRows({ room: 'bedroom' }, hass, NOW);
  assert.match(why, /Held at minimum 5\.0° · window open/);
  assert.doesNotMatch(why, /from safety/);
  assert.match(why, /<span class="tag">Suspended<\/span>/);
  assert.match(why, /<div class="s">Bed occupied · empty a few minutes after it clears<\/div>/);
  assert.doesNotMatch(why, /Bed occupied · Window open|All are true/);
  // Window just opened: the hold is true but the controller has not forced the minimum yet.
  const grace = { ...bed, heating_source: 'schedule', heating_active: 'baseline_day', mode_name: 'baseline day', mode_target: 18, target: 18 };
  const gh = P.render('room-head', { room: 'bedroom' }, withRooms([grace], []), NOW);
  assert.doesNotMatch(gh, /Heating suspended/);
  assert.match(gh, /Window open<\/div>[^]*Heating drops to minimum if it stays open</);
  const gw = whyAll({ room: 'bedroom' }, withRooms([grace], []), NOW);
  assert.match(gw, /<span class="tag">Pending<\/span>/);
  // House heating off forces the minimum with no window: name that cause.
  const off = { ...bed, heat_labels: [], labels: ['Bed occupied'] };
  const offHass = withRooms([off], [], { 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } });
  assert.match(whyAll({ room: 'bedroom' }, offHass, NOW), /Held at minimum 5\.0° · house heating off/);
  const calm = P.render('room-head', { room: 'bedroom' }, withRooms([{ ...bed, heat_labels: [], labels: ['Bed occupied'] }], []), NOW);
  assert.match(calm, /All good/);
  assert.match(calm, /Occupied · lights on</);
  assert.doesNotMatch(calm, /Occupied \(/);
});

ok('room page puts lighting straight under the head, before the chart and the why card', () => {
  const cards = loadYaml('info_templates.yaml').pulse_room.card.cards;
  const order = cards.map((c) => (c.type === 'conditional' ? 'chart' : c.mode));
  assert.deepEqual(order, ['room-head', 'lights', 'heating', 'chart', 'presence', 'media', 'device', 'room-feed']);
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

ok('room page copy: subtitle lines have no trailing full stops; no Why card; Individual lights label sits above its card', () => {
  const m = quietRoom('kitchen', { occupied: true, pres_labels: ['Monitor on'], labels: ['Monitor on'], heat_labels: ['Window open'], hvac_action: 'idle', target: 18, mode_target: 18, mode_name: 'baseline day', heating_active: 'baseline_day', heating_source: 'schedule' });
  const hass = withRooms([m], []);
  const why = whyAll({ room: 'kitchen' }, hass, NOW);
  assert.doesNotMatch(why, /Why it('|&#39;)?s like this|Why it is like this/, 'the separate Why card is gone: each subsystem explains itself');
  assert.match(why, /class="lbl"[^>]*>Lights<[\s\S]*class="lbl"[^>]*>Heating<[\s\S]*class="lbl"[^>]*>Presence</, 'one labelled section per subsystem');
  assert.equal((why.match(/<div class="s">[^<]*\.<\/div>/g) || []).length, 0, 'no subtitle ends in a full stop');
  assert.match(why, /Window open · Baseline day 18\.0° from schedule/);
  const lights = P.render('lights', { room: 'kitchen' }, hass, NOW);
  assert.doesNotMatch(lights, /<div class="lbl"[^>]*>Individual lights/);
  assert.doesNotMatch(lights, /<span class="lbl">Individual lights/);
  const scenes = P.render('lights', { room: 'kitchen' }, hass, NOW);
  assert.doesNotMatch(scenes, /\.<\/div><\/div>$/);
  const att = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'] } }), [attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window')]), NOW);
  assert.match(att, /target 5\.0° \(window open\) · normally baseline day 18\.0°<\/span>/);
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
  assert.match(empty, /<div class="s">No holds<\/div>/);
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

ok('settings sheet CSS: the body scrolls inside a viewport-bounded sheet and does not let the page behind scroll', () => {
  const rule = (sel) => cssRules().filter((r) => r.sel === sel).map((r) => r.body).join(';');
  const sheet = rule('.sheet');
  assert.match(sheet, /max-height:var\(--sheet-max,min\(88vh,calc\(100vh - env\(safe-area-inset-top,0px\) - 16px\)\)\)/, 'vh fallback');
  assert.match(sheet, /max-height:var\(--sheet-max,min\(88dvh,calc\(100dvh - env\(safe-area-inset-top,0px\) - 16px\)\)\)/, 'dvh');
  assert.ok(sheet.indexOf('88vh') < sheet.indexOf('88dvh'), 'dvh comes last so it wins where supported');
  assert.match(sheet, /min-height:0/);
  const sb = rule('.sb');
  assert.match(sb, /overflow-y:auto/);
  assert.match(sb, /overscroll-behavior:contain/);
  assert.match(sb, /-webkit-overflow-scrolling:touch/);
  assert.match(sb, /min-height:0/);
  assert.match(sb, /touch-action:pan-y/);
  assert.match(sb, /calc\(24px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(rule('.sb>*'), /flex-shrink:0/, 'sheet body children never shrink: the clipping .card would hide rows instead of .sb scrolling');
  assert.match(rule('.ovl'), /overscroll-behavior:contain/);
  assert.match(rule('.scrim'), /touch-action:none/, 'a drag on the scrim does not scroll the page');
  assert.match(rule('.sh'), /touch-action:none/);
  assert.doesNotMatch(rule('.ovl') + rule('.sheet'), /touch-action|overflow:hidden/, 'nothing on the overlay or sheet blocks the body scrolling');
});

ok('sheetFit: nothing to do when the overlay is the viewport; lifts and bounds the sheet when an ancestor contains it', () => {
  assert.equal(P.sheetFit(800, { left: 0, top: 0, right: 390, bottom: 800 }), null);
  assert.equal(P.sheetFit(800, { left: 0, top: 0.4, right: 390, bottom: 800.3 }), null);
  // overlay is the whole tall page: 2000px tall, its bottom 1200px below the fold
  assert.deepEqual(P.sheetFit(800, { left: 0, top: -400, right: 390, bottom: 2000 }), { inset: 800, max: 120 }, 'inset is capped to the viewport and the sheet stays usable');
  assert.deepEqual(P.sheetFit(800, { left: 0, top: 0, right: 390, bottom: 1000 }), { inset: 200, max: Math.floor(600 * 0.88) });
  assert.deepEqual(P.sheetFit(800, { left: 0, top: 100, right: 390, bottom: 700 }), { inset: 0, max: Math.floor(700 * 0.88) });
  assert.equal(P.sheetFit(0, { left: 0, top: 0, right: 1, bottom: 1 }), null);
  assert.equal(P.sheetFit(800, null), null);
});

ok('no "valve" wording in anything the user reads', () => {
  const bed = quietRoom('bedroom', { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'] });
  const hass = withRooms([bed], [], { 'input_boolean.bedroom_automation_heating_enabled': { state: 'on', attributes: {} } });
  const out = ['room-head', 'lights', 'heating', 'presence'].map((m) => P.render(m, { room: 'bedroom' }, hass, NOW)).join('') + P.render('room-head', { room: 'bedroom' }, hass, NOW, { settings: true });
  assert.doesNotMatch(out, /valve/i);
  assert.match(out, /Sets the target from mode, windows and schedule/);
  assert.match(out, /Window open · set to 5\.0° and returns to baseline day \(18\.0°\) once it closes</);
});

ok('Presence holds Keep room occupied and says (with a link to settings) when the motion sensor is off', () => {
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
  assert.match(pres, /data-act="settings-open" data-room="bedroom"/);
  assert.doesNotMatch(pres, /data-entity="input_boolean\.bedroom_sensor_motion_enabled"/, 'the motion switch is in settings, not on the page');
  const guestHass = withRooms([quietRoom('home_office')], [], {
    'input_boolean.home_office_automation_presence_override': b('on'),
    'input_select.house_active_mode_modifier': b('guest'),
  });
  assert.match(P.render('presence', { room: 'home_office' }, guestHass, NOW), /Set by guest mode/);
  const on = withRooms([quietRoom('bedroom')], [], { 'input_boolean.bedroom_sensor_motion_enabled': b('on') });
  const quiet = P.render('presence', { room: 'bedroom' }, on, NOW);
  assert.doesNotMatch(quiet, /Motion sensor off|settings-open/);
  // The toggle is hidden without its helper, and Presence is empty when there is neither a report nor a toggle.
  assert.doesNotMatch(quiet, /Keep room occupied/);
  assert.equal(P.render('presence', { room: 'bedroom' }, mk(), NOW), '');
});

ok('attention feed labels a motion sensor left off', () => {
  const hass = withRooms([quietRoom('bedroom')], [attn('Bedroom', 'bedroom', 'motion_disabled', 'Motion ignored, the room relies on holds')]);
  assert.match(P.render('rooms', {}, hass, NOW), /Motion sensor off/);
  assert.doesNotMatch(P.render('rooms', {}, hass, NOW), /Motion disabled/);
});

ok('house page: mode banner, modifier picker and vacation threshold write only to their fixed helpers', () => {
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
  assert.match(head, /vacation heating in 44 h/);
  assert.match(head, /Sitter modifier/);
  const mode = P.render('house-mode', {}, hass, at);
  assert.match(mode, /data-option="sitter"/);
  assert.match(mode, /seg on" data-act="house-modifier" data-option="sitter"/);
  assert.match(mode, /never goes to away or vacation/);
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
  assert.match(P.render('bins-heating', {}, mk(), NOW), new RegExp(`data-path="${P.SETTINGS_PATH}"`));
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
  const now = P.render('cameras-card', {}, offline, NOW);
  assert.match(now, new RegExp(`data-path="${P.CAMERAS_PATH}"`));
  assert.match(now, /Home office offline/);
  assert.equal(P.render('cameras-card', {}, { states: {} }, NOW), '', 'no camera entities, no card');
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
const rowText = (html) => ({ h: (html.match(/class="h">([^<]*)</) || [])[1], s: (html.match(/class="s">([^<]*)</) || [])[1], btn: (html.match(/<button class="gbtn[^>]*>([^<]*)</) || [])[1], disabled: /<button class="gbtn[^>]*disabled/.test(html) });
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
  assert.deepEqual(rowText(gr(frontGarden())), { h: 'Off', s: 'On at sunset · 16:30', btn: 'Turn on', disabled: false });
});

ok('garden lights row: on in the evening window says until when, with the theme in the headline', () => {
  const r = rowText(gr(frontGarden({ ...litScenes(), ...dark }), 'garden-lights', EVENING));
  assert.deepEqual(r, { h: 'Autumn · on', s: 'Until 00:00 or bedtime', btn: 'Turn off', disabled: false });
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
  assert.deepEqual(rowText(gr(backGarden(backOn), 'garden-lights', DAY, 'back_garden')), { h: 'On', s: 'Until 22:00', btn: 'Turn off', disabled: false });
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
  assert.deepEqual(rowText(gr(frontGarden(noScene))), { h: 'Off', s: 'No scene for Christmas', btn: 'Turn on', disabled: true });
  assert.deepEqual(rowText(gr(mk())), { h: 'Lights unknown', s: 'No lighting report from Home Assistant', btn: 'Turn on', disabled: true });
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
  assert.match(html, /class="tile on" data-act="garden-theme" data-garden="front_garden" data-option="autumn" aria-pressed="true"/);
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

ok('garden page: banner describes the garden, the automation row names the window, attention has its own label', () => {
  const head = gr(frontGarden(), 'room-head');
  assert.match(head, /Evening lighting/);
  assert.match(head, /Lights from sunset until 00:00 and bedtime/);
  assert.match(gr(frontGarden({ 'sensor.front_garden_lighting_window': b('unknown') }), 'room-head'), /Lights from sunset until bedtime/);
  const auto = gr(frontGarden(), 'room-head', DAY, FG);
  assert.doesNotMatch(auto, /presence and time of day/);
  assert.throws(() => gr(frontGarden(), 'automations'), /unknown mode/, 'the Automations section is gone');
  const item = { room: 'Front garden', key: FG, kind: 'garden_theme_config', text: 'No scene for Christmas', nav: '/pulse-dashboard/room-front_garden' };
  const warn = gr(frontGarden({ 'sensor.info_attention': b('1', { items: JSON.stringify([item]) }) }), 'room-head');
  assert.match(warn, /Theme setup/);
  assert.match(warn, /No scene for Christmas/);
});

ok('Now page: an Outside group with both gardens linking to their Pulse pages, apart from the indoor groups', () => {
  const states = { ...frontGarden().states, ...backGarden().states };
  const calm = withRooms(calmRooms(), [], states);
  const rooms = P.render('rooms', {}, calm, DAY);
  assert.match(rooms, />Outside</);
  assert.equal(count(rooms, /class="rt gt tap wide"/g), 2);
  assert.match(rooms, /data-path="\/pulse-dashboard\/room-front_garden"/);
  assert.match(rooms, /data-path="\/pulse-dashboard\/room-back_garden"/);
  assert.match(rooms, /Front garden<\/span><\/div><div class="t gh">Off<\/div><div class="b"><span>On at sunset · 16:30</);
  assert.ok(rooms.indexOf('>Outside<') > rooms.indexOf('>Rooms<'), 'after the indoor groups');
  assert.equal(count(rooms, /class="rt tap[" ]/g), 8, 'gardens are not indoor tiles');
  assert.doesNotMatch(rooms, /class="dot warn"/);
  const flagged = withRooms(calmRooms(), [attn('Front garden', FG, 'garden_theme_config', 'No scene for Christmas')], states);
  const withDot = P.render('rooms', {}, flagged, DAY);
  assert.equal(count(withDot, /class="dot warn"/g), 1);
  assert.match(withDot.match(/<a class="rt gt[\s\S]*?<\/a>/)[0], /class="dot warn"/, 'on the front garden tile');
  assert.doesNotMatch(withDot, /Needs attention/, 'gardens never join the indoor attention group');
  const status = P.render('status', {}, flagged, DAY);
  assert.match(status, /1 needs attention[\s\S]*Front garden<\/b> · Theme setup/);
  assert.match(status, /data-path="\/pulse-dashboard\/room-front_garden"/);
  noNoise({ rooms, withDot, status }, 'outside');
});

ok('a theme switch reads in words (the daily calendar publish is declared ignored, so homerun never stores it)', () => {
  const cal = { location: FG, automation_id: 'front_garden:lighting:theme_calendar' };
  const entries = [histEntry(1, { ...cal, decision: 'switch_theme', reason: 'calendar_boundary', facts: { theme: 'halloween' } })];
  const html = gr(frontGarden(histSensor(FG, entries)), 'room-feed');
  assert.doesNotMatch(html, /publish|calendar publish|not a calendar boundary/i);
  assert.match(html, /Theme switched to Halloween · calendar/);
  assert.equal((html.match(/class="feed /g) || []).length, 1);
});

ok('garden YAML: views use the garden template, Mobile links to Pulse, feed and attention wording are in place', () => {
  const tpl = yaml.load(readFileSync(root + 'info_templates.yaml', 'utf8'));
  assert.deepEqual(tpl.pulse_garden.card.cards.map((c) => c.mode), ['room-head', 'garden-lights', 'garden-theme', 'room-feed']);
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
  const SAMPLE = { lux: 85, lux_threshold: 40, source: 'input_boolean.kitchen_cooking', hold: 'binary_sensor.kitchen_monitor', theme: 'halloween', minutes: 30, scene: 'cosy_evening', mode: 'baseline_night', rooms: 'parlour,home_office', skipped: 'bedroom', room: 'home_office', temp: 31.26, target: 21, clamped_from: 27, credited: 120, balance: 3400, count: 2, indoor: 26.4, outdoor: 18.2, problem: 'unreadable', modifier: 'guest' };
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
  assert.equal(text('lighting:lux_high', { lux: 85, lux_threshold: 40 }), 'Stayed off: bright enough (85 lx, on below 40)');
  assert.equal(text('lighting:lux_high', { lux: null, lux_threshold: 40 }), 'Stayed off: bright enough (no light reading, on below 40)');
  assert.equal(text('lighting:lux_high', { lux: 1e12, lux_threshold: -5 }), 'Stayed off: bright enough (200000 lx, on below 0)', 'formatted numbers are clamped');
  assert.equal(text('lighting:external_suppress_active', { source: 'binary_sensor.kitchen_monitor' }), 'Stayed off: held off by Kitchen monitor', 'entities are worded by friendly name');
  assert.equal(text('lighting:external_suppress_active', { source: 'input_boolean.unknown_thing' }), 'Stayed off: held off by input_boolean.unknown_thing', 'falls back to the id');
  assert.equal(text('occupied:strong_hold_started', { hold: 'binary_sensor.kitchen_monitor' }), 'Marked occupied · held by Kitchen monitor');
  assert.equal(text('occupied:strong_hold_active', { hold: 'binary_sensor.kitchen_monitor' }), 'Stayed occupied: held by Kitchen monitor');
  assert.equal(text('lighting:on_outside_evening_window', { minutes: 30 }), 'Preview started · turned on outside the evening (off after 30 min)');
});

ok('wording table: the garden and feed sentences carry over, so the wording does not change', () => {
  const carried = { 'lighting:calendar_boundary': 'calendar', 'lighting:calendar_boundary_catch_up': 'calendar, after a restart', 'lighting:on_outside_evening_window': 'turned on outside the evening', 'lighting:preview_ended': 'preview over', 'lighting:theme_scene_missing': 'no scene for this theme', 'lighting:lux_low': 'getting dark', 'lighting:lux_high': 'bright enough', 'lighting:recent_auto_off': 'back soon after lights went off', 'occupied:containment_failsafe_expired': 'closed-door timeout ended', 'lighting:house_sleep_mode': 'house asleep', 'lighting:sunset': 'sunset', 'lighting:sunrise': 'sunrise', 'lighting:schedule_off': 'scheduled off', 'occupied:motion_detected': 'motion detected', 'occupied:timer_expired': 'timer ran out', 'lighting:button_cycle': 'button pressed' };
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
  assert.equal(text('heating:valve_characteristic_lost', { room: 'home office' }), 'Home office radiator valve needs an adaptation run · notification sent');
  assert.equal(text('heating:valve_characteristic_lost', { room: null }), 'A radiator valve needs an adaptation run · notification sent');
  assert.equal(text('heating:overtemp_heater_on', { temp: 31.26 }), 'Heater off · too hot (31.3°)');
  assert.equal(text('heating:overtemp_heater_on', { temp: 1e9 }), 'Heater off · too hot (50°)', 'clamped');
  assert.equal(text('heating:overtemp_heater_on', { temp: null }), 'Heater off · too hot');
  assert.equal(text('heating:temperature_set_arbitrage', { mode: 'comfort', target: 21, clamped_from: 27 }), 'Heating set to comfort (21°) · cheap power, limited from 27°');
  assert.equal(text('heating:temperature_set_arbitrage', { mode: 'comfort', target: null, clamped_from: null }), 'Heating set to comfort · cheap power');
  assert.equal(text('house_mode:parlour_active', {}), 'Sleep mode not started: parlour in use');
  assert.equal(text('lighting:theme_scene_settled', { theme: 'halloween' }), 'Light effects started · halloween theme scene');
  assert.equal(text('lighting:theme_scene_settled', { theme: null }), 'Light effects started · new theme scene');
  assert.equal(text('lighting:no_lights_in_theme_roles', { theme: null }), 'Effects not started: no lights set up for this theme');
  assert.equal(text('lighting:automation_disabled_restore', {}), 'Automation switched off · porch look restored');
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
  assert.match(status, /2 need attention/);
  assert.match(status, /Pulse<\/b> · Reason not worded/);
  assert.match(status, /data-path="\/pulse-dashboard\/room-bedroom"/, 'the link goes to the real room first');
  const only = P.render('status', {}, withRooms(P.ROOM_ORDER.map(FULL), [], cat(['lighting:brand_new_reason'])), NOW);
  assert.match(only, /1 needs attention[\s\S]*Reason not worded/);
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
const tileBusy = (html) => /<button class="tile[^"]*" data-act="scene" data-entity="scene\.parlour_lamps" aria-pressed="[a-z]+" aria-busy="true">/.test(html);

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
    [{ lights_on: 0, scene: '' }, 'off', { on: false, badge: 'Off', phrase: 'Lights off', clause: 'lights off' }],
    [{ lights_on: 2, scene: '' }, '', { on: true, badge: 'On', phrase: 'Lights on', clause: 'lights on' }],
    [{ lights_on: 2, scene: 'lamps' }, 'lamps', { on: true, badge: 'Lamps', phrase: 'Lamps scene', clause: 'lights on' }],
    [{ lights_on: 1, scene: 'off' }, 'off', { on: true, badge: 'On', phrase: 'Lights on', clause: 'lights on' }],
  ];
  for (const [over, scene, want] of cases) {
    const m = P.roomModel(withRooms([room(over)], []), 'parlour');
    assert.deepEqual(P.lightsState(m, scene), want, JSON.stringify(over));
    const hass = withRooms([room(over)], [], { 'sensor.parlour_active_scene': { state: scene ? `parlour_${scene}` : 'unknown', attributes: {} } });
    const sceneState = { 'sensor.parlour_active_scene': { state: scene ? `parlour_${scene}` : 'unknown', attributes: {} } };
    const tile = P.render('rooms', {}, withRooms([room({ ...over, occupied: false })], [], sceneState), NOW);
    assert.ok(tile.includes(`<span>${want.badge}</span>`), `tile says "${want.badge}"`);
    const inUse = P.render('rooms', {}, withRooms([room(over)], [], sceneState), NOW);
    assert.ok(inUse.includes(`</svg>${want.badge}</span>`), `occupied card says "${want.badge}"`);
    assert.ok(P.render('lights', { room: 'parlour' }, hass, NOW).includes(`<div class="h">${want.phrase}</div>`), `Lights card says "${want.phrase}"`);
    assert.ok(P.render('room-head', { room: 'parlour' }, hass, NOW).includes(`Occupied · ${want.clause}`), `banner says "${want.clause}"`);
  }
  // No second source of lights words: the old functions are gone and the phrases appear only inside lightsState.
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /lightsPhrase|lightsBadgeText|tidyVerdict|lightsExplain/);
  assert.equal((src.match(/function lightsState/g) || []).length, 1, 'one definition');
});

ok('room page order: banner, Lights, Heating, Presence, Media, Recent activity', () => {
  const cards = loadYaml('info_templates.yaml').pulse_room.card.cards.filter((c) => c.mode !== 'device').map((c) => (c.type === 'conditional' ? 'chart' : c.mode));
  assert.deepEqual(cards, ['room-head', 'lights', 'heating', 'chart', 'presence', 'media', 'room-feed']);
  // Rendered in template order for a room that has every section, the headings come out in that order.
  const hass = withRooms([quietRoom('parlour', { occupied: true, lights_on: 2, target: 20, mode_target: 20, mode_name: 'comfort' })], [], {
    'input_boolean.parlour_automation_lights_enabled': { state: 'on', attributes: {} },
  });
  const html = cards.filter((m) => m !== 'chart').map((m) => P.render(m, { room: 'parlour' }, hass, NOW)).join('');
  const heads = [...html.matchAll(/class="lbl" style="margin:4px 4px -10px">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Lights', 'Heating', 'Presence', 'Media', 'Recent activity']);
  assert.match(html.slice(0, html.indexOf('>Lights<')), /^<div class="p"><div[^>]*><a [^>]*Back to House[\s\S]*>Parlour<\/div>[\s\S]*settings-open[\s\S]*All good/, 'the header row (back, name, gear) comes first, then the banner');
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

// ── Room settings panel (step 5b) ────────────────────────────────────────────────────────────────────
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
const sheet = (room, hass = sheetHass()) => P.render('room-head', { room }, hass, NOW, { settings: true });
const titlesOf = (html) => [...html.matchAll(/class="lbl"[^>]*>([^<]+)</g)].map((m) => m[1]);

ok('settings: the gear is in every room header and the sheet is a labelled dialog only while open', () => {
  for (const k of P.ALL_ROOM_KEYS) {
    const closed = P.render('room-head', { room: k }, sheetHass(), NOW, {});
    assert.match(closed, new RegExp(`data-act="settings-open" data-room="${k}" aria-haspopup="dialog" aria-label="${P.ROOMS[k].name} settings"`), k);
    assert.doesNotMatch(closed, /role="dialog"|class="sheet"/, `${k} closed`);
    const open = sheet(k);
    assert.match(open, /role="dialog" aria-modal="true" aria-labelledby="sheet-title"/, k);
    assert.match(open, new RegExp(`id="sheet-title"[^>]*>${P.ROOMS[k].name} settings<`), k);
    assert.match(open, /data-act="settings-close" aria-label="Close settings"/, k);
    assert.doesNotMatch(open, NOISE, k);
  }
  assert.equal(P.render('room-head', { room: 'bedroom' }, sheetHass(), NOW), P.render('room-head', { room: 'bedroom' }, sheetHass(), NOW, {}), 'no ui is the same as closed');
});

ok('room head: Pulse header row (back link, name, gear) in that order, then the banner', () => {
  for (const k of P.ALL_ROOM_KEYS) {
    const html = P.render('room-head', { room: k }, sheetHass(), NOW, {});
    const name = P.ROOMS[k].name;
    const iBack = html.indexOf(`data-act="nav" data-path="${P.HOUSE_PATH}" aria-label="Back to House"`);
    const iName = html.indexOf(`font-size:28px;font-weight:700;letter-spacing:-.4px">${name}</div>`);
    const iGear = html.indexOf('data-act="settings-open"');
    const iBanner = html.indexOf('<div class="card pad');
    assert.ok(iBack > 0 && iBack < iName && iName < iGear && iGear < iBanner, `${k}: back, name, gear, banner`);
    assert.equal((html.match(/data-act="settings-open"/g) || []).length, 1, k);
    assert.equal((html.match(/Back to House/g) || []).length, 1, k);
    assert.match(html, /class="round quiet tap" data-act="nav"/, k);
    assert.match(html, new RegExp(`data-act="settings-open" data-room="${k}" aria-haspopup="dialog" aria-label="${name} settings"`), k);
    assert.ok(!html.slice(iBanner).includes('settings-open'), `${k}: the gear is no longer in the banner`);
  }
});

ok('settings: open and close are state in ui, focus goes into the sheet then back to the gear, and the page underneath is unchanged', () => {
  const ui = { settings: false, focus: null };
  P.settingsOpen(ui, 'bathroom');
  assert.deepEqual([ui.settings, ui.focus], [true, { act: 'settings-close' }], 'focus moves to the Close button');
  P.settingsClose(ui);
  assert.deepEqual([ui.settings, ui.focus], [false, { act: 'settings-open' }], 'focus returns to the gear');
  assert.throws(() => P.settingsOpen(ui, 'attic'), /no settings for "attic"/);
  assert.throws(() => P.settingsOpen(ui, '__proto__'), /no settings/);
  assert.throws(() => P.settingsOpen(null, 'bathroom'), /needs the card ui state/);
  // Both focus targets exist in the markup they are meant for.
  const closed = P.render('room-head', { room: 'bathroom' }, sheetHass(), NOW, { settings: false });
  assert.ok(closed.includes('data-act="settings-open"'));
  assert.ok(sheet('bathroom').includes('data-act="settings-close"'));
  // The sheet is added to the room-head card only: every other section renders the same open or closed.
  for (const m of ['lights', 'heating', 'presence', 'media', 'room-feed']) {
    assert.equal(P.render(m, { room: 'parlour' }, sheetHass(), NOW, { settings: true }), P.render(m, { room: 'parlour' }, sheetHass(), NOW, { settings: false }), m);
  }
  const base = P.render('room-head', { room: 'bathroom' }, sheetHass(), NOW, {});
  assert.ok(sheet('bathroom').startsWith(base.slice(0, base.length - '</div>'.length)), 'the sheet is appended after the unchanged header row and banner');
});

ok('settings: Tab wraps inside the sheet', () => {
  assert.equal(P.tabTarget(0, 3, false), 1);
  assert.equal(P.tabTarget(2, 3, false), 0, 'forward from the last wraps to the first');
  assert.equal(P.tabTarget(0, 3, true), 2, 'back from the first wraps to the last');
  assert.equal(P.tabTarget(-1, 3, false), 0, 'from outside enters at the first');
  assert.equal(P.tabTarget(-1, 3, true), 2, 'shift-Tab from outside enters at the last');
  assert.equal(P.tabTarget(0, 0, false), -1, 'nothing to focus');
  assert.equal(P.tabTarget(0, 1, false), 0);
});

ok('settings: groups per room, in subsystem order, with the plan rows', () => {
  const groupsOf = (k) => titlesOf(sheet(k));
  for (const k of ['parlour', 'hallway_downstairs', 'hallway_upstairs', 'bedroom']) assert.deepEqual(groupsOf(k), ['Lights', 'Heating', 'Presence'], k);
  assert.deepEqual(groupsOf('kitchen'), ['Lights', 'Heating', 'Presence', 'Media']);
  assert.deepEqual(groupsOf('home_office'), ['Lights', 'Heating', 'Presence', 'Media']);
  assert.deepEqual(groupsOf('bathroom'), ['Lights', 'Heating', 'Presence', 'Fan']);
  assert.deepEqual(groupsOf('foreign_office'), ['Lights', 'Heating', 'Presence']);
  assert.deepEqual(groupsOf('front_garden'), ['Lights']);
  assert.deepEqual(groupsOf('back_garden'), ['Lights']);
  const ids = (k) => [...sheet(k).matchAll(/data-act="setting-(?:toggle|number)" data-room="(\w+)" data-group="(\w+)" data-key="(\w+)"/g)].map((m) => `${m[2]}/${m[3]}`);
  assert.ok(ids('bathroom').includes('fan/automation') && ids('bathroom').includes('fan/min_run') && ids('bathroom').includes('lights/lux_dark'));
  assert.ok(ids('front_garden').includes('lights/calendar'), 'Follow calendar is a front garden setting');
  assert.ok(!ids('back_garden').includes('lights/calendar'));
  assert.ok(!ids('bedroom').some((x) => x.startsWith('fan/')), 'a room with no fan has no Fan group');
  assert.doesNotMatch(sheet('bedroom'), /Fan/);
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
  const heating = html.slice(html.indexOf('>Heating<'), html.indexOf('>Presence<'));
  for (const [key, shown] of [['door_delta', '2.5°'], ['door_min_outdoor', '8.0°'], ['door_comfort', '24.0°'], ['door_cooldown', '60 min']]) {
    assert.match(heating, new RegExp(`data-act="setting-number" data-room="foreign_office" data-group="heating" data-key="${key}" data-delta="1"`), key);
    assert.ok(heating.includes(shown), `${key} shows ${shown}`);
  }
  for (const k of ['kitchen', 'home_office']) {
    const media = sheet(k).slice(sheet(k).indexOf('>Media<'));
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

ok('settings: rows with a missing or unusable helper are hidden and an empty group is not shown', () => {
  // hallway_upstairs has no heating helper at all: no Heating group.
  assert.deepEqual(titlesOf(sheet('hallway_upstairs', sheetHass({ 'input_boolean.hallway_upstairs_automation_heating_enabled': null }))), ['Lights', 'Presence']);
  const noLux = sheet('bedroom', sheetHass({ 'input_number.bedroom_automation_lux_threshold_dark': null }));
  assert.doesNotMatch(noLux, /Dark below/);
  assert.match(noLux, /Lights automation/, 'the other Lights row stays');
  const unusable = sheet('bedroom', sheetHass({ 'input_number.bedroom_automation_lux_threshold_dark': b('unavailable'), 'input_boolean.bedroom_sensor_motion_enabled': b('unknown') }));
  assert.doesNotMatch(unusable, /Dark below|Motion sensor/);
  assert.deepEqual(titlesOf(unusable), ['Lights', 'Heating'], 'Presence has no usable row');
  const fanGone = sheet('bathroom', sheetHass(Object.fromEntries(['input_boolean.bathroom_automation_fan_enabled', 'input_number.bathroom_automation_fan_min_run', 'input_number.bathroom_automation_fan_max_run', 'input_number.bathroom_automation_fan_humidity_margin'].map((x) => [x, null]))));
  assert.doesNotMatch(titlesOf(fanGone).join(), /Fan/);
  const partial = sheet('bathroom', sheetHass({ 'input_number.bathroom_automation_fan_max_run': b('unknown') }));
  assert.match(partial, /Minimum run/);
  assert.doesNotMatch(partial, /Maximum run/);
  // Nothing readable at all: an honest empty sheet, not a blank one.
  const none = P.render('room-head', { room: 'kitchen' }, mk(), NOW, { settings: true });
  assert.match(none, /No settings available for this room/);
  assert.match(none, /role="dialog"/);
});

ok('settings: every row names a helper that exists in packages/helpers.yaml, except those listed as missing', () => {
  const missing = settingRows().filter(({ row }) => !helperIds.has(row.id)).map(({ room, group, row }) => `${room}/${group}/${row.key}`);
  assert.deepEqual(missing, ['hallway_upstairs/heating/automation'], 'the only absent helper (hidden at run time)');
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
  assert.deepEqual(titlesOf(html), ['Mo']);
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

await okAsync('settings: the card element opens from a request, closes on Escape, and returns focus (fake DOM)', async () => {
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, window: globalThis.window };
  let Card;
  const focused = [];
  const mkEl = (name, connected = true, dataset = {}) => ({ name, isConnected: connected, dataset, focus() { focused.push(name); } });
  const listeners = {};
  // The controls the real DOM would hold for the focus targets: the Close button inside the sheet, and the gear.
  const controls = [mkEl('close', true, { act: 'settings-close' }), mkEl('gear', true, { act: 'settings-open', room: 'bathroom' })];
  globalThis.HTMLElement = class { constructor() { this.style = {}; } attachShadow() { return { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return controls; }, activeElement: null, innerHTML: '' }; } };
  globalThis.customElements = { get() { return undefined; }, define(n, c) { if (n === 'pulse-card') Card = c; } };
  globalThis.window = { customCards: [], addEventListener(t, f) { listeners[t] = f; }, removeEventListener(t) { delete listeners[t]; } };
  try {
    const modPath = new URL('../www/pulse-card.js', import.meta.url).pathname;
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    const mkRoomHead = (room) => { const c = new Card(); Object.defineProperty(c, 'isConnected', { get: () => true }); c.setConfig({ mode: 'room-head', room }); c.hass = sheetHass(); c.connectedCallback(); return c; };
    const c = mkRoomHead('bathroom');
    assert.ok(listeners['pulse-card:settings'] && listeners.keydown, 'listens on window while mounted');
    // A request for another room, or from a card that is not a room-head, does nothing.
    listeners['pulse-card:settings']({ detail: { room: 'kitchen', opener: mkEl('x') } });
    assert.equal(c._ui.settings, false);
    const presenceLink = mkEl('presence-link');
    listeners['pulse-card:settings']({ detail: { room: 'bathroom', opener: presenceLink } });
    assert.equal(c._ui.settings, true);
    assert.ok(c._html.includes('role="dialog"'), 'painted with the sheet');
    assert.deepEqual(focused, ['close'], 'focus moved into the sheet, onto Close');
    // Escape closes, and focus goes back to the control that opened it (the Presence link).
    let prevented = false;
    listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
    assert.ok(prevented && c._ui.settings === false);
    assert.ok(!c._html.includes('role="dialog"'), 'repainted without the sheet');
    assert.equal(focused[focused.length - 1], 'presence-link', 'the opener ends up focused');
    focused.length = 0;
    // Opened from the gear (which the repaint replaces): focus falls back to the gear through ui.focus.
    listeners['pulse-card:settings']({ detail: { room: 'bathroom', opener: mkEl('gear', false) } });
    listeners.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(c._ui.settings, false);
    assert.deepEqual(focused, ['close', 'gear'], 'into the sheet on open, the gear takes focus on the repaint');
    // Other keys do nothing while closed; Escape while closed does nothing.
    listeners.keydown({ key: 'Escape', preventDefault() { assert.fail('closed: Escape is not ours'); } });
    // Tab inside the open sheet wraps.
    listeners['pulse-card:settings']({ detail: { room: 'bathroom', opener: mkEl('gear2', false) } });
    const a = mkEl('a'); const z = mkEl('z');
    c._sheetControls = () => [a, z];
    c._root.activeElement = z;
    let tabPrevented = false;
    listeners.keydown({ key: 'Tab', shiftKey: false, preventDefault() { tabPrevented = true; } });
    assert.ok(tabPrevented);
    assert.equal(focused[focused.length - 1], 'a', 'Tab from the last control wraps to the first');
    c._root.activeElement = a;
    listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
    assert.equal(focused[focused.length - 1], 'z', 'Shift-Tab from the first wraps to the last');
    c.disconnectedCallback();
    assert.ok(!listeners['pulse-card:settings'] && !listeners.keydown, 'listeners removed on unmount');
  } finally {
    Object.assign(globalThis, saved);
    if (saved.window === undefined) delete globalThis.window;
  }
});

console.log(`\n${n} test groups passed`);

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

ok('touchGuard: allows a scroll the sheet body can still make, cancels everything else', () => {
  const g = P.touchGuard;
  // body 600 tall in a 300 viewport: max scrollTop 300. Positive deltaY is a swipe down (content moves toward its top).
  assert.equal(g(150, 600, 300, -20, true), 'allow', 'middle, swipe up');
  assert.equal(g(150, 600, 300, 20, true), 'allow', 'middle, swipe down');
  assert.equal(g(0, 600, 300, 20, true), 'prevent', 'top edge, swipe down would chain to the page');
  assert.equal(g(0, 600, 300, -20, true), 'allow', 'top edge, swipe up scrolls');
  assert.equal(g(300, 600, 300, -20, true), 'prevent', 'bottom edge, swipe up would chain to the page');
  assert.equal(g(299.6, 600, 300, -20, true), 'prevent', 'fractional bottom counts as the bottom');
  assert.equal(g(300, 600, 300, 20, true), 'allow', 'bottom edge, swipe down scrolls back');
  assert.equal(g(0, 300, 300, -20, true), 'prevent', 'no overflow, up');
  assert.equal(g(0, 300, 300, 20, true), 'prevent', 'no overflow, down');
  assert.equal(g(150, 600, 300, -20, false), 'prevent', 'outside the body (scrim, header)');
  assert.equal(g(150, 600, 300, 0, true), 'allow', 'no vertical movement yet');
  assert.equal(g(NaN, 600, 300, -20, true), 'prevent', 'unmeasurable fails safe');
});

ok('lockScroll: locks every target and restores overflow and the exact position, once', () => {
  const a = { style: { overflow: '' }, scrollTop: 420 };
  const b = { style: { overflow: 'auto' }, scrollTop: 0 };
  const unlock = P.lockScroll([a, null, b, 7]);
  assert.equal(a.style.overflow, 'hidden');
  assert.equal(b.style.overflow, 'hidden');
  a.scrollTop = 0; // the browser moved it while locked
  unlock();
  assert.deepEqual([a.style.overflow, a.scrollTop, b.style.overflow, b.scrollTop], ['', 420, 'auto', 0]);
  a.scrollTop = 5; unlock();
  assert.equal(a.scrollTop, 5, 'a second unlock does nothing');
  assert.equal(typeof P.lockScroll(undefined), 'function', 'bad input still returns an unlock');
});

ok('splitSheet: separates the sheet from the page, and a closed room-head has none', () => {
  const open = P.splitSheet(sheet('bathroom'));
  assert.ok(open.sheet.startsWith(P.SHEET_MARK) && open.sheet.includes('class="sb"') && !open.page.includes('class="ovl"'));
  assert.ok(open.page.includes('data-act="settings-open"'));
  assert.deepEqual(P.splitSheet(P.render('room-head', { room: 'bathroom' }, sheetHass(), NOW, {})).sheet, '');
  assert.deepEqual(P.splitSheet(undefined), { page: '', sheet: '' });
});

ok('settings portal: open adds exactly one host to the body, repaints reuse it and keep the scroll, close and disconnect remove it', () => {
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, window: globalThis.window, document: globalThis.document };
  let Card;
  const bodyKids = [];
  const mkRoot = () => {
    const sb = { scrollTop: 0 };
    return { listeners: {}, addEventListener(t, f, o) { this.listeners[t] = { f, o }; }, querySelector(q) { return q === '.sb' && this.innerHTML.includes('class="sb"') ? sb : null; }, querySelectorAll() { return []; }, activeElement: null, innerHTML: '', sb };
  };
  globalThis.HTMLElement = class { constructor() { this.style = {}; } attachShadow() { return mkRoot(); } };
  globalThis.customElements = { get() { return undefined; }, define(n, c) { if (n === 'pulse-card') Card = c; } };
  globalThis.window = { customCards: [], addEventListener() {}, removeEventListener() {} };
  const docEl = { style: { overflow: '' }, scrollTop: 300 };
  globalThis.document = {
    documentElement: docEl, scrollingElement: docEl, body: { style: { overflow: '' }, scrollTop: 0, appendChild(h) { bodyKids.push(h); } },
    createElement() { const h = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, attachShadow() { this.shadow = mkRoot(); return this.shadow; }, remove() { bodyKids.splice(bodyKids.indexOf(this), 1); } }; return h; },
  };
  try {
    const modPath = new URL('../www/pulse-card.js', import.meta.url).pathname;
    delete require.cache[require.resolve(modPath)];
    require(modPath);
    const c = new Card();
    Object.defineProperty(c, 'isConnected', { get: () => true });
    c.setConfig({ mode: 'room-head', room: 'bathroom' });
    c.hass = sheetHass();
    assert.equal(bodyKids.length, 0, 'closed: no host');
    window.dispatchEvent = undefined;
    c._settingsRequest({ detail: { room: 'bathroom', opener: null } });
    assert.equal(bodyKids.length, 1, 'open: exactly one host');
    const host = bodyKids[0];
    assert.ok(host.shadow.innerHTML.includes('class="sheet"') && host.shadow.innerHTML.includes('<style>'), 'sheet and styles are in the portal');
    assert.ok(!c._root.innerHTML.includes('class="sheet"'), 'and not in the card');
    assert.equal(host.shadow.listeners.touchmove.o.passive, false, 'the touch guard can cancel');
    assert.ok(host.shadow.listeners.click && host.shadow.listeners.change, 'controls are wired');
    assert.equal(docEl.style.overflow, 'hidden', 'the page scroller is locked');
    // a repaint (stepper tap) updates the same host and keeps the sheet's scroll position
    host.shadow.sb.scrollTop = 180;
    c._html = null;
    c._paint();
    assert.equal(bodyKids.length, 1, 'repaint does not add a second host');
    assert.equal(host.shadow.sb.scrollTop, 180, 'sheet scroll kept across the repaint');
    // close removes it and restores the page position
    docEl.scrollTop = 0;
    c._settingsClose();
    assert.equal(bodyKids.length, 0, 'closed: host removed');
    assert.deepEqual([docEl.style.overflow, docEl.scrollTop], ['', 300], 'page lock released at the saved position');
    // touchmove outside .sb is cancelled; inside, at the bottom edge, swiping up is cancelled
    c._settingsRequest({ detail: { room: 'bathroom', opener: null } });
    const h2 = bodyKids[0];
    const calls = [];
    const pos = { x: 0, y: 100 };
    const ev = (target, y) => ({ touches: [{ clientX: 0, clientY: y }], target, cancelable: true, preventDefault() { calls.push('p'); } });
    c._sheetTouch(ev({ closest: () => null }, 80), pos);
    assert.deepEqual(calls, ['p'], 'scrim/header move cancelled');
    pos.y = 100;
    c._sheetTouch(ev({ closest: () => ({ scrollTop: 300, scrollHeight: 600, clientHeight: 300 }) }, 80), pos);
    assert.equal(calls.length, 2, 'bottom edge, swipe up cancelled');
    pos.y = 100;
    c._sheetTouch(ev({ closest: () => ({ scrollTop: 100, scrollHeight: 600, clientHeight: 300 }) }, 80), pos);
    assert.equal(calls.length, 2, 'mid-scroll allowed');
    // a disconnect while open removes the host and lets go of the page
    c.disconnectedCallback();
    assert.equal(bodyKids.length, 0, 'disconnect removes the host');
    assert.equal(docEl.style.overflow, '');
    assert.equal(c._ui.settings, false);
    assert.ok(h2);
    // a portal that cannot attach falls back to the in-card sheet, with a warning
    const warns = []; const w = console.warn; console.warn = (m) => warns.push(m);
    try {
      globalThis.document.body.appendChild = () => { throw new Error('nope'); };
      const d = new Card();
      Object.defineProperty(d, 'isConnected', { get: () => true });
      d.setConfig({ mode: 'room-head', room: 'bathroom' });
      d.hass = sheetHass();
      d._settingsRequest({ detail: { room: 'bathroom', opener: null } });
      assert.ok(d._root.innerHTML.includes('class="sheet"'), 'fallback: sheet stays in the card');
      assert.equal(bodyKids.length, 0);
      assert.equal(docEl.style.overflow, '', 'failed attach leaves the page unlocked');
      assert.ok(warns.some((m) => /kept inside the card/.test(m)));
    } finally { console.warn = w; }
  } finally {
    Object.assign(globalThis, saved);
    for (const k of Object.keys(saved)) if (saved[k] === undefined) delete globalThis[k];
  }
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
