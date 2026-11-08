// Pulse card tests: energy. Run: cd tests && npm test (or node --test energy.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { require, P, root, NOW, mk, NOISE, noNoise, rect, real, hexRgb, lum, cr, mkSlots, count, tomorrow, day, decl, px, rule, tile, b, update, long } from './helpers.mjs';

const energyAt = (rates, now) => P.render('energy-day', {}, mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates } } }), now, {});

const dist = (a, b) => Math.hypot(...hexRgb(a).map((v, i) => v - hexRgb(b)[i]));

const EID = 'sensor.octopus_energy_electricity_24e8140196_1012483035417_previous_accumulative';

const GID = 'sensor.octopus_energy_gas_e6s15257822462_2986733608_previous_accumulative';

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

const histUi = (fuel, e, g, statusE = 'ok', statusG = 'ok') => ({ fuel, hist: { electricity: { status: statusE, days: e || [] }, gas: { status: statusG, days: g || [] } } });

const elecDays = () => P.groupDailyCost(knownRows('ms'), TZ);

// The native rhythm of the Energy page: the same header, group and tile parts as Home and the rooms.
const energyPages = () => {
  const hass = energyHass();
  const ui = { hist: { electricity: { status: 'ok', days: [{ date: '2026-10-22', cost: 3.1 }, { date: '2026-10-23', cost: 3.4 }, { date: '2026-10-24', cost: 2.9 }] } } };
  return { head: P.render('energy-head', {}, hass, NOW, {}), day: P.render('energy-day', {}, hass, NOW, {}), cost: P.render('energy-cost', {}, hass, NOW), history: P.render('energy-history', {}, hass, NOW, ui), usage: P.render('energy-usage', {}, hass, NOW) };
};

test('energy page chart handles missing sensors', () => {
  const html = P.render('energy-day', {}, { states: {} }, NOW, {});
  assert.match(html, /No price data for today/);
  assert.doesNotMatch(html, NOISE);
});

