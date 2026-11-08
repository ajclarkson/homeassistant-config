// Pulse card tests: house. Run: cd tests && npm test (or node --test house.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, mk, withRooms, histEntry, histSensor, rowOf, rowTitle, rowSub, rowValue, NOISE, noNoise, rect, real, mkSlots, quietRoom, calmRooms, count, attn, roomPaths, tileStyle, tomorrow, nowPage, cssRules, decl, px, rule, tile, footnote, long } from './helpers.mjs';

test('House list: what is due next and when; boiler and inside/outside', () => {
  const html = P.render('house-list', {}, mk({ 'sensor.house_average_temperature': { state: '19.9', attributes: {} }, 'weather.forecast_home': { state: 'cloudy', attributes: { temperature: 10 } } }), NOW);
  assert.match(html, /<div class="hm-rt">Refuse<\/div><div class="hm-rs" style="color:#eb6f92">Collected tomorrow</);
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

test('House calm: no attention section, no occupied rooms; Rooms lists all 8 in order with "0 occupied"', () => {
  const hass = withRooms(calmRooms(), []);
  const status = P.render('status', {}, hass, NOW);
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.doesNotMatch(status, /Needs attention|All good|Nothing needs attention/);
  assert.match(rooms, /<h2>Rooms<\/h2><span class="hm-tr">0 occupied<\/span>/);
  assert.doesNotMatch(rooms, /Occupied now|Other rooms/);
  assert.deepEqual(roomPaths(rooms), P.ROOM_ORDER);
  assert.equal(count(rooms, /style="background:#9ccfd8/g), 0, 'no occupied tile');
  assert.equal(count(rooms, /style="background:#2a2740;color:#908caa"/g), 8, 'eight idle tiles');
  assert.doesNotMatch(rooms, /%|humidity|automatic/);
  noNoise({ status, rooms }, 'calm house');
});

test('House rooms: an occupied room leads the list with the occupied tile, lights line and temperature', () => {
  const hass = withRooms(calmRooms({ bedroom: { occupied: true, lights_on: 3, pres_labels: ['Sofa occupied'], labels: ['Sofa occupied'], temp: 20.4, scene: 'parlour_lamps' } }), [], { 'sensor.bedroom_active_scene': { state: 'bedroom_lamps', attributes: {} } });
  const rooms = P.render('rooms', {}, hass, NOW);
  assert.match(rooms, /<span class="hm-tr">1 occupied<\/span>/);
  assert.deepEqual(roomPaths(rooms), ['bedroom', ...P.ROOM_ORDER.filter((k) => k !== 'bedroom')]);
  const row = rowOf(rooms, '/pulse-dashboard/room-bedroom');
  assert.equal(rowTitle(row), 'Bedroom');
  assert.equal(tileStyle(row), 'background:#9ccfd8;color:#191724');
  assert.match(row, /<svg[^>]*fill="currentColor"/, 'occupied is a solid person glyph');
  assert.equal(rowSub(row), 'Lamps · sofa occupied');
  assert.equal(rowValue(row), '20.4°');
  const idle = rowOf(rooms, '/pulse-dashboard/room-parlour');
  assert.doesNotMatch(idle, /<svg[^>]*fill="currentColor"/, 'empty is an outline glyph');
  assert.equal(rowSub(idle), 'Lights off');
  assert.doesNotMatch(rooms, /Manual|%|humidity/);
});

test('House rooms: the bed hold reads "Someone in bed"', () => {
  const rooms = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupied: true, pres_labels: ['Bed occupied'], labels: ['Bed occupied'] } }), []), NOW);
  assert.equal(rowSub(rowOf(rooms, '/pulse-dashboard/room-bedroom')), 'Lights off · someone in bed');
});

test('House rooms: all occupied gives eight occupied tiles and "8 occupied"', () => {
  const rooms = P.render('rooms', {}, withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), []), NOW);
  assert.match(rooms, /<span class="hm-tr">8 occupied<\/span>/);
  assert.equal(count(rooms, /style="background:#9ccfd8;color:#191724"/g), 8);
});

