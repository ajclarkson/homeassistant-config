/*
 * Pulse: information-first dashboard cards (custom:pulse-card).
 *
 * One card, many sections: `mode` picks the section and `room` (where relevant) the room, so
 * every room page is the same template with a different room key.
 *
 * Cache busting: none needed. packages/frontend.yaml registers www/pulse-card-loader.js, which
 * fetches this file with revalidation and imports it from a Blob URL. After a change, wait ~60 s
 * for www-sync and reopen the dashboard; no ?v= bump, no HA restart.
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

  // Switch the bottom tab bar off in one line (renders nothing; the Now footer link comes back).
  const TABBAR_ENABLED = true;

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
    heat: '#f08a4b',
    heatBg: '#2a1a10',
    okBg: '#14281d',
    link: '#7aa7ff',
    sceneActive: '#f2c46b',
    sceneActiveText: '#1d1708',
    switchOn: '#3a8f63',
    switchOff: '#3a424d',
  };

  // ── Price colours (single definition) ──────────────────────────────────────────────────────
  // Graded green -> red by pence/kWh, interpolated in HSL between these stops. Lightness varies
  // along the scale (not just hue) so green and red stay apart for colour-blind viewers; bar
  // height and the numbers carry the price too. Negative prices are always good ("paid to use")
  // and get their own bright teal; >= PRICE_EXTREME_P is a deeper, more saturated red.
  const PRICE_STOPS = [ // [pence, hue, saturation %, lightness %]
    [0, 142, 58, 46],
    [15, 88, 62, 56],
    [25, 52, 82, 60],
    [35, 26, 88, 56],
    [44.99, 4, 80, 50],
  ];
  const PRICE_EXTREME_P = 45;
  const PRICE_NEGATIVE = '#2ee6c8';
  const PRICE_EXTREME = '#c2003b';
  const PRICE_NEUTRAL = '#6b7684';
  const PRICE_KEY_P = [0, 15, 30, 45];

  // Room tile geometry in ONE place. The tile has a fixed height, so the height must be at least what its
  // rows need: top+bottom padding, the name line, the temperature line, the status line and the row gaps
  // (tileNeededHeight). Every line has an explicit line-height so the arithmetic is exact, and nothing in
  // the tile clips: the status line only ellipsises text, never icons or badges.
  const TILE = { padY: 12, nameLine: 20, tempLine: 26, statusLine: 20, gap: 6 };
  const TILE_H = 104;
  const TILE_WIDE_H = 80;
  const tileNeededHeight = (wide) => (wide
    ? 2 * TILE.padY + Math.max(TILE.nameLine, TILE.tempLine) + TILE.gap + TILE.statusLine
    : 2 * TILE.padY + TILE.nameLine + TILE.tempLine + TILE.statusLine + 2 * TILE.gap);

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
.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:${TOKENS.divider};font-size:12px;font-weight:600;min-height:30px;white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.chips{display:flex;gap:6px;flex-wrap:nowrap;min-width:0}
.pstrip{display:flex;align-items:center;gap:16px;min-height:56px;color:inherit}
.det{grid-column:2 / 4;display:flex;flex-direction:column;gap:6px;padding:4px 0 6px}
.det .l{display:flex;gap:8px;font-size:12.5px;color:#cfd5dd;line-height:1.4}
.det .l b{color:${TOKENS.amber};font-weight:600}
.tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:${TOKENS.amberTag};color:${TOKENS.amber};white-space:nowrap}
.tag.ok{background:${TOKENS.okBg};color:${TOKENS.ok}}
.tag.off{background:${TOKENS.divider};color:${TOKENS.text2}}
.tag.heat{background:${TOKENS.heatBg};color:${TOKENS.heat}}
.link{display:flex;align-items:center;min-height:44px;font-size:13px;font-weight:600;color:${TOKENS.link}}
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
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:${TOKENS.divider};color:#cfd5dd;white-space:nowrap}
.oc{display:grid;grid-template-columns:20px 1fr auto;column-gap:12px;row-gap:6px;align-items:center;padding:12px 14px;min-height:64px;box-sizing:border-box;text-decoration:none;color:inherit}
.oc .nm{font-size:16px;font-weight:600}
.oc .t{text-align:right}
.oc .sub{grid-column:2 / 4;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:#a3adba}
.rgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.rt{display:grid;grid-template-rows:auto 1fr auto;row-gap:${TILE.gap}px;padding:${TILE.padY}px 12px;height:${TILE_H}px;box-sizing:border-box;background:${TOKENS.surface};border-radius:14px;text-decoration:none;color:inherit}
.rt .nm{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;line-height:${TILE.nameLine}px;color:#cfd5dd;white-space:nowrap;min-width:0}
.rt .nm span{overflow:hidden;text-overflow:ellipsis}
.rt .t{align-self:center;text-align:left;line-height:${TILE.tempLine}px}
.rt .b{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;color:#8f9aa8;font-size:11.5px;line-height:${TILE.statusLine}px;min-height:${TILE.statusLine}px;white-space:nowrap;min-width:0}
.rt .b>*{flex:none}
.rt .b>span:not(.badge){flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.rt .b .badge{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;line-height:14px}
.rt.wide{grid-column:1 / -1;grid-template-columns:1fr auto;grid-template-rows:auto auto;height:${TILE_WIDE_H}px}
.rt.wide .nm{grid-column:1;grid-row:1}
.rt.wide .t{grid-column:2;grid-row:1;text-align:right}
.rt.wide .b{grid-column:1 / -1;grid-row:2}
.segs{display:flex;gap:8px;background:${TOKENS.surface};border-radius:14px;padding:4px}
.seg{border:0;font:inherit;font-size:14px;font-weight:600;min-height:44px;border-radius:12px;cursor:pointer;flex:1;background:transparent;color:#cfd5dd}
.seg.on{background:${TOKENS.sceneActive};color:${TOKENS.sceneActiveText}}
.stat{flex:1;padding:12px;min-width:0}
.stat .k{font-size:11px;color:${TOKENS.text3};font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.stat .v{font-size:19px;font-weight:700;letter-spacing:-.3px;margin-top:4px}
.stat .s{font-size:11.5px;color:${TOKENS.text2};margin-top:2px}
.wrow{display:flex;justify-content:space-between;align-items:center;gap:10px;min-height:48px;padding:6px 14px;border-top:1px solid ${TOKENS.divider};font-size:14px}
.wrow:first-child{border-top:0}
.wrow .r{font-size:13px;font-weight:600}
.wrow .m{font-size:12px;color:${TOKENS.text2}}
.u{padding:14px;flex:1;min-width:0}
.u .v{font-size:22px;font-weight:700;letter-spacing:-.4px;margin-top:4px}
.u .v span{font-size:12px;font-weight:500;color:${TOKENS.text2}}
.tabbar-spacer{height:var(--tbh)}
.tabs{--tbh:calc(58px + max(10px, env(safe-area-inset-bottom, 0px)));box-sizing:border-box;height:var(--tbh);padding:8px 16px max(10px, env(safe-area-inset-bottom, 0px));display:flex;background:rgba(18,21,26,.94);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-top:1px solid ${TOKENS.divider}}
.tabs.fixed{position:fixed;left:0;right:0;bottom:0;z-index:100}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font:inherit;font-size:10.5px;font-weight:600;color:${TOKENS.text3};min-height:44px;background:none;border:0;cursor:pointer;padding:0}
.tab[aria-current=page]{color:${TOKENS.sceneActive}}
.tab:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:-2px;border-radius:10px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.chart:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:2px;border-radius:6px}
.tip{position:absolute;top:-36px;left:0;pointer-events:none;background:${TOKENS.divider};border:1px solid #2f3843;border-radius:8px;padding:4px 8px;font-size:12px;line-height:1.3;white-space:nowrap;z-index:2}
.tip small{display:block;font-size:10px;color:${TOKENS.text2}}
.lh{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:52px;padding:0 14px;background:none;border:0;color:inherit;font:inherit;cursor:pointer}
.lt input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:44px;margin:0;background:transparent;accent-color:${TOKENS.sceneActive}}
.lt input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:linear-gradient(to right,${TOKENS.sceneActive} var(--p,0%),${TOKENS.switchOff} var(--p,0%))}
.lt input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;margin-top:-9px;border-radius:50%;background:${TOKENS.sceneActive};border:2px solid ${TOKENS.surface}}
.lt input[type=range]::-moz-range-track{height:6px;border-radius:3px;background:${TOKENS.switchOff}}
.lt input[type=range]::-moz-range-progress{height:6px;border-radius:3px;background:${TOKENS.sceneActive}}
.lt input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:${TOKENS.sceneActive};border:2px solid ${TOKENS.surface}}
.round{min-height:44px;min-width:44px;border-radius:999px;border:0;background:${TOKENS.sceneActive};color:${TOKENS.sceneActiveText};display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.round.quiet{background:${TOKENS.divider};color:${TOKENS.text}}
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

  // Where the dashboard is registered (url_path in configuration.yaml). Defined once: an unknown
  // path silently falls back to the default dashboard, which is exactly the bug this avoids.
  const DASH = '/pulse-dashboard';
  const MOBILE = '/mobile-dashboard';
  // The separate energy page. The Details link only renders when a card names this path in
  // `details_path`, and only when that view exists in info-dashboard.yaml (tests enforce both).
  const ENERGY_PATH = `${DASH}/energy`;
  const RECENT_MS = 15 * 60 * 1000;


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
    m.house_heating_off = state(hass, 'input_boolean.house_heating_enabled') === 'off';
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

  // A warm room with heating on reads "steamy" when the room's own data (humidity, or occupied
  // with lights on) points at a shower rather than a heating fault.
  function isSteamy(m) {
    const h = m ? m.humidity : null;
    return h !== null && (h >= 85 || (h >= 70 && m.occupied && m.lights_on > 0));
  }

  // Human label for an attention item.
  function itemLabel(item, m) {
    switch (item.kind) {
      case 'window_open_heating_on': return 'Window open, heating on';
      case 'automation_disabled': return 'Automation off';
      case 'hold_active': return 'Override on';
      case 'sensor_unavailable': return 'Sensor unavailable';
      case 'sensor_stale': return 'Sensor not updating';
      case 'cold_not_heating': return 'Too cold, heating off';
      case 'warm_heating': return isSteamy(m) ? 'Steamy' : 'Too warm, heating on';
      default: return item.kind ? item.kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Needs attention';
    }
  }
  function itemDetail(item, m) {
    if (item.kind === 'warm_heating' && itemLabel(item, m) === 'Steamy') return `${item.text} · ${Math.round(m.humidity)}% humidity, probably a shower`;
    return item.text;
  }

  const roomPath = (key) => `${DASH}/room-${key}`;
  const keyFromItem = (item) => (ROOMS[item.key] ? item.key : '');

  function activeScene(hass, key) {
    const s = state(hass, `sensor.${key}_active_scene`);
    if (!usable(s)) return '';
    return s.startsWith(`${key}_`) ? s.slice(key.length + 1) : s;
  }
  const sceneLabel = (id) => SCENE_LABELS[id] || id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  // ── Feed ─────────────────────────────────────────────────────────────────────────────────────
  // Stored entries from before the plumbing filter may still be present: drop them on read too.
  // Entries that say nothing happened never reach the feed, whether stored before or after this check.
  const NOOP_WORDS = /\b(no[_ ]?change|no[_ ]?action|maintain|maintained)\b/i;
  function isPlumbing(e) {
    return PLUMBING_DECISIONS.includes(str(e.decision)) || PLUMBING_AUTOS.some((p) => str(e.auto).includes(p))
      || NOOP_WORDS.test(str(e.decision)) || NOOP_WORDS.test(str(e.reason)) || NOOP_WORDS.test(str(e.sentence));
  }
  // Plain wording for decisions whose stored sentence is jargon ("heating set mode"). Everything else
  // keeps the sensor's sentence. Uses the loc/sub/decision/reason the feed stores with each entry.
  const DECISION_WORDS = { set_mode: 'mode changed', blocked: 'blocked by its automation switch', suspend: 'suspended', restore: 'restored', sync_window_external: 'window state synced', set_sleep: 'house set to sleep' };
  const REASON_WORDS = { safety_window_open: 'window open', safety_heating_disabled: 'heating switched off', manual_override: 'manual setting', schedule: 'schedule', schedule_occupied: 'schedule, room occupied', house_mode_away: 'house away', house_mode_sleep: 'house asleep', house_mode_vacation: 'house on holiday', house_mode_normal: 'house at home', automation_disabled: 'automation off' };
  function entrySentence(e) {
    const d = str(e.decision);
    if (!DECISION_WORDS[d] || !e.loc) return str(e.sentence);
    const place = str(e.loc).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const noun = { heating: 'heating', lighting: 'lights', occupied: 'occupancy' }[str(e.sub)] || str(e.sub).replace(/_/g, ' ');
    const why = REASON_WORDS[str(e.reason)] || str(e.why) || str(e.reason).replace(/_/g, ' ');
    return `${place} ${noun ? noun + ' ' : ''}${DECISION_WORDS[d]}${why ? ' · ' + why : ''}`;
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
  // Consecutive identical sentences (a mashed button) become one row with a count. Entries are
  // newest first, so the row carries the newest time.
  function collapseFeed(entries) {
    const out = [];
    for (const e of entries) {
      const last = out[out.length - 1];
      const sentence = entrySentence(e);
      if (last && last.sentence === sentence) last.count += 1;
      else out.push({ ts: e.ts, sentence, count: 1 });
    }
    return out;
  }
  // The time column already says when; no second "just now".
  function feedRows(entries, now, limit) {
    return collapseFeed(entries).slice(0, limit).map((e) => `<div class="feed"><span class="a">${esc(hhmm(e.ts))}</span><span>${esc(e.sentence)}${e.count > 1 ? ` <b>x${e.count}</b>` : ''}</span></div>`).join('');
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
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    hand: 'M8 13V5a1.5 1.5 0 0 1 3 0v6M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 14',
    window: 'M4 4h16v16H4zM12 4v16M4 12h16',
    pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  };
  const svg = (path, size, extra) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra || ''}><path d="${path}"/></svg>`;
  // Occupancy indicator (the dot stays health): filled person = occupied, outlined dim = empty,
  // dashed amber = occupancy sensor unavailable.
  function occIcon(m, px) {
    const size = px || 15;
    if (!m.hasReport) return '';
    const [label, fill, color, dash] = m.occupancy_unavailable ? ['Occupancy unavailable', 'none', TOKENS.amber, ' stroke-dasharray="2 2"'] : m.occupied ? ['Occupied', 'currentColor', TOKENS.text, ''] : ['Empty', 'none', TOKENS.text3, ''];
    return `<svg class="occ" role="img" aria-label="${label}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:${color};flex:none"${dash}><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>`;
  }
  const SCENE_ICON = { off: 'power', lamps: 'lamp', low: 'moon', full: 'sun', all_full: 'sun', daylight: 'sun' };

  // ── Wording ──────────────────────────────────────────────────────────────────────────────────
  function lightsPhrase(m, scene) {
    if (m.lights_on > 0) return scene && scene !== 'off' ? `${sceneLabel(scene)} scene` : 'Lights on';
    return 'Off';
  }

  // The sensor's verdict says "Occupied · lights on · held occupied by Sofa occupied"; fold the hold into the
  // first clause so "occupied" is said once: "Occupied (Sofa occupied) · lights on".
  const tidyVerdict = (v, labels = []) => {
    const s = str(v);
    const held = ` · held occupied by ${labels.join(' · ')}`;
    if (!labels.length || !s.includes(held) || !/^Occupied/.test(s)) return s.replace(/held occupied by /gi, 'held occupied · ');
    // A label that already says "occupied" (Bed occupied) adds nothing in brackets.
    const extra = labels.filter((l) => !/occupied/i.test(l));
    return s.replace(held, '').replace(/^Occupied/, extra.length ? `Occupied (${extra.join(' · ')})` : 'Occupied');
  };
  function bannerFor(m, items) {
    const mine = items.filter((i) => i.key === m.key);
    // A heating hold (window or door open) suspends heating whether or not the sensor saw the target
    // diverge from the mode: a safety minimum can make the target equal the mode's own.
    if ((m.target_reason === 'window open' || m.heat_labels.length) && m.cfg.climate) {
      const why = m.heat_labels.length ? m.heat_labels.join(' · ') : 'Window open';
      // The controller waits out a grace period before forcing the minimum; until then the hold is
      // true but heating is not yet suspended.
      if (m.heat_labels.length && m.target_reason !== 'window open' && m.heating_source !== 'safety') {
        return { warn: true, title: why, body: 'Heating drops to minimum if it stays open.' };
      }
      const set = m.target === null ? 'The valve is held' : `The valve is set to ${fmt1(m.target)}°`;
      const ends = m.target_reason === 'window open' && m.mode_name && m.mode_target !== null ? ` and returns to ${m.mode_name} (${fmt1(m.mode_target)}°) once it closes` : ' until all clear';
      return { warn: true, title: 'Heating suspended', body: `${why}. ${set}${ends}.` };
    }
    if (mine.length) {
      return { warn: true, title: mine.length === 1 ? itemLabel(mine[0], m) : `${mine.length} things need attention`, body: mine.length === 1 ? itemDetail(mine[0], m) : mine.map((i) => itemDetail(i, m)).join('. ') };
    }
    if (m.cfg.report && !m.hasReport) return { warn: false, dim: true, title: 'No report yet', body: 'sensor.info_rooms has no entry for this room.' };
    if (!m.cfg.report) return { warn: false, title: 'Lights only', body: 'This area has scenes and a lights automation, no climate or presence report.' };
    return { warn: false, title: 'All good', body: tidyVerdict(m.verdict, m.pres_labels) || 'No reasons to show.' };
  }

  // ── Sections ─────────────────────────────────────────────────────────────────────────────────
  function sectionNowHeader(hass) {
    const mode = state(hass, 'sensor.house_active_mode');
    const mod = state(hass, 'input_select.house_active_mode_modifier');
    const pill = usable(mode) ? `<div class="tag ok" style="padding:3px 9px">● ${esc(mode.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))}${usable(mod) && mod !== 'none' ? ' · ' + esc(mod) : ''}</div>` : '';
    return `<div style="display:flex;align-items:center;gap:10px;min-height:44px"><div style="font-size:28px;font-weight:700;letter-spacing:-.4px">Pulse</div>${pill}</div>`;
  }

  // People and Mo on ONE row: 30px chips, 12px text, nowrap. Texts are shortened before anything could wrap.
  function peopleChips(hass, at) {
    const person = (id, name, wfh) => {
      const st = state(hass, id);
      const home = st === 'home';
      const w = state(hass, wfh) === 'on';
      const label = !usable(st) ? '?' : home && w ? 'WFH' : home ? 'Home' : 'Away';
      return `<div class="chip"><span class="dot${home ? '' : ' dim'}" style="width:7px;height:7px"></span>${esc(name)} · ${label}</div>`;
    };
    const ate = moAte(hass, at).replace('yesterday', 'yest');
    return `<div class="chips">${person('person.adam', 'Adam', 'input_boolean.wfh_adam')}${person('person.sarah', 'Sarah', 'input_boolean.wfh_sarah')}<a class="chip tap" data-act="nav" data-path="${MOBILE}/mo" style="color:${TOKENS.text2}">Mo${ate ? ' · ' + esc(ate) : ''}</a></div>`;
  }

  // Now / Next (graded colours) and Usage (unit-aware). A reading that has not updated for 10 minutes
  // is stale (the meter reports every few seconds), so it shows a dash rather than a confident 0 W.
  // The next cheapest-2h window, read from the target-rate binary sensor itself (next_time keeps its date;
  // the template sensors print HH:MM only, so a window on tomorrow's evening looked like today's).
  const CHEAPEST_ID = 'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours';
  function cheapestWindow(hass, now) {
    const st = stateObj(hass, CHEAPEST_ID);
    if (!st || !isObj(st.attributes)) return { status: 'none' };
    const a = st.attributes;
    const running = st.state === 'on';
    const hm = localHm;
    if (running) {
      let end = instantMs(a.current_end);
      const cs = instantMs(a.current_start);
      const dur = num(a.current_duration_in_hours);
      if (end === null && cs !== null && dur !== null && dur > 0) end = cs + dur * 3600000;
      return { status: 'running', end, endText: end !== null ? hm(end) : '' };
    }
    const start = instantMs(a.next_time);
    const dur = num(a.next_duration_in_hours);
    if (start === null || dur === null || dur <= 0) return { status: 'none' };
    const end = start + dur * 3600000;
    if (end <= now) return { status: 'none' }; // already past: never advertise it
    const avgRaw = num(a.next_average_value);
    const avg = avgRaw === null ? null : avgRaw * 100;
    const today = localDate(now);
    const startDay = localDate(start);
    const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
    const diff = Math.round((dayMs(startDay) - dayMs(today)) / 86400000);
    const dayWord = start <= now ? 'Now' : diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : (isoDayLabel(startDay) || startDay);
    return { status: 'upcoming', start, end, avg, dayWord, range: `${hm(start)} → ${hm(end)}`, text: `${dayWord} ${hm(start)} → ${hm(end)}` };
  }

  function priceFigures(hass, at) {
    const base = 'sensor.octopus_energy_electricity_24e8140196_1012483035417';
    const p = (v) => (v === null ? null : v * 100);
    const nowP = p(num(state(hass, `${base}_current_rate`)));
    const nextP = p(num(state(hass, `${base}_next_rate`)));
    const wState = stateObj(hass, 'sensor.glow_electricity_power');
    const wAge = wState ? parseTs(wState.last_updated) : null;
    const stale = wAge !== null && at - wAge > 600000;
    const usageText = stale ? '–' : formatPower(state(hass, 'sensor.glow_electricity_power'), attr(hass, 'sensor.glow_electricity_power', 'unit_of_measurement'));
    return { nowP, nextP, usageText };
  }

  // Energy page head: Now / Next / Usage (a reading that has not updated for 10 minutes shows a dash).
  function priceStrip(hass, at) {
    const { nowP, nextP, usageText } = priceFigures(hass, at);
    return `<div style="display:flex;gap:16px;align-items:flex-end">
<div><div class="lbl">Now</div><div style="font-size:26px;font-weight:700;letter-spacing:-.5px;line-height:1.15;color:${priceColour(nowP, { text: true })}">${nowP === null ? '–' : fmt1(nowP)}<span style="font-size:12px;font-weight:500;color:${TOKENS.text2}"> p/kWh</span></div></div>
<div><div class="lbl">Next</div><div style="font-size:18px;font-weight:600;color:${priceColour(nextP, { text: true })};line-height:1.5">${nextP === null ? '–' : fmt1(nextP) + 'p'}</div></div>
<div style="flex:1"></div><div style="text-align:right"><div class="lbl">Usage</div><div style="font-size:18px;font-weight:600;line-height:1.5">${usageText}</div></div></div>`;
  }

  // Status card price row: one 56px+ link to the Energy page (Now / Next / Usage, chevron), and under it the
  // cheapest-2h window with its Today/Tomorrow label (hidden when past or unknown).
  function statusPriceLink(hass, at) {
    const { nowP, nextP, usageText } = priceFigures(hass, at);
    const cw = cheapestWindow(hass, at);
    const lbl = (t) => `<div class="lbl" style="margin:0">${t}</div>`;
    const cue = cw.status === 'running' ? `<div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">Cheapest 2h · <b style="color:${TOKENS.text};font-weight:600">running now${cw.endText ? ', until ' + esc(cw.endText) : ''}</b></div>` : cw.status === 'upcoming' ? `<div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">Cheapest 2h · <b style="color:${TOKENS.text};font-weight:600">${esc(cw.text)}</b></div>` : '';
    return `<a class="tap pstrip" data-act="nav" data-path="${ENERGY_PATH}" aria-label="Open energy details"><div>${lbl('Now')}<div style="font-size:24px;font-weight:700;letter-spacing:-.5px;line-height:1.15;color:${priceColour(nowP, { text: true })}">${nowP === null ? '–' : fmt1(nowP)}<span style="font-size:11.5px;font-weight:500;color:${TOKENS.text2}"> p</span></div></div><div>${lbl('Next')}<div style="font-size:17px;font-weight:600;line-height:1.45;color:${priceColour(nextP, { text: true })}">${nextP === null ? '–' : fmt1(nextP) + 'p'}</div></div><div>${lbl('Usage')}<div style="font-size:17px;font-weight:600;line-height:1.45">${usageText}</div></div><div style="flex:1"></div><span style="color:${TOKENS.link};display:flex">${svg('M9 5l7 7-7 7', 20)}</span></a>${cue}`;
  }

  function heatingRooms(hass) {
    return ROOM_ORDER.filter((k) => roomModel(hass, k).hvac_action === 'heating');
  }

  const occupiedRooms = (hass) => ROOM_ORDER.filter((k) => { const m = roomModel(hass, k); return m.hasReport && m.occupied; });

  // One status card: dot + verdict (amber with the attention summary when there are items), the
  // occupancy/heating sentence, people and Mo chips, and the price strip.
  function sectionStatus(hass, at) {
    const items = attentionItems(hass);
    const n = heatingRooms(hass).length;
    const occ = occupiedRooms(hass).length;
    const sentence = `${occ} ${plural(occ, 'room', 'rooms')} occupied · ${n > 0 ? `heating in ${n} ${plural(n, 'room', 'rooms')}` : 'heating idle'}`;
    const hasData = !!stateObj(hass, 'sensor.info_attention');
    const side = `<div style="font-size:12px;color:${TOKENS.text2};text-align:right">${esc(sentence)}</div>`;
    let head;
    if (items.length === 0) {
      head = `<div style="display:flex;align-items:center;gap:10px"><span class="dot${hasData ? '' : ' dim'}"></span><div style="font-size:15px;font-weight:700">${hasData ? 'All good' : 'No attention report'}</div><div style="flex:1"></div>${side}</div>`;
    } else {
      const first = items[0];
      const path = ROOMS[first.key] ? roomPath(first.key) : MOBILE;
      // The summary is room and what; the room card below carries the sentence.
      const shown = items.slice(0, 3).map((i) => `<div style="font-size:13px;margin-top:6px;line-height:1.4"><b>${esc(i.room)}</b> · ${esc(itemLabel(i, ROOMS[i.key] ? roomModel(hass, i.key) : null))}</div>`).join('');
      const more = items.length > 3 ? `<div style="font-size:12px;color:${TOKENS.text2};margin-top:4px">+${items.length - 3} more</div>` : '';
      head = `<a class="tap" data-act="nav" data-path="${esc(path)}" style="display:block"><div style="display:flex;align-items:center;gap:10px"><span class="dot warn"></span><span style="font-size:15px;font-weight:700;color:${TOKENS.amber}">${items.length} ${plural(items.length, 'needs', 'need')} attention</span><div style="flex:1"></div>${side}</div>${shown}${more}</a>`;
    }
    return `<div class="card pad${items.length ? ' warn' : ''}">${head}<div style="margin-top:10px">${peopleChips(hass, at)}</div><div style="margin-top:12px;padding-top:4px;border-top:1px solid ${TOKENS.divider}">${statusPriceLink(hass, at)}</div></div>`;
  }

  // ── Rooms: three groups, quiet by default ───────────────────────────────────────────────────
  // A room is in exactly one group: attention first, then occupied, then everything else (fixed order).
  function roomGroups(hass) {
    const flagged = new Set(attentionItems(hass).map(keyFromItem).filter(Boolean));
    const attention = ROOM_ORDER.filter((k) => flagged.has(k));
    const occupied = occupiedRooms(hass).filter((k) => !flagged.has(k));
    const other = ROOM_ORDER.filter((k) => !flagged.has(k) && !occupied.includes(k));
    return { attention, occupied, other };
  }

  const SHORT_HOLD = { 'Window open': 'Window', 'Door open': 'Door' };
  const shortHold = (l) => SHORT_HOLD[l] || l;
  // A recent real action (under 15 minutes) as a phrase with its verb ("lights off 7 min ago"). Without a
  // known verb there is no note: a bare "7 min" means nothing.
  const ACTION_PHRASE = {
    lighting: { turn_on: 'lights on', turn_off: 'lights off', activate_scene: 'scene set' },
    heating: { set_mode: 'heating changed', suspend: 'heating suspended', restore: 'heating restored' },
    occupied: { set_occupied: 'marked occupied', clear_occupied: 'marked empty' },
  };
  function recentNote(hass, key, now) {
    const e = roomFeed(hass, key)[0];
    if (!e) return '';
    const t = parseTs(e.ts);
    const phrase = ACTION_PHRASE[str(e.sub)] && ACTION_PHRASE[str(e.sub)][str(e.decision)];
    if (t === null || !phrase) return '';
    const age = now - t;
    if (age >= RECENT_MS || age < -60000) return '';
    return age < 60000 ? `${phrase} just now` : `${phrase} ${Math.floor(age / 60000)} min ago`;
  }
  const badge = (inner, style) => `<span class="badge"${style ? ` style="${style}"` : ''}>${inner}</span>`;
  const sizedIcon = (path, px, color) => `<svg class="ic" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="${color || 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  function lightsBadgeText(m, scene) {
    if (m.lights_on > 0) return scene && scene !== 'off' ? sceneLabel(scene) : 'On';
    return 'Off';
  }
  function manualBadge(m, now, short) {
    if (!m.manual) return '';
    const a = short ? '' : ago(m.manual.ts, now);
    const src = SOURCE_WORDS[m.manual.source] || m.manual.source;
    const label = `${src.replace(/^./, (c) => c.toUpperCase())}${a ? ' · ' + a : ''}`;
    return badge(`${sizedIcon(ICON.hand, 13)}${esc(label)}`, `color:${TOKENS.amber};background:${TOKENS.amberTag}`).replace('<span class="badge"', '<span class="badge" title="Manual change"');
  }
  const holdBadges = (m) => m.heat_labels.map((l) => badge(`${sizedIcon(ICON.window, 12)}${esc(shortHold(l))}`)).join('');
  const tempText = (m) => (m.temp !== null ? `${fmt1(m.temp)}°` : '–');
  // Rooms without a climate sensor have no temperature to show at all (a bare dash adds nothing).
  // Temperature slot: a number, a muted dash when a climate sensor has no reading, and a muted "no climate"
  // for rooms that have no climate sensor at all (never a bare dash there).
  const tempBlock = (m, style) => (m.cfg.climate ? `<div style="${style}${m.temp === null ? ';color:' + TOKENS.text3 : ''}">${tempText(m)}</div>` : `<div style="font-size:12px;font-weight:500;color:${TOKENS.text3}">no climate</div>`);

  function attentionCard(hass, k, items) {
    const m = roomModel(hass, k);
    const lines = [];
    if (m.target_reason && m.target !== null) lines.push(`<div class="l"><b>Heating</b><span>target ${fmt1(m.target)}° (${esc(m.target_reason)})${m.mode_name && m.mode_target !== null ? `. Normally ${esc(m.mode_name)}, ${fmt1(m.mode_target)}°.` : '.'}</span></div>`);
    if (m.pres_labels.length) lines.push(`<div class="l"><b>Held occupied</b><span>${esc(m.pres_labels.join(' · '))}</span></div>`);
    for (const i of items.filter((x) => x.key === k)) lines.push(`<div class="l"><b>${esc(itemLabel(i, m))}</b><span>${esc(itemDetail(i, m))}</span></div>`);
    const tags = m.labels.concat(m.heat_labels.filter((l) => !m.labels.includes(l))).map((l) => `<span class="tag">${esc(l)}</span>`).join('');
    if (tags) lines.push(`<div class="l">${tags}</div>`);
    return `<div class="card warn pad"><div style="display:flex;align-items:center;gap:8px"><span class="dot warn"></span><div style="flex:1;font-size:16px;font-weight:600;display:flex;align-items:center;gap:6px">${esc(m.cfg.short)}${occIcon(m)}</div>${tempBlock(m, 'font-size:22px;font-weight:700;letter-spacing:-.3px')}</div><div class="det" style="padding:8px 0 0">${lines.join('')}<a class="link tap" data-act="nav" data-path="${roomPath(k)}">${esc(m.cfg.short)} details ›</a></div></div>`;
  }

  function occupiedCard(hass, k, now) {
    const m = roomModel(hass, k);
    const scene = activeScene(hass, k);
    const recent = recentNote(hass, k, now).replace(/^lights /, '');
    const lights = badge(`${sizedIcon(ICON.bulb, 13, m.lights_on > 0 ? TOKENS.sceneActive : undefined)}${esc(lightsBadgeText(m, scene))}`);
    const holds = m.pres_labels.slice(0, 2).map((l) => badge(esc(l))).join('');
    return `<a class="card oc tap" data-act="nav" data-path="${roomPath(k)}">${occIcon(m, 20)}<div class="nm">${esc(m.cfg.short)}</div><div class="t">${tempBlock(m, 'font-size:20px;font-weight:700;letter-spacing:-.3px')}</div><div class="sub">${lights}${manualBadge(m, now)}${holdBadges(m)}${holds}${recent ? `<span>${esc(recent)}</span>` : ''}</div></a>`;
  }

  // Fixed-height tile: name / temperature (centred) / status line pinned to the bottom. The status line never
  // wraps; at most one badge (a hold wins over the manual marker) so it cannot grow the tile.
  function roomTile(hass, k, now, wide) {
    const m = roomModel(hass, k);
    const scene = activeScene(hass, k);
    const recent = recentNote(hass, k, now).replace(/^lights /, '');
    const holds = m.hasReport ? holdBadges(m) : '';
    // One extra item at most, and the manual badge drops its age here: the tile must stay one line.
    const extra = m.hasReport ? (holds || manualBadge(m, now, true) || (recent ? `<span>${esc(recent)}</span>` : '')) : '';
    const line = `${sizedIcon(ICON.bulb, 14)}<span>${m.hasReport ? esc(lightsBadgeText(m, scene)) : 'No report'}</span>${extra}`;
    return `<a class="rt tap${wide ? ' wide' : ''}" data-act="nav" data-path="${roomPath(k)}"><div class="nm">${occIcon(m) || sizedIcon(ICON.person, 15, TOKENS.text3)}<span>${esc(m.cfg.short)}</span></div><div class="t">${tempBlock(m, `font-size:20px;font-weight:700;letter-spacing:-.3px;line-height:${TILE.tempLine}px`)}</div><div class="b">${line}</div></a>`;
  }

  function sectionRooms(hass, now) {
    const g = roomGroups(hass);
    const items = attentionItems(hass);
    const out = [];
    if (g.attention.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">Needs attention</div>${g.attention.map((k) => attentionCard(hass, k, items)).join('')}`);
    if (g.occupied.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">Occupied now</div>${g.occupied.map((k) => occupiedCard(hass, k, now)).join('')}`);
    if (g.other.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">${g.occupied.length || g.attention.length ? 'Other rooms' : 'Rooms'}</div><div class="rgrid">${g.other.map((k, i) => roomTile(hass, k, now, g.other.length % 2 === 1 && i === g.other.length - 1)).join('')}</div>`);
    return out.join('');
  }

  // The meter sensor reports kW today but could be W: read the unit, never assume it. An unknown
  // unit shows a dash, because a wrong unit is worse than no number.
  function formatPower(value, unit) {
    const v = num(value);
    if (v === null) return '–';
    const u = str(unit).trim().toLowerCase();
    const w = u === 'kw' ? v * 1000 : u === 'w' ? v : null;
    if (w === null) return '–';
    return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
  }

  // "ate 03:44" / "ate yesterday 18:05" / "ate Fri 18:05" from sensor.mo_timeline eating[0].ts
  // (epoch ms, newest first, same source as views/mo.yaml). Empty when there is no data.
  function moAte(hass, at) {
    const list = attr(hass, 'sensor.mo_timeline', 'eating');
    const first = Array.isArray(list) && isObj(list[0]) ? num(list[0].ts) : null;
    if (first === null || first < 946684800000) return '';
    const d = new Date(first);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(new Date(at)) - day(d)) / 86400000);
    if (diff <= 0) return `ate ${time}`;
    if (diff === 1) return `ate yesterday ${time}`;
    if (diff < 7) return `ate ${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
    return `ate ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
  }

  const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  function hslToHex(h, sat, l) {
    const S = sat / 100;
    const L = l / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
  }
  const luminance = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  // price (pence) -> hex. Never throws: a non-finite price is neutral grey. `text: true` returns a
  // variant lightened until it has >= 4.5:1 contrast on the card surface, for figures.
  function priceColour(p, opts) {
    const v = typeof p === 'number' ? p : typeof p === 'string' && p.trim() !== '' ? Number(p) : NaN;
    const text = !!(opts && opts.text);
    if (!Number.isFinite(v)) return text ? lift(PRICE_NEUTRAL) : PRICE_NEUTRAL;
    if (v <= 0) return text ? lift(PRICE_NEGATIVE) : PRICE_NEGATIVE;
    if (v >= PRICE_EXTREME_P) return text ? lift(PRICE_EXTREME) : PRICE_EXTREME;
    let lo = PRICE_STOPS[0];
    let hi = PRICE_STOPS[PRICE_STOPS.length - 1];
    for (let i = 0; i < PRICE_STOPS.length - 1; i += 1) {
      if (v >= PRICE_STOPS[i][0] && v <= PRICE_STOPS[i + 1][0]) { lo = PRICE_STOPS[i]; hi = PRICE_STOPS[i + 1]; break; }
    }
    const t = hi[0] === lo[0] ? 0 : (v - lo[0]) / (hi[0] - lo[0]);
    const mix = (i) => lo[i] + (hi[i] - lo[i]) * t;
    const hex = hslToHex(mix(1), mix(2), mix(3));
    return text ? lift(hex) : hex;
  }
  // Lighten (mix toward white) until the colour reads on the card surface.
  function lift(hex) {
    let out = hex;
    for (let i = 1; i <= 10 && contrast(out, TOKENS.surface) < 4.5; i += 1) {
      const m = (c) => hex2(parseInt(hex.slice(c, c + 2), 16) + (255 - parseInt(hex.slice(c, c + 2), 16)) * (i / 10));
      out = `#${m(1)}${m(3)}${m(5)}`;
    }
    return out;
  }
  // Price bars: one slot per entry of the Octopus current-day rates list (46, 48 or 50 on clock-change
  // days; never assumed), x anchored to the first slot start and last slot end, negative slots below
  // a zero baseline. Drawn here (not apexcharts-card) so the whole energy block is one surface and
  // every pixel decision is testable in node.
  const PLOT_H = 96;
  const SLOT_W = 6;
  function rateBands(rates, now) {
    const out = [];
    for (const r of Array.isArray(rates) ? rates : []) {
      if (!isObj(r)) continue;
      const start = Date.parse(r.start);
      const end = Date.parse(r.end);
      const v = Number(r.value_inc_vat) * 100;
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(v) || end <= start) continue;
      out.push({ start, end, v, state: end <= now ? 'past' : start <= now ? 'current' : 'future' });
    }
    return out.sort((x, y) => x.start - y.start);
  }

  const RATES_ENTITY = 'event.octopus_energy_electricity_24e8140196_1012483035417_current_day_rates';
  const NEXT_RATES_ENTITY = 'event.octopus_energy_electricity_24e8140196_1012483035417_next_day_rates';
  const ratesOf = (hass, day) => attr(hass, day === 'tomorrow' ? NEXT_RATES_ENTITY : RATES_ENTITY, 'rates');
  const SCRUB_HOLD_MS = 2000;
  const SCRUB_TAP_PX = 6;

  // Slot index under a pointer: x within a chart `width` px wide, n slots of equal width. Clamped to
  // the first/last slot; null when there is nothing to hit (no slots, zero width, bad input).
  function slotAt(x, width, n) {
    if (!Number.isFinite(x) || !Number.isFinite(width) || !Number.isFinite(n) || width <= 0 || n < 1) return null;
    return Math.max(0, Math.min(n - 1, Math.floor((x / width) * n)));
  }

  // What the tooltip says about one slot (a rateBands entry): local range, price, colour, short note.
  function slotReadout(slot) {
    if (!isObj(slot) || !Number.isFinite(slot.start) || !Number.isFinite(slot.end) || !Number.isFinite(slot.v)) return null;
    const t = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const notes = [];
    if (slot.state === 'current') notes.push('now');
    if (slot.v < 0) notes.push('paid to use');
    else if (slot.v === 0) notes.push('free');
    const price = `${fmt1(slot.v)}p`;
    const range = `${t(slot.start)}-${t(slot.end)}`;
    return { range, price, note: notes.join(' · '), colour: priceColour(slot.v, { text: true }), spoken: `${range.replace('-', ' to ')}, ${fmt1(slot.v)} pence${notes.length ? ', ' + notes.join(', ') : ''}` };
  }

  // Tooltip left edge: centred on the slot, clamped to stay inside the chart box.
  function tooltipLeft(centerPx, tipWidth, boxWidth) {
    if (![centerPx, tipWidth, boxWidth].every(Number.isFinite) || boxWidth <= 0) return 0;
    return Math.max(0, Math.min(boxWidth - Math.max(0, tipWidth), centerPx - tipWidth / 2));
  }

  function priceChart(rates, now, day) {
    const slots = rateBands(rates, now);
    if (slots.length === 0) return `<div style="font-size:12px;color:${TOKENS.text2};margin-top:12px">No price data for today.</div>`;
    const n = slots.length;
    const lo = Math.min(0, ...slots.map((x) => x.v));
    let hi = Math.max(0, ...slots.map((x) => x.v));
    if (hi - lo < 1) hi = lo + 1;
    const y = (v) => ((hi - v) / (hi - lo)) * (PLOT_H - 2) + 1;
    const y0 = y(0);
    const bars = slots.map((x, i) => {
      const top = Math.min(y(x.v), y0);
      const h = Math.max(1.5, Math.abs(y(x.v) - y0));
      const fill = x.state === 'current' ? TOKENS.text : priceColour(x.v);
      const op = x.state === 'past' ? 0.45 : 1;
      return `<rect x="${i * SLOT_W}" y="${top.toFixed(1)}" width="${SLOT_W - 1}" height="${h.toFixed(1)}" rx="1" fill="${fill}" opacity="${op}"/>`;
    }).join('');
    const cur = slots.findIndex((x) => x.state === 'current');
    const marker = cur >= 0 ? `<line x1="${cur * SLOT_W + (SLOT_W - 1) / 2}" x2="${cur * SLOT_W + (SLOT_W - 1) / 2}" y1="0" y2="${PLOT_H}" stroke="${TOKENS.text}" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" opacity=".6"/>` : '';
    // Hour labels follow the slots' real start times in the viewer's zone, so a 25-hour day is right.
    const ticks = slots.map((x, i) => {
      const d = new Date(x.start);
      return d.getMinutes() === 0 && d.getHours() % 6 === 0 ? `<span style="position:absolute;left:${((i / n) * 100).toFixed(2)}%;transform:translateX(-50%)">${String(d.getHours()).padStart(2, '0')}</span>` : '';
    }).join('');
    const cheapest = slots.reduce((a, x) => (x.v < a.v ? x : a), slots[0]);
    const dearest = slots.reduce((a, x) => (x.v > a.v ? x : a), slots[0]);
    const at = (x) => hhmm(new Date(x.start).toISOString());
    const label = `Half-hourly electricity price, ${n} slots. Cheapest ${fmt1(cheapest.v)}p at ${at(cheapest)}, dearest ${fmt1(dearest.v)}p at ${at(dearest)}.${cur >= 0 ? ` Now ${fmt1(slots[cur].v)}p.` : ''}`;
    const grad = [0, 15, 25, 35, 44.9].map((pp, i) => `${priceColour(pp)} ${(i / 4) * 100}%`).join(',');
    const key = `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:10px;color:${TOKENS.text3}" aria-hidden="true"><span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:3px;background:${PRICE_NEGATIVE}"></span>≤0p</span><span style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="height:6px;border-radius:3px;background:linear-gradient(to right,${grad})"></span><span style="display:flex;justify-content:space-between"><span>${PRICE_KEY_P[0]}</span><span>${PRICE_KEY_P[1]}</span><span>${PRICE_KEY_P[2]}</span><span>${PRICE_KEY_P[3]}p+</span></span></span><span style="width:10px;height:10px;border-radius:3px;background:${PRICE_EXTREME}"></span></div>`;
    // The wrapper is the focusable, scrubbable chart (touch-action: pan-y keeps vertical page scroll;
    // horizontal drags scrub). Guide and tooltip are positioned by the element, not re-rendered.
    return `<div class="chart" data-chart data-day="${day === 'tomorrow' ? 'tomorrow' : 'today'}" data-n="${n}" tabindex="0" role="img" aria-label="${esc(label)}" style="position:relative;margin-top:36px;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none"><svg viewBox="0 0 ${n * SLOT_W} ${PLOT_H}" preserveAspectRatio="none" width="100%" height="${PLOT_H}" aria-hidden="true" style="display:block">${bars}<line x1="0" x2="${n * SLOT_W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="${TOKENS.text3}" stroke-width=".8" vector-effect="non-scaling-stroke"/>${marker}</svg>
<span style="position:absolute;left:0;top:${Math.max(0, y0 - 14).toFixed(0)}px;font-size:10px;color:${TOKENS.text3};pointer-events:none">0</span><div data-guide style="display:none;position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:${TOKENS.text};opacity:.7;pointer-events:none"></div><div data-tip class="tip" style="display:none"></div></div><span class="sr" aria-live="polite" data-live></span>
<div style="position:relative;height:14px;font-size:10px;color:${TOKENS.text3};margin-top:4px">${ticks}</div>${key}`;
  }

  // The energy block is ONE card: numbers, bars, cheapest-2h and the tomorrow note.
  // ── Energy page ───────────────────────────────────────────────────────────────────────────────
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const localHm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // Cheapest / dearest slot and the time-weighted average price of a day's slots (rateBands entries).
  // Weighted by slot length so a clock-change day (or any uneven slot) is right. Null when empty.
  function energyStats(slots) {
    const list = (Array.isArray(slots) ? slots : []).filter((x) => isObj(x) && Number.isFinite(x.start) && Number.isFinite(x.end) && Number.isFinite(x.v) && x.end > x.start);
    if (list.length === 0) return null;
    let min = list[0];
    let max = list[0];
    let sum = 0;
    let span = 0;
    for (const x of list) {
      if (x.v < min.v) min = x;
      if (x.v > max.v) max = x;
      sum += x.v * (x.end - x.start);
      span += x.end - x.start;
    }
    const at = (x) => ({ v: x.v, start: x.start, end: x.end, time: localHm(x.start) });
    return { cheapest: at(min), dearest: at(max), avg: sum / span, slots: list.length };
  }
  const penceText = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}p` : '–');

  // Negative (< 0p) and cheap (0 <= p < 10p) windows computed from the same slot list as the chart, not
  // from the template sensors: those sort ISO strings with mixed offsets, which scrambles a clock-change
  // day. Slots are ordered by instant (rateBands sorts by parsed ms) and merged only when one ends exactly
  // where the next starts, so the repeated hour cannot split, duplicate or zero-length a window.
  const WINDOW_CHEAP_MAX_P = 10;
  function slotWindows(slots, kind) {
    const pick = kind === 'negative' ? (v) => v < 0 : (v) => v >= 0 && v < WINDOW_CHEAP_MAX_P;
    const list = (Array.isArray(slots) ? slots : []).filter((x) => isObj(x) && Number.isFinite(x.start) && Number.isFinite(x.end) && Number.isFinite(x.v) && x.end > x.start).sort((x, y) => x.start - y.start);
    const out = [];
    let cur = null;
    for (const x of list) {
      if (!pick(x.v)) { cur = null; continue; }
      if (cur && cur.end === x.start) {
        cur.sum += x.v * (x.end - x.start);
        cur.end = x.end;
      } else {
        cur = { start: x.start, end: x.end, sum: x.v * (x.end - x.start) };
        out.push(cur);
      }
    }
    return out.map((w) => ({ start: w.start, end: w.end, avg: w.sum / (w.end - w.start) }));
  }
  // "HH:MM → HH:MM" in the viewer's zone. If both ends print the same (a window spanning the repeated
  // hour on a clock-change day) the zone abbreviation is added so it never reads as zero-length.
  function windowRange(w) {
    const hm = localHm;
    const a = hm(w.start);
    const b = hm(w.end);
    if (a !== b) return `${a} → ${b}`;
    const z = (ms) => { try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms)); } catch (e) { return hm(ms); } };
    return `${z(w.start)} → ${z(w.end)}`;
  }

  // "Fri 23 Oct" from the ISO date part of a published timestamp, in the zone it was published in
  // (not the viewer's), so the label is the day the provider meant.
  function isoDayLabel(iso) {
    const m = typeof iso === 'string' ? iso.match(/^(\d{4})-(\d\d)-(\d\d)/) : null;
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : `${WEEKDAYS[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1]}`;
  }

  // The day a "previous accumulative" sensor covers, from its charges list (first start, and the last
  // end must be 22-26 h later so a partial list is not mistaken for a whole day). null = cannot tell.
  function coveredDay(attrs) {
    const charges = isObj(attrs) ? parseList(attrs.charges) : [];
    const starts = charges.map((c) => ({ raw: c.start, t: Date.parse(c.start) })).filter((x) => Number.isFinite(x.t));
    if (starts.length === 0) return null;
    starts.sort((a, b) => a.t - b.t);
    const ends = charges.map((c) => Date.parse(c.end)).filter(Number.isFinite);
    if (ends.length) {
      const span = Math.max(...ends) - starts[0].t;
      if (span < 22 * 3600000 || span > 26 * 3600000) return null;
    }
    return isoDayLabel(starts[0].raw);
  }

  const money = (v, unit) => {
    const n = num(v);
    const u = str(unit).trim();
    if (n === null || !(u === 'GBP' || u === '£')) return '–';
    return `${n < 0 ? '−' : ''}£${Math.abs(n).toFixed(2)}`;
  };
  // kWh, Wh or MWh in -> "17.9 kWh". Anything else (or no unit) is a dash: a wrong unit is worse than none.
  function energyText(value, unit) {
    const n = num(value);
    const f = { kwh: 1, wh: 0.001, mwh: 1000 }[str(unit).trim().toLowerCase()];
    if (n === null || f === undefined) return '–';
    const k = n * f;
    return `${Math.abs(k) >= 100 ? Math.round(k) : k.toFixed(1)} kWh`;
  }

  // Standing charge is only claimed when the attributes prove it (total_without_standing_charge and
  // standing_charge, as exposed by the Octopus sensors): total == without + standing within a penny and a
  // half, or total == without (then it is explicitly excluded). Otherwise no claim.
  function standingNote(total, attrs) {
    const a = isObj(attrs) ? attrs : {};
    const without = num(a.total_without_standing_charge);
    const standing = num(a.standing_charge);
    if (total === null || without === null) return '';
    // Published figures are each rounded to the penny, so the sum can be a penny out (3.58 vs 3.11 + 0.46).
    if (standing !== null && Math.abs(total - (without + standing)) <= 0.015) return 'incl. standing charge';
    if (Math.abs(total - without) < 0.005) return 'excl. standing charge';
    return '';
  }

  function costTile(hass, label, costId, kwhId) {
    const a = isObj(stateObj(hass, costId) && stateObj(hass, costId).attributes) ? stateObj(hass, costId).attributes : {};
    const total = usable(state(hass, costId)) ? num(state(hass, costId)) : null;
    const day = coveredDay(a) || 'latest complete day';
    const note = standingNote(total, a);
    const kwh = usable(state(hass, kwhId)) ? energyText(state(hass, kwhId), attr(hass, kwhId, 'unit_of_measurement') || 'kWh') : '–';
    return `<div class="card u"><div class="lbl" style="margin:0">${esc(label)}</div><div class="v">${usable(state(hass, costId)) ? money(state(hass, costId), a.unit_of_measurement) : '–'}</div><div style="font-size:11.5px;color:${TOKENS.text2};margin-top:2px">${esc(day)} · ${esc(kwh)}${note ? ' · ' + esc(note) : ''}</div></div>`;
  }

  function sectionEnergyHead(hass, at) {
    return `<div style="display:flex;align-items:center;gap:4px"><a class="tap" data-act="nav" data-path="${DASH}/now" aria-label="Back to Now" style="min-height:44px;min-width:44px;display:flex;align-items:center;color:${TOKENS.text2}">${svg(ICON.back, 22)}</a><div style="font-size:28px;font-weight:700;letter-spacing:-.4px">Energy</div></div>
<div class="card pad">${priceStrip(hass, at, true)}</div>`;
  }

  // Day segmented control, chart, stats and windows for the selected day. They share one element so
  // the selected day survives hass updates (ui.day) and never needs re-rendering mid-scrub.
  function sectionEnergyDay(hass, at, ui) {
    const day = ui && ui.day === 'tomorrow' ? 'tomorrow' : 'today';
    const seg = (id, label) => `<button class="seg${day === id ? ' on' : ''}" data-act="energy-day" data-day="${id}" aria-pressed="${day === id}">${label}</button>`;
    const rates = ratesOf(hass, day);
    const slots = rateBands(rates, at);
    const control = `<div class="segs">${seg('today', 'Today')}${seg('tomorrow', 'Tomorrow')}</div>`;
    if (slots.length === 0) {
      const late = day === 'tomorrow';
      return `${control}<div class="card pad"><div style="font-size:14px;font-weight:600">${late ? 'Tomorrow\'s rates are not in yet' : 'No price data for today'}</div><div style="font-size:12.5px;color:${TOKENS.text2};margin-top:4px;line-height:1.4">${late ? 'Tomorrow\'s rates are published late afternoon.' : 'The rates list is empty or unavailable.'}</div></div>${windowsCard(hass, [], at)}`;
    }
    const st = energyStats(slots);
    const stat = (k, v, sub, col) => `<div class="card stat"><div class="k">${k}</div><div class="v" style="${col ? 'color:' + col : ''}">${v}</div><div class="s">${sub}</div></div>`;
    const stats = `<div style="display:flex;gap:8px">${stat('Cheapest', penceText(st.cheapest.v), 'at ' + st.cheapest.time, priceColour(st.cheapest.v, { text: true }))}${stat('Dearest', penceText(st.dearest.v), 'at ' + st.dearest.time, priceColour(st.dearest.v, { text: true }))}${stat('Average', penceText(st.avg), 'per kWh', priceColour(st.avg, { text: true }))}</div>`;
    return `${control}<div class="card pad">${priceChart(rates, at, day)}<div style="font-size:11.5px;color:${TOKENS.text3};margin-top:8px">Drag across the chart to read any half hour.</div></div>${stats}${windowsCard(hass, slots, at)}`;
  }

  function windowsCard(hass, slots, at) {
    const rows = [];
    const cw = cheapestWindow(hass, at);
    const row = (title, sub, right) => `<div class="wrow"><div><div style="font-weight:600">${title}</div><div class="m">${sub}</div></div>${right}</div>`;
    if (cw.status === 'running') rows.push(row('Next cheapest 2 hours', `Running now${cw.endText ? ', until ' + esc(cw.endText) : ''}`, '<span class="tag ok">Running now</span>'));
    else if (cw.status === 'upcoming') rows.push(row('Next cheapest 2 hours', `${esc(cw.text)}${cw.avg !== null ? ' · avg ' + esc(penceText(cw.avg)) : ''}`, '<span class="tag ok">Best</span>'));
    else rows.push(row('Next cheapest 2 hours', 'none upcoming', ''));
    if (Array.isArray(slots) && slots.length) {
      for (const [kind, label] of [['negative', 'Negative'], ['cheap', 'Cheap']]) {
        const ws = slotWindows(slots, kind);
        if (ws.length === 0) rows.push(row(label, 'none', ''));
        else for (const w of ws) rows.push(row(label, esc(windowRange(w)), `<div class="r" style="color:${priceColour(w.avg, { text: true })}">avg ${esc(penceText(w.avg))}</div>`));
      }
    }
    return `<div class="lbl" style="margin:4px 4px -10px">Windows</div><div class="card">${rows.join('')}</div>`;
  }

  // Real published data only, always labelled with the day it covers. Octopus publishes a day or two late.
  function sectionEnergyCost(hass) {
    const e = 'sensor.octopus_energy_electricity_24e8140196_1012483035417_previous_accumulative';
    const g = 'sensor.octopus_energy_gas_e6s15257822462_2986733608_previous_accumulative';
    return `<div class="lbl" style="margin:4px 4px -10px">Cost (latest published day)</div>
<div style="display:flex;gap:8px">${costTile(hass, 'Electricity', `${e}_cost`, `${e}_consumption`)}${costTile(hass, 'Gas', `${g}_cost`, `${g}_consumption_kwh`)}</div>
<div style="font-size:11.5px;color:${TOKENS.text3};margin:-6px 4px 0">Octopus publishes about 1-2 days late, so these cover an earlier day, not today.</div>`;
  }

  // ── Daily cost history (recorder long-term statistics) ────────────────────────────────────────
  // Source: the sensor's own statistics (they include the standing charge). Never chart raw `state`
  // over time or `sum`: `state` resets daily and `sum` is cumulative. Each covered day shows up as a
  // GROUP of hourly rows sharing one `last_reset` (local midnight of the day covered) and one `state`;
  // the rows' own `start` times are NOT the covered day. So: group by the last_reset INSTANT, the cost
  // is the group's state, and the covered date is last_reset in the HA time zone (DST-safe: no +1h).
  const COST_STAT = {
    electricity: 'sensor.octopus_energy_electricity_24e8140196_1012483035417_previous_accumulative_cost',
    gas: 'sensor.octopus_energy_gas_e6s15257822462_2986733608_previous_accumulative_cost',
  };
  const HIST_DAYS = 14;
  const HIST_LOOKBACK_DAYS = 21;
  const HIST_MIN_ROWS = 20; // a covered day has ~24 hourly rows per publication; fewer means a partial group
  const HIST_REFRESH_MS = 30 * 60000;
  const HIST_RETRY_MS = 5 * 60000;

  // Statistics times arrive as epoch ms (or seconds) or ISO strings depending on version.
  function instantMs(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
    if (typeof v === 'string' && v.trim() !== '') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
    return null;
  }
  // "YYYY-MM-DD" of an instant in an IANA zone; falls back to the viewer's zone for a bad zone name.
  function localDate(ms, tz) {
    const fmt = (zone) => new Intl.DateTimeFormat('en-CA', { ...(zone ? { timeZone: zone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    let parts;
    try { parts = fmt(tz); } catch (e) { parts = fmt(undefined); }
    const g = (t) => parts.find((x) => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }
  function histRequest(nowMs) {
    return {
      type: 'recorder/statistics_during_period',
      start_time: new Date(nowMs - HIST_LOOKBACK_DAYS * 86400000).toISOString(),
      statistic_ids: [COST_STAT.electricity, COST_STAT.gas],
      period: 'hour',
      types: ['state', 'last_reset', 'sum', 'change'],
    };
  }

  // rows -> [{date, cost, rows, lastReset}] oldest first, at most `days`. Partial groups (< minRows) are
  // dropped except the newest, which is legitimately still filling. Never invents a day.
  function groupDailyCost(rows, tz, opts) {
    const days = (opts && opts.days) || HIST_DAYS;
    const minRows = opts && opts.minRows !== undefined ? opts.minRows : HIST_MIN_ROWS;
    const groups = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!isObj(r)) continue;
      const reset = instantMs(r.last_reset);
      const cost = num(r.state);
      if (reset === null || cost === null) continue;
      const at = instantMs(r.start);
      let g = groups.get(reset);
      if (!g) { g = { lastReset: reset, rows: 0, cost, at: at === null ? -Infinity : at }; groups.set(reset, g); }
      g.rows += 1;
      if (at !== null && at >= g.at) { g.at = at; g.cost = cost; } // latest row's state (identical across a group)
    }
    if (groups.size === 0) return [];
    const newest = Math.max(...groups.keys());
    const byDate = new Map();
    for (const g of groups.values()) {
      if (g.rows < minRows && g.lastReset !== newest) continue;
      const date = localDate(g.lastReset, tz);
      const prev = byDate.get(date);
      if (!prev || g.rows > prev.rows || (g.rows === prev.rows && g.lastReset > prev.lastReset)) byDate.set(date, { date, cost: g.cost, rows: g.rows, lastReset: g.lastReset });
    }
    return [...byDate.values()].sort((a, b) => a.lastReset - b.lastReset).slice(-days);
  }
  // WS result ({statistic_id: rows[]}) -> {electricity: days[], gas: days[]}. A missing or malformed series is [].
  function dailyCostFromWS(result, tz) {
    const res = isObj(result) ? result : {};
    return { electricity: groupDailyCost(res[COST_STAT.electricity], tz), gas: groupDailyCost(res[COST_STAT.gas], tz) };
  }

  const dayTick = (date) => { const l = isoDayLabel(date); return l ? l.split(' ').slice(0, 2).join(' ') : ''; };
  // Readout for a scrubbed day, shaped like slotReadout so the scrub code can share it.
  function dayReadout(day) {
    if (!isObj(day) || !Number.isFinite(day.v) || typeof day.date !== 'string') return null;
    const label = isoDayLabel(day.date);
    if (!label) return null;
    const price = money(day.v, 'GBP');
    return { range: label, price, note: day.state === 'current' ? 'latest' : '', colour: TOKENS.text, spoken: `${label}, ${price}${day.state === 'current' ? ', latest' : ''}` };
  }
  // Average of the shown days; the standing-charge note is only repeated when the cost card has verified it.
  function dailySummary(days, standing) {
    const list = (Array.isArray(days) ? days : []).filter((d) => isObj(d) && Number.isFinite(d.cost));
    if (list.length === 0) return '';
    const avg = list.reduce((a, d) => a + d.cost, 0) / list.length;
    return `${list.length}-day average ${money(avg, 'GBP')}${standing === 'incl. standing charge' ? ' · incl. standing charge' : ''}`;
  }

  function costChart(days) {
    const n = days.length;
    const COL_W = 24;
    const vals = days.map((d) => d.cost);
    const lo = Math.min(0, ...vals);
    let hi = Math.max(0, ...vals);
    if (hi - lo < 0.01) hi = lo + 0.01;
    const y = (v) => ((hi - v) / (hi - lo)) * (PLOT_H - 2) + 1;
    const y0 = y(0);
    const bars = days.map((d, i) => {
      const top = Math.min(y(d.cost), y0);
      const h = Math.max(1.5, Math.abs(y(d.cost) - y0));
      const latest = i === n - 1;
      return `<rect x="${i * COL_W + 2}" y="${top.toFixed(1)}" width="${COL_W - 4}" height="${h.toFixed(1)}" rx="2" fill="${TOKENS.link}" opacity="${latest ? 1 : 0.55}"/>`;
    }).join('');
    const ticks = days.map((d, i) => ((n - 1 - i) % 2 === 0 ? `<span style="position:absolute;left:${(((i + 0.5) / n) * 100).toFixed(2)}%;transform:translateX(-50%);white-space:nowrap">${esc(dayTick(d.date))}</span>` : '')).join('');
    const hiDay = days.reduce((a, d) => (d.cost > a.cost ? d : a), days[0]);
    const loDay = days.reduce((a, d) => (d.cost < a.cost ? d : a), days[0]);
    const lbl = (d) => `${money(d.cost, 'GBP')} on ${isoDayLabel(d.date)}`;
    const label = `Daily cost, ${n} ${plural(n, 'day', 'days')}. Highest ${lbl(hiDay)}, lowest ${lbl(loDay)}, latest ${lbl(days[n - 1])}.`;
    return `<div class="chart" data-chart data-kind="cost" data-n="${n}" tabindex="0" role="img" aria-label="${esc(label)}" style="position:relative;margin-top:36px;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none"><svg viewBox="0 0 ${n * COL_W} ${PLOT_H}" preserveAspectRatio="none" width="100%" height="${PLOT_H}" aria-hidden="true" style="display:block">${bars}<line x1="0" x2="${n * COL_W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="${TOKENS.text3}" stroke-width=".8" vector-effect="non-scaling-stroke"/></svg>
<span style="position:absolute;left:0;top:${Math.max(0, y0 - 14).toFixed(0)}px;font-size:10px;color:${TOKENS.text3};pointer-events:none">£0</span><div data-guide style="display:none;position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:${TOKENS.text};opacity:.7;pointer-events:none"></div><div data-tip class="tip" style="display:none"></div></div><span class="sr" aria-live="polite" data-live></span>
<div style="position:relative;height:14px;font-size:9.5px;color:${TOKENS.text3};margin-top:4px">${ticks}</div>`;
  }

  // Electricity | Gas toggle, bars for up to 14 covered days, readout on scrub, honest loading/unavailable states.
  function sectionEnergyHistory(hass, at, ui) {
    const fuel = ui && ui.fuel === 'gas' ? 'gas' : 'electricity';
    const seg = (id, label) => `<button class="seg${fuel === id ? ' on' : ''}" data-act="cost-fuel" data-fuel="${id}" aria-pressed="${fuel === id}">${label}</button>`;
    const h = ui && isObj(ui.hist) && isObj(ui.hist[fuel]) ? ui.hist[fuel] : { status: 'loading', days: [] };
    const days = Array.isArray(h.days) ? h.days : [];
    let body;
    if (h.status === 'loading') body = `<div style="font-size:13px;color:${TOKENS.text2}">Loading history…</div>`;
    else if (h.status !== 'ok' || days.length === 0) body = `<div style="font-size:14px;font-weight:600">History unavailable</div><div style="font-size:12.5px;color:${TOKENS.text2};margin-top:4px;line-height:1.4">The recorded cost history could not be read. The latest published day is shown above.</div>`;
    else {
      const id = COST_STAT[fuel];
      const total = usable(state(hass, id)) ? num(state(hass, id)) : null;
      const summary = dailySummary(days, standingNote(total, isObj(stateObj(hass, id)) ? stateObj(hass, id).attributes : {}));
      body = `${costChart(days)}<div style="font-size:12.5px;margin-top:8px">${esc(summary)}</div><div style="font-size:11.5px;color:${TOKENS.text3};margin-top:4px">Drag across the bars to read a day. Published about 1-2 days late.</div>`;
    }
    return `<div class="lbl" style="margin:4px 4px -10px">Daily cost</div><div class="segs">${seg('electricity', 'Electricity')}${seg('gas', 'Gas')}</div><div class="card pad">${body}</div>`;
  }

  function sectionEnergyUsage(hass) {
    const tile = (label, id) => {
      const text = usable(state(hass, id)) ? energyText(state(hass, id), attr(hass, id, 'unit_of_measurement')) : '–';
      const [v, u] = text === '–' ? ['–', ''] : text.split(' ');
      return `<div class="card u"><div class="lbl" style="margin:0">${label}</div><div class="v">${esc(v)}${u ? ` <span>${u}</span>` : ''}</div></div>`;
    };
    return `<div class="lbl" style="margin:4px 4px -10px">Usage (smart meter, live)</div>
<div style="display:flex;gap:8px">${tile('Electricity today', 'sensor.glow_electricity_today')}${tile('Gas today', 'sensor.glow_gas_today')}</div>
<div style="display:flex;gap:8px">${tile('Electricity this month', 'sensor.glow_electricity_month')}${tile('Gas this month', 'sensor.glow_gas_month')}</div>
<div style="font-size:11.5px;color:${TOKENS.text3};margin:-6px 4px 0">Live from the meter; the Octopus figures above are the supplier's, days late. They are not reconciled.</div>`;
  }

  // Bins (what is due next, and when) beside Heating (boiler state, inside/outside).
  function sectionBinsHeating(hass) {
    const names = { food: 'Food', paid_garden: 'Garden', recycling: 'Recycling', refuse: 'Refuse' };
    const bins = Object.keys(names).map((k) => ({ n: names[k], d: num(state(hass, `sensor.st_albans_collect_domestic_${k}_days_until_collection`)) })).filter((b) => b.d !== null);
    let binTitle = '–';
    let binSub = 'no collection data';
    let soon = false;
    if (bins.length) {
      const next = Math.min(...bins.map((b) => b.d));
      binTitle = bins.filter((b) => b.d === next).map((b) => b.n).join(' · ');
      binSub = next <= 0 ? 'today' : next === 1 ? 'tomorrow' : `in ${Math.round(next)} days`;
      soon = next <= 1;
    }
    const off = state(hass, 'input_boolean.house_heating_enabled') === 'off';
    const firing = state(hass, 'binary_sensor.house_heating_boiler_firing') === 'on';
    const rooms = heatingRooms(hass).length;
    const hTitle = off ? 'Heating off' : firing ? `Boiler firing · ${rooms} ${plural(rooms, 'room', 'rooms')}` : 'Boiler idle';
    const inside = num(state(hass, 'sensor.house_average_temperature'));
    const outside = num(attr(hass, 'weather.forecast_home', 'temperature'));
    const patio = state(hass, 'input_boolean.patio_door_heating_suspended') === 'on' ? ' · patio open' : '';
    const hSub = [inside !== null ? `in ${fmt1(inside)}°` : '', outside !== null ? `out ${fmt1(outside)}°` : ''].filter(Boolean).join(' · ') + patio || 'no readings';
    return `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px"><div class="card" style="padding:12px 14px${soon ? ';background:' + TOKENS.amberTag : ''}"><div class="lbl">Bins</div><div style="font-size:15px;font-weight:600;margin-top:4px${soon ? ';color:' + TOKENS.amber : ''}">${esc(binTitle)}</div><div style="font-size:12px;color:${soon ? TOKENS.amber : TOKENS.text2}">${esc(binSub)}</div></div><div class="card" style="padding:12px 14px"><div class="lbl">Heating</div><div style="font-size:15px;font-weight:600;margin-top:4px">${esc(hTitle)}</div><div style="font-size:12px;color:${TOKENS.text2}">${esc(hSub)}</div></div></div>`;
  }

  function sectionFeed(hass, now) {
    const entries = feedEntries(hass);
    const body = entries.length ? feedRows(entries, now, 3) : `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">No decisions seen since Home Assistant started.</span></div>`;
    return `<div class="lbl" style="margin:4px 4px -10px">What the house did</div><div class="card">${body}</div>`;
  }

  // The Mobile link lives in the tab bar's Controls tab; the text link is the fallback when the bar is off.
  function sectionFooter() {
    if (TABBAR_ENABLED) return '';
    return `<div style="padding:4px 4px 24px"><a class="link tap" data-act="nav" data-path="${MOBILE}">Open Mobile controls ›</a></div>`;
  }

  // ── Bottom tab bar ─────────────────────────────────────────────────────────────────────────────
  // position:fixed only works if no ancestor creates a containing block for fixed descendants (transform,
  // filter, perspective, contain, will-change, backdrop-filter). tabbarPlacement decides from computed-style
  // snapshots of the ancestors: 'fixed' when none does, otherwise 'inflow' (a normal bar at the end of the
  // page, still usable, never overlapping) and names the offender. The card probes after its first paint and
  // defaults to 'inflow' until the probe says otherwise (fail safe).
  const TABS = [
    { id: 'now', label: 'Now', path: `${DASH}/now`, icon: 'home' },
    { id: 'energy', label: 'Energy', path: ENERGY_PATH, icon: 'bolt' },
    { id: 'controls', label: 'Controls', path: MOBILE, icon: 'sliders' },
  ];
  function tabbarPlacement(ancestors) {
    const none = (v) => v === undefined || v === null || v === '' || v === 'none';
    for (const a of Array.isArray(ancestors) ? ancestors : []) {
      if (!isObj(a)) continue;
      const name = str(a.name) || 'ancestor';
      let why = '';
      if (!none(a.transform)) why = 'transform';
      else if (!none(a.filter)) why = 'filter';
      else if (!none(a.backdropFilter)) why = 'backdrop-filter';
      else if (!none(a.perspective)) why = 'perspective';
      else if (/\b(paint|layout|strict|content)\b/.test(str(a.contain))) why = 'contain';
      else if (/(transform|filter|perspective|contain)/.test(str(a.willChange))) why = 'will-change';
      if (why) return { mode: 'inflow', offender: `${name} (${why})` };
    }
    return { mode: 'fixed', offender: null };
  }
  function sectionTabbar(cfg, ui) {
    if (!TABBAR_ENABLED) return '';
    const active = cfg && cfg.active === 'energy' ? 'energy' : 'now';
    const fixed = ui && ui.tb === 'fixed';
    const tabs = TABS.map((t) => `<button type="button" class="tab" data-act="nav" data-path="${t.path}"${t.id === active ? ' aria-current="page"' : ''}>${svg(ICON[t.icon], 24)}<span>${t.label}</span></button>`).join('');
    return `${fixed ? '<div class="tabbar-spacer" style="--tbh:calc(58px + max(10px, env(safe-area-inset-bottom, 0px)))" aria-hidden="true"></div>' : ''}<nav class="tabs${fixed ? ' fixed' : ''}" aria-label="Pulse">${tabs}</nav>`;
  }

  // ── Room page sections ───────────────────────────────────────────────────────────────────────
  // Whether the valve is calling for heat right now, from the climate entity's hvac_action. Unknown
  // actions say nothing rather than guess "not heating".
  function heatingStatus(m) {
    if (m.hvac_action === 'heating') return { on: true, text: 'Heating now' };
    if (m.hvac_action === 'idle') return { on: false, text: 'Not heating' };
    if (m.hvac_action === 'off') return { on: false, text: 'Heating off' };
    return null;
  }

  // Why the controller forced the minimum (heating source "safety"): a window or door held open past its
  // grace period, else house heating switched off. Named for the reader; "safety" is the controller's word.
  function safetyCause(m) {
    if (m.heat_labels.length) return m.heat_labels.join(' · ').toLowerCase();
    return m.house_heating_off ? 'house heating off' : '';
  }

  function sectionRoomHead(hass, key) {
    const m = roomModel(hass, key);
    const b = bannerFor(m, attentionItems(hass));
    const banner = `<div class="card pad${b.warn ? ' warn' : ''}" style="display:flex;gap:10px;align-items:flex-start"><span class="dot${b.warn ? ' warn' : b.dim ? ' dim' : ''}" style="margin-top:5px"></span><div><div style="font-size:15px;font-weight:700;${b.warn ? 'color:' + TOKENS.amber : ''}">${esc(b.title)}</div><div style="font-size:13px;color:${b.warn ? TOKENS.text : TOKENS.text2};margin-top:3px;line-height:1.45">${esc(b.body)}</div></div></div>`;
    let numbers = '';
    if (m.cfg.climate) {
      const differs = !!m.target_reason;
      const sub2 = differs ? (m.mode_name && m.mode_target !== null ? `Mode ${m.mode_name} ${fmt1(m.mode_target)}°` : m.target_reason.replace(/^./, (c) => c.toUpperCase())) : [m.heating_active.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), m.heating_source ? 'from ' + m.heating_source.replace(/_/g, ' ') : ''].filter(Boolean).join(' ');
      const hs = heatingStatus(m);
      const status = hs ? `<div style="display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;margin-top:2px;color:${hs.on ? TOKENS.heat : TOKENS.text2}">${hs.on ? svg(ICON.flame, 14) : ''}${hs.text}</div>` : '';
      numbers = `<div class="two"><div class="card pad"><div class="lbl">Room</div><div class="big">${m.temp === null ? '–' : fmt1(m.temp) + '°'}</div><div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${m.humidity === null ? 'no humidity' : Math.round(m.humidity) + '% humidity'}</div></div>
<div class="card pad"><div class="lbl">${differs ? 'Valve target' : 'Target'}</div><div class="big" style="${differs ? 'color:' + TOKENS.amber : ''}">${m.target === null ? '–' : fmt1(m.target) + '°'}</div>${status}<div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${esc(sub2)}</div></div></div>`;
    }
    return `<div style="display:flex;align-items:center;gap:4px"><a class="tap" data-act="nav" data-path="${DASH}/now" aria-label="Back to Now" style="min-height:44px;min-width:44px;display:flex;align-items:center;color:${TOKENS.text2}">${svg(ICON.back, 22)}</a><div style="font-size:28px;font-weight:700;letter-spacing:-.4px">${esc(m.cfg.name)}</div></div>${banner}${numbers}`;
  }

  function sectionWhy(hass, key, now) {
    const m = roomModel(hass, key);
    if (!m.hasReport) return '';
    const scene = activeScene(hass, key);
    const rows = [];
    const lightsTag = m.manual ? '<span class="tag">Manual</span>' : m.pres_labels.length ? '<span class="tag off">Hold</span>' : '<span class="tag ok">Auto</span>';
    const lightsSub = m.lights_why ? `${esc(m.lights_why.replace(/^./, (c) => c.toUpperCase()))}${m.lights_ts ? ' at ' + esc(hhmm(m.lights_ts)) : ''}.` : 'No lighting decision seen since Home Assistant started.';
    rows.push(`<div class="item">${svg(ICON.bulb, 18)}<div><div class="h">${esc(m.lights_on > 0 ? lightsPhrase(m, scene) : 'Lights off')}</div><div class="s">${lightsSub}</div></div>${lightsTag}</div>`);
    if (m.cfg.climate) {
      const differs = !!m.target_reason;
      const h = m.target !== null ? `Heating target ${fmt1(m.target)}°` : 'Heating';
      const s = differs ? `${esc(m.target_reason.replace(/^./, (c) => c.toUpperCase()))}${m.mode_name && m.mode_target !== null ? `. Normally ${esc(m.mode_name)}, ${fmt1(m.mode_target)}°` : ''}.` : [m.mode_name && m.mode_target !== null ? `${esc(m.mode_name.replace(/^./, (c) => c.toUpperCase()))} ${fmt1(m.mode_target)}°` : '', m.heating_source ? esc(m.heating_source.replace(/_/g, ' ')) : ''].filter(Boolean).join(' from ') || 'No mode reported.';
      const safety = !differs && m.heating_source === 'safety';
      const held = !differs && m.heat_labels.length > 0;
      const minT = m.mode_target !== null ? m.mode_target : m.target;
      const cause = safetyCause(m);
      const sub = safety ? `Held at ${esc(m.mode_name || 'minimum')}${minT !== null ? ' ' + fmt1(minT) + '°' : ''}${cause ? ' · ' + esc(cause) : ''}` : held ? `${esc(m.heat_labels.join(' · '))}. ${s}` : s;
      const tag = differs ? `<span class="tag">${esc(m.target_reason.replace(/^./, (c) => c.toUpperCase()))}</span>` : safety ? '<span class="tag">Suspended</span>' : held ? '<span class="tag">Pending</span>' : m.heating_enabled === false ? '<span class="tag">Automation off</span>' : m.hvac_action === 'heating' ? '<span class="tag heat">Heating</span>' : m.hvac_action === 'idle' ? '<span class="tag off">Idle</span>' : '';
      rows.push(`<div class="item">${svg(ICON.flame, 18)}<div><div class="h">${esc(h)}</div><div class="s">${sub}</div></div>${tag}</div>`);
    }
    // Presence holds belong to the occupancy row; heating holds (window, door) to the heating row.
    const holds = m.pres_labels;
    const occ = m.occupancy_unavailable ? 'Occupancy unavailable' : m.occupied ? 'Occupied' : 'Empty';
    const pres = holds.length ? `${esc(holds.join(' · '))}.${holds.length > 1 ? ' All are true, so it stays occupied until all clear.' : ''}` : 'No holds.';
    const ovr = m.override_text ? ` ${esc(m.override_text)}.` : '';
    rows.push(`<div class="item">${svg(ICON.person, 18)}<div><div class="h">${occ}</div><div class="s">${pres}${ovr}</div></div><span class="tag${m.override && !holds.length ? '' : ' off'}">${holds.length ? 'Held' : m.override ? 'Override' : 'Clear'}</span></div>`);
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
      const pill = `Manual · ${how}${when ? ' · ' + when : ''}`;
      // One quiet second line, only when it adds something: what was done (dashboard/switch changes) and
      // what the automation last did.
      const second = [m.manual.source !== 'wall_button' && m.manual.what ? m.manual.what : '', m.lights_why ? `Last automation event: ${m.lights_why}` : ''].filter(Boolean).join(' · ');
      foot = `<div class="mrow"><span class="tag">${esc(pill)}</span></div>${second ? `<div class="note" style="margin-top:6px">${esc(second)}</div>` : ''}`;
    } else if (m.lights_why) {
      foot = `<div class="note">Set by automation${m.lights_ts ? ' at ' + esc(hhmm(m.lights_ts)) : ''}: ${esc(m.lights_why)}. Tap a scene to take over.</div>`;
    } else {
      foot = '<div class="note">No automation action seen since Home Assistant started. Tap a scene to set one.</div>';
    }
    return `<div class="lbl" style="margin:4px 4px -10px">Lighting</div><div class="card" style="padding:12px 12px 10px"><div class="tiles" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${tiles}</div>${foot}</div>`;
  }

  function lightCounts(hass, key) {
    const m = roomModel(hass, key);
    if (m.lights_total > 0) return { on: m.lights_on, total: m.lights_total };
    const list = m.cfg.lights;
    return { on: list.filter(([id]) => state(hass, id) === 'on').length, total: list.length };
  }

  // Collapsible section kept inside the card (no expander-card): one header button with a single
  // chevron, collapsed by default. The open flag lives in the element instance (ui.open), so hass
  // updates do not reset it.
  function sectionLights(hass, key, ui) {
    const m = roomModel(hass, key);
    if (m.cfg.lights.length === 0) return '';
    const open = !!(ui && ui.open);
    const c = lightCounts(hass, key);
    const head = `<button class="lh tap" data-act="lights-toggle" aria-expanded="${open}"><span class="lbl">Individual lights</span><span style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:${TOKENS.text2}">${c.on} of ${c.total} on<span style="display:flex;transform:${open ? 'rotate(180deg)' : 'none'}">${svg(ICON.chev, 18)}</span></span></button>`;
    if (!open) return `<div class="card">${head}</div>`;
    const rows = m.cfg.lights.map(([id, label]) => {
      const s = stateObj(hass, id);
      if (!s || !usable(s.state)) return `<div class="tog"><div><div class="h">${esc(label)}</div><div class="s">${s ? 'Unavailable' : 'Not found'}</div></div></div>`;
      const on = s.state === 'on';
      const modes = attr(hass, id, 'supported_color_modes');
      const dimmable = id.startsWith('light.') && Array.isArray(modes) && modes.some((x) => x !== 'onoff');
      if (dimmable) {
        const pct = on ? Math.max(0, Math.min(100, Math.round(((num(attr(hass, id, 'brightness')) || 0) / 255) * 100))) : 0;
        return `<div class="lt"><div><div class="h">${esc(label)}</div><div class="s">${on ? pct + '%' : 'Off'}</div></div><input type="range" min="0" max="100" value="${pct}" style="--p:${pct}%" data-act="brightness" data-entity="${esc(id)}" aria-label="${esc(label)} brightness"></div>`;
      }
      return `<button class="tog tap" data-act="toggle" data-entity="${esc(id)}" aria-pressed="${on}"><div><div class="h">${esc(label)}</div><div class="s">${on ? 'On' : 'Off'}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`;
    }).join('');
    return `<div class="card">${head}${rows}</div>`;
  }

  function sectionMedia(hass, key) {
    const m = roomModel(hass, key);
    if (m.cfg.media.length === 0) return '';
    const rows = m.cfg.media.map(([id, label, kind]) => {
      const s = stateObj(hass, id);
      const name = esc(label); // the device role from the room config, not the entity's friendly name
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
      return `<div class="tog"><div><div class="h">${name}</div><div class="s">${esc(text)}</div></div><button class="round${playing ? '' : ' quiet'}" data-act="media-play" data-entity="${esc(id)}" aria-label="${playing ? 'Pause' : 'Play'}">${svg(playing ? ICON.pause : ICON.play, 20)}</button></div>${volRow}`;
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
    const body = entries.length ? feedRows(entries, now, 6) : `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">No activity in this room since Home Assistant started.</span></div>`;
    return `<div class="lbl" style="margin:4px 4px -10px">Recent activity</div><div class="card">${body}</div>`;
  }

  // ── Dispatcher ───────────────────────────────────────────────────────────────────────────────
  const MODES = {
    'now-header': (h) => sectionNowHeader(h),
    status: (h, c, n) => sectionStatus(h, n),
    rooms: (h, c, n) => sectionRooms(h, n),
    'bins-heating': (h) => sectionBinsHeating(h),
    'energy-head': (h, c, n) => sectionEnergyHead(h, n),
    'energy-day': (h, c, n, ui) => sectionEnergyDay(h, n, ui),
    'energy-cost': (h) => sectionEnergyCost(h),
    'energy-history': (h, c, n, ui) => sectionEnergyHistory(h, n, ui),
    'energy-usage': (h) => sectionEnergyUsage(h),
    feed: (h, c, n) => sectionFeed(h, n),
    footer: () => sectionFooter(),
    tabbar: (h, c, n, ui) => sectionTabbar(c, ui),
    'room-head': (h, c) => sectionRoomHead(h, c.room),
    why: (h, c, n) => sectionWhy(h, c.room, n),
    scenes: (h, c, n) => sectionScenes(h, c.room, n),
    lights: (h, c, n, ui) => sectionLights(h, c.room, ui),
    media: (h, c) => sectionMedia(h, c.room),
    automations: (h, c) => sectionAutomations(h, c.room),
    'room-feed': (h, c, n) => sectionRoomFeed(h, c.room, n),
  };
  const ROOM_MODES = ['room-head', 'why', 'scenes', 'lights', 'media', 'automations', 'room-feed'];

  function validate(config) {
    if (!isObj(config) || !MODES[config.mode]) throw new Error(`pulse-card: unknown mode "${config && config.mode}"`);
    if (ROOM_MODES.includes(config.mode) && !ROOMS[config.room]) throw new Error(`pulse-card: mode "${config.mode}" needs a known room, got "${config.room}"`);
  }

  function render(mode, config, hass, now, ui) {
    validate({ ...config, mode });
    const html = MODES[mode](hass, config || {}, Number.isFinite(now) ? now : Date.now(), ui || {});
    return html ? `<div class="p">${html}</div>` : '';
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

  const api = { TILE, TILE_H, TILE_WIDE_H, tileNeededHeight, STYLE, TABBAR_ENABLED, tabbarPlacement, TABS, cheapestWindow, entrySentence, tidyVerdict, COST_STAT, HIST_DAYS, HIST_MIN_ROWS, HIST_REFRESH_MS, histRequest, groupDailyCost, dailyCostFromWS, dayReadout, dailySummary, instantMs, localDate, energyStats, slotWindows, windowRange, coveredDay, isoDayLabel, standingNote, money, energyText, penceText, ENERGY_PATH, roomGroups, recentNote, slotAt, slotReadout, tooltipLeft, ratesOf, SCRUB_HOLD_MS, rateBands, DASH, MOBILE, formatPower, moAte, TOKENS, ROOMS, ROOM_ORDER, ALL_ROOM_KEYS, ALLOWED, render, priceColour, PRICE_STOPS, PRICE_EXTREME_P, roomModel, attentionItems, handleAction, callService, num, parseList };
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
        this._ui = { tb: 'inflow', open: false, day: 'today', fuel: 'electricity', hist: { electricity: { status: 'loading', days: [] }, gas: { status: 'loading', days: [] } } };
        this._histBusy = false;
        this._histSeq = 0;
        this._histAt = 0;
        this._histRetryAt = 0;
        this._scrub = { idx: null, slots: null, active: false, pending: null, timer: null };
        this._root.addEventListener('click', (ev) => this._click(ev));
        this._root.addEventListener('change', (ev) => this._change(ev));
        // Keep the track fill under the thumb while dragging (no re-render mid-drag).
        this._root.addEventListener('input', (ev) => { const t = ev.target; if (t && t.type === 'range') t.style.setProperty('--p', `${t.value}%`); });
        this._root.addEventListener('pointerdown', (ev) => { if (ev.target && ev.target.type === 'range') this._busy = true; });
        this._root.addEventListener('pointerup', () => { this._busy = false; });
        this._root.addEventListener('pointercancel', () => { this._busy = false; });
        // Price chart scrubbing (see PR for the manual test list; not testable in node).
        this._root.addEventListener('pointerdown', (ev) => this._chartDown(ev));
        this._root.addEventListener('pointermove', (ev) => this._chartMove(ev));
        this._root.addEventListener('pointerup', (ev) => this._chartUp(ev));
        this._root.addEventListener('pointercancel', () => this._chartCancel());
        this._root.addEventListener('keydown', (ev) => this._chartKey(ev));
        this._root.addEventListener('focusout', (ev) => { if (ev.target && ev.target.closest && ev.target.closest('[data-chart]') && !this._scrub.active) this._chartClear(); });
      }
      setConfig(config) {
        validate(config);
        this._config = config;
      }
      set hass(hass) {
        this._hass = hass;
        this._histEnsure();
        this._paint();
      }
      connectedCallback() {
        this._histEnsure();
        this._tabbarProbeLater();
      }
      disconnectedCallback() {
        this._histSeq += 1;
        this._histBusy = false;
        for (const t of this._tbTimers || []) clearTimeout(t);
        this._tbTimers = null;
      }
      // Daily cost history: one read-only WS call when the Energy view mounts, then at most every 30
      // minutes (a failure retries after 5), never per hass update, never overlapping, and a response
      // that arrives after unmount is dropped (the sequence number moved on).
      _histEnsure() {
        if (!this._config || this._config.mode !== 'energy-history' || !this._hass || !this.isConnected || this._histBusy) return;
        const now = Date.now();
        if (now < this._histRetryAt || (this._histAt && now - this._histAt < HIST_REFRESH_MS)) return;
        const set = (status, days) => { for (const f of ['electricity', 'gas']) this._ui.hist[f] = { status, days: days ? days[f] : [] }; };
        if (typeof this._hass.callWS !== 'function') { set('unavailable'); this._histRetryAt = now + HIST_RETRY_MS; return; }
        this._histBusy = true;
        const seq = (this._histSeq += 1);
        const tz = this._hass.config && this._hass.config.time_zone;
        let call;
        try { call = Promise.resolve(this._hass.callWS(histRequest(now))); } catch (e) { call = Promise.reject(e); }
        call
          .then((res) => {
            if (seq !== this._histSeq) return;
            const days = dailyCostFromWS(res, tz);
            if (days.electricity.length === 0 && days.gas.length === 0) throw new Error('empty statistics');
            set('ok', days);
            this._histAt = Date.now();
          })
          .catch((err) => {
            if (seq !== this._histSeq) return;
            console.warn('pulse-card: daily cost history unavailable', err && err.message ? err.message : err);
            if (!this._histAt) set('unavailable');
            this._histRetryAt = Date.now() + HIST_RETRY_MS;
          })
          .finally(() => {
            if (seq !== this._histSeq) return;
            this._histBusy = false;
            this._paint();
          });
      }
      getCardSize() { return 3; }
      _paint() {
        // Never re-render under a finger: a slider drag or a chart scrub owns the DOM until release.
        if (!this._config || !this._hass || this._busy || this._scrub.active) return;
        let html;
        try {
          html = render(this._config.mode, this._config, this._hass, Date.now(), this._ui);
        } catch (err) {
          // Fail loudly in the card itself rather than leaving a blank hole.
          html = `<div class="p"><div class="card warn pad"><b>pulse-card error</b><div class="s">${esc(err && err.message)}</div></div></div>`;
        }
        if (html === this._html) return;
        this._html = html;
        this.style.display = html ? '' : 'none';
        this._root.innerHTML = `<style>${STYLE}</style>${html}`;
        if (this._config.mode === 'tabbar' && !this._tbProbed) this._tabbarProbeLater();
        // The repaint replaced the chart nodes: put a live readout back instead of flickering it away.
        if (this._scrub.idx !== null) this._chartShow(this._scrub.idx, false);
      }
      // ── tab bar placement ──
      _tabbarProbeLater() {
        if (!this._config || this._config.mode !== 'tabbar' || this._tbTimers) return;
        // After the first paint and again shortly after (HA builds its ancestors asynchronously).
        this._tbTimers = [setTimeout(() => this._tabbarProbe(), 0), setTimeout(() => this._tabbarProbe(), 800)];
      }
      _tabbarProbe() {
        if (!this.isConnected || typeof getComputedStyle !== 'function') return;
        this._tbProbed = true;
        const snaps = [];
        let node = this;
        while (node) {
          if (node.nodeType === 1) {
            const cs = getComputedStyle(node);
            snaps.push({
              name: `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}`,
              transform: cs.transform, filter: cs.filter, perspective: cs.perspective, contain: cs.contain, willChange: cs.willChange,
              backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
            });
          }
          node = node.assignedSlot || node.parentNode || node.host || null;
        }
        const res = tabbarPlacement(snaps);
        if (res.mode === 'inflow' && !this._tbWarned) {
          this._tbWarned = true;
          console.warn(`pulse-card: tab bar placed in-flow because an ancestor breaks position:fixed: ${res.offender}`);
        }
        if (res.mode !== this._ui.tb) {
          this._ui.tb = res.mode;
          this._paint();
        }
      }
      // ── chart scrubbing ──
      _chartEl() { return this._root.querySelector('[data-chart]'); }
      _chartHoldTimer() {
        clearTimeout(this._scrub.timer);
        this._scrub.timer = setTimeout(() => this._chartClear(), SCRUB_HOLD_MS);
      }
      _chartSlots(chart) {
        if (chart.dataset.kind === 'cost') {
          const days = this._ui.hist[this._ui.fuel === 'gas' ? 'gas' : 'electricity'].days;
          return days.map((d, i) => ({ date: d.date, v: d.cost, state: i === days.length - 1 ? 'current' : 'past' }));
        }
        return rateBands(ratesOf(this._hass, chart.dataset.day), Date.now());
      }
      _chartIdx(ev, chart) {
        const box = chart.getBoundingClientRect();
        const n = this._scrub.slots ? this._scrub.slots.length : 0;
        return slotAt(ev.clientX - box.left, box.width, n);
      }
      _chartShow(idx, announce) {
        const chart = this._chartEl();
        const slots = this._scrub.slots;
        if (!chart || !slots || slots.length === 0) return;
        const i = Math.max(0, Math.min(slots.length - 1, idx));
        const r = chart.dataset.kind === 'cost' ? dayReadout(slots[i]) : slotReadout(slots[i]);
        if (!r) return;
        this._scrub.idx = i;
        const n = slots.length;
        const guide = chart.querySelector('[data-guide]');
        const tip = chart.querySelector('[data-tip]');
        const boxW = chart.clientWidth;
        guide.style.left = `${((i + 0.5) / n) * 100}%`;
        guide.style.display = 'block';
        chart.querySelectorAll('rect').forEach((b, k) => {
          if (k === i) { b.setAttribute('stroke', TOKENS.text); b.setAttribute('stroke-width', '1.5'); b.setAttribute('vector-effect', 'non-scaling-stroke'); } else { b.removeAttribute('stroke'); b.removeAttribute('stroke-width'); }
        });
        tip.innerHTML = `${esc(r.range)} · <b style="color:${r.colour}">${esc(r.price)}</b>${r.note ? `<small>${esc(r.note)}</small>` : ''}`;
        tip.style.display = 'block';
        tip.style.left = `${tooltipLeft(((i + 0.5) / n) * boxW, tip.offsetWidth, boxW)}px`;
        if (announce) { const live = this._root.querySelector('[data-live]'); if (live) live.textContent = r.spoken; }
      }
      _chartClear() {
        clearTimeout(this._scrub.timer);
        this._scrub.idx = null;
        this._scrub.active = false;
        const chart = this._chartEl();
        if (!chart) return;
        chart.querySelector('[data-guide]').style.display = 'none';
        chart.querySelector('[data-tip]').style.display = 'none';
        chart.querySelectorAll('rect').forEach((b) => { b.removeAttribute('stroke'); b.removeAttribute('stroke-width'); });
      }
      _chartStart(ev, chart) {
        clearTimeout(this._scrub.timer);
        this._scrub.slots = this._chartSlots(chart); // frozen for the whole gesture
        this._scrub.active = true;
        try { chart.setPointerCapture(ev.pointerId); } catch (e) { /* capture is best effort */ }
      }
      _chartDown(ev) {
        const chart = ev.target && ev.target.closest ? ev.target.closest('[data-chart]') : null;
        if (!chart || !this._hass || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
        this._scrub.pending = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, chart };
        if (ev.pointerType === 'mouse') { this._chartStart(ev, chart); this._chartShow(this._chartIdx(ev, chart), false); }
      }
      _chartMove(ev) {
        const pend = this._scrub.pending;
        if (!pend || pend.id !== ev.pointerId) return;
        if (!this._scrub.active) {
          // Touch: only a mostly-horizontal drag scrubs; a vertical one is the page scrolling.
          const dx = Math.abs(ev.clientX - pend.x);
          const dy = Math.abs(ev.clientY - pend.y);
          if (dx < SCRUB_TAP_PX || dx <= dy) return;
          this._chartStart(ev, pend.chart);
        }
        const idx = this._chartIdx(ev, pend.chart);
        if (idx !== null) this._chartShow(idx, false);
      }
      _chartUp(ev) {
        const pend = this._scrub.pending;
        if (!pend || pend.id !== ev.pointerId) return;
        this._scrub.pending = null;
        if (!this._scrub.active) {
          // A tap (no real movement) selects the slot under the finger.
          this._scrub.slots = this._chartSlots(pend.chart);
          const idx = this._chartIdx(ev, pend.chart);
          if (idx !== null) this._chartShow(idx, true);
        } else {
          this._scrub.active = false;
          this._chartShow(this._scrub.idx === null ? 0 : this._scrub.idx, true);
        }
        try { pend.chart.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
        if (this._scrub.idx !== null) this._chartHoldTimer();
      }
      _chartCancel() {
        // The browser took the gesture (vertical scroll): drop any readout at once.
        if (!this._scrub.pending && !this._scrub.active) return;
        this._scrub.pending = null;
        this._chartClear();
      }
      _chartKey(ev) {
        const chart = ev.target && ev.target.closest ? ev.target.closest('[data-chart]') : null;
        if (!chart || !this._hass) return;
        if (ev.key === 'Escape') { this._chartClear(); return; }
        const step = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
        if (!step && ev.key !== 'Home' && ev.key !== 'End') return;
        ev.preventDefault();
        clearTimeout(this._scrub.timer);
        this._scrub.slots = this._chartSlots(chart);
        const n = this._scrub.slots.length;
        if (n === 0) return;
        const cur = this._scrub.slots.findIndex((x) => x.state === 'current');
        const from = this._scrub.idx !== null ? this._scrub.idx : cur >= 0 ? cur : step < 0 ? n : -1;
        const to = ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : from + step;
        this._chartShow(Math.max(0, Math.min(n - 1, to)), true);
      }
      _click(ev) {
        const el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!el || !this._hass) return;
        if (el.dataset.act === 'nav') {
          ev.preventDefault();
          const path = el.dataset.path || '';
          if (path.startsWith('/')) {
            window.history.pushState(null, '', path);
            window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
          }
          return;
        }
        if (el.dataset.act === 'cost-fuel') {
          this._ui.fuel = el.dataset.fuel === 'gas' ? 'gas' : 'electricity';
          this._chartClear();
          this._paint();
          return;
        }
        if (el.dataset.act === 'energy-day') {
          this._ui.day = el.dataset.day === 'tomorrow' ? 'tomorrow' : 'today';
          this._chartClear();
          this._paint();
          return;
        }
        if (el.dataset.act === 'lights-toggle') {
          this._ui.open = !this._ui.open;
          this._paint();
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
