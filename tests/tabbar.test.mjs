// Pulse card tests: tabbar. Run: cd tests && npm test (or node --test tabbar.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { require, Raw, P, root, NOW, FULL, mk, withRooms, NOISE, renderAll, noNoise, real, count, cssRules, decl, px, rule, over } from './helpers.mjs';

// ── Tab bar ────────────────────────────────────────────────────────────────────────────────────
const SNAP = (over = {}) => ({ name: 'div', transform: 'none', filter: 'none', perspective: 'none', contain: 'none', willChange: 'auto', backdropFilter: 'none', ...over });

test('tab bar renders four tabs, one per id, with aria-current on the active one only', () => {
  for (const [active, label] of [['house', 'Home'], ['energy', 'Energy'], ['cameras', 'Cameras'], ['settings', 'Settings']]) {
    const html = P.render('tabbar', { active }, mk(), NOW, {});
    assert.match(html, /<nav class="tabs" aria-label="Pulse">/);
    assert.equal(count(html, /<button type="button" class="tab"/g), 4);
    assert.equal(count(html, /aria-current="page"/g), 1);
    assert.match(html, new RegExp(`aria-current="page">[\\s\\S]*?<span>${label}</span>`));
    for (const t of ['Home', 'Energy', 'Cameras', 'Settings']) assert.match(html, new RegExp(`<span>${t}</span>`));
    assert.equal(count(html, /<svg /g), 4, 'inline SVG icons');
    noNoise({ html }, 'tabbar');
  }
  assert.match(P.render('tabbar', { active: 'bogus' }, mk(), NOW, {}), /aria-current="page">[\s\S]*?<span>Home<\/span>/, 'unknown active falls back to Home');
  for (const cfg of [undefined, null, {}, { active: 5 }]) assert.doesNotMatch(P.render('tabbar', cfg, mk(), NOW, undefined), NOISE);
  const css = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.match(css, /\.tab\{[^\n]*font-size:10px[^\n]*min-height:44px/);
  assert.match(css, /\.tab\[aria-current=page\]\{color:\$\{TOKENS\.tint\}\}/);
  assert.match(css, /\.tabs\{[^\n]*\$\{TOKENS\.tabBar\}[^\n]*backdrop-filter:blur\(20px\);border-top:\.5px solid \$\{TOKENS\.separator\}/);
  const bar = P.render('tabbar', { active: 'energy' }, mk(), NOW, {});
  assert.equal(count(bar, /width="26" height="26"/g), 4, '26px icons');
  assert.equal(count(bar, /<svg [^>]*fill="currentColor"/g), 1, 'only the selected tab is a filled icon');
  assert.match(bar, /aria-current="page"><svg [^>]*fill="currentColor"/);
  assert.equal(Raw.THEMES['rose-pine'].tint, '#c4a7e7');
  assert.equal(Raw.THEMES['rose-pine'].textTertiary, '#6e6a86');
  assert.equal(Raw.THEMES['rose-pine'].tabBar, 'rgba(25,23,36,.82)');
});

test('tab bar nav paths use the DASH constant and match real views', () => {
  const html = P.render('tabbar', { active: 'house' }, mk(), NOW, {});
  const paths = [...html.matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['/pulse-dashboard/house', '/pulse-dashboard/energy', '/pulse-dashboard/cameras', '/pulse-dashboard/settings']);
  const viewPaths = readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path);
  for (const p of paths) { assert.ok(p.startsWith(P.DASH + '/'), p); assert.ok(viewPaths.includes(p.slice(P.DASH.length + 1)), p); }
  assert.ok(P.TABS.every((t) => t.path.startsWith(P.DASH)));
});

test('all Pulse views are normal views; room and garden views are hidden from the tab strip (visible: false), still reachable by path', () => {
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

test('tab pages render a title and no back link; the heading is the only title (HA shows tabs, not a view title)', () => {
  for (const [mode, name] of [['energy-head', 'Energy'], ['house-head', 'Settings'], ['cameras-head', 'Cameras']]) {
    const html = P.render(mode, {}, mk(), NOW, {});
    assert.doesNotMatch(html, /Back to House|data-act="nav"/, mode);
    assert.equal(html.split(`>${name}</div>`).length - 1 + html.split(`<h1 class="hm-big">${name}</h1>`).length - 1, 1, `${mode}: exactly one visible title`);
  }
});

test('no headerOverlap workaround is left in the card', () => {
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src, /headerOverlap|headPad|MAX_HEADER_OVERLAP|_headerProbe|_hpTimers|_huiRoot/);
  assert.equal(P.headerOverlap, undefined);
  assert.equal(P.headPadStyle, undefined);
});

test('placement: fixed in-flow decision from ancestor snapshots, naming the offender', () => {
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

test('tab bar markup: in-flow by default (fail safe), fixed + spacer of the same height only when the probe says fixed', () => {
  const inflow = P.render('tabbar', { active: 'house' }, mk(), NOW, {});
  const inflow2 = P.render('tabbar', { active: 'house' }, mk(), NOW, { tb: 'inflow' });
  assert.equal(inflow, inflow2);
  assert.doesNotMatch(inflow, /tabbar-spacer|class="tabs fixed"/);
  const fixed = P.render('tabbar', { active: 'house' }, mk(), NOW, { tb: 'fixed' });
  assert.match(fixed, /<div class="tabbar-spacer" style="--tbh:calc\(49px \+ max\(34px, env\(safe-area-inset-bottom, 0px\)\)\)" aria-hidden="true"><\/div>/);
  assert.match(fixed, /<nav class="tabs fixed" aria-label="Pulse">/);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  const barH = P.STYLE.match(/\.tabs\{--tbh:(calc\([^;]*\));/)[1];
  const spacerH = fixed.match(/--tbh:(calc\(.*?\))" aria-hidden/)[1];
  assert.equal(spacerH, barH, 'spacer height equals bar height');
  assert.match(src, /\.tabs\{[^\n]*height:var\(--tbh\)/);
  assert.match(src, /\.tabbar-spacer\{height:var\(--tbh\)\}/);
  assert.match(src, /\.tabs\.fixed\{position:fixed;left:0;right:0;bottom:0;z-index:100\}/);
  assert.match(src, /padding:0 8px max\(34px, env\(safe-area-inset-bottom, 0px\)\)/);
});

test('TABBAR_ENABLED=false renders nothing (one-line switch)', () => {
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

test('every Pulse view has exactly one tabbar card, last in its section, with its own active tab', () => {
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

test('tab bar: exactly House, Energy, Cameras, Settings, each a real Pulse view, each activatable', () => {
  assert.deepEqual(P.TABS.map((t) => t.id), ['house', 'energy', 'cameras', 'settings']);
  assert.deepEqual(P.TABS.map((t) => t.label), ['Home', 'Energy', 'Cameras', 'Settings']);
  assert.deepEqual(P.TABS.map((t) => t.path), ['/pulse-dashboard/house', '/pulse-dashboard/energy', '/pulse-dashboard/cameras', '/pulse-dashboard/settings']);
  const paths = new Set(readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path));
  for (const t of P.TABS) assert.ok(paths.has(t.path.slice(P.DASH.length + 1)), t.path);
  for (const t of P.TABS) {
    const html = P.render('tabbar', { active: t.id }, mk(), NOW, {});
    assert.match(html, new RegExp(`aria-current="page"[^>]*>[\\s\\S]*?<span>${t.label}</span>`));
  }
});

test('no Pulse page renders a Mobile dashboard link (every mode, rooms with attention, Mo chip kept)', () => {
  const items = P.ALL_ROOM_KEYS.map((k) => ({ room: k, key: k, kind: 'warm_heating', text: 't', nav: '/x' })).concat([{ room: 'House', key: '', kind: 'unexplained_reason', text: 'x', nav: '' }]);
  const hass = withRooms(P.ROOM_ORDER.map(FULL), items);
  for (const [k, html] of Object.entries(renderAll(hass))) assert.doesNotMatch(html, /mobile-dashboard/, k);
  assert.match(P.render('now-header', {}, hass, NOW), /class="hm-mo">Mo/);
  assert.doesNotMatch(readFileSync(root + 'views/info-house.yaml', 'utf8'), /footer/);
});

test('info_rooms cfg: every nav is /pulse-dashboard/room-<key> and names a real view; classic views and occupied/decision sensors are gone', () => {
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

test('tab bar adds no write path and the module URL is untouched', () => {
  assert.deepEqual(Object.keys(P.ALLOWED).sort(), ['button', 'input_boolean', 'input_number', 'input_select', 'light', 'media_player', 'scene', 'switch']);
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card-loader\.js/);
  const src = readFileSync(root + 'www/pulse-card.js', 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('function sectionTabbar'), src.indexOf('function sectionTabbar') + 900), /callService|callWS/);
});

test('tab bar probe wiring (stubbed DOM): clean ancestors -> fixed with spacer; offending ancestor -> stays in-flow and warns once', async () => {
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

test('tab bar fixed height has its arithmetic: 83px with a home indicator, bar content area (49px) holds the 44px tab, its 26px icon and 10px label; spacer matches', () => {
  const bar = rule('.tabs').body;
  const calc = decl(bar, '--tbh').match(/calc\((\d+)px \+ max\((\d+)px/);
  const base = Number(calc[1]);
  const minInset = Number(calc[2]);
  assert.equal(base + minInset, 83, 'a phone with a home indicator gets the 83px iOS tab bar');
  const pad = bar.match(/padding:(\d+) (\d+)px max\((\d+)px/);
  assert.equal(Number(pad[1]), 0);
  assert.equal(minInset, Number(pad[3]), 'bottom padding uses the same max(...) as the height');
  const border = Number((bar.match(/border-top:([\d.]+)px/) || [])[1]);
  assert.equal(border, 0.5, 'hairline top border');
  const content = base - border;
  const tabMin = px(decl(rule('.tab').body, 'min-height'));
  assert.ok(content >= tabMin, `${content}px content area holds a ${tabMin}px tab`);
  const gap = px(decl(rule('.tab').body, 'gap'));
  const label = px(decl(rule('.tab').body, 'line-height'));
  assert.ok(26 + gap + label <= tabMin, 'icon + gap + label fit the tab');
  assert.ok(decl(rule('.tabbar-spacer').body, 'height') === 'var(--tbh)' && decl(bar, 'height') === 'var(--tbh)', 'spacer and bar share --tbh');
  const varHeights = cssRules().filter((r) => /(^|;)height:var\(/.test(r.body)).map((r) => r.sel).sort();
  assert.deepEqual(varHeights, ['.tabbar-spacer', '.tabs']);
  assert.deepEqual(cssRules().filter((r) => /position:fixed/.test(r.body)).map((r) => r.sel), ['.tabs.fixed']);
});
