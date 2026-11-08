// Pulse card tests: gardens. Run: cd tests && npm test (or node --test gardens.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, mk, withRooms, histEntry, histSensor, rowOf, rowTitle, rowSub, rowValue, SHARED_MODES, INDOOR_MODES, GARDEN_MODES, GARDENS, noNoise, calmRooms, count, attn, roomPaths, tileStyle, tomorrow, day, b, OPTIONS, FG_THEME, frontGarden, backGarden, litScenes, dark, declared, over } from './helpers.mjs';

const DAY = Date.parse('2026-11-02T12:00:00Z');

const EVENING = Date.parse('2026-11-02T19:00:00Z');

const NIGHT = Date.parse('2026-11-03T02:00:00Z');

const FG = 'front_garden';

const gr = (hass, mode = 'garden-lights', t = DAY, room = FG) => P.render(mode, { room }, hass, t);

// The garden Lights row: its switch state, its subtitle, which way the switch would turn, and whether it is disabled.
const rowText = (html) => ({ on: /aria-pressed="true"/.test(html), s: (html.match(/class="hm-rs">([^<]*)</) || [])[1], btn: { on: 'Turn on', off: 'Turn off' }[(html.match(/data-want="(on|off)"/) || [])[1]], disabled: /<button[^>]*\bdisabled/.test(html) });

const optionsOf = (html) => [...html.matchAll(/data-option="([^"]*)"/g)].map((m) => m[1]);

test('garden config: two gardens with a theme or none, no scenes, climate or lights of their own', () => {
  assert.deepEqual(P.GARDEN_ORDER, ['front_garden', 'back_garden']);
  for (const g of GARDENS) {
    assert.equal(P.ROOMS[g].kind, 'garden');
    for (const k of ['scenes', 'climate', 'temp', 'hum', 'lights', 'media']) assert.equal(P.ROOMS[g][k], undefined, `${g}.${k}`);
  }
  assert.equal(P.ROOMS.front_garden.theme, 'input_select.front_garden_light_theme');
  assert.equal(P.ROOMS.back_garden.theme, '');
});

test('garden lights row: off by day says when it comes on, and the button turns the theme on', () => {
  assert.deepEqual(rowText(gr(frontGarden())), { on: false, s: 'On at sunset · 16:30', btn: 'Turn on', disabled: false });
});

test('garden lights row: on in the evening window says until when', () => {
  const r = rowText(gr(frontGarden({ ...litScenes(), ...dark }), 'garden-lights', EVENING));
  assert.deepEqual(r, { on: true, s: 'Until 00:00 or bedtime', btn: 'Turn off', disabled: false });
});

test('garden lights row: on by day is a preview ending preview_min after the latest activation', () => {
  const at = (extra) => rowText(gr(frontGarden({ ...litScenes(), ...extra }))).s;
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-02T11:58:00+00:00') }), 'Preview · off by 12:08');
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-02T11:00:00+00:00') }), 'Preview · ending');
  assert.equal(at({ 'scene.front_garden_autumn': b('unavailable') }), 'Preview · off within 10 min');
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-02T11:00:00+00:00'), 'scene.front_garden_bonfire': b('2026-11-02T11:59:00+00:00') }), 'Preview · off by 12:09', 'the latest garden scene counts');
  assert.equal(at({ 'scene.front_garden_autumn': b('2026-11-01T11:00:00+00:00'), 'scene.front_garden_off': b('2026-11-02T11:59:00+00:00') }), 'Preview · ending', 'the off scene is not an activation');
});

test('garden lights row: no preview limit says until the off time; an unknown window drops the time', () => {
  const backOn = { 'sensor.back_garden_lighting_scenes': b('scene.back_garden_all', { off_scene: 'scene.back_garden_off', lights: ['switch.back_garden_plug_fence_lights'], lights_on: 1 }) };
  assert.deepEqual(rowText(gr(backGarden(backOn), 'garden-lights', DAY, 'back_garden')), { on: true, s: 'Until 22:00', btn: 'Turn off', disabled: false });
  const noWindow = { 'sensor.back_garden_lighting_window': b('unknown') };
  assert.equal(rowText(gr(backGarden({ ...backOn, ...noWindow }), 'garden-lights', DAY, 'back_garden')).s, 'Until bedtime');
  assert.equal(rowText(gr(frontGarden({ ...litScenes(), ...dark, 'sensor.front_garden_lighting_window': b('unknown') }), 'garden-lights', EVENING)).s, 'Until bedtime');
  assert.equal(rowText(gr(backGarden(noWindow), 'garden-lights', DAY, 'back_garden')).s, 'On at sunset · 16:30');
});

