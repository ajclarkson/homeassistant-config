// Pulse card tests: cameras. Run: cd tests && npm test (or node --test cameras.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, mk, rowOf, rowTitle, rowSub, count, decl, px, rule, b, ratio, over } from './helpers.mjs';

// The native rhythm of the Cameras page.
const camHass = (over = {}) => {
  const c = (st) => ({ state: st, attributes: {} });
  return mk({ 'switch.parlour_privacy': c('on'), 'switch.kitchen_privacy': c('off'), 'switch.home_office_privacy': c('unavailable'), 'binary_sensor.kitchen_person_occupancy': c('off'), 'sensor.house_active_mode': c('normal'), 'button.kitchen_move_up': c('unknown'), 'button.kitchen_move_down': c('unknown'), ...over });
};

test('cameras: per-camera status from the privacy switch, master state ignores the group, house-mode rule and offline camera shown', () => {
  const b = (st, extra = {}) => ({ state: st, attributes: {}, ...extra });
  const base = {
    'switch.parlour_privacy': b('on'), 'switch.kitchen_privacy': b('on'), 'switch.home_office_privacy': b('on'),
    'group.cameras_privacy': b('off'),
  };
  const allOff = mk({ ...base, 'sensor.house_active_mode': b('normal') });
  const head = P.render('cameras-head', {}, allOff, NOW);
  assert.match(head, />Cameras</);
  assert.match(head, /All cameras off/, 'a lying group state does not make cameras look on');
  assert.match(head, /House is at home · cameras off/);
  assert.doesNotMatch(head, /Set by hand/);
  assert.match(head, /data-act="cameras-all"[^>]*aria-pressed="false"/);
  assert.match(P.render('camera', { camera: 'kitchen' }, allOff, NOW), /Privacy on/);

  const sleep = mk({ ...base, 'switch.kitchen_privacy': b('off'), 'binary_sensor.kitchen_person_occupancy': b('on'), 'sensor.house_active_mode': b('sleep') });
  assert.match(P.render('cameras-head', {}, sleep, NOW), /Kitchen on/);
  assert.match(P.render('cameras-head', {}, sleep, NOW), /only the kitchen camera is on, for Mo/);
  assert.doesNotMatch(P.render('cameras-head', {}, sleep, NOW), /Set by hand/);
  const kitchen = P.render('camera', { camera: 'kitchen' }, sleep, NOW);
  assert.match(kitchen, /Person in view<\/div><\/div><span class="hm-val num">Live</);
  assert.match(kitchen, /data-act="camera-toggle" data-camera="kitchen" aria-pressed="true"/);
  assert.match(kitchen, /data-stream="kitchen"/, 'a live camera has a stream slot');
  assert.doesNotMatch(P.render('camera', { camera: 'parlour' }, sleep, NOW), /data-stream/, 'no stream slot while privacy is on');

  const hand = mk({ ...base, 'switch.parlour_privacy': b('off'), 'sensor.house_active_mode': b('normal') });
  const handHead = P.render('cameras-head', {}, hand, NOW);
  assert.match(handHead, /Set by hand<\/div><div class="hm-rs">Usually off while someone&#39;s home</, 'what the house mode would normally do is the second line');

  const guestAway = mk({ ...base, 'sensor.house_active_mode': b('away'), 'input_select.house_active_mode_modifier': b('guest') });
  assert.match(P.render('cameras-head', {}, guestAway, NOW), /guest is staying/);
  assert.doesNotMatch(P.render('cameras-head', {}, guestAway, NOW), /Set by hand/);

  const offline = mk({ ...base, 'switch.home_office_privacy': b('unavailable', { last_changed: '2026-10-26T12:00:00+00:00' }), 'sensor.house_active_mode': b('normal') });
  const oh = P.render('cameras-head', {}, offline, NOW);
  assert.match(oh, /Home office offline/);
  assert.match(oh, /class="hm-rt" style="color:#eb6f92;font-weight:600">Home office offline</, 'offline is said in the attention colour, not a banner');
  const oc = P.render('camera', { camera: 'home_office' }, offline, NOW);
  assert.match(oc, /Offline/);
  assert.doesNotMatch(oc, /data-act="camera-toggle"/, 'no switch for an offline camera');
  const now = P.render('house-list', {}, offline, NOW);
  assert.match(now, new RegExp(`data-path="${P.CAMERAS_PATH}"`));
  assert.match(now, /Home office offline/);
  assert.equal(count(P.render('house-list', {}, { states: {} }, NOW), /data-path="\/pulse-dashboard\/cameras"/g), 0, 'no camera entities, no cameras row');
  assert.throws(() => P.render('camera', { camera: 'garage' }, allOff, NOW), /known camera/);
});

test('cameras-all turns every readable camera off when any is live, otherwise on; writes only switch services', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const calls = [];
  const run = (states) => { calls.length = 0; P.handleAction({ states, callService: (d, s, data) => calls.push(`${d}.${s}:${data.entity_id}`) }, { dataset: { act: 'cameras-all' } }); return calls.slice(); };
  assert.deepEqual(run({ 'switch.parlour_privacy': b('off'), 'switch.kitchen_privacy': b('on'), 'switch.home_office_privacy': b('unavailable') }),
    ['switch.turn_on:switch.parlour_privacy', 'switch.turn_on:switch.kitchen_privacy']);
  assert.deepEqual(run({ 'switch.parlour_privacy': b('on'), 'switch.kitchen_privacy': b('on'), 'switch.home_office_privacy': b('on') }),
    ['switch.turn_off:switch.parlour_privacy', 'switch.turn_off:switch.kitchen_privacy', 'switch.turn_off:switch.home_office_privacy']);
});

