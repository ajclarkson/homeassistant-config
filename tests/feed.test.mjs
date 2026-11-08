// Pulse card tests: feed. Run: cd tests && npm test (or node --test feed.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, mk, histEntry, histSensor, luxHigh, story, real, count, day, decl, px, rule, tile, b, dark, catalog, declared, worded, over, long } from './helpers.mjs';

const tlRows = (html) => html.split('<div class="tl-row ').slice(1).map((r) => '<div class="tl-row ' + r);

const dotOf = (row) => row.match(/<i class="tl-dot"([^>]*)><\/i>/)[1];

test('history parser: malformed payloads give an empty list and a visible note, never a throw', () => {
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

test('Recent activity rows by kind: acted plain, declined muted, guard muted, failure amber, repeats collapse', () => {
  const abort = histEntry(4, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'guard' } });
  const failed = histEntry(5, { kind: 'action_failed', decision: '', reason: '', outcome: undefined, detail: { failure: 'error', action: 'scene.turn_on', entity: 'scene.kitchen_all' } });
  const entries = [histEntry(1), histEntry(2), luxHigh(3), abort, failed];
  const html = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', entries, {})), NOW);
  // A row: the time, the dot (kind in the class), then the subject in bold, the verb part and the reason part.
  const line = (time, kind, text) => new RegExp(`<div class="tl-row ${kind}"><span class="tl-t num">${time}</span><span class="tl-rail" aria-hidden="true"><i class="tl-dot"[^>]*></i></span><div class="tl-b" style="color:[^"]*"><div class="tl-l1">${text}`);
  assert.match(html, line('18:41', 'acted', '<b class="tl-s">Lights</b> off <span class="tl-n">x2</span></div><div class="tl-l2" style="color:#908caa">Room empty</div>'));
  assert.match(html, line('18:39', 'declined', '<b class="tl-s">Lights</b> stayed off</div><div class="tl-l2" style="color:#908caa">Bright enough, 85 lx \\(on at 40 or below\\)</div>'));
  assert.match(html, line('18:38', 'declined', '<b class="tl-s">Lights</b> held back</div></div>'), 'a guard is routine: a quiet row on a room page, not amber');
  assert.match(html, line('18:37', 'problem', '<b class="tl-s">Lights</b> couldn&#39;t be controlled \\(turn on\\)'));
  assert.match(html, /class="tl-row acted">[^]*?class="tl-b" style="color:#e0def4"/);
  assert.match(html, /class="tl-row declined">[^]*?class="tl-b" style="color:#908caa"/);
  assert.match(html, /class="tl-row problem">[^]*?class="tl-b" style="color:#eb6f92"/);
  assert.equal((html.match(/class="tl-row /g) || []).length, 4, 'one row per distinct entry; homerun stores no plumbing, so the card has nothing to hide');
  assert.match(html, /<h2>Activity<\/h2>/);
  assert.doesNotMatch(html, /⊘/);
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [])), NOW), /Nothing recorded for this room yet/);
  const unreadable = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [good(), 5])), NOW);
  assert.match(unreadable, /1 entry could not be read/);
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [], { schema: 'nope' })), NOW), /Nothing recorded for this room yet[\s\S]*History unreadable/);
  function good() { return histEntry(2); }
});

test('House feed reads sensor.house_history, says where, and a stored info_decision_feed is ignored', () => {
  const house = (entries, over = {}) => mk({ ...histSensor('house', entries, over) });
  const stale = { 'sensor.info_decision_feed': { state: 'x', attributes: { entries: JSON.stringify([{ loc: 'kitchen', ts: '2026-10-25T18:20:00+00:00', sentence: 'OLD FEED SENTENCE' }]) } } };
  const hass = mk({ ...histSensor('house', [histEntry(1, { location: 'kitchen' }), histEntry(5, { location: 'house', subsystem: 'energy', decision: 'spin', reason: 'wheels_spun', automation_id: 'house:wheel' })]), ...stale });
  const feed = P.render('feed', {}, hass, NOW);
  assert.match(feed, /<span class="tl-t num">18:41<\/span>[^]*?<b class="tl-s">Kitchen<\/b> lights off<\/div><div class="tl-l2" style="color:#908caa">Room empty<\/div>/);
  assert.match(feed, /<span class="tl-t num">18:37<\/span>[^]*?<b class="tl-s">Energy<\/b> spun the Octopus wheels/, 'whole-house entries carry their subsystem noun');
  assert.doesNotMatch(feed, /OLD FEED SENTENCE/, 'the old feed sensor is no longer read');
  assert.match(P.render('feed', {}, house([]), NOW), /Nothing recorded yet/);
  assert.match(P.render('feed', {}, mk(), NOW), /Nothing recorded yet[\s\S]*History unavailable/, 'no sensor: say so rather than imply a quiet house');
  assert.match(P.render('feed', {}, house([], { schema: 'nope' }), NOW), /History unreadable/);
  const declined = P.render('feed', {}, house([luxHigh(2)]), NOW);
  assert.match(declined, /<b class="tl-s">Kitchen<\/b> stayed off<\/div><div class="tl-l2"[^>]*>Bright enough/, 'a rule that chose not to act reads muted, as on the room page');
  assert.match(P.render('room-feed', { room: 'kitchen' }, mk({ ...histSensor('kitchen', [histEntry(1)]) }), NOW), /<b class="tl-s">Lights<\/b> off<\/div><div class="tl-l2" style="color:#908caa">Room empty/);
});

