// Shared fixtures and helpers for the Pulse card tests: the card loaded under the default theme, hass fixtures,
// row and page parsers. Each area file imports what it needs; helpers used by one area live in that area's file.
// TZ is pinned before the card loads so slot labels are the same everywhere.
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';

export const require = createRequire(import.meta.url);

export const Raw = require('../www/pulse-card.js');

// Pages carry var(--pulse-token) rather than hex. P resolves the variables against the theme the config names
// (the shipped default, rose-pine, when it names none); Raw is the card as shipped.
export const themeName = (config) => (config && config.theme) || 'rose-pine';

// One themed copy per config object: the render gate skips a repaint only when it is handed the same config.
export const themed = new WeakMap();

export const asTheme = (config) => {
  if (config === null || typeof config !== 'object') return { theme: 'rose-pine' };
  if (!themed.has(config)) themed.set(config, { ...config, theme: themeName(config) });
  return themed.get(config);
};

export const P = {
  ...Raw,
  render: (mode, config, ...rest) => Raw.resolveVars(Raw.render(mode, asTheme(config), ...rest), themeName(config)),
  STYLE: Raw.resolveVars(Raw.STYLE, 'rose-pine'),
  makeRenderGate: (...a) => {
    const gate = Raw.makeRenderGate(...a);
    const run = (mode, config, ...rest) => { const out = gate.run(mode, asTheme(config), ...rest); return { ...out, html: Raw.resolveVars(out.html, themeName(config)) }; };
    return Object.create(gate, { run: { value: run } });
  },
};

// Tests that call colour helpers directly (outside a render) read the default palette too.
Raw.useTheme({ theme: 'rose-pine' });

export const root = new URL('..', import.meta.url).pathname;

export const NOW = Date.parse('2026-10-25T18:42:00Z');

// The old "why" card is now three subsystem sections; tests about its wording read them together.
export const whyAll = (config, hass, now) => ['lights', 'heating', 'presence'].map((m) => P.render(m, config, hass, now)).join('');

export const BASE = 'sensor.octopus_energy_electricity_24e8140196_1012483035417';

export const FULL = (k) => ({
  k, n: k, nav: '/x', occupied: true, occupancy_unavailable: false, unavailable: [], temp: 20.8, target: 5.0,
  mode_target: 18.0, target_reason: 'window open', mode_name: 'baseline day', pres_labels: ['Bed occupied'],
  heat_labels: ['Window open'], humidity: 63, hvac_action: 'idle', heating_active: 'baseline_day',
  heating_source: 'schedule', lights_on: 0, lights_total: 3, scene: 'off', lights_enabled: true,
  heating_enabled: true, override: false, ext_open: true, holds: [], reason_text: 'Bed occupied · Window open',
  override_text: '', labels: ['Bed occupied', 'Window open'], manual: null, verdict: 'Occupied · lights off',
});

// The scenes each room must yield from the HA registry: ordered ids, the off scene last. This is the current
// hand list the card used before it read the registry, so the registry has to reproduce it.
export const SCENES = {
  parlour: ['all', 'lamps', 'dining', 'off'], kitchen: ['all', 'cabinets', 'off'], hallway_downstairs: ['daylight', 'low', 'off'],
  hallway_upstairs: ['daylight', 'low', 'off'], bedroom: ['all', 'all_full', 'lamps', 'off'], bathroom: ['full', 'low', 'off'],
  home_office: ['all', 'lamps', 'off'], foreign_office: ['all', 'off'], back_garden: ['all', 'off'], front_garden: ['normal', 'off'],
};