test('cameras page is registered, linked from Now, and keeps its tab bar last', () => {
  assert.match(readFileSync(root + 'info-dashboard.yaml', 'utf8'), /views\/info-cameras\.yaml/);
  const v = yaml.load(readFileSync(root + 'views/info-cameras.yaml', 'utf8'));
  assert.equal(v.path, 'cameras');
  const cards = v.sections[0].cards;
  assert.equal(cards[0].mode, 'cameras-head');
  assert.equal(cards[cards.length - 1].mode, 'tabbar');
  assert.deepEqual(cards.filter((c) => c.mode === 'camera').map((c) => c.camera), ['parlour', 'kitchen', 'home_office']);
  assert.ok(!JSON.stringify(v).includes('camera-events-card'), 'the page is native; the old card is not embedded');
});

test('camera toggle is a request: pending until the state arrives, repeat taps ignored, a silent camera says so', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const calls = [];
  const mkh = (priv) => ({ states: { 'switch.kitchen_privacy': b(priv), 'binary_sensor.kitchen_person_occupancy': b('off') }, callService: (d, sv, data) => calls.push(`${d}.${sv}:${data.entity_id}`) });
  const ui = { pending: {}, cam: { rec: {} } };
  const T0 = NOW;
  // live (privacy off): a tap asks for privacy on
  P.cameraToggle(mkh('off'), ui, 'kitchen', T0);
  assert.deepEqual(calls, ['switch.turn_on:switch.kitchen_privacy']);
  // second tap 2 s later, state has not moved: ignored, and the card says it is waiting
  P.cameraToggle(mkh('off'), ui, 'kitchen', T0 + 2000);
  assert.equal(calls.length, 1);
  const waiting = P.render('camera', { camera: 'kitchen' }, mkh('off'), T0 + 2000, ui);
  assert.match(waiting, /Turning off…/);
  assert.match(waiting, /aria-busy="true"/);
  // state arrives: pending clears itself
  assert.match(P.render('camera', { camera: 'kitchen' }, mkh('on'), T0 + 3000, ui), /Privacy on/);
  assert.equal(P.cameraPending(ui, mkh('on'), 'kitchen', T0 + 3000), null);
  assert.deepEqual({ ...P.cameraPending(ui, mkh('off'), 'kitchen', T0 + 3000) }, { waiting: true, timedOut: false, want: 'private' });
  // never arrives: after PENDING_MS it says so and a tap tries again
  const late = P.render('camera', { camera: 'kitchen' }, mkh('off'), T0 + P.PENDING_MS + 1, ui);
  assert.match(late, /No response/);
  assert.match(late, /It did not change, tap to try again/);
  P.cameraToggle(mkh('off'), ui, 'kitchen', T0 + P.PENDING_MS + 1);
  assert.equal(calls.length, 2);
  // an offline camera cannot be toggled; unknown cameras throw
  assert.equal(P.cameraToggle({ states: { 'switch.kitchen_privacy': b('unavailable') }, callService: () => assert.fail('called') }, { pending: {}, cam: { rec: {} } }, 'kitchen', T0), undefined);
  assert.throws(() => P.cameraToggle(mkh('off'), ui, 'garage', T0), /unknown camera/);
});

