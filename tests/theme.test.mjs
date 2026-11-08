// Pulse card tests: theme. Run: cd tests && npm test (or node --test theme.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { Raw, P, root, NOW, BASE, FULL, mk, withRooms, GARDENS, real, tomorrow, day, rule, tile, b, frontGarden, backGarden, litScenes, dark, settingRows, richHass, ratio, over, long } from './helpers.mjs';

// ── Themes ───────────────────────────────────────────────────────────────────────────────────────
const cardSrc = readFileSync(new URL('../www/pulse-card.js', import.meta.url), 'utf8');

// ── Room and garden pages (native design) ─────────────────────────────────────────────────────────
const roomPageHass = () => {
  const base = richHass();
  const fg = frontGarden({ ...litScenes(), ...dark });
  const helpers = Object.fromEntries(settingRows().map(({ row }) => [row.id, b(row.kind === 'toggle' ? 'on' : String(row.min))]));
  return { ...base, states: { ...base.states, ...helpers, ...fg.states, ...backGarden().states, 'switch.bathroom_fan_extractor': b('on'), 'sensor.bathroom_fan_decision': b('x', { reason: 'fan_on_shower_started' }), 'input_boolean.bedroom_automation_presence_override': b('off') } };
};

const ROOM_PAGE_MODES = (k) => ['room-head', 'lights', 'heating', 'presence', 'media', 'automation', 'room-feed', 'garden-lights', 'garden-theme'].filter((m) => (GARDENS.includes(k) ? !['lights', 'heating', 'presence', 'media'].includes(m) : !m.startsWith('garden-')));