test('House rooms: occupied rooms first and the rest in fixed order, for every occupied combination', () => {
  const keys = P.ROOM_ORDER;
  for (let occMask = 0; occMask < 256; occMask += 17) for (let attMask = 0; attMask < 256; attMask += 29) {
    const occupied = keys.filter((k, i) => occMask & (1 << i));
    const items = keys.filter((k, i) => attMask & (1 << i)).map((k) => attn(k, k, 'automation_disabled', 'Lights automation is off'));
    const html = P.render('rooms', {}, withRooms(keys.map((k) => quietRoom(k, { occupied: occupied.includes(k) })), items), NOW);
    assert.deepEqual(roomPaths(html), [...occupied, ...keys.filter((k) => !occupied.includes(k))], `mask ${occMask}/${attMask}`);
  }
});

test('House rooms: the manual marker shows only while it exists', () => {
  const manual = { source: 'wall_button', ts: '2026-10-25T16:40:00+00:00', what: 'Wall button: scene cycled' };
  const on = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual, lights_on: 2 } }), []), NOW);
  assert.match(rowSub(rowOf(on, '/pulse-dashboard/room-parlour')), /manual change/);
  const none = P.render('rooms', {}, withRooms(calmRooms({ parlour: { occupied: true, manual: null } }), []), NOW);
  assert.doesNotMatch(none, /manual change/);
});

test('House rooms: window and door holds read in the subtitle', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ kitchen: { occupied: true, heat_labels: ['Window open'] }, bedroom: { heat_labels: ['Window open'] }, hallway_downstairs: { heat_labels: ['Door open'] } }), []), NOW);
  assert.equal(count(html, /class="hm-rs">Lights off · window open</g), 2);
  assert.equal(count(html, /class="hm-rs">Lights off · door open</g), 1);
});

