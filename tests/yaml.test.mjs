// Pulse card tests: yaml. Run: cd tests && npm test (or node --test yaml.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { P, root, NOW, FULL, mk, withRooms, renderAll, streamlineVars, substitute, loadYaml, real, b, catalog } from './helpers.mjs';

test('expander-card is gone; Now no longer uses apexcharts', () => {
  for (const f of ['info_templates.yaml', 'info-dashboard.yaml', ...readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((x) => 'views/' + x)]) {
    assert.doesNotMatch(readFileSync(root + f, 'utf8'), /expander-card|lights-title/, f);
  }
  assert.doesNotMatch(readFileSync(root + 'views/info-house.yaml', 'utf8'), /apexcharts-card/, 'House has no apexcharts: energy block is drawn by pulse-card');
});

test('every room and garden view resolves its template with no placeholder left and valid pulse-cards', () => {
  const templates = yaml.load(readFileSync(root + 'info_templates.yaml', 'utf8'));
  for (const t of Object.values(templates)) assert.equal(t.variables, undefined, 'streamline ignores template-level variables');
  const views = readdirSync(root + 'views').filter((x) => /^info-room-/.test(x));
  assert.equal(views.length, P.ALL_ROOM_KEYS.length, 'one room view per room');
  for (const f of views) {
    const call = yaml.load(readFileSync(root + 'views/' + f, 'utf8')).sections[0].cards.find((c) => c.type === 'custom:streamline-card');
    const tpl = templates[call.template];
    assert.ok(tpl, `${f} names a known template`);
    const resolved = substitute(tpl.card, streamlineVars(tpl, call.variables));
    assert.doesNotMatch(JSON.stringify(resolved), /\[\[[^\]]*\]\]/, `${f} leaves no placeholder`);
    const pulse = resolved.cards.filter((c) => c.type === 'custom:pulse-card');
    assert.ok(pulse.length >= 4, `${f} has its pulse-cards`);
    for (const c of pulse) assert.doesNotThrow(() => P.render(c.mode, c, mk(), NOW), `${f} ${c.mode}`);
  }
  // The regression itself: a room that passes no fan must resolve the device card to blank, not "[[fan]]".
  const kitchen = templates.pulse_room;
  const dev = substitute(kitchen.card, streamlineVars(kitchen, { room: 'kitchen' })).cards.find((c) => c.mode === 'device');
  assert.deepEqual([dev.entity, dev.decision, dev.label], ['', '', '']);
});

test('every nav path targets the registered dashboard (/pulse-dashboard) or Mobile, and each Pulse path is a real view', () => {
  assert.equal(P.DASH, '/pulse-dashboard');
  const viewPaths = new Set();
  for (const f of readdirSync(root + 'views').filter((x) => x.startsWith('info-'))) {
    const v = yaml.load(readFileSync(root + 'views/' + f, 'utf8'));
    viewPaths.add(v.path);
    assert.doesNotMatch(readFileSync(root + 'views/' + f, 'utf8'), /\/info-dashboard/, f);
  }
  const rooms = P.ROOM_ORDER.map(FULL);
  const items = P.ALL_ROOM_KEYS.map((k) => ({ room: k, key: k, kind: 'warm_heating', text: '20.0° vs 18° target, heating on', nav: '/x' }));
  const hass = withRooms(rooms, items);
  const out = renderAll(hass);
  let seen = 0;
  for (const [k, html] of Object.entries(out)) {
    for (const m of html.matchAll(/data-path="([^"]*)"/g)) {
      seen += 1;
      const p = m[1];
      assert.ok(p.startsWith(P.DASH + '/'), `${k}: ${p} must start with ${P.DASH}/`);
      assert.ok(viewPaths.has(p.slice(P.DASH.length + 1)), `${k}: ${p} has no matching view path`);
    }
  }
  assert.ok(seen > 15, 'expected nav links in the rendered output');
  assert.doesNotMatch(readFileSync(root + 'www/pulse-card.js', 'utf8'), /\/info-dashboard/);
});

test('dashboard YAML parses', () => {
  for (const f of ['info-dashboard.yaml', 'info_templates.yaml', ...readdirSync(root + 'views').filter((x) => x.startsWith('info-')).map((x) => 'views/' + x)]) loadYaml(f);
});

test('frontend registers the fixed loader, not a versioned card URL', () => {
  const y = readFileSync(root + 'packages/frontend.yaml', 'utf8');
  assert.match(y, /- \/local\/pulse-card-loader\.js\n/);
  assert.doesNotMatch(y, /pulse-card\.js\?v=/);
  assert.match(readFileSync(root + 'www/pulse-card.js', 'utf8'), /Cache busting: none needed/);
});

test('Now v2 changes nothing HA only reads at startup', () => {
  assert.match(readFileSync(root + 'packages/frontend.yaml', 'utf8'), /pulse-card-loader\.js/);
});