test('Activity rows: line 1 is 15px/20px with the subject semibold; line 2, the reason, is smaller', () => {
  assert.match(P.STYLE, /\.tl-l1\{font-size:15px;line-height:20px\}/);
  assert.match(P.STYLE, /\.tl-l2\{font-size:13\.5px;line-height:18px/);
  assert.match(P.STYLE, /\.tl-s\{font-weight:600\}/);
});

test('House feed limited to 3 rows, repeats collapse', () => {
  const e = (i, over) => histEntry(i, over);
  const entries = [e(1, { location: 'bathroom' }), e(2, { location: 'bathroom' }), e(3, { location: 'kitchen', decision: 'turn_on', reason: 'occupancy_on' }), e(4, { location: 'hallway_downstairs' }), e(5, { location: 'home_office' })];
  const html = P.render('feed', {}, mk(histSensor('house', entries)), NOW);
  assert.equal(count(html, /class="tl-row /g), 3);
  assert.match(html, /<span class="tl-n">x2<\/span>/);
  assert.doesNotMatch(html, /Home office/);
});

test('undeclared decisions are worded from one table by sentenceFor, with a prettified fallback', () => {
  const und = (decision, reason, over = {}) => ({ ...histEntry(1), outcome: undefined, subsystem: 'heating', decision, reason, ...over });
  const say = (e) => P.sentenceFor(e, mk()).text;
  assert.equal(say(und('set_mode', 'house_mode_away')), 'Heating mode changed · house away');
  assert.equal(say(und('set_mode', 'brand_new_reason')), 'Heating mode changed · brand new reason', 'an unknown reason is prettified, never blank or thrown');
  assert.equal(say(und('turn_on', 'occupancy_on', { subsystem: 'lighting' })), 'Lights turned on · room occupied');
  assert.equal(say(und('mystery_move', '', { subsystem: 'wfh_inference' })), 'Wfh inference mystery move');
  assert.equal(say(und('constructor', 'toString')), 'Heating constructor · toString', 'slugs cannot reach into object prototypes');
  assert.equal(P.sentenceFor(und('turn_on', 'x'), mk()).tone, 'ok');
  const feed = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'bedroom', subsystem: 'heating', decision: 'set_mode', reason: 'safety_window_open', outcome: undefined })])), NOW);
  assert.match(feed, /<b class="tl-s">Bedroom<\/b> heating mode changed<\/div><div class="tl-l2" style="color:#908caa">Window open<\/div>/);
});

test('wording table: every acted or declined reason in the catalogue snapshot has a sentence, and no sentence is stale', () => {
  assert.ok(worded.length >= 29, 'the snapshot is the real catalogue');
  const missing = worded.map(([k]) => k).filter((k) => !P.REASON_TEXT[k]);
  assert.deepEqual(missing, [], 'reasons with no wording');
  const stale = Object.keys(P.REASON_TEXT).filter((k) => !declared.has(k) || declared.get(k).outcome === 'ignored');
  assert.deepEqual(stale, [], 'wording for reasons the catalogue no longer declares as acted or declined');
});

