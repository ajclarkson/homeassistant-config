/*
 * Pulse: information-first dashboard cards (custom:pulse-card).
 *
 * One card, many sections: `mode` picks the section and `room` (where relevant) the room, so
 * every room page is the same template with a different room key.
 *
 * Rules this file keeps:
 *  - Rendering is a pure function (render(mode, config, hass, nowMs) -> html string) with no DOM,
 *    so it runs under node (tests/pulse-card.test.mjs).
 *  - Nothing may throw on missing data: every attribute read goes through the safe helpers below,
 *    every list through parseList, every number through num. Missing data renders an honest
 *    empty state, never a made-up value.
 *  - Style tokens live once, in TOKENS / STYLE.
 *  - Write paths are whitelisted in ALLOWED. HA is a read-only consumer of homerun events: this
 *    card never publishes to MQTT and never calls anything but the services below.
 */
(function (root) {
  'use strict';

  // ── Style tokens (single definition) ─────────────────────────────────────────────────────────
  const TOKENS = {
    ground: '#12151a',
    surface: '#1a1f26',
    divider: '#232a33',
    text: '#e8ebef',
    text2: '#a3adba',
    text3: '#8f9aa8',
    amber: '#f2b84b',
    amberBg: '#221d10',
    amberBorder: '#4a3d1c',
    amberTag: '#2b2415',
    ok: '#6fcf97',
    okBg: '#14281d',
    link: '#7aa7ff',
    sceneActive: '#f2c46b',
    sceneActiveText: '#1d1708',
    switchOn: '#3a8f63',
    switchOff: '#3a424d',
  };

  const STYLE = `
:host{display:block}
*{box-sizing:border-box}
.p{font-family:'Inter',system-ui,-apple-system,sans-serif;color:${TOKENS.text};display:flex;flex-direction:column;gap:14px}
a,.tap{color:inherit;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
.card{background:${TOKENS.surface};border-radius:16px;overflow:hidden}
.card.warn{border:1px solid ${TOKENS.amberBorder};background:${TOKENS.amberBg}}
.pad{padding:14px}
.lbl{font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:${TOKENS.text3}}
.dot{width:10px;height:10px;border-radius:50%;background:${TOKENS.ok};flex:none}
.dot.warn{background:${TOKENS.amber}}
.dot.dim{background:${TOKENS.text3}}
.row{display:grid;grid-template-columns:10px 1fr auto;gap:12px;align-items:center;min-height:56px;padding:8px 14px;border-top:1px solid ${TOKENS.divider}}
.row:first-child{border-top:0}
.row.warn{background:#201c10;align-items:start}
.nm{font-size:15px;font-weight:600}
.sub{font-size:12px;color:${TOKENS.text2};margin-top:2px;line-height:1.35}
.t{font-size:17px;font-weight:600;text-align:right}
.rh{font-size:11px;color:${TOKENS.text3};text-align:right}
.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:${TOKENS.surface};font-size:12px;font-weight:600;min-height:32px}
.det{grid-column:2 / 4;display:flex;flex-direction:column;gap:6px;padding:4px 0 6px}
.det .l{display:flex;gap:8px;font-size:12.5px;color:#cfd5dd;line-height:1.4}
.det .l b{color:${TOKENS.amber};font-weight:600}
.tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:${TOKENS.amberTag};color:${TOKENS.amber};white-space:nowrap}
.tag.ok{background:${TOKENS.okBg};color:${TOKENS.ok}}
.tag.off{background:${TOKENS.divider};color:${TOKENS.text2}}
.link{display:flex;align-items:center;min-height:44px;font-size:13px;font-weight:600;color:${TOKENS.link}}
.bins{display:flex;gap:8px}
.bin{flex:1;background:${TOKENS.surface};border-radius:12px;padding:10px 6px;text-align:center;min-height:56px}
.bin .d{font-size:16px;font-weight:700}
.bin .n{font-size:11px;color:${TOKENS.text2};margin-top:2px}
.bin.soon{background:${TOKENS.amberTag}}
.bin.soon .d,.bin.soon .n{color:${TOKENS.amber}}
.feed{display:grid;grid-template-columns:44px 1fr;gap:8px;font-size:12.5px;line-height:1.4;padding:8px 14px;border-top:1px solid ${TOKENS.divider}}
.feed:first-child{border-top:0}
.feed .a{color:${TOKENS.text3}}
.item{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:start;padding:12px 14px;border-top:1px solid ${TOKENS.divider}}
.item:first-child{border-top:0}
.item svg,.ic{width:18px;height:18px;stroke:${TOKENS.text2};fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;margin-top:1px}
.h{font-size:14px;font-weight:600}
.s{font-size:12.5px;color:${TOKENS.text2};margin-top:2px;line-height:1.4}
.tog{display:flex;align-items:center;gap:12px;justify-content:space-between;min-height:56px;padding:6px 14px;border-top:1px solid ${TOKENS.divider};width:100%;background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;font:inherit;text-align:left}
.tog:first-child{border-top:0}
.sw{width:46px;height:28px;border-radius:999px;background:${TOKENS.switchOn};position:relative;flex:none}
.sw::after{content:'';position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;background:#fff}
.sw.off{background:${TOKENS.switchOff}}
.sw.off::after{right:auto;left:3px;background:#c4ccd6}
.tiles{display:grid;gap:8px}
.tile{border:0;font:inherit;border-radius:14px;min-height:64px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600;background:${TOKENS.divider};color:#cfd5dd}
.tile.on{background:${TOKENS.sceneActive};color:${TOKENS.sceneActiveText}}
.lt{display:grid;grid-template-columns:1fr 130px;gap:12px;align-items:center;min-height:56px;padding:6px 14px;border-top:1px solid ${TOKENS.divider}}
.lt:first-child{border-top:0}
.lt input[type=range]{width:100%;height:44px;accent-color:${TOKENS.sceneActive};margin:0}
.round{min-height:44px;min-width:44px;border-radius:999px;border:0;background:${TOKENS.sceneActive};color:${TOKENS.sceneActiveText};display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.big{font-size:32px;font-weight:700;letter-spacing:-.6px;line-height:1.1;margin-top:4px}
.two{display:flex;gap:10px}
.two .card{flex:1}
.note{font-size:11.5px;color:${TOKENS.text3};margin:10px 2px 0;line-height:1.4}
.mrow{display:flex;align-items:flex-start;gap:8px;margin:10px 2px 0}
.mrow span:last-child{font-size:11.5px;color:${TOKENS.text2};line-height:1.4}
`;

  // ── Room configuration (entity ids from views/*.yaml and packages/groups.yaml) ──────────────
  // `report` is the key in sensor.info_rooms; gardens have no report (lights automation only).
  // Gaps, reported rather than guessed: gardens have no individual light ids in the repo;
  // foreign_office has no media player in views/foreign-office.yaml.
  const SCENE_LABELS = {
    off: 'Off', all: 'All', all_full: 'Full', full: 'Full', lamps: 'Lamps', dining: 'Dining',
    cabinets: 'Cabinets', low: 'Low', daylight: 'Daylight', autumn: 'Autumn', halloween: 'Halloween',
  };

  const ROOMS = {
    parlour: {
      name: 'Parlour', short: 'Parlour', report: true,
      climate: 'climate.parlour_trv', temp: 'sensor.parlour_sensor_climate_temperature', hum: 'sensor.parlour_sensor_climate_humidity',
      scenes: ['all', 'lamps', 'dining', 'off'],
      lights: [
        ['light.parlour_light_floor_lamp', 'Floor lamp'], ['light.parlour_light_ceiling_sofa', 'Sofa ceiling'],
        ['light.parlour_light_ceiling_dining', 'Dining ceiling'], ['switch.parlour_plug_table_lamp', 'Table lamp'],
        ['switch.parlour_plug_donut_lamp', 'Donut lamp'],
      ],
      media: [['media_player.parlour', 'Soundbar', 'player'], ['media_player.parlour_tv', 'TV', 'tv']],
    },
    kitchen: {
      name: 'Kitchen', short: 'Kitchen', report: true,
      climate: 'climate.kitchen_trv', temp: 'sensor.kitchen_sensor_climate_temperature', hum: 'sensor.kitchen_sensor_climate_humidity',
      scenes: ['all', 'cabinets', 'off'],
      lights: [['light.kitchen_light_ceiling', 'Ceiling'], ['light.kitchen_light_cooker', 'Cooker'], ['switch.kitchen_light_cabinets', 'Cabinets']],
      media: [['media_player.kitchen', 'Kitchen speaker', 'player']],
    },
    hallway_downstairs: {
      name: 'Hallway downstairs', short: 'Hallway down', report: true,
      climate: 'climate.hallway_downstairs_trv', temp: 'sensor.hallway_downstairs_sensor_climate_temperature', hum: 'sensor.hallway_downstairs_sensor_climate_humidity',
      scenes: ['daylight', 'low', 'off'],
      lights: [['light.hallway_downstairs_light_ceiling', 'Ceiling']],
      media: [],
    },
    hallway_upstairs: {
      name: 'Hallway upstairs', short: 'Hallway up', report: true,
      climate: '', temp: '', hum: '',
      scenes: ['daylight', 'low', 'off'],
      lights: [['light.hallway_upstairs_light_ceiling', 'Ceiling']],
      media: [],
    },
    bedroom: {
      name: 'Bedroom', short: 'Bedroom', report: true,
      climate: 'climate.bedroom_trv', temp: 'sensor.bedroom_sensor_climate_temperature', hum: 'sensor.bedroom_sensor_climate_humidity',
      scenes: ['all', 'all_full', 'lamps', 'off'],
      lights: [['light.bedroom_light_sarah_lamp', "Sarah's lamp"], ['light.bedroom_light_adam_lamp', "Adam's lamp"], ['light.bedroom_light_ceiling', 'Ceiling']],
      media: [],
    },
    bathroom: {
      name: 'Bathroom', short: 'Bathroom', report: true,
      climate: 'climate.bathroom_trv', temp: 'sensor.bathroom_sensor_climate_temperature', hum: 'sensor.bathroom_sensor_climate_humidity',
      scenes: ['full', 'low', 'off'],
      lights: [['light.bathroom_light_ceiling', 'Ceiling']],
      media: [],
    },
    home_office: {
      name: 'Home office', short: 'Home office', report: true,
      climate: 'climate.home_office_trv', temp: 'sensor.home_office_sensor_climate_temperature', hum: 'sensor.home_office_sensor_climate_humidity',
      scenes: ['all', 'lamps', 'off'],
      lights: [['light.home_office_light_desk_lamp', 'Desk lamp'], ['light.home_office_light_floor_lamp', 'Floor lamp'], ['light.home_office_light_ceiling', 'Ceiling']],
      media: [['media_player.home_office', 'Office speaker', 'player']],
    },
    foreign_office: {
      name: 'Foreign office', short: 'Foreign office', report: true,
      climate: 'climate.foreign_office', temp: 'sensor.foreign_office_sensor_climate_temperature', hum: 'sensor.foreign_office_sensor_climate_humidity',
      scenes: ['all', 'off'],
      lights: [['light.dig_uno_v3', 'Lights']],
      media: [],
    },
    back_garden: {
      name: 'Back garden', short: 'Back garden', report: false,
      climate: '', temp: '', hum: '', scenes: ['all', 'off'], lights: [], media: [],
    },
    front_garden: {
      name: 'Front garden', short: 'Front garden', report: false,
      climate: '', temp: '', hum: '', scenes: ['all', 'autumn', 'halloween', 'off'], lights: [], media: [],
    },
  };
  const ROOM_ORDER = [
    'parlour', 'kitchen', 'hallway_downstairs', 'hallway_upstairs', 'bedroom', 'bathroom',
    'home_office', 'foreign_office',
  ];
  const ALL_ROOM_KEYS = Object.keys(ROOMS);

  // Wall-button and other manual sources, in plain words.
  const SOURCE_WORDS = { dashboard: 'dashboard', switch: 'wall switch', wall_button: 'wall button' };

  // Write paths. Anything not listed here is refused loudly.
  const ALLOWED = {
    scene: ['turn_on'],
    light: ['turn_on', 'turn_off'],
    switch: ['turn_on', 'turn_off'],
    media_player: ['media_play_pause', 'volume_set', 'turn_on', 'turn_off'],
    input_boolean: ['turn_on', 'turn_off'],
  };

  const PLUMBING_DECISIONS = ['update_external_temp', 'record'];
  const PLUMBING_AUTOS = ['room_temp_feed', 'outdoor_temp_history'];
  const CHEAP_P = 15;
  const PEAK_P = 38;

  // ── Safe readers ─────────────────────────────────────────────────────────────────────────────
  const num = (v) => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  const esc = (v) => str(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parseList = (v) => {
    if (Array.isArray(v)) return v.filter(isObj);
    if (typeof v === 'string') {
      try {
        const x = JSON.parse(v);
        return Array.isArray(x) ? x.filter(isObj) : [];
      } catch (e) {
        return [];
      }
    }
    return [];
  };
  const strList = (v) => {
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
    if (typeof v === 'string') {
      try {
        const x = JSON.parse(v);
        return Array.isArray(x) ? x.filter((y) => typeof y === 'string' && y) : [];
      } catch (e) {
        return [];
      }
    }
    return [];
  };
  const stateObj = (hass, id) => (id && hass && isObj(hass.states) && isObj(hass.states[id]) ? hass.states[id] : null);
  const state = (hass, id) => {
    const s = stateObj(hass, id);
    return s && typeof s.state === 'string' ? s.state : '';
  };
  const attr = (hass, id, a) => {
    const s = stateObj(hass, id);
    return s && isObj(s.attributes) ? s.attributes[a] : undefined;
  };
  const usable = (s) => s !== '' && s !== 'unknown' && s !== 'unavailable';
  const fmt1 = (n) => (n === null ? '' : n.toFixed(1));
  const plural = (n, one, many) => (n === 1 ? one : many);

  // ── Time ─────────────────────────────────────────────────────────────────────────────────────
  const parseTs = (ts) => {
    const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const hhmm = (ts) => {
    const t = parseTs(ts);
    if (t === null) return '';
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // Age is clamped at 0 so clock skew between HA and the browser never shows "-3 min".
  const ago = (ts, now) => {
    const t = parseTs(ts);
    if (t === null) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };

  // ── Model: sensor.info_rooms entry with the full key set, whatever is missing ───────────────
  const BLANK_ROOM = {
    k: '', n: '', nav: '', occupied: false, occupancy_unavailable: false, unavailable: [],
    temp: null, target: null, mode_target: null, target_reason: '', mode_name: '',
    pres_labels: [], heat_labels: [], humidity: null, hvac_action: null, heating_active: '',
    heating_source: '', lights_on: 0, lights_total: 0, scene: '', lights_enabled: true,
    heating_enabled: null, override: false, ext_open: false, holds: [], reason_text: '',
    override_text: '', labels: [], manual: null, lights_why: '', lights_ts: '', last: '',
    last_ts: '', verdict: '',
  };

  function roomEntry(hass, key) {
    const list = parseList(attr(hass, 'sensor.info_rooms', 'rooms'));
    return list.find((r) => r.k === key) || null;
  }

  function roomModel(hass, key) {
    const cfg = ROOMS[key];
    if (!cfg) throw new Error(`pulse-card: unknown room "${key}"`);
    const e = roomEntry(hass, key) || {};
    const m = { ...BLANK_ROOM };
    for (const k of Object.keys(BLANK_ROOM)) if (e[k] !== undefined && e[k] !== null) m[k] = e[k];
    m.key = key;
    m.cfg = cfg;
    m.hasReport = !!roomEntry(hass, key);
    m.temp = num(e.temp);
    m.target = num(e.target);
    m.mode_target = num(e.mode_target);
    m.humidity = num(e.humidity);
    m.lights_on = Math.max(0, num(e.lights_on) || 0);
    m.lights_total = Math.max(0, num(e.lights_total) || 0);
    for (const k of ['unavailable', 'pres_labels', 'heat_labels', 'labels']) m[k] = strList(e[k]);
    m.holds = parseList(e.holds);
    m.manual = isObj(e.manual) && e.manual.source ? { source: str(e.manual.source), ts: str(e.manual.ts), what: str(e.manual.what) } : null;
    for (const k of ['target_reason', 'mode_name', 'heating_active', 'heating_source', 'scene', 'reason_text', 'override_text', 'lights_why', 'lights_ts', 'last', 'last_ts', 'verdict']) m[k] = str(m[k]);
    m.lights_enabled = e.lights_enabled !== false;
    m.heating_enabled = typeof e.heating_enabled === 'boolean' ? e.heating_enabled : null;
    m.override = !!e.override;
    m.occupied = !!e.occupied;
    m.occupancy_unavailable = !!e.occupancy_unavailable;
    m.ext_open = !!e.ext_open;
    // Fall back to live entity states for the climate readings when the report is absent.
    if (m.temp === null && cfg.temp) m.temp = num(state(hass, cfg.temp));
    if (m.humidity === null && cfg.hum) m.humidity = num(state(hass, cfg.hum));
    if (m.target === null && cfg.climate) m.target = num(attr(hass, cfg.climate, 'temperature'));
    return m;
  }

  function attentionItems(hass) {
    return parseList(attr(hass, 'sensor.info_attention', 'items')).map((i) => ({
      room: str(i.room), key: str(i.key), kind: str(i.kind), text: str(i.text), nav: str(i.nav),
    }));
  }

  const roomPath = (key) => `/info-dashboard/room-${key}`;
  const keyFromItem = (item) => (ROOMS[item.key] ? item.key : '');

  function activeScene(hass, key) {
    const s = state(hass, `sensor.${key}_active_scene`);
    if (!usable(s)) return '';
    return s.startsWith(`${key}_`) ? s.slice(key.length + 1) : s;
  }
  const sceneLabel = (id) => SCENE_LABELS[id] || id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  // ── Feed ─────────────────────────────────────────────────────────────────────────────────────
  // Stored entries from before the plumbing filter may still be present: drop them on read too.
  function isPlumbing(e) {
    return PLUMBING_DECISIONS.includes(str(e.decision)) || PLUMBING_AUTOS.some((p) => str(e.auto).includes(p));
  }
  function feedEntries(hass) {
    return parseList(attr(hass, 'sensor.info_decision_feed', 'entries')).filter((e) => !isPlumbing(e));
  }
  function roomFeed(hass, key) {
    const seen = new Set();
    const out = [];
    const all = feedEntries(hass).concat(parseList(attr(hass, 'sensor.info_decision_feed', 'by_room')).filter((e) => !isPlumbing(e)));
    for (const e of all) {
      if (e.loc !== key) continue;
      const id = `${str(e.ts)}|${str(e.sentence)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(e);
    }
    return out.sort((a, b) => (parseTs(b.ts) || 0) - (parseTs(a.ts) || 0)).slice(0, 6);
  }
  function feedRows(entries, now, limit) {
    return entries.slice(0, limit).map((e) => `<div class="feed"><span class="a">${esc(hhmm(e.ts))}</span><span>${esc(e.sentence)}${ago(e.ts, now) === 'just now' ? ' · just now' : ''}</span></div>`).join('');
  }

  // ── Icons ────────────────────────────────────────────────────────────────────────────────────
  const ICON = {
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    sun: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    lamp: 'M8 4h8l2 8H6l2-8zM12 12v7M8 20h8',
    power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    flame: 'M12 3c1 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.5.6-2.6 1.5-3.5C10 9 11 6 12 3z',
    person: 'M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 20a7 7 0 0 1 14 0',
    bed: 'M4 20v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M4 16h16M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3',
    back: 'M15 5l-7 7 7 7',
    chev: 'M6 9l6 6 6-6',
    sliders: 'M4 12h10M18 12h2M4 6h4M12 6h8M4 18h12M20 18h0M16 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM10 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    play: 'M8 5v14l11-7z',
    pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  };
  const svg = (path, size, extra) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra || ''}><path d="${path}"/></svg>`;
  const SCENE_ICON = { off: 'power', lamps: 'lamp', low: 'moon', full: 'sun', all_full: 'sun', daylight: 'sun' };

  // ── Wording ──────────────────────────────────────────────────────────────────────────────────
  function lightsPhrase(m, scene) {
    if (m.lights_on > 0) return scene && scene !== 'off' ? `${sceneLabel(scene)} scene` : 'Lights on';
    return 'Off';
  }

  // One-line reason for a room row: lights state and why, then anything that differs or holds.
  function rowSub(m, scene, now) {
    const parts = [lightsPhrase(m, scene)];
    if (m.lights_why) {
      const a = ago(m.lights_ts, now);
      parts.push(`${m.lights_why}${a ? ' ' + a : ''}`);
    } else if (m.hasReport) {
      parts.push(m.occupancy_unavailable ? 'occupancy unavailable' : m.occupied ? 'occupied' : 'empty');
    }
    if (m.target_reason && m.target !== null) parts.push(`heating target ${fmt1(m.target)}° (${m.target_reason})`);
    else if (m.labels.length) parts.push(`held: ${m.labels.join(' · ')}`);
    if (m.manual) parts.push(`manual (${SOURCE_WORDS[m.manual.source] || m.manual.source})`);
    return parts.join(' · ');
  }

  function bannerFor(m, items) {
    const mine = items.filter((i) => i.key === m.key);
    if (m.target_reason === 'window open' && m.cfg.climate) {
      return {
        warn: true, title: 'Heating suspended',
        body: `Window open. The valve is set to ${fmt1(m.target)}°${m.mode_name && m.mode_target !== null ? ` and returns to ${m.mode_name} (${fmt1(m.mode_target)}°) once it closes` : ''}.`,
      };
    }
    if (mine.length) {
      return { warn: true, title: mine.length === 1 ? mine[0].text : `${mine.length} things need attention`, body: mine.length === 1 ? m.verdict : mine.map((i) => i.text).join('. ') };
    }
    if (m.cfg.report && !m.hasReport) return { warn: false, dim: true, title: 'No report yet', body: 'sensor.info_rooms has no entry for this room.' };
    if (!m.cfg.report) return { warn: false, title: 'Lights only', body: 'This area has scenes and a lights automation, no climate or presence report.' };
    return { warn: false, title: 'All good', body: m.verdict || 'No reasons to show.' };
  }

  // ── Sections ─────────────────────────────────────────────────────────────────────────────────
  function sectionNowHeader(hass) {
    const mode = state(hass, 'sensor.house_active_mode');
    const mod = state(hass, 'input_select.house_active_mode_modifier');
    const pill = usable(mode) ? `<div class="tag ok" style="padding:3px 9px">● ${esc(mode.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))}${usable(mod) && mod !== 'none' ? ' · ' + esc(mod) : ''}</div>` : '';
    const person = (id, name, wfh) => {
      const s = state(hass, id);
      const home = s === 'home';
      const w = state(hass, wfh) === 'on';
      const label = !usable(s) ? 'Unknown' : home && w ? 'WFH' : home ? 'Home' : w ? 'Away · WFH' : 'Away';
      return `<div class="chip"><span class="dot${home ? '' : ' dim'}" style="width:8px;height:8px"></span>${esc(name)} · ${label}</div>`;
    };
    const fed = hhmm(state(hass, 'input_text.mo_cooldown_eating'));
    return `<div style="display:flex;align-items:center;gap:10px"><div style="font-size:28px;font-weight:700;letter-spacing:-.4px">Pulse</div>${pill}<div style="flex:1"></div>
<a class="tap" data-act="nav" data-path="/mobile-dashboard" aria-label="Open Mobile controls" style="min-height:44px;min-width:44px;display:flex;align-items:center;justify-content:center;color:${TOKENS.text2}">${svg(ICON.sliders, 22)}</a></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">${person('person.adam', 'Adam', 'input_boolean.wfh_adam')}${person('person.sarah', 'Sarah', 'input_boolean.wfh_sarah')}<div class="chip" style="color:${TOKENS.text2}">Mo${fed ? ' · eating alert ' + esc(fed) : ''}</div></div>`;
  }

  function heatingRooms(hass) {
    return ROOM_ORDER.filter((k) => roomModel(hass, k).hvac_action === 'heating');
  }

  function sectionAttention(hass) {
    const items = attentionItems(hass);
    if (items.length === 0) {
      const home = ['person.adam', 'person.sarah'].filter((p) => state(hass, p) === 'home').length;
      const n = heatingRooms(hass).length;
      const mode = state(hass, 'sensor.house_active_mode');
      const hasData = !!stateObj(hass, 'sensor.info_attention');
      return `<div class="card pad" style="display:flex;align-items:center;gap:10px"><span class="dot${hasData ? '' : ' dim'}"></span><div><div style="font-size:15px;font-weight:700">${hasData ? 'All good' : 'No attention report'}</div><div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${home} home · heating in ${n} ${plural(n, 'room', 'rooms')}${usable(mode) ? ' · ' + esc(mode) : ''}</div></div></div>`;
    }
    const first = items[0];
    const path = ROOMS[first.key] ? roomPath(first.key) : '/mobile-dashboard';
    const shown = items.slice(0, 3).map((i) => `<div style="font-size:13px;margin-top:6px;line-height:1.4"><b>${esc(i.room)}</b> ${esc(i.text)}</div>`).join('');
    const more = items.length > 3 ? `<div style="font-size:12px;color:${TOKENS.text2};margin-top:4px">+${items.length - 3} more</div>` : '';
    return `<a class="card warn pad tap" data-act="nav" data-path="${esc(path)}" style="display:block"><div style="display:flex;align-items:center;gap:8px"><span class="dot warn"></span><span style="font-size:15px;font-weight:700;color:${TOKENS.amber}">${items.length} ${plural(items.length, 'needs', 'need')} attention</span></div>${shown}${more}</a>`;
  }

  function sectionRooms(hass, now) {
    const items = attentionItems(hass);
    const flagged = new Set(items.map(keyFromItem).filter(Boolean));
    const ordered = ROOM_ORDER.filter((k) => flagged.has(k)).concat(ROOM_ORDER.filter((k) => !flagged.has(k)));
    const rows = ordered.map((k) => {
      const m = roomModel(hass, k);
      const scene = activeScene(hass, k);
      const temp = m.temp !== null ? `${fmt1(m.temp)}°` : '–';
      const hum = m.cfg.climate ? (m.humidity !== null ? `${Math.round(m.humidity)}%` : '') : 'no climate';
      const tcolor = m.temp === null ? ` style="color:${TOKENS.text3}"` : '';
      if (!flagged.has(k)) {
        return `<a class="row tap" data-act="nav" data-path="${roomPath(k)}"><span class="dot${m.hasReport ? '' : ' dim'}"></span><div><div class="nm">${esc(m.cfg.short)}</div><div class="sub">${esc(m.hasReport ? rowSub(m, scene, now) : 'No report yet')}</div></div><div><div class="t"${tcolor}>${temp}</div><div class="rh">${esc(hum)}</div></div></a>`;
      }
      const lines = [];
      if (m.target_reason && m.target !== null) lines.push(`<div class="l"><b>Heating</b><span>target ${fmt1(m.target)}° (${esc(m.target_reason)})${m.mode_name && m.mode_target !== null ? `. Normally ${esc(m.mode_name)}, ${fmt1(m.mode_target)}°.` : '.'}</span></div>`);
      if (m.pres_labels.length) lines.push(`<div class="l"><b>Held</b><span>occupied by ${esc(m.pres_labels.join(' · '))}</span></div>`);
      for (const i of items.filter((x) => x.key === k)) lines.push(`<div class="l"><b>${esc(i.kind.replace(/_/g, ' '))}</b><span>${esc(i.text)}</span></div>`);
      const tags = m.labels.concat(m.heat_labels.filter((l) => !m.labels.includes(l))).map((l) => `<span class="tag">${esc(l)}</span>`).join('');
      if (tags) lines.push(`<div class="l">${tags}</div>`);
      return `<div class="row warn"><span class="dot warn" style="margin-top:6px"></span><div><div class="nm">${esc(m.cfg.short)}</div><div class="sub">${esc(m.verdict || rowSub(m, scene, now))}</div></div><div><div class="t"${tcolor}>${temp}</div><div class="rh">${esc(hum)}</div></div><div class="det">${lines.join('')}<a class="link tap" data-act="nav" data-path="${roomPath(k)}">${esc(m.cfg.short)} details ›</a></div></div>`;
    });
    return `<div class="lbl" style="margin:4px 4px -10px">Rooms</div><div class="card">${rows.join('')}</div>`;
  }

  const priceColor = (p) => (p === null ? TOKENS.text : p < CHEAP_P ? TOKENS.ok : p >= PEAK_P ? TOKENS.amber : TOKENS.text);
  function sectionEnergy(hass) {
    const base = 'sensor.octopus_energy_electricity_24e8140196_1012483035417';
    const now = num(state(hass, `${base}_current_rate`));
    const next = num(state(hass, `${base}_next_rate`));
    const p = (v) => (v === null ? null : v * 100);
    const watts = num(state(hass, 'sensor.glow_electricity_power'));
    const nowP = p(now);
    const nextP = p(next);
    return `<div class="lbl" style="margin:4px 4px -10px">Energy</div>
<div class="card pad" style="border-bottom-left-radius:0;border-bottom-right-radius:0;padding-bottom:0"><div style="display:flex;gap:16px;align-items:flex-end">
<div><div class="lbl">Now</div><div style="font-size:26px;font-weight:700;letter-spacing:-.5px;line-height:1.1">${nowP === null ? '–' : fmt1(nowP)}<span style="font-size:13px;font-weight:500;color:${TOKENS.text2}"> p/kWh</span></div></div>
<div><div class="lbl">Next</div><div style="font-size:18px;font-weight:600;color:${priceColor(nextP)};line-height:1.5">${nextP === null ? '–' : fmt1(nextP) + 'p'}</div></div>
<div style="flex:1"></div><div style="text-align:right"><div class="lbl">Usage</div><div style="font-size:18px;font-weight:600;line-height:1.5">${watts === null ? '–' : Math.round(watts) + ' W'}</div></div></div></div>`;
  }

  function sectionEnergyFoot(hass) {
    const s = state(hass, 'sensor.cheapest_2h_waking_start');
    const e = state(hass, 'sensor.cheapest_2h_waking_end');
    const avg = num(state(hass, 'sensor.cheapest_2h_waking_avg_rate'));
    const cheapest = usable(s) && usable(e) ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px"><span class="tag ok">Cheapest 2h</span><span>${esc(s)} → ${esc(e)}${avg !== null ? ' · avg ' + fmt1(avg) + 'p' : ''}</span></div>` : '';
    const tomorrowIn = state(hass, 'binary_sensor.octopus_tomorrow_data_available') === 'on';
    const free = state(hass, 'sensor.octopus_tomorrow_negative_windows');
    const hasFree = tomorrowIn && usable(free) && free !== '—' && free.trim() !== '';
    const note = `${tomorrowIn ? "Tomorrow's rates are in." : "Tomorrow's rates are not in yet."}${hasFree ? ' Free window ' + esc(free) + '.' : ''}`;
    return `<div class="card pad" style="border-top-left-radius:0;border-top-right-radius:0;padding-top:6px">${cheapest}<div style="font-size:12px;color:${TOKENS.text2};margin-top:6px">${note}</div></div>`;
  }

  function sectionBins(hass) {
    const names = { food: 'Food', paid_garden: 'Garden', recycling: 'Recycling', refuse: 'Refuse' };
    const bins = Object.keys(names).map((k) => ({ n: names[k], d: num(state(hass, `sensor.st_albans_collect_domestic_${k}_days_until_collection`)) }));
    bins.sort((a, b) => (a.d === null ? 1e9 : a.d) - (b.d === null ? 1e9 : b.d));
    const tiles = bins.map((b) => {
      const label = b.d === null ? '–' : b.d <= 0 ? 'Today' : b.d === 1 ? 'Tomorrow' : `${Math.round(b.d)}d`;
      const soon = b.d !== null && b.d <= 1;
      return `<div class="bin${soon ? ' soon' : ''}"><div class="d">${label}</div><div class="n">${b.n}</div></div>`;
    }).join('');
    return `<div class="lbl" style="margin:4px 4px -10px">Bins</div><div class="bins">${tiles}</div>`;
  }

  function sectionHeating(hass) {
    const master = state(hass, 'input_boolean.house_heating_enabled');
    const firing = state(hass, 'binary_sensor.house_heating_boiler_firing') === 'on';
    const rooms = heatingRooms(hass).length;
    const title = master === 'off' ? 'Heating off (master switch)' : firing ? `Boiler firing · ${rooms} ${plural(rooms, 'room', 'rooms')}` : 'Boiler idle';
    const inside = num(state(hass, 'sensor.house_average_temperature'));
    const outside = num(attr(hass, 'weather.forecast_home', 'temperature'));
    const patio = state(hass, 'input_boolean.patio_door_heating_suspended') === 'on' ? 'patio door open, heating suspended' : 'patio door shut';
    const bits = [inside !== null ? `Inside ${fmt1(inside)}°` : '', outside !== null ? `outside ${fmt1(outside)}°` : '', patio].filter(Boolean).join(' · ');
    return `<div class="lbl" style="margin:4px 4px -10px">Heating</div><div class="card pad" style="display:flex;align-items:center;gap:12px"><span style="color:${TOKENS.link}">${svg(ICON.flame, 22)}</span><div style="flex:1"><div style="font-size:15px;font-weight:600">${esc(title)}</div><div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${esc(bits)}</div></div></div>`;
  }

  function sectionFeed(hass, now) {
    const entries = feedEntries(hass);
    const body = entries.length ? feedRows(entries, now, 6) : `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">No decisions seen since HA started.</span></div>`;
    return `<div class="lbl" style="margin:4px 4px -10px">What the house did</div><div class="card">${body}</div>`;
  }

  function sectionFooter(hass, now) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:${TOKENS.text3};padding:2px 4px"><span>Updated ${esc(hhmm(new Date(now).toISOString()))}</span><a class="link tap" data-act="nav" data-path="/mobile-dashboard">Open Mobile controls ›</a></div>`;
  }

  // ── Room page sections ───────────────────────────────────────────────────────────────────────
  function sectionRoomHead(hass, key) {
    const m = roomModel(hass, key);
    const b = bannerFor(m, attentionItems(hass));
    const banner = `<div class="card pad${b.warn ? ' warn' : ''}" style="display:flex;gap:10px;align-items:flex-start"><span class="dot${b.warn ? ' warn' : b.dim ? ' dim' : ''}" style="margin-top:5px"></span><div><div style="font-size:15px;font-weight:700;${b.warn ? 'color:' + TOKENS.amber : ''}">${esc(b.title)}</div><div style="font-size:13px;color:${b.warn ? TOKENS.text : TOKENS.text2};margin-top:3px;line-height:1.45">${esc(b.body)}</div></div></div>`;
    let numbers = '';
    if (m.cfg.climate) {
      const differs = !!m.target_reason;
      const sub2 = differs ? (m.mode_name && m.mode_target !== null ? `mode ${m.mode_name} ${fmt1(m.mode_target)}°` : esc(m.target_reason)) : [m.heating_active.replace(/_/g, ' '), m.heating_source].filter(Boolean).join(' · ');
      numbers = `<div class="two"><div class="card pad"><div class="lbl">Room</div><div class="big">${m.temp === null ? '–' : fmt1(m.temp) + '°'}</div><div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${m.humidity === null ? 'no humidity' : Math.round(m.humidity) + '% humidity'}</div></div>
<div class="card pad"><div class="lbl">${differs ? 'Valve target' : 'Heating'}</div><div class="big" style="${differs ? 'color:' + TOKENS.amber : ''}">${m.target === null ? '–' : fmt1(m.target) + '°'}</div><div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${esc(sub2)}</div></div></div>`;
    }
    return `<div style="display:flex;align-items:center;gap:4px"><a class="tap" data-act="nav" data-path="/info-dashboard/now" aria-label="Back to Now" style="min-height:44px;min-width:44px;display:flex;align-items:center;color:${TOKENS.text2}">${svg(ICON.back, 22)}</a><div style="font-size:28px;font-weight:700;letter-spacing:-.4px">${esc(m.cfg.name)}</div></div>${banner}${numbers}`;
  }

  function sectionWhy(hass, key, now) {
    const m = roomModel(hass, key);
    if (!m.hasReport) return '';
    const scene = activeScene(hass, key);
    const rows = [];
    const lightsTag = m.manual ? '<span class="tag">Manual</span>' : m.pres_labels.length ? '<span class="tag off">Hold</span>' : '<span class="tag ok">Auto</span>';
    const lightsSub = m.lights_why ? `${esc(m.lights_why.replace(/^./, (c) => c.toUpperCase()))}${m.lights_ts ? ' at ' + esc(hhmm(m.lights_ts)) : ''}.` : 'No lighting decision seen since HA started.';
    rows.push(`<div class="item">${svg(ICON.bulb, 18)}<div><div class="h">${esc(m.lights_on > 0 ? lightsPhrase(m, scene) : 'Lights off')}</div><div class="s">${lightsSub}</div></div>${lightsTag}</div>`);
    if (m.cfg.climate) {
      const differs = !!m.target_reason;
      const h = m.target !== null ? `Heating target ${fmt1(m.target)}°` : 'Heating';
      const s = differs ? `${esc(m.target_reason.replace(/^./, (c) => c.toUpperCase()))}${m.mode_name && m.mode_target !== null ? `. Normally ${esc(m.mode_name)}, ${fmt1(m.mode_target)}°` : ''}.` : [m.mode_name && m.mode_target !== null ? `${esc(m.mode_name.replace(/^./, (c) => c.toUpperCase()))} ${fmt1(m.mode_target)}°` : '', m.heating_source ? esc(m.heating_source.replace(/_/g, ' ')) : ''].filter(Boolean).join(' from ') || 'No mode reported.';
      const tag = differs ? `<span class="tag">${esc(m.target_reason.replace(/^./, (c) => c.toUpperCase()))}</span>` : m.heating_enabled === false ? '<span class="tag">Automation off</span>' : '<span class="tag ok">On target</span>';
      rows.push(`<div class="item">${svg(ICON.flame, 18)}<div><div class="h">${esc(h)}</div><div class="s">${s}</div></div>${tag}</div>`);
    }
    const holds = m.labels.length ? m.labels : [];
    const occ = m.occupancy_unavailable ? 'Occupancy unavailable' : m.occupied ? 'Occupied' : 'Empty';
    const pres = holds.length ? `Held by ${esc(holds.join(' · '))}.${holds.length > 1 ? ' All are true, so it stays held until all clear.' : ''}` : 'No holds.';
    const ovr = m.override_text ? ` ${esc(m.override_text)}.` : '';
    rows.push(`<div class="item">${svg(ICON.bed, 18)}<div><div class="h">${occ}</div><div class="s">${pres}${ovr}</div></div><span class="tag${holds.length || m.override ? '' : ' off'}">${holds.length ? holds.length + ' ' + plural(holds.length, 'reason', 'reasons') : m.override ? 'Override' : 'Clear'}</span></div>`);
    return `<div class="lbl" style="margin:4px 4px -10px">Why it is like this</div><div class="card">${rows.join('')}</div>`;
  }

  function sectionScenes(hass, key, now) {
    const m = roomModel(hass, key);
    const active = activeScene(hass, key);
    const cols = Math.min(4, Math.max(1, m.cfg.scenes.length));
    const tiles = m.cfg.scenes.map((id) => {
      const on = id === active;
      const ic = ICON[SCENE_ICON[id] || 'bulb'];
      return `<button class="tile${on ? ' on' : ''}" data-act="scene" data-entity="scene.${key}_${id}" aria-pressed="${on}">${svg(ic, 20)}<span>${esc(sceneLabel(id))}</span></button>`;
    }).join('');
    let foot;
    if (m.manual) {
      const how = SOURCE_WORDS[m.manual.source] || m.manual.source;
      const when = ago(m.manual.ts, now);
      const auto = m.lights_why ? `Automation last acted: ${esc(m.lights_why)}${m.lights_ts ? ' (' + esc(hhmm(m.lights_ts)) + ')' : ''}. It may change them again.` : 'The automation may change them again.';
      foot = `<div class="mrow"><span class="tag">Manual · ${esc(how)}${when ? ', ' + esc(when) : ''}</span><span>${m.manual.what ? esc(m.manual.what) + '. ' : ''}${auto}</span></div>`;
    } else if (m.lights_why) {
      foot = `<div class="note">Set by automation${m.lights_ts ? ' at ' + esc(hhmm(m.lights_ts)) : ''}: ${esc(m.lights_why)}. Tap a scene to take over.</div>`;
    } else {
      foot = '<div class="note">No automation action seen since HA started. Tap a scene to set one.</div>';
    }
    return `<div class="lbl" style="margin:4px 4px -10px">Lighting</div><div class="card" style="padding:12px 12px 10px"><div class="tiles" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${tiles}</div>${foot}</div>`;
  }

  function lightCounts(hass, key) {
    const m = roomModel(hass, key);
    if (m.lights_total > 0) return { on: m.lights_on, total: m.lights_total };
    const list = m.cfg.lights;
    return { on: list.filter(([id]) => state(hass, id) === 'on').length, total: list.length };
  }

  function sectionLightsTitle(hass, key) {
    const m = roomModel(hass, key);
    if (m.cfg.lights.length === 0) return '';
    const c = lightCounts(hass, key);
    return `<div style="display:flex;justify-content:space-between;align-items:center;min-height:52px;padding:0 14px"><span class="lbl">Individual lights</span><span style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:${TOKENS.text2}">${c.on} of ${c.total} on ${svg(ICON.chev, 18)}</span></div>`;
  }

  function sectionLights(hass, key) {
    const m = roomModel(hass, key);
    if (m.cfg.lights.length === 0) return '';
    const rows = m.cfg.lights.map(([id, label]) => {
      const s = stateObj(hass, id);
      const name = esc(str(attr(hass, id, 'friendly_name')) || label);
      if (!s || !usable(s.state)) return `<div class="tog"><div><div class="h">${esc(label)}</div><div class="s">${s ? 'Unavailable' : 'Not found'}</div></div></div>`;
      const on = s.state === 'on';
      const dimmable = id.startsWith('light.') && Array.isArray(attr(hass, id, 'supported_color_modes')) && attr(hass, id, 'supported_color_modes').some((c) => c !== 'onoff');
      if (dimmable) {
        const pct = on ? Math.round(((num(attr(hass, id, 'brightness')) || 0) / 255) * 100) : 0;
        return `<div class="lt"><div><div class="h">${esc(label)}</div><div class="s">${on ? pct + '%' : 'Off'}</div></div><input type="range" min="0" max="100" value="${pct}" data-act="brightness" data-entity="${esc(id)}" aria-label="${esc(label)} brightness"></div>`;
      }
      return `<button class="tog tap" data-act="toggle" data-entity="${esc(id)}" aria-pressed="${on}"><div><div class="h">${esc(label)}</div><div class="s">${on ? 'On' : 'Off'}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`;
    }).join('');
    return `<div>${rows}</div>`;
  }

  function sectionMedia(hass, key) {
    const m = roomModel(hass, key);
    if (m.cfg.media.length === 0) return '';
    const rows = m.cfg.media.map(([id, label, kind]) => {
      const s = stateObj(hass, id);
      const name = esc(str(attr(hass, id, 'friendly_name')) || label);
      if (!s) return `<div class="tog"><div><div class="h">${esc(label)}</div><div class="s">Not found</div></div></div>`;
      if (!usable(s.state)) return `<div class="tog"><div><div class="h">${name}</div><div class="s">Unavailable</div></div></div>`;
      const off = s.state === 'off' || s.state === 'standby';
      const playing = s.state === 'playing';
      const title = str(attr(hass, id, 'media_title'));
      const artist = str(attr(hass, id, 'media_artist'));
      const text = playing ? [title, artist].filter(Boolean).join(' · ') || 'Playing' : s.state === 'paused' ? 'Paused' : off ? 'Off' : s.state === 'idle' ? 'Idle' : esc(s.state);
      if (kind === 'tv') {
        return `<button class="tog tap" data-act="media-power" data-entity="${esc(id)}" aria-pressed="${!off}"><div><div class="h">${name}</div><div class="s">${esc(text)}</div></div><span class="sw${off ? ' off' : ''}" role="img" aria-label="${off ? 'Off' : 'On'}"></span></button>`;
      }
      const vol = num(attr(hass, id, 'volume_level'));
      const volRow = vol === null ? '' : `<div class="lt"><div><div class="h">Volume</div><div class="s">${Math.round(vol * 100)}%</div></div><input type="range" min="0" max="100" value="${Math.round(vol * 100)}" data-act="volume" data-entity="${esc(id)}" aria-label="${name} volume"></div>`;
      return `<div class="tog"><div><div class="h">${name}</div><div class="s">${esc(text)}</div></div><button class="round" data-act="media-play" data-entity="${esc(id)}" aria-label="${playing ? 'Pause' : 'Play'}">${svg(playing ? ICON.pause : ICON.play, 20)}</button></div>${volRow}`;
    }).join('');
    return `<div class="lbl" style="margin:4px 4px -10px">Media</div><div class="card">${rows}</div>`;
  }

  function sectionAutomations(hass, key) {
    const rows = [];
    const toggle = (id, title, sub) => {
      const s = state(hass, id);
      if (!usable(s)) return;
      const on = s === 'on';
      rows.push(`<button class="tog tap" data-act="toggle" data-entity="${id}" aria-pressed="${on}"><div><div class="h">${title}</div><div class="s">${sub}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`);
    };
    toggle(`input_boolean.${key}_automation_lights_enabled`, 'Lights automation', 'Decides lights from presence and time of day');
    toggle(`input_boolean.${key}_automation_heating_enabled`, 'Heating automation', 'Sets the valve from mode, windows and schedule');
    if (rows.length === 0) return '';
    return `<div class="lbl" style="margin:4px 4px -10px">Automations</div><div class="card">${rows.join('')}</div>`;
  }

  function sectionRoomFeed(hass, key, now) {
    const entries = roomFeed(hass, key);
    const body = entries.length ? feedRows(entries, now, 6) : `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">Nothing seen in this room since HA started.</span></div>`;
    return `<div class="lbl" style="margin:4px 4px -10px">In this room</div><div class="card">${body}</div>`;
  }

  // ── Dispatcher ───────────────────────────────────────────────────────────────────────────────
  const MODES = {
    'now-header': (h) => sectionNowHeader(h),
    attention: (h) => sectionAttention(h),
    rooms: (h, c, n) => sectionRooms(h, n),
    energy: (h) => sectionEnergy(h),
    'energy-foot': (h) => sectionEnergyFoot(h),
    bins: (h) => sectionBins(h),
    heating: (h) => sectionHeating(h),
    feed: (h, c, n) => sectionFeed(h, n),
    footer: (h, c, n) => sectionFooter(h, n),
    'room-head': (h, c) => sectionRoomHead(h, c.room),
    why: (h, c, n) => sectionWhy(h, c.room, n),
    scenes: (h, c, n) => sectionScenes(h, c.room, n),
    'lights-title': (h, c) => sectionLightsTitle(h, c.room),
    lights: (h, c) => sectionLights(h, c.room),
    media: (h, c) => sectionMedia(h, c.room),
    automations: (h, c) => sectionAutomations(h, c.room),
    'room-feed': (h, c, n) => sectionRoomFeed(h, c.room, n),
  };
  const ROOM_MODES = ['room-head', 'why', 'scenes', 'lights-title', 'lights', 'media', 'automations', 'room-feed'];

  function validate(config) {
    if (!isObj(config) || !MODES[config.mode]) throw new Error(`pulse-card: unknown mode "${config && config.mode}"`);
    if (ROOM_MODES.includes(config.mode) && !ROOMS[config.room]) throw new Error(`pulse-card: mode "${config.mode}" needs a known room, got "${config.room}"`);
  }

  function render(mode, config, hass, now) {
    validate({ ...config, mode });
    const html = MODES[mode](hass, config || {}, Number.isFinite(now) ? now : Date.now());
    return html ? `<div class="p">${html}</div>` : '';
  }

  // ── Price bars for apexcharts-card ───────────────────────────────────────────────────────────
  // rates: attribute `rates` of the Octopus current-day-rates event ({start, end, value_inc_vat},
  // GBP/kWh, local offsets). Never assume 48 slots: clock-change days have 46 or 50.
  function rateSeries(rates, cat, now) {
    const list = Array.isArray(rates) ? rates : [];
    const out = [];
    for (const r of list) {
      if (!isObj(r)) continue;
      const start = Date.parse(r.start);
      const end = Date.parse(r.end);
      const v = Number(r.value_inc_vat) * 100;
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(v)) continue;
      let c;
      if (end <= now) c = 'past';
      else if (start <= now) c = 'current';
      else c = v < CHEAP_P ? 'cheap' : v >= PEAK_P ? 'peak' : 'mid';
      out.push({ x: start, y: c === cat ? v : null });
    }
    return out;
  }

  // ── Service calls ────────────────────────────────────────────────────────────────────────────
  function callService(hass, domain, service, data) {
    if (!ALLOWED[domain] || !ALLOWED[domain].includes(service)) {
      throw new Error(`pulse-card: service ${domain}.${service} is not an allowed write path`);
    }
    return hass.callService(domain, service, data);
  }

  function handleAction(hass, el, value) {
    const act = el.dataset.act;
    const id = el.dataset.entity;
    const domain = id ? id.split('.')[0] : '';
    switch (act) {
      case 'scene': return callService(hass, 'scene', 'turn_on', { entity_id: id });
      case 'toggle': return callService(hass, domain, state(hass, id) === 'on' ? 'turn_off' : 'turn_on', { entity_id: id });
      case 'brightness': {
        const pct = Math.max(0, Math.min(100, Math.round(Number(value))));
        return pct === 0 ? callService(hass, 'light', 'turn_off', { entity_id: id }) : callService(hass, 'light', 'turn_on', { entity_id: id, brightness_pct: pct });
      }
      case 'media-play': return callService(hass, 'media_player', 'media_play_pause', { entity_id: id });
      case 'media-power': return callService(hass, 'media_player', ['off', 'standby'].includes(state(hass, id)) ? 'turn_on' : 'turn_off', { entity_id: id });
      case 'volume': return callService(hass, 'media_player', 'volume_set', { entity_id: id, volume_level: Math.max(0, Math.min(1, Number(value) / 100)) });
      default: return undefined;
    }
  }

  const api = { TOKENS, ROOMS, ROOM_ORDER, ALL_ROOM_KEYS, ALLOWED, render, rateSeries, roomModel, attentionItems, handleAction, callService, num, parseList };
  root.PulseLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ── Custom element (browser only) ────────────────────────────────────────────────────────────
  if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined' && !customElements.get('pulse-card')) {
    class PulseCard extends HTMLElement {
      constructor() {
        super();
        this._root = this.attachShadow({ mode: 'open' });
        this._html = null;
        this._busy = false;
        this._root.addEventListener('click', (ev) => this._click(ev));
        this._root.addEventListener('change', (ev) => this._change(ev));
        this._root.addEventListener('pointerdown', (ev) => { if (ev.target && ev.target.type === 'range') this._busy = true; });
        this._root.addEventListener('pointerup', () => { this._busy = false; });
        this._root.addEventListener('pointercancel', () => { this._busy = false; });
      }
      setConfig(config) {
        validate(config);
        this._config = config;
      }
      set hass(hass) {
        this._hass = hass;
        this._paint();
      }
      getCardSize() { return 3; }
      _paint() {
        if (!this._config || !this._hass || this._busy) return;
        let html;
        try {
          html = render(this._config.mode, this._config, this._hass, Date.now());
        } catch (err) {
          // Fail loudly in the card itself rather than leaving a blank hole.
          html = `<div class="p"><div class="card warn pad"><b>pulse-card error</b><div class="s">${esc(err && err.message)}</div></div></div>`;
        }
        if (html === this._html) return;
        this._html = html;
        this.style.display = html ? '' : 'none';
        this._root.innerHTML = `<style>${STYLE}</style>${html}`;
      }
      _click(ev) {
        const el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!el || !this._hass) return;
        if (el.dataset.act === 'nav') {
          const path = el.dataset.path || '';
          if (path.startsWith('/')) {
            window.history.pushState(null, '', path);
            window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
          }
          return;
        }
        if (el.type === 'range') return;
        handleAction(this._hass, el);
      }
      _change(ev) {
        const el = ev.target;
        if (!el || el.type !== 'range' || !this._hass) return;
        this._busy = false;
        handleAction(this._hass, el, el.value);
      }
    }
    customElements.define('pulse-card', PulseCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: 'pulse-card', name: 'Pulse card', description: 'Information-first house status sections' });
  }
})(typeof window !== 'undefined' ? window : globalThis);