test('history, catalogue and feed YAML: one history sensor per location plus house, the catalogue projection, the feed lost by_room and lights', () => {
  const mqtt = yaml.load(readFileSync(root + 'packages/mqtt.yaml', 'utf8')).mqtt.sensor;
  const by = (id) => mqtt.find((x) => x.unique_id === id);
  const locations = [...P.ALL_ROOM_KEYS];
  const catalogLocations = [...locations, 'house']; // whole-house automations publish to sensor.house_history
  for (const loc of new Set(catalog.automations.map((a) => a.location))) assert.ok(catalogLocations.includes(loc), `catalogue location ${loc} is a room, garden or house key in the card`);
  for (const k of locations) {
    const s = by(`${k}_history`);
    assert.ok(s, k);
    assert.deepEqual([s.state_topic, s.json_attributes_topic], [`homerun/${k}/history`, `homerun/${k}/history`]);
    assert.equal(s.name, `${k.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')} History`, 'the entity id is sensor.<location>_history');
  }
  assert.deepEqual([by('house_history').state_topic, by('house_history').json_attributes_topic], ['homerun/history', 'homerun/history']);
  const cat = by('homerun_catalog');
  assert.deepEqual([cat.state_topic, cat.json_attributes_topic], ['homerun/catalog', 'homerun/catalog']);
  assert.match(cat.json_attributes_template, /'acted', 'declined'/, 'only the reasons worth explaining are kept, under the 16 KB recorder cap');
  assert.ok(JSON.stringify(catalog).length > 16384, 'the raw catalogue would exceed the recorder attribute cap');
  for (const s of mqtt.filter((x) => /_history$/.test(x.unique_id))) assert.match(s.value_template, /entries\[0\]\.ts if value_json\.entries else none/, 'an empty history is unknown, not an error');
  assert.ok(!existsSync(root + 'packages/info_surface_feed.yaml'), 'the feed trigger template is gone: House reads sensor.house_history');
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  assert.doesNotMatch(rooms, /info_decision_feed/);
  for (const f of ['info_surface_rooms', 'mqtt']) assert.doesNotThrow(() => yaml.load(readFileSync(root + `packages/${f}.yaml`, 'utf8')), f);
});

test('Pulse page paths: info-dashboard.yaml lists House first then Energy, Settings, Cameras; the old Now path is gone everywhere', () => {
  const dash = readFileSync(root + 'info-dashboard.yaml', 'utf8');
  const includes = [...dash.matchAll(/!include (views\/info-[a-z_-]+\.yaml)/g)].map((m) => m[1]);
  const viewPaths = includes.map((f) => yaml.load(readFileSync(root + f, 'utf8')).path);
  assert.deepEqual(viewPaths.slice(0, 4), ['house', 'energy', 'settings', 'cameras']);
  assert.equal(new Set(viewPaths).size, viewPaths.length, 'view paths are unique');
  assert.equal(yaml.load(readFileSync(root + 'views/info-house.yaml', 'utf8')).title, 'House');
  assert.equal(yaml.load(readFileSync(root + 'views/info-settings.yaml', 'utf8')).title, 'Settings');
  assert.ok(P.ICON.gear && P.ICON.home);
  const files = [...includes, 'info-dashboard.yaml', 'info_templates.yaml', 'www/pulse-card.js', 'wallboard.yaml', 'dashboard.yaml', 'views/home.yaml', 'views/wallboard.yaml', 'views/mo.yaml']
    .concat(readdirSync(root + 'packages').map((f) => 'packages/' + f));
  const known = new Set(viewPaths);
  for (const f of files) {
    const text = readFileSync(root + f, 'utf8');
    assert.doesNotMatch(text, /pulse-dashboard\/now\b/, `${f} references the old Now path`);
    for (const m of text.matchAll(/pulse-dashboard\/([a-z_-]+)/g)) assert.ok(known.has(m[1]), `${f}: /pulse-dashboard/${m[1]} is not a view path`);
  }
  const everyMode = Object.entries(renderAll(withRooms(P.ROOM_ORDER.map(FULL), []))).map(([, html]) => html).join('');
  assert.doesNotMatch(everyMode, /pulse-dashboard\/now\b|Back to Now/);
});

test('room keys agree across the card table, info_rooms and the info-room views', () => {
  const tableKeys = P.ROOM_TABLE.map((r) => r.key);
  assert.equal(new Set(tableKeys).size, tableKeys.length, 'unique keys');
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  const cfgKeys = [...rooms.matchAll(/\{'k': '(\w+)', 'n': '[^']+', 'nav': '([^']+)'/g)].map((m) => m[1]);
  const gardenKeys = P.ROOM_TABLE.filter((r) => r.kind === 'garden').map((r) => r.key);
  assert.deepEqual([...cfgKeys].sort(), P.ROOM_TABLE.filter((r) => r.kind === 'room').map((r) => r.key).sort(), 'info_rooms rooms = table rooms');
  for (const g of gardenKeys) assert.match(rooms, new RegExp(`\\['${g}', '[^']+', '/pulse-dashboard/room-${g}'\\]`), `info_attention garden ${g}`);
  const paths = readdirSync(root + 'views').filter((x) => /^info-room-/.test(x)).map((f) => yaml.load(readFileSync(root + 'views/' + f, 'utf8')).path).sort();
  assert.deepEqual(paths, tableKeys.map((k) => `room-${k}`).sort(), 'views = table');
  // Display order is explicit and unique within each kind; areas are unique (a scene belongs to one room).
  for (const kind of ['room', 'garden']) {
    const orders = P.ROOM_TABLE.filter((r) => r.kind === kind).map((r) => r.order);
    assert.deepEqual([...orders].sort((a, b) => a - b), orders.map((_, i) => i + 1), `${kind} order is 1..n`);
  }
  assert.equal(new Set(P.ROOM_TABLE.map((r) => r.area)).size, tableKeys.length, 'one area per room');
  assert.deepEqual(P.ROOM_ORDER, ['parlour', 'kitchen', 'hallway_downstairs', 'hallway_upstairs', 'bedroom', 'bathroom', 'home_office', 'foreign_office']);
});

test('info_rooms emits only the fields its own template or the card reads', () => {
  const rooms = readFileSync(root + 'packages/info_surface_rooms.yaml', 'utf8');
  for (const gone of ['lights_why', 'lights_ts', "'last'", 'last_ts']) assert.ok(!rooms.includes(gone), gone);
  assert.ok(!/_history/.test(rooms), 'no homerun history read left in info_rooms');
});
