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
 *  - Every write gives feedback (see Tap feedback): the control shows busy until its entity moves or
 *    8 s pass, and a failed call shows an error on the card.
 *  - Write paths are whitelisted in ALLOWED. HA is a read-only consumer of homerun events: this
 *    card never publishes to MQTT and never calls anything but the services below.
 */
(function (root) {
  'use strict';

  // Switch the bottom tab bar off in one line (renders nothing).
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
.err{background:${TOKENS.amberBg};border:1px solid ${TOKENS.amberBorder};color:${TOKENS.amber};border-radius:12px;padding:10px 14px;font-size:13px;font-weight:600}
[aria-busy="true"]{opacity:.55;cursor:progress}
.tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:${TOKENS.amberTag};color:${TOKENS.amber};white-space:nowrap}
.tag.ok{background:${TOKENS.okBg};color:${TOKENS.ok}}
.tag.off{background:${TOKENS.divider};color:${TOKENS.text2}}
.tag.heat{background:${TOKENS.heatBg};color:${TOKENS.heat}}
.link{display:flex;align-items:center;min-height:44px;font-size:13px;font-weight:600;color:${TOKENS.link}}
.feed{display:grid;grid-template-columns:44px 1fr;gap:8px;font-size:12.5px;line-height:1.4;padding:8px 14px;border-top:1px solid ${TOKENS.divider}}
.feed:first-child{border-top:0}
.feed .a{color:${TOKENS.text3}}
.feed.muted{color:${TOKENS.text2}}
.feed.warn{color:${TOKENS.amber}}
.feed .g{display:inline-flex;vertical-align:-2px;margin-right:5px}
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
.stream{background:#0c0e12;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}
.stream ha-camera-stream{display:block;width:100%}
.ptz{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,48px);gap:6px;justify-content:center;padding:12px 14px;border-top:1px solid ${TOKENS.divider}}
.ptz button{border:0;border-radius:12px;background:${TOKENS.divider};color:${TOKENS.text};cursor:pointer;display:flex;align-items:center;justify-content:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.ptz button:active{transform:scale(.96)}
.ptz button:disabled{opacity:.35;cursor:default}
.clip{display:flex;align-items:center;gap:12px;padding:8px 14px;border-top:1px solid ${TOKENS.divider};width:100%;background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;font:inherit;text-align:left;cursor:pointer;min-height:62px}
.clip img{width:72px;height:48px;object-fit:cover;border-radius:8px;background:${TOKENS.divider};flex:none}
.clip .t{font-size:14px;font-weight:600}
.clip .w{font-size:12px;color:${TOKENS.text2};margin-top:2px}
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
.gbtn{border:0;font:inherit;font-size:13.5px;font-weight:600;min-height:44px;min-width:92px;padding:0 16px;border-radius:999px;cursor:pointer;background:${TOKENS.sceneActive};color:${TOKENS.sceneActiveText};align-self:center}
.gbtn.quiet{background:${TOKENS.divider};color:${TOKENS.text}}
.gbtn:disabled{opacity:.4;cursor:default}
.gl{align-items:center}
.lnk{display:block;min-height:44px;padding:0;margin-top:2px;border:0;background:none;color:${TOKENS.link};font:inherit;font-size:13px;font-weight:600;text-align:left;cursor:pointer}
.ovl{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:var(--sheet-inset,0px);box-sizing:border-box;overscroll-behavior:contain}
.scrim{position:absolute;inset:0;background:rgba(0,0,0,.6);touch-action:none}
.sheet{position:relative;max-height:var(--sheet-max,min(88vh,calc(100vh - env(safe-area-inset-top,0px) - 16px)));max-height:var(--sheet-max,min(88dvh,calc(100dvh - env(safe-area-inset-top,0px) - 16px)));min-height:0;display:flex;flex-direction:column;background:${TOKENS.ground};border-radius:20px 20px 0 0;border-top:1px solid ${TOKENS.divider};box-shadow:0 -8px 32px rgba(0,0,0,.5);animation:sheetup .22s ease-out;outline:none}
.sh{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px 8px;flex:none;touch-action:none}
.sb{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y;padding:0 14px calc(24px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:14px}
/* Scroll bug: flex children default to shrink, so a bounded .sb squeezed them (the .card clips) instead of overflowing, leaving nothing to scroll. */
.sb>*{flex-shrink:0}
@keyframes sheetup{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.sheet{animation:none}}
.rt.wide .t.gh{font-size:15px;font-weight:600;white-space:nowrap}
.big{font-size:32px;font-weight:700;letter-spacing:-.6px;line-height:1.1;margin-top:4px}
.two{display:flex;gap:10px}
.two .card{flex:1}
.note{font-size:11.5px;color:${TOKENS.text3};margin:10px 2px 0;line-height:1.4}
.mrow{display:flex;align-items:flex-start;gap:8px;margin:10px 2px 0}
.mrow span:last-child{font-size:11.5px;color:${TOKENS.text2};line-height:1.4}
`;

  // ── Room configuration (entity ids from views/*.yaml and packages/groups.yaml) ──────────────
  // `report` is the key in sensor.info_rooms. Gardens (kind 'garden') have no report, climate, scenes or
  // lights here: their lights come from sensor.<garden>_lighting_scenes and their look from `theme`, the
  // theme helper ('' when the garden has none). Gap, reported rather than guessed: foreign_office has no
  // media player in views/foreign-office.yaml.
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
    back_garden: { kind: 'garden', name: 'Back garden', short: 'Back garden', theme: '' },
    front_garden: { kind: 'garden', name: 'Front garden', short: 'Front garden', theme: 'input_select.front_garden_light_theme' },
  };
  const GARDEN_ORDER = ['front_garden', 'back_garden'];
  const isGarden = (key) => Object.prototype.hasOwnProperty.call(ROOMS, key) && ROOMS[key].kind === 'garden';
  // What the shared room code may read from a garden: nothing it would otherwise mistake for a room feature.
  const GARDEN_ROOM_DEFAULTS = { report: false, climate: '', temp: '', hum: '', scenes: [], lights: [], media: [] };
  const ROOM_ORDER = [
    'parlour', 'kitchen', 'hallway_downstairs', 'hallway_upstairs', 'bedroom', 'bathroom',
    'home_office', 'foreign_office',
  ];
  const ALL_ROOM_KEYS = Object.keys(ROOMS);

  // Where the dashboard is registered (url_path in configuration.yaml). Defined once: an unknown
  // path silently falls back to the default dashboard, which is exactly the bug this avoids.
  const DASH = '/pulse-dashboard';
  // The separate energy page. The Details link only renders when a card names this path in
  // `details_path`, and only when that view exists in info-dashboard.yaml (tests enforce both).
  const ENERGY_PATH = `${DASH}/energy`;
  const HOUSE_PATH = `${DASH}/house`;
  const SETTINGS_PATH = `${DASH}/settings`;
  const CAMERAS_PATH = `${DASH}/cameras`;
  const RECENT_MS = 15 * 60 * 1000;


  // Wall-button and other manual sources, in plain words.
  const SOURCE_WORDS = { dashboard: 'dashboard', switch: 'wall switch', wall_button: 'wall button' };

  // Write paths. Anything not listed here is refused loudly.
  const ALLOWED = {
    scene: ['turn_on'],
    light: ['turn_on', 'turn_off'],
    switch: ['turn_on', 'turn_off'],
    media_player: ['media_play_pause', 'volume_set', 'turn_on', 'turn_off'],
    button: ['press'],
    input_boolean: ['turn_on', 'turn_off'],
    input_select: ['select_option'],
    input_number: ['set_value'],
  };

  const ACTIVITY_ROWS = 10;
  const FEED_ROWS = 3; // House shows the latest few; the room pages hold the rest

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
    override_text: '', labels: [], manual: null,
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
    m.cfg = cfg.kind === 'garden' ? { ...GARDEN_ROOM_DEFAULTS, ...cfg } : cfg;
    m.window_off = cfg.kind === 'garden' ? windowOff(hass, key) : '';
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
    for (const k of ['target_reason', 'mode_name', 'heating_active', 'heating_source', 'scene', 'reason_text', 'override_text']) m[k] = str(m[k]);
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

  // The off time the garden's lights automation publishes (retained), or '' when none is known: callers drop
  // the time from their sentence rather than invent one.
  function windowOff(hass, key) {
    const v = state(hass, `sensor.${key}_lighting_window`);
    return /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : '';
  }

  // The sensor's items, plus one the card finds itself: homerun declares a reason this card has no wording
  // for. It comes last so a real room problem still leads the summary link.
  function attentionItems(hass) {
    const items = parseList(attr(hass, 'sensor.info_attention', 'items')).map((i) => ({
      room: str(i.room), key: str(i.key), kind: str(i.kind), text: str(i.text), nav: str(i.nav),
    }));
    const gaps = unexplainedReasons(hass);
    if (gaps.length) {
      const shown = gaps.slice(0, 3).join(', ') + (gaps.length > 3 ? ` +${gaps.length - 3} more` : '');
      items.push({ room: 'Pulse', key: '', kind: 'unexplained_reason', text: `No wording for ${shown}`, nav: '' });
    }
    return items;
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
      case 'motion_disabled': return 'Motion sensor off';
      case 'garden_theme_config': return 'Theme setup';
      case 'unexplained_reason': return 'Reason not worded';
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

  // ── Wording: homerun history entries in plain words ──────────────────────────────────────────
  // homerun publishes only structured data (reason keys, outcomes, facts); every sentence on screen is
  // written here. REASON_TEXT is keyed `subsystem:reason`, the same key the catalogue declares. A test
  // compares it with tests/fixtures/catalog.json, and at run time `unexplainedReasons` compares it with
  // sensor.homerun_catalog so a reason added without wording raises attention instead of vanishing.
  const capFirst = (t) => str(t).replace(/^./, (c) => c.toUpperCase());
  const pretty = (s) => str(s).replace(/_/g, ' ').trim();
  const LUX_MAX = 200000; // far above sunlight; keeps a corrupt reading from printing a 20-digit number
  const clampInt = (n, lo, hi) => Math.round(Math.min(hi, Math.max(lo, n)));
  const fmtLux = (v) => { const n = num(v); return n === null ? 'no light reading' : `${clampInt(n, 0, LUX_MAX)} lx`; };
  const fmtThreshold = (v) => { const n = num(v); return n === null ? 'a set level' : String(clampInt(n, 0, LUX_MAX)); };
  const fmtMinutes = (v) => { const n = num(v); return n === null ? 'a few minutes' : `${clampInt(n, 0, 24 * 60)} min`; };
  const fmtTheme = (v) => { const t = str(v).trim(); return t ? (THEME_LABELS[t.toLowerCase()] || capFirst(pretty(t))) : 'the new'; };
  // Entities are named by their friendly name, falling back to the id so a rename never hides the source.
  const entityName = (hass, id) => {
    const s = str(id);
    if (!s) return '';
    const f = attr(hass, s, 'friendly_name');
    return typeof f === 'string' && f.trim() ? f.trim() : s;
  };
  const luxText = (f) => `${fmtLux(f.lux)}, on below ${fmtThreshold(f.lux_threshold)}`;
  // Heating modes by the words the settings page uses (HOUSE_NUMBERS titles). Anything else is shown
  // as its own key so a new mode is readable rather than hidden.
  const MODE_WORDS = { comfort: 'comfort', baseline_day: 'day baseline', baseline_night: 'night baseline', minimum: 'minimum', off: 'off' };
  const modeWord = (v) => { const m = str(v).trim(); return m ? (MODE_WORDS[m] || pretty(m)) : ''; };
  const setTo = (v) => (modeWord(v) ? `set to ${modeWord(v)}` : 'mode changed');
  const TEMP_MAX = 50; // far above any room or boiler setpoint; keeps a corrupt reading short
  const fmtDegrees = (v) => { const n = num(v); return n === null ? '' : `${Math.round(Math.min(TEMP_MAX, Math.max(-TEMP_MAX, n)) * 10) / 10}°`; };
  const COUNT_MAX = 1000;
  const fmtCount = (v) => { const n = num(v); return n === null ? null : clampInt(n, 0, COUNT_MAX); };
  const POINTS_MAX = 100000000;
  const fmtPoints = (v) => { const n = num(v); return n === null ? '' : String(clampInt(n, 0, POINTS_MAX)); };
  // A room fact is a key ("home_office"), a comma-joined list of keys, or a name already in words.
  const roomName = (v) => {
    const t = str(v).trim();
    if (!t) return '';
    const key = t.toLowerCase().replace(/\s+/g, '_');
    return ROOMS[key] ? ROOMS[key].name : capFirst(pretty(t));
  };
  const roomList = (v) => str(v).split(',').map(roomName).filter(Boolean).join(', ');
  const lowerFirst = (t) => str(t).replace(/^./, (c) => c.toLowerCase());
  const themeOr = (v, fallback) => { const t = str(v).trim(); return t ? lowerFirst(fmtTheme(t)) : fallback; };

  const REASON_TEXT = {
    'lighting:automation_disabled': () => 'Stayed off: lights automation is off',
    'lighting:button_cycle': (f) => `Scene set · button pressed${str(f.scene) ? ` (${pretty(f.scene)})` : ''}`,
    'lighting:button_off': () => 'Lights off · button pressed off',
    'lighting:calendar_boundary': (f) => `Theme switched to ${fmtTheme(f.theme)} · calendar`,
    'lighting:calendar_boundary_catch_up': (f) => `Theme switched to ${fmtTheme(f.theme)} · calendar, after a restart`,
    'lighting:calendar_theme_not_an_option': (f) => `Theme left as it is: the calendar wants ${fmtTheme(f.theme)}, which is not an option`,
    'lighting:external_suppress_active': (f, c) => `Stayed off: held off by ${c.name(f.source) || 'something else'}`,
    'lighting:guest_room_sleep_bypass': () => 'Left on when the house went to sleep · guest mode',
    'lighting:house_sleep_mode': () => 'Lights off · house asleep',
    'lighting:lux_high': (f) => `Stayed off: bright enough (${luxText(f)})`,
    'lighting:lux_low': (f) => `Scene set · getting dark (${luxText(f)})`,
    'lighting:occupancy_off': () => 'Lights off · room emptied',
    'lighting:occupancy_settle_off': () => 'Lights off · room stayed empty',
    'lighting:on_outside_evening_window': (f) => `Preview started · turned on outside the evening (off after ${fmtMinutes(f.minutes)})`,
    'lighting:preview_ended': () => 'Lights off · preview over',
    'lighting:recent_auto_off': () => 'Scene set · back soon after lights went off',
    'lighting:schedule_off': () => 'Lights off · scheduled off',
    'lighting:sleep_mode': () => 'Stayed off: house asleep',
    'lighting:sunrise': () => 'Lights off · sunrise',
    'lighting:sunset': () => 'Lights on · sunset',
    'lighting:sunset_while_house_asleep': () => 'Stayed off at sunset: house asleep',
    'lighting:theme_changed': (f) => `Lights restyled · lighting theme changed to ${fmtTheme(f.theme)}`,
    'lighting:theme_changed_by_hand_today': () => 'Theme left as it is: changed by hand today',
    'lighting:theme_scene_missing': (f) => `Lights on · no scene for this theme (${fmtTheme(f.theme)})`,
    'lighting:automation_disabled_restore': () => 'Automation switched off · porch look restored',
    'lighting:halloween_scene_activated': () => 'Halloween effects started · scene activated',
    'lighting:hold_expired': () => 'Porch light back to its look · motion over',
    'lighting:hold_expired_look_missing_garden_off': () => 'Porch light off · motion over, no saved look and garden off',
    'lighting:look_unreadable': () => "Porch light not warmed: couldn't save its current look",
    'lighting:motion_detected': () => 'Porch light warmed · motion detected',
    'lighting:motion_during_fade_back': () => 'Porch light warmed again · motion while it faded back',
    'lighting:no_feature_lights': () => 'Halloween effects not started: no feature lights',
    'lighting:no_lights_in_theme_roles': (f) => `Effects not started: no lights set up for ${themeOr(f.theme, 'this theme')}`,
    'lighting:restore_look_missing': () => 'Porch light left as it is: no saved look to restore',
    'lighting:scene_changed_during_hold': () => 'Porch light warmed again · scene changed during motion',
    'lighting:scene_without_effects_activated': () => 'Light effects stopped · scene has none',
    'lighting:theme_opted_out': () => 'Porch light stayed as it is: this theme ignores motion',
    'lighting:theme_scene_settled': (f) => `Light effects started · ${themeOr(f.theme, 'new')} theme scene`,
    'heating:demand_ended': () => 'Boiler off · no room needs heat',
    'heating:demand_started': (f) => `Boiler on · ${roomList(f.rooms) || 'a room'} calling for heat`,
    'heating:door_closed_was_suspended': () => 'Heating restored · door closed, heating resumed',
    'heating:door_open_heating_on': () => 'Heating suspended · door open while heating',
    'heating:heating_disabled': () => 'Boiler off · heating switched off',
    'heating:helper_unavailable': (f) => `Heating left as it is: no ${modeWord(f.mode) || 'mode'} temperature available`,
    'heating:house_mode_away': (f) => `Heating ${setTo(f.mode)} · house away`,
    'heating:house_mode_sleep': (f) => `Heating ${setTo(f.mode)} · house asleep`,
    'heating:house_mode_vacation': (f) => `Heating ${setTo(f.mode)} · house on holiday`,
    'heating:manual_override': (f) => `Heating ${setTo(f.mode)} · manual setting`,
    'heating:overtemp_heater_on': (f) => `Heater off · too hot${fmtDegrees(f.temp) ? ` (${fmtDegrees(f.temp)})` : ''}`,
    'heating:safety_heating_disabled': (f) => `Heating ${setTo(f.mode)} · heating switched off`,
    'heating:safety_window_open': (f) => `Heating ${setTo(f.mode)} · window open`,
    'heating:schedule': (f) => `Heating ${setTo(f.mode)} · schedule`,
    'heating:schedule_occupied': (f) => `Heating ${setTo(f.mode)} · schedule, room occupied`,
    'heating:temperature_set_arbitrage': (f) => `Heating ${setTo(f.mode)}${fmtDegrees(f.target) ? ` (${fmtDegrees(f.target)})` : ''} · cheap power${fmtDegrees(f.clamped_from) ? `, limited from ${fmtDegrees(f.clamped_from)}` : ''}`,
    'heating:trvs_not_set': (f) => `Radiators left as they are: no temperature for the mode in ${roomList(f.skipped) || 'some rooms'}`,
    'heating:unknown_mode': (f) => `Heating left as it is: unknown mode${modeWord(f.mode) ? ` (${modeWord(f.mode)})` : ''}`,
    'heating:valve_characteristic_lost': (f) => `${roomName(f.room) || 'A'} radiator valve needs an adaptation run · notification sent`,
    'house_mode:all_left_door_recently': () => 'House set to away · everyone left',
    'house_mode:away_duration_exceeded': () => 'House set to holiday · away for a long time',
    'house_mode:bed_not_occupied': () => 'Sleep mode not started: bed empty',
    'house_mode:bed_occupied': () => 'Stayed in sleep mode: bed occupied',
    'house_mode:button_hold_bed_occupied': () => 'House set to sleep · button held, bed occupied',
    'house_mode:button_pressed': () => 'Left sleep mode · button pressed',
    'house_mode:double_press_bypass': () => 'House set to sleep · button double press, bed sensor skipped',
    'house_mode:guest_mode_active': () => 'Stayed in sleep mode: guest mode',
    'house_mode:kitchen_motion_detected': () => 'Left sleep mode · kitchen motion',
    'house_mode:parlour_active': () => 'Sleep mode not started: parlour in use',
    'house_mode:sitter_mode_ended_house_empty': () => 'House set to away · sitter left, nobody home',
    'house_mode:sitter_present': () => 'House set to at home · house sitter here',
    'house_mode:someone_returned': () => 'House set to at home · someone came back',
    'cameras:away_but_guest_present': () => 'Cameras left off: house away, guest staying',
    'cameras:button_double_press': () => 'Camera privacy toggled · button double press',
    'cameras:house_away': () => 'Cameras on · house away',
    'cameras:house_not_away': () => 'Cameras off · house at home',
    'cameras:sleep_kitchen_camera_on': () => 'Kitchen camera on for Mo · house asleep',
    'energy:adam': () => 'Cheap power tip sent to Adam',
    'energy:adam_and_sarah': () => 'Cheap power tip sent to Adam and Sarah',
    'energy:cheap_windows': () => 'Heads-up sent · cheap power tomorrow',
    'energy:negative_windows': () => 'Heads-up sent · free power tomorrow',
    'energy:points_increased': (f) => `Octopus points credited${fmtPoints(f.credited) ? ` (+${fmtPoints(f.credited)})` : ''}${fmtPoints(f.balance) ? ` · balance ${fmtPoints(f.balance)}` : ''}`,
    'energy:sarah': () => 'Cheap power tip sent to Sarah',
    'energy:sessions_joined': (f) => { const n = fmtCount(f.count); return n === null ? 'Joined power down sessions' : `Joined ${n} power down ${plural(n, 'session', 'sessions')}`; },
    'energy:wheels_spun': (f) => { const n = fmtCount(f.count); return n === null ? 'Spun the Octopus wheels' : `Spun ${n} Octopus ${plural(n, 'wheel', 'wheels')}`; },
    'fan:automation_disabled': () => 'Fan stayed off: bathroom automation is off',
    'fan:fan_not_auto_started': () => 'Fan left alone · turned on by hand',
    'fan:fan_off_humidity_normal': () => 'Fan off · humidity back to normal',
    'fan:fan_off_max_run': () => 'Fan off · ran its maximum time',
    'fan:fan_on_shower_started': () => 'Fan on · shower started',
    'mo:eating': (f) => `Mo eating${roomName(f.room) ? ` · ${roomName(f.room)}` : ''}`,
    'mo:spotted': (f) => `Mo spotted${roomName(f.room) ? ` · ${roomName(f.room)}` : ''}`,
    'modifier:guest_absent': () => 'Guest left · home office presence override off',
    'modifier:guest_present': () => 'Guest staying · home office presence override on',
    'shower:shower_ended': () => 'Shower ended',
    'shower:shower_max_duration': () => 'Shower ended · ran past the longest it should',
    'shower:shower_started': () => 'Shower started',
    'sonos:automation_disabled': () => 'Speaker grouping switched off · left the speaker group',
    'sonos:automation_enabled': () => 'Speaker grouping switched on · joined the speaker group',
    'thermal:close_bedroom': () => 'Told to close the bedroom windows · sun building',
    'thermal:close_both': () => 'Told to close bedroom and home office windows · sun building, outside warmer',
    'thermal:close_door': (f) => `Told to close the door · outside ${fmtDegrees(f.outdoor) || 'warmer'}${fmtDegrees(f.indoor) ? `, inside ${fmtDegrees(f.indoor)}` : ''}`,
    'thermal:close_home_office': () => 'Told to close the home office windows · outside warmer',
    'thermal:open_both': () => 'Told to open the windows · cooler outside',
    'thermal:open_door': (f) => `Told to open the door · inside ${fmtDegrees(f.indoor) || 'warm'}${fmtDegrees(f.outdoor) ? `, outside ${fmtDegrees(f.outdoor)}` : ''}`,
    'wfh_inference:always_wfh_wed_fri': () => 'Marked as working from home · Wednesday to Friday',
    'wfh_inference:home_at_inference_time': () => 'Marked as working from home · home first thing',
    'occupied:containment_failsafe_expired': () => 'Marked empty · closed-door timeout ended',
    'occupied:motion_detected': () => 'Marked occupied · motion detected',
    'occupied:strong_hold_active': (f, c) => `Stayed occupied: held by ${c.name(f.hold) || 'a hold'}`,
    'occupied:strong_hold_started': (f, c) => `Marked occupied · held by ${c.name(f.hold) || 'a hold'}`,
    'occupied:timer_expired': () => 'Marked empty · timer ran out',
  };
  // Decisions homerun stores without a declaration (decisions with actions only, from automations that
  // declare no reasons): worded from the decision verb and the reason slug, in this table so there is one
  // place for wording besides REASON_TEXT. `verb` is the sentence tail, `note` is the short phrase a room
  // tile shows for a recent action ("lights on 7 min ago"), per subsystem, and only where a tile may say it.
  const UNDECLARED = {
    decisions: {
      turn_on: { verb: 'turned on', note: { lighting: 'lights on' } },
      turn_off: { verb: 'turned off', note: { lighting: 'lights off' } },
      on: { verb: 'turned on' },
      activate_scene: { verb: 'scene set', note: { lighting: 'scene set' } },
      set_occupied: { verb: 'marked occupied', note: { occupied: 'marked occupied' } },
      clear_occupied: { verb: 'marked empty', note: { occupied: 'marked empty' } },
      notify: { verb: 'notification sent' },
      join: { verb: 'joined the speaker group' },
      unjoin: { verb: 'left the speaker group' },
      exit_sleep: { verb: 'left sleep mode' },
      clear_recent_auto_off: { verb: 'reset after switching off' },
      switch_theme: { verb: 'theme switched' },
      start_preview: { verb: 'preview started' },
      set_mode: { verb: 'mode changed', note: { heating: 'heating changed' } },
      blocked: { verb: 'blocked by its automation switch' },
      suspend: { verb: 'suspended', note: { heating: 'heating suspended' } },
      restore: { verb: 'restored', note: { heating: 'heating restored' } },
      sync_window_external: { verb: 'window state synced' },
      set_sleep: { verb: 'house set to sleep' },
    },
    reasons: {
      occupancy_on: 'room occupied', kitchen_motion_detected: 'kitchen motion', end_of_day: 'end of day',
      already_in_sleep_mode: 'already asleep', not_in_sleep_mode: 'not asleep', house_away: 'house away', house_not_away: 'someone home',
      guest_mode_active: 'guest mode', away_but_guest_present: 'away but guest present', bed_occupied: 'bed occupied',
      bed_not_occupied: 'bed empty', button_pressed: 'button pressed', button_double_press: 'button double press',
      door_open_heating_on: 'door open while heating', door_closed_was_suspended: 'door closed, heating resumed',
      open_door: 'door opened', close_door: 'door closed', outside_morning_window: 'outside the morning window',
      parlour_active: 'parlour in use', overtemp_heater_on: 'too hot',
      safety_window_open: 'window open', safety_heating_disabled: 'heating switched off', manual_override: 'manual setting',
      schedule: 'schedule', schedule_occupied: 'schedule, room occupied', house_mode_away: 'house away', house_mode_sleep: 'house asleep',
      house_mode_vacation: 'house on holiday', house_mode_normal: 'house at home', automation_disabled: 'automation off',
    },
    nouns: { lighting: 'Lights', occupied: 'Occupancy', heating: 'Heating' },
  };
  const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

  function undeclaredSentence(e) {
    const noun = own(UNDECLARED.nouns, e.subsystem) || capFirst(pretty(e.subsystem));
    const d = own(UNDECLARED.decisions, e.decision);
    const verb = d ? d.verb : pretty(e.decision);
    const why = own(UNDECLARED.reasons, e.reason) || pretty(e.reason);
    return `${noun}${verb ? ' ' + verb : ''}${why ? ' · ' + why : ''}`;
  }
  // What a failed run or action says. Devices are named by their friendly name, never "entity".
  function problemSentence(e, hass) {
    const d = e.detail;
    const who = entityName(hass, d.entity);
    if (e.kind === 'action_failed') {
      if (d.failure === 'ack_timeout') return `${who || 'A device'} didn't respond`;
      return `${who || 'A device'} couldn't be controlled${str(d.action) ? ` (${pretty(str(d.action).split('.').pop())})` : ''}`;
    }
    switch (d.abort_kind) {
      case 'unavailable_input': return `Couldn't run: ${who || 'an input'} unavailable`;
      case 'guard': return `Held back${who ? ' · ' + who : ''}${e.reason ? ' · ' + pretty(e.reason) : ''}`;
      case 'unhandled_error': return "Couldn't run: it failed unexpectedly";
      default: return `Couldn't run: ${pretty(d.abort_kind) || 'unknown problem'}`;
    }
  }
  // The one place an entry becomes words, plus how to show it: `ok` for something done, `muted` for a rule that
  // chose not to act, `warn` for a run that could not happen. A declared reason with no wording still renders
  // (never blank) and is reported by unexplainedReasons.
  function sentenceFor(e, hass) {
    if (e.kind !== 'decision') return { text: problemSentence(e, hass), tone: 'warn' };
    const tone = e.outcome === 'declined' ? 'muted' : 'ok';
    if (e.outcome === undefined) return { text: undeclaredSentence(e), tone };
    const fn = own(REASON_TEXT, `${e.subsystem}:${e.reason}`);
    const ctx = { name: (id) => entityName(hass, id) };
    return { text: fn ? fn(e.facts, ctx) : `${capFirst(pretty(e.subsystem))} ${pretty(e.reason)}`, tone };
  }

  // ── History: sensor.<location>_history (home.history.v1) ─────────────────────────────────────
  const HISTORY_SCHEMA = 'home.history.v1';
  const HISTORY_MAX = 200; // homerun's own upper bound on history.size
  const HISTORY_KINDS = ['decision', 'abort', 'action_failed'];
  const flatRecord = (v) => {
    const out = {};
    if (!isObj(v)) return out;
    for (const k of Object.keys(v)) if (v[k] === null || ['string', 'number', 'boolean'].includes(typeof v[k])) out[k] = v[k];
    return out;
  };
  // One entry, or null when it cannot be trusted: the card never renders a half-understood row.
  function historyEntry(raw) {
    if (!isObj(raw) || parseTs(raw.ts) === null || !HISTORY_KINDS.includes(raw.kind)) return null;
    if (typeof raw.subsystem !== 'string' || !raw.subsystem || typeof raw.location !== 'string') return null;
    if (raw.outcome !== undefined && raw.outcome !== 'acted' && raw.outcome !== 'declined') return null;
    return {
      ts: raw.ts, location: raw.location, automation_id: str(raw.automation_id), subsystem: raw.subsystem, kind: raw.kind,
      decision: str(raw.decision), reason: str(raw.reason), outcome: raw.outcome, facts: flatRecord(raw.facts), detail: flatRecord(raw.detail),
    };
  }
  // A sensor's attributes in, `{entries, note}` out: newest first, never throws. A payload we cannot read
  // is an empty list plus a note that says so, because "nothing happened" and "we cannot tell" differ.
  function parseHistory(attrs) {
    if (attrs === undefined || attrs === null) return { entries: [], note: '' };
    if (!isObj(attrs)) return { entries: [], note: 'History unreadable' };
    if (attrs.schema === undefined && attrs.entries === undefined) return { entries: [], note: '' };
    if (attrs.schema !== HISTORY_SCHEMA) return { entries: [], note: 'History unreadable' };
    let list = attrs.entries;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = null; } }
    if (!Array.isArray(list)) return { entries: [], note: 'History unreadable' };
    const entries = list.slice(0, HISTORY_MAX).map(historyEntry).filter(Boolean);
    entries.sort((a, b) => parseTs(b.ts) - parseTs(a.ts));
    const skipped = Math.min(list.length, HISTORY_MAX) - entries.length;
    return { entries, note: skipped > 0 ? `${skipped} ${plural(skipped, 'entry', 'entries')} could not be read` : '' };
  }
  function readHistory(hass, entity) {
    const s = stateObj(hass, entity);
    if (!s || s.state === 'unavailable') return { entries: [], note: 'History unavailable' };
    return parseHistory(s.attributes);
  }
  // A decision that changed something: declared `acted`, or an undeclared decision (stored only with actions).
  const isActed = (e) => e.kind === 'decision' && e.outcome !== 'declined';

  // sensor.homerun_catalog keeps "subsystem:reason" keys for the reasons worth explaining (acted or declined).
  // Any without wording is a gap in this card, so it is reported rather than hidden. An unreadable catalogue
  // reports nothing: an unknown is not a gap.
  const REASON_KEY = /^[a-z][a-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$/;
  function unexplainedReasons(hass) {
    const raw = attr(hass, 'sensor.homerun_catalog', 'reasons');
    if (!Array.isArray(raw)) return [];
    return raw.filter((k) => typeof k === 'string' && REASON_KEY.test(k) && !Object.prototype.hasOwnProperty.call(REASON_TEXT, k)).slice(0, 50);
  }

  // Room "Recent activity": the room's history as rows, consecutive identical rows collapsed (a mashed button).
  // Plumbing (a timer refresh, a startup sync) never reaches a history: homerun declares those reasons `ignored`
  // and stores nothing for them, so there is nothing to filter here.
  function activityOf(hass, history, withPlace) {
    const rows = [];
    for (const e of history.entries) {
      const sentence = sentenceFor(e, hass);
      const text = withPlace ? placed(e.location, sentence.text) : sentence.text;
      const last = rows[rows.length - 1];
      if (last && last.text === text && last.tone === sentence.tone) last.count += 1;
      else rows.push({ ts: e.ts, text, tone: sentence.tone, count: 1 });
    }
    return { rows, note: history.note };
  }
  // House-wide rows say where: "Kitchen · Lights off · room emptied". Whole-house automations have no room.
  function placed(location, text) {
    if (!location || location === 'house') return text;
    return `${own(ROOMS, location) ? ROOMS[location].name : capFirst(pretty(location))} · ${text}`;
  }
  function roomActivity(hass, key) {
    return activityOf(hass, readHistory(hass, `sensor.${key}_history`), false);
  }
  function houseActivity(hass) {
    return activityOf(hass, readHistory(hass, 'sensor.house_history'), true);
  }
  const DIDNT_GLYPH = 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM6.3 6.3l11.4 11.4';
  function activityRows(rows, limit) {
    return rows.slice(0, limit).map((r) => {
      const glyph = r.tone === 'muted' ? `<span class="g">${svg(DIDNT_GLYPH, 12)}</span>` : '';
      return `<div class="feed ${r.tone}"><span class="a">${esc(hhmm(r.ts))}</span><span>${glyph}${esc(r.text)}${r.count > 1 ? ` <b>x${r.count}</b>` : ''}</span></div>`;
    }).join('');
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
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    camera: 'M3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM15 10.5l6-3v9l-6-3',
    play: 'M8 5v14l11-7z',
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    hand: 'M8 13V5a1.5 1.5 0 0 1 3 0v6M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 14',
    window: 'M4 4h16v16H4zM12 4v16M4 12h16',
    pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
    leaf: 'M5 19c0-8 5-13 14-14 0 9-5 14-14 14zM5 19l8-8',
    skull: 'M12 3a7 7 0 0 0-7 7c0 2.5 1.2 4 3 5v3h8v-3c1.8-1 3-2.5 3-5a7 7 0 0 0-7-7zM9.5 11h.01M14.5 11h.01M10 18v2M14 18v2',
    tree: 'M12 3l5 7h-3l4 6H6l4-6H7l5-7zM12 16v5',
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
  // The only place lights are put into words. `badge` is the short form for tiles and chips, `phrase` the
  // headline of the Lights card, `clause` the lower-case fragment inside the banner's sentence.
  function lightsState(m, scene) {
    if (!(m.lights_on > 0)) return { on: false, badge: 'Off', phrase: 'Lights off', clause: 'lights off' };
    if (scene && scene !== 'off') return { on: true, badge: sceneLabel(scene), phrase: `${sceneLabel(scene)} scene`, clause: 'lights on' };
    return { on: true, badge: 'On', phrase: 'Lights on', clause: 'lights on' };
  }

  // The room's one-line state, built here from facts rather than taken from a string the sensor made up.
  // Holds that already say "occupied" (Bed occupied) add nothing in brackets; other holds fold into the first
  // clause, so "occupied" is said once: "Occupied (Sofa) · lights on".
  function verdictFor(m, scene) {
    const holds = m.pres_labels;
    const extra = holds.filter((l) => !/occupied/i.test(l));
    const first = m.occupancy_unavailable ? 'Occupancy unavailable' : m.occupied ? `Occupied${extra.length ? ` (${extra.join(' · ')})` : ''}` : 'Empty';
    const parts = [first, lightsState(m, scene).clause];
    if (m.target_reason && m.target !== null) parts.push(`heating target ${fmt1(m.target)}° (${m.target_reason})`);
    if (holds.length && !m.occupied) parts.push(`held occupied · ${holds.join(' · ')}`);
    if (m.heat_labels.length && !m.target_reason) parts.push(`heating suspended: ${m.heat_labels.join(' · ').toLowerCase()}`);
    if (m.override_text) parts.push(m.override_text);
    return parts.join(' · ');
  }
  function bannerFor(m, items, scene) {
    const mine = items.filter((i) => i.key === m.key);
    // A heating hold (window or door open) suspends heating whether or not the sensor saw the target
    // diverge from the mode: a safety minimum can make the target equal the mode's own.
    if ((m.target_reason === 'window open' || m.heat_labels.length) && m.cfg.climate) {
      const why = m.heat_labels.length ? m.heat_labels.join(' · ') : 'Window open';
      // The controller waits out a grace period before forcing the minimum; until then the hold is
      // true but heating is not yet suspended.
      if (m.heat_labels.length && m.target_reason !== 'window open' && m.heating_source !== 'safety') {
        return { warn: true, title: why, body: 'Heating drops to minimum if it stays open' };
      }
      const set = m.target === null ? 'held at minimum' : `set to ${fmt1(m.target)}°`;
      const ends = m.target_reason === 'window open' && m.mode_name && m.mode_target !== null ? ` and returns to ${m.mode_name} (${fmt1(m.mode_target)}°) once it closes` : ' until all clear';
      return { warn: true, title: 'Heating suspended', body: `${why} · ${set}${ends}` };
    }
    if (mine.length) {
      return { warn: true, title: mine.length === 1 ? itemLabel(mine[0], m) : `${mine.length} things need attention`, body: mine.length === 1 ? itemDetail(mine[0], m) : mine.map((i) => itemDetail(i, m)).join(' · ') };
    }
    if (m.cfg.report && !m.hasReport) return { warn: false, dim: true, title: 'No report yet', body: 'sensor.info_rooms has no entry for this room' };
    if (m.cfg.kind === 'garden') return { warn: false, title: 'Evening lighting', body: `Lights from sunset until ${m.window_off ? m.window_off + ' and bedtime' : 'bedtime'}` };
    if (!m.cfg.report) return { warn: false, title: 'Lights only', body: 'This area has scenes and a lights automation, no climate or presence report' };
    return { warn: false, title: 'All good', body: verdictFor(m, scene) };
  }

  // ── Sections ─────────────────────────────────────────────────────────────────────────────────
  function sectionNowHeader(hass) {
    const mode = state(hass, 'sensor.house_active_mode');
    const mod = state(hass, 'input_select.house_active_mode_modifier');
    const pill = usable(mode) ? `<a class="tag ok tap" data-act="nav" data-path="${SETTINGS_PATH}" aria-label="Open settings" style="padding:3px 9px;text-decoration:none">● ${esc(mode.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))}${usable(mod) && mod !== 'none' ? ' · ' + esc(mod) : ''}</a>` : '';
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
    return `<div class="chips">${person('person.adam', 'Adam', 'input_boolean.wfh_adam')}${person('person.sarah', 'Sarah', 'input_boolean.wfh_sarah')}<div class="chip" style="color:${TOKENS.text2}">Mo${ate ? ' · ' + esc(ate) : ''}</div></div>`;
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

  const STATUS_ROWS = 3;
  const attentionPath = (item) => (ROOMS[item.key] ? roomPath(item.key) : HOUSE_PATH);
  // "+N more" opens the first room not already listed above it; if every hidden item is in a listed room
  // (or has none), the first hidden item's own target is the honest answer.
  function moreAttentionPath(items) {
    const listed = new Set(items.slice(0, STATUS_ROWS).map(keyFromItem).filter(Boolean));
    const hidden = items.slice(STATUS_ROWS);
    const next = hidden.find((i) => keyFromItem(i) && !listed.has(i.key)) || hidden[0];
    return attentionPath(next);
  }

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
      const shownItems = items.slice(0, STATUS_ROWS);
      // Each row opens its own room; an item with no room (an unexplained reason) opens House.
      // The summary is room and what; the room card below carries the sentence.
      const shown = shownItems.map((i) => `<a class="tap" data-act="nav" data-path="${esc(attentionPath(i))}" style="display:block;font-size:13px;margin-top:6px;line-height:1.4"><b>${esc(i.room)}</b> · ${esc(itemLabel(i, ROOMS[i.key] ? roomModel(hass, i.key) : null))}</a>`).join('');
      const more = items.length > STATUS_ROWS ? `<a class="tap" data-act="nav" data-path="${esc(moreAttentionPath(items))}" style="display:block;font-size:12px;color:${TOKENS.text2};margin-top:4px">+${items.length - STATUS_ROWS} more</a>` : '';
      head = `<div style="display:flex;align-items:center;gap:10px"><span class="dot warn"></span><span style="font-size:15px;font-weight:700;color:${TOKENS.amber}">${items.length} ${plural(items.length, 'needs', 'need')} attention</span><div style="flex:1"></div>${side}</div>${shown}${more}`;
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
  function recentNote(hass, key, now) {
    // The newest thing the house did here; a rule that chose not to act is not an action.
    const e = readHistory(hass, `sensor.${key}_history`).entries.find((x) => isActed(x));
    if (!e) return '';
    const t = parseTs(e.ts);
    const decision = own(UNDECLARED.decisions, e.decision);
    const phrase = decision && decision.note ? own(decision.note, e.subsystem) : undefined;
    if (t === null || !phrase) return '';
    const age = now - t;
    if (age >= RECENT_MS || age < -60000) return '';
    return age < 60000 ? `${phrase} just now` : `${phrase} ${Math.floor(age / 60000)} min ago`;
  }
  const badge = (inner, style) => `<span class="badge"${style ? ` style="${style}"` : ''}>${inner}</span>`;
  const sizedIcon = (path, px, color) => `<svg class="ic" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="${color || 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
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
    if (m.target_reason && m.target !== null) lines.push(`<div class="l"><b>Heating</b><span>target ${fmt1(m.target)}° (${esc(m.target_reason)})${m.mode_name && m.mode_target !== null ? ` · normally ${esc(m.mode_name)} ${fmt1(m.mode_target)}°` : ''}</span></div>`);
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
    const lights = badge(`${sizedIcon(ICON.bulb, 13, m.lights_on > 0 ? TOKENS.sceneActive : undefined)}${esc(lightsState(m, scene).badge)}`);
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
    const line = `${sizedIcon(ICON.bulb, 14)}<span>${m.hasReport ? esc(lightsState(m, scene).badge) : 'No report'}</span>${extra}`;
    return `<a class="rt tap${wide ? ' wide' : ''}" data-act="nav" data-path="${roomPath(k)}"><div class="nm">${occIcon(m) || sizedIcon(ICON.person, 15, TOKENS.text3)}<span>${esc(m.cfg.short)}</span></div><div class="t">${tempBlock(m, `font-size:20px;font-weight:700;letter-spacing:-.3px;line-height:${TILE.tempLine}px`)}</div><div class="b">${line}</div></a>`;
  }

  function sectionRooms(hass, now) {
    const g = roomGroups(hass);
    const items = attentionItems(hass);
    const out = [];
    if (g.attention.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">Needs attention</div>${g.attention.map((k) => attentionCard(hass, k, items)).join('')}`);
    if (g.occupied.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">Occupied now</div>${g.occupied.map((k) => occupiedCard(hass, k, now)).join('')}`);
    if (g.other.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">${g.occupied.length || g.attention.length ? 'Other rooms' : 'Rooms'}</div><div class="rgrid">${g.other.map((k, i) => roomTile(hass, k, now, g.other.length % 2 === 1 && i === g.other.length - 1)).join('')}</div>`);
    const flagged = new Set(items.map((i) => i.key));
    out.push(`<div class="lbl" style="margin:4px 4px -10px">Outside</div><div class="rgrid">${GARDEN_ORDER.map((k) => gardenTile(hass, k, now, flagged.has(k))).join('')}</div>`);
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
    if (slots.length === 0) return `<div style="font-size:12px;color:${TOKENS.text2};margin-top:12px">No price data for today</div>`;
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

  // The heading of a tab page (Energy, Settings, Cameras). Those pages are normal views, so HA's header shows
  // the tab strip (or Material You's bottom bar), not the view title, and there is nowhere to go "back" to: the
  // card draws the title and no back link.
  function pageTitle(name) {
    return `<div style="min-height:44px;display:flex;align-items:center;font-size:28px;font-weight:700;letter-spacing:-.4px">${esc(name)}</div>`;
  }

  function sectionEnergyHead(hass, at) {
    return `${pageTitle('Energy')}
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
      return `${control}<div class="card pad"><div style="font-size:14px;font-weight:600">${late ? 'Tomorrow\'s rates are not in yet' : 'No price data for today'}</div><div style="font-size:12.5px;color:${TOKENS.text2};margin-top:4px;line-height:1.4">${late ? 'Tomorrow\'s rates are published late afternoon' : 'The rates list is empty or unavailable'}</div></div>${windowsCard(hass, [], at)}`;
    }
    const st = energyStats(slots);
    const stat = (k, v, sub, col) => `<div class="card stat"><div class="k">${k}</div><div class="v" style="${col ? 'color:' + col : ''}">${v}</div><div class="s">${sub}</div></div>`;
    const stats = `<div style="display:flex;gap:8px">${stat('Cheapest', penceText(st.cheapest.v), 'at ' + st.cheapest.time, priceColour(st.cheapest.v, { text: true }))}${stat('Dearest', penceText(st.dearest.v), 'at ' + st.dearest.time, priceColour(st.dearest.v, { text: true }))}${stat('Average', penceText(st.avg), 'per kWh', priceColour(st.avg, { text: true }))}</div>`;
    return `${control}<div class="card pad">${priceChart(rates, at, day)}<div style="font-size:11.5px;color:${TOKENS.text3};margin-top:8px">Drag across the chart to read any half hour</div></div>${stats}${windowsCard(hass, slots, at)}`;
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
<div style="font-size:11.5px;color:${TOKENS.text3};margin:-6px 4px 0">Octopus publishes about 1-2 days late, so these cover an earlier day, not today</div>`;
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
    else if (h.status !== 'ok' || days.length === 0) body = `<div style="font-size:14px;font-weight:600">History unavailable</div><div style="font-size:12.5px;color:${TOKENS.text2};margin-top:4px;line-height:1.4">The recorded cost history could not be read; the latest published day is shown above</div>`;
    else {
      const id = COST_STAT[fuel];
      const total = usable(state(hass, id)) ? num(state(hass, id)) : null;
      const summary = dailySummary(days, standingNote(total, isObj(stateObj(hass, id)) ? stateObj(hass, id).attributes : {}));
      body = `${costChart(days)}<div style="font-size:12.5px;margin-top:8px">${esc(summary)}</div><div style="font-size:11.5px;color:${TOKENS.text3};margin-top:4px">Drag across the bars to read a day · Published about 1-2 days late</div>`;
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
<div style="font-size:11.5px;color:${TOKENS.text3};margin:-6px 4px 0">Live from the meter; the Octopus figures above are the supplier's, days late, and the two are not reconciled</div>`;
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
    return `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px"><div class="card" style="padding:12px 14px${soon ? ';background:' + TOKENS.amberTag : ''}"><div class="lbl">Bins</div><div style="font-size:15px;font-weight:600;margin-top:4px${soon ? ';color:' + TOKENS.amber : ''}">${esc(binTitle)}</div><div style="font-size:12px;color:${soon ? TOKENS.amber : TOKENS.text2}">${esc(binSub)}</div></div><a class="card tap" data-act="nav" data-path="${SETTINGS_PATH}" aria-label="Open settings" style="padding:12px 14px;display:block"><div class="lbl">Heating</div><div style="font-size:15px;font-weight:600;margin-top:4px">${esc(hTitle)}</div><div style="font-size:12px;color:${TOKENS.text2}">${esc(hSub)}</div></a></div>`;
  }

  function sectionFeed(hass, now) {
    const { rows, note } = houseActivity(hass);
    const quiet = (msg) => `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">${esc(msg)}</span></div>`;
    const body = (rows.length ? activityRows(rows, FEED_ROWS) : quiet('Nothing recorded yet')) + (note ? quiet(note) : '');
    return `<div class="lbl" style="margin:4px 4px -10px">What the house did</div><div class="card">${body}</div>`;
  }

  // ── Top guard ────────────────────────────────────────────────────────────────────────────────
  // Room, garden and tab pages are normal views, so HA's header is not meant to show. Material You hides the app
  // bar by setting ha-menu-button to opacity 0 (--ha-menu-button-opacity) but also gives it pointer-events: all, so
  // on a narrow screen the invisible hamburger sits over the top-left of the page and takes the tap meant for
  // our back link. The card measures any header control that would take a tap and a tap target of its own that
  // it overlaps, and the heading cards put an empty row above their content that tall (ui.top). Nothing is
  // hard-coded: the size comes from the browser. It only ever grows, because a scrolled page moves the targets
  // up and would read as "no overlap".
  const TOP_GUARD_MAX = 200; // a header is 56px plus the top safe area; this only stops a bad measurement running away
  const HEAD_MODES = ['now-header', 'energy-head', 'house-head', 'cameras-head', 'room-head'];
  const rectOk = (r) => isObj(r) && ['left', 'top', 'right', 'bottom'].every((k) => Number.isFinite(r[k])) && r.right > r.left && r.bottom > r.top;
  // A header control takes taps unless it, or an ancestor it inherits from, switched them off or removed it.
  function takesTaps(cs) {
    return isObj(cs) && cs.pointerEvents !== 'none' && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }
  // Pixels to move the targets down so none sits under a blocker. `shift` is the guard already in place, so the
  // answer is about the content's natural position and does not flip-flop as the guard appears.
  function coverNeed(blockers, targets, shift) {
    const dy = Number.isFinite(shift) ? Math.max(0, shift) : 0;
    let need = 0;
    for (const b of Array.isArray(blockers) ? blockers : []) {
      if (!rectOk(b)) continue;
      for (const t of Array.isArray(targets) ? targets : []) {
        if (!rectOk(t)) continue;
        const top = t.top - dy;
        const bottom = t.bottom - dy;
        if (t.left < b.right && t.right > b.left && top < b.bottom && bottom > b.top) need = Math.max(need, Math.ceil(b.bottom - top));
      }
    }
    return Math.max(0, Math.min(TOP_GUARD_MAX, need));
  }
  function topGuard(ui) {
    const h = ui && Number.isFinite(ui.top) ? Math.max(0, Math.min(TOP_GUARD_MAX, ui.top)) : 0;
    // The page's own 14px gap follows the row, so take it back.
    return h > 0 ? `<div data-top-guard style="height:${h}px;margin-bottom:-14px" aria-hidden="true"></div>` : '';
  }

  // The settings sheet is position:fixed, but an ancestor with a transform, filter or contain makes it relative to
  // that ancestor instead. Given the overlay's real rect and the viewport height, say how far to lift the sheet
  // off the bottom and how tall it may be so it lies inside the visible viewport either way. Null when the
  // overlay already covers the viewport (the CSS dvh rules are then right).
  function sheetFit(viewportH, rect) {
    if (!Number.isFinite(viewportH) || viewportH <= 0 || !rectOk(rect)) return null;
    if (Math.abs(rect.top) < 1 && Math.abs(rect.bottom - viewportH) < 1) return null;
    const inset = Math.max(0, Math.min(viewportH, Math.round(rect.bottom - viewportH)));
    const top = Math.max(0, rect.top);
    const room = Math.max(0, viewportH - inset - top);
    return { inset, max: Math.max(120, Math.floor(room * 0.88)) };
  }

  // ── Settings sheet portal ──────────────────────────────────────────────────────────────────────
  // The sheet is rendered as the last thing in the room-head html, starting at this marker. The card moves it out
  // of its own shadow root into a host on document.body, so position:fixed is relative to the viewport whatever
  // transform/filter/contain HA's view containers carry. Returns the page html and the sheet html (empty when closed).
  const SHEET_MARK = '<div class="ovl">';
  function splitSheet(html) {
    const s = typeof html === 'string' ? html : '';
    const at = s.indexOf(SHEET_MARK);
    return at < 0 ? { page: s, sheet: '' } : { page: s.slice(0, at), sheet: s.slice(at) };
  }

  // iOS WebKit hands a touch scroll to the page when the inner scroller cannot move, and rubber-bands even with
  // overscroll-behavior. So every touchmove on the open sheet is cancelled unless it is inside the sheet body and the
  // body can still scroll the way the finger is going. deltaY is the finger's movement since the last event: positive
  // is a swipe down, which scrolls the content toward its top. Anything unmeasurable is cancelled (fail safe).
  function touchGuard(scrollTop, scrollHeight, clientHeight, deltaY, insideBody) {
    if (!insideBody) return 'prevent';
    if (![scrollTop, scrollHeight, clientHeight, deltaY].every(Number.isFinite)) return 'prevent';
    const max = scrollHeight - clientHeight;
    if (max < 1) return 'prevent'; // nothing to scroll: any move would chain to the page
    if (deltaY === 0) return 'allow';
    // 1px of slack: fractional scroll positions on high-density screens never quite reach the bounds.
    return deltaY > 0 ? (scrollTop > 1 ? 'allow' : 'prevent') : scrollTop < max - 1 ? 'allow' : 'prevent';
  }

  // Lock the page's scrollers while the sheet is open and put each back exactly. Targets are elements (or anything
  // with style and scrollTop). overflow:hidden alone does not stop iOS (hence touchGuard) but does stop wheel,
  // keyboard and other scroll paths, and the saved scrollTop makes the close land where the page was.
  function lockScroll(targets) {
    const saved = [];
    for (const el of Array.isArray(targets) ? targets : []) {
      if (!el || typeof el !== 'object' || !el.style) continue;
      saved.push({ el, overflow: el.style.overflow, top: Number.isFinite(el.scrollTop) ? el.scrollTop : 0 });
      el.style.overflow = 'hidden';
    }
    let done = false;
    return function unlock() {
      if (done) return;
      done = true;
      for (const s of saved) {
        s.el.style.overflow = s.overflow;
        if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top;
      }
    };
  }

  // HA's page scroller differs by version and by theme (Material You restyles the header), so find it rather than
  // assume it: the document scroller plus every ancestor of the card, through shadow roots, that really scrolls.
  function scrollTargets(from, doc) {
    const out = [];
    const add = (el) => { if (el && !out.includes(el)) out.push(el); };
    let node = from;
    while (node) {
      if (node.nodeType === 1 && typeof getComputedStyle === 'function') {
        const oy = getComputedStyle(node).overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight) add(node);
      }
      node = node.assignedSlot || node.parentNode || node.host || null;
    }
    if (doc) { add(doc.scrollingElement); add(doc.documentElement); add(doc.body); }
    return out;
  }

  // ── Bottom tab bar ─────────────────────────────────────────────────────────────────────────────
  // position:fixed only works if no ancestor creates a containing block for fixed descendants (transform,
  // filter, perspective, contain, will-change, backdrop-filter). tabbarPlacement decides from computed-style
  // snapshots of the ancestors: 'fixed' when none does, otherwise 'inflow' (a normal bar at the end of the
  // page, still usable, never overlapping) and names the offender. The card probes after its first paint and
  // defaults to 'inflow' until the probe says otherwise (fail safe).
  const TABS = [
    { id: 'house', label: 'House', path: HOUSE_PATH, icon: 'home' },
    { id: 'energy', label: 'Energy', path: ENERGY_PATH, icon: 'bolt' },
    { id: 'cameras', label: 'Cameras', path: CAMERAS_PATH, icon: 'camera' },
    { id: 'settings', label: 'Settings', path: SETTINGS_PATH, icon: 'gear' },
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
    const active = cfg && TABS.some((t) => t.id === cfg.active) ? cfg.active : 'house';
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

  // Pulse's own header row (back to House, the room name, the settings gear) then the banner. Room and garden
  // pages are normal views, so HA draws no header of its own and this row is the only one, styled like the
  // Energy/Cameras/Settings headings. Each subsystem (lights, heating, presence) has its own section further
  // down and explains itself next to its controls. The sheet is part of this card (ui.settings), so it works
  // the same on indoor rooms and gardens.
  function sectionRoomHead(hass, key, ui) {
    const m = roomModel(hass, key);
    const b = bannerFor(m, attentionItems(hass), activeScene(hass, key));
    const back = `<a class="round quiet tap" data-act="nav" data-path="${HOUSE_PATH}" aria-label="Back to House" style="text-decoration:none;margin-left:-8px">${svg(ICON.back, 22)}</a>`;
    const title = `<div style="flex:1;min-width:0;min-height:44px;display:flex;align-items:center;font-size:28px;font-weight:700;letter-spacing:-.4px">${esc(m.cfg.name)}</div>`;
    const gear = `<button class="round quiet tap" data-act="settings-open" data-room="${key}" aria-haspopup="dialog" aria-label="${esc(m.cfg.name)} settings" style="margin-right:-8px">${svg(ICON.gear, 22)}</button>`;
    const head = `<div style="display:flex;align-items:center;gap:8px">${back}${title}${gear}</div>`;
    const banner = `<div class="card pad${b.warn ? ' warn' : ''}" style="display:flex;gap:10px;align-items:flex-start"><span class="dot${b.warn ? ' warn' : b.dim ? ' dim' : ''}" style="margin-top:5px"></span><div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700;${b.warn ? 'color:' + TOKENS.amber : ''}">${esc(b.title)}</div><div style="font-size:13px;color:${b.warn ? TOKENS.text : TOKENS.text2};margin-top:3px;line-height:1.45">${esc(b.body)}</div></div></div>`;
    return `${head}${banner}${ui && ui.settings ? settingsSheet(hass, key) : ''}`;
  }

  // The lights row of the Lights card: why the lights are as they are, including why they are NOT on. One
  // function, first matching rule wins (the order is the point: a switched-off automation outranks any
  // history, and a hand change outranks an older automated action):
  //   1 automation off · 2 manual change newer than the last automated action · 3 lights off and room empty
  //   4 newest lighting entry is a decline, abort or failure and newer than the last act · 5 the last act.
  // Presence holds keep a room occupied, so no "room emptied" event fires and the lights stay as they are until
  // the last hold clears; a manual change persists the same way, because the controller only acts on triggers.
  // Indoor rooms only: gardens keep their own model (gardenModel), whose sub-line explains each state.
  // Returns {state, why, tone, holds}: tone is ok | muted | warn.
  function lightsStory(hass, key, now) {
    const m = roomModel(hass, key);
    const holds = m.pres_labels.join(' · ');
    const at = (ts) => (ts ? ' at ' + hhmm(ts) : '');
    const out = (state, why, tone) => ({ state, why, tone, holds });
    if (!m.lights_enabled) return out('disabled', 'Lights automation is off · they change only by hand', 'muted');
    const h = readHistory(hass, `sensor.${key}_history`);
    const lighting = h.entries.filter((e) => e.subsystem === 'lighting');
    const lastActed = lighting.find(isActed);
    if (m.manual) {
      const manualAt = parseTs(m.manual.ts);
      const actedAt = lastActed ? parseTs(lastActed.ts) : null;
      if (manualAt === null || actedAt === null || manualAt > actedAt) {
        const how = capFirst(SOURCE_WORDS[m.manual.source] || m.manual.source);
        const what = m.manual.source !== 'wall_button' && m.manual.what ? `: ${m.manual.what}` : '';
        return out('manual', `${how}${at(m.manual.ts)}${what} · stays until the room is empty`, 'ok');
      }
    }
    const occ = stateObj(hass, `binary_sensor.${key}_occupied`);
    const sensorGone = m.occupancy_unavailable || state(hass, `binary_sensor.${key}_occupied`) === 'unavailable';
    if (m.lights_on === 0 && (sensorGone || !m.occupied)) {
      if (sensorGone) return out('empty', 'Occupancy sensor unavailable', 'warn');
      const since = parseTs(occ && occ.last_changed);
      // Clamped to now so a skewed clock never shows a time in the future.
      const when = since === null ? '' : ` since ${hhmm(new Date(Number.isFinite(now) ? Math.min(since, now) : since).toISOString())}`;
      const motionOff = state(hass, `input_boolean.${key}_sensor_motion_enabled`) === 'off' ? ' · motion sensor is off' : '';
      return out('empty', `No one detected${when}${motionOff}`, 'ok');
    }
    // What would change the lights next, said only while they are on.
    const tail = m.lights_on > 0 ? (holds ? ` · stays on while ${holds}` : ' · off when the room empties') : '';
    const newest = lighting[0];
    const newer = newest && (!lastActed || parseTs(newest.ts) > parseTs(lastActed.ts));
    if (newer && !isActed(newest)) {
      const { text, tone } = sentenceFor(newest, hass);
      return out(tone === 'warn' ? 'problem' : 'declined', `${text}${at(newest.ts)}${tail}`, tone);
    }
    if (lastActed) return out('acted', `${sentenceFor(lastActed, hass).text}${at(lastActed.ts)}${tail}`, 'ok');
    return out('none', `${h.note ? `Lighting ${h.note.toLowerCase()}` : 'No lighting decision recorded yet'}${tail}`, h.note ? 'warn' : 'muted');
  }

  function lightsTag(story) {
    switch (story.state) {
      case 'disabled': return '<span class="tag">Automation off</span>';
      case 'manual': return '<span class="tag">Manual</span>';
      case 'problem': return '<span class="tag">Problem</span>';
      case 'declined': return "<span class=\"tag off\">Didn't act</span>";
      default: return story.holds ? '<span class="tag off">Hold</span>' : '<span class="tag ok">Auto</span>';
    }
  }

  // Heating: the room and target numbers, then why the target is what it is. The 24 h chart is its own card
  // directly under this one (info_templates.yaml), so the whole subsystem reads as one block.
  function heatingNumbers(m) {
    const differs = !!m.target_reason;
    const sub2 = differs ? (m.mode_name && m.mode_target !== null ? `Mode ${m.mode_name} ${fmt1(m.mode_target)}°` : m.target_reason.replace(/^./, (c) => c.toUpperCase())) : [m.heating_active.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), m.heating_source ? 'from ' + m.heating_source.replace(/_/g, ' ') : ''].filter(Boolean).join(' ');
    const hs = heatingStatus(m);
    const status = hs ? `<div style="display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;margin-top:2px;color:${hs.on ? TOKENS.heat : TOKENS.text2}">${hs.on ? svg(ICON.flame, 14) : ''}${hs.text}</div>` : '';
    return `<div class="two"><div class="card pad"><div class="lbl">Room</div><div class="big">${m.temp === null ? '–' : fmt1(m.temp) + '°'}</div><div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${m.humidity === null ? 'no humidity' : Math.round(m.humidity) + '% humidity'}</div></div>
<div class="card pad"><div class="lbl">Target</div><div class="big" style="${differs ? 'color:' + TOKENS.amber : ''}">${m.target === null ? '–' : fmt1(m.target) + '°'}</div>${status}<div style="font-size:12px;color:${TOKENS.text2};margin-top:2px">${esc(sub2)}</div></div></div>`;
  }
  function heatingWhy(m) {
    const differs = !!m.target_reason;
    const h = m.target !== null ? `Heating target ${fmt1(m.target)}°` : 'Heating';
    const s = differs ? `${esc(m.target_reason.replace(/^./, (c) => c.toUpperCase()))}${m.mode_name && m.mode_target !== null ? ` · normally ${esc(m.mode_name)} ${fmt1(m.mode_target)}°` : ''}` : [m.mode_name && m.mode_target !== null ? `${esc(m.mode_name.replace(/^./, (c) => c.toUpperCase()))} ${fmt1(m.mode_target)}°` : '', m.heating_source ? esc(m.heating_source.replace(/_/g, ' ')) : ''].filter(Boolean).join(' from ') || 'No mode reported';
    const safety = !differs && m.heating_source === 'safety';
    const held = !differs && m.heat_labels.length > 0;
    const minT = m.mode_target !== null ? m.mode_target : m.target;
    const cause = safetyCause(m);
    const resumes = m.house_heating_off ? 'stays at minimum while house heating is off' : m.heat_labels.length ? 'normal heating resumes when it closes' : '';
    const sub = safety ? `Held at ${esc(m.mode_name || 'minimum')}${minT !== null ? ' ' + fmt1(minT) + '°' : ''}${cause ? ' · ' + esc(cause) : ''}${resumes ? ' · ' + resumes : ''}` : held ? `${esc(m.heat_labels.join(' · '))} · ${s}` : s;
    const tag = differs ? `<span class="tag">${esc(m.target_reason.replace(/^./, (c) => c.toUpperCase()))}</span>` : safety ? '<span class="tag">Suspended</span>' : held ? '<span class="tag">Pending</span>' : m.heating_enabled === false ? '<span class="tag">Automation off</span>' : m.hvac_action === 'heating' ? '<span class="tag heat">Heating</span>' : m.hvac_action === 'idle' ? '<span class="tag off">Idle</span>' : '';
    return `<div class="item">${svg(ICON.flame, 18)}<div><div class="h">${esc(h)}</div><div class="s">${sub}</div></div>${tag}</div>`;
  }
  function sectionHeating(hass, key) {
    const m = roomModel(hass, key);
    if (!m.hasReport || !m.cfg.climate) return '';
    return `<div class="lbl" style="margin:4px 4px -10px">Heating</div>${heatingNumbers(m)}<div class="card">${heatingWhy(m)}</div>`;
  }

  // Presence: occupied or empty, what holds the room occupied and what ends it, and "Keep room occupied" (acts now,
  // so it lives here and not in settings). When the motion sensor is switched off the row says so and links to
  // the settings sheet, where the switch is.
  function keepOccupiedRow(hass, key) {
    const id = `input_boolean.${key}_automation_presence_override`;
    const s = state(hass, id);
    if (!usable(s)) return '';
    const on = s === 'on';
    const guest = key === 'home_office' && state(hass, 'input_select.house_active_mode_modifier') === 'guest';
    const sub = on ? (guest ? 'Set by guest mode · lights and heating treat the room as in use' : 'Room held occupied · lights and heating treat it as in use') : 'Holds the room occupied until switched off';
    return `<button class="tog tap" data-act="toggle" data-entity="${id}" aria-pressed="${on}"><div><div class="h">Keep room occupied</div><div class="s">${sub}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`;
  }
  function sectionPresence(hass, key) {
    const m = roomModel(hass, key);
    const keep = keepOccupiedRow(hass, key);
    if (!m.hasReport && !keep) return '';
    let row = '';
    if (m.hasReport) {
      const holds = m.pres_labels;
      const occ = m.occupancy_unavailable ? 'Occupancy unavailable' : m.occupied ? 'Occupied' : 'Empty';
      const pres = holds.length ? `${esc(holds.join(' · '))} · empty a few minutes after ${holds.length > 1 ? 'the last one clears' : 'it clears'}` : m.occupied ? 'No holds · empty a few minutes after the last movement' : 'No holds';
      const ovr = m.override_text ? ` · ${esc(m.override_text)}` : '';
      const motionOff = state(hass, `input_boolean.${key}_sensor_motion_enabled`) === 'off';
      const noMotion = motionOff ? ' · Motion sensor off, so movement is ignored' : '';
      const link = motionOff ? `<button class="lnk tap" data-act="settings-open" data-room="${key}" aria-haspopup="dialog">Settings</button>` : '';
      row = `<div class="item">${svg(ICON.person, 18)}<div><div class="h">${occ}</div><div class="s">${pres}${ovr}${noMotion}</div>${link}</div><span class="tag${m.override && !holds.length ? '' : ' off'}">${holds.length ? 'Held' : m.override ? 'Override' : 'Clear'}</span></div>`;
    }
    return `<div class="lbl" style="margin:4px 4px -10px">Presence</div><div class="card">${row}${keep}</div>`;
  }

  // Lights: what they are doing and why (including why they are not on), the scene tiles, and the individual
  // lights expanding under a hairline, all in one card. The headline wording is lightsState, as everywhere.
  function lightsStoryRow(hass, key, now, m, scene) {
    const story = lightsStory(hass, key, now);
    const tint = story.tone === 'warn' ? ` style="color:${TOKENS.amber}"` : '';
    return `<div class="item">${svg(ICON.bulb, 18)}<div><div class="h">${esc(lightsState(m, scene).phrase)}</div><div class="s"${tint}>${esc(story.why)}</div></div>${lightsTag(story)}</div>`;
  }
  function sectionLights(hass, key, now, ui) {
    const m = roomModel(hass, key);
    const active = activeScene(hass, key);
    const cols = Math.min(4, Math.max(1, m.cfg.scenes.length));
    const tiles = m.cfg.scenes.map((id) => {
      const on = id === active;
      const ic = ICON[SCENE_ICON[id] || 'bulb'];
      return `<button class="tile${on ? ' on' : ''}" data-act="scene" data-entity="scene.${key}_${id}" aria-pressed="${on}">${svg(ic, 20)}<span>${esc(sceneLabel(id))}</span></button>`;
    }).join('');
    const story = m.hasReport ? lightsStoryRow(hass, key, now, m, active) : '';
    const exp = lightsExpander(hass, key, ui);
    const more = exp ? `<div style="margin:10px -12px -10px;border-top:1px solid ${TOKENS.divider}">${exp}</div>` : '';
    const controls = `<div style="padding:12px 12px 10px${story ? `;border-top:1px solid ${TOKENS.divider}` : ''}"><div class="tiles" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${tiles}</div>${more}</div>`;
    return `<div class="lbl" style="margin:4px 4px -10px">Lights</div><div class="card">${story}${controls}</div>`;
  }

  function lightCounts(hass, key) {
    const m = roomModel(hass, key);
    if (m.lights_total > 0) return { on: m.lights_on, total: m.lights_total };
    const list = m.cfg.lights;
    return { on: list.filter(([id]) => state(hass, id) === 'on').length, total: list.length };
  }

  // Collapsible list kept inside the Lighting card (no expander-card): one header row with a single
  // chevron, collapsed by default. The open flag lives in the element instance (ui.open), so hass
  // updates do not reset it.
  function lightsExpander(hass, key, ui) {
    const m = roomModel(hass, key);
    if (m.cfg.lights.length === 0) return '';
    const open = !!(ui && ui.open);
    const c = lightCounts(hass, key);
    const head = `<button class="lh tap" data-act="lights-toggle" aria-expanded="${open}"><span style="font-size:14px;font-weight:600">Individual lights<span style="font-weight:500;color:${TOKENS.text2}"> · ${c.on} of ${c.total} on</span></span><span style="display:flex;color:${TOKENS.text2};transform:${open ? 'rotate(180deg)' : 'none'}">${svg(ICON.chev, 18)}</span></button>`;
    if (!open) return head;
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
    return `${head}${rows}`;
  }

  // A single switchable device with the reason homerun last gave for its state (the fan row on the
  // bathroom page). `entity` is the switch, `decision` the decision sensor whose `reason` attribute
  // says why. Each reason is only shown while it still agrees with the switch: the decision sensor
  // keeps its last value, so "Shower started" must not outlive a fan that has since been switched off.
  const DEVICE_REASONS = {
    fan_on_shower_started: ['Shower started', 'on'],
    fan_off_humidity_normal: ['Humidity back to normal', 'off'],
    fan_off_max_run: ['Ran its maximum time', 'off'],
    fan_run_extended: ['Another shower started', 'on'],
    fan_holding_min_run: ['Minimum run', 'on'],
    fan_holding_humidity_high: ['Clearing steam', 'on'],
    fan_not_auto_started: ['Turned on by hand', 'on'],
    automation_disabled: ['Automation off', 'any'],
  };
  function deviceReason(reason, isOn) {
    const r = str(reason);
    const hit = DEVICE_REASONS[r];
    if (!hit) return '';
    return hit[1] === 'any' || hit[1] === (isOn ? 'on' : 'off') ? hit[0] : '';
  }

  // ── Room settings ────────────────────────────────────────────────────────────────────────────
  // The settings panel (a sheet opened from the gear in the room banner) holds what means "this room should
  // behave differently from now on": automation switches and their tuning, by subsystem. What a person changes
  // because of something happening right now (scenes, lights, the fan on/off, keep-room-occupied) stays on the page.
  //
  // Rows are either a toggle or a stepper with a fixed min/max/step. A write names a room, group and key from
  // this table, never an entity id, so turn_on/turn_off/set_value can only reach the helpers listed here. A row
  // whose helper is missing or unusable is left out when rendering, and a group left empty is not shown.
  //
  // Stepper ranges equal the clamp in the automation that reads the helper (a test holds the numbers to a list of
  // expected clamps, so a change on one side has to be made on both). Where the automation does not clamp, the
  // range is the helper's own min/max/step in packages/helpers.yaml. Sources:
  //   fan: homerun-automations lib/bathroom/steam.ts (MIN/MAX_FAN_MIN_RUN_MIN, MIN/MAX_FAN_MAX_RUN_MIN, MIN/MAX_FAN_MARGIN)
  //   lux threshold, foreign office door ventilation: no clamp in the automation, so the helper's range.
  // Not exposed on purpose: calibration that silently breaks a rule when wrong, such as the bathroom shower
  // detection thresholds (shower_rise, above_baseline, end_drop, end_confirm). Those stay in HA settings.
  const toggleRow = (key, id, title, sub) => ({ kind: 'toggle', key, id, title, sub });
  const stepRow = (key, id, title, sub, min, max, step, unit) => ({ kind: 'number', key, id, title, sub, min, max, step, unit });
  const luxRow = (k) => stepRow('lux_dark', `input_number.${k}_automation_lux_threshold_dark`, 'Dark below', 'Lux reading under which the room counts as dark', 0, 500, 1, ' lx');
  const lightsGroup = (k, extra) => ({ key: 'lights', title: 'Lights', rows: [toggleRow('automation', `input_boolean.${k}_automation_lights_enabled`, 'Lights automation', 'Decides lights from presence and time of day'), luxRow(k), ...extra] });
  const presenceGroup = (k) => ({ key: 'presence', title: 'Presence', rows: [toggleRow('motion', `input_boolean.${k}_sensor_motion_enabled`, 'Motion sensor', 'Off means movement is ignored and the room relies on holds')] });
  const heatingGroup = (k, extra) => ({ key: 'heating', title: 'Heating', rows: [toggleRow('automation', `input_boolean.${k}_automation_heating_enabled`, 'Heating automation', 'Sets the target from mode, windows and schedule'), ...extra] });
  const sonosGroup = (k) => ({ key: 'media', title: 'Media', rows: [toggleRow('sonos', `input_boolean.${k}_automation_sonos_enabled`, 'Follow the speaker group', 'Joins the parlour speaker group when the room is occupied')] });
  const indoor = (k, ...more) => [lightsGroup(k, []), heatingGroup(k, []), presenceGroup(k), ...more];
  const DOOR = 'input_number.foreign_office_automation_door';
  const ROOM_SETTINGS = {
    parlour: indoor('parlour'),
    kitchen: indoor('kitchen', sonosGroup('kitchen')),
    hallway_downstairs: indoor('hallway_downstairs'),
    hallway_upstairs: indoor('hallway_upstairs'),
    bedroom: indoor('bedroom'),
    bathroom: [
      lightsGroup('bathroom', []), heatingGroup('bathroom', []), presenceGroup('bathroom'),
      {
        key: 'fan', title: 'Fan', rows: [
          toggleRow('automation', 'input_boolean.bathroom_automation_fan_enabled', 'Fan automation', 'Runs the extractor fan after a shower until the steam clears'),
          stepRow('min_run', 'input_number.bathroom_automation_fan_min_run', 'Minimum run', 'After the last shower ends', 5, 30, 5, ' min'),
          stepRow('max_run', 'input_number.bathroom_automation_fan_max_run', 'Maximum run', 'Off by then, whatever the humidity', 15, 120, 15, ' min'),
          stepRow('margin', 'input_number.bathroom_automation_fan_humidity_margin', 'Stops within', 'Humidity points above the room\'s normal level', 2, 30, 1, '%'),
        ],
      },
    ],
    home_office: indoor('home_office', sonosGroup('home_office')),
    foreign_office: [
      lightsGroup('foreign_office', []),
      heatingGroup('foreign_office', [
        stepRow('door_delta', `${DOOR}_open_delta`, 'Door open delta', 'Suggest opening the door when outside is this much cooler than the room', 0.5, 10, 0.5, '°'),
        stepRow('door_min_outdoor', `${DOOR}_open_min_outdoor`, 'Door open minimum outdoors', 'No suggestion when outside is colder than this', 0, 20, 0.5, '°'),
        stepRow('door_comfort', `${DOOR}_indoor_comfort_threshold`, 'Door indoor comfort', 'No suggestion until the room is at least this warm', 18, 28, 0.5, '°'),
        stepRow('door_cooldown', `${DOOR}_notification_cooldown_mins`, 'Door alert cooldown', 'Minimum time between door alerts', 15, 240, 15, ' min'),
      ]),
      presenceGroup('foreign_office'),
    ],
    front_garden: [{
      key: 'lights', title: 'Lights', rows: [
        toggleRow('automation', 'input_boolean.front_garden_automation_lights_enabled', 'Lights automation', 'On from sunset; off when the house goes to sleep'),
        toggleRow('calendar', 'input_boolean.front_garden_light_theme_calendar_enabled', 'Follow calendar', 'Switches theme on the days it changes'),
      ],
    }],
    back_garden: [{
      key: 'lights', title: 'Lights', rows: [toggleRow('automation', 'input_boolean.back_garden_automation_lights_enabled', 'Lights automation', 'On from sunset; off when the house goes to sleep')],
    }],
  };

  // Fails at load, not at the first tap: every room has a table, each row's helper is in the domain its kind
  // writes to, keys are unique within a group, and every stepper has a sane range.
  function checkRoomSettings() {
    for (const k of Object.keys(ROOMS)) if (!Array.isArray(ROOM_SETTINGS[k])) throw new Error(`pulse-card: no settings table for ${k}`);
    for (const [room, groups] of Object.entries(ROOM_SETTINGS)) {
      if (!Object.prototype.hasOwnProperty.call(ROOMS, room)) throw new Error(`pulse-card: settings for unknown room ${room}`);
      const gkeys = new Set();
      for (const g of groups) {
        if (gkeys.has(g.key)) throw new Error(`pulse-card: duplicate settings group ${room}/${g.key}`);
        gkeys.add(g.key);
        const rkeys = new Set();
        for (const r of g.rows) {
          if (rkeys.has(r.key)) throw new Error(`pulse-card: duplicate setting ${room}/${g.key}/${r.key}`);
          rkeys.add(r.key);
          const domain = r.kind === 'toggle' ? 'input_boolean' : 'input_number';
          if (!new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(r.id)) throw new Error(`pulse-card: setting ${room}/${g.key}/${r.key} must be an ${domain}, got "${r.id}"`);
          if (r.kind === 'number' && !(r.min < r.max && r.step > 0 && r.step <= r.max - r.min)) throw new Error(`pulse-card: setting ${room}/${g.key}/${r.key} has a bad range`);
        }
      }
    }
  }
  checkRoomSettings();

  // The one lookup for a write. Unknown room, group or key (and prototype keys such as __proto__) throw.
  function settingFor(room, group, key) {
    const groups = Object.prototype.hasOwnProperty.call(ROOM_SETTINGS, room) ? ROOM_SETTINGS[room] : null;
    const g = groups ? groups.find((x) => x.key === group) : undefined;
    const row = g ? g.rows.find((x) => x.key === key) : undefined;
    if (!row) throw new Error(`pulse-card: unknown setting "${room}/${group}/${key}"`);
    return row;
  }

  // Visible rows of one group, as {row, html}; rows whose helper cannot be read are dropped.
  function settingRowHtml(hass, room, group, row) {
    const ds = { room, group, key: row.key };
    if (row.kind === 'toggle') {
      const s = state(hass, row.id);
      if (!usable(s)) return '';
      const on = s === 'on';
      return `<button class="tog tap" data-act="setting-toggle" data-room="${room}" data-group="${group}" data-key="${row.key}" aria-pressed="${on}"><div><div class="h">${esc(row.title)}</div><div class="s">${esc(row.sub)}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`;
    }
    const v = num(state(hass, row.id));
    return v === null ? '' : stepperRow(row, v, row.sub, 'setting-number', ds);
  }
  function settingGroupsHtml(hass, room) {
    return ROOM_SETTINGS[room].map((g) => {
      const rows = g.rows.map((r) => settingRowHtml(hass, room, g.key, r)).filter(Boolean).join('');
      return rows ? `<div class="lbl" style="margin:4px 4px -10px">${esc(g.title)}</div><div class="card">${rows}</div>` : '';
    }).join('');
  }

  // The sheet. It is inside the room-head card, fixed over the page, so the page underneath is untouched
  // and keeps its scroll position. Escape, the Close button and the scrim all close it; focus handling is in
  // the element (settingsOpen / settingsClose say where focus goes).
  function settingsSheet(hass, room) {
    const body = settingGroupsHtml(hass, room) || `<div class="card pad" style="color:${TOKENS.text2};font-size:13px">No settings available for this room</div>`;
    const title = `${ROOMS[room].name} settings`;
    return `<div class="ovl"><div class="scrim" data-act="settings-close" aria-hidden="true"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1"><div class="sh"><div id="sheet-title" style="font-size:20px;font-weight:700;letter-spacing:-.2px">${esc(title)}</div><button class="round quiet" data-act="settings-close" aria-label="Close settings">${svg('M6 6l12 12M18 6L6 18', 20)}</button></div><div class="sb">${body}</div></div></div>`;
  }

  // Open/closed lives in ui.settings; ui.focus names the control that takes focus after the next paint
  // (the element reads it): into the sheet on open, back to the gear on close.
  function settingsOpen(ui, room) {
    if (!isObj(ui)) throw new Error('pulse-card: settingsOpen needs the card ui state');
    if (!Object.prototype.hasOwnProperty.call(ROOM_SETTINGS, room)) throw new Error(`pulse-card: no settings for "${room}"`);
    ui.settings = true;
    ui.focus = { act: 'settings-close' };
    return ui;
  }
  function settingsClose(ui) {
    if (!isObj(ui)) throw new Error('pulse-card: settingsClose needs the card ui state');
    ui.settings = false;
    ui.focus = { act: 'settings-open' };
    return ui;
  }
  // Tab wraps inside the open sheet. index -1 (focus outside the list) enters at the first or last control.
  function tabTarget(index, count, back) {
    if (!(count > 0)) return -1;
    if (index < 0 || index >= count) return back ? count - 1 : 0;
    return (index + (back ? -1 : 1) + count) % count;
  }

  function sectionDevice(hass, config) {
    if (config.entity === '') return '';
    const id = config.entity;
    const label = str(config.label) || 'Fan';
    const s = stateObj(hass, id);
    if (!s) return `<div class="card"><div class="tog"><div><div class="h">${esc(label)}</div><div class="s">Not found</div></div></div></div>`;
    if (!usable(s.state)) return `<div class="card"><div class="tog"><div><div class="h">${esc(label)}</div><div class="s">Unavailable</div></div></div></div>`;
    const on = s.state === 'on';
    const why = deviceReason(attr(hass, config.decision, 'reason'), on);
    const text = [on ? 'On' : 'Off', why].filter(Boolean).join(' · ');
    return `<div class="card"><button class="tog tap" data-act="toggle" data-entity="${esc(id)}" aria-pressed="${on}"><div><div class="h">${esc(label)}</div><div class="s">${esc(text)}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button></div>`;
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

  // ── Gardens ──────────────────────────────────────────────────────────────────────────────────
  // The theme helper is the only thing a person picks for the look; the Lights button turns the garden on (in
  // that theme) or off. Scenes are an implementation detail: the card never offers one directly, and it
  // never falls back silently when the theme has no scene.
  const THEME_LABELS = { normal: 'Normal', autumn: 'Autumn', halloween: 'Halloween', bonfire: 'Bonfire', christmas: 'Christmas' };
  const THEME_ICON = { normal: 'bulb', autumn: 'leaf', halloween: 'skull', bonfire: 'flame', christmas: 'tree' };
  const themeLabel = (id) => THEME_LABELS[id] || str(id).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const themeIcon = (id) => ICON[THEME_ICON[id] || 'bulb'];

  // 'Wed 5 Nov' from a YYYY-MM-DD date, or '' for anything else. Built from the parts (not Date.parse) so the
  // weekday cannot shift with the time zone.
  function shortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return '';
    return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  const hhmmMs = (ms) => (Number.isFinite(ms) ? localHm(ms) : '');
  const sameLocalDay = (a, b) => { const x = new Date(a); const y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
  // Minutes since noon, so an off time at or after midnight sorts after the evening (as the lights automation does).
  const sinceNoon = (h, m) => (h * 60 + m - 720 + 1440) % 1440;
  function beforeOff(nowMs, off) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(off);
    if (!m) return true;
    const d = new Date(nowMs);
    return sinceNoon(d.getHours(), d.getMinutes()) < sinceNoon(Number(m[1]), Number(m[2]));
  }

  // The next calendar change as {date, theme}, or null. The topic's JSON may arrive as an object or a string.
  function calendarNext(v) {
    let x = v;
    if (typeof x === 'string') { try { x = JSON.parse(x); } catch (e) { return null; } }
    if (!isObj(x) || !shortDate(x.date) || typeof x.theme !== 'string' || !x.theme) return null;
    return { date: x.date, theme: x.theme };
  }

  // The most recent time any of this garden's scenes except the off scene was activated (a scene's state is
  // its activation time), or null. A preview ends `preview_min` after this; a picked theme "applies at sunset"
  // when it was chosen after this.
  function lastLitMs(hass, key, offScene) {
    let best = null;
    for (const id of Object.keys(hass && isObj(hass.states) ? hass.states : {})) {
      if (!id.startsWith(`scene.${key}_`) || id === offScene) continue;
      const t = parseTs(state(hass, id));
      if (t !== null && (best === null || t > best)) best = t;
    }
    return best;
  }

  const sceneOf = (key, v) => (typeof v === 'string' && new RegExp(`^scene\\.${key}_[a-z0-9_]+$`).test(v) ? v : '');

  function gardenModel(hass, key, now) {
    if (!isGarden(key)) throw new Error(`pulse-card: unknown garden "${key}"`);
    const cfg = ROOMS[key];
    const sc = `sensor.${key}_lighting_scenes`;
    const scState = state(hass, sc);
    const reporting = usable(scState);
    const onScene = reporting ? sceneOf(key, scState) : '';
    const offScene = reporting ? sceneOf(key, attr(hass, sc, 'off_scene')) : '';
    const lights = strList(attr(hass, sc, 'lights'));
    // Clamped: a count above the list length would claim lights that the scene does not list.
    const lightsOn = lights.length ? Math.min(lights.length, Math.max(0, num(attr(hass, sc, 'lights_on')) || 0)) : 0;
    const helper = cfg.theme;
    const themeState = helper ? state(hass, helper) : 'normal';
    const theme = usable(themeState) ? themeState : '';
    const cal = `sensor.${key}_light_theme_calendar`;
    const calState = state(hass, cal);
    const previewMin = num(attr(hass, `sensor.${key}_lighting_window`, 'preview_min'));
    const sunset = parseTs(state(hass, 'sensor.sun_next_setting'));
    const calOn = state(hass, `input_boolean.${key}_light_theme_calendar_enabled`);
    const helperObj = helper ? stateObj(hass, helper) : null;
    return {
      key, name: cfg.name, hasTheme: !!helper, helper, reporting,
      onScene, offScene, sceneMissing: reporting && !onScene, lights, lightsOn, on: lightsOn > 0,
      theme, options: helper ? strList(attr(hass, helper, 'options')) : [],
      themeChangedMs: helperObj ? parseTs(helperObj.last_changed) : null,
      off: windowOff(hass, key), previewMin: previewMin !== null && previewMin > 0 ? Math.round(previewMin) : null,
      automationOn: state(hass, `input_boolean.${key}_automation_lights_enabled`) !== 'off',
      asleep: state(hass, 'sensor.house_active_mode') === 'sleep',
      sunBelow: state(hass, 'sun.sun') === 'below_horizon',
      sunsetMs: sunset, sunsetToday: sunset !== null && sunset > now && sameLocalDay(sunset, now),
      litMs: lastLitMs(hass, key, offScene),
      calToggle: usable(calOn) ? calOn : '', calToday: usable(calState) ? calState : '',
      calNext: calendarNext(attr(hass, cal, 'next')), calToggleId: `input_boolean.${key}_light_theme_calendar_enabled`,
    };
  }

  const gardenHeadline = (g) => {
    if (!g.reporting) return 'Lights unknown';
    if (!g.on) return 'Off';
    return g.hasTheme && g.theme ? `${themeLabel(g.theme)} · on` : 'On';
  };

  // The one sentence under the headline; first match wins. A missing scene is shown first when the garden is off,
  // because it is why the button is disabled. Unknown times are dropped, never invented.
  function gardenSub(g, now) {
    if (!g.reporting) return 'No lighting report from Home Assistant';
    if (!g.on && g.sceneMissing) return `No scene for ${themeLabel(g.theme || 'normal')}`;
    if (!g.automationOn) return 'Lights automation is off · they change only by hand';
    if (g.on) {
      if (g.sunBelow && (!g.off || beforeOff(now, g.off))) return g.off ? `Until ${g.off} or bedtime` : 'Until bedtime';
      if (g.previewMin !== null) {
        const ends = g.litMs === null ? null : g.litMs + g.previewMin * 60000;
        if (ends === null) return `Preview · off within ${g.previewMin} min`;
        return ends > now ? `Preview · off by ${hhmmMs(ends)}` : 'Preview · ending';
      }
      return g.off ? `Until ${g.off}` : 'Until bedtime';
    }
    if (g.asleep) return 'House asleep · back at sunset';
    return g.sunsetToday ? `On at sunset · ${hhmmMs(g.sunsetMs)}` : 'On at sunset tomorrow';
  }

  // Why the theme is what it is, from the calendar topic and its toggle.
  function themeSource(g) {
    if (g.calToggle === 'off') return 'Calendar paused · stays until you change it';
    if (!g.calToday) return '';
    const next = g.calNext;
    if (g.theme === g.calToday) return next ? `From calendar · ${themeLabel(next.theme)} from ${shortDate(next.date)}` : 'From calendar';
    return next ? `Picked by hand · calendar resumes ${shortDate(next.date)} with ${themeLabel(next.theme)}` : 'Picked by hand';
  }
  // A theme picked after the garden last showed anything has not been seen yet.
  function themeApplies(g, now) {
    if (!g.reporting || g.on || !g.hasTheme || !g.automationOn || g.asleep) return '';
    const pending = g.litMs === null || (g.themeChangedMs !== null && g.themeChangedMs > g.litMs);
    if (!pending) return '';
    return g.sunsetToday ? `Applies at sunset · ${hhmmMs(g.sunsetMs)}` : 'Applies at sunset';
  }

  function sectionGardenLights(hass, key, now) {
    const g = gardenModel(hass, key, now);
    const wantOn = !g.on;
    const target = wantOn ? g.onScene : g.offScene;
    const disabled = !g.reporting || !target;
    const btn = `<button class="gbtn${wantOn ? '' : ' quiet'}" data-act="garden-power" data-garden="${key}" data-want="${wantOn ? 'on' : 'off'}"${disabled ? ' disabled' : ''}>${wantOn ? 'Turn on' : 'Turn off'}</button>`;
    return `<div class="card"><div class="item gl">${svg(ICON.bulb, 18)}<div><div class="h">${esc(gardenHeadline(g))}</div><div class="s">${esc(gardenSub(g, now))}</div></div>${btn}</div></div>`;
  }

  function sectionGardenTheme(hass, key, now) {
    const g = gardenModel(hass, key, now);
    if (!g.hasTheme || !g.options.length) return '';
    const cols = g.options.length <= 4 ? g.options.length : 3;
    const tiles = g.options.map((o) => `<button class="tile${o === g.theme ? ' on' : ''}" data-act="garden-theme" data-garden="${key}" data-option="${esc(o)}" aria-pressed="${o === g.theme}">${svg(themeIcon(o), 20)}<span>${esc(themeLabel(o))}</span></button>`).join('');
    const lines = [themeSource(g), themeApplies(g, now)].filter(Boolean).map((t) => `<div class="note">${esc(t)}</div>`).join('');
    // Only when the calendar is not in charge: paused, or a theme picked by hand. Acting needs the toggle's state.
    const follow = !!g.calToday && !!g.calToggle && (g.calToggle === 'off' || g.theme !== g.calToday);
    const use = follow ? `<button class="tog tap" data-act="use-calendar" data-garden="${key}"><div><div class="h">Use calendar</div><div class="s">Back to ${esc(themeLabel(g.calToday))}, then follow the calendar</div></div></button>` : '';
    return `<div class="lbl" style="margin:4px 4px -10px">Theme</div><div class="card" style="padding:12px 12px 10px"><div class="tiles" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${tiles}</div>${lines}</div>${use ? `<div class="card">${use}</div>` : ''}`;
  }

  // Now: one wide tile per garden, below the indoor groups. Gardens stay out of the indoor attention,
  // occupied and other groups; the tile only shows a warn dot when the garden has items.
  function gardenTile(hass, key, now, flagged) {
    const g = gardenModel(hass, key, now);
    const dot = flagged ? '<span class="dot warn"></span>' : '';
    return `<a class="rt gt tap wide" data-act="nav" data-path="${roomPath(key)}"><div class="nm">${dot}<span>${esc(g.name)}</span></div><div class="t gh">${esc(gardenHeadline(g))}</div><div class="b"><span>${esc(gardenSub(g, now))}</span></div></a>`;
  }

  // ── Settings page ───────────────────────────────────────────────────────────────────────────────
  // The house-wide settings. Writes go to fixed helper ids (never an id read from the page), so the
  // select and number services can only reach these two helpers.
  const HOUSE_MODIFIER = 'input_select.house_active_mode_modifier';
  const HOUSE_VACATION_HOURS = 'input_number.house_automation_vacation_threshold_hours';
  const MODIFIERS = {
    none: { label: 'None', sub: 'The house follows its modes and presence' },
    guest: { label: 'Guest', sub: 'Home office held occupied, its lights stay on through sleep, cameras left alone when away' },
    sitter: { label: 'Sitter', sub: 'The house stays in normal mode while empty, so it never goes to away or vacation' },
  };
  // Heating numbers: the page names a key from this table, never an entity id, so set_value can only reach these.
  const HOUSE_NUMBERS = {
    baseline_day: { id: 'input_number.global_temperature_baseline_day', title: 'Day baseline', min: 0, max: 25, step: 0.5, unit: '°' },
    baseline_night: { id: 'input_number.global_temperature_baseline_night', title: 'Night baseline', min: 0, max: 25, step: 0.5, unit: '°' },
    comfort: { id: 'input_number.global_temperature_comfort', title: 'Comfort', min: 0, max: 25, step: 0.5, unit: '°' },
    minimum: { id: 'input_number.global_temperature_minimum', title: 'Minimum', min: 0, max: 25, step: 0.5, unit: '°' },
    window_grace: { id: 'input_number.global_heating_window_open_grace_minutes', title: 'Window open grace', min: 0, max: 30, step: 1, unit: ' min' },
  };
  const VACATION_MIN_H = 1;
  const VACATION_MAX_H = 168;
  const vacationStep = (h) => (h < 24 ? 1 : 6);

  // What the house mode does, in the words a person uses.
  function houseModeText(mode, hass, now) {
    const since = parseTs(stateObj(hass, 'sensor.house_active_mode') && stateObj(hass, 'sensor.house_active_mode').last_changed);
    switch (mode) {
      case 'normal': return { title: 'At home', body: 'Rooms follow their schedules and presence' };
      case 'sleep': return { title: 'Asleep', body: 'Heating at night baseline · kitchen camera on for Mo' };
      case 'away': {
        const h = num(state(hass, HOUSE_VACATION_HOURS));
        const left = since !== null && h !== null ? since + h * 3600000 - now : null;
        const vac = left === null ? '' : left <= 0 ? ' · vacation heating is due' : ` · vacation heating in ${left >= 3600000 ? Math.round(left / 3600000) + ' h' : Math.max(1, Math.round(left / 60000)) + ' min'}`;
        return { title: 'Away', body: `Heating at night baseline · cameras on${vac}` };
      }
      case 'vacation': return { title: 'On holiday', body: 'Heating at minimum' };
      default: return { title: usable(mode) ? mode.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Mode unknown', body: usable(mode) ? '' : 'No house mode is being reported' };
    }
  }

  function sectionHouseHead(hass, now) {
    const mode = state(hass, 'sensor.house_active_mode');
    const t = houseModeText(mode, hass, now);
    const since = stateObj(hass, 'sensor.house_active_mode') && stateObj(hass, 'sensor.house_active_mode').last_changed;
    const when = usable(mode) && hhmm(since) ? ` · since ${hhmm(since)}` : '';
    const mod = state(hass, HOUSE_MODIFIER);
    const modText = usable(mod) && mod !== 'none' && MODIFIERS[mod] ? ` · ${MODIFIERS[mod].label} modifier` : '';
    const banner = `<div class="card pad" style="display:flex;gap:10px;align-items:flex-start"><span class="dot${usable(mode) ? '' : ' dim'}" style="margin-top:5px"></span><div><div style="font-size:15px;font-weight:700">${esc(t.title)}</div><div style="font-size:13px;color:${TOKENS.text2};margin-top:3px;line-height:1.45">${esc(t.body)}${esc(when)}${esc(modText)}</div></div></div>`;
    return `${pageTitle('Settings')}${banner}`;
  }

  function sectionHouseMode(hass, now) {
    const mod = state(hass, HOUSE_MODIFIER);
    const vac = num(state(hass, HOUSE_VACATION_HOURS));
    let out = '';
    if (usable(mod)) {
      const segs = Object.keys(MODIFIERS).map((k) => `<button class="seg${mod === k ? ' on' : ''}" data-act="house-modifier" data-option="${k}" aria-pressed="${mod === k}">${MODIFIERS[k].label}</button>`).join('');
      const sub = (MODIFIERS[mod] || MODIFIERS.none).sub;
      out += `<div class="lbl" style="margin:4px 4px -10px">House mode</div><div class="card pad"><div class="segs" role="group" aria-label="Mode modifier">${segs}</div><div style="font-size:12.5px;color:${TOKENS.text2};margin-top:8px;line-height:1.45">${esc(sub)}</div></div>`;
    }
    if (vac !== null) {
      const away = state(hass, 'sensor.house_active_mode') === 'away';
      out += `<div class="card"><div class="tog"><div><div class="h">Vacation threshold</div><div class="s">${away ? 'Away now · counts from when the house went away' : 'How long away lasts before vacation heating'}</div></div><div style="display:flex;align-items:center;gap:6px"><button class="round" data-act="house-threshold" data-delta="-1" aria-label="Shorter">${svg('M5 12h14', 20)}</button><span style="min-width:44px;text-align:center;font-weight:600">${Math.round(vac)} h</span><button class="round" data-act="house-threshold" data-delta="1" aria-label="Longer">${svg('M12 5v14M5 12h14', 20)}</button></div></div></div>`;
    }
    return out;
  }

  // One stepper row. `data` becomes the buttons' dataset, which is how handleAction finds the fixed
  // table entry to write; it never carries the target helper id itself.
  function stepperRow(d, v, sub, act, data) {
    const shown = d.step < 1 ? v.toFixed(1) : String(Math.round(v));
    const attrs = Object.entries(data).map(([k, x]) => `data-${k}="${esc(x)}"`).join(' ');
    const btn = (delta, label, path) => `<button class="round" data-act="${act}" ${attrs} data-delta="${delta}" aria-label="${d.title} ${label}">${svg(path, 20)}</button>`;
    return `<div class="tog"><div><div class="h">${d.title}</div><div class="s">${esc(sub)}</div></div><div style="display:flex;align-items:center;gap:6px">${btn(-1, 'lower', 'M5 12h14')}<span style="min-width:58px;text-align:center;font-weight:600">${shown}${d.unit}</span>${btn(1, 'higher', 'M12 5v14M5 12h14')}</div></div>`;
  }

  // Same stepper as the vacation threshold, driven by a HOUSE_NUMBERS key.
  function numberRow(hass, key, sub) {
    const d = HOUSE_NUMBERS[key];
    const v = num(state(hass, d.id));
    if (v === null) return '';
    return stepperRow(d, v, sub, 'house-number', { key });
  }

  // One step of a table-defined number, snapped to the step and clamped to the table's range.
  function stepNumber(hass, d, delta) {
    const cur = num(state(hass, d.id));
    if (cur === null) return undefined;
    const dir = Number(delta) < 0 ? -1 : 1;
    const stepped = Math.round((cur + dir * d.step) / d.step) * d.step;
    return callService(hass, 'input_number', 'set_value', { entity_id: d.id, value: Math.max(d.min, Math.min(d.max, stepped)) });
  }

  function sectionHouseHeating(hass) {
    const master = state(hass, 'input_boolean.house_heating_enabled');
    const rows = [];
    if (usable(master)) {
      const on = master === 'on';
      const firing = state(hass, 'binary_sensor.house_heating_boiler_firing') === 'on';
      const sub = on ? (firing ? 'On · boiler firing' : 'On · boiler idle') : 'Off · every room drops to its minimum';
      rows.push(`<button class="tog tap" data-act="toggle" data-entity="input_boolean.house_heating_enabled" aria-pressed="${on}"><div><div class="h">Central heating</div><div class="s">${sub}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`);
    }
    const subs = {
      baseline_day: 'Daytime target for rooms on the global setpoints',
      baseline_night: 'Night target, also used while away',
      comfort: 'Warmest target, used when a room calls for comfort',
      minimum: 'Lowest target, also used on holiday and for open windows',
      window_grace: 'How long a window or door can stay open before heating drops to minimum',
    };
    const temps = ['baseline_day', 'baseline_night', 'comfort', 'minimum'].map((k) => numberRow(hass, k, subs[k])).join('');
    const grace = numberRow(hass, 'window_grace', subs.window_grace);
    const out = [];
    if (rows.length) out.push(`<div class="lbl" style="margin:4px 4px -10px">Heating</div><div class="card">${rows.join('')}</div>`);
    if (temps) out.push(`<div class="lbl" style="margin:4px 4px -10px">Temperature modes</div><div class="card">${temps}</div><div style="font-size:12px;color:${TOKENS.text2};margin:-6px 4px 0">Applies to every room that uses the global setpoints</div>`);
    if (grace) out.push(`<div class="lbl" style="margin:4px 4px -10px">Safety</div><div class="card">${grace}</div>`);
    return out.join('');
  }

  function sectionHousePeople(hass) {
    const rows = [['input_boolean.wfh_adam', 'Adam', 'person.adam'], ['input_boolean.wfh_sarah', 'Sarah', 'person.sarah']].map(([id, name, person]) => {
      const s = state(hass, id);
      if (!usable(s)) return '';
      const on = s === 'on';
      const where = state(hass, person) === 'home' ? 'Home' : usable(state(hass, person)) ? 'Away' : '';
      return `<button class="tog tap" data-act="toggle" data-entity="${id}" aria-pressed="${on}"><div><div class="h">${name} working from home</div><div class="s">${[where, 'Set automatically from the weekly pattern, tap to override'].filter(Boolean).join(' · ')}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`;
    }).join('');
    return rows ? `<div class="lbl" style="margin:4px 4px -10px">People</div><div class="card">${rows}</div>` : '';
  }

  // Mo's phone alerts. Same approach as HOUSE_NUMBERS: the page names a key, so turn_on/turn_off through this path
  // can only reach these two helpers.
  const MO_TOGGLES = {
    spotted: { id: 'input_boolean.mo_notifications_spotted_enabled', title: 'Spotted notifications', sub: 'A phone alert when Mo is seen on a camera' },
    eating: { id: 'input_boolean.mo_notifications_eating_enabled', title: 'Eating notifications', sub: 'A phone alert when Mo is at the feeder' },
  };
  function sectionHouseMo(hass) {
    const rows = Object.entries(MO_TOGGLES).map(([key, d]) => {
      const st = state(hass, d.id);
      if (!usable(st)) return '';
      const on = st === 'on';
      return `<button class="tog tap" data-act="mo-toggle" data-key="${key}" aria-pressed="${on}"><div><div class="h">${d.title}</div><div class="s">${d.sub}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? 'On' : 'Off'}"></span></button>`;
    }).join('');
    return rows ? `<div class="lbl" style="margin:4px 4px -10px">Mo</div><div class="card">${rows}</div>` : '';
  }

  // ── Cameras ──────────────────────────────────────────────────────────────────────────────────
  // The privacy switch is the source of truth per camera (on = camera off). group.cameras_privacy is not
  // used: it reads "off" as soon as one member is unavailable, which looks like cameras on.
  // Writes name a camera from this table, never an entity id taken from the page.
  const CAMERAS = [
    { k: 'parlour', name: 'Parlour' },
    { k: 'kitchen', name: 'Kitchen' },
    { k: 'home_office', name: 'Home office' },
  ];
  const cameraSwitch = (k) => `switch.${k}_privacy`;

  function cameraStatus(hass, c, now) {
    const sw = stateObj(hass, cameraSwitch(c.k));
    const s = sw && typeof sw.state === 'string' ? sw.state : '';
    if (!usable(s)) return { key: 'offline', tag: 'Offline', live: false, offline: true, since: ago(sw && sw.last_changed, now) };
    if (s === 'on') return { key: 'private', tag: 'Privacy on', live: false, offline: false };
    const person = state(hass, `binary_sensor.${c.k}_person_occupancy`) === 'on';
    return { key: 'live', tag: person ? 'Live · person' : 'Live', live: true, offline: false, person };
  }

  // A camera toggle uses the shared pending mark (see Tap feedback), which also remembers which way it asked.
  // A tap while the mark is still waiting is ignored, because a second tap would flip the camera straight back.
  const camUi = (ui) => (ui && ui.cam ? ui.cam : { rec: {} });
  const CAMERA_TOGGLE = (k) => ({ act: 'camera-toggle', camera: k });
  function cameraPending(ui, hass, k, now) {
    return pendingFor(ui, hass, CAMERA_TOGGLE(k), now);
  }
  function cameraToggle(hass, ui, k, now) {
    const c = CAMERAS.find((x) => x.k === k);
    if (!c) throw new Error(`pulse-card: unknown camera "${k}"`);
    const status = cameraStatus(hass, c, now);
    if (status.offline) return undefined;
    const pend = cameraPending(ui, hass, k, now);
    if (pend && pend.waiting) return undefined;
    pendingStart(ui, hass, CAMERA_TOGGLE(k), now, status.live ? 'private' : 'live');
    return callService(hass, 'switch', status.live ? 'turn_on' : 'turn_off', { entity_id: cameraSwitch(k) });
  }

  // Frigate clips from a media_source browse result; anything without a clip or an id is dropped.
  const CLIP_LIMIT = 20;
  function parseClips(result, limit = CLIP_LIMIT) {
    const kids = result && Array.isArray(result.children) ? result.children : [];
    const out = [];
    for (const item of kids) {
      const e = item && item.frigate && item.frigate.event;
      if (!e || !e.has_clip || !e.id || typeof item.media_content_id !== 'string') continue;
      const start = num(e.start_time);
      out.push({ id: String(e.id), mediaId: item.media_content_id, start: start === null ? null : start * 1000, label: str(e.label) || 'movement', zones: Array.isArray(e.zones) ? e.zones.map(str).filter(Boolean) : [] });
      if (out.length >= limit) break;
    }
    return out;
  }
  const frigateClipsId = (k) => `media-source://frigate/frigate/event-search/clips////${k}/`;
  const PTZ_DIRS = { up: '↑', left: '←', right: '→', down: '↓' };
  // "12 min ago" for the last day, then the weekday and time.
  const clipWhen = (ms, now) => {
    if (ms === null) return 'Unknown time';
    if (now - ms < 86400000) {
      const a = ago(new Date(ms).toISOString(), now);
      return a.replace(/^./, (x) => x.toUpperCase());
    }
    const d = new Date(ms);
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hhmm(d.toISOString())}`;
  };

  // What camera-mode-sync does for the current house mode; `want` is null when it leaves cameras alone.
  function cameraRule(hass) {
    const mode = state(hass, 'sensor.house_active_mode');
    const guest = state(hass, HOUSE_MODIFIER) === 'guest';
    const all = (v, over = {}) => Object.assign(Object.fromEntries(CAMERAS.map((c) => [c.k, v])), over);
    if (mode === 'away') return guest ? { text: 'House is away, but a guest is staying so cameras are left as they are', want: null } : { text: 'House is away · cameras on', want: all(true) };
    if (mode === 'sleep') return { text: 'House is asleep · only the kitchen camera is on, for Mo', want: all(false, { kitchen: true }) };
    if (mode === 'normal') return { text: 'House is at home · cameras off', want: all(false) };
    return { text: 'Cameras follow the house mode', want: null };
  }

  function camerasSummary(hass, now) {
    const st = CAMERAS.map((c) => ({ c, s: cameraStatus(hass, c, now) }));
    const live = st.filter((x) => x.s.live);
    const offline = st.filter((x) => x.s.offline);
    const rule = cameraRule(hass);
    const byHand = !!rule.want && st.some((x) => !x.s.offline && x.s.live !== rule.want[x.c.k]);
    const title = live.length === 0 ? 'All cameras off' : live.length === st.length ? 'All cameras on' : `${live.map((x) => x.c.name).join(' · ')} on`;
    return { st, live, offline, rule, byHand, title };
  }

  function sectionCamerasHead(hass, now) {
    const sum = camerasSummary(hass, now);
    const notes = [sum.rule.text, sum.byHand ? 'set by hand' : '', sum.offline.length ? `${sum.offline.map((x) => x.c.name).join(' · ')} offline` : ''].filter(Boolean);
    const warn = sum.offline.length > 0;
    const banner = `<div class="card pad${warn ? ' warn' : ''}" style="display:flex;gap:10px;align-items:flex-start"><span class="dot${warn ? ' warn' : sum.live.length ? '' : ' dim'}" style="margin-top:5px"></span><div><div style="font-size:15px;font-weight:700">${esc(sum.title)}</div><div style="font-size:13px;color:${TOKENS.text2};margin-top:3px;line-height:1.45">${esc(notes.join(' · '))}</div></div></div>`;
    const usableCams = sum.st.filter((x) => !x.s.offline).length;
    const master = usableCams ? `<div class="card"><button class="tog tap" data-act="cameras-all" aria-pressed="${sum.live.length > 0}"><div><div class="h">Cameras</div><div class="s">${sum.live.length ? 'Tap to turn all off' : 'Tap to turn all on'}</div></div><span class="sw${sum.live.length ? '' : ' off'}" role="img" aria-label="${sum.live.length ? 'On' : 'Off'}"></span></button></div>` : '';
    return `${pageTitle('Cameras')}${banner}${master}`;
  }

  // `live` says whether a stream belongs above `rest`. The element draws the stream in a slot of its own that
  // repaints never touch; render() (tests, and any caller without an element) puts a placeholder in instead.
  function cameraParts(hass, camera, now, ui) {
    const c = CAMERAS.find((x) => x.k === camera);
    const st = cameraStatus(hass, c, now);
    const pend = cameraPending(ui, hass, c.k, now);
    const waiting = !!pend && pend.waiting;
    let tag = st.tag;
    let cls = st.key === 'live' ? 'tag ok' : st.key === 'private' ? 'tag off' : 'tag';
    if (waiting) { tag = pend.want === 'live' ? 'Turning on…' : 'Turning off…'; cls = 'tag off'; }
    else if (pend) { tag = 'No response'; cls = 'tag'; }
    const sub = st.offline ? `Offline${st.since ? ' · ' + st.since : ''}` : waiting ? 'Waiting for the camera' : pend ? 'It did not change · tap to try again' : st.live ? (st.person ? 'Person in view' : 'No one in view') : 'Camera is off';
    const head = `<div class="tog"><div style="display:flex;align-items:center;gap:10px">${svg(ICON.camera, 20)}<div><div class="h">${c.name}</div><div class="s">${esc(sub)}</div></div></div><span class="${cls}">${esc(tag)}</span></div>`;
    const toggle = st.offline ? '' : `<button class="tog tap" data-act="camera-toggle" data-camera="${c.k}" aria-pressed="${st.live}"><div><div class="h">Camera on</div><div class="s">${waiting ? 'Waiting for the camera' : st.live ? 'Tap to turn off' : 'Tap to turn on'}</div></div><span class="sw${st.live ? '' : ' off'}" role="img" aria-label="${st.live ? 'On' : 'Off'}"></span></button>`;
    const pad = st.live ? ptzPad(hass, c) : '';
    return { live: st.live, rest: markPending(`${head}${toggle}${pad}${recordingsBlock(hass, c, now, ui)}`, ui, hass, now) };
  }

  function sectionCamera(hass, camera, now, ui) {
    const parts = cameraParts(hass, camera, now, ui);
    return `<div class="card">${parts.live ? `<div class="stream" data-stream="${camera}"></div>` : ''}${parts.rest}</div>`;
  }

  // Pan/tilt: hidden altogether while the camera has none of its four buttons (they are unavailable when the
  // camera is unreachable); individual buttons disable on their own.
  function ptzPad(hass, c) {
    // A button reads `unknown` until its first press, which is a working button; only these two are not.
    const avail = (d) => { const st = state(hass, `button.${c.k}_move_${d}`); return st !== '' && st !== 'unavailable'; };
    if (!Object.keys(PTZ_DIRS).some(avail)) return '';
    const b = (d) => `<button data-act="camera-ptz" data-camera="${c.k}" data-dir="${d}" aria-label="Move ${d}"${avail(d) ? '' : ' disabled'}>${PTZ_DIRS[d]}</button>`;
    return `<div class="ptz"><div></div>${b('up')}<div></div>${b('left')}<div></div>${b('right')}<div></div>${b('down')}<div></div></div>`;
  }

  function recordingsBlock(hass, c, now, ui) {
    const r = camUi(ui).rec[c.k] || { open: false };
    const toggle = `<button class="tog tap" data-act="camera-rec" data-camera="${c.k}" aria-expanded="${!!r.open}"><div><div class="h">Recordings</div><div class="s">${r.open && r.status === 'ok' ? `${r.items.length} recent` : 'Clips of people and movement'}</div></div><span style="color:${TOKENS.text2};display:flex;transform:rotate(${r.open ? 180 : 0}deg)">${svg(ICON.chev, 20)}</span></button>`;
    if (!r.open) return toggle;
    const msg = (t) => `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">${t}</span></div>`;
    let body;
    if (r.status === 'loading' || !r.status) body = msg('Loading recordings…');
    else if (r.status === 'error') body = msg("Couldn't load recordings") + `<button class="tog tap" data-act="camera-rec-refresh" data-camera="${c.k}"><div><div class="h">Try again</div></div></button>`;
    else if (!r.items.length) body = msg('No recordings yet');
    else body = r.items.map((it) => {
      const what = [it.label.replace(/^./, (x) => x.toUpperCase()), it.zones.join(', ')].filter(Boolean).join(' · ');
      return `<button class="clip" data-act="camera-clip" data-camera="${c.k}" data-clip="${esc(it.id)}"><img src="/api/frigate/notifications/${encodeURIComponent(it.id)}/snapshot.jpg" alt="" loading="lazy"><div style="flex:1;min-width:0"><div class="t">${esc(clipWhen(it.start, now))}</div><div class="w">${esc(what)}</div></div><span style="color:${TOKENS.text2};display:flex">${svg(ICON.play, 18)}</span></button>`;
    }).join('');
    return toggle + body;
  }

  // Now: one row, quiet when all is as expected, amber when a camera is offline.
  function sectionCamerasCard(hass, now) {
    const sum = camerasSummary(hass, now);
    if (!CAMERAS.some((c) => stateObj(hass, cameraSwitch(c.k)))) return '';
    const warn = sum.offline.length > 0;
    const sub = warn ? `${sum.offline.map((x) => x.c.name).join(' · ')} offline` : sum.rule.text;
    return `<a class="card tap" data-act="nav" data-path="${CAMERAS_PATH}" aria-label="Open cameras" style="display:flex;align-items:center;gap:12px;padding:12px 14px${warn ? ';background:' + TOKENS.amberTag : ''}"><span style="color:${warn ? TOKENS.amber : TOKENS.text2};display:flex">${svg(ICON.camera, 22)}</span><div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:600">${esc(sum.title)}</div><div style="font-size:12px;color:${TOKENS.text2}">${esc(sub)}</div></div><span style="color:${TOKENS.link};display:flex">${svg('M9 5l7 7-7 7', 20)}</span></a>`;
  }

  function sectionRoomFeed(hass, key, now) {
    const { rows, note } = roomActivity(hass, key);
    const quiet = (msg) => `<div class="feed"><span class="a"></span><span style="color:${TOKENS.text2}">${esc(msg)}</span></div>`;
    const body = (rows.length ? activityRows(rows, ACTIVITY_ROWS) : quiet('Nothing recorded for this room yet')) + (note ? quiet(note) : '');
    return `<div class="lbl" style="margin:4px 4px -10px">Recent activity</div><div class="card">${body}</div>`;
  }

  // ── Tap feedback ─────────────────────────────────────────────────────────────────────────────
  // A tap is a request, not a result: a switch can take seconds to report back. So every write marks the tapped
  // element pending (aria-busy, dimmed) at once. The mark clears when a target entity's state, last_changed or
  // last_updated moves, or after PENDING_MS. If the service call is rejected the mark clears and the card shows a
  // short error, so a failure is never swallowed. State lives in `ui` (per card element); the HTML only reads it.
  const PENDING_MS = 8000;
  const ERROR_MS = 6000;

  // An element's identity is its data-* attributes (camelCase, as in el.dataset), sorted. A click and the HTML
  // render() marked therefore agree on the key without any id being added to the markup.
  const pendingKey = (ds) => Object.keys(ds).sort().map((k) => `${k}=${ds[k]}`).join('&');

  // The entities a write will change, from the same fixed tables handleAction writes through. Empty when
  // unknown, in which case there is nothing that could ever clear a mark, so none is set.
  function writeTargets(hass, ds) {
    const id = str(ds.entity);
    const table = (t, k) => (own(t, k) ? [t[k].id] : []);
    switch (ds.act) {
      case 'scene': case 'toggle': case 'brightness': case 'media-play': case 'media-power': case 'volume': return id ? [id] : [];
      case 'camera-toggle': return CAMERAS.some((c) => c.k === ds.camera) ? [cameraSwitch(ds.camera)] : [];
      case 'camera-ptz': return CAMERAS.some((c) => c.k === ds.camera) ? [`button.${ds.camera}_move_${ds.dir}`] : [];
      case 'cameras-all': return CAMERAS.map((c) => cameraSwitch(c.k));
      case 'house-modifier': return [HOUSE_MODIFIER];
      case 'house-threshold': return [HOUSE_VACATION_HOURS];
      case 'house-number': return table(HOUSE_NUMBERS, ds.key);
      case 'mo-toggle': return table(MO_TOGGLES, ds.key);
      case 'setting-toggle': case 'setting-number': {
        try { return [settingFor(ds.room, ds.group, ds.key).id]; } catch (err) { return []; }
      }
      case 'garden-power': case 'garden-theme': case 'use-calendar': {
        // The garden model reads the page's own sensors; a garden it cannot read has no target.
        try {
          const g = gardenModel(hass, ds.garden, Date.now());
          if (ds.act === 'garden-power') return [ds.want === 'on' ? g.onScene : g.offScene].filter(Boolean);
          return g.helper ? [g.helper] : [];
        } catch (err) { return []; }
      }
      default: return [];
    }
  }
  const snapshot = (hass, id) => {
    const s = stateObj(hass, id);
    return s ? { id, state: s.state, changed: s.last_changed, updated: s.last_updated } : null;
  };
  const snapshotMoved = (hass, snap) => {
    const s = stateObj(hass, snap.id);
    return !s || s.state !== snap.state || s.last_changed !== snap.changed || s.last_updated !== snap.updated;
  };

  // Mark a write pending. `want` is optional context (the camera toggle says which way it asked).
  function pendingStart(ui, hass, ds, now, want) {
    if (!isObj(ui)) throw new Error('pulse-card: pendingStart needs the card ui state');
    const snaps = writeTargets(hass, ds).map((id) => snapshot(hass, id)).filter(Boolean);
    if (snaps.length === 0) return null;
    if (!isObj(ui.pending)) ui.pending = {};
    ui.pending[pendingKey(ds)] = { at: now, snaps, want };
    return ui.pending[pendingKey(ds)];
  }
  function pendingClear(ui, ds) {
    if (isObj(ui) && isObj(ui.pending)) delete ui.pending[pendingKey(ds)];
  }
  // null when nothing is pending or a target has moved; otherwise how long it has been waiting. A mark that
  // outlived PENDING_MS stays visible to callers that want to say "no response" (cameras) but is not `waiting`.
  function pendingFor(ui, hass, ds, now) {
    const p = isObj(ui) && isObj(ui.pending) ? ui.pending[pendingKey(ds)] : undefined;
    if (!p || p.snaps.some((snap) => snapshotMoved(hass, snap))) return null;
    const age = Math.max(0, now - p.at); // a skewed clock must not make a mark immortal or negative
    return { waiting: age < PENDING_MS, timedOut: age >= PENDING_MS, want: p.want };
  }

  const unesc = (t) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const camel = (k) => k.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());
  // Adds aria-busy to every control in `html` whose write is still pending. Runs on the finished HTML so each
  // section stays unaware of tap feedback. A control that already says it is busy is left alone.
  function markPending(html, ui, hass, now) {
    if (!isObj(ui) || !isObj(ui.pending) || Object.keys(ui.pending).length === 0) return html;
    return html.replace(/<[a-z][a-z0-9]*\b[^>]*\bdata-act="[^"]*"[^>]*>/g, (tag) => {
      if (/\baria-busy=/.test(tag)) return tag;
      const ds = {};
      for (const m of tag.matchAll(/\bdata-([a-z][a-z0-9-]*)="([^"]*)"/g)) ds[camel(m[1])] = unesc(m[2]);
      const p = pendingFor(ui, hass, ds, now);
      return p && p.waiting ? tag.replace(/\/?>$/, (end) => ` aria-busy="true"${end}`) : tag;
    });
  }
  // "Couldn't reach Kitchen ceiling": the device by its friendly name, else the object part of its id.
  function reachName(hass, ds) {
    const ids = writeTargets(hass, ds);
    if (ids.length === 0) return 'that';
    if (ids.length > 1) return 'the devices';
    const named = entityName(hass, ids[0]);
    return named === ids[0] ? capFirst(pretty(ids[0].split('.').pop())) : named;
  }
  // Runs one write with feedback. `run` starts the write (and marks it pending); a rejection, or a synchronous
  // throw, clears the mark and sets the card's error. The real error goes to the console so a programming
  // mistake (an unknown table key) is not hidden behind the friendly sentence.
  async function guarded(hass, ui, ds, now, run) {
    ui.error = null;
    try {
      await run();
    } catch (err) {
      pendingClear(ui, ds);
      ui.error = { text: `Couldn't reach ${reachName(hass, ds)}`, at: now };
      if (typeof console !== 'undefined') console.warn('pulse-card: write failed', err && err.message ? err.message : err);
    }
  }
  const writeRun = (hass, ui, el, value, now) => () => {
    pendingStart(ui, hass, { ...el.dataset }, now);
    return handleAction(hass, el, value);
  };
  function perform(hass, ui, el, value, now) {
    return guarded(hass, ui, { ...el.dataset }, now, writeRun(hass, ui, el, value, now));
  }
  const errorBanner = (ui, now) => (isObj(ui) && isObj(ui.error) && Math.max(0, now - ui.error.at) < ERROR_MS
    ? `<div class="err" role="alert">${esc(ui.error.text)}</div>` : '');

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
    tabbar: (h, c, n, ui) => sectionTabbar(c, ui),
    'room-head': (h, c, n, ui) => sectionRoomHead(h, c.room, ui),
    lights: (h, c, n, ui) => sectionLights(h, c.room, n, ui),
    heating: (h, c) => sectionHeating(h, c.room),
    presence: (h, c) => sectionPresence(h, c.room),
    media: (h, c) => sectionMedia(h, c.room),
    device: (h, c) => sectionDevice(h, c),
    'room-feed': (h, c, n) => sectionRoomFeed(h, c.room, n),
    'garden-lights': (h, c, n) => sectionGardenLights(h, c.room, n),
    'garden-theme': (h, c, n) => sectionGardenTheme(h, c.room, n),
    'house-head': (h, c, n) => sectionHouseHead(h, n),
    'house-mode': (h, c, n) => sectionHouseMode(h, n),
    'house-people': (h) => sectionHousePeople(h),
    'house-heating': (h) => sectionHouseHeating(h),
    'house-mo': (h) => sectionHouseMo(h),
    'cameras-card': (h, c, n) => sectionCamerasCard(h, n),
    'cameras-head': (h, c, n) => sectionCamerasHead(h, n),
    camera: (h, c, n, ui) => sectionCamera(h, c.camera, n, ui),
  };
  const ROOM_MODES = ['room-head', 'lights', 'heating', 'presence', 'media', 'room-feed', 'garden-lights', 'garden-theme'];
  // Indoor rooms have scenes, a report and media; gardens have a lights row and a theme. The shared modes
  // (room-head, room-feed) work for both.
  const GARDEN_MODES = ['garden-lights', 'garden-theme'];
  const INDOOR_MODES = ['lights', 'heating', 'presence', 'media'];

  function validate(config) {
    if (!isObj(config) || !MODES[config.mode]) throw new Error(`pulse-card: unknown mode "${config && config.mode}"`);
    if (config.mode === 'camera' && !CAMERAS.some((c) => c.k === config.camera)) throw new Error(`pulse-card: mode "camera" needs a known camera, got "${config.camera}"`);
    // Both blank is the shared room template's "this room has no device": render nothing. One blank is a mistake.
    if (config.mode === 'device' && !(config.entity === '' && config.decision === '')) {
      const ok = (v) => typeof v === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(v);
      if (!ok(config.entity) || !ok(config.decision)) throw new Error(`pulse-card: mode "device" needs an entity and a decision sensor, got "${config.entity}" and "${config.decision}"`);
      const allowed = ALLOWED[config.entity.split('.')[0]];
      if (!allowed || !allowed.includes('turn_on') || !allowed.includes('turn_off')) throw new Error(`pulse-card: mode "device" cannot switch "${config.entity}"`);
    }
    if (ROOM_MODES.includes(config.mode) && !(typeof config.room === 'string' && Object.prototype.hasOwnProperty.call(ROOMS, config.room))) throw new Error(`pulse-card: mode "${config.mode}" needs a known room, got "${config.room}"`);
    if (GARDEN_MODES.includes(config.mode) && !isGarden(config.room)) throw new Error(`pulse-card: mode "${config.mode}" is for gardens, got "${config.room}"`);
    if (INDOOR_MODES.includes(config.mode) && isGarden(config.room)) throw new Error(`pulse-card: mode "${config.mode}" is for indoor rooms, got "${config.room}"`);
  }

  function render(mode, config, hass, now, ui) {
    validate({ ...config, mode });
    const at = Number.isFinite(now) ? now : Date.now();
    const body = MODES[mode](hass, config || {}, at, ui || {});
    const html = body && HEAD_MODES.includes(mode) ? topGuard(ui) + body : body;
    return html ? `<div class="p">${errorBanner(ui, at)}${markPending(html, ui, hass, at)}</div>` : '';
  }

  // ── Service calls ────────────────────────────────────────────────────────────────────────────
  function callService(hass, domain, service, data) {
    if (!ALLOWED[domain] || !ALLOWED[domain].includes(service)) {
      throw new Error(`pulse-card: service ${domain}.${service} is not an allowed write path`);
    }
    return hass.callService(domain, service, data);
  }

  // Garden writes go to a fixed helper or to a scene read from the garden's own lighting sensor at click time
  // (never an id from the page), and each is checked against the garden before anything is called.
  function gardenPower(hass, key, want) {
    if (want !== 'on' && want !== 'off') throw new Error(`pulse-card: unknown garden power "${want}"`);
    const g = gardenModel(hass, key, Date.now());
    const entity = want === 'on' ? g.onScene : g.offScene;
    if (!entity) throw new Error(`pulse-card: ${key} has no scene to turn ${want}`);
    return callService(hass, 'scene', 'turn_on', { entity_id: entity });
  }
  function gardenTheme(hass, key, option) {
    const g = gardenModel(hass, key, Date.now());
    if (!g.hasTheme) throw new Error(`pulse-card: ${key} has no theme`);
    if (!g.options.includes(option)) throw new Error(`pulse-card: "${option}" is not a theme of ${key}`);
    return callService(hass, 'input_select', 'select_option', { entity_id: g.helper, option });
  }
  // Calendar back in charge: switch the toggle on if it is off, then select the calendar's theme. In that
  // order, so the toggle is never off while the theme says "from calendar".
  async function useCalendar(hass, key) {
    const g = gardenModel(hass, key, Date.now());
    if (!g.hasTheme || !g.calToggle || !g.calToday) throw new Error(`pulse-card: ${key} has no calendar to use`);
    if (!g.options.includes(g.calToday)) throw new Error(`pulse-card: calendar theme "${g.calToday}" is not an option of ${key}`);
    if (g.calToggle === 'off') await callService(hass, 'input_boolean', 'turn_on', { entity_id: g.calToggleId });
    return callService(hass, 'input_select', 'select_option', { entity_id: g.helper, option: g.calToday });
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
      case 'camera-ptz': {
        const k = el.dataset.camera;
        const dir = el.dataset.dir;
        if (!CAMERAS.some((c) => c.k === k) || !Object.prototype.hasOwnProperty.call(PTZ_DIRS, dir)) throw new Error(`pulse-card: unknown pan/tilt "${k}/${dir}"`);
        return callService(hass, 'button', 'press', { entity_id: `button.${k}_move_${dir}` });
      }
      case 'cameras-all': {
        const known = CAMERAS.filter((c) => usable(state(hass, cameraSwitch(c.k))));
        const anyLive = known.some((c) => state(hass, cameraSwitch(c.k)) === 'off');
        return Promise.all(known.map((c) => callService(hass, 'switch', anyLive ? 'turn_on' : 'turn_off', { entity_id: cameraSwitch(c.k) })));
      }
      case 'house-modifier': {
        const option = el.dataset.option;
        if (!Object.prototype.hasOwnProperty.call(MODIFIERS, option)) throw new Error(`pulse-card: unknown modifier "${option}"`);
        return callService(hass, 'input_select', 'select_option', { entity_id: HOUSE_MODIFIER, option });
      }
      case 'house-threshold': {
        const cur = num(state(hass, HOUSE_VACATION_HOURS));
        const dir = Number(el.dataset.delta) < 0 ? -1 : 1;
        if (cur === null) return undefined;
        const next = Math.max(VACATION_MIN_H, Math.min(VACATION_MAX_H, Math.round(cur + dir * vacationStep(dir < 0 ? cur - 1 : cur))));
        return callService(hass, 'input_number', 'set_value', { entity_id: HOUSE_VACATION_HOURS, value: next });
      }
      case 'house-number': {
        const d = Object.prototype.hasOwnProperty.call(HOUSE_NUMBERS, el.dataset.key) ? HOUSE_NUMBERS[el.dataset.key] : null;
        if (!d) throw new Error(`pulse-card: unknown house setting "${el.dataset.key}"`);
        return stepNumber(hass, d, el.dataset.delta);
      }
      case 'setting-toggle': {
        const row = settingFor(el.dataset.room, el.dataset.group, el.dataset.key);
        if (row.kind !== 'toggle') throw new Error(`pulse-card: setting "${el.dataset.key}" is not a toggle`);
        return callService(hass, 'input_boolean', state(hass, row.id) === 'on' ? 'turn_off' : 'turn_on', { entity_id: row.id });
      }
      case 'setting-number': {
        const row = settingFor(el.dataset.room, el.dataset.group, el.dataset.key);
        if (row.kind !== 'number') throw new Error(`pulse-card: setting "${el.dataset.key}" is not a number`);
        return stepNumber(hass, row, el.dataset.delta);
      }
      case 'mo-toggle': {
        const d = Object.prototype.hasOwnProperty.call(MO_TOGGLES, el.dataset.key) ? MO_TOGGLES[el.dataset.key] : null;
        if (!d) throw new Error(`pulse-card: unknown Mo setting "${el.dataset.key}"`);
        return callService(hass, 'input_boolean', state(hass, d.id) === 'on' ? 'turn_off' : 'turn_on', { entity_id: d.id });
      }
      case 'garden-power': return gardenPower(hass, el.dataset.garden, el.dataset.want);
      case 'garden-theme': return gardenTheme(hass, el.dataset.garden, el.dataset.option);
      case 'use-calendar': return useCalendar(hass, el.dataset.garden);
      case 'media-play': return callService(hass, 'media_player', 'media_play_pause', { entity_id: id });
      case 'media-power': return callService(hass, 'media_player', ['off', 'standby'].includes(state(hass, id)) ? 'turn_on' : 'turn_off', { entity_id: id });
      case 'volume': return callService(hass, 'media_player', 'volume_set', { entity_id: id, volume_level: Math.max(0, Math.min(1, Number(value) / 100)) });
      default: return undefined;
    }
  }

  const api = { lightsStory, lightsState, verdictFor, houseActivity, parseHistory, readHistory, sentenceFor, roomActivity, unexplainedReasons, REASON_TEXT, TILE, TILE_H, TILE_WIDE_H, tileNeededHeight, STYLE, TABBAR_ENABLED, tabbarPlacement, TABS, cheapestWindow, COST_STAT, HIST_DAYS, HIST_MIN_ROWS, HIST_REFRESH_MS, histRequest, groupDailyCost, dailyCostFromWS, dayReadout, dailySummary, instantMs, localDate, energyStats, slotWindows, windowRange, coveredDay, isoDayLabel, standingNote, money, energyText, penceText, ENERGY_PATH, HOUSE_PATH, SETTINGS_PATH, takesTaps, coverNeed, topGuard, sheetFit, splitSheet, touchGuard, lockScroll, scrollTargets, SHEET_MARK, HEAD_MODES, TOP_GUARD_MAX, CAMERAS_PATH, PENDING_MS, cameraParts, cameraToggle, cameraPending, perform, pendingStart, pendingFor, pendingKey, markPending, ERROR_MS, parseClips, frigateClipsId, roomGroups, recentNote, slotAt, slotReadout, tooltipLeft, ratesOf, SCRUB_HOLD_MS, rateBands, DASH, formatPower, moAte, TOKENS, ROOMS, ROOM_ORDER, GARDEN_ORDER, ALL_ROOM_KEYS, THEME_LABELS, THEME_ICON, ICON, gardenModel, gardenSub, themeSource, shortDate, ALLOWED, DEVICE_REASONS, ROOM_SETTINGS, MO_TOGGLES, settingFor, settingsOpen, settingsClose, tabTarget, render, priceColour, PRICE_STOPS, PRICE_EXTREME_P, roomModel, attentionItems, handleAction, callService, num, parseList };
  root.PulseLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ── Custom element (browser only) ────────────────────────────────────────────────────────────
  const hasWindowEvents = () => typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function';
  if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined' && !customElements.get('pulse-card')) {
    class PulseCard extends HTMLElement {
      constructor() {
        super();
        this._root = this.attachShadow({ mode: 'open' });
        this._html = null;
        this._busy = false;
        this._ui = { top: 0, tb: 'inflow', open: false, settings: false, focus: null, day: 'today', fuel: 'electricity', cam: { rec: {} }, pending: {}, error: null, hist: { electricity: { status: 'loading', days: [] }, gas: { status: 'loading', days: [] } } };
        this._histBusy = false;
        this._histSeq = 0;
        this._histAt = 0;
        this._histRetryAt = 0;
        this._scrub = { idx: null, slots: null, active: false, pending: null, timer: null };
        this._wireControls(this._root);
        this._portal = null; // the settings sheet's host on document.body while it is open
        this._portalBroken = false;
        // Price chart scrubbing (see PR for the manual test list; not testable in node).
        this._root.addEventListener('pointerdown', (ev) => this._chartDown(ev));
        this._root.addEventListener('pointermove', (ev) => this._chartMove(ev));
        this._root.addEventListener('pointerup', (ev) => this._chartUp(ev));
        this._root.addEventListener('pointercancel', () => this._chartCancel());
        this._root.addEventListener('keydown', (ev) => this._chartKey(ev));
        this._opener = null; // the control (maybe in another card) that opened the settings sheet
        this._onOpenRequest = (ev) => this._settingsRequest(ev);
        this._onWindowKey = (ev) => this._settingsKey(ev);
        this._root.addEventListener('focusout', (ev) => { if (ev.target && ev.target.closest && ev.target.closest('[data-chart]') && !this._scrub.active) this._chartClear(); });
      }
      // Taps, toggles and slider drags: wired to the card's root and, while open, to the sheet's portal root.
      _wireControls(root) {
        root.addEventListener('click', (ev) => this._click(ev));
        root.addEventListener('change', (ev) => this._change(ev));
        // Keep the track fill under the thumb while dragging (no re-render mid-drag).
        root.addEventListener('input', (ev) => { const t = ev.target; if (t && t.type === 'range') t.style.setProperty('--p', `${t.value}%`); });
        root.addEventListener('pointerdown', (ev) => { if (ev.target && ev.target.type === 'range') this._busy = true; });
        root.addEventListener('pointerup', () => { this._busy = false; });
        root.addEventListener('pointercancel', () => { this._busy = false; });
      }
      setConfig(config) {
        validate(config);
        this._config = config;
      }
      set hass(hass) {
        this._hass = hass;
        this._histEnsure();
        this._paint();
        this._syncStream();
      }
      connectedCallback() {
        // Any card on the page (the gear, the Presence link) asks for the sheet by event; only the room-head card has one.
        if (hasWindowEvents()) {
          window.addEventListener('pulse-card:settings', this._onOpenRequest);
          window.addEventListener('keydown', this._onWindowKey);
        }
        this._histEnsure();
        this._tabbarProbeLater();
        this._topProbeLater();
      }
      disconnectedCallback() {
        if (hasWindowEvents()) {
          window.removeEventListener('pulse-card:settings', this._onOpenRequest);
          window.removeEventListener('keydown', this._onWindowKey);
        }
        // The portal lives outside this element, so unmounting must take it down; the sheet state goes with it
        // so a remount does not come back to an invisible open sheet.
        this._portalHide();
        if (this._ui.settings) { this._ui.settings = false; this._ui.focus = null; this._opener = null; this._html = null; }
        this._histSeq += 1;
        this._histBusy = false;
        for (const t of this._tbTimers || []) clearTimeout(t);
        for (const t of this._topTimers || []) clearTimeout(t);
        this._topTimers = null;
        if (this._onResize && typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', this._onResize);
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
        if (this._config.mode === 'camera') { this._paintCamera(); return; }
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
        const kept = this._captureFocus();
        const { page, sheet } = splitSheet(html);
        const portaled = sheet ? this._portalShow(sheet) : (this._portalHide(), false);
        // No sheet, or a sheet that could not be portaled (fallback: it stays in the card): paint all of it here.
        this._root.innerHTML = `<style>${STYLE}</style>${portaled ? page : html}`;
        this._restoreFocus(kept);
        if (this._config.mode === 'tabbar' && !this._tbProbed) this._tabbarProbeLater();
        this._fitSheet();
        if (!this._topTimers) this._topProbeLater();
        // The repaint replaced the chart nodes: put a live readout back instead of flickering it away.
        if (this._scrub.idx !== null) this._chartShow(this._scrub.idx, false);
      }
      // ── settings sheet ──
      // A repaint replaces the DOM, which would drop focus and the sheet's scroll position on every stepper tap.
      // So both are captured before and put back after. A pending focus request (ui.focus: into the sheet on open,
      // back to the gear on close) wins over the captured one.
      _captureFocus() {
        const root = this._sheetRoot();
        const sheet = root.querySelector ? root.querySelector('.sb') : null;
        const active = root.activeElement || this._root.activeElement;
        return {
          scroll: sheet ? sheet.scrollTop : 0,
          key: sheet && active && active.dataset && active.dataset.act ? pendingKey(active.dataset) : null,
        };
      }
      // Controls only: the scrim shares the Close button's data-act but is not focusable.
      _focusables() {
        const sel = 'button[data-act], a[data-act]';
        return [...this._root.querySelectorAll(sel), ...(this._portal ? this._portal.root.querySelectorAll(sel) : [])];
      }
      _restoreFocus(kept) {
        const sheet = this._sheetRoot().querySelector('.sb');
        if (sheet && kept.scroll) sheet.scrollTop = kept.scroll;
        const req = this._ui.focus;
        this._ui.focus = null; // one-shot: a request that finds nothing must not steal focus on a later paint
        const list = this._focusables();
        const el = req ? list.find((x) => x.dataset.act === req.act) : kept.key ? list.find((x) => pendingKey(x.dataset) === kept.key) : null;
        if (el) el.focus({ preventScroll: true });
      }
      _sheetControls() {
        return [...this._sheetRoot().querySelectorAll('.sheet button:not([disabled])')];
      }
      // Where the sheet's DOM lives: the portal while it is open there, else the card (closed, or the fallback).
      _sheetRoot() { return this._portal ? this._portal.root : this._root; }
      // Show or update the portaled sheet. False means it could not be attached: the caller keeps the sheet in the card.
      _portalShow(sheetHtml) {
        if (this._portalBroken || typeof document === 'undefined' || !document.body) {
          this._portalWarn(this._portalBroken ? 'earlier failure' : 'no document body');
          return false;
        }
        try {
          if (!this._portal) this._portalOpen();
          this._portal.root.innerHTML = `<style>${STYLE}</style><div class="p">${sheetHtml}</div>`;
          return true;
        } catch (err) {
          this._portalBroken = true;
          this._portalHide();
          this._portalWarn(err && err.message ? err.message : err);
          return false;
        }
      }
      _portalWarn(why) {
        if (this._portalWarned) return;
        this._portalWarned = true;
        console.warn(`pulse-card: settings sheet kept inside the card (portal unavailable: ${why}); it may not scroll on iOS`);
      }
      _portalOpen() {
        const host = document.createElement('div');
        host.setAttribute('data-pulse-sheet', '');
        const root = host.attachShadow({ mode: 'open' });
        this._wireControls(root);
        // Non-passive: the guard has to be able to cancel. touchstart only records where the finger is.
        const pos = { x: null, y: null };
        const start = (ev) => { const t = ev.touches && ev.touches[0]; if (t) { pos.x = t.clientX; pos.y = t.clientY; } };
        const move = (ev) => this._sheetTouch(ev, pos);
        root.addEventListener('touchstart', start, { passive: true });
        root.addEventListener('touchmove', move, { passive: false });
        document.body.appendChild(host);
        this._portal = { host, root, unlock: lockScroll(scrollTargets(this, document)) };
      }
      _sheetTouch(ev, pos) {
        const t = ev.touches && ev.touches[0];
        if (!t) return;
        const dx = pos.x === null ? 0 : t.clientX - pos.x;
        const dy = pos.y === null ? 0 : t.clientY - pos.y;
        pos.x = t.clientX;
        pos.y = t.clientY;
        const body = ev.target && ev.target.closest ? ev.target.closest('.sb') : null;
        // A mostly sideways drag inside the body (a brightness slider) is not a scroll: leave it to the control.
        if (body && Math.abs(dx) > Math.abs(dy)) return;
        const verdict = touchGuard(body ? body.scrollTop : 0, body ? body.scrollHeight : 0, body ? body.clientHeight : 0, dy, !!body);
        if (verdict === 'prevent' && ev.cancelable) ev.preventDefault();
      }
      _portalHide() {
        const p = this._portal;
        if (!p) return;
        this._portal = null;
        p.unlock();
        p.host.remove();
      }
      _settingsRequest(ev) {
        const room = ev && ev.detail ? ev.detail.room : '';
        if (!this._config || this._config.mode !== 'room-head' || this._config.room !== room) return;
        this._opener = ev.detail.opener || null;
        settingsOpen(this._ui, room);
        this._paint();
      }
      _settingsClose() {
        if (!this._ui.settings) return;
        const opener = this._opener;
        this._opener = null;
        settingsClose(this._ui);
        this._paint();
        // Back to whatever opened it, if it is still on the page (the Presence link); else the gear, via ui.focus.
        if (opener && opener.isConnected && typeof opener.focus === 'function') { opener.focus(); this._ui.focus = null; }
      }
      _settingsKey(ev) {
        if (!this._ui.settings || !ev) return;
        if (ev.key === 'Escape') { ev.preventDefault(); this._settingsClose(); return; }
        if (ev.key !== 'Tab') return;
        const list = this._sheetControls();
        const at = list.indexOf(this._sheetRoot().activeElement);
        const to = tabTarget(at, list.length, ev.shiftKey);
        if (to < 0) return;
        ev.preventDefault();
        list[to].focus();
      }
      // ── cameras ──
      // The live stream is a real element, and moving or re-creating it restarts the video. So a camera card is
      // built once as a shell with a stream slot, and only the part below the slot is repainted. The slot shows
      // only while the camera is on, and the stream element exists only while the slot shows.
      _paintCamera() {
        let parts;
        try {
          parts = cameraParts(this._hass, this._config.camera, Date.now(), this._ui);
        } catch (err) {
          parts = { live: false, rest: `<div class="pad warn"><b>pulse-card error</b><div class="s">${esc(err && err.message)}</div></div>` };
        }
        if (!this._camShell) {
          this._root.innerHTML = `<style>${STYLE}</style><div class="p"><div class="card"><div class="stream" id="cam-stream" hidden></div><div id="cam-rest"></div></div></div>`;
          this._camShell = true;
          this._html = null;
        }
        this.style.display = '';
        if (parts.rest !== this._html) {
          this._html = parts.rest;
          this._root.getElementById('cam-rest').innerHTML = parts.rest;
        }
        this._root.getElementById('cam-stream').hidden = !parts.live;
        this._syncStream();
      }
      _syncStream() {
        if (!this._config || this._config.mode !== 'camera' || !this._hass || typeof document === 'undefined') return;
        const slot = this._root.getElementById ? this._root.getElementById('cam-stream') : null;
        if (!slot) return;
        if (slot.hidden) {
          if (this._streamEl) { this._streamEl.remove(); this._streamEl = null; }
          return;
        }
        if (!this._streamEl) {
          const el = document.createElement('ha-camera-stream');
          el.setAttribute('muted', '');
          el.setAttribute('controls', '');
          el.setAttribute('playsinline', '');
          slot.appendChild(el);
          this._streamEl = el;
        }
        this._streamEl.hass = this._hass;
        this._streamEl.stateObj = this._hass.states[`camera.${this._config.camera}`];
      }
      // Shows the pending mark at once, and again when the wait or the error message runs out, because
      // nothing else would repaint a card whose entity never answered.
      async _write(ds, run) {
        const now = Date.now();
        const done = guarded(this._hass, this._ui, ds, now, run);
        this._paint();
        setTimeout(() => this._paint(), PENDING_MS + 100);
        setTimeout(() => this._paint(), ERROR_MS + 100);
        await done;
        this._paint();
      }
      _cameraToggle(k) {
        return this._write(CAMERA_TOGGLE(k), () => cameraToggle(this._hass, this._ui, k, Date.now()));
      }
      async _recOpen(k, refresh) {
        const cur = this._ui.cam.rec[k] || { open: false, status: '', items: [] };
        if (!refresh) {
          cur.open = !cur.open;
          this._ui.cam.rec[k] = cur;
          if (!cur.open) { this._paint(); return; }
        }
        cur.open = true;
        cur.status = 'loading';
        this._ui.cam.rec[k] = cur;
        const seq = (cur.seq = (cur.seq || 0) + 1);
        this._paint();
        let next;
        try {
          if (typeof this._hass.callWS !== 'function') throw new Error('no websocket');
          next = { status: 'ok', items: parseClips(await this._hass.callWS({ type: 'media_source/browse_media', media_content_id: frigateClipsId(k) })) };
        } catch (e) {
          next = { status: 'error', items: [] };
        }
        if (cur.seq !== seq) return;
        Object.assign(cur, next);
        this._paint();
      }
      // The player is attached to the document, outside the shadow root: a repaint of the card must not
      // recreate the <video> and restart the clip.
      async _playClip(k, id) {
        const item = (this._ui.cam.rec[k] || { items: [] }).items.find((x) => x.id === id);
        if (!item || typeof document === 'undefined') return;
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', 'Recording');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;gap:12px;font-family:system-ui,sans-serif';
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.autoplay = true;
        video.style.cssText = 'max-width:100%;max-height:75vh;border-radius:12px;background:#000';
        const status = document.createElement('div');
        status.style.cssText = 'color:#a3adba;font-size:13px;min-height:18px';
        status.textContent = 'Loading…';
        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.cssText = 'min-height:44px;padding:0 28px;border:0;border-radius:22px;background:#e8ebef;color:#12151a;font:inherit;font-size:15px;font-weight:600;cursor:pointer';
        overlay.append(video, status, close);
        const done = () => { video.pause(); video.removeAttribute('src'); overlay.remove(); };
        close.addEventListener('click', done);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(); });
        document.documentElement.appendChild(overlay);
        try {
          const resolved = await this._hass.callWS({ type: 'media_source/resolve_media', media_content_id: item.mediaId });
          if (!resolved || typeof resolved.url !== 'string') throw new Error('no url');
          status.textContent = '';
          video.src = resolved.url;
        } catch (e) {
          status.textContent = "Couldn't play this recording";
        }
      }
      // ── top guard and sheet fit ──
      _topProbeLater() {
        if (!this._config || !HEAD_MODES.includes(this._config.mode) || this._topTimers) return;
        // HA and Material You build the header asynchronously: look again as it settles. The probe itself is cheap.
        this._topTimers = [0, 800, 2500].map((ms) => setTimeout(() => this._topProbe(), ms));
        this._onResize = () => this._topProbe();
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', this._onResize);
      }
      // Every header control (the hamburger, the back arrow, the action items) lives in an ancestor's shadow root;
      // collect the ones that would take a tap, in viewport coordinates.
      _headerBlockers() {
        const out = [];
        let node = this;
        while (node) {
          if (node.nodeType === 11 && node.querySelectorAll) {
            for (const el of node.querySelectorAll('ha-menu-button, ha-icon-button-arrow-prev, .action-items')) {
              const r = el.getBoundingClientRect();
              if (rectOk(r) && takesTaps(getComputedStyle(el))) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
            }
          }
          node = node.assignedSlot || node.parentNode || node.host || null;
        }
        return out;
      }
      _topProbe() {
        if (!this.isConnected || typeof getComputedStyle !== 'function' || !this._config || !HEAD_MODES.includes(this._config.mode)) return;
        const targets = [...this._root.querySelectorAll('[data-act]')]
          .filter((el) => !el.closest('.ovl'))
          .map((el) => el.getBoundingClientRect())
          .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
        const need = coverNeed(this._headerBlockers(), targets, this._ui.top);
        // Grow only (see the comment at TOP_GUARD_MAX).
        if (need > this._ui.top) {
          this._ui.top = need;
          this._paint();
        }
      }
      // After a paint with the sheet open: if the overlay is not the viewport (an ancestor contains it), size and lift
      // the sheet from the overlay's real rect. Otherwise the CSS rules stand.
      _fitSheet() {
        const ovl = this._root.querySelector('.ovl');
        if (!ovl || typeof window === 'undefined') return;
        const fit = sheetFit(window.innerHeight, ovl.getBoundingClientRect());
        if (!fit) return;
        ovl.style.setProperty('--sheet-inset', `${fit.inset}px`);
        ovl.style.setProperty('--sheet-max', `${fit.max}px`);
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
        if (el.dataset.act === 'camera-toggle') { this._cameraToggle(el.dataset.camera); return; }
        if (el.dataset.act === 'camera-rec') { this._recOpen(el.dataset.camera, false); return; }
        if (el.dataset.act === 'camera-rec-refresh') { this._recOpen(el.dataset.camera, true); return; }
        if (el.dataset.act === 'camera-clip') { this._playClip(el.dataset.camera, el.dataset.clip); return; }
        if (el.dataset.act === 'settings-open') {
          window.dispatchEvent(new CustomEvent('pulse-card:settings', { detail: { room: el.dataset.room, opener: el } }));
          return;
        }
        if (el.dataset.act === 'settings-close') { this._settingsClose(); return; }
        if (el.dataset.act === 'lights-toggle') {
          this._ui.open = !this._ui.open;
          this._paint();
          return;
        }
        if (el.type === 'range') return;
        this._act(el);
      }
      _change(ev) {
        const el = ev.target;
        if (!el || el.type !== 'range' || !this._hass) return;
        this._busy = false;
        this._act(el, el.value);
      }
      _act(el, value) {
        return this._write({ ...el.dataset }, writeRun(this._hass, this._ui, el, value, Date.now()));
      }
    }
    customElements.define('pulse-card', PulseCard);
    window.customCards = window.customCards || [];
    window.customCards.push({ type: 'pulse-card', name: 'Pulse card', description: 'Information-first house status sections' });
  }
})(typeof window !== 'undefined' ? window : globalThis);