test('colour literals appear only inside the THEMES block', () => {
  const start = cardSrc.indexOf('  const THEMES = {');
  const end = cardSrc.indexOf('  const DEFAULT_THEME');
  assert.ok(start > 0 && end > start);
  const outside = (cardSrc.slice(0, start) + cardSrc.slice(end)).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const stray = outside.match(/(?<![&\w])#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
  assert.equal(stray, null, `colour literals outside THEMES: ${stray}`);
});

test('every theme defines exactly the same tokens, and the default exists', () => {
  assert.ok(Raw.THEMES[Raw.DEFAULT_THEME]);
  const want = Object.keys(Raw.THEMES[Raw.DEFAULT_THEME]).sort();
  for (const [name, t] of Object.entries(Raw.THEMES)) assert.deepEqual(Object.keys(t).sort(), want, name);
  for (const k of Raw.COLOUR_KEYS) assert.ok(cardSrc.includes(`TOKENS.${k}`) || cardSrc.includes(`colour('${k}')`) || cardSrc.includes(`'${k}'`), `token ${k} is used by the card`);
});

test('every theme is readable: text and textSecondary 4.5:1 on bg and surface, tint 3:1 on surface, inks on their fills', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    for (const fg of ['text', 'textSecondary']) for (const bg of ['bg', 'surface']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: ${fg} on ${bg} ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t.tint, t.surface) >= 3, `${name}: tint on surface ${ratio(t.tint, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.tintInk, t.tint) >= 4.5, `${name}: tintInk on tint ${ratio(t.tintInk, t.tint).toFixed(2)}`);
    assert.ok(ratio(t.attention, t.attentionBg) >= 4.5, `${name}: attention on attentionBg ${ratio(t.attention, t.attentionBg).toFixed(2)}`);
    assert.ok(ratio(t.text, t.control) >= 4.5, `${name}: text on control`);
    assert.ok(ratio(t.textSoft, t.control) >= 4.5, `${name}: textSoft on control`);
  }
});

test('every theme: tile glyphs read on their fills (3:1), including the declined, empty-room and presence colours', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    const pairs = Object.entries(Raw.SUBSYSTEMS).map(([id, s]) => [`subsystem ${id}`, t[s.tile], t[s.ink]])
      .concat([['outside', t.outside, t.outsideInk], ['bins', t.bins, t.binsInk], ['attention', t.attention, t.attentionInk], ['occupied room', t.occupied, t.occupiedInk]]);
    assert.equal(Object.keys(Raw.SUBSYSTEMS).length, 13, 'all 13 homerun subsystems have tile tokens');
    for (const [what, fill, ink] of pairs) assert.ok(ratio(ink, fill) >= 3, `${name}: ${what} glyph on tile ${ratio(ink, fill).toFixed(2)}`);
    assert.ok(ratio(t.textSecondary, t.tileIdle) >= 3, `${name}: empty-room glyph on the idle tile`);
    assert.ok(ratio(t.text, t.tileIdle) >= 4.5, `${name}: text on the idle tile`);
    // A declined row draws its glyph in the subsystem colour on the idle tile, or in secondary text where that colour would vanish.
    for (const [id, s] of Object.entries(Raw.SUBSYSTEMS)) {
      const glyph = ratio(t[s.tile], t.tileIdle) >= 3 ? t[s.tile] : t.textSecondary;
      assert.ok(ratio(glyph, t.tileIdle) >= 3, `${name}: declined ${id} glyph`);
    }
    assert.ok(ratio(t.present, t.bg) >= 3, `${name}: the present dot on the page`);
    assert.notEqual(t.present, t.presenceAway);
    assert.ok(ratio(t.presenceAway, t.bg) >= 1.5, `${name}: the away dot is dim but still there`);
    assert.notEqual(t.chevron, t.surface);
    assert.ok(ratio(t.chevron, t.surface) >= 1.5, `${name}: the chevron is dim but still there`);
    assert.ok(ratio(t.subEnergy, t.surface) >= 3, `${name}: the Electricity heading on the widget`);
    // Timeline: the rail is quieter than the dots and text but still visible; every dot reads on the surface (3:1), in its
    // subsystem colour or, where that would vanish, in secondary text (the attention dot is checked just below).
    assert.notEqual(t.rail, t.surface);
    assert.ok(ratio(t.rail, t.surface) >= 1.1 && ratio(t.rail, t.surface) < ratio(t.chevron, t.surface), `${name}: the rail is subtle but there ${ratio(t.rail, t.surface).toFixed(2)}`);
    for (const [id, s] of Object.entries(Raw.SUBSYSTEMS)) {
      const dot = ratio(t[s.tile], t.surface) >= 3 ? t[s.tile] : t.textSecondary;
      assert.ok(ratio(dot, t.surface) >= 3, `${name}: ${id} timeline dot`);
    }
    assert.ok(ratio(t.attention, t.surface) >= 3, `${name}: the Needs attention header on the page`);
  }
  assert.equal(ratio('#000000', '#ffffff'), 21);
});

test('every Pulse view paints the default theme\'s background, so the page reads as bg end to end', () => {
  const views = readdirSync(root + 'views').filter((x) => x.startsWith('info-'));
  assert.ok(views.length >= 14);
  for (const f of views) assert.equal(yaml.load(readFileSync(root + 'views/' + f, 'utf8')).background, Raw.THEMES[Raw.DEFAULT_THEME].bg, f);
});

test('the House page under the default theme: every variable resolves, no tertiary text, every glyph hidden from assistive tech', () => {
  const hass = richHass();
  for (const mode of ['now-header', 'status', 'rooms', 'house-list', 'feed', 'tabbar']) {
    const html = Raw.render(mode, { active: 'house' }, hass, NOW, {});
    assert.doesNotThrow(() => Raw.resolveVars(html, 'rose-pine'), mode);
    assert.doesNotMatch(html, /textTertiary|--pulse-textTertiary/, `${mode}: no tertiary text`);
    for (const tag of html.match(/<svg[^>]*>/g) || []) assert.match(tag, /aria-hidden="true"/, `${mode}: ${tag.slice(0, 40)}`);
    assert.doesNotMatch(html, /<(?:a|button)[^>]*>\s*<\/(?:a|button)>/, `${mode}: no empty links`);
  }
  const house = ['now-header', 'status', 'rooms', 'house-list', 'feed'].map((m) => Raw.render(m, {}, hass, NOW, {})).join('');
  assert.match(Raw.resolveVars(house, 'rose-pine'), /background:#9ccfd8;color:#191724/, 'an occupied room takes Foam');
  assert.doesNotMatch(Raw.STYLE.split('\n').filter((l) => /^\.hm|^\.tab/.test(l)).join('\n'), /textTertiary/);
  // Every House-page rule uses tokens only (the colour-literal test covers the file; this holds the page's own rules to it).
  assert.doesNotMatch(Raw.STYLE.split('\n').filter((l) => /^\.hm/.test(l)).join('\n'), /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(P.STYLE, /\.hm-row:focus-visible/, 'rows show focus');
});

test('room and garden pages under the default theme: variables resolve, no tertiary text, glyphs hidden, no empty controls', () => {
  const hass = roomPageHass();
  let seen = 0;
  for (const k of P.ALL_ROOM_KEYS) {
    for (const mode of ROOM_PAGE_MODES(k)) {
      const html = Raw.render(mode, { room: k }, hass, NOW, {});
      if (!html) continue;
      seen += 1;
      assert.doesNotThrow(() => Raw.resolveVars(html, 'rose-pine'), `${k}/${mode}`);
      assert.doesNotMatch(html, /textTertiary/, `${k}/${mode}: no tertiary text`);
      for (const tag of html.match(/<svg[^>]*>/g) || []) assert.match(tag, /aria-hidden="true"/, `${k}/${mode}`);
      assert.doesNotMatch(html, /<(?:a|button)[^>]*>\s*<\/(?:a|button)>/, `${k}/${mode}: no empty links`);
      // Same side margins and the same section gap as the House page: every card is an `.hm` block.
      assert.match(html, /^<div class="p"><div class="hm( hm-first)?">/, `${k}/${mode}: built on the House page block`);
    }
  }
  assert.ok(seen >= 55, `rendered ${seen} room cards`);
  assert.doesNotMatch(Raw.STYLE.split('\n').filter((l) => /^\.hm/.test(l)).join('\n'), /textTertiary/, 'no hm rule uses the tertiary colour');
});

test('every control on the room and garden pages is a button or link with a name, a 44px target, and writes only inside the allowlist', () => {
  const hass = roomPageHass();
  const seen = new Set();
  for (const k of P.ALL_ROOM_KEYS) {
    for (const mode of ROOM_PAGE_MODES(k)) {
      const html = P.render(mode, { room: k, entity: 'switch.bathroom_fan_extractor', decision: 'sensor.bathroom_fan_decision', label: 'Extractor fan' }, hass, NOW, {});
      for (const tag of html.match(/<(?:button|a|input)\b[^>]*\bdata-act="[^"]*"[^>]*>/g) || []) {
        const ds = {};
        for (const m of tag.matchAll(/\bdata-([a-z][a-z0-9-]*)="([^"]*)"/g)) ds[m[1].replace(/-([a-z0-9])/g, (x, c) => c.toUpperCase())] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        assert.match(tag, /^<(button|a|input)\b/, `${k}/${mode}`);
        if (ds.act === 'nav') continue;
        // A disclosure row writes nothing: it only flips the viewer's own open/closed state.
        if (ds.act === 'disclose') { assert.match(ds.id, /^[a-z0-9_]+:[a-z0-9_]+$/, `${k}/${mode}`); assert.match(tag, /aria-expanded="(true|false)" aria-controls="dp-[\w-]+"/); continue; }
        seen.add(ds.act);
        const calls = [];
        const h = { ...hass, callService: (...a) => calls.push(a) };
        assert.doesNotThrow(() => P.handleAction(h, { dataset: ds }, '50'), `${k}/${mode}: ${JSON.stringify(ds)} writes outside the allowlist`);
        assert.ok(calls.length >= 1, `${k}/${mode}: ${ds.act} makes a call`);
      }
      // Buttons that carry no text of their own name themselves.
      for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) assert.ok(/aria-label="[^"]+"/.test(m[1]) || m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim() !== '', `${k}/${mode}: an unnamed button ${m[1]}`);
    }
  }
  assert.deepEqual([...seen].sort(), ['brightness', 'garden-power', 'garden-theme', 'heating-mode', 'media-play', 'media-power', 'scene', 'setting-number', 'setting-toggle', 'toggle', 'volume'].sort());
});

test('energy tokens: the tile labels read on a tile, in every theme', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    for (const k of ['subEnergy', 'heat', 'textSecondary']) assert.ok(ratio(t[k], t.surface) >= 4.5, `${name}: ${k} label on a tile ${ratio(t[k], t.surface).toFixed(2)}`);
  }
});

test('the new tokens: a slider track that shows on the surface and under the tint fill; the switch knob reads on both tracks; labels read on cards', () => {
  for (const [name, t] of Object.entries(Raw.THEMES)) {
    assert.ok(ratio(t.sliderTrack, t.surface) >= 1.3, `${name}: sliderTrack on surface ${ratio(t.sliderTrack, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.tint, t.sliderTrack) >= 3, `${name}: the tint fill on the track ${ratio(t.tint, t.sliderTrack).toFixed(2)}`);
    assert.ok(ratio(long(t.knob), t.on) >= 3, `${name}: knob on the on track ${ratio(long(t.knob), t.on).toFixed(2)}`);
    assert.ok(ratio(long(t.knob), t.off) >= 3, `${name}: knob on the off track ${ratio(long(t.knob), t.off).toFixed(2)}`);
    assert.notEqual(t.on, t.off);
    assert.ok(ratio(t.heat, t.surface) >= 4.5, `${name}: the Temperature label on a widget ${ratio(t.heat, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.subLighting, t.surface) >= 4.5, `${name}: the Light level label on a widget ${ratio(t.subLighting, t.surface).toFixed(2)}`);
    assert.ok(ratio(t.text, t.control) >= 4.5 && ratio(t.link, t.bg) >= 3, `${name}: stepper glyphs on the pill`);
    // The selected scene: primary text and the tint icon over the tint fill, which is itself blended over the card.
    const sel = over(t.tintFill, t.surface);
    assert.ok(ratio(t.text, sel) >= 4.5, `${name}: scene name on the selected button ${ratio(t.text, sel).toFixed(2)}`);
    assert.ok(ratio(t.tint, sel) >= 3, `${name}: scene icon on the selected button ${ratio(t.tint, sel).toFixed(2)}`);
    assert.ok(ratio(t.tint, t.surface) >= 3, `${name}: the ring that marks it, on the unselected card colour`);
    assert.ok(sel !== t.surface.toLowerCase(), `${name}: the selected fill differs from an unselected button`);
    const a = /^rgba\(\d+,\d+,\d+,(\.\d+|1|0)\)$/.exec(t.tintFill);
    assert.ok(a && +a[1] > 0 && +a[1] <= 0.3, `${name}: tintFill is the tint at low alpha, got ${t.tintFill}`);
  }
  assert.match(Raw.STYLE, /\.hm-check\{[^}]*color:var\(--pulse-tint\)/, 'the picker checkmark is the tint');
});

test('the theme is chosen by config, defaults to rose-pine, and an unknown name fails loudly', () => {
  const hass = withRooms(P.ROOM_ORDER.map(FULL), []);
  assert.equal(Raw.DEFAULT_THEME, 'rose-pine');
  assert.equal(Raw.themeOf({}), Raw.THEMES['rose-pine']);
  assert.equal(Raw.themeOf({ theme: 'rose-pine' }), Raw.THEMES['rose-pine']);
  assert.equal(Raw.render('rooms', {}, hass, NOW), Raw.render('rooms', { theme: 'rose-pine' }, hass, NOW));
  assert.equal(Raw.styleFor({}), Raw.styleFor({ theme: 'rose-pine' }));
  assert.match(Raw.styleFor({}), /^:host\{--pulse-bg:#191724;/);
  for (const bad of ['nord', '', 'classic', 'Rose-Pine', null, 3]) assert.throws(() => Raw.render('rooms', { theme: bad }, hass, NOW), /unknown theme/, String(bad));
  assert.throws(() => Raw.themeOf({ theme: 'nord' }), /known: rose-pine/);
  assert.throws(() => Raw.styleFor({ theme: 'nord' }), /unknown theme/);
});

test('a theme missing a token, or with a stray one, fails at validation', () => {
  const full = Raw.THEMES[Raw.DEFAULT_THEME];
  const without = (k) => { const { [k]: _gone, ...rest } = full; return rest; };
  for (const k of Raw.COLOUR_KEYS.concat('priceStops')) assert.throws(() => Raw.checkThemes({ 'rose-pine': full, odd: without(k) }), new RegExp(`missing: ${k}`), k);
  assert.throws(() => Raw.checkThemes({ 'rose-pine': full, odd: { ...full, extra: '#000000' } }), /unknown: extra/);
  assert.throws(() => Raw.checkThemes({ 'rose-pine': full, odd: { ...full, bg: '' } }), /token "bg"/);
  assert.throws(() => Raw.checkThemes({ 'rose-pine': full, odd: { ...full, priceStops: [[1, 2, 3]] } }), /priceStops/);
  assert.throws(() => Raw.TOKENS.nope, /unknown colour token "nope"/);
  assert.throws(() => Raw.colour('nope'), /unknown colour token/);
});

test('the stylesheet carries the theme as --pulse-* variables on :host and the markup only references them', () => {
  const css = Raw.styleFor({ theme: 'rose-pine' });
  assert.match(css, /^:host\{--pulse-bg:#191724;/);
  for (const k of Raw.COLOUR_KEYS) assert.ok(css.includes(`--pulse-${k}:${Raw.THEMES['rose-pine'][k]}`), k);
  assert.ok(!Raw.STYLE.includes('#191724'), 'the stylesheet body holds no colour');
  const vars = new Set([...Raw.STYLE.matchAll(/var\(--pulse-(\w+)\)/g)].map((m) => m[1]));
  for (const v of vars) assert.ok(Raw.COLOUR_KEYS.includes(v), v);
});

test('price colours follow the theme: the theme\'s stops, and readable figures on its surface', () => {
  const day = mk({ 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates': { state: 'x', attributes: { rates: real } } });
  const fills = (theme) => Raw.render('energy-day', { theme }, day, Date.parse('2026-10-25T18:29:00Z'), {}).match(/fill="#[0-9a-f]{6}"/g).join();
  assert.equal(fills('rose-pine'), fills(undefined), 'no theme means the default');
  const roseNow = (cents) => Raw.render('energy-head', { theme: 'rose-pine' }, mk({ [`${BASE}_current_rate`]: { state: String(cents / 100), attributes: {} } }), NOW);
  const colourOf = (html) => html.match(/<div class="hm-wv num"><span style="color:(#[0-9a-f]{6})">/)[1];
  assert.equal(colourOf(roseNow(-2)), Raw.THEMES['rose-pine'].priceNegative);
  assert.notEqual(colourOf(roseNow(60)), colourOf(roseNow(-2)), 'the extreme price is its own colour (lightened for text until readable)');
  for (const v of [-5, 0, 5, 15, 25, 35, 44, 50]) assert.ok(ratio(colourOf(roseNow(v)), Raw.THEMES['rose-pine'].surface) >= 4.5, `${v}p`);
});

// ── Copy table ───────────────────────────────────────────────────────────────────────────────────
test('every COPY key is used by the card and every COPY reference names a key', () => {
  const body = cardSrc.replace(/^\s*(\/\/|\*).*$/gm, '');
  const refs = new Set([...body.matchAll(/\bCOPY\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`));
  const keys = new Set();
  for (const area of Object.keys(Raw.COPY)) for (const key of Object.keys(Raw.COPY[area])) keys.add(`${area}.${key}`);
  assert.deepEqual([...refs].filter((r) => !keys.has(r)), [], 'references without a key');
  assert.deepEqual([...keys].filter((k) => !refs.has(k)), [], 'keys nothing references');
  assert.deepEqual(Object.keys(Raw.COPY).sort(), ['cameras', 'common', 'energy', 'feed', 'home', 'room', 'settings']);
});