test('wording table: sentences read only declared facts, never print a placeholder, and survive null facts', () => {
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
  assert.equal(text('lighting:lux_high', { lux: 85, lux_threshold: 40 }), 'Stayed off: bright enough, 85 lx (on at 40 or below)');
  assert.equal(text('lighting:lux_high', { lux: null, lux_threshold: 40 }), 'Stayed off: bright enough, no light reading (on at 40 or below)');
  assert.equal(text('lighting:lux_high', { lux: 1e12, lux_threshold: -5 }), 'Stayed off: bright enough, 200000 lx (on at 0 or below)', 'formatted numbers are clamped');
  assert.equal(text('lighting:external_suppress_active', { source: 'binary_sensor.kitchen_monitor' }), 'Stayed off: held off by Kitchen monitor', 'entities are worded by friendly name');
  assert.equal(text('lighting:external_suppress_active', { source: 'input_boolean.unknown_thing' }), 'Stayed off: held off by input_boolean.unknown_thing', 'falls back to the id');
  assert.equal(text('occupied:strong_hold_started', { hold: 'binary_sensor.kitchen_monitor' }), 'Marked occupied · held by Kitchen monitor');
  assert.equal(text('occupied:strong_hold_active', { hold: 'binary_sensor.kitchen_monitor' }), 'Stayed occupied: held by Kitchen monitor');
  assert.equal(text('lighting:on_outside_evening_window', { minutes: 30 }), 'Off in 30 min · turned on by hand outside lighting hours');
});

test('wording table: the garden and feed sentences carry over, so the wording does not change', () => {
  const carried = { 'lighting:calendar_boundary': 'calendar', 'lighting:calendar_boundary_catch_up': 'calendar, after a restart', 'lighting:on_outside_evening_window': 'turned on by hand outside lighting hours', 'lighting:preview_ended': 'preview over', 'lighting:theme_scene_missing': 'no x scene set up', 'lighting:lux_low': 'room occupied and dark', 'lighting:lux_high': 'bright enough', 'lighting:recent_auto_off': 'back soon after lights went off', 'occupied:containment_failsafe_expired': 'door shut but no movement', 'lighting:house_sleep_mode': 'house set to asleep', 'lighting:sunset': 'sunset', 'lighting:sunrise': 'sunrise', 'lighting:schedule_off': 'end of the evening', 'occupied:motion_detected': 'motion detected', 'occupied:timer_expired': 'no one seen for', 'lighting:button_cycle': 'button pressed' };
  for (const [key, phrase] of Object.entries(carried)) {
    const raw = P.REASON_TEXT[key]({ lux: 1, lux_threshold: 2, theme: 'x', minutes: 1, scene: '', hold: '' }, { name: () => '' });
    assert.ok(raw.toLowerCase().includes(phrase.toLowerCase()), `${key} keeps "${phrase}": ${raw}`);
  }
});

