// Pulse card tests: settings. Run: cd tests && npm test (or node --test settings.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, mk, INDOOR_MODES, GARDEN_MODES, GARDENS, streamlineVars, substitute, loadYaml, count, footnote, b, helpersYaml, helperIds, settingRows, sheetHass, sheet, over, long } from './helpers.mjs';

// The native rhythm of the Settings page.
const setHass = (over = {}) => {
  const c = (st, extra = {}) => ({ state: st, attributes: {}, ...extra });
  return mk({
    'sensor.house_active_mode': c('normal', { last_changed: '2026-10-29T07:30:00+00:00' }), 'input_select.house_active_mode_modifier': c('guest'),
    'input_number.house_automation_vacation_threshold_hours': c('48'), 'input_boolean.wfh_adam': c('on'), 'input_boolean.wfh_sarah': c('off'),
    'person.adam': c('home'), 'person.sarah': c('not_home'), 'input_boolean.house_heating_enabled': c('on'), 'binary_sensor.house_heating_boiler_firing': c('on'),
    'input_number.global_temperature_baseline_day': c('19.5'), 'input_number.global_temperature_baseline_night': c('17'), 'input_number.global_temperature_comfort': c('21'), 'input_number.global_temperature_minimum': c('12'),
    'input_number.global_heating_window_open_grace_minutes': c('5'), 'input_boolean.mo_notifications_spotted_enabled': c('on'), 'input_boolean.mo_notifications_eating_enabled': c('off'), ...over,
  });
};

const setPages = () => { const h = setHass(); const at = Date.parse('2026-10-29T14:00:00+00:00'); return { head: P.render('house-head', {}, h, at), mode: P.render('house-mode', {}, h, at), people: P.render('house-people', {}, h, at), heating: P.render('house-heating', {}, h, at), mo: P.render('house-mo', {}, h, at) }; };

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

// The settings groups (ROOM_TABLE) a rendered Automation list draws from, in order.
const groupsOf = (html) => [...new Set([...html.matchAll(/data-act="setting-(?:toggle|number)" data-room="\w+" data-group="(\w+)"/g)].map((m) => m[1]))];