test('garden lights row: an off time after midnight keeps the window open; past it the lights are a preview again', () => {
  const window = { 'sensor.front_garden_lighting_window': b('01:30', { off: '01:30', preview_min: 10 }) };
  assert.equal(rowText(gr(frontGarden({ ...litScenes(), ...dark, ...window }), 'garden-lights', Date.parse('2026-11-03T00:30:00Z'))).s, 'Until 01:30 or bedtime');
  const late = { ...litScenes(), ...dark, 'scene.front_garden_autumn': b('2026-11-03T01:58:00+00:00') };
  assert.equal(rowText(gr(frontGarden(late), 'garden-lights', NIGHT)).s, 'Preview · off by 02:08');
});

test('garden lights row: asleep, tomorrow, automation off, missing scene and no report', () => {
  assert.equal(rowText(gr(frontGarden({ 'sensor.house_active_mode': b('sleep') }), 'garden-lights', EVENING)).s, 'House asleep · back at sunset');
  assert.equal(rowText(gr(frontGarden(dark), 'garden-lights', EVENING)).s, 'On at sunset tomorrow');
  assert.equal(rowText(gr(frontGarden({ 'sensor.sun_next_setting': b('unknown') }))).s, 'On at sunset tomorrow', 'no sunset time is invented');
  const manual = rowText(gr(frontGarden({ 'input_boolean.front_garden_automation_lights_enabled': b('off') })));
  assert.deepEqual([manual.s, manual.btn], ['Lights automation is off · they change only by hand', 'Turn on']);
  const noScene = { 'sensor.front_garden_lighting_scenes': b('missing', { theme: 'christmas', off_scene: 'scene.front_garden_off', missing_themes: ['christmas'], lights: [], lights_on: 0 }), ...FG_THEME('christmas') };
  assert.deepEqual(rowText(gr(frontGarden(noScene))), { on: false, s: 'No scene for Christmas', btn: 'Turn on', disabled: true });
  assert.deepEqual(rowText(gr(mk())), { on: false, s: 'No lighting report from Home Assistant', btn: 'Turn on', disabled: true });
});

test('garden lights row: a lit garden whose theme scene went missing can still be turned off', () => {
  const r = rowText(gr(frontGarden({ 'sensor.front_garden_lighting_scenes': b('missing', { theme: 'christmas', off_scene: 'scene.front_garden_off', missing_themes: ['christmas'], lights: ['light.a'], lights_on: 1 }) })));
  assert.deepEqual([r.btn, r.disabled], ['Turn off', false]);
});

test('garden lights: count whatever the off scene lists (switches too), clamped to the list', () => {
  const scenes = (lights, lights_on) => ({ 'sensor.back_garden_lighting_scenes': b('scene.back_garden_all', { off_scene: 'scene.back_garden_off', lights, lights_on }) });
  const model = (lights, n) => P.gardenModel(backGarden(scenes(lights, n)), 'back_garden', DAY);
  const one = model(['switch.back_garden_plug_fence_lights'], 1);
  assert.deepEqual([one.lights.length, one.lightsOn, one.on], [1, 1, true]);
  assert.equal(model(['switch.x'], 9).lightsOn, 1);
  assert.equal(model([], 3).on, false, 'no listed lights means nothing can be on');
});

test('garden scene targets outside the garden are refused', () => {
  const g = P.gardenModel(frontGarden({ 'sensor.front_garden_lighting_scenes': b('scene.parlour_all', { off_scene: 'light.front_garden_off', lights: [], lights_on: 0 }) }), FG, DAY);
  assert.deepEqual([g.onScene, g.offScene], ['', '']);
});