test('wording table: sentences for the garden, heating, house, energy and cat reasons read their facts, and survive null ones', () => {
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

test('wording table: audit wording for lighting, occupancy, house, cameras, wfh and the rest, with missing facts handled', () => {
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

test('wording table: every heating cause is worded, `other` and a missing cause say nothing, and a cause never repeats its reason', () => {
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

test('wording table: every key the catalogue adds for the audit is either worded or ignored, never the other way round', () => {
  for (const k of ['lighting:occupancy_off_already_off', 'lighting:house_sleep_mode_already_off', 'lighting:sunrise_already_off', 'lighting:schedule_off_already_off', 'lighting:sleep_mode_idle', 'lighting:scene_without_effects_activated', 'modifier:not_guest', 'thermal:nobody_home']) {
    assert.equal(declared.get(k).outcome, 'ignored', `${k} is ignored, so it appears in no history and has no wording`);
    assert.equal(P.REASON_TEXT[k], undefined, k);
  }
  for (const k of ['lighting:theme_effects_stopped', 'cameras:guest_arrived_while_away']) assert.equal(declared.get(k).outcome, 'acted', k);
  assert.equal(declared.has('lighting:sleep_mode_button'), false, 'no button split: buttons are not declined in sleep');
  assert.equal(declared.get('lighting:sleep_mode').outcome, 'declined');
});

test('terms: no visible string says vacation, sleep mode, getting dark or emptied', () => {
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

test('House feed card is wired to sensor.house_history and the old feed entity is referenced nowhere', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(src, /readHistory\(hass, 'sensor\.house_history'\)/);
  const files = ['info-dashboard.yaml', 'info_templates.yaml', 'wallboard.yaml', 'dashboard.yaml', 'www/pulse-card.js']
    .concat(readdirSync(root + 'views').map((f) => 'views/' + f), readdirSync(root + 'packages').map((f) => 'packages/' + f));
  for (const f of files) assert.doesNotMatch(readFileSync(root + f, 'utf8'), /info_decision_feed|plumbing_decisions|PLUMBING_|'verdict'|verdict: /, f);
  assert.ok(yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8')).sections[0].cards.some((c) => c.mode === 'feed'));
});

test('feed: suppress sources get a plain phrase from a table, unknown sources keep the friendly name', () => {
  assert.equal(P.SUPPRESS_SOURCES['binary_sensor.hallway_upstairs_bed_occupied_sync'], 'someone in bed');
  const hass = mk({ 'binary_sensor.kitchen_monitor': { state: 'on', attributes: { friendly_name: 'Kitchen monitor' } } });
  const text = (source) => P.sentenceFor(histEntry(1, { subsystem: 'lighting', decision: 'no_action', reason: 'external_suppress_active', outcome: 'declined', facts: { source } }), hass).text;
  assert.equal(text('binary_sensor.hallway_upstairs_bed_occupied_sync'), 'Stayed off: someone in bed');
  assert.equal(text('binary_sensor.kitchen_monitor'), 'Stayed off: held off by Kitchen monitor');
  assert.equal(text('input_boolean.unknown_thing'), 'Stayed off: held off by input_boolean.unknown_thing');
  assert.equal(text(undefined), 'Stayed off: held off by something else');
  assert.equal(text('toString'), 'Stayed off: held off by toString', 'inherited object keys are not sources');
});

test('room feed rows: the timeline, led by the subsystem the entry is about', () => {
  const html = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [histEntry(1), luxHigh(2), histEntry(3, { subsystem: 'weird_new' })])), NOW);
  assert.match(html, /<h2>Activity<\/h2>/);
  const rows = tlRows(html);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.match(/<b class="tl-s">([^<]+)</)[1]), ['Lights', 'Lights', 'Weird'], 'the subsystem noun, not the room the page is about');
  assert.match(rows[1], /class="tl-b" style="color:#908caa"/, 'a declined decision reads in secondary text');
  assert.match(html, /<b class="tl-s">Weird<\/b> new occupancy off/, 'an unknown subsystem: its prettified id leads');
  assert.doesNotMatch(html, /hm-tile|<svg/, 'no subsystem tiles on activity rows');
  const quiet = P.render('room-feed', { room: 'kitchen' }, mk(), NOW);
  assert.match(quiet, /<div class="hm-row"><div class="hm-text"><div class="hm-rs">Nothing recorded for this room yet<\/div>/);
  assert.doesNotMatch(P.STYLE, /\.feed[{ .]|\.tag[{ .]/, 'the older feed line and the pills are gone from the stylesheet');
});

test('House activity rows: subject, verb part, reason part; dot in the subsystem colour', () => {
  const house = [histEntry(1, { location: 'hallway_upstairs' }), luxHigh(2), histEntry(3, { location: 'house', subsystem: 'weird_new' })];
  const html = P.render('feed', {}, mk(histSensor('house', house)), NOW);
  const rows = tlRows(html);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /<b class="tl-s">Hallway up<\/b> lights off<\/div><div class="tl-l2" style="color:#908caa">Room empty<\/div>/);
  assert.match(rows[2], /<b class="tl-s">Weird<\/b> new occupancy off/);
  assert.equal(dotOf(rows[0]), ' style="background:#f6c177"', 'acted: filled with the subsystem colour');
  assert.equal(dotOf(rows[1]), ' style="border-color:#f6c177"', 'declined: a ring in the subsystem colour');
  assert.match(rows[1], /class="tl-row declined">/);
  assert.match(rows[1], /class="tl-b" style="color:#908caa"><div class="tl-l1"><b class="tl-s">Kitchen<\/b> stayed off/, 'declined sentence is secondary text');
  assert.equal(dotOf(rows[2]), ' style="background:#908caa"', 'no subsystem colour: secondary text');
  const quiet = P.render('feed', {}, mk(), NOW);
  assert.match(quiet, /Nothing recorded yet/);
  assert.match(quiet, /<h2>Activity<\/h2>/);
  // A subsystem colour that would vanish on the surface falls back to secondary text.
  const cams = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'house', subsystem: 'cameras', decision: 'no_action', reason: 'x', outcome: 'declined' })])), NOW);
  assert.equal(dotOf(tlRows(cams)[0]), ' style="border-color:#908caa"');
  const problem = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unhandled_error' }, location: 'house' })])), NOW);
  assert.match(problem, /class="tl-row problem"><span class="tl-t num">18:41<\/span><span class="tl-rail" aria-hidden="true"><i class="tl-dot"><\/i><\/span><div class="tl-b" style="color:#eb6f92"><div class="tl-l1"><b class="tl-s">[^<]*<\/b>[^<]*Couldn&#39;t run|couldn&#39;t run: it failed unexpectedly/, 'a problem: attention dot and text');
  assert.match(P.STYLE, /\.tl-row\.problem \.tl-dot\{[^}]*background:#eb6f92/);
});