test('house page: mode banner, modifier picker and holiday threshold write only to their fixed helpers', () => {
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
  assert.match(head, /<span class="hm-line">Away · Sitter<\/span>/, 'the mode and modifier are the subtitle');
  assert.match(head, /Heating at night baseline<\/div><\/div><span class="hm-val num">Since 10:00<\/span>/, 'one fact per row, the start time trailing the first');
  assert.match(head, /Holiday heating in 44 h/);
  assert.doesNotMatch(head, / · (cameras|holiday)/, 'a second row, not a middle dot');
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

test('settings page: head is the large title with the house mode as its subtitle (as on Home), then the mode as a list', () => {
  const { head } = setPages();
  assert.match(head, /^<div class="p"><div class="hm hm-first"><div class="hm-head"><div class="hm-hd"><h1 class="hm-big">Settings<\/h1><span class="hm-line">At home · Guest<\/span><\/div><\/div><section class="hm-sec hm-tight"><div class="hm-list plain">/);
  assert.match(head, /Rooms follow their schedules and presence<\/div><\/div><span class="hm-val num">Since 07:30<\/span>/);
  assert.doesNotMatch(head, /Back to House|data-act="nav"|class="card|class="dot|class="lbl/);
  assert.doesNotMatch(P.render('house-head', {}, mk(), NOW), /Since/, 'no mode, no start time');
  assert.match(P.render('house-head', {}, { states: {} }, NOW), /<span class="hm-line">Mode unknown<\/span>/);
});

test('settings page: House mode is a segmented control with its description underneath and the holiday threshold a stepper row', () => {
  const { mode } = setPages();
  assert.match(mode, /^<div class="p"><div class="hm"><section class="hm-sec"><div class="hm-h"><h2>House mode<\/h2><\/div><div class="segs" role="group" aria-label="Mode modifier">/);
  assert.equal(count(mode, /class="seg( on)?" data-act="house-modifier"|class="seg on" data-act="house-modifier"/g), 3, 'None, Guest and Sitter are all still there');
  assert.match(mode, /seg on" data-act="house-modifier" data-option="guest"/);
  assert.match(mode, /<div class="hm-feet"><p class="hm-foot">Home office held occupied/);
  assert.match(mode, /Holiday threshold<span class="hm-tv num">48 h<\/span><\/div><div class="hm-rs">How long away lasts before holiday heating<\/div>/);
  assert.match(mode, /<span class="hm-step"><button type="button" data-act="house-threshold"\s+data-delta="-1" aria-label="Holiday threshold shorter">/);
  assert.match(mode, /data-delta="1" aria-label="Holiday threshold longer"/);
  assert.match(mode, /class="hm-group-row"/);
  const away = P.render('house-mode', {}, setHass({ 'sensor.house_active_mode': { state: 'away', attributes: {} } }), NOW);
  assert.match(away, /Away now, counting from when the house went away/);
  assert.equal(P.render('house-mode', {}, { states: {} }, NOW), '', 'nothing to show, nothing drawn');
});

test('settings page: people are avatar rows with a native switch; heating settings are list rows with steppers; no pills or round buttons', () => {
  const { people, heating } = setPages();
  assert.match(people, /<h2>People<\/h2>/);
  assert.match(people, /data-entity="input_boolean\.wfh_adam" aria-pressed="true"><span class="hm-av" role="img" aria-label="Adam, home">A<span class="hm-pd"[^>]*><\/span><\/span><div class="hm-text"><div class="hm-rt">Adam working from home<\/div><div class="hm-rs">Home\. Set automatically from the weekly pattern, tap to override<\/div><\/div><span class="hm-sw" aria-hidden="true"><\/span>/);
  assert.match(people, /aria-label="Sarah, away"/);
  assert.match(people, /<div class="hm-rs">Away\. Set automatically/);
  assert.match(people, /<span class="hm-sw off" aria-hidden="true">/);
  assert.deepEqual([...heating.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ['Heating', 'Temperature modes', 'Safety']);
  assert.match(heating, /Central heating<\/div><div class="hm-rs">Boiler firing<\/div>/);
  assert.equal(count(heating, /class="hm-step"/g), 5, 'four temperatures and the window grace');
  assert.match(heating, /Day baseline<span class="hm-tv num">19\.5°<\/span>/);
  assert.match(heating, /Window open grace<span class="hm-tv num">5 min<\/span>/);
  assert.match(heating, /data-act="house-number" data-key="comfort" data-delta="1" aria-label="Comfort higher"/);
  assert.match(heating, /<p class="hm-foot">Applies to every room that uses the global setpoints<\/p>/, 'the note is a footnote under its list');
  for (const [k, html] of Object.entries({ people, heating })) assert.doesNotMatch(html, /class="(tog|round|sw|lbl|tag)|text-transform|class="card/, k);
  const idle = P.render('house-heating', {}, setHass({ 'binary_sensor.house_heating_boiler_firing': { state: 'off', attributes: {} } }), NOW);
  assert.match(idle, /Boiler idle/);
});

test('settings page: the Mo switches keep their own look; only the gap above them follows the shared section gap', () => {
  const { mo } = setPages();
  assert.match(mo, /^<div class="p"><div class="lbl" style="margin:max\(0px,calc\(36px - var\(--row-gap,8px\)\)\) 4px -10px">Mo<\/div><div class="card">/);
  assert.equal(count(mo, /<button class="tog tap" data-act="mo-toggle"/g), 2);
  assert.match(mo, /<span class="sw" role="img" aria-label="On">/);
  assert.match(mo, /Spotted notifications<\/div><div class="s">A phone alert when Mo is seen on a camera/);
  assert.match(P.STYLE, /\.lbl\{font-size:11px;font-weight:600;letter-spacing:\.8px;text-transform:uppercase/, 'its label style is untouched');
});

test('settings page: sentence-case headers and one block per card; only the title card is flush at the top', () => {
  const pages = setPages();
  for (const k of ['head', 'mode', 'people', 'heating']) {
    assert.match(pages[k], k === 'head' ? /^<div class="p"><div class="hm hm-first">/ : /^<div class="p"><div class="hm">/, k);
    for (const h of pages[k].matchAll(/<h2>([^<]+)<\/h2>/g)) assert.equal(h[1], h[1].charAt(0) + h[1].slice(1).toLowerCase(), `${k}: "${h[1]}"`);
  }
  assert.equal(count(pages.head + pages.mode + pages.people + pages.heating, /hm-first/g), 1);
});

test('settings page is reachable from the House header pill and the Heating card, and registered in the dashboard', () => {
  const hdr = P.render('now-header', {}, mk(), NOW);
  assert.match(hdr, new RegExp(`data-act="nav" data-path="${P.SETTINGS_PATH}"`));
  assert.match(P.render('house-list', {}, mk(), NOW), new RegExp(`data-path="${P.SETTINGS_PATH}"`));
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-settings\.yaml/);
  const v = yaml.load(readFileSync(root + 'views/info-settings.yaml', 'utf8'));
  assert.deepEqual(v.sections[0].cards.map((c) => c.mode), ['house-head', 'house-mode', 'house-people', 'house-heating', 'house-mo', 'tabbar']);
  assert.equal(v.path, 'settings');
});

test('house heating section: central heating toggle, temperature steppers and window grace write to fixed helpers within range', () => {
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
  assert.match(out, /Every room drops to its minimum/);
  assert.doesNotMatch(out, /Off · /);
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

test('settings: groups per room, in subsystem order, with the plan rows', () => {
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

test('settings: foreign office door heating steppers and the Sonos follow toggles', () => {
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

test('settings: the stepper ranges equal the expected clamps, and sit inside the helper ranges HA enforces', () => {
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

test('settings: steppers clamp to the table and snap to the step; a toggle flips only its helper', () => {
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

test('settings: every row writes only its own table helper; unknown and prototype keys, and a kind mismatch, throw', () => {
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

test('settings: a tap on a settings control writes nothing outside the table even if the element names another entity', () => {
  const calls = [];
  const h = { ...sheetHass(), callService: (...a) => calls.push(a) };
  P.handleAction(h, { dataset: { act: 'setting-toggle', room: 'bathroom', group: 'fan', key: 'automation', entity: 'light.bathroom_light_ceiling' } });
  assert.equal(calls[0][2].entity_id, 'input_boolean.bathroom_automation_fan_enabled');
});

test('settings: rows with a missing or unusable helper are hidden and an empty list is not shown', () => {
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

test('settings: every row names a helper that exists in packages/helpers.yaml, with no exceptions', () => {
  const missing = settingRows().filter(({ row }) => !helperIds.has(row.id)).map(({ room, group, row }) => `${room}/${group}/${row.key}`);
  assert.deepEqual(missing, []);
  for (const { row } of settingRows()) assert.match(row.id, row.kind === 'toggle' ? /^input_boolean\.\w+$/ : /^input_number\.\w+$/);
});

test('settings: the room page no longer renders Automations, the fan steppers, or Follow calendar', () => {
  assert.throws(() => P.render('automations', { room: 'bedroom' }, mk(), NOW), /unknown mode/);
  const tpl = loadYaml('info_templates.yaml');
  for (const t of ['pulse_room', 'pulse_garden']) assert.ok(!tpl[t].card.cards.some((c) => c.mode === 'automations'), t);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /FAN_NUMBERS|fan-number|sectionAutomations/);
  for (const k of P.ALL_ROOM_KEYS) {
    // Presence carries the (closed) Automation row, whose panel holds the switches: checked on its own below.
    const page = ['room-head', ...(GARDENS.includes(k) ? GARDEN_MODES : INDOOR_MODES.filter((m) => m !== 'presence')), 'room-feed'].map((m) => P.render(m, { room: k }, sheetHass(), NOW)).join('');
    assert.doesNotMatch(page, /Automations<|Lights automation|Heating automation|Fan automation|Follow calendar|data-act="setting-/, k);
  }
});

test('settings: the streamline defaults still live in `default` and the template substitution leaves no placeholder', () => {
  const tpl = loadYaml('info_templates.yaml');
  for (const [name, t] of Object.entries(tpl)) {
    assert.equal(t.variables, undefined, name);
    const vars = streamlineVars(t, { room: 'bathroom' });
    assert.doesNotMatch(JSON.stringify(substitute(t.card, vars)), /\[\[[^\]]*\]\]/, name);
  }
  assert.ok(Array.isArray(tpl.pulse_room.default) && Array.isArray(tpl.pulse_garden.default));
});

test('Mo toggles: two switches on the Settings page that write only their own helpers', () => {
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
