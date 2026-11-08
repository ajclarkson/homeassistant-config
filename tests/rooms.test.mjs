// Pulse card tests: rooms. Run: cd tests && npm test (or node --test rooms.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { Raw, P, root, NOW, whyAll, FULL, SCENES, registryFixture, mk, withRooms, histEntry, histSensor, luxHigh, rowOf, rowTitle, rowSub, rowValue, NOISE, GARDENS, renderAll, noNoise, story, loadYaml, real, quietRoom, calmRooms, count, day, decl, px, rule, tile, footnote, b, dark, worded, helperIds, sheetHass, sheet, closedSheet, over } from './helpers.mjs';

const INDOOR_KEYS = P.ALL_ROOM_KEYS.filter((k) => !GARDENS.includes(k));

const kitchenEntity = (id, friendly) => ({ [id]: { state: 'on', attributes: { friendly_name: friendly } } });

test('10 rooms configured', () => assert.equal(P.ALL_ROOM_KEYS.length, 10));

test('every mode renders for all 10 rooms with full report data (attention state)', () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const hass = withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }]);
  const out = renderAll(hass);
  noNoise(out, 'full');
  assert.match(out.status, /<h2[^>]*>Needs attention<\/h2>/);
  assert.equal(rowTitle(rowOf(out.status, '/pulse-dashboard/room-bedroom')), 'Bedroom');
  assert.match(out['room-head:bedroom'], /Window open, heating on[\s\S]*Open window while heating/, 'the attention item sits under the header');
  assert.match(out['heating:bedroom'], /class="hm-rt">Window open<\/div><\/div><span class="hm-val num">[\d.]+°/, 'a window-open target is explained under the grid');
  assert.match(out.rooms, /room-bedroom/, 'the room is still listed under Rooms');
  assert.match(out['presence:bedroom'], /<div class="hm-rt">Occupied<\/div><div class="hm-rs">Empty a few minutes after the bed clears<\/div><\/div><span class="hm-val num">Bed</);
  assert.doesNotMatch(out['presence:bedroom'], /Bed occupied · Window open/);
});

test('sparse report entries (only k) never throw and keep a calm render', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ k }));
  const out = renderAll(withRooms(rooms, [{}, { key: 'nope' }]));
  noNoise(out, 'sparse');
});

test('no info_rooms / info_attention at all (fresh restart) renders honest empty states', () => {
  const out = renderAll(mk());
  noNoise(out, 'missing');
  assert.match(out.status, /No attention report/);
  assert.match(out['room-head:bedroom'], /<span class="hm-line">No report<\/span>/);
  assert.equal(out['presence:bedroom'], '', 'no report: no presence rows');
  assert.match(out['automation:bedroom'], /data-id="bedroom:automation"/, 'the Automation row still stands alone, without a Presence header');
  assert.equal(out['heating:bedroom'], '');
});

test('attributes arriving as JSON strings, garbage strings or wrong types', () => {
  const garbage = withRooms('not json', []);
  noNoise(renderAll(garbage), 'garbage');
  const weird = mk({ 'sensor.info_rooms': { state: 'ok', attributes: { rooms: 42 } }, 'sensor.info_attention': { state: '1', attributes: { items: { a: 1 } } } });
  noNoise(renderAll(weird), 'weird');
  const nulls = withRooms([{ k: 'bedroom', temp: null, target: 'abc', lights_on: 'x', manual: 'str', holds: 'nope', labels: 7 }], []);
  noNoise(renderAll(nulls), 'nulls');
});