test('recent action note stays a phrase with its verb (under 15 minutes) but only a scene change reaches the room subtitle', () => {
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

test('House rooms: one lights state, at most one reason in priority order, never "marked"', () => {
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

test('House rooms: unavailable occupancy shows an attention glyph; rooms with no report say so; rows are 60px links', () => {
  const html = P.render('rooms', {}, withRooms(calmRooms({ bedroom: { occupancy_unavailable: true } }), []), NOW);
  assert.equal(tileStyle(rowOf(html, '/pulse-dashboard/room-bedroom')), 'background:#2a2740;color:#eb6f92');
  const missing = P.render('rooms', {}, mk(), NOW);
  const roomsOnly = missing.slice(0, missing.indexOf('<h2>Outside'));
  assert.equal(count(roomsOnly, /class="hm-rs">No report/g), 8);
  assert.equal(count(roomsOnly, /class="hm-val num">–</g), 7, 'seven rooms with a climate sensor show a dash; the climate-less hallway shows no value');
  assert.match(P.STYLE, /\.hm-row\{[^}]*min-height:60px/);
  assert.match(P.STYLE, /\.hm-tile\{width:30px;height:30px;border-radius:8px/);
});

test('House electricity widget: one link to the Energy page with the price, next half hour, chart and cheapest window', () => {
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

test('House electricity widget: a mini chart of the next 9 half-hour slots, current slot highlighted, hidden from assistive tech', () => {
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

test('House view layout: header, status, rooms, house list, feed, tab bar; no old modes', () => {
  const v = yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8'));
  const modes = v.sections[0].cards.map((c) => c.mode);
  assert.deepEqual(modes, ['now-header', 'status', 'rooms', 'house-list', 'feed', 'tabbar']);
  for (const m of modes) assert.ok(P.render(m, {}, mk(), NOW) !== undefined);
  for (const old of ['attention', 'bins', 'bins-heating', 'cameras-card', 'energy-foot', 'energy']) assert.throws(() => P.render(old, {}, mk(), NOW), /unknown mode/, old);
});

test('House header: large title, mode and occupancy line, two avatars with presence dots, the Mo line; no Pulse title, pill or chips', () => {
  const hdr = P.render('now-header', {}, withRooms(calmRooms({ parlour: { occupied: true }, kitchen: { occupied: true } }), []), NOW);
  assert.match(hdr, /<h1 class="hm-big">Home<\/h1>/);
  assert.match(hdr, />At home<\/a>/);
  assert.doesNotMatch(hdr, /occupied/, 'the occupied count is said once, on the Rooms header');
  assert.doesNotMatch(hdr, />Pulse<|class="tag|class="chip|● /);
  assert.equal(count(hdr, /<a /g), 1, 'the mode line is the only link in the header');
  assert.match(hdr, /data-path="\/pulse-dashboard\/settings" aria-label="Open settings"/);
  const avatars = [...hdr.matchAll(/<span class="hm-av" role="img" aria-label="([^"]*)">(\w)<span class="hm-pd" style="background:(#[0-9a-f]{6})"><\/span><\/span>/g)].map((m) => m.slice(1));
  assert.deepEqual(avatars, [['Adam, home', 'A', '#9ccfd8'], ['Sarah, away', 'S', '#524f67']], 'initials, label and dot colour per presence');
  assert.match(hdr, /<div class="hm-mo">Mo<\/div>/);
  const away = P.render('now-header', {}, mk({ 'person.adam': { state: 'unknown', attributes: {} } }), NOW);
  assert.match(away, /aria-label="Adam, unknown"/);
  assert.match(P.render('now-header', {}, mk({ 'sensor.house_active_mode': { state: 'vacation', attributes: {} } }), NOW), />On holiday<\/a>/);
  assert.match(P.render('now-header', {}, mk({ 'input_select.house_active_mode_modifier': { state: 'guest', attributes: {} } }), NOW), />At home · Guest<\/a>/);
  // avatars sit side by side with a gap, each dot on its own avatar's bottom-right with a ring in the page colour
  assert.match(P.STYLE, /\.hm-avs\{[^}]*gap:6px/);
  assert.doesNotMatch(P.STYLE, /\.hm-av\+\.hm-av/, 'no overlap');
  assert.match(P.STYLE, /\.hm-av\{[^}]*position:relative/);
  assert.match(P.STYLE, /\.hm-pd\{[^}]*position:absolute;right:-2px;bottom:-2px;[^}]*box-shadow:0 0 0 2px #191724/);
  assert.match(P.STYLE, /\.hm-av\{[^}]*width:36px;height:36px;border-radius:50%;background:#26233a;border:2px solid #191724/);
  assert.match(P.STYLE, /\.hm-pd\{[^}]*width:10px;height:10px/);
  for (const hass of [mk(), withRooms(calmRooms(), []), withRooms(P.ROOM_ORDER.map((k) => quietRoom(k, { occupied: true })), [attn('Bedroom', 'bedroom', 'automation_disabled', 't')]), { states: {} }]) assert.doesNotMatch(nowPage(hass), /Updated/);
  assert.equal(count(nowPage(mk()), /data-path="\/mobile-dashboard"/g), 0);
  assert.doesNotMatch(P.render('tabbar', { active: 'house' }, mk(), NOW, {}), /mobile-dashboard|Controls/);
});

test('House header: the Mo line keeps its content (last meal, shortened), unchanged from the old chip', () => {
  const worst = P.render('now-header', {}, mk({ 'sensor.mo_timeline': { state: 'x', attributes: { eating: [{ ts: Date.parse('2026-10-24T18:05:00Z') }] } } }), NOW);
  assert.match(worst, /<div class="hm-mo">Mo · ate yest 18:05<\/div>/);
  assert.doesNotMatch(worst, /yesterday/);
  assert.match(P.STYLE, /\.hm-mo\{[^}]*color:#908caa/);
});

test('House type scale: 34/41 title, 20 bold sentence-case section headers, 17 row titles, 14 subtitles, 13 footnote; rounded tabular numerals; no uppercase labels', () => {
  const css = P.STYLE;
  assert.match(css, /\.hm-big\{[^}]*font-size:34px;line-height:41px;font-weight:700/);
  assert.match(css, /\.hm-h h2\{[^}]*font-size:20px[^}]*font-weight:700/);
  assert.match(css, /\.hm-rt\{font-size:17px/);
  assert.match(css, /\.hm-rs\{font-size:14px;line-height:19px;color:#908caa/);
  assert.match(css, /\.hm-foot\{[^}]*font-size:13px/);
  assert.match(css, /\.hm \.num,\.hm-price,\.hm-val\{font-family:ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums\}/);
  assert.match(css, /\.hm\{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif/);
  const hm = css.split('\n').filter((l) => /^\.hm/.test(l)).join('\n');
  assert.doesNotMatch(hm, /uppercase|letter-spacing:\.[4-9]/);
  const page = nowPage(withRooms(calmRooms(), [attn('Bedroom', 'bedroom', 'automation_disabled', 'x')]));
  assert.doesNotMatch(page, /class="lbl"|text-transform/, 'the House page uses no uppercase label');
  assert.doesNotMatch(css.split('\n').filter((l) => /^\.hm/.test(l)).join('\n'), /textTertiary|#6e6a86/);
  const sections = [...page.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['Needs attention', 'Rooms', 'Outside', 'House', 'Activity']);
});

test('House spacing: one 36px gap above every section and widget, whichever card it lives in (markup/CSS only, no browser)', () => {
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

test('House list: inset grouped list, rows 60px with a 30px tile, hairline starting at the text column, whole row a link', () => {
  const css = P.STYLE;
  assert.doesNotMatch(css.match(/\.hm\{[^}]*\}/)[0], /padding/, 'no side margin on lists or widgets: HA view padding is the inset');
  assert.match(css, /\.hm-h\{[^}]*padding:0 4px/, 'headers sit 4px in from the list edge');
  assert.match(css, /\.hm-top\{[^}]*padding:0 4px/);
  assert.match(css, /\.hm-mo\{padding:0 4px/);
  assert.match(css, /\.hm-list\{background:#1f1d2e;border-radius:12px/);
  assert.match(css, /\.hm-row\{[^}]*gap:12px;min-height:60px;padding:0 14px/);
  assert.match(css, /\.hm-row\+\.hm-row::before\{[^}]*left:56px[^}]*height:\.5px;background:rgba\(110,106,134,\.35\)/, '14 + 30 + 12: the hairline starts at the text column');
  assert.match(css, /\.hm-chev\{[^}]*width:14px;color:#524f67/);
  const page = nowPage(withRooms(calmRooms(), []));
  for (const row of page.match(/<a class="hm-row tap"[^>]*>/g)) assert.match(row, /data-act="nav" data-path="\/pulse-dashboard\//);
  assert.equal(count(page, /<a class="hm-row tap"/g) > 10, true);
  assert.doesNotMatch(page, /<div class="hm-row"[^>]*data-act/, 'a row that navigates is an <a>');
  assert.match(page, /<svg [^>]*aria-hidden="true"/);
  assert.doesNotMatch(page.replace(/<svg[\s\S]*?<\/svg>/g, ''), /<svg/);
});

test('House sparse and missing data: every House mode renders cleanly', () => {
  for (const hass of [{ states: {} }, mk(), withRooms(P.ROOM_ORDER.map((k) => ({ k })), [{}]), withRooms('junk', 'junk'), withRooms(P.ROOM_ORDER.map((k) => ({ k, temp: null, manual: 'x', labels: 7 })), [])]) {
    const page = nowPage(hass);
    assert.doesNotMatch(page, NOISE);
    assert.doesNotMatch(page, /Updated/);
  }
});

test('House rooms: a room with a climate sensor and no reading keeps a dash; one without shows no value and says so', () => {
  const quiet = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { temp: null, humidity: null }, kitchen: { temp: null } }), []), NOW);
  const up = rowOf(quiet, '/pulse-dashboard/room-hallway_upstairs');
  assert.equal(rowValue(up), undefined);
  assert.equal(rowSub(up), 'Lights off · no temperature sensor');
  assert.equal(rowValue(rowOf(quiet, '/pulse-dashboard/room-kitchen')), '–');
  const occ = P.render('rooms', {}, withRooms(calmRooms({ hallway_upstairs: { occupied: true, temp: null } }), []), NOW);
  assert.equal(rowValue(rowOf(occ, '/pulse-dashboard/room-hallway_upstairs')), undefined);
  assert.equal(roomPaths(occ)[0], 'hallway_upstairs');
});

test('list rows have their arithmetic: a 60px row holds the 30px tile and the 22px + 19px text lines; the activity row grows with its text', () => {
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

test('every fixed height or clipping rule is accounted for (a new one needs its arithmetic)', () => {
  const fixed = cssRules().filter((r) => px(decl(r.body, 'height'))).map((r) => r.sel).sort();
  // Fixed SHAPES that hold no text: dots, icons, avatars, tiles, bars, switch track and knob, slider track and
  // thumb, the 1px visually-hidden helper. No content box has a fixed height.
  const shapes = ['.hm-thumb', '.dot', '.sw', '.sw::after', '.sr', '.hm-sw', '.hm-sw::after', '.hm-step', '.hm-step-div', '.hm-slider', '.hm-slider::-webkit-slider-runnable-track', '.hm-slider::-webkit-slider-thumb', '.hm-slider::-moz-range-track', '.hm-slider::-moz-range-progress', '.hm-slider::-moz-range-thumb', '.hm-av', '.hm-pd', '.hm-tile', '.hm-bars', '.hm-row+.hm-row::before', '.hm-dp .hm-row::before', '.ptz button', '.tl-dot', '.tl-row:last-child .tl-rail::before'];
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
  for (const sel of ['.hm-row', '.tog', '.link', '.seg', '.row']) assert.ok(px(decl(rule(sel).body, 'min-height')) > 0 && px(decl(rule(sel).body, 'height')) === null, sel);
  // The bar chart: the tallest bar fits its 44px box and a zero or negative price keeps a 4px stub.
  assert.equal(px(decl(rule('.hm-bars').body, 'height')), 44);
  const barHeights = [...P.render('status', {}, mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates: mkSlots(9, '2026-10-25T18:00:00Z', (i) => i * 5 - 5) } } }), Date.parse('2026-10-25T18:00:00Z')).matchAll(/class="hm-bar[^"]*" style="height:(\d+)px/g)].map((m) => +m[1]);
  assert.equal(Math.min(...barHeights), 4);
  assert.equal(Math.max(...barHeights), 44);
});

// ── Pulse home-page UX tweaks ───────────────────────────────────────────────────────────────────
test('House list: Heating, Cameras, Bins in that order under one "House" header, after the rooms card that ends with Outside', () => {
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

test('House list tiles and trailing links: heating tile, cameras tile, bins tile; heating and cameras link, bins does not', () => {
  const cams = mk({ 'switch.parlour_privacy': { state: 'on', attributes: {} }, 'switch.kitchen_privacy': { state: 'on', attributes: {} }, 'switch.home_office_privacy': { state: 'on', attributes: {} } });
  const html = P.render('house-list', {}, cams, NOW);
  const heat = rowOf(html, P.SETTINGS_PATH);
  assert.equal(tileStyle(heat), 'background:#ebbcba;color:#191724');
  assert.ok(heat.includes(P.ICON.flameFull), 'the heating tile uses the full-size flame, not the small inline one');
  assert.doesNotMatch(heat, /d="M12 3c1 3 4/);
  assert.match(heat, /<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"/, 'an 18px solid glyph like the other tiles');
  assert.match(P.ICON.flameFull, /^M12 2\.5c/, 'spans nearly the full 24 box (top at 2.5)');
  const camRow = rowOf(html, P.CAMERAS_PATH);
  assert.equal(tileStyle(camRow), 'background:#403d52;color:#e0def4');
  const bins = html.match(/<div class="hm-row"><span class="hm-tile"[^>]*>[\s\S]*?<\/div><\/div>/)[0];
  assert.match(bins, /background:#7aa2f7;color:#191724/);
  assert.doesNotMatch(bins, /hm-chev|data-path/, 'bins has no page to open');
  const offline = P.render('house-list', {}, mk({ 'switch.parlour_privacy': { state: 'unavailable', attributes: {}, last_changed: '2026-10-26T12:00:00+00:00' }, 'switch.kitchen_privacy': { state: 'on', attributes: {} }, 'switch.home_office_privacy': { state: 'on', attributes: {} } }), NOW);
  assert.equal(tileStyle(rowOf(offline, P.CAMERAS_PATH)), 'background:#eb6f92;color:#191724', 'an offline camera takes the attention tile');
  assert.match(rowSub(rowOf(offline, P.CAMERAS_PATH)), /offline$/);
  const today = P.render('house-list', {}, mk({ 'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '0', attributes: {} } }), NOW);
  assert.match(today, /Collected today/);
  const far = P.render('house-list', {}, mk({ 'sensor.st_albans_collect_domestic_refuse_days_until_collection': { state: '5', attributes: {} }, 'sensor.st_albans_collect_domestic_food_days_until_collection': { state: '9', attributes: {} } }), NOW);
  assert.match(far, /<div class="hm-rt">Refuse<\/div><div class="hm-rs">Collected in 5 days</, 'not soon: the subtitle keeps the secondary colour');
});

test('heating row: short title; the room count leads the subtitle only when heating is on and rooms are calling', () => {
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