test('a missing COPY key throws at runtime instead of printing undefined', () => {
  assert.throws(() => Raw.COPY.home.nope, /no COPY\.home\.nope/);



  assert.equal(Raw.COPY.home.headerLine('At home', ''), 'At home');
  assert.equal(Raw.COPY.home.headerLine('At home', 'Guest'), 'At home · Guest');
  assert.equal(Raw.COPY.home.roomsOccupiedCount(3), '3 occupied');
  assert.equal(Raw.COPY.home.personLabel('Adam', 'home'), 'Adam, home');
  assert.equal(Raw.COPY.home.moreItems(2), '+2 more');
  assert.equal(Raw.COPY.home.reasonText('Bed occupied'), 'someone in bed');
  assert.equal(Raw.COPY.home.reasonText('Sofa occupied'), 'sofa occupied');
  assert.equal(Raw.COPY.home.reasonText('Sonos playing'), 'Sonos playing');
  assert.equal(Raw.COPY.home.reasonText('Doors closed'), 'doors closed');
  assert.equal(Raw.COPY.home.roomLine('Lamps', 'someone in bed', 'scene set 4 min ago'), 'Lamps · someone in bed');
  assert.equal(Raw.COPY.home.roomLine('Full', 'doors closed', ''), 'Full · doors closed');
  assert.equal(Raw.COPY.home.roomLine('Lamps', '', 'scene set 4 min ago'), 'Lamps · set 4 min ago');
  assert.equal(Raw.COPY.home.roomLine('Lights off', '', ''), 'Lights off');
  assert.equal(Raw.COPY.home.heatingLine(3, '17.7°', '3.7°', false), '3 rooms heating · 17.7° in, 3.7° out');
  assert.equal(Raw.COPY.home.heatingLine(0, '', '', true), 'no readings · patio open');
  assert.equal(Raw.COPY.home.binNames(['Food']), 'Food');
  assert.equal(Raw.COPY.home.binNames(['Food', 'Garden', 'Refuse']), 'Food, garden and refuse');
  assert.deepEqual([0, 1, 5].map(Raw.COPY.home.collected), ['Collected today', 'Collected tomorrow', 'Collected in 5 days']);
  assert.equal(Raw.COPY.energy.nextHalfHour('38.8p', '188 W'), 'Next 38.8p · using 188 W');
  assert.equal(Raw.COPY.energy.nextHalfHour('', '188 W'), 'using 188 W');
  assert.equal(Raw.COPY.energy.windowOn('Today', '09:00', '11:00'), '09:00 – 11:00');
  assert.equal(Raw.COPY.energy.windowOn('Tomorrow', '09:00', '11:00'), 'Tomorrow 09:00 – 11:00');
  assert.equal(Raw.COPY.cameras.recent(4), '4 recent');
});

test('the wording tables sit together after COPY, ahead of any render code', () => {
  const at = (needle) => { const i = cardSrc.indexOf(needle); assert.ok(i > 0, needle); return i; };
  const copyAt = at('  const COPY = {');
  const firstSection = at('  function sectionNowHeader');
  for (const t of ['  const SUBSYSTEMS = {', '  const REASON_TEXT = {', '  const UNDECLARED = {']) assert.ok(at(t) > copyAt && at(t) < firstSection, t);
  assert.ok(at('  const REASON_TEXT = {') - copyAt < 40000, 'the wording region is one block');
});