test('no-climate rooms: no numbers card, "no climate" in row', () => {
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

test('manual marker: the Lights card shows a Manual tag, and its story says who set it and what ends it', () => {
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
  assert.match(auto, /<p class="hm-foot">Lamps on since 18:30 · off when the room empties<\/p>/, 'plain words, not the Activity sentence');
  assert.doesNotMatch(auto, /Scene set|Auto · |on at 40 or below/);
  const hold = why({ manual: null, lights_on: 2, pres_labels: ['Monitor on'], labels: ['Monitor on'] }, histSensor('parlour', [dark]));
  assert.match(hold, /<p class="hm-foot">Lamps on since 18:30 · stay on while the monitor is on<\/p>/);
  assert.doesNotMatch(hold, /Hold/);
  const sofa = why({ manual: null, lights_on: 2, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'] }, histSensor('parlour', [dark]));
  assert.match(sofa, /Lamps on since 18:30 · stay on while the sofa is occupied</);
  const two = why({ manual: null, lights_on: 2, pres_labels: ['Sofa occupied', 'Doors closed'], labels: [] }, histSensor('parlour', [dark]));
  assert.match(two, /stay on while the sofa is occupied and the doors are closed</);
  assert.match(why({ manual: null, lights_on: 2, pres_labels: ['Sonos playing'], labels: [] }, histSensor('parlour', [dark])), /stay on while Sonos is playing</);
  // Any last action that did not set a scene keeps the shared wording, with no "Hold" tag.
  const sunset = histEntry(12, { location: 'parlour', decision: 'turn_on', reason: 'sunset' });
  const other = why({ manual: null, lights_on: 2, pres_labels: ['Monitor on'], labels: ['Monitor on'] }, histSensor('parlour', [sunset]));
  assert.match(other, /Lights on · sunset at 18:30 · stays on while Monitor on</);
  assert.doesNotMatch(other, /Hold|Lamps on since/);
  assert.equal(P.REASON_TEXT['lighting:lux_low']({ lux: 12, lux_threshold: 40, scene: 'parlour_lamps' }, {}), 'Scene set (parlour lamps) · room occupied and dark (12 lx, on at 40 or below)', 'the shared wording is untouched');
  const off = why({ manual: null, lights_on: 0, pres_labels: ['Monitor on'], labels: ['Monitor on'] });
  assert.doesNotMatch(off, /stays on while/, 'a held room with the lights off does not claim they stay on');
  const disabled = why({ manual, lights_enabled: false });
  assert.match(disabled, /Lights automation is off · they change only by hand/);
  assert.doesNotMatch(disabled, /Auto · |Manual · /, 'the sentence already says it, so no mode prefix');
  assert.match(why({ manual: null }, histSensor('parlour', [])), /No lighting decision recorded yet/);
  assert.match(why({ manual: null }), /Lighting history unavailable/, 'a missing history sensor is said, not passed off as quiet');
});

test('lightsStory rule 1: lights automation off beats a declined entry and a manual change', () => {
  const s = story({ lights_enabled: false, manual: { source: 'wall_button', ts: histEntry(1).ts, what: '' } }, histSensor('kitchen', [luxHigh(1)]));
  assert.equal(s.state, 'disabled');
  assert.equal(s.why, 'Lights automation is off · they change only by hand');
});

test('lightsStory rule 2: a manual change wins only when newer than the last automated action', () => {
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

test('lightsStory rule 3: lights off in an empty room says since when, notes a disabled motion sensor, flags an unavailable one', () => {
  const occ = (state, changed) => ({ 'binary_sensor.kitchen_occupied': { state, last_changed: changed, attributes: {} } });
  const empty = story({ occupied: false }, { ...occ('off', '2026-10-25T14:03:00+00:00'), ...histSensor('kitchen', [luxHigh(1)]) });
  assert.deepEqual([empty.state, empty.why, empty.tone], ['empty', 'No one seen since 14:03', 'ok'], 'beats a declined entry');
  const noMotion = story({ occupied: false }, { ...occ('off', '2026-10-25T14:03:00+00:00'), 'input_boolean.kitchen_sensor_motion_enabled': { state: 'off', attributes: {} } });
  assert.equal(noMotion.why, 'No one seen since 14:03 · motion sensor is off');
  assert.equal(story({ occupied: false }, occ('off', 'garbage')).why, 'No one seen', 'an unreadable time is dropped, not invented');
  assert.equal(story({ occupied: false }, occ('off', '2030-01-01T00:00:00+00:00')).why, 'No one seen since 18:42', 'a future time is clamped to now');
  const gone = story({ occupied: false, occupancy_unavailable: true });
  assert.deepEqual([gone.why, gone.tone], ['Occupancy sensor unavailable', 'warn']);
  assert.equal(story({ occupied: true, lights_on: 0 }, histSensor('kitchen', [])).state, 'none', 'an occupied room with lights off falls through to history');
  assert.notEqual(story({ occupied: false, lights_on: 2 }, histSensor('kitchen', [])).state, 'empty', 'lights on: not rule 3');
});

test('lightsStory rule 4: a newer decline, abort or failure is explained in words; an older one is not', () => {
  const declined = story({}, histSensor('kitchen', [luxHigh(1), histEntry(30)]));
  assert.deepEqual([declined.state, declined.tone, declined.why], ['declined', 'muted', 'Stayed off at 18:41: bright enough, 85 lx (on at 40 or below)']);
  assert.match(story({}, histSensor('kitchen', [luxHigh(1, null)])).why, /bright enough, no light reading \(on at 40 or below\)/);
  const abort = histEntry(2, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unavailable_input', entity: 'sensor.kitchen_lux' } });
  const a = story({}, { ...histSensor('kitchen', [abort, histEntry(30)]), ...kitchenEntity('sensor.kitchen_lux', 'Lux sensor') });
  assert.deepEqual([a.state, a.tone, a.why], ['problem', 'warn', "Couldn't run: Lux sensor unavailable at 18:40"]);
  const failed = histEntry(2, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'ack_timeout', action: 'light.turn_on', entity: 'light.kitchen_ceiling' } });
  const f = story({}, { ...histSensor('kitchen', [failed, histEntry(30)]), ...kitchenEntity('light.kitchen_ceiling', 'Kitchen ceiling') });
  assert.deepEqual([f.state, f.tone, f.why], ['problem', 'warn', "Kitchen ceiling didn't respond at 18:40"]);
  const old = story({}, histSensor('kitchen', [histEntry(1), luxHigh(30)]));
  assert.equal(old.state, 'acted', 'the decline is older than the last act, so the act explains the lights');
  const heldOn = story({ lights_on: 2, pres_labels: ['Monitor on'] }, histSensor('kitchen', [luxHigh(1)]));
  assert.match(heldOn.why, /^Stayed off at 18:41: bright enough, 85 lx \(on at 40 or below\) · stays on while Monitor on$/);
  const other = story({}, histSensor('kitchen', [histEntry(1, { subsystem: 'occupied', decision: 'set_occupied', reason: 'motion_detected' })]));
  assert.equal(other.state, 'none', 'occupancy entries are not lighting explanations');
});

test('lightsStory rule 5: the last act in words, then an honest empty, then a visible note for a bad payload', () => {
  const s = story({ lights_on: 2 }, histSensor('kitchen', [histEntry(3, { decision: 'turn_on', reason: 'sunset', facts: {} }), histEntry(9, { decision: 'no_action', reason: 'lux_high', outcome: 'declined', facts: { lux: 60, lux_threshold: 40 } })]));
  assert.deepEqual([s.state, s.why], ['acted', 'Lights on · sunset at 18:39 · off when the room empties']);
  assert.equal(story({}, histSensor('kitchen', [])).why, 'No lighting decision recorded yet');
  const bad = story({}, histSensor('kitchen', [], { schema: 'home.history.v9' }));
  assert.deepEqual([bad.why, bad.tone], ['Lighting history unreadable', 'warn']);
  assert.equal(story({}, histSensor('kitchen', [histEntry(1, { subsystem: 'lighting', outcome: undefined, decision: 'turn_on', reason: 'on_by_something' })])).state, 'acted', 'an undeclared decision with actions counts as an act');
});

test('scene tiles use the spike scene map and highlight the active scene', () => {
  for (const k of INDOOR_KEYS) {
    const tiles = [...P.render('lights', { room: k }, mk(), NOW).matchAll(/data-act="scene" data-entity="scene\.(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(tiles, SCENES[k].map((id) => `${k}_${id}`), k);
  }
  for (const g of GARDENS) assert.equal(P.ROOMS[g].scenes, undefined, `${g} offers no scenes of its own`);
});

test('individual lights: a disclosure row with an "N of M on" summary; open, a switch row per light, a slider under a dimmable light that is on, missing honestly', () => {
  const OPEN = { open: { 'parlour:lights': true } };
  const closed = P.render('lights', { room: 'parlour' }, mk(), NOW);
  const html = P.render('lights', { room: 'parlour' }, mk(), NOW, OPEN);
  assert.match(html, /<h2>Lights<\/h2>/);
  assert.equal((html.match(/<h2>/g) || []).length, 1, "the Individual lights row is the label; it adds no section header of its own");
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

test('individual lights summary: "All off" at none, else "N of M on" over the configured lights', () => {
  const lights = P.ROOMS.parlour.lights.map(([id]) => id);
  const sum = (over) => P.render('lights', { room: 'parlour' }, mk(over), NOW).match(/class="hm-val hm-ds">([^<]*)</)[1];
  assert.equal(sum(Object.fromEntries(lights.map((id) => [id, { state: 'off', attributes: {} }]))), 'All off');
  assert.equal(sum(Object.fromEntries(lights.map((id, i) => [id, { state: i === 0 ? 'on' : 'off', attributes: {} }]))), `1 of ${lights.length} on`);
  assert.equal(sum(Object.fromEntries(lights.map((id) => [id, { state: 'on', attributes: {} }]))), `${lights.length} of ${lights.length} on`);
});

test('disclosure: state is per page, default closed, toggled and persisted; a bad id throws; the render gate sees it', () => {
  const key = 'zz_room:lights';
  assert.equal(P.disclosureStore[key], undefined);
  assert.equal(P.toggleDisclosure(key), true);
  assert.equal(P.disclosureStore[key], true);
  assert.equal(P.toggleDisclosure(key), false);
  assert.equal(key in P.disclosureStore, false);
  for (const bad of ['', 'x', 'a:b:c', '__proto__', undefined, 5, 'A:b']) assert.throws(() => P.toggleDisclosure(bad), /bad disclosure id/);
});

test('device mode: fan row shows state and reason, taps toggle, hides when blank, fails loudly when misconfigured', () => {
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

test('fan row keeps its on/off toggle and reason and no longer carries steppers', () => {
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

test('device row sits under the media card and only the bathroom page fills it', () => {
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

test('media only for rooms with players', () => {
  for (const k of INDOOR_KEYS) {
    const html = P.render('media', { room: k }, mk(), NOW);
    assert.equal(html === '', P.ROOMS[k].media.length === 0, k);
  }
  const p = P.render('media', { room: 'parlour' }, mk(), NOW);
  assert.match(p, /data-act="media-play"/);
  assert.match(p, /data-act="volume"/);
  assert.match(p, /data-act="media-power"/);
});

// ── Correctness fixes ─────────────────────────────────────────────────────────────────────────
test('the occupancy row on every room page says Occupied or Empty; no bed icon anywhere on the page', () => {
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

test('Presence row: no trailing value when nothing holds the room; a short hold label when something does', () => {
  const pres = (over) => P.render('presence', { room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: true, ...over } }), []), NOW);
  const free = pres({});
  assert.match(free, /Empties a few minutes after the last movement/);
  assert.doesNotMatch(free, /hm-val|Clear/, 'no status word that reads like a button');
  const bed = pres({ pres_labels: ['Bed occupied'], labels: ['Bed occupied'] });
  assert.match(bed, /<span class="hm-val num">Bed<\/span>/);
  assert.match(pres({ pres_labels: ['Doors closed'], labels: ['Doors closed'] }), /<span class="hm-val num">Doors<\/span>/);
  assert.match(pres({ pres_labels: ['Monitor on'], labels: ['Monitor on'] }), /<span class="hm-val num">Monitor on<\/span>/, 'a hold without a short word shows its own label');
  assert.match(pres({ pres_labels: ['Bed occupied', 'Doors closed'] }), /<span class="hm-val num">Bed \+1<\/span>/);
  assert.doesNotMatch(P.render('presence', { room: 'parlour' }, withRooms(calmRooms({ parlour: { occupied: false } }), []), NOW), /hm-val|Clear/, 'an empty room with no holds is quiet too');
});

test('media players are labelled by device role from the room config, not the entity name', () => {
  const html = P.render('media', { room: 'parlour' }, mk({ 'media_player.parlour': { state: 'playing', attributes: { friendly_name: 'Parlour', volume_level: 0.3 } }, 'media_player.parlour_tv': { state: 'off', attributes: { friendly_name: 'Bravia KD-55' } } }), NOW);
  assert.match(html, /<div class="hm-rt">Soundbar<\/div>/);
  assert.match(html, /<div class="hm-rt">TV<\/div>/);
  assert.doesNotMatch(html, /<div class="hm-rt">Parlour<\/div>|Bravia/);
  assert.match(P.render('media', { room: 'kitchen' }, mk({ 'media_player.kitchen': { state: 'idle', attributes: { friendly_name: 'Kitchen' } } }), NOW), /Kitchen speaker/);
});

test('held-occupied wording has no redundancy', () => {
  const m = quietRoom('parlour', { occupied: true, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], lights_on: 2 });
  const hass = withRooms([m], []);
  const why = whyAll({ room: 'parlour' }, hass, NOW);
  assert.match(why, /<div class="hm-rt">Occupied<\/div><div class="hm-rs">Empty a few minutes after the sofa clears<\/div><\/div><span class="hm-val num">Sofa<\/span>/);
  assert.doesNotMatch(why, /Held occupied|Held by|occupied by Sofa occupied|1 reason/);
  const head = P.render('room-head', { room: 'parlour' }, hass, NOW);
  assert.match(head, /Occupied · lamps on/);
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

test('room page order: Lights, Heating, Media, the fan, Presence, Automation, Activity, one order for every room', () => {
  const cards = loadYaml('info_templates.yaml').pulse_room.card.cards;
  const order = cards.map((c) => c.mode);
  assert.deepEqual(order, ['room-head', 'lights', 'heating', 'media', 'device', 'presence', 'automation', 'room-feed']);
});

test('speaker play button is quiet unless playing; the amber pause button marks active playback', () => {
  const media = (state) => P.render('media', { room: 'kitchen' }, mk({ 'media_player.kitchen': { state, attributes: { friendly_name: 'Kitchen', volume_level: 0.2 } } }), NOW);
  assert.match(media('idle'), /class="round quiet" data-act="media-play"/);
  assert.match(media('paused'), /class="round quiet"/);
  assert.match(media('playing'), /class="round" data-act="media-play"/);
});

test('recent_auto_off is worded as a return after switch-off, not as the lights being off', () => {
  const text = P.REASON_TEXT['lighting:recent_auto_off']({}, { name: () => '' });
  assert.match(text, /back soon after lights went off/);
  assert.doesNotMatch(text, /just switched off/);
});

test('room page copy: subtitle lines have no trailing full stops; no Why card; Individual lights is a disclosure row', () => {
  const m = quietRoom('kitchen', { occupied: true, pres_labels: ['Monitor on'], labels: ['Monitor on'], heat_labels: ['Window open'], hvac_action: 'idle', target: 18, mode_target: 18, mode_name: 'baseline day', heating_active: 'baseline_day', heating_source: 'schedule' });
  const hass = withRooms([m], []);
  const why = whyAll({ room: 'kitchen' }, hass, NOW);
  assert.doesNotMatch(why, /Why it('|&#39;)?s like this|Why it is like this/, 'the separate Why card is gone: each subsystem explains itself');
  assert.match(why, /<h2>Lights<\/h2>[\s\S]*Individual lights[\s\S]*<h2>Heating<\/h2>[\s\S]*<h2>Presence<\/h2>/, 'one titled list per subsystem');
  assert.equal((why.match(/<div class="hm-rs">[^<]*\.<\/div>/g) || []).length, 0, 'no subtitle ends in a full stop');
  assert.match(why, /Window open · Baseline day, from schedule/);
  const lights = P.render('lights', { room: 'kitchen' }, hass, NOW);
  assert.match(lights, /Individual lights/);
  assert.doesNotMatch(lights, /\.<\/p>/, 'footnotes end without a full stop');
  const energy = P.render('energy-day', {}, mk(), NOW, { day: 'today' });
  assert.doesNotMatch(energy, /\.<\/div>/, 'energy notes end without a full stop');
});

test('why card says what ends a heating hold and an occupancy hold', () => {
  const bed = quietRoom('bedroom', { occupied: true, target: 5, mode_target: 5, mode_name: 'minimum', heating_active: 'minimum', heating_source: 'safety', hvac_action: 'idle', pres_labels: ['Bed occupied'], heat_labels: ['Window open'], labels: ['Bed occupied', 'Window open'] });
  const why = whyAll({ room: 'bedroom' }, withRooms([bed], []), NOW);
  assert.match(why, /Held at minimum 5\.0° · window open · normal heating resumes when it closes/);
  assert.match(why, /Empty a few minutes after the bed clears/);
  const off = whyAll({ room: 'bedroom' }, withRooms([bed], [], { 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } }), NOW);
  assert.match(off, /stays at minimum while house heating is off/);
  assert.doesNotMatch(off, /resumes when it closes/);
  const two = whyAll({ room: 'bedroom' }, withRooms([{ ...bed, pres_labels: ['Bed occupied', 'Monitor on'] }], []), NOW);
  assert.match(two, /<div class="hm-rs">Empty a few minutes after the last one clears<\/div><\/div><span class="hm-val num">Bed \+1</);
  const motion = whyAll({ room: 'bedroom' }, withRooms([{ ...bed, pres_labels: [], heat_labels: [] }], []), NOW);
  assert.match(motion, /Empties a few minutes after the last movement/);
  const empty = whyAll({ room: 'bedroom' }, withRooms([{ ...bed, occupied: false, pres_labels: [], heat_labels: [] }], []), NOW);
  assert.doesNotMatch(empty, /holds/i, 'never the engine word');
  assert.doesNotMatch(empty.slice(empty.indexOf('<h2>Presence')), /hm-rs/, 'no sensor time: no subtitle');
  const seen = withRooms([{ ...bed, occupied: false, pres_labels: [], heat_labels: [] }], [], { 'binary_sensor.bedroom_occupied': { state: 'off', last_changed: new Date(NOW - 3600000).toISOString(), attributes: {} } });
  const seenHtml = whyAll({ room: 'bedroom' }, seen, NOW);
  assert.match(seenHtml, /<div class="hm-rs">No one seen since \d\d:\d\d<\/div>/);
  assert.doesNotMatch(seenHtml, /holds/i);
});

test('top guard: a hit-testable invisible header button pushes the back link and gear down; clear targets are left alone', () => {
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

test('top guard: the heading cards (and only they) get the empty row above everything, sized from ui.top', () => {
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

test('no "valve" wording in anything the user reads', () => {
  const bed = quietRoom('bedroom', { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'] });
  const hass = withRooms([bed], [], { 'input_boolean.bedroom_automation_heating_enabled': { state: 'on', attributes: {} } });
  const out = ['room-head', 'lights', 'heating', 'presence', 'automation'].map((m) => P.render(m, { room: 'bedroom' }, hass, NOW)).join('');
  assert.doesNotMatch(out, /valve/i);
  assert.match(out, /Sets the target from mode, windows and schedule/);
  assert.match(out, /Normal target<\/div><div class="hm-rs">Baseline day<\/div><\/div><span class="hm-val num">18\.0°</);
});

test('Presence holds Keep room occupied and says when the motion sensor is off; the switch itself is under Automation, a section of its own', () => {
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
  assert.doesNotMatch(pres, /data-id="bedroom:automation"|data-key="motion"/, 'the Automation row is not part of Presence');
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
  const bare = P.render('presence', { room: 'bedroom' }, mk(), NOW);
  assert.equal(bare, '', 'no report and no toggle: no Presence group');
  assert.match(P.render('automation', { room: 'bedroom' }, mk(), NOW), /data-id="bedroom:automation"/, 'the Automation row stands alone');
});

test('lights wording: every lights phrase comes from lightsState', () => {
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
    const said = want.on ? (want.badge === 'On' ? 'lights on' : `${want.badge.toLowerCase()} on`) : 'lights off';
    assert.ok(P.render('room-head', { room: 'parlour' }, hass, NOW).includes(`<span class="hm-line">Occupied · ${said} · 20.8°</span>`), `subtitle says "${said}"`);
  }
  // No second source of lights words: the old functions are gone and the phrases appear only inside lightsState.
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /lightsPhrase|lightsBadgeText|tidyVerdict|lightsExplain/);
  assert.equal((src.match(/function lightsState/g) || []).length, 1, 'one definition');
});

test('room page order: header, Lights, Heating, Media, the fan, Presence, Automation, Activity', () => {
  const all = loadYaml('info_templates.yaml').pulse_room.card.cards;
  assert.deepEqual(all.map((c) => c.mode), ['room-head', 'lights', 'heating', 'media', 'device', 'presence', 'automation', 'room-feed']);
  // Rendered in template order for a room that has every section, the headings come out in that order.
  const mediaId = P.ROOMS.parlour.media[0][0];
  const hass = withRooms([quietRoom('parlour', { occupied: true, lights_on: 2, target: 20, mode_target: 20, mode_name: 'comfort', pres_labels: ['Sofa occupied'] })], [], {
    'input_boolean.parlour_automation_lights_enabled': { state: 'on', attributes: {} },
    [mediaId]: { state: 'idle', attributes: { friendly_name: 'TV' } },
  });
  const html = all.map((c) => P.render(c.mode, { room: 'parlour', ...(c.mode === 'device' ? { entity: '', decision: '' } : {}) }, hass, NOW)).join('');
  // Automation is a disclosure row, which stands in for its section header.
  const heads = [...html.matchAll(/<h2>([^<]+)<\/h2>|data-act="disclose" data-id="parlour:(\w+)"/g)].map((m) => m[1] || `row:${m[2]}`);
  assert.deepEqual(heads, ['Lights', 'row:lights', 'Heating', 'Media', 'Presence', 'row:automation', 'Activity']);
  assert.match(html.slice(0, html.indexOf('<h2>Lights')), /^<div class="p"><div class="hm hm-first"><div class="hm-head"><a [^>]*Back to House[\s\S]*<h1 class="hm-big">Parlour<\/h1><span class="hm-line">Occupied · lamps on · 20\.8°<\/span>/, 'the back link, the title and the subtitle come first');
  assert.doesNotMatch(html, /Why it|Light level|<h2>Scenes/, 'no separate explanation card, no tiles, no Scenes title');
  assert.ok(html.indexOf('Keep room occupied') < html.indexOf('data-id="parlour:automation"'), 'Keep room occupied stays in Presence, ahead of Automation');
  assert.doesNotMatch(P.render('presence', { room: 'parlour' }, hass, NOW), /disclose/, 'Automation is not a Presence row');
  // A room lacking a section skips it: no media, no heading.
  const noMedia = withRooms([quietRoom('bedroom', { occupied: true })], []);
  assert.deepEqual([...all.map((c) => P.render(c.mode, { room: 'bedroom', ...(c.mode === 'device' ? { entity: '', decision: '' } : {}) }, noMedia, NOW)).join('').matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ['Lights', 'Heating', 'Presence', 'Activity']);
  // Every room view still calls the one template.
  for (const f of readdirSync(root + 'views').filter((x) => /^info-room-/.test(x) && !/garden/.test(x))) {
    assert.equal(yaml.load(readFileSync(root + 'views/' + f, 'utf8')).sections[0].cards[0].template, 'pulse_room', f);
  }
});

test('Automation: one disclosure row on every room and garden page, rows explain themselves with a subtitle, no footnotes', () => {
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
  assert.match(rule('.hm-rs').body, /font-size:14px[^}]*color:#908caa/);
  assert.match(P.render('room-head', { room: 'bedroom' }, sheetHass(), NOW), /<h1 class="hm-big">Bedroom<\/h1>/);
});

test('Automation summary: "All on", or what is off in the attention colour (one by name, several by count)', () => {
  const sum = (room, over) => closedSheet(room, sheetHass(over)).match(/<span class="hm-val hm-ds"([^>]*)>([^<]*)</).slice(1);
  assert.deepEqual(sum('bathroom', {}), ['', 'All on']);
  assert.deepEqual(sum('bathroom', { 'input_boolean.bathroom_automation_fan_enabled': b('off') }), [' style="color:#eb6f92"', 'Fan automation off']);
  assert.deepEqual(sum('kitchen', { 'input_boolean.kitchen_automation_lights_enabled': b('off') }), [' style="color:#eb6f92"', 'Lights automation off']);
  assert.deepEqual(sum('kitchen', { 'input_boolean.kitchen_automation_lights_enabled': b('off'), 'input_boolean.kitchen_automation_heating_enabled': b('off') }), [' style="color:#eb6f92"', '2 off']);
  assert.deepEqual(sum('kitchen', { 'input_boolean.kitchen_automation_lights_enabled': b('off'), 'input_boolean.kitchen_automation_heating_enabled': b('off'), 'input_boolean.kitchen_sensor_motion_enabled': b('off') }), [' style="color:#eb6f92"', '3 off']);
  assert.equal(sum('front_garden', { 'input_boolean.front_garden_automation_lights_enabled': b('off') })[1], 'Lights automation off');
});

test('disclosure row: a real button, aria-expanded and aria-controls, a chevron that turns 90 degrees, one definition', () => {
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
  assert.match(rule('.hm-val').body, /color:#908caa/, 'the summary is textSecondary');
});

test('native controls: a switch row is a button with aria-pressed; a stepper has two labelled buttons, its value in the row title', () => {
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
  assert.match(rule('.hm-sw').body, /background:#31748f/);
  assert.match(rule('.hm-sw.off').body, /background:#403d52/);
  assert.match(rule('.hm-sw::after').body, /background:#e0def4/);
  assert.match(rule('.hm-step').body, /background:#26233a/);
  assert.match(rule('.hm-slider::-webkit-slider-runnable-track').body, /linear-gradient\(to right,#c4a7e7 var\(--p,0%\),#403d52 var\(--p,0%\)\)/);
});

test('room head: a tint back link, the large title, a plain-words subtitle; attention items sit right under it', () => {
  const full = withRooms(P.ROOM_ORDER.map(FULL), [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }, { room: 'Bedroom', key: 'bedroom', kind: 'cold_not_heating', text: 'Cold, heating off', nav: '/x' }]);
  for (const k of P.ALL_ROOM_KEYS) {
    const html = P.render('room-head', { room: k }, full, NOW, {});
    assert.match(html, new RegExp(`<a class="hm-back tap" data-act="nav" data-path="${P.HOUSE_PATH}" aria-label="Back to House"><svg[^>]*><path d="M15 5l-7 7 7 7"/></svg><span>Home</span></a>`), k);
    assert.match(html, new RegExp(`<h1 class="hm-big">${P.ROOMS[k].name}</h1><span class="hm-line">[^<]+</span>`), k);
    assert.equal((html.match(/Back to House/g) || []).length, 1, k);
  }
  assert.match(rule('.hm-back').body, /color:#c4a7e7/, 'the back link is in the tint colour');
  assert.match(rule('.hm-big').body, /font-size:34px;line-height:41px;font-weight:700/);
  assert.match(rule('.hm-line').body, /font-size:15px[^}]*color:#908caa/);
  // Subtitles in plain words.
  const sub = (over, extra) => P.render('room-head', { room: 'parlour' }, withRooms([quietRoom('parlour', { temp: null, ...over })], [], extra), NOW).match(/<span class="hm-line">([^<]*)</)[1];
  assert.equal(sub({ occupied: true, lights_on: 2 }), 'Occupied · lamps on');
  assert.equal(sub({ occupied: false, lights_on: 0 }), 'Empty · lights off');
  assert.equal(sub({ occupancy_unavailable: true, lights_on: 1 }, { 'sensor.parlour_active_scene': { state: 'unknown', attributes: {} } }), 'Occupancy unavailable · lights on');
  // Attention: one row each, filled tile with the attention ink glyph, short label in the attention colour, the detail beneath.
  const bed = P.render('room-head', { room: 'bedroom' }, full, NOW, {});
  assert.equal((bed.match(/<div class="hm-row">/g) || []).length, 2);
  assert.match(bed, /<section class="hm-sec hm-tight"><div class="hm-list"><div class="hm-row"><span class="hm-tile" style="background:#eb6f92;color:#191724"><svg[^>]*><path d="M4 4h16v16H4zM12 4v16M4 12h16"\/><\/svg><\/span><div class="hm-text"><div class="hm-rt" style="color:#eb6f92;font-weight:600">Window open, heating on<\/div><div class="hm-rs">Open window while heating<\/div>/);
  assert.match(bed, new RegExp(`<path d="${P.ICON.flame.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"/></svg></span><div class="hm-text"><div class="hm-rt" style="color:#eb6f92;font-weight:600">Too cold, heating off`));
  assert.doesNotMatch(P.render('room-head', { room: 'kitchen' }, full, NOW, {}), /hm-tight/, 'a room with nothing to flag has no list');
  assert.match(rule('.hm .hm-tight').body, /margin-top:16px/);
});

test('light level lives in the lighting footnote: "Dark (6 lx)" or "Bright (87 lx)" by the live threshold, no prefix without a usable reading', () => {
  const LUX = 'sensor.parlour_sensor_motion_illuminance';
  const lx = (v, unit = 'lx') => ({ [LUX]: b(v, { unit_of_measurement: unit }), 'input_number.parlour_automation_lux_threshold_dark': b('40') });
  const room = (extra) => withRooms([quietRoom('parlour', { manual: null, pres_labels: [], labels: [], lights_on: 0, occupied: true })], [], { ...extra, ...histSensor('parlour', [luxHigh(1), histEntry(30)]) });
  const note = (extra) => (P.render('lights', { room: 'parlour' }, room(extra), NOW).match(/<p class="hm-foot">([^<]*)<\/p>/) || [])[1];
  assert.match(note(lx('12')), /^Dark \(12 lx\)/);
  assert.match(note(lx('40')), /^Dark \(40 lx\)/, 'at the threshold counts as dark, as the automation does');
  assert.match(note(lx('41')), /^Bright \(41 lx\)/);
  assert.match(note(lx('1e12')), /^Bright \(200000 lx\)/, 'clamped');
  assert.equal(note({ ...lx('87'), 'input_number.parlour_automation_lux_threshold_dark': b('10') }).split(' · ')[0], 'Bright (87 lx)');
  // A declined decision has no caption of its own, so the footnote is the light level alone.
  assert.equal(note(lx('6')), 'Dark (6 lx)');
  // The prefix leads the lighting sentence, joined by a middle dot.
  const lit = withRooms([quietRoom('parlour', { manual: null, pres_labels: [], labels: [], lights_on: 2, occupied: true })], [], { ...lx('6'), ...histSensor('parlour', [histEntry(30, { location: 'parlour', decision: 'activate_scene', reason: 'lux_low', facts: { lux: 6, lux_threshold: 40, scene: 'parlour_lamps' } })]) });
  assert.match(P.render('lights', { room: 'parlour' }, lit, NOW), /<p class="hm-foot">Dark \(6 lx\) · Lamps on since \d\d:\d\d · off when the room empties<\/p>/);
  // An empty, dark room: no mode word ("Auto") between the light level and the sentence.
  const emptyDark = withRooms([quietRoom('parlour', { manual: null, pres_labels: [], labels: [], lights_on: 0, occupied: false })], [], { ...lx('0'), 'binary_sensor.parlour_occupied': { state: 'off', last_changed: new Date(NOW - 3600000).toISOString(), attributes: {} }, ...histSensor('parlour', []) });
  const emptyNote = (P.render('lights', { room: 'parlour' }, emptyDark, NOW).match(/<p class="hm-foot">([^<]*)<\/p>/) || [])[1];
  assert.match(emptyNote, /^Dark \(0 lx\) · No one seen since \d\d:\d\d$/);
  // No sensor, an unusable reading, a wrong unit or no threshold: no prefix, never a guess.
  for (const [v, unit] of [['unavailable', 'lx'], ['unknown', 'lx'], ['abc', 'lx'], ['85', 'klx'], ['85', null]]) assert.doesNotMatch(note(lx(v, unit)) || '', /Dark|Bright/, `${v} ${unit}`);
  assert.doesNotMatch(note({ [LUX]: b('85', { unit_of_measurement: 'lx' }) }) || '', /Dark|Bright/, 'no threshold helper');
  assert.doesNotMatch(note({}) || '', /Dark|Bright/, 'no sensor');
  assert.doesNotMatch(P.render('lights', { room: 'parlour' }, room(lx('85')), NOW), /Light level|hm-wgrid/, 'no tile');
  for (const k of INDOOR_KEYS) {
    assert.equal(P.ROOMS[k].lux, `sensor.${k}_sensor_motion_illuminance`, k);
    assert.ok(helperIds.has(`input_number.${k}_automation_lux_threshold_dark`), `${k}: its threshold is a real helper`);
  }
  for (const g of GARDENS) assert.equal(P.ROOMS[g].lux, undefined);
  assert.match(rule('.hm-wgrid').body, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(rule('.hm-w:only-child').body, /grid-column:1\/-1/);
  assert.match(rule('.hm-w').body, /background:#1f1d2e;border-radius:20px;padding:14px 16px/);
  assert.match(rule('.hm-wv').body, /font-size:34px/);
  assert.throws(() => P.render('readings', { room: 'parlour' }, mk(), NOW), /unknown mode/);
});

test('room subtitle appends the room temperature when there is a sensor and a reading, and omits it otherwise', () => {
  const line = (key, over) => P.render('room-head', { room: key }, withRooms([quietRoom(key, { occupied: true, lights_on: 2, ...over })], []), NOW).match(/<span class="hm-line">([^<]*)<\/span>/)[1];
  assert.equal(line('parlour', { temp: 20.2 }), 'Occupied · lamps on · 20.2°');
  assert.equal(line('parlour', { temp: 20 }), 'Occupied · lamps on · 20.0°');
  assert.equal(line('parlour', { temp: null }), 'Occupied · lamps on', 'no reading');
  assert.equal(line('parlour', { temp: 18.4, occupied: false, lights_on: 0 }), 'Empty · lights off · 18.4°');
  // One capitalisation rule: only the first item is capitalised, whatever the scene's label.
  assert.doesNotMatch(line('parlour', { temp: 20.2 }), /· [A-Z]/);
  assert.equal(line('hallway_upstairs', { temp: 19 }), 'Occupied · lights on', 'a room without a temperature sensor');
});

test('Scenes: a two-column grid of real buttons, the active one a tinted fill with a tint icon and ring and primary text', () => {
  const html = P.render('lights', { room: 'parlour' }, mk(), NOW);
  assert.match(html, /<h2>Lights<\/h2><\/div><div class="hm-scenes"><button type="button" class="hm-scene" data-act="scene" data-entity="scene\.parlour_all" aria-pressed="false"><svg/);
  assert.match(html, /<button type="button" class="hm-scene on" data-act="scene" data-entity="scene\.parlour_lamps" aria-pressed="true">/);
  assert.match(rule('.hm-scenes').body, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(rule('.hm-scene').body, /min-height:76px;padding:12px 14px;border:0;border-radius:16px/);
  assert.match(rule('.hm-scene').body, /font-size:15px[^}]*font-weight:600/);
  assert.match(rule('.hm-scene').body, /background:#1f1d2e/);
  assert.equal(rule('.hm-scene.on').body, 'background:rgba(196,167,231,.16);box-shadow:inset 0 0 0 1.5px #c4a7e7', 'tintFill and a tint ring; no colour override, so the label stays primary text');
  assert.equal(rule('.hm-scene.on svg').body, 'color:#c4a7e7', 'the icon is the tint');
  assert.doesNotMatch(rule('.hm-scene.on').body, /tintInk|1d1708/, 'no dark ink on a quiet fill');
});

test('lights note: a declined decision has no caption under the scenes (the Light level tile and Activity carry it); the story still words it time first', () => {
  const hass = withRooms([{ ...FULL('kitchen'), manual: null, pres_labels: [], labels: [], occupied: true, lights_on: 0 }], [], histSensor('kitchen', [luxHigh(1), histEntry(30)]));
  const html = P.render('lights', { room: 'kitchen' }, hass, NOW);
  assert.doesNotMatch(html, /hm-foot|Stayed off|bright enough/, 'no caption under the scene grid');
  assert.equal(P.lightsStory(hass, 'kitchen', NOW).why, 'Stayed off at 18:41: bright enough, 85 lx (on at 40 or below)');
  const feed = P.render('room-feed', { room: 'kitchen' }, hass, NOW);
  assert.match(feed, /<b class="tl-s">Lights<\/b> stayed off<\/div><div class="tl-l2"[^>]*>Bright enough, 85 lx \(on at 40 or below\)<\/div>/, 'the declined event is still in Activity');
  const manual = withRooms([{ ...FULL('kitchen'), manual: { ts: '2026-10-25T18:40:00Z', source: 'wall_button', what: '' }, pres_labels: [], labels: [], occupied: true, lights_on: 1 }], []);
  assert.match(P.render('lights', { room: 'kitchen' }, manual, NOW), /<p class="hm-foot">Manual/, 'other states keep their caption');
  assert.equal(P.REASON_TEXT['lighting:lux_high']({ lux: 85, lux_threshold: 40 }, {}), 'Stayed off: bright enough, 85 lx (on at 40 or below)', 'REASON_TEXT is untouched');
});

test('Occupied row: the value is the source, the subtitle the clearing rule without repeating it, for every kind of hold', () => {
  const row = (labels, over = {}) => {
    const html = P.render('presence', { room: 'parlour' }, withRooms([quietRoom('parlour', { occupied: true, pres_labels: labels, labels, ...over })], []), NOW);
    const m = html.match(/<div class="hm-rt">([^<]*)<\/div><div class="hm-rs">([^<]*)<\/div><\/div>(?:<span class="hm-val num">([^<]*)<\/span>)?/);
    return { title: m[1], sub: m[2], value: m[3] };
  };
  assert.deepEqual(row(['Sofa occupied']), { title: 'Occupied', sub: 'Empty a few minutes after the sofa clears', value: 'Sofa' });
  assert.deepEqual(row(['Bed occupied']), { title: 'Occupied', sub: 'Empty a few minutes after the bed clears', value: 'Bed' });
  assert.deepEqual(row(['Doors closed']), { title: 'Occupied', sub: 'Empty a few minutes after it clears', value: 'Doors' });
  assert.deepEqual(row(['Sonos playing']), { title: 'Occupied', sub: 'Empty a few minutes after it clears', value: 'Sonos' });
  assert.deepEqual(row(['Monitor on']), { title: 'Occupied', sub: 'Empty a few minutes after it clears', value: 'Monitor on' });
  assert.deepEqual(row(['Sofa occupied', 'Doors closed']), { title: 'Occupied', sub: 'Empty a few minutes after the last one clears', value: 'Sofa +1' });
  // Motion alone: no source, so no value and the existing wording.
  assert.deepEqual(row([]), { title: 'Occupied', sub: 'Empties a few minutes after the last movement', value: undefined });
  assert.equal(row(['Sofa occupied'], { override_text: 'Held by hand' }).sub, 'Empty a few minutes after the sofa clears · Held by hand');
  assert.equal(row(['Sofa occupied']).sub.includes('Sofa occupied'), false, 'the source is not said twice');
});

test('presence: no trailing value when nothing holds the room, and no action either (supersedes the old Clear pin)', () => {
  const html = P.render('presence', { room: 'parlour' }, withRooms([quietRoom('parlour', { occupied: false, pres_labels: [] })], []), NOW);
  assert.doesNotMatch(html, /hm-val|Clear/);
  assert.doesNotMatch(html, /data-act="clear/);
  const held = P.render('presence', { room: 'parlour' }, withRooms([quietRoom('parlour', { occupied: true, pres_labels: ['Bed occupied'] })], []), NOW);
  assert.match(held, /<span class="hm-val num">Bed<\/span>/, 'a hold keeps a value: its short label');
});

// ── Room registry (step 7.1) ─────────────────────────────────────────────────────────────────
test('scenes derive from the registry: ordered by scene_order_N, off last, device area fallback, other areas and unlabelled scenes ignored', () => {
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

test('registry problems fail loudly: bad label, missing or duplicate off scene, duplicate position, foreign scene id', () => {
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

// ── Room rhythm polish ───────────────────────────────────────────────────────────────────────────
test('top gap: an invisible header control is switched off (and put back), a visible one still guards', () => {
  const mkEl = (inline = '') => { const st = new Map(inline ? [['pointer-events', [inline, '']]] : []); return { style: { getPropertyValue: (k) => (st.get(k) || [''])[0], getPropertyPriority: (k) => (st.get(k) || ['', ''])[1], setProperty: (k, v, pr = '') => st.set(k, [v, pr]), removeProperty: (k) => st.delete(k), st } }; };
  assert.equal(Raw.invisibleControl({ opacity: '0' }), true);
  assert.equal(Raw.invisibleControl({ opacity: '1' }), false);
  assert.equal(Raw.invisibleControl(null), false);
  const saved = new Map();
  const a = mkEl();
  const b = mkEl('auto');
  Raw.disarm(a, saved); Raw.disarm(a, saved); Raw.disarm(b, saved);
  assert.deepEqual(a.style.st.get('pointer-events'), ['none', 'important']);
  assert.equal(saved.size, 2);
  Raw.rearm(saved);
  assert.equal(a.style.st.has('pointer-events'), false, 'no inline value before: removed');
  assert.deepEqual(b.style.st.get('pointer-events'), ['auto', ''], 'its own inline value restored');
  assert.equal(saved.size, 0);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(src, /if \(invisibleControl\(cs\)\) disarm\(el, this\._disarmed\);\n\s*else out\.push/, 'the probe disarms before it measures');
  assert.match(src, /rearm\(this\._disarmed\);/, 'and disconnect puts taps back');
  // A control that stays tappable still pushes content down; the guard is unchanged for it.
  assert.equal(Raw.coverNeed([{ left: 0, top: 0, right: 56, bottom: 63 }], [{ left: 10, top: 10, right: 60, bottom: 50 }], 0), 53);
});

test('both two-column grids share one 10px gutter', () => {
  assert.equal(px(decl(rule('.hm-wgrid').body, 'gap')), 10);
  assert.equal(px(decl(rule('.hm-scenes').body, 'gap')), 10);
});

test('Individual lights is a row of the Scenes group, 12px under the grid, with no header and no section gap of its own', () => {
  const html = P.render('lights', { room: 'parlour' }, mk(), NOW);
  assert.equal((html.match(/<section class="hm-sec">/g) || []).length, 1, 'one section');
  assert.match(html, /<\/div><div class="hm-group-row"><div class="hm-list plain"><button[^>]*data-id="parlour:lights"/);
  assert.ok(html.indexOf('hm-group-row') > html.indexOf('class="hm-scenes"'));
  assert.ok(html.indexOf('hm-group-row') < html.indexOf('</section>'));
  assert.equal(px(decl(rule('.hm-group-row').body, 'margin-top')), 12);
});

test('Automation is a group of its own, not a Presence row; gardens keep a card of their own', () => {
  const hass = withRooms([quietRoom('bedroom', { occupied: true })], [], { 'input_boolean.bedroom_automation_presence_override': { state: 'off', attributes: {} } });
  const pres = P.render('presence', { room: 'bedroom' }, hass, NOW);
  assert.equal((pres.match(/<section class="hm-sec">/g) || []).length, 1);
  assert.ok(pres.indexOf('Keep room occupied') > 0, 'Keep room occupied stays in Presence');
  assert.equal(pres.indexOf('data-id="bedroom:automation"'), -1);
  const auto = P.render('automation', { room: 'bedroom' }, hass, NOW);
  assert.equal((auto.match(/data-id="bedroom:automation"/g) || []).length, 1);
  assert.doesNotMatch(auto, /<h2>|Keep room occupied/, 'the row is the label; no header');
  assert.match(P.render('automation', { room: 'bedroom' }, hass, NOW, { open: { 'bedroom:automation': true } }), /id="dp-bedroom-automation">/, 'open state still keys off the same id');
  assert.match(P.render('automation', { room: 'front_garden' }, sheetHass(), NOW), /data-id="front_garden:automation"/);
});

test('wording: presence, keep occupied, TV toggle, light level', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const off = withRooms([quietRoom('bedroom', { occupied: true })], [], { 'input_boolean.bedroom_automation_presence_override': b('off') });
  const pres = P.render('presence', { room: 'bedroom' }, off, NOW);
  assert.match(pres, /Empties a few minutes after the last movement/);
  assert.doesNotMatch(pres, /No holds ·/);
  assert.match(pres, /Until you switch it off/);
  assert.doesNotMatch(pres, /Holds the room occupied/);
  const held = withRooms([quietRoom('bedroom', { occupied: true, pres_labels: ['Bed occupied'], labels: ['Bed occupied'] })], []);
  assert.match(P.render('presence', { room: 'bedroom' }, held, NOW), /Empty a few minutes after the bed clears/, 'holds keep their info');
  const tvKind = P.ROOMS.parlour.media.find((x) => x[2] === 'tv');
  assert.ok(tvKind, 'the parlour has a TV');
  {
    const html = P.render('media', { room: 'parlour' }, mk({ [tvKind[0]]: { state: 'off', attributes: {} } }), NOW);
    assert.doesNotMatch(html.slice(html.indexOf(tvKind[1])), /hm-rs">(Off|On)</, 'a toggle row does not repeat its switch');
  }
});