test('cameras page: head is the large title with the camera state as its subtitle, then one grouped list; no banner, pill or uppercase label', () => {
  const head = P.render('cameras-head', {}, camHass(), NOW);
  assert.match(head, /^<div class="p"><div class="hm hm-first"><div class="hm-head"><div class="hm-hd"><h1 class="hm-big">Cameras<\/h1><span class="hm-line">Kitchen on<\/span><\/div><\/div><section class="hm-sec hm-tight"><div class="hm-list plain">/);
  assert.doesNotMatch(head, /Back to House|data-act="nav"|class="card|class="tag|class="lbl|class="dot|text-transform/);
  assert.match(head, /Cameras<\/div><div class="hm-rs">House is at home · cameras off/, 'the master switch says which rule of the house mode applies');
  assert.match(head, /<span class="hm-sw" aria-hidden="true"><\/span>/, 'a native switch');
  assert.doesNotMatch(head, /Tap to turn/, 'the switch needs no instructions');
  assert.match(head, /Home office offline<\/div><\/div><\/div>/, 'offline is a row, in the attention colour');
  // Every camera offline: no master switch to flip, but the title and the offline row stay.
  const gone = { state: 'unavailable', attributes: {} };
  const none = P.render('cameras-head', {}, mk({ 'switch.parlour_privacy': gone, 'switch.kitchen_privacy': gone, 'switch.home_office_privacy': gone }), NOW);
  assert.doesNotMatch(none, /cameras-all/);
  assert.match(none, /Parlour, Kitchen, Home office offline/);
});