test('cheapest 2h: dated window from the binary sensor (Today / Tomorrow), past hidden, running now, never from the date-less template sensors', () => {
  const cw = (attrs, state = 'off') => ({ 'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': { state, attributes: attrs } });
  // a window on a LATER date reads Tomorrow (the template sensors would have printed 20:00 → 22:00 with no day)
  assert.deepEqual(P.cheapestWindow(mk(), NOW).text, 'Tomorrow 20:00 → 22:00');
  assert.ok(Math.abs(P.cheapestWindow(mk(), NOW).avg - 25.9) < 1e-9);
  const energy = P.render('energy-day', {}, mk(), NOW, {});
  assert.match(energy, /Next cheapest 2 hours<\/div><div class="hm-rs">Tomorrow 20:00 → 22:00<\/div><\/div><span class="hm-val num">avg 25\.9p</);
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
  assert.match(P.render('energy-day', {}, past, late, {}), /Next cheapest 2 hours<\/div><div class="hm-rs">None upcoming/);
  // running now: from current_end, or current_start + duration; state on without an end still says running
  const run = mk(cw({ current_start: '2026-10-25T18:00:00+00:00', current_end: '2026-10-25T20:00:00+00:00' }, 'on'));
  assert.equal(P.cheapestWindow(run, NOW).endText, '20:00');
  assert.match(P.render('status', {}, run, NOW), /Cheapest 2 hours<\/span><span class="num">Now, until 20:00</);
  assert.match(P.render('energy-day', {}, run, NOW, {}), /Next cheapest 2 hours<\/div><div class="hm-rs">Now, until 20:00</, 'running now is said in the sub-line, with no pill');
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

test('energy block is one card with an SVG chart: every slot of the real 50-slot clock-change day is drawn', () => {
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

test('real data at 18:29Z: slots 0-37 past (dimmed, visible), slot 38 now, 39-49 future; negatives sit below the baseline', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  const bars = rect(html);
  const base = Number(html.match(/<line x1="0" x2="300" y1="([\d.]+)"/)[1]);
  assert.deepEqual(bars.slice(0, 38).map((b) => b.op), Array(38).fill(0.45));
  assert.equal(bars[38].fill, '#e0def4');
  assert.equal(bars[38].op, 1);
  assert.deepEqual(bars.slice(39).map((b) => b.op), Array(11).fill(1));
  // 16:00-18:30Z (slots 34-37) are 29-33p: mid band, drawn above the baseline, clearly tall
  for (const i of [34, 35, 36, 37]) { assert.equal(bars[i].fill, P.priceColour(real[i].value_inc_vat * 100)); assert.ok(bars[i].y + bars[i].h <= base + 0.5 && bars[i].h > 30, `slot ${i}`); }
  // overnight slots are negative: green, hanging from the baseline
  const neg = bars.slice(0, 34).filter((b) => Math.abs(b.y - base) < 0.6);
  assert.ok(neg.length >= 20, 'negative slots start at the baseline and extend down');
  assert.ok(real.slice(0, 34).every((r, i) => (r.value_inc_vat <= 0 ? bars[i].fill === '#7dcfff' : bars[i].fill === P.priceColour(r.value_inc_vat * 100))));
  assert.ok(bars.every((b) => b.h >= 1.5));
  const nowX = Number(html.match(/<line x1="([\d.]+)" x2="[\d.]+" y1="0"/)[1]);
  assert.equal(nowX, 38 * 6 + 2.5, 'now marker sits on the current slot');
});

test('hour labels follow real slot start times in the viewer zone (TZ=UTC here)', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  const labels = [...html.matchAll(/left:([\d.]+)%;transform:translateX\(-50%\)">(\d\d)</g)].map((m) => m[2]);
  assert.deepEqual(labels, ['00', '06', '12', '18', '00'].filter(() => true).slice(0, labels.length));
  assert.ok(labels.includes('06') && labels.includes('12') && labels.includes('18'));
});

test('energy chart edge cases: empty, garbage, 48 slots, single slot, all negative, flat', () => {
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

test('priceColour: negative special case, boundaries, never throws', () => {
  const C = P.priceColour;
  for (const bad of [NaN, undefined, null, 'x', '', Infinity, -Infinity, {}, []]) assert.equal(C(bad), '#6e6a86', String(bad));
  assert.equal(C(-7.54), '#7dcfff');
  assert.equal(C(0), '#7dcfff');
  assert.equal(C(-0.01), C(-100));
  for (const v of [0.01, 15, 25, 35, 44.9, 45, 100, -7.54]) assert.match(C(v), /^#[0-9a-f]{6}$/, String(v));
  assert.equal(C(45), C(100));
  assert.equal(C('12'), C(12));
  assert.notEqual(C(45), C(44.9));
});

test('priceColour: negative is clearly distinct from the 0-10p greens; extreme is distinct from 35-44.9p', () => {
  for (const v of [0.01, 2, 5, 10]) assert.ok(dist(P.priceColour(-1), P.priceColour(v)) > 60, `neg vs ${v}`);
  for (let v = 35; v < 45; v += 0.3) assert.ok(dist(P.priceColour(45), P.priceColour(v)) > 45, `extreme vs ${v.toFixed(1)}`);
});

test('priceColour: continuous green -> red hue, monotonic, lightness varies, green/red differ in luminance', () => {
  const hue = (hex) => { const [r, g, b] = hexRgb(hex).map((x) => x / 255); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn; if (d === 0) return 0; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; };
  let prev = 1000;
  let lights = new Set();
  let maxStep = 0;
  let last = null;
  for (let v = 0.5; v < 45; v += 0.5) {
    const c = P.priceColour(v);
    let h = hue(c);
    if (h > 300) h -= 360; // the last stop's hue runs below 0 (through orange to red), which reads back as ~343
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

test('priceColour: text variant reads on the card (>= 4.5:1) for every price', () => {
  for (const v of [-20, -7.5, 0, 0.5, 5, 10, 15, 20, 25, 30, 35, 40, 44.9, 45, 80, 200, NaN]) assert.ok(cr(P.priceColour(v, { text: true }), '#1f1d2e') >= 4.5, `${v}`);
});

test('Now and Next figures use the price colour (text variant)', () => {
  const html = P.render('status', {}, mk(), NOW); // now 34.8p, next 41.2p in the fixture
  assert.ok(html.includes(`<div class="hm-price num" style="color:${P.priceColour(34.8, { text: true })}">34.8<small>p</small></div>`));
  assert.match(html, /Next 41\.2p</);
  const none = P.render('status', {}, { states: {} }, NOW);
  assert.ok(none.includes(`color:${P.priceColour(NaN, { text: true })}`));
});

test('chart: per-slot colours from the real rates at 18:29Z; key and aria summary present', () => {
  const html = energyAt(real, Date.parse('2026-10-25T18:29:00Z'));
  const bars = rect(html);
  assert.equal(bars.length, 50);
  real.forEach((r, i) => {
    const p = r.value_inc_vat * 100;
    if (i === 38) assert.equal(bars[i].fill, '#e0def4');
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

test('extreme prices (>= 45p) render in the extreme colour; zero and negative in teal', () => {
  const slots = [-3, 0, 20, 44.9, 45, 60].map((p, i) => { const s = Date.parse('2026-10-25T00:00:00Z') + i * 1800000; return { start: new Date(s).toISOString(), end: new Date(s + 1800000).toISOString(), value_inc_vat: p / 100 }; });
  const bars = rect(energyAt(slots, Date.parse('2026-10-25T23:00:00Z')));
  assert.deepEqual(bars.map((b) => b.fill), ['#7dcfff', '#7dcfff', P.priceColour(20), P.priceColour(44.9), '#b4637a', '#b4637a']);
});

test('slotAt: x -> slot index, clamped, never assumes 48', () => {
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

test('slotReadout: local range, price, now / paid to use notes, bad input is null', () => {
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

test('slotReadout works on a 46-slot (short) day too', () => {
  const day = P.rateBands(mkSlots(46, '2026-03-29T00:00:00Z', (i) => i - 10), Date.parse('2026-03-29T05:10:00Z'));
  assert.equal(day.length, 46);
  assert.equal(P.slotAt(299, 300, day.length), 45);
  assert.equal(P.slotReadout(day[45]).range, '22:30-23:00');
  assert.equal(P.slotReadout(day[10]).note, 'now · free');
});

test('tooltipLeft: centred, clamped inside the chart, never negative, bad input is 0', () => {
  assert.equal(P.tooltipLeft(150, 100, 300), 100);
  assert.equal(P.tooltipLeft(5, 100, 300), 0); // left edge
  assert.equal(P.tooltipLeft(299, 100, 300), 200); // right edge
  assert.equal(P.tooltipLeft(150, 400, 300), 0); // wider than the box
  assert.equal(P.tooltipLeft(150, 0, 300), 150);
  for (const bad of [[NaN, 10, 300], [10, NaN, 300], [10, 10, 0], [10, 10, -1], [10, 10, NaN], [Infinity, 10, 300]]) assert.equal(P.tooltipLeft(...bad), 0, JSON.stringify(bad));
  for (let c = -50; c < 400; c += 7) { const l = P.tooltipLeft(c, 120, 300); assert.ok(l >= 0 && l <= 180, `${c} -> ${l}`); }
});

test('chart markup: focusable, pan-y, one summary label, live region, guide and tooltip hooks; empty rates have none', () => {
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

test('energyStats: cheapest, dearest, time-weighted average (negatives, clock-change day, uneven slots)', () => {
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

test('windows from the slot list: real clock-change day gives ONE negative run, no overlaps or zero-length windows', () => {
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

test('windows: tomorrow (46 slots), ordinary 48-slot day, empty, one slot, thresholds', () => {
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

test('windows card renders them for the selected day with graded colour; none / empty days honest', () => {
  const hass = energyHass();
  const t = P.render('energy-day', {}, hass, NOW, {});
  assert.equal(count(t, />Free power</g), 1, 'one negative run, not a scrambled list');
  assert.match(t, /Free power<\/div><div class="hm-rs">23:00 → 14:30<\/div><\/div><span class="hm-val num">avg −\d/); // TZ=UTC here; London shows 00:00 → 14:30 (child-process test)
  assert.match(t, /Cheap<\/div><div class="hm-rs">/);
  assert.equal(count(t, /→ 01:00/g), 0);
  const m = P.render('energy-day', {}, hass, NOW, { day: 'tomorrow' });
  assert.ok(/Free power<\/div><div class="hm-rs">None/.test(m) || /Free power<\/div><div class="hm-rs">\d\d:\d\d → \d\d:\d\d/.test(m));
  const e = P.render('energy-day', {}, energyHass({}, real, []), NOW, { day: 'tomorrow' });
  assert.doesNotMatch(e, />Free power<|>Cheap</);
  const quiet = day('2026-03-02T00:00:00Z', 48);
  const q = P.render('energy-day', {}, energyHass({}, quiet, quiet), Date.parse('2026-03-02T12:00:00Z'), {});
  assert.match(q, /Free power<\/div><div class="hm-rs">None/);
  assert.match(q, /Cheap<\/div><div class="hm-rs">None/);
});

test('window labels in Europe/London on the real clock-change day (child process, TZ set before Date is used)', () => {
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

test('windowRange: a window spanning the repeated hour is never printed zero-length', () => {
  const script = `
    const P = require(${JSON.stringify(root + 'www/pulse-card.js')});
    const w = { start: Date.parse('2026-10-25T00:00:00Z'), end: Date.parse('2026-10-25T01:00:00Z') };
    console.log(P.windowRange(w));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Europe/London' } }).toString().trim();
  assert.match(out, /^01:00 [A-Z+0-9:]+ → 01:00 [A-Z+0-9:]+$/);
  assert.notEqual(out.split(' → ')[0], out.split(' → ')[1]);
});

test('energy page: head has the title (no back link), the live usage as its subtitle, and Now/Next as two tiles', () => {
  const html = P.render('energy-head', {}, energyHass({ 'sensor.glow_electricity_power': { state: '0.44', attributes: { unit_of_measurement: 'kW' }, last_updated: '2026-10-25T18:41:50+00:00' } }), NOW);
  assert.doesNotMatch(html, /Back to House/);
  assert.match(html, /^<div class="p"><div class="hm hm-first"><div class="hm-head"><div class="hm-hd"><h1 class="hm-big">Energy<\/h1><span class="hm-line">Using 440 W<\/span><\/div><\/div><div class="hm-wgrid hm-tight">/);
  assert.ok(html.includes(`color:${P.priceColour(34.8, { text: true })}`));
  assert.equal(count(html, /class="hm-w"/g), 2, 'Now and Next');
  assert.match(html, />Now<\/div><div class="hm-wv num"><span[^>]*>34\.8<\/span><small>p\/kWh<\/small><\/div><div class="hm-ws">Until 19:00/, 'Now says which half hour it covers');
  assert.match(html, /From 19:00/);
  assert.match(html, />Next<\/div>/);
  assert.doesNotMatch(html, /class="lbl"|text-transform/, 'no uppercase label');
  // A meter reading that has not moved for 10 minutes is no live fact: the subtitle is left out, not shown as a dash.
  const stale = P.render('energy-head', {}, energyHass({ 'sensor.glow_electricity_power': { state: '0.44', attributes: { unit_of_measurement: 'kW' }, last_updated: '2026-10-25T17:00:00+00:00' } }), NOW);
  assert.doesNotMatch(stale, /hm-line|Using/);
});

test('energy page day toggle: Today (50 slots) <-> Tomorrow (46 slots), pressed state, no now marker tomorrow', () => {
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

test('energy page stats tiles follow the selected day', () => {
  const hass = energyHass();
  const t = P.render('energy-day', {}, hass, NOW, {});
  assert.match(t, /Cheapest<\/div><div class="hm-wv num"><span style="color:#[0-9a-f]{6}">−7\.5p<\/span><\/div><div class="hm-ws">at \d\d:\d\d/);
  assert.match(t, /Dearest<\/div><div class="hm-wv num"><span[^>]*>33\.4p<\/span><\/div><div class="hm-ws">at 17:00/);
  assert.match(t, /Average<\/div><div class="hm-wv num"><span[^>]*>[−\d.]+p<\/span><\/div><div class="hm-ws">per kWh/);
  assert.match(t, /<div class="hm-wgrid hm-group-row">/, 'the stat tiles share the two-column grid; the odd one out spans the row');
  const m = P.render('energy-day', {}, hass, NOW, { day: 'tomorrow' });
  const st = P.energyStats(P.rateBands(tomorrow, NOW));
  assert.ok(m.includes(`>${P.penceText(st.dearest.v)}<`));
  assert.ok(m.includes(`at ${st.dearest.time}`));
});

test('energy page: tomorrow missing / empty / unavailable shows the honest empty state', () => {
  for (const rates of [[], undefined, 'unavailable', [null], 'x']) {
    const html = P.render('energy-day', {}, energyHass(rates === undefined ? { 'event.octopus_energy_electricity_24e8140196_1012483035417_next_day_rates': null } : {}, real, rates), NOW, { day: 'tomorrow' });
    assert.match(html, /Tomorrow&#39;s rates are not in yet/);
    assert.match(html, /published late afternoon/);
    assert.doesNotMatch(html, /<rect|data-chart|Cheapest<\/div>/);
    assert.match(html, /<h2>Prices<\/h2>/, 'the section keeps its header and the day control');
    assert.match(html, /class="seg on" data-act="energy-day" data-day="tomorrow"/);
    noNoise({ html }, 'tomorrow empty');
  }
  const todayEmpty = P.render('energy-day', {}, energyHass({}, [], tomorrow), NOW, {});
  assert.match(todayEmpty, /No price data for today/);
  assert.doesNotMatch(P.render('energy-day', {}, { states: {} }, NOW, {}), NOISE);
});

test('covered day: derived from charges, otherwise "latest complete day"; never guessed', () => {
  assert.equal(P.isoDayLabel('2026-10-23T00:00:00+01:00'), 'Fri 23 Oct');
  assert.equal(P.isoDayLabel('2026-10-23'), 'Fri 23 Oct');
  for (const bad of [null, undefined, 5, 'x', '2026-13-45']) assert.ok([null, 'Fri 23 Oct'].includes(P.isoDayLabel(bad)) || typeof P.isoDayLabel(bad) === 'string');
  const full = { charges: charges('2026-10-22T23:00:00Z') };
  full.charges = full.charges.map((c, i) => (i === 0 ? { ...c, start: '2026-10-23T00:00:00+01:00' } : c));
  assert.equal(P.coveredDay(full), 'Fri 23 Oct');
  assert.equal(P.coveredDay({ charges: charges('2026-10-22T23:00:00Z', 5, 10).map((c, i) => (i === 0 ? { ...c, start: '2026-10-23T00:00:00+01:00' } : c)) }), null, 'a partial day is not labelled');
  for (const bad of [undefined, null, {}, { charges: [] }, { charges: 'x' }, { charges: [{ start: 'nope' }] }]) assert.equal(P.coveredDay(bad), null);
});

test('standing charge is only claimed when the attributes prove it (live shapes: rounding tolerant)', () => {
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

test('covered day on a 25-hour clock-change day: 50 charges from 2026-10-25T00:00:00+01:00 still derive the date', () => {
  const c = Array.from({ length: 50 }, (_, i) => {
    const t = Date.parse('2026-10-24T23:00:00Z') + i * 1800000;
    return { start: i === 0 ? '2026-10-25T00:00:00+01:00' : new Date(t).toISOString(), end: new Date(t + 1800000).toISOString(), cost: 0.1 };
  });
  assert.equal(P.coveredDay({ charges: c }), 'Sun 25 Oct');
  assert.equal(P.coveredDay({ charges: c.slice(0, 40) }), null, 'a partial list is still refused');
  const r = P.render('energy-cost', {}, mk({ [`${EID}_cost`]: { state: '3.58', attributes: { unit_of_measurement: 'GBP', charges: c, total_without_standing_charge: 3.11, standing_charge: 0.46 } } }), NOW);
  assert.match(r, /£3\.58<\/div><div class="hm-ws">Sun 25 Oct<\/div><div class="hm-ws">–<\/div><div class="hm-ws">incl\. standing charge</);
});

test('cost card: published values labelled with their day, unavailable dashes, missing date says latest complete day', () => {
  const e = { unit_of_measurement: 'GBP', charges: charges('2026-10-22T23:00:00Z').map((c, i) => (i === 0 ? { ...c, start: '2026-10-23T00:00:00+01:00' } : c)), total_without_standing_charge: 2.9, standing_charge: 0.52 };
  const hass = mk({ [`${EID}_cost`]: { state: '3.42', attributes: e }, [`${EID}_consumption`]: { state: '9.4', attributes: { unit_of_measurement: 'kWh' } }, [`${GID}_cost`]: { state: '1.2', attributes: { unit_of_measurement: 'GBP' } }, [`${GID}_consumption_kwh`]: { state: '10.04', attributes: { unit_of_measurement: 'kWh' } } });
  const html = P.render('energy-cost', {}, hass, NOW);
  assert.match(html, /Electricity<\/div><div class="hm-wv num">£3\.42<\/div><div class="hm-ws">Fri 23 Oct<\/div><div class="hm-ws">9\.4 kWh<\/div><div class="hm-ws">incl\. standing charge</);
  assert.match(html, /Gas<\/div><div class="hm-wv num">£1\.20<\/div><div class="hm-ws">Latest complete day<\/div><div class="hm-ws">10\.0 kWh</);
  assert.doesNotMatch(html, /Gas[\s\S]*standing/);
  assert.match(html, /Octopus publishes about 1-2 days late/);
  const dash = P.render('energy-cost', {}, mk({ [`${EID}_cost`]: { state: 'unavailable', attributes: {} } }), NOW);
  assert.equal(count(dash, /class="hm-wv num">–</g), 2);
  assert.match(dash, /Latest complete day<\/div><div class="hm-ws">–/);
  assert.match(P.render('energy-cost', {}, mk({ [`${EID}_cost`]: { state: '3.42', attributes: { unit_of_measurement: 'USD' } } }), NOW), /class="hm-wv num">–</);
  noNoise({ html, dash }, 'cost');
  assert.equal(P.money(-1.5, 'GBP'), '−£1.50');
});

test('usage card: unit-aware kWh, dashes for unavailable / unknown units, labelled as live meter', () => {
  const g = (v, u) => ({ state: v, attributes: u ? { unit_of_measurement: u } : {} });
  const html = P.render('energy-usage', {}, mk({ 'sensor.glow_electricity_today': g('17.9', 'kWh'), 'sensor.glow_electricity_month': g('142.33', 'kWh'), 'sensor.glow_gas_today': g('3100', 'Wh'), 'sensor.glow_gas_month': g('unavailable', 'kWh') }), NOW);
  assert.match(html, /Electricity<\/div><div class="hm-wv num">17\.9<small>kWh<\/small><\/div><div class="hm-ws">Today</);
  assert.match(html, /Electricity<\/div><div class="hm-wv num">142<small>kWh<\/small><\/div><div class="hm-ws">This month</);
  assert.match(html, /Gas<\/div><div class="hm-wv num">3\.1<small>kWh<\/small><\/div><div class="hm-ws">Today</);
  assert.match(html, /Gas<\/div><div class="hm-wv num">–<\/div><div class="hm-ws">This month</);
  assert.equal(count(html, /class="hm-w"/g), 4, 'two fuels by two periods, in the two-column grid');
  assert.match(html, /smart meter, live/);
  const nounit = P.render('energy-usage', {}, mk({ 'sensor.glow_electricity_today': g('17.9') }), NOW);
  assert.match(nounit, /Electricity<\/div><div class="hm-wv num">–<\/div><div class="hm-ws">Today</);
  assert.equal(P.energyText('1', 'MWh'), '1000 kWh');
  assert.equal(P.energyText(null, 'kWh'), '–');
  noNoise({ html, nounit }, 'usage');
});

test('energy page: sparse / missing / garbage data never throws or leaks noise in any energy mode', () => {
  for (const hass of [{ states: {} }, mk(), energyHass({ 'sensor.glow_gas_today': { state: 'x', attributes: null }, [`${EID}_cost`]: { state: '1', attributes: { charges: 5 } } }), energyHass({}, 'junk', 7)]) {
    for (const m of ['energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage']) for (const ui of [{}, { day: 'tomorrow' }, undefined]) noNoise({ x: P.render(m, {}, hass, NOW, ui) }, m);
  }
});

test('energy view is registered and adds no write paths', () => {
  const v = yaml.load(readFileSync(root + 'views/info-energy.yaml', 'utf8'));
  assert.equal(v.path, 'energy');
  assert.deepEqual(v.sections[0].cards.map((c) => c.mode), ['energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage', 'tabbar']);
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-energy\.yaml/);
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card-loader\.js/);
});

test('history: groups by last_reset INSTANT (mixed +00:00 / +01:00 / Z / ms / seconds forms are one group)', () => {
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

test('history: the known-good electricity fixture gives covered days 14..23 Oct with the right costs (ms and ISO inputs)', () => {
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

test('history: covered date across BST, GMT and both clock changes (no last_reset + 1h arithmetic)', () => {
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

test('history: partial groups are dropped except the newest (still open); fewer than 14 days just shows fewer', () => {
  const rows = [...hourly('2026-10-19T23:00:00Z', 3.56), ...hourly('2026-10-20T23:00:00Z', 9.99, 5), ...hourly('2026-10-21T23:00:00Z', 2.75), ...hourly('2026-10-22T23:00:00Z', 3.58, 3)];
  const d = P.groupDailyCost(rows, TZ);
  assert.deepEqual(d.map((x) => [x.date, x.cost]), [['2026-10-20', 3.56], ['2026-10-22', 2.75], ['2026-10-23', 3.58]]);
  assert.equal(P.groupDailyCost(hourly('2026-10-22T23:00:00Z', 3.58, 1), TZ).length, 1, 'a lone newest group is kept');
  const many = Array.from({ length: 30 }, (_, i) => hourly(new Date(Date.parse('2026-09-01T23:00:00Z') + i * 86400000).toISOString(), 3 + i / 100)).flat();
  const d14 = P.groupDailyCost(many, TZ);
  assert.equal(d14.length, 14);
  assert.equal(d14[13].cost, 3.29, 'the most recent 14 days');
});

test('history: empty / garbage / missing inputs never throw or invent days', () => {
  for (const bad of [undefined, null, 5, 'x', {}, [], [null], [{}], [{ state: 'x', last_reset: 'y' }], [{ state: 3, last_reset: null }], [{ state: null, last_reset: 5 }]]) assert.deepEqual(P.groupDailyCost(bad, TZ), [], JSON.stringify(bad));
  assert.deepEqual(P.dailyCostFromWS(undefined, TZ), { electricity: [], gas: [] });
  assert.deepEqual(P.dailyCostFromWS({ [ECOST]: 'x', [GCOST]: [{ junk: 1 }] }, TZ), { electricity: [], gas: [] });
  const both = P.dailyCostFromWS({ [ECOST]: hourly('2026-10-22T23:00:00Z', 3.58), [GCOST]: hourly('2026-10-23T23:00:00Z', 2.84) }, TZ);
  assert.equal(both.electricity[0].date, '2026-10-23');
  assert.equal(both.gas[0].date, '2026-10-24');
});

test('history request is a read-only recorder statistics call for the two cost sensors (hourly, 21 days)', () => {
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

test('history section: bars, scaling, latest highlighted, ticks, summary, readout text', () => {
  const days = elecDays();
  const hass = mk({ [ECOST]: { state: '3.58', attributes: { unit_of_measurement: 'GBP', total_without_standing_charge: 3.11, standing_charge: 0.46 } } });
  const html = P.render('energy-history', {}, hass, NOW, histUi('electricity', days));
  assert.match(html, />Daily cost</);
  assert.match(html, /class="seg on" data-act="cost-fuel" data-fuel="electricity" aria-pressed="true"/);
  assert.match(html, /data-fuel="gas" aria-pressed="false"/);
  const bars = [...html.matchAll(/<rect x="(\d+)" y="([\d.]+)" width="(\d+)" height="([\d.]+)" rx="2" fill="#7aa2f7" opacity="([\d.]+)"\/>/g)].map((m) => ({ y: +m[2], h: +m[4], op: +m[5] }));
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

test('history section: toggle shows gas, fewer than 14 days, loading / unavailable / empty are honest, never fake bars', () => {
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

test('history runtime: one WS call on mount, no call per hass update, 30 min refresh, no overlap, stale and unmount guarded, failures swallowed', async () => {
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

test('energy page: sentence-case section headers, no uppercase labels, pills or middle-dot strings, one root block per card', () => {
  const pages = energyPages();
  for (const [k, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /class="lbl"|text-transform|class="tag|class="card|class="wrow|class="stat/, `${k}: only the shared parts`);
    assert.doesNotMatch(html, / · /, `${k}: a second line instead of a middle dot`);
    assert.match(html, k === 'head' ? /^<div class="p"><div class="hm hm-first">/ : /^<div class="p"><div class="hm">/, `${k}: one block, spaced by the shared section gap`);
    for (const h of html.matchAll(/<h2>([^<]+)<\/h2>/g)) assert.equal(h[1], h[1].charAt(0) + h[1].slice(1).toLowerCase().replace(/\b(octopus)\b/, '$1'), `${k}: "${h[1]}" is sentence case`);
  }
  assert.deepEqual([...(pages.day + pages.cost + pages.history + pages.usage).matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ['Prices', 'Windows', 'Cost (latest published day)', 'Daily cost', 'Usage (smart meter, live)']);
  assert.equal(count(pages.head, /<h1 /g), 1);
});

test('energy page: charts sit in a card of the room chart\'s radius and padding, with the legend in the room chart\'s style', () => {
  const pages = energyPages();
  assert.equal(count(pages.day, /<div class="hm-card"><div class="chart"/g), 1, 'price chart in a card');
  assert.equal(count(pages.history, /<div class="hm-card"><div class="chart"/g), 1, 'cost chart in a card');
  const card = rule('.hm-card').body;
  assert.equal(px(decl(card, 'border-radius')), 20, 'the room chart card radius');
  assert.equal(px(decl(card, 'padding')), 16);
  // The legend: 11px, secondary text, left aligned under the plot (apex: fontSize 11px, textSecondary, horizontalAlign left).
  assert.match(pages.day, /margin-top:8px;font-size:11px;color:#908caa" aria-hidden="true"><span style="display:inline-flex/);
  assert.doesNotMatch(pages.day + pages.history, /color:#6e6a86/, 'axis and legend text is readable, not tertiary');
  // The scrub tooltip sits 36px above the plot: the chart's top margin plus the card padding keeps it inside the card.
  assert.ok(20 + px(decl(card, 'padding')) >= 36);
  assert.match(pages.day, /data-chart data-day="today"[^>]*style="position:relative;margin-top:20px;/);
});

test('energy page: headline numbers are tiles in the shared two-column grid, an odd last tile spans the row', () => {
  const pages = energyPages();
  assert.equal(count(pages.head, /class="hm-w"/g), 2);
  assert.equal(count(pages.day, /class="hm-w"/g), 3);
  assert.equal(count(pages.cost, /class="hm-w"/g), 2);
  assert.equal(count(pages.usage, /class="hm-w"/g), 4);
  assert.match(P.STYLE, /\.hm-wgrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:10px\}/);
  assert.equal(decl(rule('.hm-wgrid .hm-w:last-child:nth-child(odd)').body, 'grid-column'), '1/-1');
  assert.equal(decl(rule('.hm-scenes').body, 'gap'), decl(rule('.hm-wgrid').body, 'gap'), 'one gutter token for every two-column grid');
});

test('energy page: the top gap fix applies: the title card has no top margin, every other card is spaced by the section gap', () => {
  const pages = energyPages();
  assert.match(P.STYLE, /\.hm\.hm-first\{margin-top:0\}/);
  assert.equal(count(pages.head, /class="hm hm-first"/g), 1);
  for (const k of ['day', 'cost', 'history', 'usage']) assert.equal(count(pages[k], /hm-first/g), 0, k);
  assert.match(P.STYLE, /\.hm\{[^}]*margin-top:max\(0px,calc\(36px - var\(--row-gap,8px\)\)\)/);
});

test('stat tiles: the unit sits in a zero line-height box so both sub-lines share a baseline', () => {
  assert.match(rule('.hm-wv small').body, /line-height:0/);
  assert.match(rule('.hm-wv').body, /line-height:41px/);
});