test('timeline CSS: 40px time, 20px rail, 12px dots, 10px gap, the 14px card inset on both sides, 2px rail line from the first dot to the last', () => {
  const row = rule('.tl-row').body;
  assert.equal(decl(row, 'grid-template-columns'), '40px 20px minmax(0,1fr)');
  assert.equal(px(decl(row, 'column-gap')), 10);
  assert.equal(decl(row, 'padding'), '6px 14px', 'the standard card inset (a list row pads 14px) on both sides');
  assert.equal(px(decl(rule('.hm-row').body, 'padding').split(' ')[1]), 14, 'the inset the timeline matches');
  assert.equal(px(decl(rule('.hm-list.tl').body, 'padding').split(' ')[0]), 6, 'the container keeps its 6px vertical padding');
  const t = rule('.tl-t').body;
  assert.match(t, /text-align:right/);
  assert.equal(px(decl(t, 'font-size')), 14);
  assert.equal(px(decl(t, 'line-height')), px(decl(rule('.tl-l1').body, 'line-height')), 'the time shares the first text line');
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
  assert.equal(decl(rail, 'background'), '#403d52');
  assert.equal(px(decl(rule('.tl-h').body, 'font-size')), 15);
  assert.match(rule('.tl-h').body, /font-weight:600;color:#908caa/);
  assert.match(rule('.tl-b').body, /min-width:0/, 'a long sentence wraps inside its column at 360px');
});

test('timeline: day groups, time shown once per minute, subject sharing, hidden decoration', () => {
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

test('problem rows never show an entity id: friendly name (case kept), else the room on Home or the noun on a room page', () => {
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

test('a subsystem word that only names the room state is dropped after a room subject', () => {
  assert.deepEqual(P.timelineLead('Parlour', 'Occupancy marked occupied', { noun: 'Occupancy', implied: true }), { lead: 'Parlour', rest: ' marked occupied' });
  assert.deepEqual(P.timelineLead('Parlour', 'Lights off', { noun: 'Lights' }), { lead: 'Parlour', rest: ' lights off' }, 'a thing (lights) is kept');
  assert.deepEqual(P.timelineLead('Occupancy', 'Occupancy marked occupied', { noun: 'Occupancy', implied: true }), { lead: 'Occupancy', rest: ' marked occupied' }, 'a subsystem subject is not dropped');
  const e = histEntry(1, { location: 'parlour', subsystem: 'occupied', decision: 'set_occupied', reason: 'kitchen_motion_detected', outcome: undefined });
  assert.match(P.render('feed', {}, mk(histSensor('house', [e])), NOW), /<b class="tl-s">Parlour<\/b> marked occupied<\/div><div class="tl-l2" style="color:#908caa">Kitchen motion<\/div>/);
  assert.match(P.render('room-feed', { room: 'parlour' }, mk(histSensor('parlour', [e])), NOW), /<b class="tl-s">Occupancy<\/b> marked occupied/);
});

test('sentence split: the first " · " divides the verb part from the reason part; no separator shows it whole', () => {
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

test('subsystem table: every catalogue subsystem has a noun and an icon that exists; unknown ones fall back', () => {
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

test('house feed subject: whole-house rows get the subsystem noun, unless the sentence already opens with it', () => {
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

test('guard aborts: hidden from the House feed, muted on room pages, never a problem', () => {
  const guard = (ago, over = {}) => histEntry(ago, { kind: 'abort', decision: '', reason: 'bed_occupied', outcome: undefined, detail: { abort_kind: 'guard' }, ...over });
  const unhandled = histEntry(8, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unhandled_error' }, location: 'house' });
  const unavailable = histEntry(9, { kind: 'abort', decision: '', reason: '', outcome: undefined, detail: { abort_kind: 'unavailable_input', entity: 'sensor.x' }, location: 'house' });
  const houseGuard = guard(3, { location: 'house', subsystem: 'energy' });
  const house = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'house', subsystem: 'energy', decision: 'spin', reason: 'wheels_spun' }), houseGuard, guard(4), unhandled, unavailable])), NOW);
  assert.doesNotMatch(house, /Held back/, 'guards never reach the House feed');
  assert.equal(count(house, /class="tl-row /g), 3, 'the other rows stay');
  assert.match(house, /class="tl-row problem">[^]*?style="color:#eb6f92"><div class="tl-l1"><b class="tl-s">[^<]*<\/b> [Cc]ouldn&#39;t run: it failed unexpectedly/, 'real aborts stay in the attention colour');
  assert.match(house, /class="tl-row problem">[^]*?style="color:#eb6f92"><div class="tl-l1"><b class="tl-s">[^<]*<\/b> [Cc]ouldn&#39;t run: .*unavailable/);
  const room = P.render('room-feed', { room: 'kitchen' }, mk(histSensor('kitchen', [guard(2)])), NOW);
  assert.match(room, /class="tl-row declined">[^]*?style="color:#908caa"><div class="tl-l1"><b class="tl-s">[^<]*<\/b> held back/);
  assert.doesNotMatch(room, /color:#eb6f92/);
  assert.equal(P.sentenceFor(guard(1), mk()).tone, 'muted');
  assert.equal(P.sentenceFor(unhandled, mk()).tone, 'warn');
  // The lights story and tag must not call a guard a problem.
  const held = story({}, histSensor('kitchen', [guard(1), histEntry(60)]));
  assert.deepEqual([held.state, held.tone], ['declined', 'muted'], 'a held-back run reads as a decline, not a Problem');
  assert.match(held.why, /^Held back/);
  const failedStory = story({}, histSensor('kitchen', [unhandled, histEntry(60)]));
  assert.deepEqual([failedStory.state, failedStory.tone], ['problem', 'warn'], 'a genuine failure still is one');
});

test('narrow phone (360px): row titles and subtitles ellipsise in their own column; the trailing value and chevron never shrink', () => {
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

test('timeline: colon-form declined sentences split into subject line and capitalised reason; failures and no-reason rows stay as they were', () => {
  assert.deepEqual(P.splitSentence('Stayed off: bright enough, 85 lx (on at 40 or below)', true), { what: 'Stayed off', why: 'bright enough, 85 lx (on at 40 or below)' });
  assert.deepEqual(P.splitSentence('Stayed off: bright enough', false), { what: 'Stayed off: bright enough', why: '' });
  assert.deepEqual(P.splitSentence('Scene set · room occupied: dark', true), { what: 'Scene set', why: 'room occupied: dark' }, 'the earlier separator wins');
  assert.deepEqual(P.splitSentence('Lights off', true), { what: 'Lights off', why: '' });
  // Every declined wording in the table has the colon form, so none renders unsplit.
  for (const [key, fn] of Object.entries(P.REASON_TEXT)) {
    const t = fn({ lux: 5, lux_threshold: 10, source: 'x', hold: 'h', theme: 't', mode: 'comfort', indoor: 1, outdoor: 2, rooms: 'a', skipped: 'a', room: 'kitchen', hours: 1, minutes: 1, count: 1, person: 'adam', credited: 1, balance: 1, privacy: 'on', time: '10:00', scene: '', cause: '', target: 1, temp: 1 }, { name: (x) => x });
    if (/^(Stayed|Not |Fan left|Theme left|Heating left|Cameras left|Fan not|Left alone)/.test(t) && t.includes(': ')) assert.ok(P.splitSentence(t, true).why, key);
  }
  const hass = mk(histSensor('kitchen', [luxHigh(1), histEntry(2, { decision: 'turn_off', reason: 'occupancy_off' })]));
  const feed = P.render('room-feed', { room: 'kitchen' }, hass, NOW);
  assert.equal((feed.match(/ · /g) || []).length, 0, 'no middle dot anywhere in the rows');
  assert.match(feed, /<div class="tl-l2" style="color:#908caa">Bright enough, 85 lx/);
  assert.equal((feed.match(/class="tl-l2"/g) || []).length, 2);
  assert.match(rule('.tl-l2').body, /font-size:13\.5px/);
  assert.equal(px(decl(rule('.tl-l1').body, 'line-height')), 20, 'the dot stays on line 1');
  const bare = P.render('feed', {}, mk(histSensor('house', [histEntry(1, { location: 'house', subsystem: 'energy', decision: 'x', reason: 'adam', outcome: 'acted' })])), NOW);
  assert.doesNotMatch(bare, /tl-l2/, 'no reason, one line');
});