test('cameras page: each camera is one card, the picture first at its natural size, then name, state, switch, pan/tilt and recordings in list style', () => {
  const live = P.render('camera', { camera: 'kitchen' }, camHass(), NOW);
  assert.match(live, /^<div class="p"><div class="hm"><div class="hm-list"><div class="stream" data-stream="kitchen"><\/div><div class="hm-row">/, 'the stream is the first thing in the list; the list clips it to the card corners');
  assert.match(live, /<div class="hm-rt">Kitchen<\/div><div class="hm-rs">No one in view<\/div><\/div><span class="hm-val num">Live<\/span>/);
  assert.match(live, /<button type="button" class="hm-row hm-btn tap" data-act="camera-toggle" data-camera="kitchen" aria-pressed="true"><div class="hm-text"><div class="hm-rt">Camera on<\/div><\/div><span class="hm-sw" aria-hidden="true"><\/span><\/button>/, 'a native toggle with no instructions');
  assert.match(live, /class="ptz"/);
  assert.match(live, /data-act="camera-rec" data-camera="kitchen" aria-expanded="false"[^>]*><div class="hm-text"><div class="hm-rt">Recordings<\/div><div class="hm-rs">Clips of people and movement<\/div><\/div><span class="hm-chev"/);
  const priv = P.render('camera', { camera: 'parlour' }, camHass(), NOW);
  assert.doesNotMatch(priv, /data-stream|class="ptz"/);
  assert.match(priv, /Camera is off<\/div><\/div><span class="hm-val num">Privacy on<\/span>/);
  assert.match(priv, /<span class="hm-sw off" aria-hidden="true">/);
  const off = P.render('camera', { camera: 'home_office' }, camHass(), NOW);
  assert.match(off, /<span class="hm-val num">Offline<\/span>/);
  assert.doesNotMatch(off, /camera-toggle/);
  for (const html of [live, priv, off]) assert.doesNotMatch(html, /class="tag|class="card|class="tog|class="clip|class="lbl| · /);
  // Layout, asserted from the CSS (there is no browser here): the stream clips to the list's radius, keeps a 16:9
  // box until the picture is there and then grows to the picture's own shape, and the hidden slot really hides.
  assert.equal(px(decl(rule('.hm-list').body, 'border-radius')), 12);
  assert.match(decl(rule('.hm-list').body, 'overflow'), /hidden/);
  assert.equal(decl(rule('.stream ha-camera-stream').body, 'width'), '100%');
  assert.equal(decl(rule('.stream').body, 'aspect-ratio'), '16/9');
  assert.equal(decl(rule('.stream[hidden]').body, 'display'), 'none');
  assert.match(readFileSync(root + 'www/pulse-card.js', 'utf8'), /<div class="p"><div class="hm"><div class="hm-list"><div class="stream" id="cam-stream" hidden><\/div><div id="cam-rest"><\/div><\/div><\/div><\/div>/, 'the element shell matches the static markup');
});

test('cameras page: recordings open in the same list, each clip a row with a thumbnail, a time, what was seen and a play arrow', () => {
  const hass = camHass();
  const clip = { id: 'a1', mediaId: 'x', start: NOW - 600000, label: 'person', zones: ['patio'] };
  const open = P.render('camera', { camera: 'kitchen' }, hass, NOW, { cam: { pending: {}, rec: { kitchen: { open: true, status: 'ok', items: [clip] } } } });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<div class="hm-dp"><button type="button" class="hm-row hm-btn tap" data-act="camera-clip" data-camera="kitchen" data-clip="a1"><img class="hm-thumb"[^>]*><div class="hm-text"><div class="hm-rt">10 min ago<\/div><div class="hm-rs">Person, patio<\/div><\/div><span class="hm-chev"/);
  assert.equal(px(decl(rule('.hm-thumb').body, 'width')), 72);
  assert.equal(px(decl(rule('.hm-thumb').body, 'height')), 48);
  assert.match(P.render('camera', { camera: 'kitchen' }, hass, NOW, { cam: { pending: {}, rec: { kitchen: { open: true, status: 'error', items: [] } } } }), /<div class="hm-dp"><div class="hm-row"><div class="hm-text"><div class="hm-rs">Couldn&#39;t load recordings<\/div><\/div><\/div><button[^>]*data-act="camera-rec-refresh"[^>]*><div class="hm-text"><div class="hm-rt" style="color:#7aa2f7;font-weight:600">Try again/);
});

test('cameras page: cards are spaced by the shared section gap and only the title card is flush at the top', () => {
  const html = ['parlour', 'kitchen', 'home_office'].map((k) => P.render('camera', { camera: k }, camHass(), NOW));
  for (const h of html) assert.doesNotMatch(h, /hm-first/);
  assert.match(P.render('cameras-head', {}, camHass(), NOW), /class="hm hm-first"/);
  assert.match(P.STYLE, /\.hm\{[^}]*margin-top:max\(0px,calc\(36px - var\(--row-gap,8px\)\)\)/);
  assert.match(P.STYLE, /\.ptz\{[^\n]*border-top:\.5px solid/, 'the pan/tilt pad uses the list hairline');
});

test('camera pan/tilt writes only that camera\'s move buttons; the pad hides when none are available', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const live = (extra) => ({ states: { 'switch.parlour_privacy': b('off'), ...extra } });
  assert.doesNotMatch(P.render('camera', { camera: 'parlour' }, mk({ ...live({}).states, 'button.parlour_move_up': b('unavailable') }), NOW), /class="ptz"/);
  const some = mk({ ...live({}).states, 'button.parlour_move_up': b('unknown'), 'button.parlour_move_left': b('unknown'), 'button.parlour_move_right': b('unknown'), 'button.parlour_move_down': b('unknown') });
  assert.match(P.render('camera', { camera: 'parlour' }, some, NOW), /class="ptz"/);
  const calls = [];
  const h = { states: {}, callService: (d, s, data) => calls.push(`${d}.${s}:${data.entity_id}`) };
  P.handleAction(h, { dataset: { act: 'camera-ptz', camera: 'home_office', dir: 'left' } });
  assert.deepEqual(calls, ['button.press:button.home_office_move_left']);
  assert.throws(() => P.handleAction(h, { dataset: { act: 'camera-ptz', camera: 'garage', dir: 'up' } }), /unknown pan\/tilt/);
  assert.throws(() => P.handleAction(h, { dataset: { act: 'camera-ptz', camera: 'parlour', dir: 'reboot' } }), /unknown pan\/tilt/);
});

test('camera recordings: Frigate clips are parsed defensively and rendered as loading, empty, error and list states', () => {
  const ev = (id, over = {}) => ({ media_content_id: `media-source://frigate/x/${id}`, frigate: { event: { id, has_clip: true, start_time: (NOW - 600000) / 1000, label: 'person', zones: ['patio'], ...over } } });
  const clips = P.parseClips({ children: [ev('a'), ev('b', { has_clip: false }), { media_content_id: 'x' }, null, ev('c', { zones: undefined, label: '' }), ev('', {})] });
  assert.deepEqual(clips.map((c) => c.id), ['a', 'c']);
  assert.equal(clips[0].mediaId, 'media-source://frigate/x/a');
  assert.equal(clips[1].label, 'movement');
  assert.equal(P.parseClips(null).length, 0);
  assert.equal(P.parseClips({ children: Array.from({ length: 50 }, (_, i) => ev(String(i + 1))) }).length, 20);
  assert.equal(P.frigateClipsId('home_office'), 'media-source://frigate/frigate/event-search/clips////home_office/');
  const b = (st) => ({ state: st, attributes: {} });
  const hass = mk({ 'switch.parlour_privacy': b('on') });
  const at = (rec) => P.render('camera', { camera: 'parlour' }, hass, NOW, { cam: { pending: {}, rec: { parlour: rec } } });
  assert.match(P.render('camera', { camera: 'parlour' }, hass, NOW), /aria-expanded="false"/);
  assert.match(at({ open: true, status: 'loading', items: [] }), /Loading recordings…/);
  assert.match(at({ open: true, status: 'ok', items: [] }), /No recordings yet/);
  assert.match(at({ open: true, status: 'error', items: [] }), /Couldn&#39;t load recordings[\s\S]*data-act="camera-rec-refresh"/);
  const list = at({ open: true, status: 'ok', items: clips });
  assert.match(list, /2 recent/);
  assert.match(list, /data-act="camera-clip" data-camera="parlour" data-clip="a"/);
  assert.match(list, /10 min ago/);
  assert.match(list, /Person, patio/);
  assert.match(list, /snapshot\.jpg/);
  assert.doesNotMatch(list, /<script/i);
});

test('cameras row subtitle gives the reason per state, never restating the title', () => {
  const b = (st) => ({ state: st, attributes: {} });
  const privacy = (on, mode, extra = {}) => mk({ 'switch.parlour_privacy': b(on.parlour ? 'on' : 'off'), 'switch.kitchen_privacy': b(on.kitchen ? 'on' : 'off'), 'switch.home_office_privacy': b(on.home_office ? 'on' : 'off'), 'sensor.house_active_mode': b(mode), ...extra });
  const allPriv = { parlour: 1, kitchen: 1, home_office: 1 };
  const card = (hass) => rowOf(P.render('house-list', {}, hass, NOW), P.CAMERAS_PATH);
  const sub = (hass) => rowSub(card(hass));
  assert.equal(rowTitle(card(privacy(allPriv, 'normal'))), 'All cameras off');
  assert.equal(sub(privacy(allPriv, 'normal')), 'Off while someone&#39;s home');
  assert.equal(sub(privacy({}, 'away')), 'On while the house is away');
  const guestAway = { 'input_select.house_active_mode_modifier': b('guest') };
  assert.equal(sub(privacy(allPriv, 'away', guestAway)), 'Off while a guest is staying');
  assert.equal(sub(privacy({}, 'away', guestAway)), 'Changed by hand · usually off while a guest is staying', 'cameras on with a guest while away is a deviation');
  assert.match(P.render('cameras-head', {}, privacy(allPriv, 'away', guestAway), NOW), /House is away, but a guest is staying · cameras off/);
  assert.equal(sub(privacy({ parlour: 1, home_office: 1 }, 'sleep')), 'Only the kitchen is on overnight, for Mo');
  assert.equal(sub(privacy(allPriv, 'unknown_mode')), 'Following the house mode');
  assert.equal(sub(privacy({ parlour: 1, kitchen: 1 }, 'normal')), 'Changed by hand · usually off while someone&#39;s home');
  for (const hass of [privacy(allPriv, 'normal'), privacy({}, 'away'), privacy({}, 'normal')]) assert.doesNotMatch(sub(hass), /cameras (on|off)/i);
  assert.match(P.render('cameras-head', {}, privacy(allPriv, 'normal'), NOW), /House is at home · cameras off/, 'the Cameras page keeps its fuller wording');
});
