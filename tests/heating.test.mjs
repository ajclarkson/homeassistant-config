// Pulse card tests: heating. Run: cd tests && npm test (or node --test heating.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Raw, P, root, NOW, whyAll, mk, withRooms, NOISE, loadYaml, rect, quietRoom, tomorrow, day, rule, tile, footnote, b, over, long } from './helpers.mjs';

// The same without the Room/Target numbers, which word the target on their own ("Minimum from safety").
const whyRows = (config, hass, now) => whyAll(config, hass, now).replace(/<div class="two">.*?<\/div><\/div><\/div>(?=<div class="card">)/s, '');

// ── Heating mode grid ──
const HEAT_ROOMS = P.ROOM_TABLE.filter((r) => r.climate).map((r) => r.key);

const heatHass = (report, extra = {}) => withRooms([quietRoom('parlour', { target: 18, mode_target: 18, mode_name: 'baseline day', heating_active: 'baseline_day', heating_source: 'schedule', ...report })], [], {
  'input_select.parlour_heating_manual_mode': { state: 'auto', attributes: {} },
  'input_number.global_temperature_comfort': { state: '20', attributes: {} },
  'input_number.global_temperature_baseline_day': { state: '18', attributes: {} },
  'input_number.global_temperature_baseline_night': { state: '16.5', attributes: {} },
  'input_number.global_temperature_minimum': { state: '5', attributes: {} },
  'sensor.house_active_mode': { state: 'normal', attributes: {} },
  ...extra,
});

const heatGrid = (report, extra) => P.render('heating', { room: 'parlour' }, heatHass(report, extra), NOW);

// ── Heating day plan ──
const PLANS = JSON.parse(readFileSync(new URL('./fixtures/heating-plans.json', import.meta.url), 'utf8'));

const planSensor = (c) => ({ 'sensor.parlour_heating_plan': { state: c.state, attributes: { blocks: PLANS.weekday, ...c.attributes } } });

const planAt = (name, report = { temp: 18.4 }, over = {}) => {
  const c = { ...PLANS.cases[name], ...over };
  return { now: Date.parse(c.now), hass: heatHass(report, planSensor(c)), c };
};

const planHtml = (name, ui, report, over) => { const { now, hass } = planAt(name, report, over); return P.render('heating', { room: 'parlour' }, hass, now, ui); };

const countOf = (html, re) => (html.match(re) || []).length;

