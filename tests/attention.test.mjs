// Pulse card tests: attention. Run: cd tests && npm test (or node --test attention.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { P, NOW, FULL, mk, withRooms, rowOf, rowTitle, rowSub, renderAll, noNoise, real, quietRoom, calmRooms, count, attn, tileStyle, day, nowPage, footnote, b, worded, update } from './helpers.mjs';

test('calm state: no attention, All good', () => {
  const rooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, }));
  const out = renderAll(withRooms(rooms, []));
  noNoise(out, 'calm');
  assert.doesNotMatch(out.status, /Needs attention|All good|Nothing needs attention/);
  assert.doesNotMatch(out['room-head:parlour'], /All good|hm-tight/, 'a calm room has no banner and no attention list');
  assert.match(out['room-head:parlour'], /<span class="hm-line">Occupied · lights off · 20.8°<\/span>/);
  assert.match(out['heating:parlour'], /class="segs five"/, 'a calm room shows the mode control');
  assert.doesNotMatch(out['heating:parlour'], /, from /, 'the control replaces the mode and source row');
  assert.doesNotMatch(out['room-head:parlour'], />Target</, 'the header carries no numbers');
});

test('House attention: one row per item with the room as title, the detail as subtitle and a glyph for the kind; rooms stay listed too', () => {
  const rooms = calmRooms({
    bathroom: { occupied: true, temp: 23.1, humidity: 88, lights_on: 1 },
    bedroom: { occupied: true, target: 5, target_reason: 'window open', mode_name: 'baseline day', mode_target: 18, heat_labels: ['Window open'], labels: ['Window open'], temp: 20.8 },
  });
  const items = [attn('Bathroom', 'bathroom', 'warm_heating', '23.1° vs 18° target, heating on'), attn('Bedroom', 'bedroom', 'window_open_heating_on', 'Open window while heating is on')];
  const hass = withRooms(rooms, items);
  const status = P.render('status', {}, hass, NOW);
  assert.match(status, /<h2 style="color:#eb6f92">Needs attention<\/h2>/);
  const bath = rowOf(status, '/pulse-dashboard/room-bathroom');
  const bed = rowOf(status, '/pulse-dashboard/room-bedroom');
  assert.equal(rowTitle(bath), 'Bathroom');
  assert.match(rowSub(bath), /23\.1° vs 18° target, heating on · 88% humidity, probably a shower/);
  assert.equal(rowSub(bed), 'Open window while heating is on');
  assert.equal(tileStyle(bed), 'background:#eb6f92;color:#191724');
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

test('House attention: no section when calm, a footnote when the report is missing, never an all-good state', () => {
  const calm = nowPage(withRooms(calmRooms(), []));
  assert.doesNotMatch(calm, /Needs attention|card pad warn|All good/);
  assert.match(P.render('status', {}, { states: {} }, NOW), /<p class="hm-foot">No attention report<\/p>/);
  assert.doesNotMatch(P.render('status', {}, withRooms(calmRooms(), []), NOW), /No attention report/);
  assert.match(P.STYLE, /\.hm-foot\{[^}]*color:#908caa/);
});

test('attention rows say which way a temperature is off: the detail is the subtitle, steamy adds the humidity', () => {
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

test('status attention: each row links to its own room, a room-less item opens House; +N more opens the first room not already shown', () => {
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

test('attention feed labels a motion sensor left off', () => {
  const hass = withRooms([quietRoom('bedroom')], [attn('Bedroom', 'bedroom', 'motion_disabled', 'Motion ignored, the room relies on holds')]);
  assert.match(P.render('room-head', { room: 'bedroom' }, hass, NOW), /Motion sensor off/);
  assert.doesNotMatch(P.render('room-head', { room: 'bedroom' }, hass, NOW), /Motion disabled/);
  assert.equal(rowSub(rowOf(P.render('status', {}, hass, NOW), '/pulse-dashboard/room-bedroom')), 'Motion ignored, the room relies on holds');
});

test('unexplained_reason: a catalogue reason with no wording raises attention; the real catalogue raises none', () => {
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