// A registry as hass.entities / hass.devices carry it. Positions are deliberately inserted out of order, kitchen
// scenes take their area from the device, and each area also holds entities that are not scenes.
export function registryFixture(want = SCENES) {
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

export const mk = (over = {}) => {
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

export const withRooms = (rooms, attention, extra = {}) => mk({
  'sensor.info_rooms': { state: 'ok', attributes: { rooms: typeof rooms === 'string' ? rooms : JSON.stringify(rooms) } },
  'sensor.info_attention': { state: String(attention.length), attributes: { items: JSON.stringify(attention) } },
  ...extra,
});

// homerun history entries (home.history.v1) and the sensor that carries them. `ago` is minutes before NOW.
export const histEntry = (ago, over = {}) => ({
  ts: new Date(NOW - ago * 60000).toISOString(), location: 'kitchen', automation_id: 'kitchen:lighting', subsystem: 'lighting',
  kind: 'decision', decision: 'turn_off', reason: 'occupancy_off', outcome: 'acted', ...over,
});

export const histSensor = (key, entries, over = {}) => ({ [`sensor.${key}_history`]: { state: entries.length ? entries[0].ts : 'unknown', attributes: { schema: 'home.history.v1', entries, ...over } } });

export const luxHigh = (ago, lux = 85) => histEntry(ago, { decision: 'no_action', reason: 'lux_high', outcome: 'declined', facts: { lux, lux_threshold: 40 } });

// The House page is lists of rows: a row is the <a> (or <div>) that holds a room's path, a title and a subtitle.
export const rowOf = (html, path) => { const m = html.match(new RegExp(`<a class="hm-row tap" data-act="nav" data-path="${path.replace(/[/.]/g, '\\$&')}"[\\s\\S]*?</a>`)); assert.ok(m, `no row for ${path}`); return m[0]; };

export const rowTitle = (row) => row.match(/class="hm-rt">([^<]*)</)[1];

export const rowSub = (row) => row.match(/class="hm-rs"[^>]*>([^<]*)</)[1];

export const rowValue = (row) => (row.match(/class="hm-val num">([^<]*)</) || [])[1];

export const NOISE = /undefined|NaN|\[object|null/;

export const ALL_MODES = ['now-header', 'status', 'rooms', 'house-list', 'feed', 'tabbar', 'energy-head', 'energy-day', 'energy-cost', 'energy-history', 'energy-usage'];

export const SHARED_MODES = ['room-head', 'automation', 'room-feed'];

export const INDOOR_MODES = ['lights', 'heating', 'presence', 'media'];

export const GARDEN_MODES = ['garden-lights', 'garden-theme'];

export const GARDENS = ['front_garden', 'back_garden'];

export const modesFor = (k) => SHARED_MODES.concat(GARDENS.includes(k) ? GARDEN_MODES : INDOOR_MODES);

export const renderAll = (hass) => {
  const out = {};
  for (const m of ALL_MODES) out[m] = P.render(m, {}, hass, NOW);
  for (const k of P.ALL_ROOM_KEYS) for (const m of modesFor(k)) out[`${m}:${k}`] = P.render(m, { room: k }, hass, NOW);
  return out;
};

export const noNoise = (out, label) => { for (const [k, v] of Object.entries(out)) assert.ok(!NOISE.test(v), `${label} ${k} contains noise: ${(v.match(NOISE) || [])[0]} in ${v.slice(0, 200)}`); };

// ── lightsStory: first matching rule wins ─────────────────────────────────────────────────────
export const story = (over = {}, extra = {}, key = 'kitchen') => P.lightsStory(withRooms([{ ...FULL(key), manual: null, pres_labels: [], labels: [], occupied: true, lights_on: 0, ...over }], [], extra), key, NOW);

// Mirrors streamline-card's evaluateVariables: defaults come only from the template's `default` (list of
// single-key maps or an object), never from a template-level `variables:`; the view's variables win.
export const streamlineVars = (tpl, viewVars) => {
  const flat = (d) => (Array.isArray(d) ? Object.assign({}, ...d) : d || {});
  return { ...flat(tpl.default), ...flat(viewVars) };
};

export const substitute = (node, vars) => {
  if (typeof node === 'string') return node.replace(/\[\[(\w+)\]\]/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  if (Array.isArray(node)) return node.map((x) => substitute(x, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, vars)]));
  return node;
};

// ── YAML: parses, and the apexcharts data_generator strings run against rate lists ───────────
export const loadYaml = (rel) => yaml.load(readFileSync(root + rel, 'utf8').replace(/!include /g, ''));

export const walk = (node, fn) => { if (Array.isArray(node)) node.forEach((x) => walk(x, fn)); else if (node && typeof node === 'object') { fn(node); Object.entries(node).forEach(([k, x]) => { if (k !== '<<') walk(x, fn); }); } };

export const rect = (html) => [...html.matchAll(/<rect x="(\d+)" y="([\d.]+)" width="(\d+)" height="([\d.]+)" rx="1" fill="([^"]+)" opacity="([\d.]+)"\/>/g)].map((m) => ({ x: +m[1], y: +m[2], h: +m[4], fill: m[5], op: +m[6] }));

export const real = JSON.parse(readFileSync(root + 'tests/fixtures/rates-2026-10-25-clock-change.json', 'utf8'));

export const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export const lum = (h) => { const c = hexRgb(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

export const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

export function mkSlots(n, startIso, f) { return Array.from({ length: n }, (_, i) => { const t = Date.parse(startIso) + i * 1800000; return { start: new Date(t).toISOString(), end: new Date(t + 1800000).toISOString(), value_inc_vat: f(i) / 100 }; }); }

// ── Now v2 ─────────────────────────────────────────────────────────────────────────────────────
export const quietRoom = (k, over = {}) => ({ ...FULL(k), occupied: false, target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false, manual: null, lights_on: 0, lights_why: 'lights back to automatic', lights_ts: '2026-10-25T16:40:00+00:00', last: 'Off', last_ts: '2026-10-25T16:40:00+00:00', humidity: 55, scene: '', verdict: 'Empty', ...over });

export const calmRooms = (over = {}) => P.ROOM_ORDER.map((k) => quietRoom(k, over[k] || {}));

export const count = (html, re) => (html.match(re) || []).length;

export const attn = (room, key, kind, text) => ({ room, key, kind, text, nav: '/x' });

// House page rooms, attention and widget (native list design)
export const roomPaths = (html) => [...html.slice(0, html.indexOf('<h2>Outside')).matchAll(/data-path="\/pulse-dashboard\/room-(\w+)"/g)].map((m) => m[1]);

export const tileStyle = (row) => row.match(/class="hm-tile" style="([^"]*)"/)[1];

// ── Energy page ──────────────────────────────────────────────────────────────────────────────
export const tomorrow = JSON.parse(readFileSync(root + 'tests/fixtures/rates-2026-10-26-tomorrow.json', 'utf8'));

export const day = (start, n = 48) => Array.from({ length: n }, (_, i) => ({ start: new Date(Date.parse(start) + i * 1800000).toISOString().replace('.000Z', '+00:00'), end: new Date(Date.parse(start) + (i + 1) * 1800000).toISOString().replace('.000Z', '+00:00'), value_inc_vat: 0.2 }));

export const winOn = (rates) => P.slotWindows(P.rateBands(rates, NOW), 'negative');

export const fmtWin = (w) => `${P.windowRange(w)} avg ${P.penceText(w.avg)}`;

// ── House page header, attention and tab bar (native list design) ────────────────────────────────
export const NOW_MODES = ['now-header', 'status', 'rooms', 'house-list', 'feed'];

export const nowPage = (hass) => NOW_MODES.map((m) => P.render(m, {}, hass, NOW)).join('\n');

// ── List geometry (fixed shapes only, no clipping of content) ───────────────────────────────────
export const cssRules = () => [...P.STYLE.matchAll(/^([^{\n]+)\{([^\n]*)\}$/gm)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

export const decl = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)${prop}:([^;]+)`)); return m ? m[1].trim() : null; };

export const px = (v) => (v && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);

export const rule = (sel) => cssRules().find((r) => r.sel === sel);

export const tile = (html, option) => (html.match(new RegExp(`<button[^>]*data-option="${option}"[^>]*>[\\s\\S]*?</button>`)) || [])[0];

export const footnote = (html) => html.match(/<p class="hm-foot">([^<]*)<\/p>/)[1];

// ── Gardens: lights row, theme picker, Now "Outside" group ───────────────────────────────────────
export const b = (state, attributes = {}, last_changed) => ({ state, attributes, ...(last_changed ? { last_changed } : {}) });

export const OPTIONS = ['normal', 'autumn', 'halloween', 'bonfire', 'christmas'];

export const FG_THEME = (theme, last_changed) => ({ 'input_select.front_garden_light_theme': b(theme, { options: OPTIONS }, last_changed) });

// A front garden as the live registry describes it (Spike A): lights off, autumn picked, calendar following.
export const frontGarden = (over = {}) => mk({
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

export const backGarden = (over = {}) => mk({
  'sensor.back_garden_lighting_scenes': b('scene.back_garden_all', { theme: 'normal', off_scene: 'scene.back_garden_off', missing_themes: [], lights: ['switch.back_garden_plug_fence_lights'], lights_on: 0 }),
  'sensor.back_garden_lighting_window': b('22:00', { off: '22:00', preview_min: null }),
  'input_boolean.back_garden_automation_lights_enabled': b('on'),
  'sun.sun': b('above_horizon'),
  'sensor.sun_next_setting': b('2026-11-02T16:30:00+00:00'),
  ...over,
});

export const litScenes = (off = 2) => ({ 'sensor.front_garden_lighting_scenes': b('scene.front_garden_autumn', { theme: 'autumn', off_scene: 'scene.front_garden_off', missing_themes: [], lights: ['light.a', 'light.b'], lights_on: off }) });

export const dark = { 'sun.sun': b('below_horizon'), 'sensor.sun_next_setting': b('2026-11-03T16:28:00+00:00') };

// ── Wording table against the catalogue snapshot ──────────────────────────────────────────────
export const catalog = JSON.parse(readFileSync(root + 'tests/fixtures/catalog.json', 'utf8'));

export const declared = new Map(); // 'subsystem:reason' -> {outcomes, facts}
for (const a of catalog.automations) {
  for (const [reason, v] of Object.entries(a.reasons)) {
    const key = `${a.subsystem}:${reason}`;
    const seen = declared.get(key);
    const facts = [...v.facts].sort().join(',');
    if (seen) { assert.equal(seen.outcome, v.outcome, `${key}: automations disagree on outcome`); assert.equal(seen.facts, facts, `${key}: automations disagree on facts`); }
    else declared.set(key, { outcome: v.outcome, facts });
  }
}

export const worded = [...declared].filter(([, v]) => v.outcome !== 'ignored');

// ── Room settings: the inline Automation list (step 5b) ────────────────────────────────────────────────────────────────────
export const helpersYaml = loadYaml('packages/helpers.yaml');

export const helperIds = new Set([...Object.keys(helpersYaml.input_boolean).map((k) => `input_boolean.${k}`), ...Object.keys(helpersYaml.input_number).map((k) => `input_number.${k}`)]);

export const settingRows = () => Object.entries(P.ROOM_SETTINGS).flatMap(([room, groups]) => groups.flatMap((g) => g.rows.map((row) => ({ room, group: g.key, row }))));

export const sheetHass = (over = {}) => {
  const states = {};
  for (const { row } of settingRows()) states[row.id] = b(row.kind === 'toggle' ? 'on' : String(row.min));
  return mk({ ...states, ...over });
};

// Open, so the rows are visible; `closedSheet` is the default-closed render.
export const sheet = (room, hass = sheetHass()) => P.render('automation', { room }, hass, NOW, { open: { [`${room}:automation`]: true } });

export const closedSheet = (room, hass = sheetHass()) => P.render('automation', { room }, hass, NOW);

// ── Render cost: memoised parses, per-pass room models, skipped renders ──────────────────────────
// HA hands the card a new hass object on every update, with a new state object only for entities that changed.
export const update = (hass, over = {}, extra = {}) => {
  const states = { ...hass.states };
  for (const [id, v] of Object.entries(over)) { if (v === null) delete states[id]; else states[id] = v; }
  return { ...hass, ...extra, states };
};

export const richHass = () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const hist = Object.assign({}, ...P.ALL_ROOM_KEYS.map((k) => histSensor(k, [histEntry(3, { location: k }), luxHigh(9)])), histSensor('house', [histEntry(5, { location: 'house' })]));
  return withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }], {
    ...hist,
    'switch.kitchen_camera_privacy': { state: 'off', attributes: {} },
    'sensor.unrelated_0': { state: '0', attributes: {} },
  });
};

// Every section the harness can render, as [label, mode, config, ui].
export const allCards = () => {
  const cards = [];
  for (const m of ALL_MODES) cards.push([m, m, {}, {}]);
  for (const k of P.ALL_ROOM_KEYS) for (const m of modesFor(k)) cards.push([`${m}:${k}`, m, { room: k }, {}]);
  for (const c of ['parlour', 'kitchen', 'home_office']) cards.push([`camera:${c}`, 'camera', { camera: c }, {}]);
  cards.push(['cameras-head', 'cameras-head', {}, {}]);
  for (const m of ['house-head', 'house-mode', 'house-people', 'house-heating', 'house-mo']) cards.push([m, m, {}, {}]);
  return cards;
};

export const ratio = (a, b) => { for (const c of [a, b]) assert.match(c, /^#[0-9a-f]{6}$/i, `${c} is a 6-digit hex`); return cr(a, b); };

// A translucent rgba(r,g,b,a) laid over an opaque #rrggbb, as hex: what the eye sees.
export const over = (fg, bg) => {
  const [r, g, b, a] = fg.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/).slice(1).map(Number);
  const base = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  return '#' + [r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
};

export const long = (c) => (c.length === 4 ? `#${[...c.slice(1)].map((x) => x + x).join('')}` : c); // a theme may write its white knob as #fff