test('garden theme tiles come from the helper options, with the helper state active', () => {
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

test('every theme option in helpers.yaml has a label', () => {
  const helpers = yaml.load(readFileSync(root + 'packages/helpers.yaml', 'utf8'));
  const themes = Object.entries(helpers.input_select).filter(([id]) => id.endsWith('_light_theme'));
  assert.ok(themes.length > 0);
  for (const [id, h] of themes) {
    for (const o of h.options) {
      assert.ok(P.THEME_LABELS[o], `${id}: option "${o}" has no label`);
    }
  }
});

test('theme source line: paused, from calendar, picked by hand, and no next date', () => {
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

test('theme card: applies at sunset only when the garden is off and the pick has not been seen yet', () => {
  const picked = FG_THEME('bonfire', '2026-11-02T11:00:00+00:00');
  assert.match(gr(frontGarden(picked), 'garden-theme'), /Applies at sunset · 16:30/);
  assert.doesNotMatch(gr(frontGarden(), 'garden-theme'), /Applies at sunset/, 'the autumn look was seen after the pick');
  assert.doesNotMatch(gr(frontGarden({ ...litScenes(), ...picked }), 'garden-theme'), /Applies at sunset/, 'on now');
  assert.doesNotMatch(gr(frontGarden({ ...picked, 'input_boolean.front_garden_automation_lights_enabled': b('off') }), 'garden-theme'), /Applies at sunset/, 'automation off');
});

test('theme card: Use calendar only when the calendar is not in charge; the follow toggle moved to settings', () => {
  assert.doesNotMatch(gr(frontGarden(), 'garden-theme'), /Use calendar/);
  assert.doesNotMatch(gr(frontGarden(), 'garden-theme'), /Follow calendar|calendar_enabled/);
  const paused = gr(frontGarden({ 'input_boolean.front_garden_light_theme_calendar_enabled': b('off') }), 'garden-theme');
  assert.match(paused, /data-act="use-calendar" data-garden="front_garden"/);
  assert.match(paused, /Back to Autumn/);
  assert.match(gr(frontGarden(FG_THEME('halloween')), 'garden-theme'), /data-act="use-calendar"/);
});

test('garden writes: power uses the sensor scenes, themes use the helper, Use calendar toggles then selects', async () => {
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

test('garden writes fail loudly: bad option, no theme, not a garden, no scene, calendar theme not an option', async () => {
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

test('validate: garden modes need a garden, indoor modes need a room, shared modes take either', () => {
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

test('garden page: the header says whether the lights are on, the Lights row names the window, attention has its own label', () => {
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

test('House page: an Outside list with both gardens linking to their Pulse pages, apart from the indoor rooms', () => {
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
  assert.equal(tileStyle(front), 'background:#31748f;color:#e0def4');
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

test('a theme switch reads in words (the daily calendar publish is declared ignored, so homerun never stores it)', () => {
  const cal = { location: FG, automation_id: 'front_garden:lighting:theme_calendar' };
  const entries = [histEntry(1, { ...cal, decision: 'switch_theme', reason: 'calendar_boundary', facts: { theme: 'halloween' } })];
  const html = gr(frontGarden(histSensor(FG, entries)), 'room-feed');
  assert.doesNotMatch(html, /publish|calendar publish|not a calendar boundary/i);
  assert.match(html, /<b class="tl-s">Lights<\/b> theme switched to Halloween<\/div><div class="tl-l2" style="color:#908caa">Calendar/);
  assert.equal((html.match(/class="tl-row /g) || []).length, 1);
});

test('garden YAML: views use the garden template, Mobile links to Pulse, feed and attention wording are in place', () => {
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

test('garden sensors: MQTT topics and the lighting scenes template per garden', () => {
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

test('Christmas scene exists, Normal keeps its entity id, scene ids stay unique', () => {
  const scenes = yaml.load(readFileSync(root + 'scenes.yaml', 'utf8'));
  const byId = Object.fromEntries(scenes.map((x) => [x.id, x]));
  assert.equal(byId['1792000000002'].name, 'Front Garden Normal');
  assert.equal(byId['1792000000006'].name, 'Front Garden Christmas');
  assert.deepEqual(Object.keys(byId['1792000000006'].entities).sort(), Object.keys(byId['1792000000003'].entities).sort());
  assert.equal(new Set(scenes.map((x) => x.id)).size, scenes.length);
});