const sane = (html) => assert.doesNotMatch(html, /NaN|undefined|Infinity|\[object/);

const epoch = (iso) => Date.parse(iso) / 1000;

const DAY0 = '2026-10-25T';

const histFixture = () => ({
  'sensor.parlour_sensor_climate_temperature': [
    { s: '17.0', lu: epoch(`${DAY0}00:00:00Z`) }, { s: '17.2', lu: epoch(`${DAY0}02:00:00Z`) }, { s: '17.4', lu: epoch(`${DAY0}02:01:00Z`) },
    { s: 'unavailable', lu: epoch(`${DAY0}02:05:00Z`) }, { s: '99', lu: epoch(`${DAY0}02:10:00Z`) }, { s: '18.1', lu: epoch(`${DAY0}04:20:00Z`) }, { s: '18.4', lu: epoch(`${DAY0}07:00:00Z`) },
  ],
  'climate.parlour_trv': [
    { s: 'heat', a: { hvac_action: 'idle' }, lu: epoch(`${DAY0}00:00:00Z`) }, { s: 'heat', a: { hvac_action: 'heating' }, lu: epoch(`${DAY0}01:00:00Z`) },
    { s: 'heat', a: { hvac_action: 'idle' }, lu: epoch(`${DAY0}02:00:00Z`) }, { s: 'heat', a: { hvac_action: 'heating' }, lu: epoch(`${DAY0}06:00:00Z`) },
  ],
});

const PARLOUR = P.ROOMS.parlour;

const heatData = (nowIso = `${DAY0}10:00:00Z`) => ({ day: '2026-10-25', ...P.parseHeatHistory(histFixture(), PARLOUR, Date.parse(`${DAY0}00:00:00Z`), Date.parse(nowIso)) });

test('room heating card does not say whether the room is heating right now as a row; unknown action says nothing', () => {
  const head = (over) => P.render('heating', { room: 'parlour' }, withRooms([quietRoom('parlour', { target: 20, mode_target: 20, mode_name: 'comfort', heating_active: 'comfort', heating_source: 'schedule', ...over })], []), NOW);
  const on = head({ hvac_action: 'heating' });
  // The grid replaces the mode-and-source row. Heating-now is the widget's sub line only.
  assert.doesNotMatch(on, /Comfort, from schedule/);
  assert.doesNotMatch(on, /Right now|Heating now|class="hm-rt">Target</);
  for (const a of ['heating', 'idle', 'off', null]) assert.doesNotMatch(head({ hvac_action: a }), /Right now|Heating now|Not heating|Heating off/);
});

test('every room with a climate entity has its mode helper, and only those', () => {
  assert.deepEqual(HEAT_ROOMS, ['parlour', 'kitchen', 'hallway_downstairs', 'bedroom', 'bathroom', 'home_office', 'foreign_office']);
  for (const k of HEAT_ROOMS) assert.equal(P.ROOMS[k].heatMode, `input_select.${k}_heating_manual_mode`);
  for (const r of P.ROOM_TABLE.filter((x) => !x.climate)) assert.equal(r.heatMode, undefined, r.key);
  const helpers = loadYaml('packages/helpers.yaml').input_select;
  for (const k of HEAT_ROOMS) assert.deepEqual(helpers[`${k}_heating_manual_mode`].options, ['auto', 'comfort', 'baseline_day', 'baseline_night', 'minimum'], k);
  assert.deepEqual(P.HEATING_MODES.map((m) => m.option), helpers.parlour_heating_manual_mode.options, 'segments follow the helper options');
});

test('heating control: one row of five segments, no temperatures, a short Min with the full word as its name', () => {
  const out = heatGrid({});
  assert.equal((out.match(/<div class="segs five"/g) || []).length, 1);
  assert.deepEqual([...out.matchAll(/data-option="(\w+)" aria-pressed="\w+" aria-label="(\w+)">(\w+)<\/button>/g)].map((m) => [m[1], m[2], m[3]]),
    [['auto', 'Auto', 'Auto'], ['comfort', 'Comfort', 'Comfort'], ['baseline_day', 'Day', 'Day'], ['baseline_night', 'Night', 'Night'], ['minimum', 'Minimum', 'Min']]);
  assert.doesNotMatch(out, /disabled/);
  assert.doesNotMatch(tile(out, 'comfort'), /\d°/, 'temperatures live in the card, not the segments');
  assert.equal(footnote(out), 'Follows the schedule');
  assert.doesNotMatch(out, /Day, from schedule|Status|hm-scene/, 'rows the control repeats are gone');
  assert.doesNotMatch(out, /Humidity|% humidity/, 'humidity is a line under the plan temperature, not a row');
});

test('heating control: the selected segment is the helper state, and the footnote names a manual mode', () => {
  for (const o of ['auto', 'comfort', 'baseline_day', 'baseline_night', 'minimum']) {
    const out = heatGrid({ heating_source: 'manual' }, { 'input_select.parlour_heating_manual_mode': { state: o, attributes: {} } });
    const on = [...out.matchAll(/class="seg( on)?" data-act="heating-mode"[^>]*data-option="(\w+)"/g)].filter((m) => m[1]).map((m) => m[2]);
    assert.deepEqual(on, [o]);
    assert.match(tile(out, o), /aria-pressed="true"/);
  }
  const manual = heatGrid({ heating_source: 'manual' }, { 'input_select.parlour_heating_manual_mode': { state: 'comfort', attributes: {} } });
  assert.equal(footnote(manual), 'Comfort 20.0° until the schedule next changes', 'no plan, so no end time');
});

test('heating control: stages 1 to 3 disable every segment and the footnote says why', () => {
  const cases = [
    [{ heating_enabled: false }, {}, /^Heating automation is off for this room/],
    [{ heating_source: 'safety', heat_labels: ['Window open'] }, {}, /^A window or door is open, so the room is held at minimum/],
    [{ heating_source: 'safety', house_heating_off: true }, { 'input_boolean.house_heating_enabled': { state: 'off', attributes: {} } }, /^House heating is off/],
    [{ heating_source: 'house_mode' }, { 'sensor.house_active_mode': { state: 'away', attributes: {} } }, /^The house is away, so heating follows the house/],
    [{ heating_source: 'house_mode' }, { 'sensor.house_active_mode': { state: 'sleep', attributes: {} } }, /^The house is asleep/],
    [{ heating_source: 'house_mode_vacation' }, { 'sensor.house_active_mode': { state: 'vacation', attributes: {} } }, /^The house is on holiday/],
    [{ heating_source: 'house_mode' }, { 'sensor.house_active_mode': { state: 'unknown', attributes: {} } }, /^Heating follows the house mode/],
    [{}, { 'input_select.parlour_heating_manual_mode': { state: 'unavailable', attributes: {} } }, /^The mode helper is unavailable/],
  ];
  for (const [report, extra, want] of cases) {
    const out = heatGrid(report, extra);
    assert.equal((out.match(/data-act="heating-mode"[^>]*disabled/g) || []).length, 5, JSON.stringify(report));
    assert.match(footnote(out), want);
    assert.doesNotMatch(out, /Follows the schedule/);
  }
  assert.equal((heatGrid({ heat_labels: ['Window open'] }).match(/ disabled/g) || []).length, 0, 'a window still inside its grace period does not disable the control');
  assert.match(heatGrid({ heating_enabled: false }), /aria-pressed="true"/, 'the selection still shows while disabled');
});

test('heating control: rooms without the helper show none; sparse reports do not throw', () => {
  assert.equal(P.render('heating', { room: 'hallway_upstairs' }, heatHass({}), NOW), '');
  const sparse = P.render('heating', { room: 'parlour' }, withRooms([{ k: 'parlour' }], []), NOW);
  assert.match(sparse, /^<div class="p">|^$/);
  assert.doesNotMatch(sparse, NOISE);
});

test('heating mode tap writes the helper, and a disabled mode neither writes nor throws silently', () => {
  const calls = [];
  const hass = { ...heatHass({}), callService: (d, s, data) => { calls.push([d, s, data]); return Promise.resolve(); } };
  const el = (option, room = 'parlour') => ({ dataset: { act: 'heating-mode', room, option } });
  for (const o of ['auto', 'comfort', 'baseline_day', 'baseline_night', 'minimum']) P.handleAction(hass, el(o));
  assert.deepEqual(calls.map((c) => c[2].option), ['auto', 'comfort', 'baseline_day', 'baseline_night', 'minimum']);
  assert.ok(calls.every((c) => c[0] === 'input_select' && c[1] === 'select_option' && c[2].entity_id === 'input_select.parlour_heating_manual_mode'));
  assert.throws(() => P.handleAction(hass, el('turbo')), /unknown heating mode/);
  assert.throws(() => P.handleAction(hass, el('auto', 'hallway_upstairs')), /no heating mode helper/);
  assert.throws(() => P.handleAction(hass, el('auto', 'toString')), /no heating mode helper/);
  const locked = { ...heatHass({ heating_enabled: false }), callService: () => assert.fail('must not be called') };
  assert.throws(() => P.handleAction(locked, el('comfort')), /locked/);
  assert.equal(P.ACT_HAPTIC['heating-mode'], 'segmented');
  assert.equal(P.HAPTICS[P.ACT_HAPTIC['heating-mode']], 'selection');
});

test('heating holds read as heating, not occupancy: banner, heating row and occupied row', () => {
  const bed = quietRoom('bedroom', { occupied: true, lights_on: 2, target: 5, mode_target: 5, mode_name: 'minimum', heating_active: 'minimum', heating_source: 'safety', hvac_action: 'idle', pres_labels: ['Bed occupied'], heat_labels: ['Window open'], labels: ['Bed occupied', 'Window open'], verdict: 'Occupied · lights on · held occupied by Bed occupied · heating suspended: window open' });
  const hass = withRooms([bed], []);
  const why = whyRows({ room: 'bedroom' }, hass, NOW);
  assert.match(why, /Held at minimum 5\.0° · window open/);
  assert.doesNotMatch(why, /from safety/);
  assert.match(why, /Status<\/div><\/div><span class="hm-val num">Suspended</);
  assert.match(why, /<div class="hm-rs">Empty a few minutes after the bed clears<\/div>/);
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
  assert.match(calm, /Occupied · lights on · 20\.8°</);
  assert.doesNotMatch(calm, /Occupied \(|All good/);
});

test('day plan: every source reads, and the contract is checked', () => {
  for (const name of ['schedule', 'schedule_wrap', 'safety', 'house_mode', 'manual', 'manual_over_day']) {
    const { now, hass } = planAt(name);
    const v = P.dayPlan(hass, 'parlour', now);
    assert.equal(v.ok, true, name);
    assert.equal(v.plan.active.mode, PLANS.cases[name].state, name);
    assert.deepEqual(v.temps, { comfort: 20, baseline_day: 18, baseline_night: 16.5, minimum: 5 });
  }
  const eff = (name) => { const { now, hass } = planAt(name); return P.dayPlan(hass, 'parlour', now).eff; };
  assert.equal(eff('schedule'), null, 'the schedule is the plan, not an override');
  assert.deepEqual([eff('safety').mode, eff('safety').to, eff('safety').byHand], ['minimum', 1440, false], 'no end: held to the end of the strip');
  assert.deepEqual([eff('house_mode').mode, eff('house_mode').to], ['baseline_night', 1440]);
  assert.deepEqual([eff('manual').mode, eff('manual').from, eff('manual').to, eff('manual').byHand], ['comfort', 17 * 60, 19 * 60, true]);
  // The override runs past a midnight: clamped to the strip.
  const { hass } = planAt('manual');
  const next = { ...hass, states: { ...hass.states, 'sensor.parlour_heating_plan': { state: 'comfort', attributes: { ...hass.states['sensor.parlour_heating_plan'].attributes, override: { mode: 'comfort', until: '2026-10-26T01:00:00Z' } } } } };
  assert.equal(P.dayPlan(next, 'parlour', Date.parse(PLANS.cases.manual.now)).eff.to, 1440);
});

test('day plan: a missing, unavailable, stale or broken plan is named, never drawn', () => {
  const why = (hass, now) => P.dayPlan(hass, 'parlour', now).why;
  const { now, hass } = planAt('stale');
  assert.equal(why(hass, now), 'stale');
  assert.equal(why(heatHass({}), now), 'missing', 'no sensor');
  assert.equal(why(heatHass({}, { 'sensor.parlour_heating_plan': { state: 'unavailable', attributes: {} } }), now), 'missing');
  assert.equal(why(heatHass({}, { 'sensor.parlour_heating_plan': { state: 'unknown', attributes: {} } }), now), 'missing');
  const ok1 = planAt('schedule');
  const broken = (patch) => heatHass({}, { 'sensor.parlour_heating_plan': { state: 'comfort', attributes: { ...ok1.hass.states['sensor.parlour_heating_plan'].attributes, ...patch } } });
  for (const patch of [
    { date: '25/10/2026' }, { date: undefined }, { blocks: [] }, { blocks: 'nope' }, { blocks: [{ start: '6:00', end: '16:15', mode: 'comfort' }] },
    { blocks: [{ start: '06:00', end: '24:00', mode: 'comfort' }] }, { blocks: [{ start: '06:00', end: '16:15', mode: 'turbo' }] }, { blocks: [{ start: '06:00', end: '16:15', mode: 'auto' }] },
    { blocks: [...PLANS.weekday, 'x'] }, { active: null }, { active: { mode: 'comfort', source: '', until: null } }, { active: { mode: 'comfort', source: 'schedule', until: 'soon' } },
    { override: 'yes' }, { override: { mode: 'comfort', until: null } }, { override: { mode: 'turbo', until: '2026-10-25T19:00:00Z' } },
  ]) assert.equal(why(broken(patch), ok1.now), 'invalid', JSON.stringify(patch));
  // A global that is unavailable cannot be drawn.
  assert.equal(why(heatHass({}, { ...planSensor(ok1.c), 'input_number.global_temperature_comfort': { state: 'unavailable', attributes: {} } }), ok1.now), 'invalid');
  assert.equal(P.dayPlan(heatHass({}), now, now).ok, false);
  assert.throws(() => P.zonedClock(NaN), /needs a time/);
  // The blocks can arrive as a JSON string.
  assert.equal(P.dayPlan(broken({ blocks: JSON.stringify(PLANS.weekday) }), 'parlour', ok1.now).ok, true);
});

test('day plan: a block that wraps midnight is two segments', () => {
  const { now, hass } = planAt('schedule_wrap');
  const v = P.dayPlan(hass, 'parlour', now);
  assert.deepEqual(v.segs.map((s) => [s.mode, s.from, s.to]), [['baseline_night', 0, 360], ['baseline_day', 360, 975], ['comfort', 975, 1320], ['baseline_night', 1320, 1440]]);
  const html = planHtml('schedule_wrap');
  sane(html);
  assert.equal(countOf(html, /opacity="0\.22"/g), 2, 'night is drawn at both ends');
  assert.match(html, /<rect x="0\.0"[^>]*width="81\.5"/, 'the morning end starts at the left edge');
  assert.deepEqual(P.planSegments([{ from: 1320, to: 0, mode: 'minimum' }]).map((s) => [s.from, s.to]), [[1320, 1440]], 'ending exactly at midnight leaves no sliver');
});

test('day plan: the schedule draws areas by warmth, the target step line, the dimmed future and the now marker', () => {
  const html = planHtml('schedule', { heatData: heatData() });
  sane(html);
  assert.match(html, /<svg class="plan" viewBox="0 0 326 134"[^>]*role="img" aria-label="Today(?:'|&#39;)s heating plan\. Now Day 18\.0 degrees until 16:15\./);
  const ops = [...html.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#ebbcba" opacity="([\d.]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ops, ['0.22', '0.42', '0.75', '0.22'], 'night, day, comfort, night in time order');
  assert.equal(countOf(html, /class="plan-future"/g), 1);
  const future = html.match(/class="plan-future" x="([\d.]+)"/)[1];
  assert.equal(Number(future), Number((10 * 60 / 1440 * 326).toFixed(1)), 'the future starts at now');
  assert.match(html, /<path d="M0\.0 [\d.]+H81\.5V[\d.]+H220\.7V[\d.]+H298\.8V[\d.]+H326\.0" fill="none" stroke="#ebbcba" stroke-width="2"\/>/, 'one step line across the day');
  assert.doesNotMatch(html, /plan-override|plan-replaced/);
  assert.match(html, /<text[^>]*>now<\/text>/);
  for (const h of ['00', '06', '12', '18']) assert.match(html, new RegExp(`>${h}</text>`));
  assert.match(html, /class="plan-dot"/);
  assert.match(html, /class="plan-room"/);
  assert.equal(countOf(html, /class="plan-heat"/g), 2, 'a heating bar per span');
});

test('day plan: hour labels that would touch the now label are hidden', () => {
  const x = (min) => min / 1440 * 326;
  assert.deepEqual(P.planHours(x(970)), [0, 6, 12], '16:10: 18 sits beside now');
  assert.deepEqual(P.planHours(x(600)), [0, 6, 12, 18]);
  assert.deepEqual(P.planHours(x(10)), [6, 12, 18], 'just after midnight: 00 is covered');
  assert.deepEqual(P.planHours(x(375)), [0, 12, 18], '06:15: 06 is covered');
  const html = planHtml('schedule', { heatData: heatData() });
  assert.equal(countOf(html, /<text[^>]*>now<\/text>/g), 1);
});

test('day plan: the heating bar bridges gaps under 10 min, then drops spans under 5 min', () => {
  assert.deepEqual(P.tidyHeatSpans([[60, 70], [78, 90]]), [[60, 90]], 'an 8 min gap is bridged');
  assert.deepEqual(P.tidyHeatSpans([[60, 70], [80, 90]]), [[60, 70], [80, 90]], 'a 10 min gap is not');
  assert.deepEqual(P.tidyHeatSpans([[60, 63], [200, 210]]), [[200, 210]], 'a 3 min blip goes');
  assert.deepEqual(P.tidyHeatSpans([[60, 63], [66, 69]]), [[60, 69]], 'blips that merge into 9 min stay');
  assert.deepEqual(P.tidyHeatSpans([[60, 65]]), [[60, 65]], 'exactly 5 min stays');
  assert.deepEqual(P.tidyHeatSpans([[200, 210], [60, 90], [-5, 0], [50, 50], [1430, 1500]]), [[60, 90], [200, 210], [1430, 1440]], 'unsorted, empty and out-of-day spans are cleaned');
  assert.deepEqual(P.tidyHeatSpans([]), []);
  assert.throws(() => P.tidyHeatSpans(null), /list of spans/);
});

test('day plan: the card says what the room is doing and the next blocks trail their temperature', () => {
  const html = planHtml('schedule', { heatData: heatData() });
  assert.match(html, /plan-big[^>]*>18\.4°</);
  assert.match(html, />Day · 18\.0°</);
  assert.match(html, />until 16:15 · radiator idle</);
  const rows = [...html.matchAll(/class="hm-rt">([^<]*)<\/div><div class="hm-rs">([^<]*)<\/div><\/div><span class="hm-val num">([^<]*)</g)].map((m) => m.slice(1));
  assert.deepEqual(rows, [['Next: Comfort', 'From 16:15', '20.0°'], ['Then: Night', 'From 22:00', '16.5°']]);
  assert.match(planHtml('schedule', undefined, { temp: 18.4, hvac_action: 'heating' }), />until 16:15 · radiator heating</);
  // Late in the evening only one block is left, and with none left the rows go.
  assert.equal(countOf(planHtml('schedule_wrap'), /class="hm-rs">From/g), 0);
});

test('day plan: an override is drawn in the tint over its span with the replaced plan dashed', () => {
  const html = planHtml('manual', { heatData: heatData(`${DAY0}17:00:00Z`) });
  sane(html);
  const x = (min) => (min / 1440 * 326).toFixed(1);
  assert.match(html, new RegExp(`<path class="plan-override" d="M${x(1020)} [\\d.]+H${x(1140)}" fill="none" stroke="#c4a7e7" stroke-width="2"/>`));
  assert.match(html, /class="plan-replaced"[^>]*stroke-dasharray="3 3"/);
  assert.equal(countOf(html, /fill="#c4a7e7" opacity="0\.4"/g), 1, 'the override area');
  // The comfort area stops where the override starts and the plan resumes after it.
  const comfort = [...html.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="#ebbcba" opacity="0\.75"/g)].map((m) => [m[1], Math.round(Number(m[1]) + Number(m[2]))]);
  assert.deepEqual(comfort, [[x(975), x(1020)], [x(1140), x(1320)]].map(([a, b]) => [a, Math.round(Number(b))]));
  assert.match(html, />by hand until 19:00 · radiator idle</);
  assert.match(html, new RegExp(`class="plan-mode-t num" style="color:#c4a7e7"`));
  const rows = [...html.matchAll(/class="hm-rs">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(rows.slice(0, 2), ['From 19:00 · schedule resumes', 'From 22:00']);
  assert.deepEqual([...html.matchAll(/class="hm-rt">([^<]*)</g)].map((m) => m[1]).slice(0, 2), ['Next: Comfort', 'Then: Night'], 'the end of an override leads with Next too');
  const { now, hass } = planAt('manual');
  const chosen = P.render('heating', { room: 'parlour' }, { ...hass, states: { ...hass.states, 'input_select.parlour_heating_manual_mode': { state: 'comfort', attributes: {} } } }, now);
  assert.equal(footnote(chosen), 'Comfort 20.0° until 19:00, then back to the schedule');
});

test('day plan: safety and house mode draw what the controller chose; the footnote keeps its reason', () => {
  const safety = planHtml('safety', undefined, { temp: 18, heating_source: 'safety', heat_labels: ['Window open'] });
  assert.match(safety, /class="plan-override"/);
  assert.match(safety, />held for now · radiator idle</);
  assert.match(footnote(safety), /^A window or door is open/);
  const house = planHtml('house_mode', undefined, { temp: 18, heating_source: 'house_mode' }, {});
  assert.match(house, /class="plan-override"/);
  assert.equal(footnote(planHtml('schedule')), 'Follows the schedule', 'Auto holds nothing, so no end time');
});

test('day plan: the control sits inside the card under the chart and above the next-block rows', () => {
  const html = planHtml('schedule');
  const at = (re) => html.search(re);
  assert.ok(at(/<svg class="plan"/) < at(/class="segs five"/) && at(/class="segs five"/) < at(/class="hm-rs">From/));
  assert.ok(at(/class="segs five"/) < at(/<\/div><p class="hm-foot"|<div class="hm-feet">/), 'the footnote is outside the card');
  assert.doesNotMatch(html, /Comfort 20\.0°<\/text>/, 'no label drawn on the chart');
  assert.doesNotMatch(html, /<text[^>]*font-size="11"/);
});

test('day plan: a stale or missing plan falls back to the mode control in a card with a footnote', () => {
  const stale = planHtml('stale');
  assert.doesNotMatch(stale, /<svg class="plan"|plan-card/);
  assert.match(stale, /<div class="hm-card"><div class="segs five"/);
  assert.equal(countOf(stale, /data-act="heating-mode"/g), 5);
  assert.deepEqual([...stale.matchAll(/<p class="hm-foot">([^<]*)<\/p>/g)].map((m) => m[1]), ['Follows the schedule', 'The heating plan is not for today, so the day is not drawn']);
  const none = P.render('heating', { room: 'parlour' }, heatHass({}), NOW);
  assert.match(none, /There is no heating plan to show yet/);
  assert.equal(countOf(none, /data-act="heating-mode"/g), 5);
  // Never a note in place of the grid's own reason.
  const locked = P.render('heating', { room: 'parlour' }, heatHass({ heating_enabled: false }), NOW);
  assert.match(footnote(locked), /^Heating automation is off/);
});

test('day plan: no history draws the plan without the line, bar or heated row; yesterday\'s history is ignored', () => {
  for (const ui of [undefined, {}, { heatData: null }, { heatData: { day: '2026-10-24', temps: [{ min: 60, v: 17 }, { min: 120, v: 18 }], spans: [[0, 60]] } }, { heatData: { day: '2026-10-25', temps: [], spans: null } }]) {
    const html = planHtml('schedule', ui);
    sane(html);
    assert.match(html, /<svg class="plan"/);
    assert.doesNotMatch(html, /plan-room|plan-heat|Heated today|radiator on/, JSON.stringify(ui));
    assert.equal(footnote(html), 'Follows the schedule', 'no history, no suffix');
    assert.match(html, /class="plan-dot"/, 'the live reading still marks now');
  }
  assert.doesNotMatch(planHtml('schedule', undefined, { temp: null }), /plan-dot|plan-room/, 'no reading, no dot');
  const heated = planHtml('schedule', { heatData: heatData() });
  assert.equal(footnote(heated), 'Follows the schedule · radiator on 5 h today', 'one hour, then 06:00 to now');
  assert.doesNotMatch(heated, /Heated today/, 'no row of its own');
  const long = { heatData: { ...heatData(), spans: [[0, 100], [200, 232]] } };
  assert.equal(footnote(planHtml('schedule', long)), 'Follows the schedule · radiator on 2 h 12 min today');
  assert.equal(footnote(planHtml('schedule', { heatData: { ...heatData(), spans: [[0, 45]] } })), 'Follows the schedule · radiator on 45 min today');
  // Every footnote variant takes the suffix: a manual mode and a locked control too.
  assert.match(footnote(planHtml('manual', { heatData: heatData() })), / · radiator on 5 h today$/);
  assert.match(footnote(P.render('heating', { room: 'parlour' }, planAt('schedule', { heating_enabled: false }).hass, planAt('schedule').now, { heatData: heatData() })), /^Heating automation is off.* · radiator on 5 h today$/);
});

test('day plan: humidity is a small line under the room temperature, only with a reading, and the bathroom keeps it for the fan', () => {
  const line = (report, room = 'parlour') => (P.render('heating', { room }, planAt('schedule', report).hass, planAt('schedule').now, undefined).match(/<span class="plan-hum">([^<]*)<\/span>/) || [])[1];
  assert.equal(line({ humidity: 59 }), '59% humidity');
  assert.equal(line({ humidity: 58.6 }), '59% humidity', 'rounded');
  assert.equal(line({ humidity: null }), undefined, 'no reading, no line');
  assert.match(planHtml('schedule', undefined, { humidity: 59 }), /<span class="plan-temp"><span class="num plan-big">[^<]*<\/span><span class="plan-hum">59% humidity<\/span><\/span>/);
  assert.match(rule('.plan-hum').body, /color:#908caa/, 'secondary text token');
  assert.doesNotMatch(planHtml('schedule', undefined, { humidity: 59 }), /<div class="hm-rt">Humidity/, 'no row either');
  // The bathroom: humidity drives the fan, so it is a row of the Fan section and not in the Heating card.
  const cfg = { room: 'bathroom', entity: 'switch.bathroom_fan_extractor', decision: 'sensor.bathroom_fan_decision', label: 'Extractor fan' };
  const bath = (hum) => withRooms([quietRoom('bathroom', { humidity: hum })], [], { 'switch.bathroom_fan_extractor': b('off'), 'sensor.bathroom_fan_decision': { state: 'no_action', attributes: { reason: 'fan_idle' } } });
  assert.match(P.render('device', cfg, bath(72), NOW), /<div class="hm-rt">Humidity<\/div><\/div><span class="hm-val num">72%<\/span>/);
  assert.doesNotMatch(P.render('device', cfg, bath(null), NOW), /Humidity/);
  assert.doesNotMatch(P.render('device', { ...cfg, room: 'parlour' }, bath(72), NOW), /Humidity/, 'only the bathroom shows it there');
  assert.throws(() => P.render('device', { ...cfg, room: 'nowhere' }, bath(72), NOW), /known room/);
  assert.equal(P.ROOMS.bathroom.humidityInFan, true);
  assert.equal(P.ROOM_TABLE.filter((r) => r.humidityInFan).length, 1);
  const { now, c } = planAt('schedule');
  const bh = withRooms([quietRoom('bathroom', { humidity: 72, temp: 21 })], [], {
    'sensor.bathroom_heating_plan': planSensor(c)['sensor.parlour_heating_plan'], 'input_select.bathroom_heating_manual_mode': b('auto'),
    ...Object.fromEntries(Object.entries(heatHass({}).states).filter(([k]) => /global_temperature|house_active_mode/.test(k))),
  });
  const bathHeat = P.render('heating', { room: 'bathroom' }, bh, now, undefined);
  assert.match(bathHeat, /class="num plan-big"/, 'the plan card is drawn');
  assert.doesNotMatch(bathHeat, /humidity/i, 'the bathroom\'s humidity is not in the Heating card');
});

test('day plan: hostile numbers cannot leave the picture', () => {
  const ui = { heatData: { day: '2026-10-25', temps: [{ min: 30, v: 17 }, { min: 9999, v: 1e9 }, { min: -5, v: -1e9 }, { min: 200, v: 18 }], spans: [[-100, 50], [1400, 99999], [30, 10]] } };
  const html = planHtml('schedule', ui, { temp: 999 });
  sane(html);
  for (const m of html.matchAll(/\sy="(-?[\d.]+)"|cy="(-?[\d.]+)"/g)) assert.ok(Number(m[1] || m[2]) >= 0 && Number(m[1] || m[2]) <= 134, m[0]);
  for (const m of html.matchAll(/\sx="(-?[\d.]+)"|cx="(-?[\d.]+)"/g)) assert.ok(Number(m[1] || m[2]) >= 0 && Number(m[1] || m[2]) <= 326, m[0]);
});

test('day plan: draws with the theme\'s own tokens', () => {
  const { now, hass } = planAt('manual');
  const rp = Raw.render('heating', { room: 'parlour' }, hass, now, { heatData: heatData(`${DAY0}17:00:00Z`) });
  for (const k of ['heat', 'tint', 'text', 'surface', 'textSecondary']) assert.ok(Raw.resolveVars(rp, 'rose-pine').includes(Raw.THEMES['rose-pine'][k]), k);
  assert.doesNotMatch(rp.replace(/var\(--pulse-\w+\)/g, ''), /#[0-9a-f]{6}\b(?!.*<\/svg>)/i, 'colour literals appear only inside the picture');
});

test('heating history: rows parse in either wire form, bad rows drop, spans clip to the day', () => {
  const midnight = Date.parse(`${DAY0}00:00:00Z`);
  const now = Date.parse(`${DAY0}10:00:00Z`);
  const h = P.parseHeatHistory(histFixture(), PARLOUR, midnight, now);
  // 02:00 and 02:01 share a five-minute bucket (the later wins); unavailable and 99 are dropped.
  assert.deepEqual(h.temps.map((p) => [p.min, p.v]), [[0, 17], [121, 17.4], [260, 18.1], [420, 18.4]]);
  assert.deepEqual(h.spans, [[60, 120], [360, 600]], 'the last span runs to now');
  assert.equal(P.parseHeatHistory({ ...histFixture(), 'climate.parlour_trv': [] }, PARLOUR, midnight, now).spans, null, 'no climate rows, no heated row');
  const full = { 'sensor.parlour_sensor_climate_temperature': [{ state: '19', last_updated: `${DAY0}03:00:00+00:00` }], 'climate.parlour_trv': [{ state: 'heat', attributes: { hvac_action: 'heating' }, last_changed: `${DAY0}03:00:00Z` }, { state: 'unavailable', last_changed: `${DAY0}04:00:00Z` }] };
  const f = P.parseHeatHistory(full, PARLOUR, midnight, now);
  assert.deepEqual([f.temps, f.spans], [[{ min: 180, v: 19 }], [[180, 240]]], 'the long form reads too, and unavailable ends a span');
  const before = P.parseHeatHistory({ 'sensor.parlour_sensor_climate_temperature': [{ s: '15', lu: epoch('2026-10-24T22:00:00Z') }], 'climate.parlour_trv': [{ s: 'heat', a: { hvac_action: 'heating' }, lu: epoch('2026-10-24T22:00:00Z') }] }, PARLOUR, midnight, now);
  assert.deepEqual([before.temps[0].min, before.spans[0]], [0, [0, 600]], 'the carried-in start state clips to midnight');
  assert.deepEqual(P.parseHeatHistory({}, PARLOUR, midnight, now), { temps: [], spans: null });
  assert.deepEqual(P.parseHeatHistory({ 'sensor.parlour_sensor_climate_temperature': ['x', null, { s: '18' }] }, PARLOUR, midnight, now).temps, []);
  assert.throws(() => P.parseHeatHistory(null, PARLOUR, midnight, now), /not an object/);
  const req = P.heatRequest(PARLOUR, midnight, now);
  assert.deepEqual([req.type, req.entity_ids, req.start_time, req.end_time, req.significant_changes_only, req.minimal_response], ['history/history_during_period', ['sensor.parlour_sensor_climate_temperature', 'climate.parlour_trv'], `${DAY0}00:00:00.000Z`, `${DAY0}10:00:00.000Z`, false, false]);
});

test('heating history loader: on load, then at most every five minutes, never overlapping; stale responses are ignored', async () => {
  const calls = [];
  const pending = [];
  const hass = { config: { time_zone: 'UTC' }, callWS: (req) => { calls.push(req); return new Promise((res, rej) => pending.push({ res, rej })); } };
  const t0 = Date.parse(`${DAY0}10:00:00Z`);
  let changes = 0;
  const L = P.makeHeatLoader();
  const go = (now) => L.ensure(hass, 'parlour', now, () => { changes += 1; });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  go(t0); go(t0 + 1000); go(t0 + 2000);
  assert.equal(calls.length, 1, 'one request in flight, however many hass updates');
  pending[0].res(histFixture());
  await flush();
  assert.equal(changes, 1);
  assert.equal(L.data.day, '2026-10-25');
  go(t0 + P.HEAT_REFRESH_MS - 1);
  assert.equal(calls.length, 1, 'not before five minutes');
  go(t0 + P.HEAT_REFRESH_MS);
  assert.equal(calls.length, 2);
  // Cancelled (the card unmounted): the late answer neither lands nor repaints.
  L.cancel();
  pending[1].res(histFixture());
  await flush();
  assert.equal(changes, 1);
  // A failure keeps what is drawn, retries later, and says so once in the console.
  const warn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    go(t0 + 10 * 60000);
    assert.equal(calls.length, 3);
    pending[2].rej(new Error('boom'));
    await flush();
    assert.equal(L.data.day, '2026-10-25', 'the earlier history stays');
    go(t0 + 10 * 60000 + 1000);
    assert.equal(calls.length, 3, 'no retry before the delay');
    go(t0 + 10 * 60000 + P.HEAT_RETRY_MS);
    assert.equal(calls.length, 4);
  } finally { console.warn = warn; }
  assert.deepEqual(warned.length, 1);
  // A newer day drops yesterday's data and supersedes an old request.
  const tomorrow = Date.parse('2026-10-26T00:05:00Z');
  go(tomorrow);
  assert.equal(L.data, null);
  assert.equal(calls.length, 5);
  pending[3].res(histFixture());
  await flush();
  assert.equal(L.data, null, 'the answer for the old request is ignored');
  assert.equal(calls[4].start_time, '2026-10-26T00:00:00.000Z');
  // Not a heated room, or no websocket: nothing happens.
  const quiet = P.makeHeatLoader();
  quiet.ensure(hass, 'hallway_upstairs', t0, () => {});
  quiet.ensure({}, 'parlour', t0, () => {});
  assert.equal(calls.length, 5);
  // A throwing call is a failure, not a crash.
  const boom = P.makeHeatLoader();
  console.warn = () => {};
  try { boom.ensure({ callWS: () => { throw new Error('sync'); } }, 'parlour', t0, () => {}); await flush(); } finally { console.warn = warn; }
  assert.equal(boom.data, null);
});

test('heating card: history rides on ui without changing the render signature, and the apexcharts block is gone', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(src, /Object\.defineProperty\(this\._ui, 'heatData', \{ get: \(\) => this\._heat\.data, enumerable: false \}\)/);
  assert.match(src, /this\._heat\.cancel\(\)/, 'unmount cancels');
  assert.doesNotMatch(readFileSync(root + 'info_templates.yaml', 'utf8'), /apexcharts|chart-head/);
  assert.throws(() => P.render('chart-head', {}, mk(), NOW));
  // The gate redraws when the revision moves and not otherwise.
  const gate = P.makeRenderGate();
  const { now, hass } = planAt('schedule');
  const cfg = { room: 'parlour' };
  const ui = { heatRev: 0 };
  gate.run('heating', cfg, hass, now, ui, false);
  assert.equal(gate.run('heating', cfg, hass, now + 1000, ui, false).skipped, true);
  ui.heatRev = 1;
  assert.equal(gate.run('heating', cfg, hass, now + 2000, ui, false).skipped, false);
});
