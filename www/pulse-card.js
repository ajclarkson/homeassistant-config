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
 * Config: `mode` (required), `room` / `camera` / `entity` / `decision` / `active` as each mode needs, and
 * `theme` (optional; `rose-pine` when absent, an unknown name is a card error), e.g.
 *   {type: custom:pulse-card, mode: status, theme: classic}
 * Every card of a dashboard should name the same theme; a theme applies to the card that names it.
 *
 * To add a theme: copy the `classic` entry in THEMES, give it a new key, and change the values; every
 * token must be present (load fails otherwise) and tests/pulse-card.test.mjs holds it to the contrast
 * floors. To change wording: edit COPY (interface text) or the tables next to it (SUBSYSTEMS,
 * REASON_TEXT, UNDECLARED); the tests fail on an unused key or a reference to a missing one.
 *
 * Rules this file keeps:
 *  - Rendering is a pure function (render(mode, config, hass, nowMs) -> html string) with no DOM,
 *    so it runs under node (tests/pulse-card.test.mjs).
 *  - Nothing may throw on missing data: every attribute read goes through the safe helpers below,
 *    every list through parseList, every number through num. Missing data renders an honest
 *    empty state, never a made-up value.
 *  - Colours live once, in THEMES; wording lives once, in COPY. Everything else references them.
 *  - Every write gives feedback (see Tap feedback): the control shows busy until its entity moves or
 *    8 s pass, and a failed call shows an error on the card.
 *  - Write paths are whitelisted per entity in ALLOWED ({domain: {service: [entity patterns]}}) and
 *    callService throws on any call whose entity_id matches none of them (or has none). Lights,
 *    switches, media players and camera buttons are exact ids taken from the room table, CAMERAS and
 *    the fan row; scenes are built from the room keys; helpers match the patterns listed there.
 *    HA is a read-only consumer of homerun events: this card never publishes to MQTT and never calls
 *    anything but the services allowed there. Every write goes through callService (a test checks).
 */
(function (root) {
  'use strict';

  // Switch the bottom tab bar off in one line (renders nothing).
  const TABBAR_ENABLED = true;
  // 49px of bar above the home-indicator area, which is at least 34px: 83px on a phone with a home indicator,
  // taller where the safe area is.
  const TABBAR_H = 'calc(49px + max(34px, env(safe-area-inset-bottom, 0px)))';

  // House page spacing. HM_SECTION_GAP is the one visible space above every section header and widget, measured
  // from the previous list or widget, whichever card each lives in. The cards sit in HA's grid, which adds its own
  // row gap between cards, so a card's top margin is HM_SECTION_GAP less that gap (the --row-gap variable, 8px if
  // unset) and inside a card each block gets the full HM_SECTION_GAP. The header card is first and has no margin.
  // HM_HEADER_INSET indents titles and section headers from the list edge, as iOS does. The lists themselves have
  // no side margin: HA's view padding is the inset.
  const HM_SECTION_GAP = 36;
  const HM_HEADER_INSET = 4;
  // The space above a block, less the grid's own row gap (see above). `.hm` uses it, and so does the one block that is
  // not built from these parts yet (the Mo notification switches on Settings), so its gap above matches.
  const HM_TOP_MARGIN = `max(0px,calc(${HM_SECTION_GAP}px - var(--row-gap,8px)))`;
  // One gutter for both two-column grids (the stat tiles and the scene buttons), so they read as one rhythm.
  const HM_GRID_GAP = 10;
  // A group's extra row (the Individual lights disclosure under the scenes) sits this far below the grid: close
  // enough to read as part of the group, not a new section.
  const HM_GROUP_GAP = 12;
  // The card inset: the left and right padding of a list row. The timeline uses it too.
  const HM_ROW_INSET = 14;

  // ── Themes (single definition of every colour) ───────────────────────────────────────────────
  // Tokens are named by role, not hue, so a theme can change a hue without a name lying. Every theme
  // defines every token; the card picks one by `theme:` in its config (default `rose-pine`; `classic` is the
  // original look). Colours reach CSS as custom properties (--pulse-<token>), set once on the card root, and
  // reach JS (SVG attributes, price maths, the clip player outside the shadow root) through colour().
  // This block is the only place a colour literal may appear (a test greps for strays).
  //   Surfaces: bg page and sheet ground; surface cards; control chips, tiles, badges and tip fills;
  //     controlEdge their outline; separator row dividers.
  //   Text: text; textSoft body text on controls; textSecondary sub-lines; textTertiary non-essential
  //     hints only (it can fall below 4.5:1 on some themes).
  //   Accent: tint is the selected / active fill, tintInk the text on it; tintFill the quiet selected state (tint at
  //     low alpha over a surface: primary text and a tint icon sit on it); link; on / off toggle tracks
  //     with knob / knobOff; sliderTrack the unfilled part of a slider (the fill is tint); ok good status; heat boiler
  //     firing.
  //   Attention: attention text and dots; attentionBg, attentionBorder, attentionRow fills.
  //   Chrome: tabBar translucent tab bar; scrimFull the clip player's backdrop; streamWell / videoBg
  //     behind camera pictures.
  //   Tiles (the rounded squares that lead a list row): each fill has an Ink, the glyph colour on it, held to
  //     3:1 by a test. sub<Subsystem> is one per homerun subsystem (activity rows); outside and bins lead those
  //     rows; occupied is an occupied room's tile; tileIdle is an empty room's or a declined decision's tile;
  //     attentionInk is the glyph on an attention tile (the fill is attention).
  //   Rail: the thin vertical line of an activity timeline (quieter than a separator, so the dots lead).
  //   People: present and presenceAway are the avatar presence dots; chevron is the dim row arrow.
  //   Price: priceStops are [hue, saturation %, lightness %] for the five PRICE_AT prices, interpolated
  //     in HSL (hues may run below 0 to cross red); priceNegative, priceExtreme, priceNeutral.
  const THEMES = {
    classic: {
      bg: '#12151a', surface: '#1a1f26', control: '#232a33', controlEdge: '#2f3843', separator: '#232a33',
      text: '#e8ebef', textSoft: '#cfd5dd', textSecondary: '#a3adba', textTertiary: '#8f9aa8',
      tint: '#f2c46b', tintInk: '#1d1708', tintFill: 'rgba(242,196,107,.16)', link: '#7aa7ff',
      on: '#3a8f63', off: '#3a424d', knob: '#fff', knobOff: '#c4ccd6', sliderTrack: '#3a424d',
      ok: '#6fcf97', heat: '#f08a4b',
      attention: '#f2b84b', attentionBg: '#221d10', attentionBorder: '#4a3d1c', attentionRow: '#201c10',
      tabBar: 'rgba(18,21,26,.82)', scrimFull: 'rgba(0,0,0,.94)',
      streamWell: '#0c0e12', videoBg: '#000',
      priceNegative: '#2ee6c8', priceExtreme: '#c2003b', priceNeutral: '#6b7684',
      priceStops: [[142, 58, 46], [88, 62, 56], [52, 82, 60], [26, 88, 56], [4, 80, 50]],
      // Tiles: a fill and the ink of the glyph on it. iOS system dark colours.
      subLighting: '#ffd60a', subLightingInk: '#000000', subHeating: '#ff6b35', subHeatingInk: '#000000',
      subOccupied: '#5e5ce6', subOccupiedInk: '#ffffff', subEnergy: '#ffd60a', subEnergyInk: '#000000',
      subCameras: '#636366', subCamerasInk: '#ffffff', subFan: '#64d2ff', subFanInk: '#000000',
      subShower: '#40c8e0', subShowerInk: '#000000', subSonos: '#bf5af2', subSonosInk: '#000000',
      subHouseMode: '#0a84ff', subHouseModeInk: '#ffffff', subMo: '#ac8e68', subMoInk: '#000000',
      subThermal: '#66d4cf', subThermalInk: '#000000', subWfh: '#ff375f', subWfhInk: '#000000',
      subModifier: '#ff453a', subModifierInk: '#000000',
      outside: '#30d158', outsideInk: '#000000', bins: '#32ade6', binsInk: '#000000', attentionInk: '#000000',
      occupied: '#ff9f0a', occupiedInk: '#000000', present: '#30d158', presenceAway: '#48484a',
      chevron: '#5a626d', tileIdle: '#2c2c2e', rail: '#2f3843',
    },
    // Rose Pine with Tokyo Night fill-ins.
    'rose-pine': {
      bg: '#191724', surface: '#1f1d2e', control: '#26233a', controlEdge: '#403d52', separator: 'rgba(110,106,134,.35)',
      text: '#e0def4', textSoft: '#e0def4', textSecondary: '#908caa', textTertiary: '#6e6a86',
      tint: '#c4a7e7', tintInk: '#191724', tintFill: 'rgba(196,167,231,.16)', link: '#7aa2f7',
      on: '#31748f', off: '#403d52', knob: '#e0def4', knobOff: '#908caa', sliderTrack: '#403d52',
      ok: '#9ccfd8', heat: '#ebbcba',
      attention: '#eb6f92', attentionBg: '#2b1f33', attentionBorder: '#5c3550', attentionRow: '#251c2e',
      tabBar: 'rgba(25,23,36,.82)', scrimFull: 'rgba(0,0,0,.94)',
      streamWell: '#14121f', videoBg: '#000',
      priceNegative: '#7dcfff', priceExtreme: '#b4637a', priceNeutral: '#6e6a86',
      // Pine, Foam, Gold, a warm coral, Love (hue -17 = 343, so the last step runs through orange to red).
      priceStops: [[197, 49, 38], [189, 43, 73], [35, 88, 72], [14, 75, 70], [-17, 76, 68]],
      subLighting: '#f6c177', subLightingInk: '#191724', subHeating: '#ebbcba', subHeatingInk: '#191724',
      subOccupied: '#9ccfd8', subOccupiedInk: '#191724', subEnergy: '#ff9e64', subEnergyInk: '#191724',
      subCameras: '#403d52', subCamerasInk: '#e0def4', subFan: '#7dcfff', subFanInk: '#191724',
      subShower: '#2ac3de', subShowerInk: '#191724', subSonos: '#bb9af7', subSonosInk: '#191724',
      subHouseMode: '#c4a7e7', subHouseModeInk: '#191724', subMo: '#9ece6a', subMoInk: '#191724',
      subThermal: '#73daca', subThermalInk: '#191724', subWfh: '#c0caf5', subWfhInk: '#191724',
      subModifier: '#f7768e', subModifierInk: '#191724',
      outside: '#31748f', outsideInk: '#e0def4', bins: '#7aa2f7', binsInk: '#191724', attentionInk: '#191724',
      occupied: '#9ccfd8', occupiedInk: '#191724', present: '#9ccfd8', presenceAway: '#524f67',
      chevron: '#524f67', tileIdle: '#2a2740', rail: '#403d52',
    },
  };
  const DEFAULT_THEME = 'rose-pine';
  const PRICE_AT = [0, 15, 25, 35, 44.99]; // pence for each of a theme's priceStops

  // Every theme must define exactly the tokens classic does: a missing or extra key fails at load,
  // not as an invisible element on one page of one theme.
  function checkThemes(themes) {
    const keys = Object.keys(themes.classic);
    for (const [name, t] of Object.entries(themes)) {
      const have = Object.keys(t);
      const missing = keys.filter((k) => !have.includes(k));
      const extra = have.filter((k) => !keys.includes(k));
      if (missing.length || extra.length) throw new Error(`pulse-card: theme "${name}" token mismatch (missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'})`);
      for (const k of keys) {
        if (k === 'priceStops') continue;
        if (typeof t[k] !== 'string' || t[k] === '') throw new Error(`pulse-card: theme "${name}" token "${k}" must be a colour string`);
      }
      const ok = Array.isArray(t.priceStops) && t.priceStops.length === PRICE_AT.length && t.priceStops.every((x) => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite));
      if (!ok) throw new Error(`pulse-card: theme "${name}" priceStops must be ${PRICE_AT.length} [hue, saturation, lightness] triples`);
    }
    return keys.filter((k) => k !== 'priceStops');
  }
  const COLOUR_KEYS = checkThemes(THEMES);

  // CSS side: TOKENS.text is the string "var(--pulse-text)". A misspelt token throws instead of
  // producing the CSS "var(--pulse-undefined)", which would silently drop the declaration.
  const TOKENS = new Proxy(Object.fromEntries(COLOUR_KEYS.map((k) => [k, `var(--pulse-${k})`])), {
    get(target, key) {
      if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`pulse-card: unknown colour token "${key}"`);
      return target[key];
    },
  });

  // Unknown theme names fail loudly (no silent fallback to classic); absent means the default.
  function themeOf(config) {
    const name = config && config.theme !== undefined ? config.theme : DEFAULT_THEME;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(THEMES, name)) throw new Error(`pulse-card: unknown theme "${name}" (known: ${Object.keys(THEMES).join(', ')})`);
    return THEMES[name];
  }
  // JS side: the theme the card is rendering with. render() sets it for a pass and restores it after;
  // event handlers that build colours outside a render call useTheme(config) first.
  let activeTheme = THEMES[DEFAULT_THEME];
  const useTheme = (config) => { activeTheme = themeOf(config); };
  function colour(key) {
    if (!COLOUR_KEYS.includes(key)) throw new Error(`pulse-card: unknown colour token "${key}"`);
    return activeTheme[key];
  }
  const themeVars = (theme) => `:host{${COLOUR_KEYS.map((k) => `--pulse-${k}:${theme[k]}`).join(';')}}`;
  const styleFor = (config) => themeVars(themeOf(config)) + STYLE;
  // Test helper: replace var(--pulse-x) with a theme's value, to compare against hex expectations.
  const resolveVars = (text, name) => text.replace(/var\(--pulse-(\w+)\)/g, (m, k) => {
    const t = THEMES[name];
    if (!t || !COLOUR_KEYS.includes(k)) throw new Error(`pulse-card: cannot resolve ${m} in theme "${name}"`);
    return t[k];
  });

  // ── Price colours ──────────────────────────────────────────────────────────────────────────
  // Graded by pence/kWh, interpolated in HSL between the theme's priceStops. In the classic theme
  // lightness varies along the scale (not just hue) so green and red stay apart for colour-blind
  // viewers; bar height and the numbers carry the price too. Negative prices are always good ("paid to
  // use") and get their own bright colour; >= PRICE_EXTREME_P is the theme's priceExtreme.
  const PRICE_EXTREME_P = 45;
  const PRICE_KEY_P = [0, 15, 30, 45];

  // ── Wording (everything the card says lives in this region) ──────────────────────────────────
  // COPY holds the interface chrome: titles, tab and control labels, empty and no-data states, units
  // text. Wording that needs a value is a small function. Sentences composed from live facts (verdicts,
  // banners, camera and heating explanations) are built where the facts are, from fragments in the
  // tables below. After COPY: SUBSYSTEMS (noun and icon per homerun subsystem), then the history
  // wording (REASON_TEXT per `subsystem:reason`, UNDECLARED for decisions homerun did not declare).
  // To change a word, edit it here; a test fails when a key is unused or a reference has no key.
  const COPY = {
    common: {
      tabHouse: 'Home', tabEnergy: 'Energy', tabCameras: 'Cameras', tabSettings: 'Settings',
      on: 'On', off: 'Off', notFound: 'Not found', unavailable: 'Unavailable',
      navLabel: 'Pulse', backToHouse: 'Back to House', modeModifier: 'Mode modifier',
      openCameras: 'Open cameras', openEnergy: 'Open energy details', openSettings: 'Open settings', shorter: 'shorter', longer: 'longer', lower: 'lower', higher: 'higher', play: 'Play', pause: 'Pause',
      cardError: 'pulse-card error',
    },
    home: {
      title: 'Home', house: 'House', bins: 'Bins', needsAttention: 'Needs attention', rooms: 'Rooms', outside: 'Outside',
      noAttentionReport: 'No attention report', mo: 'Mo', noReport: 'No report', noTemperatureSensor: 'no temperature sensor',
      lightsOff: 'Lights off', lightsOn: 'Lights on', noCollectionData: 'No collection data',
      heatingOff: 'Heating off', boilerFiring: 'Boiler firing', boilerIdle: 'Boiler idle',
      roomsOccupiedCount: (n) => `${n} occupied`,
      moreItems: (n) => `+${n} more`,
      personLabel: (name, status) => `${name}, ${status}`,
      // "At home" or "At home · Guest": the house mode and the modifier if one is set. How many rooms are in use
      // is said once, on the Rooms header.
      headerLine: (mode, modifier) => [mode, modifier].filter(Boolean).join(' · '),
      // A room's reason as the lower-case tail of its subtitle: "someone in bed", "doors closed", "Sonos playing".
      // The bed hold is reworded; a proper noun keeps its capital; any other label only loses its first capital.
      reasonText: (label) => (label === 'Bed occupied' ? 'someone in bed' : /^Sonos\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)),
      // The room subtitle: the lights, then ONE reason, or (only when there is none) when the scene was set:
      // "Lamps · someone in bed", "Full · doors closed", "Lamps · set 4 min ago", "Lights off".
      roomLine: (lights, reason, setAgo) => [lights, reason || str(setAgo).replace(/^scene /, '')].filter(Boolean).join(' · '),
      // "3 rooms heating · 17.7° in, 3.7° out · patio open"; the temperatures are already formatted ('' = no reading).
      heatingLine: (rooms, inside, outside, patio) => {
        const temps = [inside ? `${inside} in` : '', outside ? `${outside} out` : ''].filter(Boolean).join(', ') || 'no readings';
        return [rooms > 0 ? `${rooms} ${plural(rooms, 'room', 'rooms')} heating` : '', temps, patio ? 'patio open' : ''].filter(Boolean).join(' · ');
      },
      // Bin names as a sentence: "Food", "Food and refuse", "Food, garden and refuse".
      binNames: (names) => { const [first, ...rest] = names; const more = rest.map((n) => n.toLowerCase()); return more.length < 2 ? [first, ...more].join(' and ') : `${[first, ...more.slice(0, -1)].join(', ')} and ${more[more.length - 1]}`; },
      collected: (days) => (days <= 0 ? 'Collected today' : days === 1 ? 'Collected tomorrow' : `Collected in ${Math.round(days)} days`),
    },
    room: {
      heating: 'Heating', presence: 'Presence', lights: 'Lights', media: 'Media', theme: 'Theme',
      useCalendar: 'Use calendar', keepRoomOccupied: 'Keep room occupied', volume: 'Volume', brightness: 'Brightness',
      scenes: 'Scenes', automation: 'Automation', fan: 'Fan',
      temperature: 'Temperature', lightLevel: 'Light level', luxUnit: 'lx',
      // The Light level tile's sub-line, with the room's live dark threshold: "Bright enough · on below 15 lx".
      luxDark: (limit) => `Dark · on below ${limit} lx`, luxBright: (limit) => `Bright enough · on below ${limit} lx`,
      // The Presence row's sub-line when the room is occupied with nothing holding it, and when it is empty.
      emptiesSoon: 'Empties a few minutes after the last movement', noHolds: 'No holds',
      // The "Keep room occupied" description while it is off (the switch itself says on or off).
      keepOccupiedOff: 'Until you switch it off',
      occupied: 'Occupied', empty: 'Empty', occupancyUnavailable: 'Occupancy unavailable',
      override: 'Override',
      // The short word a presence hold shows beside the Occupied row; a hold with no entry shows its own label.
      holdShort: { 'Bed occupied': 'Bed', 'Doors closed': 'Doors', 'Sonos playing': 'Sonos' },
      holdMore: (n) => ` +${n}`,
      // Heating mode control: labels by helper option (the segment shows the short one, five words must fit a 320px
      // phone; the full word is its accessible name), the group's name and the footnotes.
      heatingModes: { auto: 'Auto', comfort: 'Comfort', baseline_day: 'Day', baseline_night: 'Night', minimum: 'Minimum' },
      heatingModesShort: { auto: 'Auto', comfort: 'Comfort', baseline_day: 'Day', baseline_night: 'Night', minimum: 'Min' },
      heatingModeGroup: 'Heating mode',
      heatingModeAuto: 'Follows the schedule',
      heatingModeUnavailable: 'The mode helper is unavailable, so a choice cannot be made',
      // temp may be '' (no reading); until may be '' (the plan does not say when the choice ends).
      heatingModeManual: (mode, temp, until) => `${mode}${temp ? ` ${temp}` : ''} ${until ? `until ${until}, then back to the schedule` : 'until the schedule next changes'}`,
      // The day plan with the mode control under its chart: the strip, its card and the notes that stand in for it.
      planNow: 'now', heatedToday: 'Heated today', radiatorHeating: 'radiator heating', radiatorIdle: 'radiator idle',
      planMode: (mode, temp) => `${mode} · ${temp}°`,
      planUntil: (time) => `until ${time}`, planByHand: (time) => `by hand until ${time}`, planHeld: 'held for now',
      planFrom: (time) => `From ${time}`, planResumes: (time) => `From ${time} · schedule resumes`,
      planLabel: (mode, temp, until) => `Today's heating plan. Now ${mode} ${temp} degrees${until ? ` until ${until}` : ''}.`,
      hoursMinutes: (h, min) => (min ? `${h} h ${min} min` : `${h} h`), minutes: (min) => `${min} min`,
      planMissing: 'There is no heating plan to show yet, so the day is not drawn',
      planStale: 'The heating plan is not for today, so the day is not drawn',
      planInvalid: 'The heating plan could not be read, so the day is not drawn',
      heatingLock: {
        automationOff: 'Heating automation is off for this room, so a choice would change nothing',
        windowOpen: 'A window or door is open, so the room is held at minimum',
        houseOff: 'House heating is off, so the room stays at minimum',
        away: 'The house is away, so heating follows the house',
        sleep: 'The house is asleep, so heating follows the house',
        vacation: 'The house is on holiday, so heating follows the house',
        house: 'Heating follows the house mode, so a choice would change nothing',
      },
      humidity: 'Humidity', normalTarget: 'Normal target', status: 'Status',
      manual: 'Manual', manualChange: 'Manual change', problem: 'Problem',
      hold: 'Hold', auto: 'Auto', suspended: 'Suspended', pending: 'Pending', heatingAutomationOff: 'Heating automation is off', pendingNote: 'Heating drops to minimum if it stays open',
      // The room's subtitle under its name: "Occupied · Lamps on", "Empty · lights off". `scene` is the active
      // scene's label ('' when none), only said while the lights are on.
      headLine: (occupancy, lightsOn, scene) => `${occupancy} · ${lightsOn ? (scene ? `${scene} on` : 'lights on') : 'lights off'}`,
      gardenLine: (reporting, on) => (!reporting ? 'Lights unknown' : on ? 'Lights on' : 'Lights off'),
      heatingTo: (t) => `Heating to ${t}`, heatingNow: 'Heating', targetIs: (t) => `Target ${t}`, notHeating: 'Not heating',
      individualLights: 'Individual lights',
      // Trailing summary of the "Individual lights" row: "2 of 5 on", or "All off".
      lightsSummary: (on, total) => (on === 0 ? 'All off' : `${on} of ${total} on`),
      allOn: 'All on',
      // Trailing summary of the "Automation" row when something is switched off: the one switch by name
      // ("Lights automation off"), else how many ("2 off").
      automationOff: (titles) => (titles.length === 1 ? `${titles[0]} off` : `${titles.length} off`),
      // The lights "why" line for a declined decision, time first: "Stayed off at 11:25: bright enough (...)".
      // The sentence is REASON_TEXT's, untouched; the time goes after its lead clause, else at the end.
      declinedLine: (sentence, time) => {
        if (!time) return sentence;
        const i = sentence.indexOf(': ');
        return i < 0 ? `${sentence} at ${time}` : `${sentence.slice(0, i)} at ${time}${sentence.slice(i)}`;
      },
    },
    energy: {
      title: 'Energy', prices: 'Prices', now: 'Now', next: 'Next', perKwh: 'per kWh', penceUnit: 'p/kWh',
      cheapestHeading: 'Cheapest 2 hours', nextCheapest: 'Next cheapest 2 hours', windows: 'Windows',
      cheapest: 'Cheapest', dearest: 'Dearest', average: 'Average', freePower: 'Free power', cheap: 'Cheap',
      none: 'None', noneUpcoming: 'None upcoming', today: 'Today', tomorrow: 'Tomorrow', thisMonth: 'This month',
      latestCompleteDay: 'Latest complete day',
      // The subtitle under the title: the smart meter's live draw. The tiles' second line: the half hour they cover.
      using: (usage) => `Using ${usage}`, until: (t) => `Until ${t}`, from: (t) => `From ${t}`, at: (t) => `at ${t}`,
      noPriceToday: 'No price data for today', ratesNotInYet: "Tomorrow's rates are not in yet",
      ratesPublishedLate: "Tomorrow's rates are published late afternoon", ratesEmpty: 'The rates list is empty or unavailable',
      dragChart: 'Drag across the chart to read any half hour', dragBars: 'Drag across the bars to read a day', publishedLate: 'Published about 1-2 days late',
      costLatest: 'Cost (latest published day)', octopusLate: 'Octopus publishes about 1-2 days late, so these cover an earlier day, not today',
      loadingHistory: 'Loading history…', historyUnavailable: 'History unavailable',
      historyUnavailableBody: 'The recorded cost history could not be read; the latest published day is shown above',
      dailyCost: 'Daily cost', electricity: 'Electricity', gas: 'Gas', usageLive: 'Usage (smart meter, live)',
      meterNote: "Live from the meter; the Octopus figures above are the supplier's, days late, and the two are not reconciled",
      runningNow: (until) => `Now${until ? `, until ${until}` : ''}`,
      // "Next 38.8p · using 188 W"; either part drops out when it is unknown. Short, so it holds one line on a phone.
      nextHalfHour: (price, usage) => [price ? `Next ${price}` : '', usage ? `using ${usage}` : ''].filter(Boolean).join(' · '),
      // The cheapest window: "09:00 – 11:00" today, "Tomorrow 09:00 – 11:00" (or the weekday) on another day.
      windowOn: (day, from, to) => `${day === 'Today' ? '' : `${day} `}${from} – ${to}`,
      avg: (price) => `avg ${price}`,
      dailyCostDays: (n) => `Daily cost, ${n} ${plural(n, 'day', 'days')}`,
    },
    cameras: {
      title: 'Cameras', master: 'Cameras', cameraOn: 'Camera on', recordings: 'Recordings', tryAgain: 'Try again',
      recordingsHint: 'Clips of people and movement', loadingRecordings: 'Loading recordings…', recordingsError: "Couldn't load recordings", noRecordings: 'No recordings yet',
      live: 'Live', privacyOn: 'Privacy on', offlineWord: 'Offline', turningOn: 'Turning on…', turningOff: 'Turning off…', noResponse: 'No response',
      personInView: 'Person in view', noOneInView: 'No one in view', cameraIsOff: 'Camera is off', waiting: 'Waiting for the camera', didNotChange: 'It did not change, tap to try again',
      byHand: 'Set by hand', usually: (rule) => `Usually ${rule}`, wentOffline: (ago) => `Went offline ${ago}`,
      recent: (n) => `${n} recent`,
      offline: (names) => `${names} offline`,
    },
    feed: {
      activity: 'Activity', today: 'Today', yesterday: 'Yesterday',
      day: (weekday, date, month) => `${weekday} ${date} ${month}`,
      nothingYet: 'Nothing recorded yet', roomNothingYet: 'Nothing recorded for this room yet', historyUnavailable: 'History unavailable',
    },
    settings: {
      title: 'Settings', houseMode: 'House mode', holidayThreshold: 'Holiday threshold', centralHeating: 'Central heating', heating: 'Heating',
      since: (t) => `Since ${t}`, home: 'Home', away: 'Away',
      thresholdAway: 'Away now, counting from when the house went away', thresholdIdle: 'How long away lasts before holiday heating',
      heatingOffNote: 'Every room drops to its minimum',
      workingFromHome: (name) => `${name} working from home`,
      wfhSub: (where) => `${where ? `${where}. ` : ''}Set automatically from the weekly pattern, tap to override`,
      temperatureModes: 'Temperature modes', temperatureModesNote: 'Applies to every room that uses the global setpoints',
      safety: 'Safety', people: 'People', mo: 'Mo',
    },
  };
  // A reference to a key that is not in the table throws, instead of printing "undefined" on the page.
  for (const area of Object.keys(COPY)) {
    COPY[area] = new Proxy(COPY[area], {
      get(target, key) {
        if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`pulse-card: no COPY.${area}.${key}`);
        return target[key];
      },
    });
  }

  // `implied`: the noun names the room's own state, so after a room subject it adds nothing ("Parlour marked occupied").
  // The subject, icon and tile colours (`tile` and `ink`, a THEMES token pair) of each homerun subsystem on the activity feeds: the one table. A test holds it to
  // the catalogue, so a new subsystem fails loudly here instead of showing up as a bare dot.
  const SUBSYSTEMS = {
    lighting: { noun: 'Lights', icon: 'bulb', tile: 'subLighting', ink: 'subLightingInk' },
    heating: { noun: 'Heating', icon: 'flame', tile: 'subHeating', ink: 'subHeatingInk' },
    occupied: { noun: 'Occupancy', implied: true, icon: 'person', tile: 'subOccupied', ink: 'subOccupiedInk' },
    energy: { noun: 'Energy', icon: 'bolt', tile: 'subEnergy', ink: 'subEnergyInk' },
    cameras: { noun: 'Cameras', icon: 'camera', tile: 'subCameras', ink: 'subCamerasInk' },
    fan: { noun: 'Fan', icon: 'fan', tile: 'subFan', ink: 'subFanInk' },
    shower: { noun: 'Shower', icon: 'droplet', tile: 'subShower', ink: 'subShowerInk' },
    sonos: { noun: 'Speakers', icon: 'speaker', tile: 'subSonos', ink: 'subSonosInk' },
    house_mode: { noun: 'House mode', icon: 'home', tile: 'subHouseMode', ink: 'subHouseModeInk' },
    mo: { noun: 'Mo', icon: 'paw', tile: 'subMo', ink: 'subMoInk' },
    thermal: { noun: 'Windows', icon: 'window', tile: 'subThermal', ink: 'subThermalInk' },
    wfh_inference: { noun: 'Working from home', icon: 'laptop', tile: 'subWfh', ink: 'subWfhInk' },
    modifier: { noun: 'Guest mode', icon: 'guest', tile: 'subModifier', ink: 'subModifierInk' },
  };
  const subsystemOf = (id) => own(SUBSYSTEMS, id) || { noun: capFirst(pretty(id)), icon: 'dot', tile: '', ink: '' };
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
  const friendlyName = (hass, id) => {
    const s = str(id);
    const f = s ? attr(hass, s, 'friendly_name') : '';
    return typeof f === 'string' ? f.trim() : '';
  };
  const entityName = (hass, id) => friendlyName(hass, id) || str(id);
  // The lights come on when the reading is at or below the threshold, so the words say "or below".
  const luxText = (f) => `${fmtLux(f.lux)}, on at ${fmtThreshold(f.lux_threshold)} or below`;
  const fmtHours = (v) => { const n = num(v); return n === null ? 'a long time' : `${clampInt(n, 0, 24 * 31)} h`; };
  // " (scene)" after "Scene set" when homerun says which scene; nothing when it does not.
  const sceneNote = (v) => (str(v).trim() ? ` (${pretty(v)})` : '');
  // A person is named by the fact (adam -> Adam); a missing one leaves the sentence without a name.
  const personLead = (v, tail) => (str(v).trim() ? `${capFirst(pretty(v).toLowerCase())} ${lowerFirst(tail)}` : tail);
  const fmtClock = (v) => { const t = str(v).trim(); return /^\d{1,2}:\d{2}$/.test(t) ? t : ''; };
  // Why a heating mode was re-evaluated, in the words after the reason. `other` is a runtime fallback and
  // says nothing; a cause that only repeats its reason (house mode on a house-mode reason, a manual set on
  // a manual setting) is dropped so the row never reads "house asleep, house mode changed".
  const HEATING_CAUSE = {
    boundary: 'schedule time reached', window_closed: 'window closed', house_mode: 'house mode changed', manual_ended: 'manual setting ended',
    manual_set: 'set by hand', occupancy: 'room occupancy changed', heating_on: 'heating switched on', wfh: 'working from home', startup: 'after a restart',
  };
  const REPEATS_CAUSE = { house_mode: /^house_mode_/, manual_set: /^manual_override$/ };
  const causeClause = (cause, reason) => {
    const c = str(cause).trim();
    const words = own(HEATING_CAUSE, c);
    if (!words || (REPEATS_CAUSE[c] && REPEATS_CAUSE[c].test(reason))) return '';
    return `, ${words}`;
  };
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

  // The privacy switch is on when the cameras are off, so the verdict reads the opposite way round.
  const privacyVerdict = (privacy) => {
    const p = str(privacy).trim().toLowerCase();
    return p === 'on' || p === 'true' ? 'Cameras off' : p === 'off' || p === 'false' ? 'Cameras on' : 'Cameras switched on or off';
  };

  // Known sources of an external suppress, as the plain phrase a person would use. Any other source falls back to
  // the entity's friendly name, which is usually a helper's technical name.
  const SUPPRESS_SOURCES = {
    'binary_sensor.hallway_upstairs_bed_occupied_sync': 'someone in bed',
  };
  const REASON_TEXT = {
    'lighting:automation_disabled': () => 'Stayed off: lights automation is off',
    'lighting:button_cycle': (f) => `Scene set${sceneNote(f.scene)} · button pressed`,
    'lighting:button_off': () => 'Lights off · button held',
    'lighting:calendar_boundary': (f) => `Theme switched to ${fmtTheme(f.theme)} · calendar`,
    'lighting:calendar_boundary_catch_up': (f) => `Theme switched to ${fmtTheme(f.theme)} · calendar, after a restart`,
    'lighting:calendar_theme_not_an_option': (f) => `Theme left as it is: the calendar wants ${fmtTheme(f.theme)}, which is not an option`,
    'lighting:external_suppress_active': (f, c) => `Stayed off: ${own(SUPPRESS_SOURCES, f.source) || `held off by ${c.name(f.source) || 'something else'}`}`,
    'lighting:guest_room_sleep_bypass': () => 'Not switched off at bedtime: room kept for a guest',
    'lighting:house_sleep_mode': () => 'Lights off · house set to asleep',
    'lighting:lux_high': (f) => `Stayed off: bright enough, ${fmtLux(f.lux)} (on at ${fmtThreshold(f.lux_threshold)} or below)`,
    'lighting:lux_low': (f) => (num(f.lux) === null ? `Scene set${sceneNote(f.scene)} · room occupied (no light reading)` : `Scene set${sceneNote(f.scene)} · room occupied and dark (${luxText(f)})`),
    'lighting:occupancy_off': () => 'Lights off · room empty',
    'lighting:occupancy_settle_off': () => 'Lights off · room stayed empty',
    'lighting:on_outside_evening_window': (f) => `Off in ${fmtMinutes(f.minutes)} · turned on by hand outside lighting hours`,
    'lighting:preview_ended': () => 'Lights off · preview over',
    'lighting:recent_auto_off': (f) => `Scene set${sceneNote(f.scene)} · back soon after lights went off`,
    'lighting:schedule_off': () => 'Lights off · end of the evening',
    'lighting:sleep_mode': () => 'Stayed off: house asleep',
    'lighting:sunrise': () => 'Lights off · sunrise',
    'lighting:sunset': () => 'Lights on · sunset',
    'lighting:sunset_while_house_asleep': () => 'Stayed off at sunset: house asleep',
    'lighting:theme_changed': (f) => `Lights restyled · lighting theme changed to ${fmtTheme(f.theme)}`,
    'lighting:theme_changed_by_hand_today': () => 'Theme left as it is: picked by hand (checked after a restart)',
    'lighting:theme_scene_missing': (f) => (str(f.theme).trim() ? `Normal scene used · no ${fmtTheme(f.theme)} scene set up` : 'Normal scene used · no scene set up for this theme'),
    'lighting:automation_disabled_restore': () => 'Porch light back to its look · porch automation is off',
    'lighting:halloween_scene_activated': () => 'Halloween animation started · Halloween scene on',
    'lighting:hold_expired': () => 'Porch light back to its look · motion over',
    'lighting:hold_expired_look_missing_garden_off': () => 'Porch light off · motion over, no saved look and garden off',
    'lighting:look_unreadable': () => "Porch light not warmed: couldn't save its current look",
    'lighting:motion_detected': () => 'Porch light warmed · motion detected',
    'lighting:motion_during_fade_back': () => 'Porch light warmed again · motion while it faded back',
    'lighting:no_feature_lights': () => 'Halloween effects not started: no lights labelled for them',
    'lighting:no_lights_in_theme_roles': (f) => `Effects not started: no lights set up for ${themeOr(f.theme, 'this theme')}`,
    'lighting:restore_look_missing': () => 'Porch light left warm: no saved look to go back to',
    'lighting:scene_changed_during_hold': () => 'Porch light warmed again · scene changed during motion',
    'lighting:theme_effects_stopped': (f) => (str(f.theme).trim() ? `Light effects stopped · ${fmtTheme(f.theme)} scene replaced` : 'Light effects stopped · theme scene replaced'),
    'lighting:theme_opted_out': () => 'Porch light stayed as it is: this theme ignores motion',
    'lighting:theme_scene_settled': (f) => (str(f.theme).trim() ? `Light effects started · ${fmtTheme(f.theme)} scene on` : 'Light effects started · theme scene on'),
    'heating:demand_ended': () => 'Boiler off · no room needs heat',
    'heating:demand_started': (f) => `Boiler on · ${roomList(f.rooms) || 'a room'} calling for heat`,
    'heating:door_closed_was_suspended': () => 'House heating back on · patio door closed',
    'heating:door_open_heating_on': () => 'House heating paused · patio door left open',
    'heating:heating_disabled': () => 'Boiler off · house heating switched off',
    'heating:helper_unavailable': (f) => `Heating left as it is: no ${modeWord(f.mode) || 'mode'} temperature available`,
    'heating:house_mode_away': (f) => `Heating ${setTo(f.mode)} · house away${causeClause(f.cause, 'house_mode_away')}`,
    'heating:house_mode_sleep': (f) => `Heating ${setTo(f.mode)} · house asleep${causeClause(f.cause, 'house_mode_sleep')}`,
    'heating:house_mode_vacation': (f) => `Heating ${setTo(f.mode)} · house on holiday${causeClause(f.cause, 'house_mode_vacation')}`,
    'heating:manual_override': (f) => `Heating ${setTo(f.mode)} · manual setting${causeClause(f.cause, 'manual_override')}`,
    'heating:overtemp_heater_on': (f) => `Heater off · too hot${fmtDegrees(f.temp) ? ` (${fmtDegrees(f.temp)})` : ''}`,
    'heating:safety_heating_disabled': (f) => `Heating ${setTo(f.mode)} · house heating switched off`,
    'heating:safety_window_open': (f) => `Heating ${setTo(f.mode)} · window open`,
    'heating:schedule': (f) => `Heating ${setTo(f.mode)} · schedule${causeClause(f.cause, 'schedule')}`,
    'heating:schedule_occupied': (f) => `Heating ${setTo(f.mode)} · schedule, room occupied${causeClause(f.cause, 'schedule_occupied')}`,
    'heating:temperature_set_arbitrage': (f) => `Heating ${setTo(f.mode)}${fmtDegrees(f.target) ? ` (${fmtDegrees(f.target)})` : ''} · free power, room empty${fmtDegrees(f.clamped_from) ? `, limited from ${fmtDegrees(f.clamped_from)}` : ''}`,
    'heating:trvs_not_set': (f) => `Radiators left as they are: no temperature for the mode in ${roomList(f.skipped) || 'some rooms'}`,
    'heating:unknown_mode': (f) => `Heating left as it is: unknown mode${modeWord(f.mode) ? ` (${modeWord(f.mode)})` : ''}`,
    'heating:valve_characteristic_lost': (f) => `Notification sent · ${roomName(f.room) ? lowerFirst(roomName(f.room)) : 'a'} radiator valve needs recalibrating`,
    'house_mode:all_left_door_recently': () => 'House set to away · everyone left',
    'house_mode:away_duration_exceeded': () => 'House set to holiday · away for a long time',
    'house_mode:bed_not_occupied': () => 'Not set to asleep: bed empty',
    'house_mode:bed_occupied': () => 'Stayed asleep: bed occupied',
    'house_mode:button_hold_bed_occupied': () => 'House set to asleep · button held, bed occupied',
    'house_mode:button_pressed': () => 'House set to at home · button pressed',
    'house_mode:double_press_bypass': () => 'House set to asleep · button double-pressed, bed sensor skipped',
    'house_mode:guest_mode_active': () => 'Stayed asleep: guest mode',
    'house_mode:kitchen_motion_detected': () => 'House set to at home · kitchen in use in the morning',
    'house_mode:parlour_active': () => 'Not set to asleep: parlour in use',
    'house_mode:sitter_mode_ended_house_empty': () => 'House set to away · sitter left, nobody home',
    'house_mode:sitter_present': () => 'House set to at home · house sitter here',
    'house_mode:someone_returned': () => 'House set to at home · someone came back',
    'cameras:away_but_guest_present': () => 'Cameras left off: house away, guest staying',
    'cameras:button_double_press': (f) => `${privacyVerdict(f.privacy)} · button double-pressed`,
    'cameras:guest_arrived_while_away': () => 'Cameras off · guest arrived while away',
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
    'fan:automation_disabled': () => 'Fan not started: fan automation is off',
    'fan:fan_not_auto_started': () => 'Fan left alone: already on by hand',
    'fan:fan_off_humidity_normal': () => 'Fan off · humidity back to normal',
    'fan:fan_off_max_run': () => 'Fan off · ran its maximum time',
    'fan:fan_on_shower_started': () => 'Fan on · shower started',
    'mo:eating': (f) => `Mo eating${roomName(f.room) ? ` · ${roomName(f.room)}` : ''}`,
    'mo:spotted': (f) => `Mo spotted${roomName(f.room) ? ` · ${roomName(f.room)}` : ''}`,
    'modifier:guest_absent': () => 'Home office released · guest mode off',
    'modifier:guest_present': () => 'Home office kept occupied · guest staying',
    'shower:shower_ended': () => 'Shower over · humidity falling',
    'shower:shower_max_duration': () => 'Shower marked over · on longer than any real shower',
    'shower:shower_started': () => 'Shower detected · humidity rising fast',
    'sonos:automation_disabled': () => 'Left the speaker group · grouping switched off',
    'sonos:automation_enabled': () => 'Joined the speaker group · grouping switched on',
    'thermal:close_bedroom': () => 'Told to close the bedroom windows · sun building',
    'thermal:close_both': () => 'Told to close bedroom and home office windows · sun building, outside warmer',
    'thermal:close_door': (f) => `Told to close the door · outside ${fmtDegrees(f.outdoor) || 'warmer'}${fmtDegrees(f.indoor) ? `, inside ${fmtDegrees(f.indoor)}` : ''}`,
    'thermal:close_home_office': () => 'Told to close the home office windows · outside warmer',
    'thermal:open_both': () => 'Told to open the windows · cooler outside',
    'thermal:open_door': (f) => `Told to open the door · inside ${fmtDegrees(f.indoor) || 'warm'}${fmtDegrees(f.outdoor) ? `, outside ${fmtDegrees(f.outdoor)}` : ''}`,
    'wfh_inference:always_wfh_wed_fri': (f) => `${personLead(f.person, 'Marked as working from home')} · always Wed to Fri`,
    'wfh_inference:home_at_inference_time': (f) => `${personLead(f.person, 'Marked as working from home')} · home${fmtClock(f.time) ? ` at ${fmtClock(f.time)}` : ' when checked'}`,
    'occupied:containment_failsafe_expired': (f) => `Marked empty · door shut but no movement for ${fmtHours(f.hours)}`,
    'occupied:motion_detected': () => 'Marked occupied · motion detected',
    'occupied:strong_hold_active': (f, c) => `Stayed occupied: held by ${c.name(f.hold) || 'a hold'}`,
    'occupied:strong_hold_started': (f, c) => `Marked occupied · held by ${c.name(f.hold) || 'a hold'}`,
    'occupied:timer_expired': (f) => `Marked empty · no one seen for ${fmtMinutes(f.minutes)}`,
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
      exit_sleep: { verb: 'house set to at home' },
      clear_recent_auto_off: { verb: 'reset after switching off' },
      switch_theme: { verb: 'theme switched' },
      start_preview: { verb: 'preview started' },
      set_mode: { verb: 'mode changed', note: { heating: 'heating changed' } },
      blocked: { verb: 'blocked' },
      suspend: { verb: 'suspended', note: { heating: 'heating suspended' } },
      restore: { verb: 'restored', note: { heating: 'heating restored' } },
      sync_window_external: { verb: 'window state synced' },
      set_sleep: { verb: 'house set to asleep' },
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
      house_mode_vacation: 'house on holiday', house_mode_normal: 'house at home', automation_disabled: 'automation is off',
    },
    nouns: { lighting: 'Lights', occupied: 'Occupancy', heating: 'Heating' },
  };
  // Words that keep their capital when a feed sentence follows its subject ("Parlour halloween..." would be wrong).
  const KEEP_CAPITAL = /^(Halloween|Octopus|Mo|Sonos)(?=\s|$)/;
  const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

  // Why a room is the way it is, for its subtitle, which has room for ONE reason. This is the priority order, most
  // important first; the first row that finds a label wins. Heating holds lead because they change what the house
  // does (heating is suspended); then the bed, then any other presence hold the report names; Sonos playing and
  // doors closed are weak signals, so they only speak when nothing stronger does; a manual change comes last.
  const presenceHold = (m, test) => m.pres_labels.find(test) || '';
  const ROOM_REASONS = [
    { why: 'a window or door open suspends heating', find: (m) => m.heat_labels[0] || '' },
    { why: 'someone in bed', find: (m) => presenceHold(m, (l) => l === 'Bed occupied') },
    { why: 'any other presence hold', find: (m) => presenceHold(m, (l) => l !== 'Bed occupied' && !/^(Sonos playing|Doors closed)$/.test(l)) },
    { why: 'a speaker is playing', find: (m) => presenceHold(m, (l) => l === 'Sonos playing') },
    { why: 'the doors are shut', find: (m) => presenceHold(m, (l) => l === 'Doors closed') },
    { why: 'someone changed the lights by hand', find: (m) => (m.manual ? COPY.room.manualChange : '') },
  ];
  function roomReason(m) {
    for (const r of ROOM_REASONS) {
      const label = r.find(m);
      if (label) return COPY.home.reasonText(label);
    }
    return '';
  }

  function undeclaredSentence(e) {
    const noun = own(UNDECLARED.nouns, e.subsystem) || capFirst(pretty(e.subsystem));
    const d = own(UNDECLARED.decisions, e.decision);
    const verb = d ? d.verb : pretty(e.decision);
    const why = own(UNDECLARED.reasons, e.reason) || pretty(e.reason);
    return `${noun}${verb ? ' ' + verb : ''}${why ? ' · ' + why : ''}`;
  }
  // What a failed run or action says, and whether it opens with a device's own name (so its case is kept). Devices are
  // named by their friendly name, never by entity id: without one the sentence opens with `fallback` (a room or a
  // subsystem noun) instead, and a guard simply leaves the device out.
  function problemParts(e, hass, fallback) {
    const d = e.detail;
    const friendly = friendlyName(hass, d.entity);
    if (e.kind === 'action_failed') {
      const lead = friendly || fallback;
      const text = d.failure === 'ack_timeout' ? `${lead} didn't respond` : `${lead} couldn't be controlled${str(d.action) ? ` (${pretty(str(d.action).split('.').pop())})` : ''}`;
      return { text, named: friendly !== '' };
    }
    switch (d.abort_kind) {
      case 'unavailable_input': return { text: `Couldn't run: ${friendly || 'an input'} unavailable`, named: false };
      case 'guard': return { text: `Held back${friendly ? ' · ' + friendly : ''}${e.reason ? ' · ' + pretty(e.reason) : ''}`, named: false };
      case 'unhandled_error': return { text: "Couldn't run: it failed unexpectedly", named: false };
      default: return { text: `Couldn't run: ${pretty(d.abort_kind) || 'unknown problem'}`, named: false };
    }
  }
  // A guard abort is an automation's precondition not being met: routine, never a problem.
  const isGuard = (e) => e.kind === 'abort' && e.detail.abort_kind === 'guard';
  // The one place an entry becomes words, plus how to show it: `ok` for something done, `muted` for a rule that
  // chose not to act, `warn` for a run that could not happen. A declared reason with no wording still renders
  // (never blank) and is reported by unexplainedReasons.
  function sentenceFor(e, hass, fallback = subjectOf(e.location, e.subsystem)) {
    if (e.kind !== 'decision') return { ...problemParts(e, hass, fallback), tone: isGuard(e) ? 'muted' : 'warn' };
    const tone = e.outcome === 'declined' ? 'muted' : 'ok';
    if (e.outcome === undefined) return { text: undeclaredSentence(e), tone };
    const fn = own(REASON_TEXT, `${e.subsystem}:${e.reason}`);
    const ctx = { name: (id) => entityName(hass, id) };
    return { text: fn ? fn(e.facts, ctx) : `${capFirst(pretty(e.subsystem))} ${pretty(e.reason)}`, tone };
  }

  const STYLE = `
:host{display:block}
*{box-sizing:border-box}
.p{font-family:'Inter',system-ui,-apple-system,sans-serif;color:${TOKENS.text};display:flex;flex-direction:column;gap:14px}
a,.tap{color:inherit;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
.card{background:${TOKENS.surface};border-radius:16px;overflow:hidden}
.card.warn{border:1px solid ${TOKENS.attentionBorder};background:${TOKENS.attentionBg}}
.pad{padding:14px}
.lbl{font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:${TOKENS.textTertiary}}
.dot{width:10px;height:10px;border-radius:50%;background:${TOKENS.ok};flex:none}
.dot.warn{background:${TOKENS.attention}}
.dot.dim{background:${TOKENS.textTertiary}}
.row{display:grid;grid-template-columns:10px 1fr auto;gap:12px;align-items:center;min-height:56px;padding:8px 14px;border-top:1px solid ${TOKENS.separator}}
.row:first-child{border-top:0}
.row.warn{background:${TOKENS.attentionRow};align-items:start}
.t{font-size:17px;font-weight:600;text-align:right}
.err{background:${TOKENS.attentionBg};border:1px solid ${TOKENS.attentionBorder};color:${TOKENS.attention};border-radius:12px;padding:10px 14px;font-size:13px;font-weight:600}
[aria-busy="true"]{opacity:.55;cursor:progress}
.link{display:flex;align-items:center;min-height:44px;font-size:13px;font-weight:600;color:${TOKENS.link}}
.h{font-size:14px;font-weight:600}
.s{font-size:12.5px;color:${TOKENS.textSecondary};margin-top:2px;line-height:1.4}
.tog{display:flex;align-items:center;gap:12px;justify-content:space-between;min-height:56px;padding:6px 14px;border-top:1px solid ${TOKENS.separator};width:100%;background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;font:inherit;text-align:left}
.tog:first-child{border-top:0}
.sw{width:46px;height:28px;border-radius:999px;background:${TOKENS.on};position:relative;flex:none}
.sw::after{content:'';position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;background:${TOKENS.knob}}
.sw.off{background:${TOKENS.off}}
.sw.off::after{right:auto;left:3px;background:${TOKENS.knobOff}}
.segs{display:flex;gap:8px;background:${TOKENS.surface};border-radius:14px;padding:4px}
.seg{border:0;font:inherit;font-size:14px;font-weight:600;min-height:44px;border-radius:12px;cursor:pointer;flex:1;background:transparent;color:${TOKENS.textSoft}}
.seg.on{background:${TOKENS.tint};color:${TOKENS.tintInk}}
.seg:disabled{opacity:.5;cursor:default}
.seg:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:2px}
.segs.five{gap:2px}
.segs.five .seg{font-size:13px;min-width:0;padding:0 2px}
.stream{background:${TOKENS.streamWell};aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}
.stream[hidden]{display:none}
.stream ha-camera-stream{display:block;width:100%}
.ptz{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,48px);gap:6px;justify-content:center;padding:12px ${HM_ROW_INSET}px;border-top:.5px solid ${TOKENS.separator}}
.ptz button{border:0;border-radius:12px;background:${TOKENS.control};color:${TOKENS.text};cursor:pointer;display:flex;align-items:center;justify-content:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.ptz button:active{transform:scale(.96)}
.ptz button:disabled{opacity:.35;cursor:default}
.hm-thumb{width:72px;height:48px;object-fit:cover;border-radius:8px;background:${TOKENS.control};flex:none}
.hm{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:${TOKENS.text};display:flex;flex-direction:column;margin-top:${HM_TOP_MARGIN}}
.hm>*+*{margin-top:${HM_SECTION_GAP}px}
.hm.hm-first{margin-top:0}
.hm .num,.hm-price,.hm-val{font-family:ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.hm-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 ${HM_HEADER_INSET}px}
.hm-hd{min-width:0}
.hm-big{margin:0;font-size:34px;line-height:41px;font-weight:700;letter-spacing:.3px}
.hm-line{display:block;font-size:15px;line-height:20px;color:${TOKENS.textSecondary};min-height:20px}
.hm-avs{display:flex;flex:none;gap:6px}
.hm-av{position:relative;box-sizing:border-box;width:36px;height:36px;border-radius:50%;background:${TOKENS.control};border:2px solid ${TOKENS.bg};display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:${TOKENS.text}}
.hm-pd{position:absolute;right:-2px;bottom:-2px;width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 2px ${TOKENS.bg}}
.hm-head{display:flex;flex-direction:column;gap:4px}
.hm-mo{padding:0 ${HM_HEADER_INSET}px;font-size:13px;line-height:18px;color:${TOKENS.textSecondary}}
.hm-foot{margin:0;padding:0 ${HM_HEADER_INSET}px;font-size:13px;line-height:18px;color:${TOKENS.textSecondary}}
.hm-sec{display:flex;flex-direction:column;gap:8px}
.hm-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 ${HM_HEADER_INSET}px}
.hm-h h2{margin:0;font-size:20px;line-height:25px;font-weight:700}
.hm-tr{font-size:15px;line-height:20px;font-weight:400;color:${TOKENS.textSecondary}}
.hm-list{background:${TOKENS.surface};border-radius:12px;overflow:hidden}
.hm-row{position:relative;display:flex;align-items:center;gap:12px;min-height:60px;padding:0 ${HM_ROW_INSET}px;color:inherit;text-decoration:none}
.hm-row+.hm-row::before{content:'';position:absolute;top:0;left:56px;right:0;height:.5px;background:${TOKENS.separator}}
.hm-tile{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none}
.hm-text{flex:1;min-width:0}
.hm-rt{font-size:17px;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hm-rs{font-size:14px;line-height:19px;color:${TOKENS.textSecondary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hm-val{flex:none;font-size:17px;line-height:22px;color:${TOKENS.textSecondary}}
.hm-chev{flex:none;display:flex;width:14px;color:${TOKENS.chevron}}
.hm-l1{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.tl-day+.tl-day{margin-top:12px}
.tl-day{display:flex;flex-direction:column;gap:8px}
.tl-h{padding:0 ${HM_HEADER_INSET}px;font-size:15px;line-height:20px;font-weight:600;color:${TOKENS.textSecondary}}
.hm-list.tl{padding:6px 0}
.tl-row{display:grid;grid-template-columns:40px 20px minmax(0,1fr);column-gap:10px;padding:6px ${HM_ROW_INSET}px}
.tl-t{text-align:right;font-size:14px;line-height:20px;color:${TOKENS.textSecondary}}
.tl-rail{position:relative;margin:-6px 0}
.tl-rail::before{content:'';position:absolute;left:9px;width:2px;top:0;bottom:0;background:${TOKENS.rail}}
.tl-row:first-child .tl-rail::before{top:16px}
.tl-row:last-child .tl-rail::before{bottom:auto;height:16px;top:0}
.tl-row:first-child:last-child .tl-rail::before{display:none}
.tl-dot{position:absolute;left:4px;top:10px;width:12px;height:12px;border-radius:50%;box-sizing:border-box;background:${TOKENS.surface};border:2px solid transparent}
.tl-row.acted .tl-dot{border-width:0}
.tl-row.problem .tl-dot{border-width:0;background:${TOKENS.attention}}
.tl-b{min-width:0;overflow-wrap:anywhere}
.tl-l1{font-size:15px;line-height:20px}
.tl-l2{font-size:13.5px;line-height:18px;margin-top:1px}
.tl-s{font-weight:600}
.tl-n{font-weight:600;color:${TOKENS.textSecondary}}
.hm-row:focus-visible,.hm-card:focus-visible,.hm-line:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:-2px}
.hm-card{background:${TOKENS.surface};border-radius:20px;padding:16px;display:block;color:inherit;text-decoration:none}
.plan-card{padding-bottom:0}
.plan-card .segs{margin:12px 0 16px}
.plan-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.plan-big{font-size:44px;line-height:48px;font-weight:300;letter-spacing:-1px}
.plan-mode{display:flex;flex-direction:column;align-items:flex-end;text-align:right}
.plan-mode-t{font-size:17px;font-weight:600}
.plan-mode-s{font-size:14px;color:${TOKENS.textSecondary}}
.plan-card .hm-list{margin:8px -16px 0;border-radius:0 0 20px 20px}
.hm-eh{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:600;color:${TOKENS.subEnergy}}
.hm-eb{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:8px}
.hm-ep{min-width:0}
.hm-price{font-size:40px;line-height:44px;font-weight:700}
.hm-price small{font-size:20px;font-weight:600;margin-left:2px;color:${TOKENS.textSecondary}}
.hm-es{font-size:13px;line-height:18px;color:${TOKENS.textSecondary}}
.hm-bars{display:flex;align-items:flex-end;gap:3px;height:44px;flex:none}
.hm-bar{width:7px;border-radius:4px;opacity:.55}
.hm-bar.now{opacity:1}
.hm-efoot{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:14px;padding-top:12px;border-top:.5px solid ${TOKENS.separator};font-size:15px;line-height:20px}
.hm-efoot .hm-es{font-size:15px;line-height:20px}
@media (max-width:359px){.hm-price{font-size:36px}}
.hm .hm-tight{margin-top:16px}
.hm-back{display:flex;align-items:center;align-self:flex-start;gap:2px;min-height:44px;min-width:44px;margin-left:-6px;padding-right:8px;font-size:17px;line-height:22px;color:${TOKENS.tint}}
.hm-back:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:-2px;border-radius:10px}
.hm-list.plain .hm-row+.hm-row::before{left:14px}
.hm-list.plain .hm-row{padding-top:8px;padding-bottom:8px}
.hm-list.plain .hm-rt,.hm-list.plain .hm-rs{white-space:normal;overflow:visible}
.hm-btn{width:100%;border:0;background:none;font:inherit;text-align:left;cursor:pointer;-webkit-tap-highlight-color:transparent}
.hm-btn:disabled{opacity:.4;cursor:default}
.hm-tv{margin-left:8px;color:${TOKENS.textSecondary}}
.hm-feet{display:flex;flex-direction:column;gap:6px}
.hm-ds{flex:0 1 auto;min-width:0;text-align:right}
.hm-btn[aria-expanded="true"] .hm-chev{transform:rotate(90deg)}
.hm-dp[hidden]{display:none}
.hm-dp .hm-row::before{content:'';position:absolute;top:0;left:14px;right:0;height:.5px;background:${TOKENS.separator}}
.hm-wgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:${HM_GRID_GAP}px}
.hm-w{background:${TOKENS.surface};border-radius:20px;padding:14px 16px;min-width:0}
.hm-w:only-child{grid-column:1/-1}
.hm-wgrid .hm-w:last-child:nth-child(odd){grid-column:1/-1}
.hm-wl{font-size:13px;line-height:18px;font-weight:600}
.hm-wv{font-family:ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif;font-size:34px;line-height:41px;font-weight:700}
.hm-wv small{font-size:17px;line-height:0;font-weight:600;margin-left:3px;color:${TOKENS.textSecondary}}
.hm-ws{font-size:14px;line-height:19px;color:${TOKENS.textSecondary};min-height:19px}
.hm-scenes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:${HM_GRID_GAP}px}
.hm-group-row{margin-top:${HM_GROUP_GAP}px}
.hm-scene{display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;min-height:76px;padding:12px 14px;border:0;border-radius:16px;font:inherit;font-size:15px;line-height:20px;font-weight:600;text-align:left;cursor:pointer;background:${TOKENS.surface};color:${TOKENS.text};-webkit-tap-highlight-color:transparent}
.hm-scene.wide{grid-column:1/-1;min-height:64px}
.hm-scene-t{display:flex;flex-direction:column;gap:2px}
.hm-scene-s{font-size:13px;line-height:18px;font-weight:500;color:${TOKENS.textSecondary}}
.hm-scene:disabled{opacity:.5;cursor:default}
.hm-scene.on{background:${TOKENS.tintFill};box-shadow:inset 0 0 0 1.5px ${TOKENS.tint}}
.hm-scene.on svg{color:${TOKENS.tint}}
.hm-scene:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:2px}
.hm-sw{position:relative;flex:none;width:51px;height:31px;border-radius:16px;background:${TOKENS.on}}
.hm-sw::after{content:'';position:absolute;top:2px;right:2px;width:27px;height:27px;border-radius:50%;background:${TOKENS.knob}}
.hm-sw.off{background:${TOKENS.off}}
.hm-sw.off::after{right:auto;left:2px}
.hm-step{position:relative;flex:none;display:flex;align-items:center;width:94px;height:32px;border-radius:8px;background:${TOKENS.control}}
.hm-step button{width:47px;min-height:44px;margin:-6px 0;padding:0;border:0;background:none;color:${TOKENS.text};display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
.hm-step button:active{opacity:.6}
.hm-step button:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:-2px;border-radius:8px}
.hm-step-div{flex:none;width:1px;height:18px;background:${TOKENS.separator}}
.hm-check{flex:none;display:flex;color:${TOKENS.tint}}
.hm-slr{flex-direction:column;align-items:stretch;justify-content:center;gap:0;padding:8px 14px}
.hm-slr .hm-l1{align-items:center}
.hm-slider{-webkit-appearance:none;appearance:none;width:100%;height:44px;margin:0;background:transparent;accent-color:${TOKENS.tint}}
.hm-slider::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:linear-gradient(to right,${TOKENS.tint} var(--p,0%),${TOKENS.sliderTrack} var(--p,0%))}
.hm-slider::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;margin-top:-9px;border-radius:50%;background:${TOKENS.knob};border:0}
.hm-slider::-moz-range-track{height:6px;border-radius:3px;background:${TOKENS.sliderTrack}}
.hm-slider::-moz-range-progress{height:6px;border-radius:3px;background:${TOKENS.tint}}
.hm-slider::-moz-range-thumb{width:24px;height:24px;border-radius:50%;background:${TOKENS.knob};border:0}
.tabbar-spacer{height:var(--tbh)}
.tabs{--tbh:${TABBAR_H};box-sizing:border-box;height:var(--tbh);padding:0 8px max(34px, env(safe-area-inset-bottom, 0px));display:flex;background:${TOKENS.tabBar};-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-top:.5px solid ${TOKENS.separator}}
.tabs.fixed{position:fixed;left:0;right:0;bottom:0;z-index:100}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:inherit;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;font-size:10px;line-height:12px;font-weight:500;color:${TOKENS.textSecondary};min-height:44px;background:none;border:0;cursor:pointer;padding:0}
.tab[aria-current=page]{color:${TOKENS.tint}}
.tab:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:-2px;border-radius:10px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.chart:focus-visible{outline:2px solid ${TOKENS.link};outline-offset:2px;border-radius:6px}
.tip{position:absolute;top:-36px;left:0;pointer-events:none;background:${TOKENS.control};border:1px solid ${TOKENS.controlEdge};border-radius:8px;padding:4px 8px;font-size:12px;line-height:1.3;white-space:nowrap;z-index:2}
.tip small{display:block;font-size:10px;color:${TOKENS.textSecondary}}
`;


  // ── Room settings ────────────────────────────────────────────────────────────────────────────
  // The Automation list on each room and garden page holds what means "this room should behave differently from
  // now on": automation switches and their tuning, by subsystem. What a person changes because of something
  // happening right now (scenes, lights, the fan on/off, keep-room-occupied) has its own list higher up the page.
  //
  // Rows are either a toggle or a stepper with a fixed min/max/step. A write names a room, group and key from
  // this table, never an entity id, so turn_on/turn_off/set_value can only reach the helpers listed here. A row
  // whose helper is missing or unusable is left out when rendering, and the list is hidden when no row remains.
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

  // ── Room registry: the one hand-written room table ─────────────────────────────────────────
  // One entry per room and garden. `order` is the display order within its kind. `area` is the HA area id
  // whose scenes the card reads from the registry (see sceneRegistry); lights, climate and media are written
  // here because the registry cannot give them (room areas also hold camera switches, fans and LEDs, some lights
  // have no area, and no climate entity has one). `report` means sensor.info_rooms has an entry for the room.
  // Gardens (kind 'garden') have no report, climate or lights here: their lights come from
  // sensor.<garden>_lighting_scenes and their look from `theme`, the theme helper ('' when the garden has none).
  // `settings` are the Automation list's rows (the header above says what belongs there). Gap, reported rather than
  // guessed: foreign_office has no media player in views/foreign-office.yaml. Room keys must match the
  // `room-<key>` views and sensor.info_rooms (a test holds all three together).
  const SCENE_LABELS = {
    off: 'Off', all: 'All', all_full: 'Full', full: 'Full', lamps: 'Lamps', dining: 'Dining',
    cabinets: 'Cabinets', low: 'Low', daylight: 'Daylight', autumn: 'Autumn', halloween: 'Halloween',
  };

  const ROOM_TABLE = [
    {
      key: 'parlour', kind: 'room', order: 1, area: 'parlour',
      name: 'Parlour', short: 'Parlour', report: true,
      climate: 'climate.parlour_trv', temp: 'sensor.parlour_sensor_climate_temperature', hum: 'sensor.parlour_sensor_climate_humidity', lux: 'sensor.parlour_sensor_motion_illuminance',
      heatMode: 'input_select.parlour_heating_manual_mode',
      lights: [
        ['light.parlour_light_floor_lamp', 'Floor lamp'], ['light.parlour_light_ceiling_sofa', 'Sofa ceiling'],
        ['light.parlour_light_ceiling_dining', 'Dining ceiling'], ['switch.parlour_plug_table_lamp', 'Table lamp'],
        ['switch.parlour_plug_donut_lamp', 'Donut lamp'],
      ],
      media: [['media_player.parlour', 'Soundbar', 'player'], ['media_player.parlour_tv', 'TV', 'tv']],
      settings: indoor('parlour'),
    },
    {
      key: 'kitchen', kind: 'room', order: 2, area: 'kitchen',
      name: 'Kitchen', short: 'Kitchen', report: true,
      climate: 'climate.kitchen_trv', temp: 'sensor.kitchen_sensor_climate_temperature', hum: 'sensor.kitchen_sensor_climate_humidity', lux: 'sensor.kitchen_sensor_motion_illuminance',
      heatMode: 'input_select.kitchen_heating_manual_mode',
      lights: [['light.kitchen_light_ceiling', 'Ceiling'], ['light.kitchen_light_cooker', 'Cooker'], ['switch.kitchen_light_cabinets', 'Cabinets']],
      media: [['media_player.kitchen', 'Kitchen speaker', 'player']],
      settings: indoor('kitchen', sonosGroup('kitchen')),
    },
    {
      key: 'hallway_downstairs', kind: 'room', order: 3, area: 'hallway_downstairs',
      name: 'Hallway downstairs', short: 'Hallway down', report: true,
      climate: 'climate.hallway_downstairs_trv', temp: 'sensor.hallway_downstairs_sensor_climate_temperature', hum: 'sensor.hallway_downstairs_sensor_climate_humidity', lux: 'sensor.hallway_downstairs_sensor_motion_illuminance',
      heatMode: 'input_select.hallway_downstairs_heating_manual_mode',
      lights: [['light.hallway_downstairs_light_ceiling', 'Ceiling']],
      media: [],
      settings: indoor('hallway_downstairs'),
    },
    {
      key: 'hallway_upstairs', kind: 'room', order: 4, area: 'hallway_upstairs',
      name: 'Hallway upstairs', short: 'Hallway up', report: true,
      climate: '', temp: '', hum: '', lux: 'sensor.hallway_upstairs_sensor_motion_illuminance',
      lights: [['light.hallway_upstairs_light_ceiling', 'Ceiling']],
      media: [],
      settings: [lightsGroup('hallway_upstairs', []), presenceGroup('hallway_upstairs')], // no heating automation or helper here
    },
    {
      key: 'bedroom', kind: 'room', order: 5, area: 'bedroom',
      name: 'Bedroom', short: 'Bedroom', report: true,
      climate: 'climate.bedroom_trv', temp: 'sensor.bedroom_sensor_climate_temperature', hum: 'sensor.bedroom_sensor_climate_humidity', lux: 'sensor.bedroom_sensor_motion_illuminance',
      heatMode: 'input_select.bedroom_heating_manual_mode',
      lights: [['light.bedroom_light_sarah_lamp', "Sarah's lamp"], ['light.bedroom_light_adam_lamp', "Adam's lamp"], ['light.bedroom_light_ceiling', 'Ceiling']],
      media: [],
      settings: indoor('bedroom'),
    },
    {
      key: 'bathroom', kind: 'room', order: 6, area: 'bathroom',
      name: 'Bathroom', short: 'Bathroom', report: true,
      climate: 'climate.bathroom_trv', temp: 'sensor.bathroom_sensor_climate_temperature', hum: 'sensor.bathroom_sensor_climate_humidity', lux: 'sensor.bathroom_sensor_motion_illuminance',
      heatMode: 'input_select.bathroom_heating_manual_mode',
      lights: [['light.bathroom_light_ceiling', 'Ceiling']],
      media: [],
      settings: [
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
    },
    {
      key: 'home_office', kind: 'room', order: 7, area: 'home_office',
      name: 'Home office', short: 'Home office', report: true,
      climate: 'climate.home_office_trv', temp: 'sensor.home_office_sensor_climate_temperature', hum: 'sensor.home_office_sensor_climate_humidity', lux: 'sensor.home_office_sensor_motion_illuminance',
      heatMode: 'input_select.home_office_heating_manual_mode',
      lights: [['light.home_office_light_desk_lamp', 'Desk lamp'], ['light.home_office_light_floor_lamp', 'Floor lamp'], ['light.home_office_light_ceiling', 'Ceiling']],
      media: [['media_player.home_office', 'Office speaker', 'player']],
      settings: indoor('home_office', sonosGroup('home_office')),
    },
    {
      key: 'foreign_office', kind: 'room', order: 8, area: 'foreign_office',
      name: 'Foreign office', short: 'Foreign office', report: true,
      climate: 'climate.foreign_office', temp: 'sensor.foreign_office_sensor_climate_temperature', hum: 'sensor.foreign_office_sensor_climate_humidity', lux: 'sensor.foreign_office_sensor_motion_illuminance',
      heatMode: 'input_select.foreign_office_heating_manual_mode',
      lights: [['light.dig_uno_v3', 'Lights']],
      media: [],
      settings: [
        lightsGroup('foreign_office', []),
        heatingGroup('foreign_office', [
          stepRow('door_delta', `${DOOR}_open_delta`, 'Door open delta', 'Suggest opening the door when outside is this much cooler than the room', 0.5, 10, 0.5, '°'),
          stepRow('door_min_outdoor', `${DOOR}_open_min_outdoor`, 'Door open minimum outdoors', 'No suggestion when outside is colder than this', 0, 20, 0.5, '°'),
          stepRow('door_comfort', `${DOOR}_indoor_comfort_threshold`, 'Door indoor comfort', 'No suggestion until the room is at least this warm', 18, 28, 0.5, '°'),
          stepRow('door_cooldown', `${DOOR}_notification_cooldown_mins`, 'Door alert cooldown', 'Minimum time between door alerts', 15, 240, 15, ' min'),
        ]),
        presenceGroup('foreign_office'),
      ],
    },
    {
      key: 'front_garden', kind: 'garden', order: 1, area: 'front_garden', name: 'Front garden', short: 'Front garden', theme: 'input_select.front_garden_light_theme',
      settings: [{
        key: 'lights', title: 'Lights', rows: [
          toggleRow('automation', 'input_boolean.front_garden_automation_lights_enabled', 'Lights automation', 'On from sunset; off when the house is set to asleep'),
          toggleRow('calendar', 'input_boolean.front_garden_light_theme_calendar_enabled', 'Follow calendar', 'Switches theme on the days it changes'),
        ],
      }],
    },
    {
      key: 'back_garden', kind: 'garden', order: 2, area: 'back_garden', name: 'Back garden', short: 'Back garden', theme: '',
      settings: [{
        key: 'lights', title: 'Lights', rows: [toggleRow('automation', 'input_boolean.back_garden_automation_lights_enabled', 'Lights automation', 'On from sunset; off when the house is set to asleep')],
      }],
    },
  ];

  const ROOMS = Object.fromEntries(ROOM_TABLE.map((r) => [r.key, r]));
  const ROOM_SETTINGS = Object.fromEntries(ROOM_TABLE.map((r) => [r.key, r.settings]));
  const byOrder = (kind) => ROOM_TABLE.filter((r) => r.kind === kind).sort((a, b) => a.order - b.order).map((r) => r.key);
  const ROOM_ORDER = byOrder('room');
  const GARDEN_ORDER = byOrder('garden');
  const isGarden = (key) => Object.prototype.hasOwnProperty.call(ROOMS, key) && ROOMS[key].kind === 'garden';
  // What the shared room code may read from a garden: nothing it would otherwise mistake for a room feature.
  const GARDEN_ROOM_DEFAULTS = { report: false, climate: '', temp: '', hum: '', lux: '', lights: [], media: [], heatMode: undefined };
  const ALL_ROOM_KEYS = ROOM_TABLE.map((r) => r.key);
  // Every room with a climate entity must name its heating-mode helper, and no other room may: a missing name
  // would silently drop the grid, a stray one would offer a write to nothing.
  for (const r of ROOM_TABLE) {
    const want = r.climate ? `input_select.${r.key}_heating_manual_mode` : undefined;
    if (r.heatMode !== want) throw new Error(`pulse-card: room "${r.key}" heatMode must be ${want === undefined ? 'unset (no climate)' : `"${want}"`}, got ${r.heatMode === undefined ? 'nothing' : `"${r.heatMode}"`}`);
  }
  // The helper's options, in segment order. `temp` is the HOUSE_NUMBERS key holding the mode's temperature; auto has none.
  const HEATING_MODES = [
    { option: 'auto', temp: '' },
    { option: 'comfort', temp: 'comfort' },
    { option: 'baseline_day', temp: 'baseline_day' },
    { option: 'baseline_night', temp: 'baseline_night' },
    { option: 'minimum', temp: 'minimum' },
  ];

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

  // ── Render cost ──────────────────────────────────────────────────────────────────────────────
  // `optimise` switches the two caches below off so a test can prove they change nothing on screen.
  let optimise = true;
  function setOptimise(on) {
    if (typeof on !== 'boolean') throw new Error('pulse-card: setOptimise needs a boolean');
    optimise = on;
  }
  // Parsed JSON attributes, kept per state object. HA replaces the state object when anything about the entity
  // changes, so a hit is always current. The raw value is compared as well: it costs nothing and keeps an
  // in-place edit (a test fixture, never HA) from serving a stale parse. Callers must treat the result as read-only.
  const parseCache = new WeakMap();
  function parsedAttr(hass, id, a, parse) {
    const s = stateObj(hass, id);
    if (typeof parse !== 'function') throw new Error('pulse-card: parsedAttr needs a parser');
    if (!s || !isObj(s.attributes)) return parse(undefined);
    const raw = s.attributes[a];
    if (!optimise) return parse(raw);
    let per = parseCache.get(s);
    if (!per) { per = new Map(); parseCache.set(s, per); }
    const hit = per.get(a);
    if (hit && hit.raw === raw) return hit.value;
    const value = parse(raw);
    per.set(a, { raw, value });
    return value;
  }
  // Room models, built at most once per key in a render pass (a page of cards builds the same room many times).
  // Only live while render() runs, and keyed to that pass's hass, so direct callers always get a fresh model.
  let pass = null;
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
    const list = parsedAttr(hass, 'sensor.info_rooms', 'rooms', parseList);
    return list.find((r) => r.k === key) || null;
  }

  function roomModel(hass, key) {
    if (!pass || pass.hass !== hass) return buildRoomModel(hass, key);
    let m = pass.models.get(key);
    if (!m) { m = buildRoomModel(hass, key); pass.models.set(key, m); }
    return m;
  }
  function buildRoomModel(hass, key) {
    const cfg = ROOMS[key];
    if (!cfg) throw new Error(`pulse-card: unknown room "${key}"`);
    const e = roomEntry(hass, key) || {};
    const m = { ...BLANK_ROOM };
    for (const k of Object.keys(BLANK_ROOM)) if (e[k] !== undefined && e[k] !== null) m[k] = e[k];
    m.key = key;
    m.cfg = cfg.kind === 'garden' ? { ...GARDEN_ROOM_DEFAULTS, ...cfg } : cfg;
    // Gardens take their scenes from sensor.<garden>_lighting_scenes, not from tiles.
    m.scenes = cfg.kind === 'garden' ? [] : (sceneRegistry(hass).rooms[key] || { ids: [] }).ids;
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
    const items = parsedAttr(hass, 'sensor.info_attention', 'items', parseList).map((i) => ({
      room: str(i.room), key: str(i.key), kind: str(i.kind), text: str(i.text), nav: str(i.nav),
    }));
    const gaps = unexplainedReasons(hass);
    if (gaps.length) {
      const shown = gaps.slice(0, 3).join(', ') + (gaps.length > 3 ? ` +${gaps.length - 3} more` : '');
      items.push({ room: 'Pulse', key: '', kind: 'unexplained_reason', text: `No wording for ${shown}`, nav: '' });
    }
    const bad = sceneProblems(hass);
    if (bad.length) {
      const shown = bad.slice(0, 2).join('; ') + (bad.length > 2 ? ` +${bad.length - 2} more` : '');
      items.push({ room: 'Pulse', key: '', kind: 'scene_registry', text: `Scene labels need fixing: ${shown}`, nav: '' });
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
      case 'automation_disabled': return 'Automation is off';
      case 'hold_active': return 'Override on';
      case 'motion_disabled': return 'Motion sensor off';
      case 'garden_theme_config': return 'Theme setup';
      case 'unexplained_reason': return 'Reason not worded';
      case 'scene_registry': return 'Scene labels';
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

  // ── Scenes from the HA registry ───────────────────────────────────────────────────────────────
  // A room's scenes are the `scene.*` entities in its area (the entity's own area, else its device's), by label:
  // `scene_order_N` puts the scene in the tile list at position N, `scene_control_off` marks the scene that
  // switches the room off (shown last), and `scene_theme_<theme>` marks a garden's theme look (not a tile); other `scene_control_<name>` labels are the automations' and ignored. The
  // scene id the card shows is the entity id without `scene.<room>_`. Anything under `scene_` that is none of
  // these, a scene whose id does not start with its room key, two scenes at one position, or a room without
  // exactly one off scene is a problem: it is returned, surfaced as an attention item and logged, never skipped.
  // A hass without `entities` (the registry has not arrived) yields nothing and no problems.
  const SCENE_ORDER_LABEL = /^scene_order_([1-9]\d{0,2})$/;
  const SCENE_THEME_LABEL = /^scene_theme_([a-z][a-z0-9_]*)$/;
  const SCENE_OFF_LABEL = 'scene_control_off';
  const SCENE_CONTROL_LABEL = /^scene_control_[a-z][a-z0-9_]*$/;
  const registryCache = new WeakMap();

  function sceneArea(devices, e) {
    const own = e.area_id;
    if (typeof own === 'string' && own) return own;
    const dev = e.device_id && devices ? devices[e.device_id] : null;
    return dev && typeof dev.area_id === 'string' ? dev.area_id : '';
  }

  // Pure: the registry in, `{rooms: {key: {ids, off, themes}}, problems}` out.
  function deriveScenes(entities, devices) {
    const problems = [];
    const rooms = {};
    const byArea = new Map(ROOM_TABLE.map((r) => [r.area, r.key]));
    const found = {};
    for (const key of ALL_ROOM_KEYS) { rooms[key] = { ids: [], off: '', themes: {} }; found[key] = { ordered: [], offs: [] }; }
    for (const [eid, e] of Object.entries(entities)) {
      if (!eid.startsWith('scene.') || !isObj(e)) continue;
      const key = byArea.get(sceneArea(devices, e));
      if (!key) continue;
      const labels = Array.isArray(e.labels) ? e.labels.filter((l) => typeof l === 'string' && l.startsWith('scene_')) : [];
      if (!labels.length) continue;
      const prefix = `scene.${key}_`;
      const id = eid.startsWith(prefix) ? eid.slice(prefix.length) : '';
      if (!/^[a-z0-9_]+$/.test(id)) { problems.push(`${eid} is in ${key} but its id does not start with ${prefix}`); continue; }
      for (const l of labels) {
        const order = SCENE_ORDER_LABEL.exec(l);
        const theme = SCENE_THEME_LABEL.exec(l);
        if (order) found[key].ordered.push({ n: Number(order[1]), id });
        else if (l === SCENE_OFF_LABEL) found[key].offs.push(id);
        else if (theme) rooms[key].themes[theme[1]] = id;
        // Other control labels (scene_control_daylight, ...) belong to the lighting automations; Pulse ignores them.
        else if (SCENE_CONTROL_LABEL.test(l)) continue;
        else problems.push(`${eid} has label "${l}" which is not scene_order_N, scene_control_<name> or scene_theme_<name>`);
      }
    }
    for (const key of ALL_ROOM_KEYS) {
      const { ordered, offs } = found[key];
      if (offs.length !== 1) problems.push(`${key}: expected one scene labelled ${SCENE_OFF_LABEL}, found ${offs.length}`);
      else rooms[key].off = offs[0];
      ordered.sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
      for (let i = 1; i < ordered.length; i += 1) if (ordered[i].n === ordered[i - 1].n) problems.push(`${key}: scenes ${ordered[i - 1].id} and ${ordered[i].id} are both scene_order_${ordered[i].n}`);
      // The off scene is always the last tile, whatever position it carries.
      rooms[key].ids = ordered.map((o) => o.id).filter((id) => id !== rooms[key].off);
      if (rooms[key].off) rooms[key].ids.push(rooms[key].off);
    }
    return { rooms, problems };
  }

  // Memoised on the registry object: HA replaces `hass.entities` when it changes.
  function sceneRegistry(hass) {
    const entities = hass && hass.entities;
    if (!isObj(entities)) return { rooms: {}, problems: [] };
    const devices = isObj(hass.devices) ? hass.devices : null;
    const hit = registryCache.get(entities);
    if (hit && hit.devices === devices) return hit.value;
    const value = deriveScenes(entities, devices);
    registryCache.set(entities, { devices, value });
    return value;
  }

  const loggedProblems = new Set();
  function sceneProblems(hass) {
    const { problems } = sceneRegistry(hass);
    for (const p of problems) {
      if (loggedProblems.has(p) || typeof console === 'undefined') continue;
      loggedProblems.add(p);
      console.error(`pulse-card: scene registry: ${p}`);
    }
    return problems;
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
  const historyCache = new WeakMap();
  function readHistory(hass, entity) {
    const s = stateObj(hass, entity);
    if (!s || s.state === 'unavailable') return { entries: [], note: COPY.feed.historyUnavailable };
    if (!optimise) return parseHistory(s.attributes);
    // Keyed by the state object, and checked against the attributes object and the entries payload it was built from.
    const hit = historyCache.get(s);
    if (hit && hit.attrs === s.attributes && hit.raw === s.attributes.entries) return hit.value;
    const value = parseHistory(s.attributes);
    historyCache.set(s, { attrs: s.attributes, raw: s.attributes && s.attributes.entries, value });
    return value;
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
      // Routine on the House feed, where it would only be noise; a room page still shows it, muted.
      if (withPlace && isGuard(e)) continue;
      const sentence = sentenceFor(e, hass, withPlace ? subjectOf(e.location, e.subsystem) : subsystemOf(e.subsystem).noun);
      const text = withPlace ? placed(e.location, sentence.text, e.subsystem) : sentence.text;
      const last = rows[rows.length - 1];
      if (last && last.text === text && last.tone === sentence.tone && last.subsystem === e.subsystem) last.count += 1;
      else rows.push({ ts: e.ts, text, sentence: sentence.text, named: sentence.named === true, subject: subjectOf(e.location, e.subsystem), tone: sentence.tone, subsystem: e.subsystem, declined: e.outcome === 'declined', count: 1 });
    }
    return { rows, note: history.note };
  }
  // House feed rows say what they are about: a room's short name, or for whole-house entries the subsystem
  // noun ("Energy · Spun 3 Octopus wheels"). The prefix is left off when the sentence already opens with that
  // noun (or its first word: "House mode" under "House set to away"), so nothing reads "Lights · Lights off".
  // The subject of a feed row: a room's short name, or for whole-house entries the subsystem noun.
  function subjectOf(location, subsystem) {
    if (location && location !== 'house') return own(ROOMS, location) ? ROOMS[location].short : capFirst(pretty(location));
    return subsystemOf(subsystem).noun;
  }
  function placed(location, text, subsystem) {
    const subject = subjectOf(location, subsystem);
    if (location && location !== 'house') return `${subject} · ${text}`;
    const first = subject.split(' ')[0].toLowerCase();
    const lead = text.toLowerCase();
    return lead === first || lead.startsWith(first + ' ') ? text : `${subject} · ${text}`;
  }
  function roomActivity(hass, key) {
    return activityOf(hass, readHistory(hass, `sensor.${key}_history`), false);
  }
  function houseActivity(hass) {
    return activityOf(hass, readHistory(hass, 'sensor.house_history'), true);
  }
  // ── Icons ────────────────────────────────────────────────────────────────────────────────────
  const ICON = {
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    sun: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    lamp: 'M8 4h8l2 8H6l2-8zM12 12v7M8 20h8',
    power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    flame: 'M12 3c1 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.5.6-2.6 1.5-3.5C10 9 11 6 12 3z',
    // A flame that fills its 24 box (the small one above is for inline use at 14px); the House heating tile.
    flameFull: 'M12 2.5c.6 3.8 5.6 6.2 5.6 11.8a5.6 5.6 0 0 1-11.2 0c0-2.3 1.1-3.9 2.4-5.1.1 1.7.9 2.7 2 2.9C10.2 8.8 10.9 5.4 12 2.5z',
    person: 'M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 20a7 7 0 0 1 14 0',
    bed: 'M4 20v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M4 16h16M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3',
    back: 'M15 5l-7 7 7 7',
    chev: 'M6 9l6 6 6-6',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    camera: 'M3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM15 10.5l6-3v9l-6-3',
    play: 'M8 5v14l11-7z',
    clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
    snow: 'M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9',
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    hand: 'M8 13V5a1.5 1.5 0 0 1 3 0v6M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 14',
    window: 'M4 4h16v16H4zM12 4v16M4 12h16',
    pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
    leaf: 'M5 19c0-8 5-13 14-14 0 9-5 14-14 14zM5 19l8-8',
    skull: 'M12 3a7 7 0 0 0-7 7c0 2.5 1.2 4 3 5v3h8v-3c1.8-1 3-2.5 3-5a7 7 0 0 0-7-7zM9.5 11h.01M14.5 11h.01M10 18v2M14 18v2',
    tree: 'M12 3l5 7h-3l4 6H6l4-6H7l5-7zM12 16v5',
    droplet: 'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
    speaker: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 7h.01',
    paw: 'M12 12c-3 0-5 2.5-5 5 0 2 1.5 3 3 3 1 0 1.5-.5 2-.5s1 .5 2 .5c1.5 0 3-1 3-3 0-2.5-2-5-5-5zM4 10a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0zM8 5.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0zM13 5.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0zM17 10a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0z',
    laptop: 'M5 6h14v9H5zM2 19h20',
    fan: 'M12 12c0-4 1-7 3.5-7S18 8 12 12zM12 12c4 0 7 1 7 3.5S16 18 12 12zM12 12c0 4-1 7-3.5 7S6 16 12 12zM12 12c-4 0-7-1-7-3.5S8 6 12 12z',
    guest: 'M10 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM3 20a7 7 0 0 1 14 0M19 8v6M16 11h6',
    dot: 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    next: 'M9 5l7 7-7 7',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
    sunset: 'M3 19h18M7 19a5 5 0 0 1 10 0M12 7v3M5.5 11.5l1.4 1.4M18.5 11.5l-1.4 1.4M12 3l-2 2M12 3l2 2',
    bin: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v6M14 11v6',
    // Filled variants for the selected tab; closed shapes, so they take a fill.
    homeFill: 'M12 3L2 12h3v8h5v-5h4v5h5v-8h3z',
  };
  const svg = (path, size, extra) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra || ''}><path d="${path}"/></svg>`;
  // The same glyph as a solid shape (evenodd, so a hole in the path stays a hole).
  const svgFilled = (path, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" fill-rule="evenodd" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  const SCENE_ICON = { off: 'power', lamps: 'lamp', low: 'moon', full: 'sun', all_full: 'sun', daylight: 'sun' };

  // ── Wording ──────────────────────────────────────────────────────────────────────────────────
  // The only place lights are put into words. `badge` is the short form (the scene's label, "On" or "Off"), `clause`
  // the lower-case fragment inside verdictFor's sentence.
  function lightsState(m, scene) {
    if (!(m.lights_on > 0)) return { on: false, badge: 'Off', clause: 'lights off' };
    if (scene && scene !== 'off') return { on: true, badge: sceneLabel(scene), clause: 'lights on' };
    return { on: true, badge: 'On', clause: 'lights on' };
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
  // ── House page: the native list design ──────────────────────────────────────────────────────
  // Every section on the House page is built from the same few parts: a section header, an inset grouped list,
  // and rows (a tile, a title with one subtitle line, an optional trailing value, a chevron). Rows are real links
  // (<a>) wherever they lead somewhere. Glyphs are decoration (aria-hidden); the text carries the meaning.
  const hmTile = (fill, ink, glyph, filled) => `<span class="hm-tile" style="background:${fill};color:${ink}">${filled ? svgFilled(glyph, 18) : svg(glyph, 18)}</span>`;
  // data-* attributes from an object; values are escaped. The dataset is how a tap finds its fixed table entry.
  const dataAttrs = (data) => Object.entries(data).map(([k, x]) => `data-${k}="${esc(x)}"`).join(' ');
  // One list row. `path` makes it a link (with a chevron); `ctl` (attributes, already escaped) makes the whole row
  // a button; without either it is a plain row. `subColour` and `titleColour` are token values (the title is then
  // semibold); `titleValue` is a figure after the title, `value` the trailing figure, `trailing` a control.
  // A row without `tile` leads with its text; `sub` undefined leaves the subtitle line out.
  function hmRow({ tile, title, titleColour, titleValue, sub, subColour, value, path, label, ctl, trailing }) {
    const lead = tile || '';
    const tv = titleValue ? `<span class="hm-tv num">${esc(titleValue)}</span>` : '';
    const subLine = sub === undefined ? '' : `<div class="hm-rs"${subColour ? ` style="color:${subColour}"` : ''}>${esc(sub)}</div>`;
    const text = `<div class="hm-text"><div class="hm-rt"${titleColour ? ` style="color:${titleColour};font-weight:600"` : ''}>${esc(title)}${tv}</div>${subLine}</div>`;
    const val = value ? `<span class="hm-val num">${esc(value)}</span>` : '';
    const end = trailing || '';
    if (ctl) return `<button type="button" class="hm-row hm-btn tap" ${ctl}>${lead}${text}${val}${end}</button>`;
    if (!path) return `<div class="hm-row">${lead}${text}${val}${end}</div>`;
    return `<a class="hm-row tap" data-act="nav" data-path="${esc(path)}"${label ? ` aria-label="${esc(label)}"` : ''}>${lead}${text}${val}${end}<span class="hm-chev">${svg(ICON.next, 14)}</span></a>`;
  }
  const hmList = (rows, plain) => `<div class="hm-list${plain ? ' plain' : ''}">${rows}</div>`;
  // 13px footnotes under a list or grid.
  const hmFeet = (notes) => (notes && notes.length ? `<div class="hm-feet">${notes.map((t) => `<p class="hm-foot">${esc(t)}</p>`).join('')}</div>` : '');
  // A section: header, then the body in an inset grouped list (`plain`: its rows have no leading tile) or, with
  // `bare`, as it is (a grid), then `after` (markup that belongs to the group, already built), then `notes`.
  const hmSection = (title, rows, opts) => `<section class="hm-sec"><div class="hm-h"><h2${opts && opts.colour ? ` style="color:${opts.colour}"` : ''}>${esc(title)}</h2>${opts && opts.trailing ? `<span class="hm-tr">${esc(opts.trailing)}</span>` : ''}</div>${opts && opts.bare ? rows : hmList(rows, opts && opts.plain)}${(opts && opts.after) || ''}${hmFeet(opts && opts.notes)}</section>`;

  // Native-style controls: the one definition every control on the room and garden pages uses.
  // Switch: 51x31, knob 27. It is decoration inside a row button, which carries aria-pressed and the title.
  const hmSwitch = (on) => `<span class="hm-sw${on ? '' : ' off'}" aria-hidden="true"></span>`;
  function hmToggleRow({ title, sub, on, act, data, disabled, tile }) {
    const ctl = `data-act="${act}" ${dataAttrs(data)} aria-pressed="${on}"${disabled ? ' disabled' : ''}`;
    return hmRow({ tile, title, sub, ctl, trailing: hmSwitch(on) });
  }
  // Stepper: a 94x32 pill, "−" | "+" either side of a hairline. The current value is in the row's title. The
  // buttons are 44px tall, taller than the pill, so the target is large and the pill stays slim.
  // `names` are the two buttons' spoken names, "lower" and "higher" unless the value is not a level (a duration is
  // shorter or longer).
  function hmStepper(act, data, label, names = [COPY.common.lower, COPY.common.higher]) {
    const btn = (delta, name, glyph) => `<button type="button" data-act="${act}" ${dataAttrs(data)} data-delta="${delta}" aria-label="${esc(label)} ${name}">${svg(glyph, 16)}</button>`;
    return `<span class="hm-step">${btn(-1, names[0], 'M5 12h14')}<i class="hm-step-div" aria-hidden="true"></i>${btn(1, names[1], 'M12 5v14M5 12h14')}</span>`;
  }
  function hmStepperRow({ title, sub, shown, act, data, names }) {
    return hmRow({ title, sub, titleValue: shown, trailing: hmStepper(act, data, title, names) });
  }
  // Slider row: the label and value above a full-width range (track sliderTrack, fill tint via --p).
  function hmSliderRow({ title, pct, act, data, label }) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    return `<div class="hm-row hm-slr"><div class="hm-l1"><span class="hm-rt">${esc(title)}</span><span class="hm-val num">${p}%</span></div><input type="range" class="hm-slider" min="0" max="100" value="${p}" style="--p:${p}%" data-act="${act}" ${dataAttrs(data)} aria-label="${esc(label)}"></div>`;
  }
  // Disclosure row: the one definition of "a row that opens a list under it", inside the same inset list.
  // A real button (>= 60px tall) with aria-expanded and aria-controls; the trailing summary is textSecondary
  // unless `tone` is a token colour; the chevron turns 90 degrees when open (CSS, off aria-expanded). The panel
  // is always in the markup, `hidden` while closed, so aria-controls always names an element. State is `open`
  // (see disclosureOpen), never read from the DOM, so a repaint draws the same state with no animation.
  const DISCLOSURE_ID = /^[a-z0-9_]+:[a-z0-9_]+$/;
  function hmDisclosure({ id, title, summary, tone, open, body }) {
    if (!DISCLOSURE_ID.test(id)) throw new Error(`pulse-card: bad disclosure id "${id}"`);
    const panel = `dp-${id.replace(':', '-')}`;
    const sum = summary ? `<span class="hm-val hm-ds"${tone ? ` style="color:${tone}"` : ''}>${esc(summary)}</span>` : '';
    const ctl = `data-act="disclose" data-id="${id}" aria-expanded="${open}" aria-controls="${panel}"`;
    const row = hmRow({ title, ctl, trailing: `${sum}<span class="hm-chev" aria-hidden="true">${svg(ICON.next, 14)}</span>` });
    return `${row}<div class="hm-dp" id="${panel}"${open ? '' : ' hidden'}>${body}</div>`;
  }
  // Open/closed is per-viewer UI state, default closed. The card keeps it in `ui.open` (one object shared by
  // every card on the page, see disclosureStore); a render with no ui draws everything closed.
  const disclosureOpen = (ui, id) => isObj(ui) && isObj(ui.open) && ui.open[id] === true;
  // An inset list holding just a disclosure (no section header: the row is the label).
  const hmDisclosureList = (html) => `<div class="hm"><section class="hm-sec">${hmList(html, true)}</section></div>`;

  // A two-up grid of widget cards; a lone widget spans the row.
  // `sub` is a line or a list of lines (a second line reads better than a middle dot).
  const hmWidget = (label, colour, valueHtml, sub) => `<div class="hm-w"><div class="hm-wl" style="color:${colour}">${esc(label)}</div><div class="hm-wv num">${valueHtml}</div>${[].concat(sub).map((line) => `<div class="hm-ws">${esc(line)}</div>`).join('')}</div>`;
  // A section header on its own, for pages that build the body themselves (a control and a card under it).
  const hmHead = (title) => `<div class="hm-h"><h2>${esc(title)}</h2></div>`;
  // The heading of a tab page (Energy, Cameras, Settings): the large title and a one-line subtitle, no back link
  // because a tab root has nowhere to go back to. Same markup as the room page's title; `line` '' leaves it out.
  const pageHead = (title, line) => `<div class="hm-head"><div class="hm-hd"><h1 class="hm-big">${esc(title)}</h1>${line ? `<span class="hm-line">${esc(line)}</span>` : ''}</div></div>`;

  // Header: the large title, the house mode and occupancy, and who is home.
  function avatar(hass, id, name) {
    const st = state(hass, id);
    const home = st === 'home';
    const status = !usable(st) ? 'unknown' : home ? 'home' : 'away';
    return `<span class="hm-av" role="img" aria-label="${esc(COPY.home.personLabel(name, status))}">${esc(name.charAt(0))}<span class="hm-pd" style="background:${home ? TOKENS.present : TOKENS.presenceAway}"></span></span>`;
  }
  function sectionNowHeader(hass, at) {
    const mode = state(hass, 'sensor.house_active_mode');
    const mod = state(hass, 'input_select.house_active_mode_modifier');
    const modifier = usable(mod) && mod !== 'none' ? (own(MODIFIERS, mod) ? MODIFIERS[mod].label : mod) : '';
    const line = COPY.home.headerLine(houseModeText(mode, hass, at).title, modifier);
    // The Mo line is unchanged in content: the owner is redesigning it separately.
    const ate = moAte(hass, at).replace('yesterday', 'yest');
    return `<div class="hm hm-first"><div class="hm-head"><div class="hm-top"><div class="hm-hd"><h1 class="hm-big">${COPY.home.title}</h1><a class="hm-line tap" data-act="nav" data-path="${SETTINGS_PATH}" aria-label="${COPY.common.openSettings}">${esc(line)}</a></div><div class="hm-avs">${avatar(hass, 'person.adam', 'Adam')}${avatar(hass, 'person.sarah', 'Sarah')}</div></div><div class="hm-mo">${COPY.home.mo}${ate ? ' · ' + esc(ate) : ''}</div></div></div>`;
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

  // Electricity widget: the current price, what is next, a mini chart of the coming slots, and the cheapest
  // two-hour window. The whole card opens the Energy page.
  const MINI_SLOTS = 9;
  const MINI_MIN_H = 4; // px; a zero or negative price still shows as a stub, not nothing
  const MINI_MAX_H = 44;
  // The current half hour and the ones after it, today's list followed by tomorrow's.
  function upcomingSlots(hass, at) {
    const slots = rateBands(ratesOf(hass, 'today'), at).concat(rateBands(ratesOf(hass, 'tomorrow'), at));
    return slots.filter((s) => s.state !== 'past').sort((a, b) => a.start - b.start).slice(0, MINI_SLOTS);
  }
  function miniBars(slots) {
    if (!slots.length) return '';
    const hi = Math.max(...slots.map((s) => s.v));
    // From a zero baseline, so a bar's height is its price against the dearest shown slot: a cheap slot looks cheap
    // instead of being stretched to a dot. When nothing is above zero every bar is the stub.
    const height = (v) => (hi > 0 ? Math.max(MINI_MIN_H, Math.min(MINI_MAX_H, (v / hi) * MINI_MAX_H)) : MINI_MIN_H);
    const bars = slots.map((s) => `<span class="hm-bar${s.state === 'current' ? ' now' : ''}" style="height:${Math.round(height(s.v))}px;background:${priceColour(s.v)}"></span>`).join('');
    return `<div class="hm-bars" aria-hidden="true">${bars}</div>`;
  }
  function cheapestFooter(hass, at) {
    const cw = cheapestWindow(hass, at);
    let right = '';
    if (cw.status === 'running') right = COPY.energy.runningNow(cw.endText ? esc(cw.endText) : '');
    else if (cw.status === 'upcoming') right = COPY.energy.windowOn(cw.dayWord, `${localHm(cw.start)}`, `${localHm(cw.end)}`);
    return right ? `<div class="hm-efoot"><span class="hm-es">${COPY.energy.cheapestHeading}</span><span class="num">${right}</span></div>` : '';
  }
  function electricityWidget(hass, at) {
    const { nowP, nextP, usageText } = priceFigures(hass, at);
    const sub = COPY.energy.nextHalfHour(nextP === null ? '' : `${fmt1(nextP)}p`, usageText === '–' ? '' : usageText);
    return `<a class="hm-card hm-elec tap" data-act="nav" data-path="${ENERGY_PATH}" aria-label="${COPY.common.openEnergy}"><div class="hm-eh">${svgFilled(ICON.bolt, 14)}<span>${COPY.energy.electricity}</span></div><div class="hm-eb"><div class="hm-ep"><div class="hm-price num" style="color:${priceColour(nowP, { text: true })}">${nowP === null ? '–' : fmt1(nowP)}<small>p</small></div>${sub ? `<div class="hm-es">${esc(sub)}</div>` : ''}</div>${miniBars(upcomingSlots(hass, at))}</div>${cheapestFooter(hass, at)}</a>`;
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
  // The tile glyph that suits an item: a window, a thermometer-ish flame for temperature faults, else a warning.
  function attentionGlyph(kind) {
    if (kind === 'window_open_heating_on') return ICON.window;
    if (kind === 'cold_not_heating' || kind === 'warm_heating') return ICON.flame;
    return ICON.warn;
  }

  // Needs attention: only when there is something to say. A missing report is said once, in small print; there is
  // no "all good" state, a calm house shows nothing here.
  function attentionSection(hass) {
    const items = attentionItems(hass);
    if (items.length === 0) return stateObj(hass, 'sensor.info_attention') ? '' : `<p class="hm-foot">${COPY.home.noAttentionReport}</p>`;
    const tile = (glyph) => hmTile(TOKENS.attention, TOKENS.attentionInk, glyph);
    const rows = items.slice(0, STATUS_ROWS).map((i) => {
      const m = ROOMS[i.key] ? roomModel(hass, i.key) : null;
      return hmRow({ tile: tile(attentionGlyph(i.kind)), title: i.room, sub: itemDetail(i, m) || itemLabel(i, m), path: attentionPath(i) });
    });
    if (items.length > STATUS_ROWS) {
      rows.push(hmRow({ tile: '<span class="hm-tile"></span>', title: COPY.home.moreItems(items.length - STATUS_ROWS), sub: '', path: moreAttentionPath(items) }));
    }
    return hmSection(COPY.home.needsAttention, rows.join(''), { colour: TOKENS.attention });
  }
  function sectionStatus(hass, at) {
    return `<div class="hm">${attentionSection(hass)}${electricityWidget(hass, at)}</div>`;
  }

  // ── Rooms and Outside ───────────────────────────────────────────────────────────────────────
  // Occupied rooms first, then the rest, each in the fixed room order. A room that needs attention is listed
  // here too: the attention section above is a summary, not a move.
  function roomOrder(hass) {
    const occupied = occupiedRooms(hass);
    return occupied.concat(ROOM_ORDER.filter((k) => !occupied.includes(k)));
  }
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
  // The room's one plain line, from facts the report already holds: what is holding it (bed, a window), the
  // lights and how recently the house changed them, and a note for rooms with no temperature sensor.
  function roomSubtitle(hass, k, now) {
    const m = roomModel(hass, k);
    if (!m.hasReport) return COPY.home.noReport;
    const lights = lightsState(m, activeScene(hass, k));
    const lightsText = !lights.on ? COPY.home.lightsOff : lights.badge === 'On' ? COPY.home.lightsOn : lights.badge;
    const reason = roomReason(m);
    // Only a scene change is worth a time; "marked occupied", "lights off 7 min ago" and the rest are not.
    const note = recentNote(hass, k, now);
    const line = COPY.home.roomLine(lightsText, reason, /^scene set /.test(note) ? note : '');
    // The missing-sensor note explains the blank value; it only fits when the line has nothing else to say.
    return !m.cfg.climate && !reason && line === lightsText ? `${line} · ${COPY.home.noTemperatureSensor}` : line;
  }
  function roomRow(hass, k, now) {
    const m = roomModel(hass, k);
    const occupied = m.hasReport && m.occupied;
    const tile = occupied ? hmTile(TOKENS.occupied, TOKENS.occupiedInk, ICON.person, true) : hmTile(TOKENS.tileIdle, m.occupancy_unavailable ? TOKENS.attention : TOKENS.textSecondary, ICON.person);
    // No climate sensor: no trailing value at all. A sensor with no reading shows a dash.
    const value = m.cfg.climate ? (m.temp !== null ? `${fmt1(m.temp)}°` : '–') : '';
    return hmRow({ tile, title: m.cfg.name, sub: roomSubtitle(hass, k, now), value, path: roomPath(k) });
  }
  function gardenRow(hass, key, now) {
    const g = gardenModel(hass, key, now);
    const shown = !g.reporting ? '–' : g.on ? COPY.common.on : COPY.common.off;
    return hmRow({ tile: hmTile(TOKENS.outside, TOKENS.outsideInk, ICON.sunset), title: g.name, sub: gardenSub(g, now), value: shown, path: roomPath(key) });
  }
  function sectionRooms(hass, now) {
    const keys = roomOrder(hass);
    const occupied = occupiedRooms(hass).length;
    const rooms = hmSection(COPY.home.rooms, keys.map((k) => roomRow(hass, k, now)).join(''), { trailing: COPY.home.roomsOccupiedCount(occupied) });
    const outside = hmSection(COPY.home.outside, GARDEN_ORDER.map((k) => gardenRow(hass, k, now)).join(''));
    return `<div class="hm">${rooms}${outside}</div>`;
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
    h = ((h % 360) + 360) % 360; // stops may use negative hues to cross red
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
    if (!Number.isFinite(v)) return text ? lift(colour('priceNeutral')) : colour('priceNeutral');
    if (v <= 0) return text ? lift(colour('priceNegative')) : colour('priceNegative');
    if (v >= PRICE_EXTREME_P) return text ? lift(colour('priceExtreme')) : colour('priceExtreme');
    const stops = activeTheme.priceStops.map((x, i) => [PRICE_AT[i], ...x]); // [pence, hue, saturation %, lightness %]
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i += 1) {
      if (v >= stops[i][0] && v <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const t = hi[0] === lo[0] ? 0 : (v - lo[0]) / (hi[0] - lo[0]);
    const mix = (i) => lo[i] + (hi[i] - lo[i]) * t;
    const hex = hslToHex(mix(1), mix(2), mix(3));
    return text ? lift(hex) : hex;
  }
  // Lighten (mix toward white) until the colour reads on the card surface.
  function lift(hex) {
    let out = hex;
    for (let i = 1; i <= 10 && contrast(out, colour('surface')) < 4.5; i += 1) {
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
  // Room above the plot for the scrub tooltip (it sits 36px above the plot): the card's own 16px padding covers
  // the rest, so the tooltip never leaves the card.
  const CHART_TOP = 20;
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
    if (slots.length === 0) return `<div style="font-size:14px;line-height:19px;color:${TOKENS.textSecondary}">${COPY.energy.noPriceToday}</div>`;
    const n = slots.length;
    const lo = Math.min(0, ...slots.map((x) => x.v));
    let hi = Math.max(0, ...slots.map((x) => x.v));
    if (hi - lo < 1) hi = lo + 1;
    const y = (v) => ((hi - v) / (hi - lo)) * (PLOT_H - 2) + 1;
    const y0 = y(0);
    const bars = slots.map((x, i) => {
      const top = Math.min(y(x.v), y0);
      const h = Math.max(1.5, Math.abs(y(x.v) - y0));
      const fill = x.state === 'current' ? colour('text') : priceColour(x.v);
      const op = x.state === 'past' ? 0.45 : 1;
      return `<rect x="${i * SLOT_W}" y="${top.toFixed(1)}" width="${SLOT_W - 1}" height="${h.toFixed(1)}" rx="1" fill="${fill}" opacity="${op}"/>`;
    }).join('');
    const cur = slots.findIndex((x) => x.state === 'current');
    const marker = cur >= 0 ? `<line x1="${cur * SLOT_W + (SLOT_W - 1) / 2}" x2="${cur * SLOT_W + (SLOT_W - 1) / 2}" y1="0" y2="${PLOT_H}" stroke="${colour('text')}" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" opacity=".6"/>` : '';
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
    const key = `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:${TOKENS.textSecondary}" aria-hidden="true"><span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:3px;background:${colour('priceNegative')}"></span>≤0p</span><span style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="height:6px;border-radius:3px;background:linear-gradient(to right,${grad})"></span><span style="display:flex;justify-content:space-between"><span>${PRICE_KEY_P[0]}</span><span>${PRICE_KEY_P[1]}</span><span>${PRICE_KEY_P[2]}</span><span>${PRICE_KEY_P[3]}p+</span></span></span><span style="width:10px;height:10px;border-radius:3px;background:${colour('priceExtreme')}"></span></div>`;
    // The wrapper is the focusable, scrubbable chart (touch-action: pan-y keeps vertical page scroll;
    // horizontal drags scrub). Guide and tooltip are positioned by the element, not re-rendered.
    return `<div class="chart" data-chart data-day="${day === 'tomorrow' ? 'tomorrow' : 'today'}" data-n="${n}" tabindex="0" role="img" aria-label="${esc(label)}" style="position:relative;margin-top:${CHART_TOP}px;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none"><svg viewBox="0 0 ${n * SLOT_W} ${PLOT_H}" preserveAspectRatio="none" width="100%" height="${PLOT_H}" aria-hidden="true" style="display:block">${bars}<line x1="0" x2="${n * SLOT_W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="${colour('textTertiary')}" stroke-width=".8" vector-effect="non-scaling-stroke"/>${marker}</svg>
<span style="position:absolute;left:0;top:${Math.max(0, y0 - 14).toFixed(0)}px;font-size:10px;color:${TOKENS.textSecondary};pointer-events:none">0</span><div data-guide style="display:none;position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:${TOKENS.text};opacity:.7;pointer-events:none"></div><div data-tip class="tip" style="display:none"></div></div><span class="sr" aria-live="polite" data-live></span>
<div style="position:relative;height:14px;font-size:10px;color:${TOKENS.textSecondary};margin-top:4px">${ticks}</div>${key}`;
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

  // A published-cost tile: the fuel, the cost in large type, then the day it covers, the energy used and, when the
  // attributes prove it, what the cost includes, one fact per line.
  function costTile(hass, label, colourToken, costId, kwhId) {
    const a = isObj(stateObj(hass, costId) && stateObj(hass, costId).attributes) ? stateObj(hass, costId).attributes : {};
    const total = usable(state(hass, costId)) ? num(state(hass, costId)) : null;
    const day = coveredDay(a) || COPY.energy.latestCompleteDay;
    const note = standingNote(total, a);
    const kwh = usable(state(hass, kwhId)) ? energyText(state(hass, kwhId), attr(hass, kwhId, 'unit_of_measurement') || 'kWh') : '–';
    const cost = usable(state(hass, costId)) ? money(state(hass, costId), a.unit_of_measurement) : '–';
    return hmWidget(label, colourToken, esc(cost), [day, kwh, note].filter(Boolean));
  }

  // Title, today's live usage as the subtitle (the smart meter, dash when stale so it is left out), then the price
  // now and next as two tiles. Each tile says which half hour it is for.
  function sectionEnergyHead(hass, at) {
    const { nowP, nextP, usageText } = priceFigures(hass, at);
    const current = rateBands(ratesOf(hass, 'today'), at).find((x) => x.state === 'current');
    const tile = (label, p, sub) => hmWidget(label, TOKENS.subEnergy, p === null ? '–' : `<span style="color:${priceColour(p, { text: true })}">${fmt1(p)}</span><small>${COPY.energy.penceUnit}</small>`, sub);
    const tiles = `<div class="hm-wgrid hm-tight">${tile(COPY.energy.now, nowP, current ? COPY.energy.until(localHm(current.end)) : '')}${tile(COPY.energy.next, nextP, current ? COPY.energy.from(localHm(current.end)) : '')}</div>`;
    return `<div class="hm hm-first">${pageHead(COPY.energy.title, usageText === '–' ? '' : COPY.energy.using(usageText))}${tiles}</div>`;
  }

  // Day segmented control, chart, stats and windows for the selected day. They share one element so
  // the selected day survives hass updates (ui.day) and never needs re-rendering mid-scrub.
  function sectionEnergyDay(hass, at, ui) {
    const day = ui && ui.day === 'tomorrow' ? 'tomorrow' : 'today';
    const seg = (id, label) => `<button class="seg${day === id ? ' on' : ''}" data-act="energy-day" data-day="${id}" aria-pressed="${day === id}">${label}</button>`;
    const rates = ratesOf(hass, day);
    const slots = rateBands(rates, at);
    const control = `<div class="segs">${seg('today', COPY.energy.today)}${seg('tomorrow', COPY.energy.tomorrow)}</div>`;
    if (slots.length === 0) {
      const late = day === 'tomorrow';
      const empty = hmList(hmRow({ title: late ? COPY.energy.ratesNotInYet : COPY.energy.noPriceToday, sub: late ? COPY.energy.ratesPublishedLate : COPY.energy.ratesEmpty }), true);
      return `<div class="hm"><section class="hm-sec">${hmHead(COPY.energy.prices)}${control}${empty}</section>${windowsCard(hass, [], at)}</div>`;
    }
    const st = energyStats(slots);
    const stat = (label, p, sub) => hmWidget(label, TOKENS.textSecondary, `<span style="color:${priceColour(p, { text: true })}">${esc(penceText(p))}</span>`, sub);
    const stats = `<div class="hm-wgrid hm-group-row">${stat(COPY.energy.cheapest, st.cheapest.v, COPY.energy.at(st.cheapest.time))}${stat(COPY.energy.dearest, st.dearest.v, COPY.energy.at(st.dearest.time))}${stat(COPY.energy.average, st.avg, COPY.energy.perKwh)}</div>`;
    return `<div class="hm"><section class="hm-sec">${hmHead(COPY.energy.prices)}${control}<div class="hm-card">${priceChart(rates, at, day)}</div>${hmFeet([COPY.energy.dragChart])}${stats}</section>${windowsCard(hass, slots, at)}</div>`;
  }

  // The windows list (no wrapper of its own: it is a section of the Day card). Each row is a name, its range and an
  // average price; "next cheapest" says whether it is running now in its own sub-line.
  function windowsCard(hass, slots, at) {
    const rows = [];
    const cw = cheapestWindow(hass, at);
    if (cw.status === 'running') rows.push(hmRow({ title: COPY.energy.nextCheapest, sub: COPY.energy.runningNow(cw.endText || '') }));
    else if (cw.status === 'upcoming') rows.push(hmRow({ title: COPY.energy.nextCheapest, sub: cw.text, value: cw.avg !== null ? COPY.energy.avg(penceText(cw.avg)) : '' }));
    else rows.push(hmRow({ title: COPY.energy.nextCheapest, sub: COPY.energy.noneUpcoming }));
    if (Array.isArray(slots) && slots.length) {
      for (const [kind, label] of [['negative', COPY.energy.freePower], ['cheap', COPY.energy.cheap]]) {
        const ws = slotWindows(slots, kind);
        if (ws.length === 0) rows.push(hmRow({ title: label, sub: COPY.energy.none }));
        else for (const w of ws) rows.push(hmRow({ title: label, sub: windowRange(w), value: COPY.energy.avg(penceText(w.avg)) }));
      }
    }
    return hmSection(COPY.energy.windows, rows.join(''), { plain: true });
  }

  // Real published data only, always labelled with the day it covers. Octopus publishes a day or two late.
  function sectionEnergyCost(hass) {
    const e = 'sensor.octopus_energy_electricity_24e8140196_1012483035417_previous_accumulative';
    const g = 'sensor.octopus_energy_gas_e6s15257822462_2986733608_previous_accumulative';
    const tiles = `<div class="hm-wgrid">${costTile(hass, COPY.energy.electricity, TOKENS.subEnergy, `${e}_cost`, `${e}_consumption`)}${costTile(hass, COPY.energy.gas, TOKENS.heat, `${g}_cost`, `${g}_consumption_kwh`)}</div>`;
    return `<div class="hm">${hmSection(COPY.energy.costLatest, tiles, { bare: true, notes: [COPY.energy.octopusLate] })}</div>`;
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
      return `<rect x="${i * COL_W + 2}" y="${top.toFixed(1)}" width="${COL_W - 4}" height="${h.toFixed(1)}" rx="2" fill="${colour('link')}" opacity="${latest ? 1 : 0.55}"/>`;
    }).join('');
    const ticks = days.map((d, i) => ((n - 1 - i) % 2 === 0 ? `<span style="position:absolute;left:${(((i + 0.5) / n) * 100).toFixed(2)}%;transform:translateX(-50%);white-space:nowrap">${esc(dayTick(d.date))}</span>` : '')).join('');
    const hiDay = days.reduce((a, d) => (d.cost > a.cost ? d : a), days[0]);
    const loDay = days.reduce((a, d) => (d.cost < a.cost ? d : a), days[0]);
    const lbl = (d) => `${money(d.cost, 'GBP')} on ${isoDayLabel(d.date)}`;
    const label = `${COPY.energy.dailyCostDays(n)}. Highest ${lbl(hiDay)}, lowest ${lbl(loDay)}, latest ${lbl(days[n - 1])}.`;
    return `<div class="chart" data-chart data-kind="cost" data-n="${n}" tabindex="0" role="img" aria-label="${esc(label)}" style="position:relative;margin-top:${CHART_TOP}px;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none"><svg viewBox="0 0 ${n * COL_W} ${PLOT_H}" preserveAspectRatio="none" width="100%" height="${PLOT_H}" aria-hidden="true" style="display:block">${bars}<line x1="0" x2="${n * COL_W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="${colour('textTertiary')}" stroke-width=".8" vector-effect="non-scaling-stroke"/></svg>
<span style="position:absolute;left:0;top:${Math.max(0, y0 - 14).toFixed(0)}px;font-size:10px;color:${TOKENS.textSecondary};pointer-events:none">£0</span><div data-guide style="display:none;position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:${TOKENS.text};opacity:.7;pointer-events:none"></div><div data-tip class="tip" style="display:none"></div></div><span class="sr" aria-live="polite" data-live></span>
<div style="position:relative;height:14px;font-size:10px;color:${TOKENS.textSecondary};margin-top:4px">${ticks}</div>`;
  }

  // Electricity | Gas toggle, bars for up to 14 covered days, readout on scrub, honest loading/unavailable states.
  function sectionEnergyHistory(hass, at, ui) {
    const fuel = ui && ui.fuel === 'gas' ? 'gas' : 'electricity';
    const seg = (id, label) => `<button class="seg${fuel === id ? ' on' : ''}" data-act="cost-fuel" data-fuel="${id}" aria-pressed="${fuel === id}">${label}</button>`;
    const h = ui && isObj(ui.hist) && isObj(ui.hist[fuel]) ? ui.hist[fuel] : { status: 'loading', days: [] };
    const days = Array.isArray(h.days) ? h.days : [];
    const line = (text, strong) => `<div style="font-size:${strong ? 17 : 14}px;line-height:${strong ? 22 : 19}px;${strong ? '' : `color:${TOKENS.textSecondary}`}">${text}</div>`;
    let body;
    let notes = [];
    if (h.status === 'loading') body = line(COPY.energy.loadingHistory);
    else if (h.status !== 'ok' || days.length === 0) body = line(COPY.energy.historyUnavailable, true) + line(COPY.energy.historyUnavailableBody);
    else {
      const id = COST_STAT[fuel];
      const total = usable(state(hass, id)) ? num(state(hass, id)) : null;
      const summary = dailySummary(days, standingNote(total, isObj(stateObj(hass, id)) ? stateObj(hass, id).attributes : {}));
      body = `${costChart(days)}<div style="font-size:14px;line-height:19px;margin-top:8px">${esc(summary)}</div>`;
      notes = [COPY.energy.dragBars, COPY.energy.publishedLate];
    }
    return `<div class="hm"><section class="hm-sec">${hmHead(COPY.energy.dailyCost)}<div class="segs">${seg('electricity', COPY.energy.electricity)}${seg('gas', COPY.energy.gas)}</div><div class="hm-card">${body}</div>${hmFeet(notes)}</section></div>`;
  }

  // Live smart-meter usage: a tile per fuel for today, then for the month (the period is the tile's second line).
  function sectionEnergyUsage(hass) {
    const tile = (label, colourToken, period, id) => {
      const text = usable(state(hass, id)) ? energyText(state(hass, id), attr(hass, id, 'unit_of_measurement')) : '–';
      const [v, u] = text === '–' ? ['–', ''] : text.split(' ');
      return hmWidget(label, colourToken, `${esc(v)}${u ? `<small>${esc(u)}</small>` : ''}`, period);
    };
    const tiles = `<div class="hm-wgrid">${tile(COPY.energy.electricity, TOKENS.subEnergy, COPY.energy.today, 'sensor.glow_electricity_today')}${tile(COPY.energy.gas, TOKENS.heat, COPY.energy.today, 'sensor.glow_gas_today')}${tile(COPY.energy.electricity, TOKENS.subEnergy, COPY.energy.thisMonth, 'sensor.glow_electricity_month')}${tile(COPY.energy.gas, TOKENS.heat, COPY.energy.thisMonth, 'sensor.glow_gas_month')}</div>`;
    return `<div class="hm">${hmSection(COPY.energy.usageLive, tiles, { bare: true, notes: [COPY.energy.meterNote] })}</div>`;
  }

  // House list: Heating, Cameras and Bins as rows. Heating opens Settings, Cameras the Cameras page; Bins has no
  // page to open, so it is a plain row without a chevron.
  const BIN_NAMES = { food: 'Food', paid_garden: 'Garden', recycling: 'Recycling', refuse: 'Refuse' };
  function binsRow(hass) {
    const bins = Object.keys(BIN_NAMES).map((k) => ({ n: BIN_NAMES[k], d: num(state(hass, `sensor.st_albans_collect_domestic_${k}_days_until_collection`)) })).filter((b) => b.d !== null);
    const tile = hmTile(TOKENS.bins, TOKENS.binsInk, ICON.bin);
    if (!bins.length) return hmRow({ tile, title: COPY.home.bins, sub: COPY.home.noCollectionData });
    const next = Math.min(...bins.map((b) => b.d));
    const soon = next <= 1;
    return hmRow({ tile, title: COPY.home.binNames(bins.filter((b) => b.d === next).map((b) => b.n)), sub: COPY.home.collected(next), subColour: soon ? TOKENS.attention : '' });
  }
  function heatingRow(hass) {
    const off = state(hass, 'input_boolean.house_heating_enabled') === 'off';
    const firing = state(hass, 'binary_sensor.house_heating_boiler_firing') === 'on';
    const rooms = heatingRooms(hass).length;
    const inside = num(state(hass, 'sensor.house_average_temperature'));
    const outside = num(attr(hass, 'weather.forecast_home', 'temperature'));
    const patio = state(hass, 'input_boolean.patio_door_heating_suspended') === 'on';
    // The room count means nothing when heating is off or no room is calling for heat.
    const sub = COPY.home.heatingLine(!off && rooms > 0 ? rooms : 0, inside === null ? '' : `${fmt1(inside)}°`, outside === null ? '' : `${fmt1(outside)}°`, patio);
    const title = off ? COPY.home.heatingOff : firing ? COPY.home.boilerFiring : COPY.home.boilerIdle;
    return hmRow({ tile: hmTile(TOKENS.subHeating, TOKENS.subHeatingInk, ICON.flameFull, true), title, sub, path: SETTINGS_PATH, label: COPY.common.openSettings });
  }
  // Nothing when the house has no camera entities at all. An offline camera is an attention matter: the tile and
  // the subtitle say so.
  function camerasRow(hass, now) {
    if (!CAMERAS.some((c) => stateObj(hass, cameraSwitch(c.k)))) return '';
    const sum = camerasSummary(hass, now);
    const warn = sum.offline.length > 0;
    const sub = warn ? COPY.cameras.offline(sum.offline.map((x) => x.c.name).join(' · ')) : camerasReason(sum);
    const tile = warn ? hmTile(TOKENS.attention, TOKENS.attentionInk, ICON.camera) : hmTile(TOKENS.subCameras, TOKENS.subCamerasInk, ICON.camera);
    return hmRow({ tile, title: sum.title, sub, subColour: warn ? TOKENS.attention : '', path: CAMERAS_PATH, label: COPY.common.openCameras });
  }
  function sectionHouseList(hass, now) {
    return `<div class="hm">${hmSection(COPY.home.house, heatingRow(hass) + camerasRow(hass, now) + binsRow(hass))}</div>`;
  }

  // Activity: a timeline. Each day is its own inset container under a small day header; a row is a time, a dot on
  // a rail, and the words on two lines: line 1 the subject in bold and the verb part, line 2 the reason in
  // smaller secondary text (no line 2 when there is no reason).
  // The dot says what kind of entry it is: filled in the subsystem colour for something done, a ring for a rule
  // that chose not to act, filled in the attention colour (with the text) for a run or action that failed.
  const DOT_MIN_CONTRAST = 3; // a subsystem colour that would vanish on the surface falls back to secondary text
  function dotColour(subsystem) {
    const s = subsystemOf(subsystem);
    return s.tile && contrast(colour(s.tile), colour('surface')) >= DOT_MIN_CONTRAST ? TOKENS[s.tile] : TOKENS.textSecondary;
  }
  const REASON_SEP = ' · ';
  // A rule that chose not to act is worded "<what>: <why>" in REASON_TEXT ("Stayed off: bright enough (...)", "Not set
  // to asleep: bed empty"); a rule that acted is worded "<what> · <why>". Every declined sentence has the colon
  // form, so the colon is the split for those, and only those: a failed run ("Couldn't run: ...") is one line.
  const CLAUSE_SEP = ': ';
  // The sentence in two parts at its first " · " (or, with `colon`, its first ": " if that comes earlier): what
  // happened, and why. No separator means all of it is the what.
  function splitSentence(sentence, colon = false) {
    const dot = sentence.indexOf(REASON_SEP);
    const clause = colon ? sentence.indexOf(CLAUSE_SEP) : -1;
    if (clause >= 0 && (dot < 0 || clause < dot)) return { what: sentence.slice(0, clause), why: sentence.slice(clause + CLAUSE_SEP.length) };
    return dot < 0 ? { what: sentence, why: '' } : { what: sentence.slice(0, dot), why: sentence.slice(dot + REASON_SEP.length) };
  }
  // Subject then verb part, read as one phrase: "Parlour" + "Lights off" is "Parlour lights off". A verb part that
  // already opens with the subject's first word ("Cameras on", "House set to away") shares it instead of repeating it.
  const startsWithWord = (text, word) => text.toLowerCase() === word.toLowerCase() || text.toLowerCase().startsWith(word.toLowerCase() + ' ');
  // `named`: the verb part opens with a device's own name, whose case is kept. `noun`/`implied` describe the subsystem.
  function timelineLead(subject, what, opts = {}) {
    const first = subject.split(' ')[0];
    if (startsWithWord(what, first)) return { lead: what.slice(0, first.length), rest: what.slice(first.length) };
    const noun = opts.noun ? opts.noun.split(' ')[0] : '';
    if (opts.implied && noun && startsWithWord(what, noun)) what = what.slice(noun.length).trim();
    return { lead: subject, rest: ' ' + (opts.named || KEEP_CAPITAL.test(what) ? what : lowerFirst(what)) };
  }
  function timelineText(r) {
    const { what, why } = splitSentence(r.sentence, r.tone === 'muted');
    const sub = subsystemOf(r.subsystem);
    const { lead, rest } = timelineLead(r.subject, what, { named: r.named, noun: sub.noun, implied: sub.implied === true });
    const quiet = r.tone === 'warn' ? '' : ` style="color:${TOKENS.textSecondary}"`;
    const count = r.count > 1 ? ` <span class="tl-n">x${r.count}</span>` : '';
    const line1 = `<div class="tl-l1"><b class="tl-s">${esc(lead)}</b>${esc(rest)}${count}</div>`;
    return line1 + (why ? `<div class="tl-l2"${quiet}>${esc(capFirst(why))}</div>` : '');
  }
  function timelineRow(r, time) {
    const kind = r.tone === 'warn' ? 'problem' : r.tone === 'muted' || r.declined ? 'declined' : 'acted';
    const c = dotColour(r.subsystem);
    const dotStyle = kind === 'acted' ? ` style="background:${c}"` : kind === 'declined' ? ` style="border-color:${c}"` : '';
    const text = kind === 'problem' ? TOKENS.attention : kind === 'declined' ? TOKENS.textSecondary : TOKENS.text;
    return `<div class="tl-row ${kind}"><span class="tl-t num">${esc(time)}</span><span class="tl-rail" aria-hidden="true"><i class="tl-dot"${dotStyle}></i></span><div class="tl-b" style="color:${text}">${timelineText(r)}</div></div>`;
  }
  // "Thu 5 Nov" in the HA time zone (the viewer's when HA names none or a bad one).
  function dayParts(ms, tz) {
    const fmt = (zone) => new Intl.DateTimeFormat('en-US', { ...(zone ? { timeZone: zone } : {}), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    let parts;
    try { parts = fmt(tz); } catch (e) { parts = fmt(undefined); }
    const g = (t) => parts.find((x) => x.type === t).value;
    return { date: localDate(ms, tz), label: COPY.feed.day(g('weekday'), g('day'), g('month')), time: `${g('hour')}:${g('minute')}` };
  }
  const prevDate = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  // Rows (newest first) in, day groups out: [{label, rows: [{r, time}]}], the time blank when it repeats the row above.
  function dayGroups(rows, now, tz) {
    const today = localDate(now, tz);
    const yesterday = prevDate(today);
    const groups = [];
    for (const r of rows) {
      const d = dayParts(parseTs(r.ts), tz);
      let g = groups[groups.length - 1];
      if (!g || g.date !== d.date) {
        g = { date: d.date, label: d.date === today ? COPY.feed.today : d.date === yesterday ? COPY.feed.yesterday : d.label, rows: [], last: '' };
        groups.push(g);
      }
      g.rows.push({ r, time: d.time === g.last ? '' : d.time });
      g.last = d.time;
    }
    return groups;
  }
  const quietFeedRow = (msg) => `<div class="hm-row"><div class="hm-text"><div class="hm-rs">${esc(msg)}</div></div></div>`;
  function timelineSection(rows, note, emptyText, now, hass) {
    const tz = hass.config && hass.config.time_zone;
    const days = dayGroups(rows, now, tz).map((g) => `<div class="tl-day"><div class="tl-h">${esc(g.label)}</div><div class="hm-list tl">${g.rows.map((x) => timelineRow(x.r, x.time)).join('')}</div></div>`).join('');
    const quiet = (rows.length ? '' : quietFeedRow(emptyText)) + (note ? quietFeedRow(note) : '');
    return `<div class="hm">${hmSection(COPY.feed.activity, days + (quiet ? hmList(quiet) : ''), { bare: true })}</div>`;
  }
  function sectionFeed(hass, now) {
    const { rows, note } = houseActivity(hass);
    return timelineSection(rows.slice(0, FEED_ROWS), note, COPY.feed.nothingYet, now, hass);
  }

  // ── Top guard ────────────────────────────────────────────────────────────────────────────────
  // Room, garden and tab pages are normal views, so HA's header is not meant to show. Material You hides the app
  // bar by setting ha-menu-button to opacity 0 (--ha-menu-button-opacity) but also gives it pointer-events: all, so
  // on a narrow screen the invisible hamburger sits over the top-left of the page and takes the tap meant for
  // our back link. A control that cannot be seen (opacity 0) has no business taking a tap, so the card switches
  // its pointer events off while the page is shown and puts them back when it leaves (disarm / rearm): the back
  // link then sits at the top of the page like any other content. Anything that would still take a tap (a header
  // that is really showing, or one whose style the card could not change) is measured against the card's tap
  // targets, and the heading cards put an empty row above their content that tall (ui.top). Nothing is
  // hard-coded: the size comes from the browser. It only ever grows, because a scrolled page moves the targets
  // up and would read as "no overlap".
  const TOP_GUARD_MAX = 200; // a header is 56px plus the top safe area; this only stops a bad measurement running away
  const HEAD_MODES = ['now-header', 'energy-head', 'house-head', 'cameras-head', 'room-head'];
  const rectOk = (r) => isObj(r) && ['left', 'top', 'right', 'bottom'].every((k) => Number.isFinite(r[k])) && r.right > r.left && r.bottom > r.top;
  // A header control takes taps unless it, or an ancestor it inherits from, switched them off or removed it.
  function takesTaps(cs) {
    return isObj(cs) && cs.pointerEvents !== 'none' && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }
  // A control the viewer cannot see: fully transparent.
  const invisibleControl = (cs) => isObj(cs) && Number.parseFloat(cs.opacity) === 0;
  // Switch an invisible control's taps off, remembering its own inline value in `saved` (a Map) for rearm. The
  // important flag beats a theme rule that gives it pointer-events: all.
  function disarm(el, saved) {
    if (saved.has(el)) return;
    saved.set(el, { value: el.style.getPropertyValue('pointer-events'), priority: el.style.getPropertyPriority('pointer-events') });
    el.style.setProperty('pointer-events', 'none', 'important');
  }
  function rearm(saved) {
    for (const [el, was] of saved) {
      if (was.value) el.style.setProperty('pointer-events', was.value, was.priority);
      else el.style.removeProperty('pointer-events');
    }
    saved.clear();
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

  // ── Bottom tab bar ─────────────────────────────────────────────────────────────────────────────
  // position:fixed only works if no ancestor creates a containing block for fixed descendants (transform,
  // filter, perspective, contain, will-change, backdrop-filter). tabbarPlacement decides from computed-style
  // snapshots of the ancestors: 'fixed' when none does, otherwise 'inflow' (a normal bar at the end of the
  // page, still usable, never overlapping) and names the offender. The card probes after its first paint and
  // defaults to 'inflow' until the probe says otherwise (fail safe).
  // `fill` names the solid glyph for the selected tab; without one the outline glyph is filled in.
  const TABS = [
    { id: 'house', label: COPY.common.tabHouse, path: HOUSE_PATH, icon: 'home', fill: 'homeFill' },
    { id: 'energy', label: COPY.common.tabEnergy, path: ENERGY_PATH, icon: 'bolt' },
    { id: 'cameras', label: COPY.common.tabCameras, path: CAMERAS_PATH, icon: 'camera' },
    { id: 'settings', label: COPY.common.tabSettings, path: SETTINGS_PATH, icon: 'gear' },
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
    const icon = (t) => (t.id === active ? svgFilled(ICON[t.fill || t.icon], 26) : svg(ICON[t.icon], 26));
    const tabs = TABS.map((t) => `<button type="button" class="tab" data-act="nav" data-path="${t.path}"${t.id === active ? ' aria-current="page"' : ''}>${icon(t)}<span>${t.label}</span></button>`).join('');
    return `${fixed ? `<div class="tabbar-spacer" style="--tbh:${TABBAR_H}" aria-hidden="true"></div>` : ''}<nav class="tabs${fixed ? ' fixed' : ''}" aria-label="${COPY.common.navLabel}">${tabs}</nav>`;
  }

  // ── Room page sections ───────────────────────────────────────────────────────────────────────
  // Every room and garden page is built from the House page's parts (hmRow, hmSection, the native controls above):
  // header, readings, then one titled inset list per subsystem. Whole-page spacing is HM_SECTION_GAP, from `.hm`.

  // Why the controller forced the minimum (heating source "safety"): a window or door held open past its
  // grace period, else house heating switched off. Named for the reader; "safety" is the controller's word.
  function safetyCause(m) {
    if (m.heat_labels.length) return m.heat_labels.join(' · ').toLowerCase();
    return m.house_heating_off ? 'house heating off' : '';
  }

  // The subtitle under the room's name: occupancy and the lights in plain words. Gardens have no occupancy.
  function roomHeadLine(hass, key, now) {
    if (isGarden(key)) {
      const g = gardenModel(hass, key, now);
      return COPY.room.gardenLine(g.reporting, g.on);
    }
    const m = roomModel(hass, key);
    if (!m.hasReport) return COPY.home.noReport;
    const occupancy = m.occupancy_unavailable ? COPY.room.occupancyUnavailable : m.occupied ? COPY.room.occupied : COPY.room.empty;
    const lights = lightsState(m, activeScene(hass, key));
    return COPY.room.headLine(occupancy, lights.on, lights.on && lights.badge !== 'On' ? lights.badge : '');
  }

  // This room's attention items as an inset list right under the header: the short label in the attention colour,
  // the detail beneath. No other banner: what the heating is doing is in the Heating list.
  function roomAttention(hass, key) {
    const m = roomModel(hass, key);
    const rows = attentionItems(hass).filter((i) => i.key === key).map((i) => hmRow({
      tile: hmTile(TOKENS.attention, TOKENS.attentionInk, attentionGlyph(i.kind)), title: itemLabel(i, m), titleColour: TOKENS.attention, sub: itemDetail(i, m),
    }));
    return rows.length ? `<section class="hm-sec hm-tight">${hmList(rows.join(''))}</section>` : '';
  }

  // Back link (tint, 44px target), the large title and the subtitle. Room and garden pages are normal views, so HA
  // draws no header of its own and this is the only one.
  function sectionRoomHead(hass, key, now) {
    const m = roomModel(hass, key);
    const back = `<a class="hm-back tap" data-act="nav" data-path="${HOUSE_PATH}" aria-label="${COPY.common.backToHouse}">${svg(ICON.back, 22)}<span>${COPY.common.tabHouse}</span></a>`;
    const title = `<div class="hm-hd"><h1 class="hm-big">${esc(m.cfg.name)}</h1><span class="hm-line">${esc(roomHeadLine(hass, key, now))}</span></div>`;
    return `<div class="hm hm-first"><div class="hm-head">${back}${title}</div>${roomAttention(hass, key)}</div>`;
  }

  // Readings: Temperature and Light level widgets. A room without the sensor has no widget, and a lone widget
  // takes the full row.
  // Sub-line of the Temperature widget, from the valve and the target.
  function temperatureSub(m) {
    const target = m.target === null ? '' : `${fmt1(m.target)}°`;
    if (m.hvac_action === 'heating') return target ? COPY.room.heatingTo(target) : COPY.room.heatingNow;
    if (m.hvac_action === 'off' || (!target && m.hvac_action === 'idle')) return COPY.room.notHeating;
    return target ? COPY.room.targetIs(target) : '';
  }
  // The room's live illuminance sensor against its dark threshold (the entities the lights automation reads). A
  // sensor that is absent from HA has no widget; one that is unavailable, non-numeric or not in lx shows a muted
  // dash rather than a guessed figure. Lux is clamped; "dark" is at or below the threshold, as the automation counts it.
  function luxReading(hass, key) {
    const id = ROOMS[key].lux;
    const s = id ? stateObj(hass, id) : null;
    if (!s) return null;
    const lx = attr(hass, id, 'unit_of_measurement') === 'lx' ? num(s.state) : null;
    if (lx === null) return { text: '–', sub: '' };
    const limit = num(state(hass, `input_number.${key}_automation_lux_threshold_dark`));
    return { text: `${clampInt(lx, 0, LUX_MAX)}`, unit: true, sub: limit === null ? '' : lx <= limit ? COPY.room.luxDark(clampInt(limit, 0, LUX_MAX)) : COPY.room.luxBright(clampInt(limit, 0, LUX_MAX)) };
  }
  function sectionReadings(hass, key) {
    const m = roomModel(hass, key);
    const cards = [];
    if (m.cfg.temp && m.temp !== null) cards.push(hmWidget(COPY.room.temperature, TOKENS.heat, `${fmt1(m.temp)}°`, temperatureSub(m)));
    const lux = luxReading(hass, key);
    if (lux) cards.push(hmWidget(COPY.room.lightLevel, TOKENS.subLighting, lux.unit ? `${lux.text}<small>${COPY.room.luxUnit}</small>` : lux.text, lux.sub));
    return cards.length ? `<div class="hm"><div class="hm-wgrid">${cards.join('')}</div></div>` : '';
  }

  // The lights row of the Lights card: why the lights are as they are, including why they are NOT on. One
  // function, first matching rule wins (the order is the point: a switched-off automation outranks any
  // history, and a hand change outranks an older automated action):
  //   1 automation off · 2 manual change newer than the last automated action · 3 lights off and room empty
  //   4 newest lighting entry is a decline, abort or failure and newer than the last act · 5 the last act.
  // Presence holds keep a room occupied, so no "room empty" event fires and the lights stay as they are until
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
      if (tone === 'warn') return out('problem', `${text}${at(newest.ts)}${tail}`, tone);
      return out('declined', `${COPY.room.declinedLine(text, newest.ts ? hhmm(newest.ts) : '')}${tail}`, tone);
    }
    if (lastActed) return out('acted', `${sentenceFor(lastActed, hass).text}${at(lastActed.ts)}${tail}`, 'ok');
    return out('none', `${h.note ? `Lighting ${h.note.toLowerCase()}` : 'No lighting decision recorded yet'}${tail}`, h.note ? 'warn' : 'muted');
  }

  // How the lights automation stands, as the footnote under the scenes: its mode, then why the lights are as they are.
  // A decline has no footnote: the Light level tile carries the threshold and Activity has the decision, so the
  // caption only repeated them.
  function lightsNote(story) {
    if (story.state === 'declined') return '';
    const lead = { disabled: '', manual: COPY.room.manual, problem: COPY.room.problem, declined: '' }[story.state];
    const tag = lead !== undefined ? lead : story.holds ? COPY.room.hold : COPY.room.auto;
    return [tag, story.why].filter(Boolean).join(' · ');
  }

  // Heating: an inset list of what the card shows, values trailing. The 24 h chart is its own card directly under
  // this one (info_templates.yaml).
  const upperFirst = (t) => str(t).replace(/^./, (c) => c.toUpperCase());
  // Why the target is what it is, as one line. The order of the rules is the point: a window or door held past
  // its grace period (safety), a hold still waiting out the grace (held), a deviation from the mode, the mode.
  function heatingReason(m) {
    const differs = !!m.target_reason;
    // The target itself is the row's trailing figure, so the words carry the mode and where it came from only.
    const plain = [m.mode_name ? upperFirst(m.mode_name) : '', m.heating_source ? `from ${m.heating_source.replace(/_/g, ' ')}` : ''].filter(Boolean).join(', ') || 'No mode reported';
    const safety = !differs && m.heating_source === 'safety';
    const held = !differs && m.heat_labels.length > 0;
    if (differs) return upperFirst(m.target_reason);
    if (safety) {
      const minT = m.mode_target !== null ? m.mode_target : m.target;
      const cause = safetyCause(m);
      const resumes = m.house_heating_off ? 'stays at minimum while house heating is off' : m.heat_labels.length ? 'normal heating resumes when it closes' : '';
      return `Held at ${m.mode_name || 'minimum'}${minT !== null ? ' ' + fmt1(minT) + '°' : ''}${cause ? ' · ' + cause : ''}${resumes ? ' · ' + resumes : ''}`;
    }
    return held ? `${m.heat_labels.join(' · ')} · ${plain}` : plain;
  }
  // The automation's own state when it is not simply running: suspended, waiting out a grace period, or switched off.
  function heatingStateText(m) {
    if (m.target_reason) return '';
    if (m.heating_source === 'safety') return COPY.room.suspended;
    if (m.heat_labels.length > 0) return COPY.room.pending;
    return m.heating_enabled === false ? COPY.room.heatingAutomationOff : '';
  }
  // Why a choice of mode would have no effect, as the footnote that replaces "holds until": the first of the
  // controller's stages 1 to 3 that wins (automation off, safety, house mode), or '' when the choice is live.
  function heatingLock(hass, m) {
    const L = COPY.room.heatingLock;
    if (m.heating_enabled === false) return L.automationOff;
    if (m.heating_source === 'safety' || m.house_heating_off) return m.house_heating_off ? L.houseOff : L.windowOpen;
    if (!m.heating_source.startsWith('house_mode')) return '';
    const houseMode = state(hass, 'sensor.house_active_mode');
    return own({ away: L.away, sleep: L.sleep, vacation: L.vacation }, houseMode) || L.house;
  }
  // The footnote under the control: why a choice is locked, else what the choice does. Auto holds nothing (the day
  // plan's header says what the schedule is doing), so it says only that the schedule is in charge; a fixed mode
  // says its global temperature and when the plan takes back over.
  function heatingNote(hass, chosen, view) {
    if (chosen === 'auto') return COPY.room.heatingModeAuto;
    const mode = HEATING_MODES.find((x) => x.option === chosen);
    const t = num(state(hass, HOUSE_NUMBERS[mode.temp].id));
    const end = view && view.plan.override ? view.plan.override.until : null;
    return COPY.room.heatingModeManual(COPY.room.heatingModes[chosen], t === null ? '' : `${fmt1(t)}°`, end === null ? '' : clockText(zonedClock(end, view.tz).min));
  }
  function modeSegment({ room, mode, on, locked }) {
    return `<button type="button" class="seg${on ? ' on' : ''}" data-act="heating-mode" data-room="${esc(room)}" data-option="${mode.option}" aria-pressed="${on}" aria-label="${esc(COPY.room.heatingModes[mode.option])}"${locked ? ' disabled' : ''}>${esc(COPY.room.heatingModesShort[mode.option])}</button>`;
  }
  // The control: Auto then the four fixed modes in one row. The selected segment is the helper's state; a locked
  // control is disabled and its footnote says why. An unknown helper state selects nothing.
  function heatingControl(hass, m, key, view) {
    const chosen = state(hass, m.cfg.heatMode);
    const known = HEATING_MODES.some((x) => x.option === chosen);
    const lock = known ? heatingLock(hass, m) : COPY.room.heatingModeUnavailable;
    const segs = HEATING_MODES.map((mode) => modeSegment({ room: key, mode, on: mode.option === chosen, locked: lock !== '' })).join('');
    return { html: `<div class="segs five" role="group" aria-label="${esc(COPY.room.heatingModeGroup)}">${segs}</div>`, note: lock || heatingNote(hass, chosen, view) };
  }
  // Writes the helper, refusing what the control would have disabled: a stale tap must not look like it worked.
  function setHeatingMode(hass, key, option) {
    const cfg = own(ROOMS, key);
    if (!cfg || !cfg.heatMode) throw new Error(`pulse-card: room "${key}" has no heating mode helper`);
    if (!HEATING_MODES.some((x) => x.option === option)) throw new Error(`pulse-card: unknown heating mode "${option}"`);
    const lock = heatingLock(hass, roomModel(hass, key));
    if (lock) throw new Error(`pulse-card: heating mode for "${key}" is locked: ${lock}`);
    return callService(hass, 'input_select', 'select_option', { entity_id: cfg.heatMode, option });
  }
  // The rows the control does not repeat: why the target differs from the mode, the safety hold, humidity, and the
  // automation's pending / suspended state.
  function heatingRows(m, heated) {
    const rows = [];
    if (m.target_reason || m.heating_source === 'safety' || m.heat_labels.length) rows.push(hmRow({ title: heatingReason(m), value: m.target === null ? '–' : `${fmt1(m.target)}°` }));
    if (m.target_reason && m.mode_name && m.mode_target !== null) rows.push(hmRow({ title: COPY.room.normalTarget, sub: upperFirst(m.mode_name), value: `${fmt1(m.mode_target)}°` }));
    if (heated) rows.push(heated);
    if (m.humidity !== null) rows.push(hmRow({ title: COPY.room.humidity, value: `${Math.round(m.humidity)}%` }));
    const stateText = heatingStateText(m);
    // "Heating automation is off" is already the control's footnote.
    if (stateText && stateText !== COPY.room.heatingAutomationOff) rows.push(hmRow({ title: COPY.room.status, sub: stateText === COPY.room.pending ? COPY.room.pendingNote : undefined, value: stateText }));
    return rows.join('');
  }
  // ── Day plan ─────────────────────────────────────────────────────────────────────────────────
  // The room's day drawn as a 00:00 to 24:00 strip from sensor.{room}_heating_plan (blocks and what the controller
  // chose, never temperatures: those come from the four global helpers), with the room's temperature and the
  // radiator's heating spans from recorder history laid over it. Times are in HA's time zone.
  const PLAN_W = 326;
  const PLAN_PLOT_H = 110;
  const PLAN_H = 134;
  const DAY_MIN = 1440;
  // Warmer modes draw deeper. Fixed by mode, not by degrees, so a changed global never reorders the picture.
  const PLAN_OPACITY = { minimum: 0.12, baseline_night: 0.22, baseline_day: 0.42, comfort: 0.75 };
  const PLAN_MODES = HEATING_MODES.filter((x) => x.option !== 'auto').map((x) => x.option);
  const PLAN_TEMP_LO = -20; // a room reading outside these is a faulty sensor, not weather
  const PLAN_TEMP_HI = 60;
  const PLAN_MIN_RANGE = 4; // degrees; a flat day still gets a readable scale
  const HEAT_BUCKET_MS = 5 * 60000; // one drawn point per five minutes keeps a day under 300 points
  const HEAT_REFRESH_MS = 5 * 60000;
  const HEAT_RETRY_MS = 5 * 60000;
  const PLAN_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const PLAN_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

  // The wall clock of an instant in an IANA zone (the viewer's zone for a bad name): "YYYY-MM-DD" and minutes since
  // midnight. The hour is read as h23 because some engines print midnight as 24.
  function zonedClock(ms, tz) {
    if (!Number.isFinite(ms)) throw new Error(`pulse-card: zonedClock needs a time, got ${ms}`);
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
    let parts;
    try { parts = new Intl.DateTimeFormat('en-CA', tz ? { ...opts, timeZone: tz } : opts).formatToParts(new Date(ms)); } catch (e) { parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date(ms)); }
    const g = (t) => Number(parts.find((x) => x.type === t).value);
    const p2 = (v) => String(v).padStart(2, '0');
    const min = (g('hour') % 24) * 60 + g('minute');
    return { date: `${g('year')}-${p2(g('month'))}-${p2(g('day'))}`, min, sec: g('second') };
  }
  const clockText = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  // On a clock-change day this is out by the hour that moved; the strip is nominal 24 h anyway.
  const dayStart = (ms, tz) => { const c = zonedClock(ms, tz); return ms - (c.min * 60 + c.sec) * 1000 - (ms % 1000); };
  const planX = (min) => Math.max(0, Math.min(DAY_MIN, min)) / DAY_MIN * PLAN_W;

  // Reads and checks a plan sensor. Returns {ok:true, ...} or {ok:false, why}: `missing` (no sensor, or it is
  // unavailable), `stale` (a well-formed plan for another day), `invalid` (anything that breaks the contract).
  function parsePlan(s, today) {
    if (!isObj(s) || !usable(str(s.state)) || !isObj(s.attributes)) return { ok: false, why: 'missing' };
    const a = s.attributes;
    const bad = { ok: false, why: 'invalid' };
    if (typeof a.date !== 'string' || !PLAN_DATE.test(a.date)) return bad;
    const list = parseList(a.blocks);
    if (list.length === 0 || (Array.isArray(a.blocks) && list.length !== a.blocks.length)) return bad;
    const blocks = [];
    for (const b of list) {
      const from = PLAN_CLOCK.exec(str(b.start));
      const to = PLAN_CLOCK.exec(str(b.end));
      if (!from || !to || !PLAN_MODES.includes(b.mode)) return bad;
      blocks.push({ from: Number(from[1]) * 60 + Number(from[2]), to: Number(to[1]) * 60 + Number(to[2]), mode: b.mode });
    }
    const until = (v) => (v === null || v === undefined ? null : instantMs(v));
    if (!isObj(a.active) || !PLAN_MODES.includes(a.active.mode) || typeof a.active.source !== 'string' || a.active.source === '') return bad;
    const activeUntil = until(a.active.until);
    if (a.active.until !== null && a.active.until !== undefined && activeUntil === null) return bad;
    let override = null;
    if (a.override !== null && a.override !== undefined) {
      const ou = isObj(a.override) ? until(a.override.until) : null;
      if (!isObj(a.override) || !PLAN_MODES.includes(a.override.mode) || ou === null) return bad;
      override = { mode: a.override.mode, until: ou };
    }
    if (a.date !== today) return { ok: false, why: 'stale' };
    return { ok: true, date: a.date, context: str(a.context), blocks, active: { mode: a.active.mode, source: a.active.source, until: activeUntil }, override };
  }

  // Blocks as minute segments of one day, in order. A block that wraps midnight (end <= start) becomes two pieces,
  // one at each end of the strip.
  function planSegments(blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.to > b.from) out.push({ from: b.from, to: b.to, mode: b.mode });
      else {
        out.push({ from: b.from, to: DAY_MIN, mode: b.mode });
        if (b.to > 0) out.push({ from: 0, to: b.to, mode: b.mode });
      }
    }
    return out.sort((x, y) => x.from - y.from);
  }
  const segAt = (segs, min) => segs.find((x) => x.from <= min && min < x.to) || null;

  // Everything the picture and rows need, or {ok:false, why}. The "effective" span is what overrides the plan from
  // now: a manual choice, or a safety or house-mode choice; a schedule choice is the plan itself.
  function dayPlan(hass, key, now) {
    const cfg = own(ROOMS, key);
    if (!cfg || !cfg.climate) return { ok: false, why: 'missing' };
    const tz = hass && hass.config && hass.config.time_zone;
    const clock = zonedClock(now, tz);
    const plan = parsePlan(stateObj(hass, `sensor.${key}_heating_plan`), clock.date);
    if (!plan.ok) return plan;
    const temps = {};
    for (const mode of PLAN_MODES) {
      const t = num(state(hass, HOUSE_NUMBERS[mode].id));
      temps[mode] = t === null ? null : Math.max(PLAN_TEMP_LO, Math.min(PLAN_TEMP_HI, t));
    }
    const used = [...plan.blocks.map((b) => b.mode), plan.active.mode, ...(plan.override ? [plan.override.mode] : [])];
    if (used.some((mode) => temps[mode] === null)) return { ok: false, why: 'invalid' };
    const scheduled = plan.active.source.startsWith('schedule');
    const source = plan.override ? { mode: plan.override.mode, until: plan.override.until } : scheduled ? null : { mode: plan.active.mode, until: plan.active.until };
    let eff = null;
    if (source) {
      const end = source.until === null ? DAY_MIN : (() => { const c = zonedClock(source.until, tz); return c.date === clock.date ? c.min : DAY_MIN; })();
      if (end > clock.min) eff = { mode: source.mode, from: clock.min, to: end, until: source.until, byHand: !!plan.override };
    }
    return { ok: true, plan, temps, tz, nowMin: clock.min, now, midnight: dayStart(now, tz), segs: planSegments(plan.blocks), eff };
  }

  // The next blocks to show, at most two: the plan block that takes over when an override ends, then the plan's
  // own later starts.
  function planNext(view) {
    const out = [];
    const after = view.eff ? view.eff.to : view.nowMin;
    if (view.eff && view.eff.to < DAY_MIN) {
      const seg = segAt(view.segs, view.eff.to);
      if (seg) out.push({ mode: seg.mode, at: view.eff.to, resumes: true });
    }
    for (const seg of view.segs) if (seg.from > after && !out.some((x) => x.at === seg.from)) out.push({ mode: seg.mode, at: seg.from, resumes: false });
    return out.slice(0, 2);
  }

  // The step line of the plan between two minutes, as an SVG path ('' when nothing is planned there).
  function stepPath(view, y, from, to) {
    let d = '';
    let last = null;
    for (const seg of view.segs) {
      const a = Math.max(seg.from, from);
      const b = Math.min(seg.to, to);
      if (b <= a) continue;
      const yy = y(view.temps[seg.mode]).toFixed(1);
      d += last === null || last.to !== a ? `M${planX(a).toFixed(1)} ${yy}` : `V${yy}`;
      d += `H${planX(b).toFixed(1)}`;
      last = { to: b };
    }
    return d;
  }

  // Room history in, drawable data out. Rows come as HA sends them (full or compressed: s / a / lu); a row that
  // cannot be read is dropped, never guessed. Returns {temps:[{min, v}], spans:[[from, to]] | null}.
  function parseHeatHistory(res, cfg, midnight, now) {
    if (!isObj(res)) throw new Error('pulse-card: history response is not an object');
    const rows = (id) => (Array.isArray(res[id]) ? res[id] : []).filter(isObj)
      .map((e) => ({ t: instantMs(e.lu !== undefined ? e.lu : e.last_updated !== undefined ? e.last_updated : e.lc !== undefined ? e.lc : e.last_changed), s: e.s !== undefined ? e.s : e.state, a: isObj(e.a) ? e.a : isObj(e.attributes) ? e.attributes : null }))
      .filter((e) => e.t !== null).sort((x, y) => x.t - y.t);
    const minutes = (t) => (Math.max(midnight, Math.min(now, t)) - midnight) / 60000;
    const buckets = new Map();
    for (const e of rows(cfg.temp)) {
      const v = num(e.s);
      if (v === null || v < PLAN_TEMP_LO || v > PLAN_TEMP_HI || e.t > now) continue;
      buckets.set(Math.floor((Math.max(midnight, e.t) - midnight) / HEAT_BUCKET_MS), { min: minutes(e.t), v });
    }
    const temps = [...buckets.entries()].sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    const climate = rows(cfg.climate);
    if (climate.length === 0) return { temps, spans: null };
    const spans = [];
    let action = '';
    let since = null;
    for (const e of climate) {
      if (e.t > now) break;
      if (e.a && typeof e.a.hvac_action === 'string') action = e.a.hvac_action;
      else if (!usable(str(e.s))) action = '';
      const heating = action === 'heating';
      if (heating && since === null) since = e.t;
      if (!heating && since !== null) { if (minutes(e.t) > minutes(since)) spans.push([minutes(since), minutes(e.t)]); since = null; }
    }
    if (since !== null && minutes(now) > minutes(since)) spans.push([minutes(since), minutes(now)]);
    return { temps, spans };
  }
  function heatRequest(cfg, midnight, now) {
    return {
      type: 'history/history_during_period', start_time: new Date(midnight).toISOString(), end_time: new Date(now).toISOString(), entity_ids: [cfg.temp, cfg.climate],
      include_start_time_state: true, significant_changes_only: false, minimal_response: false, no_attributes: false,
    };
  }

  // Loads the day's history for one room card. At most one request in flight; a refresh no sooner than five minutes
  // after the last success (a failure retries after five), never per hass update; a new local day drops the old
  // data; and a response that arrives after cancel() or a newer request is ignored (the sequence number moved on).
  function makeHeatLoader() {
    const s = { seq: 0, busy: false, at: 0, retryAt: 0, day: '', data: null };
    return {
      get data() { return s.data; },
      cancel() { s.seq += 1; s.busy = false; },
      ensure(hass, key, now, onChange) {
        const cfg = own(ROOMS, key);
        if (!cfg || !cfg.climate || !cfg.temp || !hass || typeof hass.callWS !== 'function') return;
        const tz = hass.config && hass.config.time_zone;
        const day = zonedClock(now, tz).date;
        if (s.day !== day) { s.seq += 1; s.busy = false; s.day = day; s.data = null; s.at = 0; s.retryAt = 0; }
        if (s.busy || now < s.retryAt || (s.at && now - s.at < HEAT_REFRESH_MS)) return;
        s.busy = true;
        const seq = (s.seq += 1);
        const midnight = dayStart(now, tz);
        let call;
        try { call = Promise.resolve(hass.callWS(heatRequest(cfg, midnight, now))); } catch (e) { call = Promise.reject(e); }
        call
          .then((res) => {
            if (seq !== s.seq) return;
            s.data = { day, ...parseHeatHistory(res, cfg, midnight, now) };
            s.at = now;
          })
          .catch((err) => {
            if (seq !== s.seq) return;
            if (typeof console !== 'undefined') console.warn('pulse-card: heating history unavailable', err && err.message ? err.message : err);
            s.retryAt = now + HEAT_RETRY_MS;
          })
          .finally(() => {
            if (seq !== s.seq) return;
            s.busy = false;
            if (typeof onChange === 'function') onChange();
          });
      },
    };
  }

  // The history that belongs to the plan on screen: today's, and drawable.
  function planHistory(ui, view) {
    const d = isObj(ui) ? ui.heatData : null;
    return isObj(d) && d.day === zonedClock(view.now, view.tz).date ? d : null;
  }
  const heatedMinutes = (spans) => Math.round(spans.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0));

  // The picture. Plan areas (not under an override), the future dimmed, the step line (dashed under an override,
  // which is drawn in the tint), the room line to now, the now marker, and the heating bar under the axis.
  function planSvg(view, data, roomTemp) {
    const t = (mode) => view.temps[mode];
    const refs = view.segs.filter((x) => x.mode !== 'minimum').map((x) => t(x.mode));
    const all = (refs.length ? refs : view.segs.map((x) => t(x.mode))).concat(view.eff ? [t(view.eff.mode)] : []);
    const line = data ? data.temps.map((p) => p.v) : [];
    if (roomTemp !== null) line.push(roomTemp);
    const lo = Math.floor(Math.min(...all, ...line) - 2);
    const hi = Math.max(Math.ceil(Math.max(...all, ...line) + 1.5), lo + PLAN_MIN_RANGE);
    // A temperature below the scale (the minimum, usually) sits on the floor; it is clamped, not rescaled.
    const y = (v) => Math.max(0, Math.min(PLAN_PLOT_H, PLAN_PLOT_H - ((v - lo) / (hi - lo)) * PLAN_PLOT_H));
    const heat = colour('heat');
    const tint = colour('tint');
    const text = colour('text');
    const sec = colour('textSecondary');
    const surface = colour('surface');
    const nowX = planX(view.nowMin);
    const area = (from, to, v, fill, op) => {
      if (to <= from) return '';
      const top = Math.min(y(v), PLAN_PLOT_H - 3);
      return `<rect x="${planX(from).toFixed(1)}" y="${top.toFixed(1)}" width="${(planX(to) - planX(from)).toFixed(1)}" height="${(PLAN_PLOT_H - top).toFixed(1)}" fill="${fill}" opacity="${op}"/>`;
    };
    let out = '';
    for (const seg of view.segs) {
      const op = PLAN_OPACITY[seg.mode];
      if (!view.eff) out += area(seg.from, seg.to, t(seg.mode), heat, op);
      else out += area(seg.from, Math.min(seg.to, view.eff.from), t(seg.mode), heat, op) + area(Math.max(seg.from, view.eff.to), seg.to, t(seg.mode), heat, op);
    }
    if (view.eff) out += area(view.eff.from, view.eff.to, t(view.eff.mode), tint, 0.4);
    out += `<rect class="plan-future" x="${nowX.toFixed(1)}" y="0" width="${(PLAN_W - nowX).toFixed(1)}" height="${PLAN_PLOT_H}" fill="${surface}" opacity=".45"/>`;
    const step = (d, attrs) => (d ? `<path d="${d}" fill="none" ${attrs}/>` : '');
    const solid = `stroke="${heat}" stroke-width="2"`;
    if (!view.eff) out += step(stepPath(view, y, 0, DAY_MIN), solid);
    else {
      out += step(stepPath(view, y, 0, view.eff.from), solid);
      out += step(stepPath(view, y, view.eff.from, view.eff.to), `class="plan-replaced" stroke="${heat}" stroke-width="1.5" stroke-dasharray="3 3" opacity=".8"`);
      out += `<path class="plan-override" d="M${planX(view.eff.from).toFixed(1)} ${y(t(view.eff.mode)).toFixed(1)}H${planX(view.eff.to).toFixed(1)}" fill="none" stroke="${tint}" stroke-width="2"/>`;
      out += step(stepPath(view, y, view.eff.to, DAY_MIN), solid);
    }
    const pts = data ? data.temps.filter((p) => p.min < view.nowMin).map((p) => [planX(p.min), y(p.v)]) : [];
    if (roomTemp !== null) pts.push([nowX, y(roomTemp)]);
    if (pts.length >= 2) out += `<path class="plan-room" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${text}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    out += `<path d="M${nowX.toFixed(1)} 0V${PLAN_PLOT_H}" stroke="${text}" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>`;
    if (pts.length) out += `<circle class="plan-dot" cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="4" fill="${text}" stroke="${surface}" stroke-width="2"/>`;
    if (data && data.spans) for (const [a, b] of data.spans) out += `<rect class="plan-heat" x="${planX(a).toFixed(1)}" y="${PLAN_PLOT_H + 4}" width="${Math.max(1.5, planX(b) - planX(a)).toFixed(1)}" height="4" rx="2" fill="${heat}"/>`;
    const label = (x, s, anchor, fill, weight) => `<text x="${x.toFixed(1)}" y="${PLAN_H - 2}" fill="${fill}" font-size="10"${weight ? ` font-weight="${weight}"` : ''} text-anchor="${anchor}">${s}</text>`;
    for (const h of [0, 6, 12, 18]) if (h === 0 || Math.abs(planX(h * 60) - nowX) > 18) out += label(planX(h * 60), String(h).padStart(2, '0'), h === 0 ? 'start' : 'middle', sec);
    out += label(Math.max(10, Math.min(PLAN_W - 10, nowX)), esc(COPY.room.planNow), 'middle', text, 600);
    const endMs = view.eff ? view.eff.until : view.plan.active.until;
    const aria = COPY.room.planLabel(COPY.room.heatingModes[view.plan.active.mode], fmt1(t(view.plan.active.mode)), endMs === null ? '' : clockText(zonedClock(endMs, view.tz).min));
    return `<svg class="plan" viewBox="0 0 ${PLAN_W} ${PLAN_H}" width="100%" role="img" aria-label="${esc(aria)}" style="display:block;margin-top:12px">${out}</svg>`;
  }

  // The card around the picture: the room's temperature, what the room is doing and until when, the picture, then
  // the next blocks as rows with their temperature trailing.
  function planCard(view, m, data, control) {
    const mode = view.plan.active.mode;
    const label = COPY.room.heatingModes[mode];
    const temp = fmt1(view.temps[mode]);
    const endMs = view.eff ? view.eff.until : view.plan.active.until;
    const until = endMs !== null ? clockText(zonedClock(endMs, view.tz).min) : '';
    const radiator = m.hvac_action === 'heating' ? COPY.room.radiatorHeating : m.hvac_action === 'idle' ? COPY.room.radiatorIdle : '';
    const when = !until ? (view.eff ? COPY.room.planHeld : '') : view.eff && view.eff.byHand ? COPY.room.planByHand(until) : COPY.room.planUntil(until);
    const sub = [when, radiator].filter(Boolean).join(' · ');
    const big = m.temp !== null ? `${fmt1(m.temp)}°` : '–';
    const head = `<div class="plan-head"><span class="num plan-big">${esc(big)}</span><span class="plan-mode"><span class="plan-mode-t num"${view.eff ? ` style="color:${TOKENS.tint}"` : ''}>${esc(COPY.room.planMode(label, temp))}</span>${sub ? `<span class="plan-mode-s">${esc(sub)}</span>` : ''}</span></div>`;
    const rows = planNext(view).map((n) => hmRow({ title: COPY.room.heatingModes[n.mode], sub: n.resumes ? COPY.room.planResumes(clockText(n.at)) : COPY.room.planFrom(clockText(n.at)), value: `${fmt1(view.temps[n.mode])}°` })).join('');
    return `<div class="hm-card plan-card">${head}${planSvg(view, data, m.temp)}${control}${rows ? hmList(rows, true) : ''}</div>`;
  }
  const planNote = (why) => own({ missing: COPY.room.planMissing, stale: COPY.room.planStale, invalid: COPY.room.planInvalid }, why) || COPY.room.planInvalid;
  const durationText = (min) => (min >= 60 ? COPY.room.hoursMinutes(Math.floor(min / 60), min % 60) : COPY.room.minutes(min));

  function sectionHeating(hass, key, now, ui) {
    const m = roomModel(hass, key);
    if (!m.hasReport || !m.cfg.climate) return '';
    const view = dayPlan(hass, key, now);
    const data = view.ok ? planHistory(ui, view) : null;
    const ctl = heatingControl(hass, m, key, view.ok ? view : null);
    const rows = heatingRows(m, data && data.spans ? hmRow({ title: COPY.room.heatedToday, value: durationText(heatedMinutes(data.spans)) }) : '');
    const notes = view.ok ? [ctl.note] : [ctl.note, planNote(view.why)];
    // Without a plan the control stands in a card of its own, where the day plan card would have held it.
    const body = (view.ok ? planCard(view, m, data, ctl.html) : `<div class="hm-card">${ctl.html}</div>`) + hmFeet(notes);
    return `<div class="hm">${hmSection(COPY.room.heating, body, { bare: true, after: rows ? `<div class="hm-group-row">${hmList(rows, true)}</div>` : '' })}</div>`;
  }

  // Presence: occupied or empty, what holds the room occupied and what ends it, and "Keep room occupied" (acts now,
  // so it lives here and not in Automation).
  function keepOccupiedRow(hass, key) {
    const id = `input_boolean.${key}_automation_presence_override`;
    const s = state(hass, id);
    if (!usable(s)) return '';
    const on = s === 'on';
    const guest = key === 'home_office' && state(hass, 'input_select.house_active_mode_modifier') === 'guest';
    const sub = on ? (guest ? 'Set by guest mode · lights and heating treat the room as in use' : 'Room held occupied · lights and heating treat it as in use') : COPY.room.keepOccupiedOff;
    return hmToggleRow({ title: COPY.room.keepRoomOccupied, sub, on, act: 'toggle', data: { entity: id } });
  }
  // The trailing value of the Occupied row appears only when something holds the room, so it never reads as a button
  // (an empty value is a quiet row; the subtitle already says there are no holds). Several holds: the first, then "+N".
  function presenceValue(holds, override) {
    if (holds.length) {
      const first = own(COPY.room.holdShort, holds[0]) || holds[0];
      return first + (holds.length > 1 ? COPY.room.holdMore(holds.length - 1) : '');
    }
    return override ? COPY.room.override : '';
  }
  // The Presence group's last row is the Automation disclosure (the switches decide what the room does on its own);
  // a garden has no Presence group, so its Automation card stands alone (sectionAutomation).
  function sectionPresence(hass, key, ui) {
    const m = roomModel(hass, key);
    const keep = keepOccupiedRow(hass, key);
    const automation = automationRow(hass, key, ui);
    // With nothing else to say about presence (no report, no override helper) the row has no group to join.
    if (!m.hasReport && !keep) return automation ? hmDisclosureList(automation) : '';
    let row = '';
    if (m.hasReport) {
      const holds = m.pres_labels;
      const occ = m.occupancy_unavailable ? COPY.room.occupancyUnavailable : m.occupied ? COPY.room.occupied : COPY.room.empty;
      const pres = holds.length ? `${holds.join(' · ')} · empty a few minutes after ${holds.length > 1 ? 'the last one clears' : 'it clears'}` : m.occupied ? COPY.room.emptiesSoon : COPY.room.noHolds;
      const ovr = m.override_text ? ` · ${m.override_text}` : '';
      const noMotion = state(hass, `input_boolean.${key}_sensor_motion_enabled`) === 'off' ? ' · Motion sensor off, so movement is ignored' : '';
      row = hmRow({ title: occ, sub: `${pres}${ovr}${noMotion}`, value: presenceValue(holds, m.override) });
    }
    return `<div class="hm">${hmSection(COPY.room.presence, row + keep + automation, { plain: true })}</div>`;
  }

  // Lights: the scene buttons (found in the HA registry, see sceneRegistry), then one row per light.
  function sceneButton(key, id, active) {
    const on = id === active;
    return `<button type="button" class="hm-scene${on ? ' on' : ''}" data-act="scene" data-entity="scene.${key}_${id}" aria-pressed="${on}">${svg(ICON[SCENE_ICON[id] || 'bulb'], 22)}<span>${esc(sceneLabel(id))}</span></button>`;
  }
  // One light: its name, brightness or state, a switch; a dimmable light that is on has its slider under it.
  function lightRows(hass, id, label) {
    const s = stateObj(hass, id);
    if (!s || !usable(s.state)) return hmRow({ title: label, sub: s ? COPY.common.unavailable : COPY.common.notFound });
    const on = s.state === 'on';
    const modes = attr(hass, id, 'supported_color_modes');
    const dimmable = id.startsWith('light.') && Array.isArray(modes) && modes.some((x) => x !== 'onoff');
    const pct = on ? Math.max(0, Math.min(100, Math.round(((num(attr(hass, id, 'brightness')) || 0) / 255) * 100))) : 0;
    const row = hmToggleRow({ title: label, sub: on ? (dimmable ? `${pct}%` : COPY.common.on) : COPY.common.off, on, act: 'toggle', data: { entity: id } });
    return dimmable && on ? row + hmSliderRow({ title: COPY.room.brightness, pct, act: 'brightness', data: { entity: id }, label: `${label} ${COPY.room.brightness.toLowerCase()}` }) : row;
  }
  // "Individual lights": a disclosure row, "2 of 5 on" or "All off" trailing, the light rows under it when open.
  function individualLights(hass, key, m, ui) {
    const on = m.cfg.lights.filter(([id]) => state(hass, id) === 'on').length;
    const id = `${key}:lights`;
    const body = m.cfg.lights.map(([lid, label]) => lightRows(hass, lid, label)).join('');
    const row = hmDisclosure({ id, title: COPY.room.individualLights, summary: COPY.room.lightsSummary(on, m.cfg.lights.length), open: disclosureOpen(ui, id), body });
    return hmList(row, true);
  }
  // Scenes, with the Individual lights row as part of that group (HM_GROUP_GAP under the grid, inside the section).
  // A room with no scenes gives the row a section of its own, since there is no group to join.
  function sectionLights(hass, key, now, ui) {
    const m = roomModel(hass, key);
    const active = activeScene(hass, key);
    const note = m.hasReport ? lightsNote(lightsStory(hass, key, now)) : '';
    const notes = note ? [note] : [];
    const lights = m.cfg.lights.length ? individualLights(hass, key, m, ui) : '';
    const grid = m.scenes.length ? `<div class="hm-scenes">${m.scenes.map((id) => sceneButton(key, id, active)).join('')}</div>` : '';
    if (grid) return `<div class="hm">${hmSection(COPY.room.scenes, grid, { bare: true, after: lights ? `<div class="hm-group-row">${lights}</div>` : '', notes })}</div>`;
    return lights ? `<div class="hm"><section class="hm-sec">${lights}${hmFeet(notes)}</section></div>` : '';
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
    automation_disabled: ['Fan automation is off', 'any'],
  };
  function deviceReason(reason, isOn) {
    const r = str(reason);
    const hit = DEVICE_REASONS[r];
    if (!hit) return '';
    return hit[1] === 'any' || hit[1] === (isOn ? 'on' : 'off') ? hit[0] : '';
  }

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

  // One setting of the Automation list: a switch row, or a stepper row with its value in the label. A row whose
  // helper cannot be read is left out.
  function settingRowHtml(hass, room, group, row) {
    const data = { room, group, key: row.key };
    if (row.kind === 'toggle') {
      const s = state(hass, row.id);
      return usable(s) ? hmToggleRow({ title: row.title, sub: row.sub, on: s === 'on', act: 'setting-toggle', data }) : '';
    }
    const v = num(state(hass, row.id));
    return v === null ? '' : hmStepperRow({ title: row.title, sub: row.sub, shown: `${row.step < 1 ? v.toFixed(1) : String(Math.round(v))}${row.unit}`, act: 'setting-number', data });
  }
  // Automation: every setting of the room's table (ROOM_TABLE settings, rooms and gardens alike) behind one
  // disclosure row. Collapsed it says "All on" or what is off, in the attention colour; each row explains itself
  // with a subtitle. '' when the room has no readable setting.
  function automationRow(hass, key, ui) {
    const shown = ROOM_SETTINGS[key].flatMap((g) => g.rows.map((r) => ({ r, html: settingRowHtml(hass, key, g.key, r) }))).filter((x) => x.html);
    if (shown.length === 0) return '';
    const off = shown.filter((x) => x.r.kind === 'toggle' && state(hass, x.r.id) !== 'on').map((x) => x.r.title);
    const hasToggle = shown.some((x) => x.r.kind === 'toggle');
    const id = `${key}:automation`;
    return hmDisclosure({
      id, title: COPY.room.automation, summary: off.length ? COPY.room.automationOff(off) : hasToggle ? COPY.room.allOn : '',
      tone: off.length ? TOKENS.attention : '', open: disclosureOpen(ui, id), body: shown.map((x) => x.html).join(''),
    });
  }
  function sectionAutomation(hass, key, ui) {
    const row = automationRow(hass, key, ui);
    return row ? hmDisclosureList(row) : '';
  }

  // The fan (the bathroom page): its switch, with the reason homerun last gave.
  function sectionDevice(hass, config) {
    if (config.entity === '') return '';
    const id = config.entity;
    const label = str(config.label) || COPY.room.fan;
    const s = stateObj(hass, id);
    const body = !s || !usable(s.state)
      ? hmRow({ title: label, sub: s ? COPY.common.unavailable : COPY.common.notFound })
      : hmToggleRow({ title: label, sub: [s.state === 'on' ? COPY.common.on : COPY.common.off, deviceReason(attr(hass, config.decision, 'reason'), s.state === 'on')].filter(Boolean).join(' · '), on: s.state === 'on', act: 'toggle', data: { entity: id } });
    return `<div class="hm">${hmSection(COPY.room.fan, body, { plain: true })}</div>`;
  }

  // A TV's toggle already says on or off, so its description is silent about that: only what is playing or paused
  // is worth a line. Undefined leaves the line out (see hmRow).
  const TV_QUIET = ['on', 'off', 'standby', 'idle'];
  const tvSub = (state, text) => (TV_QUIET.includes(state) ? undefined : text);
  function sectionMedia(hass, key) {
    const m = roomModel(hass, key);
    if (m.cfg.media.length === 0) return '';
    const rows = m.cfg.media.map(([id, label, kind]) => {
      const s = stateObj(hass, id);
      if (!s || !usable(s.state)) return hmRow({ title: label, sub: s ? COPY.common.unavailable : COPY.common.notFound });
      const off = s.state === 'off' || s.state === 'standby';
      const playing = s.state === 'playing';
      const title = str(attr(hass, id, 'media_title'));
      const artist = str(attr(hass, id, 'media_artist'));
      const text = playing ? [title, artist].filter(Boolean).join(' · ') || 'Playing' : s.state === 'paused' ? 'Paused' : off ? 'Off' : s.state === 'idle' ? 'Idle' : s.state;
      if (kind === 'tv') return hmToggleRow({ title: label, sub: tvSub(s.state, text), on: !off, act: 'media-power', data: { entity: id } });
      const vol = num(attr(hass, id, 'volume_level'));
      const play = `<button type="button" class="round${playing ? '' : ' quiet'}" data-act="media-play" data-entity="${esc(id)}" aria-label="${playing ? COPY.common.pause : COPY.common.play}">${svg(playing ? ICON.pause : ICON.play, 20)}</button>`;
      const volume = vol === null ? '' : hmSliderRow({ title: COPY.room.volume, pct: vol * 100, act: 'volume', data: { entity: id }, label: `${label} ${COPY.room.volume.toLowerCase()}` });
      return hmRow({ title: label, sub: text, trailing: play }) + volume;
    }).join('');
    return `<div class="hm">${hmSection(COPY.room.media, rows, { plain: true })}</div>`;
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
    const row = hmToggleRow({ title: COPY.room.lights, sub: gardenSub(g, now), on: g.on, act: 'garden-power', data: { garden: key, want: wantOn ? 'on' : 'off' }, disabled: !g.reporting || !target });
    return `<div class="hm">${hmSection(COPY.room.lights, row, { plain: true })}</div>`;
  }

  // The theme picker: one row per option, a tint checkmark on the chosen one. Where the theme comes from and when it
  // applies are footnotes; "Use calendar" is a last row when the calendar is not in charge.
  function sectionGardenTheme(hass, key, now) {
    const g = gardenModel(hass, key, now);
    if (!g.hasTheme || !g.options.length) return '';
    const rows = g.options.map((o) => {
      const chosen = o === g.theme;
      return hmRow({ title: themeLabel(o), ctl: `data-act="garden-theme" data-garden="${esc(key)}" data-option="${esc(o)}" aria-pressed="${chosen}"`, trailing: chosen ? `<span class="hm-check">${svg(ICON.check, 22)}</span>` : '' });
    });
    // Only when the calendar is not in charge: paused, or a theme picked by hand. Acting needs the toggle's state.
    const follow = !!g.calToday && !!g.calToggle && (g.calToggle === 'off' || g.theme !== g.calToday);
    if (follow) rows.push(hmRow({ title: COPY.room.useCalendar, sub: `Back to ${themeLabel(g.calToday)}, then follow the calendar`, ctl: `data-act="use-calendar" data-garden="${esc(key)}"` }));
    return `<div class="hm">${hmSection(COPY.room.theme, rows.join(''), { plain: true, notes: [themeSource(g), themeApplies(g, now)].filter(Boolean) })}</div>`;
  }

  // ── Settings page ───────────────────────────────────────────────────────────────────────────────
  // The house-wide settings. Writes go to fixed helper ids (never an id read from the page), so the
  // select and number services can only reach these two helpers.
  const HOUSE_MODIFIER = 'input_select.house_active_mode_modifier';
  const HOUSE_VACATION_HOURS = 'input_number.house_automation_vacation_threshold_hours';
  const MODIFIERS = {
    none: { label: 'None', sub: 'The house follows its modes and presence' },
    guest: { label: 'Guest', sub: 'Home office held occupied, its lights stay on while the house is asleep, cameras left alone when away' },
    sitter: { label: 'Sitter', sub: 'The house stays in normal mode while empty, so it never goes to away or holiday' },
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
        const vac = left === null ? '' : left <= 0 ? ' · holiday heating is due' : ` · holiday heating in ${left >= 3600000 ? Math.round(left / 3600000) + ' h' : Math.max(1, Math.round(left / 60000)) + ' min'}`;
        return { title: 'Away', body: `Heating at night baseline · cameras on${vac}` };
      }
      case 'vacation': return { title: 'On holiday', body: 'Heating at minimum' };
      default: return { title: usable(mode) ? mode.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Mode unknown', body: usable(mode) ? '' : 'No house mode is being reported' };
    }
  }

  // Title, the house mode (and modifier) as the subtitle, then what the mode means as a list: one fact per row, the
  // time it began trailing the first.
  function sectionHouseHead(hass, now) {
    const mode = state(hass, 'sensor.house_active_mode');
    const t = houseModeText(mode, hass, now);
    const since = stateObj(hass, 'sensor.house_active_mode') && stateObj(hass, 'sensor.house_active_mode').last_changed;
    const mod = state(hass, HOUSE_MODIFIER);
    const modifier = usable(mod) && mod !== 'none' && own(MODIFIERS, mod) ? MODIFIERS[mod].label : '';
    const parts = t.body ? t.body.split(' · ') : usable(mode) ? [t.title] : [];
    const began = usable(mode) && hhmm(since) ? COPY.settings.since(hhmm(since)) : '';
    const rows = parts.map((part, i) => hmRow({ title: upperFirst(part), value: i === 0 ? began : '' }));
    const list = rows.length ? `<section class="hm-sec hm-tight">${hmList(rows.join(''), true)}</section>` : '';
    return `<div class="hm hm-first">${pageHead(COPY.settings.title, COPY.home.headerLine(t.title, modifier))}${list}</div>`;
  }

  // House mode: the modifier as a segmented control with what it does under it, and the holiday threshold as a stepper row.
  function sectionHouseMode(hass, now) {
    const mod = state(hass, HOUSE_MODIFIER);
    const vac = num(state(hass, HOUSE_VACATION_HOURS));
    const body = [];
    if (usable(mod)) {
      const segs = Object.keys(MODIFIERS).map((k) => `<button class="seg${mod === k ? ' on' : ''}" data-act="house-modifier" data-option="${k}" aria-pressed="${mod === k}">${MODIFIERS[k].label}</button>`).join('');
      body.push(`<div class="segs" role="group" aria-label="${COPY.common.modeModifier}">${segs}</div>${hmFeet([(MODIFIERS[mod] || MODIFIERS.none).sub])}`);
    }
    if (vac !== null) {
      const away = state(hass, 'sensor.house_active_mode') === 'away';
      const row = hmStepperRow({ title: COPY.settings.holidayThreshold, sub: away ? COPY.settings.thresholdAway : COPY.settings.thresholdIdle, shown: `${Math.round(vac)} h`, act: 'house-threshold', data: {}, names: [COPY.common.shorter, COPY.common.longer] });
      body.push(`<div${body.length ? ' class="hm-group-row"' : ''}>${hmList(row, true)}</div>`);
    }
    return body.length ? `<div class="hm"><section class="hm-sec">${hmHead(COPY.settings.houseMode)}${body.join('')}</section></div>` : '';
  }

  // A stepper row driven by a HOUSE_NUMBERS key. `data` is the buttons' dataset, which is how handleAction finds the
  // fixed table entry to write; it never carries the target helper id itself.
  function numberRow(hass, key, sub) {
    const d = HOUSE_NUMBERS[key];
    const v = num(state(hass, d.id));
    if (v === null) return '';
    return hmStepperRow({ title: d.title, sub, shown: `${d.step < 1 ? v.toFixed(1) : String(Math.round(v))}${d.unit}`, act: 'house-number', data: { key } });
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
    const out = [];
    if (usable(master)) {
      const on = master === 'on';
      const firing = state(hass, 'binary_sensor.house_heating_boiler_firing') === 'on';
      const sub = on ? (firing ? COPY.home.boilerFiring : COPY.home.boilerIdle) : COPY.settings.heatingOffNote;
      out.push(hmSection(COPY.settings.heating, hmToggleRow({ title: COPY.settings.centralHeating, sub, on, act: 'toggle', data: { entity: 'input_boolean.house_heating_enabled' } }), { plain: true }));
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
    if (temps) out.push(hmSection(COPY.settings.temperatureModes, temps, { plain: true, notes: [COPY.settings.temperatureModesNote] }));
    if (grace) out.push(hmSection(COPY.settings.safety, grace, { plain: true }));
    return out.length ? `<div class="hm">${out.join('')}</div>` : '';
  }

  // People: who is working from home today, with their avatar (the dot says whether they are home).
  function sectionHousePeople(hass) {
    const rows = [['input_boolean.wfh_adam', 'Adam', 'person.adam'], ['input_boolean.wfh_sarah', 'Sarah', 'person.sarah']].map(([id, name, person]) => {
      const s = state(hass, id);
      if (!usable(s)) return '';
      const where = state(hass, person) === 'home' ? COPY.settings.home : usable(state(hass, person)) ? COPY.settings.away : '';
      return hmToggleRow({ tile: avatar(hass, person, name), title: COPY.settings.workingFromHome(name), sub: COPY.settings.wfhSub(where), on: s === 'on', act: 'toggle', data: { entity: id } });
    }).join('');
    return rows ? `<div class="hm">${hmSection(COPY.settings.people, rows, { plain: true })}</div>` : '';
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
      return `<button class="tog tap" data-act="mo-toggle" data-key="${key}" aria-pressed="${on}"><div><div class="h">${d.title}</div><div class="s">${d.sub}</div></div><span class="sw${on ? '' : ' off'}" role="img" aria-label="${on ? COPY.common.on : COPY.common.off}"></span></button>`;
    }).join('');
    // Left as it was apart from the gap above it, which is the shared section gap so it does not crowd the list above.
    return rows ? `<div class="lbl" style="margin:${HM_TOP_MARGIN} 4px -10px">${COPY.settings.mo}</div><div class="card">${rows}</div>` : '';
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
    if (!usable(s)) return { key: 'offline', word: COPY.cameras.offlineWord, live: false, offline: true, since: ago(sw && sw.last_changed, now) };
    if (s === 'on') return { key: 'private', word: COPY.cameras.privacyOn, live: false, offline: false };
    const person = state(hass, `binary_sensor.${c.k}_person_occupancy`) === 'on';
    return { key: 'live', word: COPY.cameras.live, live: true, offline: false, person };
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
    // `reason` is the short why for the Now card, whose title already says on or off.
    if (mode === 'away') return guest ? { text: 'House is away, but a guest is staying · cameras off', reason: 'Off while a guest is staying', want: all(false) } : { text: 'House is away · cameras on', reason: 'On while the house is away', want: all(true) };
    if (mode === 'sleep') return { text: 'House is asleep · only the kitchen camera is on, for Mo', reason: 'Only the kitchen is on overnight, for Mo', want: all(false, { kitchen: true }) };
    if (mode === 'normal') return { text: 'House is at home · cameras off', reason: "Off while someone's home", want: all(false) };
    return { text: 'Cameras follow the house mode', reason: 'Following the house mode', want: null };
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

  // Why the cameras are as they are, for the Now card (its title says on or off). When someone has flipped one
  // against the house mode, say so and what the mode would normally do.
  function camerasReason(sum) {
    if (!sum.byHand) return sum.rule.reason;
    return `Changed by hand · usually ${sum.rule.reason.replace(/^./, (c) => c.toLowerCase())}`;
  }

  // Title, the camera state as the subtitle, then one list: the master switch (its sub-line says which rule of the
  // house mode applies), and only when true, "Set by hand" and which cameras are offline.
  function sectionCamerasHead(hass, now) {
    const sum = camerasSummary(hass, now);
    const rows = [];
    if (sum.st.some((x) => !x.s.offline)) rows.push(hmToggleRow({ title: COPY.cameras.master, sub: sum.rule.text, on: sum.live.length > 0, act: 'cameras-all', data: {} }));
    if (sum.byHand) rows.push(hmRow({ title: COPY.cameras.byHand, sub: COPY.cameras.usually(lowerFirst(sum.rule.reason)) }));
    if (sum.offline.length) rows.push(hmRow({ title: COPY.cameras.offline(sum.offline.map((x) => x.c.name).join(', ')), titleColour: TOKENS.attention }));
    const list = rows.length ? `<section class="hm-sec hm-tight">${hmList(rows.join(''), true)}</section>` : '';
    return `<div class="hm hm-first">${pageHead(COPY.cameras.title, sum.title)}${list}</div>`;
  }

  // `live` says whether a stream belongs above `rest`. The element draws the stream in a slot of its own that
  // repaints never touch; render() (tests, and any caller without an element) puts a placeholder in instead.
  function cameraParts(hass, camera, now, ui) {
    const c = CAMERAS.find((x) => x.k === camera);
    const st = cameraStatus(hass, c, now);
    const pend = cameraPending(ui, hass, c.k, now);
    const waiting = !!pend && pend.waiting;
    let word = st.word;
    if (waiting) word = pend.want === 'live' ? COPY.cameras.turningOn : COPY.cameras.turningOff;
    else if (pend) word = COPY.cameras.noResponse;
    const person = st.person ? COPY.cameras.personInView : COPY.cameras.noOneInView;
    const sub = st.offline ? (st.since ? COPY.cameras.wentOffline(st.since) : COPY.cameras.offlineWord) : waiting ? COPY.cameras.waiting : pend ? COPY.cameras.didNotChange : st.live ? person : COPY.cameras.cameraIsOff;
    const head = hmRow({ tile: hmTile(TOKENS.subCameras, TOKENS.subCamerasInk, ICON.camera), title: c.name, sub, value: word });
    const toggle = st.offline ? '' : hmToggleRow({ title: COPY.cameras.cameraOn, on: st.live, act: 'camera-toggle', data: { camera: c.k } });
    const pad = st.live ? ptzPad(hass, c) : '';
    return { live: st.live, rest: markPending(`${head}${toggle}${pad}${recordingsBlock(hass, c, now, ui)}`, ui, hass, now) };
  }

  // A camera is one inset list: the picture (natural size, clipped to the list's rounded corners) on top, then its
  // name and state, the switch, pan/tilt and recordings as rows.
  function sectionCamera(hass, camera, now, ui) {
    const parts = cameraParts(hass, camera, now, ui);
    return `<div class="hm"><div class="hm-list">${parts.live ? `<div class="stream" data-stream="${camera}"></div>` : ''}${parts.rest}</div></div>`;
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

  // Recordings: a disclosure row (the shared chevron turns when open), then a row per clip with its thumbnail.
  function recordingsBlock(hass, c, now, ui) {
    const r = camUi(ui).rec[c.k] || { open: false };
    const sub = r.open && r.status === 'ok' ? COPY.cameras.recent(r.items.length) : COPY.cameras.recordingsHint;
    const toggle = hmRow({ title: COPY.cameras.recordings, sub, ctl: `data-act="camera-rec" data-camera="${c.k}" aria-expanded="${!!r.open}"`, trailing: `<span class="hm-chev" aria-hidden="true">${svg(ICON.next, 14)}</span>` });
    if (!r.open) return toggle;
    let body;
    if (r.status === 'loading' || !r.status) body = quietFeedRow(COPY.cameras.loadingRecordings);
    else if (r.status === 'error') body = quietFeedRow(COPY.cameras.recordingsError) + hmRow({ title: COPY.cameras.tryAgain, titleColour: TOKENS.link, ctl: `data-act="camera-rec-refresh" data-camera="${c.k}"` });
    else if (!r.items.length) body = quietFeedRow(COPY.cameras.noRecordings);
    else body = r.items.map((it) => {
      const what = [it.label.replace(/^./, (x) => x.toUpperCase()), it.zones.join(', ')].filter(Boolean).join(', ');
      const thumb = `<img class="hm-thumb" src="/api/frigate/notifications/${encodeURIComponent(it.id)}/snapshot.jpg" alt="" loading="lazy">`;
      return hmRow({ tile: thumb, title: clipWhen(it.start, now), sub: what, ctl: `data-act="camera-clip" data-camera="${c.k}" data-clip="${esc(it.id)}"`, trailing: `<span class="hm-chev" aria-hidden="true">${svg(ICON.play, 18)}</span>` });
    }).join('');
    return `${toggle}<div class="hm-dp">${body}</div>`;
  }

  // Activity: the same timeline as the House page. The page is the room, so rows lead with the subsystem noun.
  function sectionRoomFeed(hass, key, now) {
    const { rows, note } = roomActivity(hass, key);
    return timelineSection(rows.slice(0, ACTIVITY_ROWS).map((r) => ({ ...r, subject: subsystemOf(r.subsystem).noun })), note, COPY.feed.roomNothingYet, now, hass);
  }

  // ── Tap feedback ─────────────────────────────────────────────────────────────────────────────
  // A tap is a request, not a result: a switch can take seconds to report back. So every write marks the tapped
  // element pending (aria-busy, dimmed) at once. The mark clears when a target entity's state, last_changed or
  // last_updated moves, or after PENDING_MS. If the service call is rejected the mark clears and the card shows a
  // short error, so a failure is never swallowed. State lives in `ui` (per card element); the HTML only reads it.
  const PENDING_MS = 8000;
  const ERROR_MS = 6000;

  // ── Haptics ──────────────────────────────────────────────────────────────────────────────────
  // Home Assistant's frontend listens for a composed `haptic` event on window: the companion app plays the
  // native haptic, a browser maps it to navigator.vibrate (iOS Safari has no vibration API, so nothing plays
  // there). The card only has to dispatch it from its host element; it crosses the shadow root on its own.
  const HAPTIC_TYPES = ['success', 'warning', 'failure', 'light', 'medium', 'heavy', 'selection'];
  function haptic(node, type) {
    if (!HAPTIC_TYPES.includes(type)) throw new Error(`pulse-card: unknown haptic "${type}"`);
    if (!node || typeof node.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
    node.dispatchEvent(new CustomEvent('haptic', { detail: type, bubbles: true, composed: true }));
  }
  // Interaction kind -> haptic. A choice among options is a `selection`; a switch, press or slider commit is
  // `light`; `failure` is played when a user action ends in the card's error state. No `success`: the control
  // changing is the confirmation.
  const HAPTICS = {
    scene: 'selection', segmented: 'selection', stepper: 'selection',
    toggle: 'light', press: 'light', media: 'light', slider: 'light',
    error: 'failure',
  };
  // Every data-act the card dispatches -> a HAPTICS kind, or null for "deliberately silent" (navigation and
  // disclosure). A new control must be added here, so it cannot ship without a haptic decision.
  const ACT_HAPTIC = {
    'scene': 'scene', 'heating-mode': 'segmented',
    'energy-day': 'segmented', 'cost-fuel': 'segmented', 'house-modifier': 'segmented', 'garden-theme': 'segmented',
    'house-threshold': 'stepper', 'house-number': 'stepper', 'setting-number': 'stepper',
    'toggle': 'toggle', 'setting-toggle': 'toggle', 'mo-toggle': 'toggle', 'camera-toggle': 'toggle', 'cameras-all': 'toggle',
    'garden-power': 'toggle', 'media-power': 'toggle',
    'camera-ptz': 'press', 'use-calendar': 'press',
    'media-play': 'media',
    'brightness': 'slider', 'volume': 'slider',
    'nav': null, 'disclose': null, 'camera-rec': null, 'camera-rec-refresh': null, 'camera-clip': null,
  };
  // Plays the haptic for a tap on a control, at tap time (the user's input, not the state coming back).
  function tapHaptic(node, act) {
    if (!Object.prototype.hasOwnProperty.call(ACT_HAPTIC, act)) throw new Error(`pulse-card: no haptic decision for "${act}"`);
    const kind = ACT_HAPTIC[act];
    if (kind !== null) haptic(node, HAPTICS[kind]);
  }

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
      case 'heating-mode': return own(ROOMS, ds.room) && ROOMS[ds.room].heatMode ? [ROOMS[ds.room].heatMode] : [];
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
  async function guarded(hass, ui, ds, now, run, node) {
    ui.error = null;
    try {
      await run();
    } catch (err) {
      pendingClear(ui, ds);
      ui.error = { text: `Couldn't reach ${reachName(hass, ds)}`, at: now };
      haptic(node, HAPTICS.error); // here, where the error is set, so a re-render never repeats it
      if (typeof console !== 'undefined') console.warn('pulse-card: write failed', err && err.message ? err.message : err);
    }
  }
  const writeRun = (hass, ui, el, value, now) => () => {
    pendingStart(ui, hass, { ...el.dataset }, now);
    return handleAction(hass, el, value);
  };
  function perform(hass, ui, el, value, now, node) {
    return guarded(hass, ui, { ...el.dataset }, now, writeRun(hass, ui, el, value, now), node);
  }
  const errorBanner = (ui, now) => (isObj(ui) && isObj(ui.error) && Math.max(0, now - ui.error.at) < ERROR_MS
    ? `<div class="err" role="alert">${esc(ui.error.text)}</div>` : '');

  // ── Dispatcher ───────────────────────────────────────────────────────────────────────────────
  const MODES = {
    'now-header': (h, c, n) => sectionNowHeader(h, n),
    status: (h, c, n) => sectionStatus(h, n),
    rooms: (h, c, n) => sectionRooms(h, n),
    'house-list': (h, c, n) => sectionHouseList(h, n),
    'energy-head': (h, c, n) => sectionEnergyHead(h, n),
    'energy-day': (h, c, n, ui) => sectionEnergyDay(h, n, ui),
    'energy-cost': (h) => sectionEnergyCost(h),
    'energy-history': (h, c, n, ui) => sectionEnergyHistory(h, n, ui),
    'energy-usage': (h) => sectionEnergyUsage(h),
    feed: (h, c, n) => sectionFeed(h, n),
    tabbar: (h, c, n, ui) => sectionTabbar(c, ui),
    'room-head': (h, c, n) => sectionRoomHead(h, c.room, n),
    readings: (h, c) => sectionReadings(h, c.room),
    lights: (h, c, n, ui) => sectionLights(h, c.room, n, ui),
    heating: (h, c, n, ui) => sectionHeating(h, c.room, n, ui),
    presence: (h, c, n, ui) => sectionPresence(h, c.room, ui),
    media: (h, c) => sectionMedia(h, c.room),
    device: (h, c) => sectionDevice(h, c),
    automation: (h, c, n, ui) => sectionAutomation(h, c.room, ui),
    'room-feed': (h, c, n) => sectionRoomFeed(h, c.room, n),
    'garden-lights': (h, c, n) => sectionGardenLights(h, c.room, n),
    'garden-theme': (h, c, n) => sectionGardenTheme(h, c.room, n),
    'house-head': (h, c, n) => sectionHouseHead(h, n),
    'house-mode': (h, c, n) => sectionHouseMode(h, n),
    'house-people': (h) => sectionHousePeople(h),
    'house-heating': (h) => sectionHouseHeating(h),
    'house-mo': (h) => sectionHouseMo(h),
    'cameras-head': (h, c, n) => sectionCamerasHead(h, n),
    camera: (h, c, n, ui) => sectionCamera(h, c.camera, n, ui),
  };
  const ROOM_MODES = ['room-head', 'readings', 'lights', 'heating', 'presence', 'media', 'automation', 'room-feed', 'garden-lights', 'garden-theme'];
  // Indoor rooms have scenes, a report and media; gardens have a lights row and a theme. The shared modes
  // (room-head, room-feed) work for both.
  const GARDEN_MODES = ['garden-lights', 'garden-theme'];
  const INDOOR_MODES = ['readings', 'lights', 'heating', 'presence', 'media'];

  function validate(config) {
    if (!isObj(config) || !MODES[config.mode]) throw new Error(`pulse-card: unknown mode "${config && config.mode}"`);
    themeOf(config);
    if (config.mode === 'camera' && !CAMERAS.some((c) => c.k === config.camera)) throw new Error(`pulse-card: mode "camera" needs a known camera, got "${config.camera}"`);
    // Both blank is the shared room template's "this room has no device": render nothing. One blank is a mistake.
    if (config.mode === 'device' && !(config.entity === '' && config.decision === '')) {
      const ok = (v) => typeof v === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(v);
      if (!ok(config.entity) || !ok(config.decision)) throw new Error(`pulse-card: mode "device" needs an entity and a decision sensor, got "${config.entity}" and "${config.decision}"`);
      const domain = config.entity.split('.')[0];
      if (!writeAllowed(domain, 'turn_on', config.entity) || !writeAllowed(domain, 'turn_off', config.entity)) throw new Error(`pulse-card: mode "device" cannot switch "${config.entity}"`);
    }
    if (ROOM_MODES.includes(config.mode) && !(typeof config.room === 'string' && Object.prototype.hasOwnProperty.call(ROOMS, config.room))) throw new Error(`pulse-card: mode "${config.mode}" needs a known room, got "${config.room}"`);
    if (GARDEN_MODES.includes(config.mode) && !isGarden(config.room)) throw new Error(`pulse-card: mode "${config.mode}" is for gardens, got "${config.room}"`);
    if (INDOOR_MODES.includes(config.mode) && isGarden(config.room)) throw new Error(`pulse-card: mode "${config.mode}" is for indoor rooms, got "${config.room}"`);
  }

  function render(mode, config, hass, now, ui) {
    validate({ ...config, mode });
    const at = Number.isFinite(now) ? now : Date.now();
    // One pass, one set of room models; restored in `finally` so a throw cannot leave a stale pass behind.
    const outer = pass;
    const outerTheme = activeTheme;
    useTheme(config);
    pass = optimise ? { hass, models: new Map() } : null;
    try {
      const body = MODES[mode](hass, config || {}, at, ui || {});
      const html = body && HEAD_MODES.includes(mode) ? topGuard(ui) + body : body;
      return html ? `<div class="p">${errorBanner(ui, at)}${markPending(html, ui, hass, at)}</div>` : '';
    } finally {
      pass = outer;
      activeTheme = outerTheme;
    }
  }

  // ── Skipping a render nothing could have changed ─────────────────────────────────────────────
  // A render is a function of: the mode and config, the ui state, `now`, and whatever it reads from hass.
  // Everything read from hass goes through a recording view, so nothing is on a hand list that could drift:
  //   - hass.states[id] (get, `in`): the state object, by identity (HA replaces it on any change);
  //   - listing hass.states: the list of ids, compared in full (a scene appearing must show);
  //   - any other hass property (entities, devices, areas, user, config, themes, locale...): its identity;
  //   - anything stranger (spread, Object.keys(hass), a descriptor lookup on states): not trackable, so the
  //     render is marked opaque and never skipped.
  // The ui state is mutated in place, so it is compared by its JSON text; if that fails, never skip.
  // `now` is covered by a maximum age: relative times ("5 min ago", stale-sensor ages) only change with it.
  // Callers that are not a hass update (taps, timers, the settings sheet, scrubbing) never skip at all.
  const RENDER_MAX_AGE_MS = 15000;
  function trackHass(hass) {
    if (!isObj(hass)) throw new Error('pulse-card: trackHass needs a hass object');
    const deps = { states: new Map(), props: new Map(), keys: null, opaque: false };
    const rawStates = hass.states;
    const statesView = isObj(rawStates) ? new Proxy(rawStates, {
      get(t, k, r) { if (typeof k === 'string') deps.states.set(k, t[k]); return Reflect.get(t, k, r); },
      has(t, k) { if (typeof k === 'string') deps.states.set(k, t[k]); return Reflect.has(t, k); },
      ownKeys(t) { deps.keys = Reflect.ownKeys(t).filter((k) => typeof k === 'string'); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { deps.opaque = deps.opaque || !deps.keys; return Reflect.getOwnPropertyDescriptor(t, k); },
      set() { throw new Error('pulse-card: render must not write hass.states'); },
      deleteProperty() { throw new Error('pulse-card: render must not write hass.states'); },
    }) : rawStates;
    const view = new Proxy(hass, {
      get(t, k, r) {
        if (typeof k !== 'string') return Reflect.get(t, k, r);
        // Not recorded as a property: HA replaces the whole states object on every change; entries are tracked below.
        if (k === 'states') return statesView;
        const v = t[k];
        deps.props.set(k, v);
        return v;
      },
      has() { deps.opaque = true; return true; },
      ownKeys(t) { deps.opaque = true; return Reflect.ownKeys(t); },
      set() { throw new Error('pulse-card: render must not write hass'); },
      deleteProperty() { throw new Error('pulse-card: render must not write hass'); },
    });
    return { view, deps };
  }
  // True when every recorded read would give the same answer against this hass.
  function depsUnchanged(deps, hass) {
    if (!deps || deps.opaque || !isObj(hass)) return false;
    for (const [k, v] of deps.props) if (hass[k] !== v) return false;
    if (deps.states.size === 0 && deps.keys === null) return true;
    const states = hass.states;
    if (!isObj(states)) return false;
    for (const [id, v] of deps.states) if (states[id] !== v) return false;
    if (deps.keys !== null) {
      const now = Object.keys(states);
      if (now.length !== deps.keys.length || now.some((id, i) => id !== deps.keys[i])) return false;
    }
    return true;
  }
  const uiSignature = (ui) => { try { return JSON.stringify(ui === undefined ? null : ui); } catch (e) { return null; } };

  function makeRenderGate(maxAgeMs = RENDER_MAX_AGE_MS) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 60000) throw new Error(`pulse-card: render max age must be 1s to 60s, got ${maxAgeMs}`);
    const stats = { renders: 0, skips: 0 };
    let prev = null;
    return {
      stats,
      // Forget the last render: the next run renders. For setConfig and for mount changes.
      reset() { prev = null; },
      // `force` is for every caller that is not a hass update. Returns {html, skipped}.
      run(mode, config, hass, now, ui, force) {
        const sig = uiSignature(ui);
        const at = Number.isFinite(now) ? now : Date.now();
        if (!force && prev && sig !== null && prev.mode === mode && prev.config === config && prev.sig === sig
          && at >= prev.at && at - prev.at < maxAgeMs && depsUnchanged(prev.deps, hass)) {
          stats.skips += 1;
          return { html: prev.html, skipped: true };
        }
        prev = null; // a throw below must not leave a result that no longer matches
        const { view, deps } = trackHass(hass);
        const html = render(mode, config, view, at, ui);
        stats.renders += 1;
        prev = { mode, config, sig, at, deps, html };
        return { html, skipped: false };
      },
    };
  }

  // ── Service calls ────────────────────────────────────────────────────────────────────────────
  // Write paths: {domain: {service: [entity patterns]}}. A call must name an entity_id that matches one of the
  // patterns of its domain and service; anything else throws. Defined here, after the tables it reads.
  // Exact ids (escaped, anchored) come from the room table, CAMERAS and PTZ_DIRS, never from a hand list.
  // The fan switch is not in the room table (the bathroom view passes it to the device row), so it is named here.
  const exact = (ids) => ids.map((id) => new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const FAN_SWITCHES = ['switch.bathroom_fan_extractor'];
  const roomIds = (domain, field) => ROOM_TABLE.flatMap((r) => (r[field] || []).map((x) => x[0])).filter((id) => id.startsWith(`${domain}.`));
  const SCENE_PATTERN = new RegExp(`^scene\\.(${ALL_ROOM_KEYS.join('|')})_[a-z0-9_]+$`);
  const BOOLEAN_PATTERN = /^input_boolean\.(\w+_automation_(lights|heating|sonos|fan)_enabled|\w+_automation_presence_override|\w+_sensor_motion_enabled|\w+_light_theme_calendar_enabled|wfh_(adam|sarah)|house_heating_enabled|mo_notifications_(spotted|eating)_enabled)$/;
  const NUMBER_PATTERN = /^input_number\.(\w+_automation_(lux_threshold_dark|fan_(min_run|max_run|humidity_margin)|door_\w+|vacation_threshold_hours)|global_temperature_(minimum|baseline_night|baseline_day|comfort)|global_heating_window_open_grace_minutes)$/;
  const SELECT_PATTERN = new RegExp(`^input_select\\.(house_active_mode_modifier|\\w+_light_theme|(${ROOM_TABLE.filter((r) => r.heatMode).map((r) => r.key).join('|')})_heating_manual_mode)$`);
  const lightIds = exact(roomIds('light', 'lights'));
  const mediaIds = exact(roomIds('media_player', 'media'));
  const ALLOWED = {
    scene: { turn_on: [SCENE_PATTERN] },
    light: { turn_on: lightIds, turn_off: lightIds },
    switch: (() => {
      const ids = exact([...roomIds('switch', 'lights'), ...CAMERAS.map((c) => cameraSwitch(c.k)), ...FAN_SWITCHES]);
      return { turn_on: ids, turn_off: ids };
    })(),
    media_player: { media_play_pause: mediaIds, volume_set: mediaIds, turn_on: mediaIds, turn_off: mediaIds },
    button: { press: exact(CAMERAS.flatMap((c) => Object.keys(PTZ_DIRS).map((d) => `button.${c.k}_move_${d}`))) },
    input_boolean: { turn_on: [BOOLEAN_PATTERN], turn_off: [BOOLEAN_PATTERN] },
    input_select: { select_option: [SELECT_PATTERN] },
    input_number: { set_value: [NUMBER_PATTERN] },
  };

  // True when a call to domain.service on this entity is allowed.
  function writeAllowed(domain, service, entity) {
    const patterns = Object.prototype.hasOwnProperty.call(ALLOWED, domain) && Object.prototype.hasOwnProperty.call(ALLOWED[domain], service) ? ALLOWED[domain][service] : null;
    return !!patterns && typeof entity === 'string' && patterns.some((p) => p.test(entity));
  }

  function callService(hass, domain, service, data) {
    const entity = isObj(data) ? data.entity_id : undefined;
    if (!writeAllowed(domain, service, entity)) {
      throw new Error(`pulse-card: ${domain}.${service} on ${typeof entity === 'string' ? `"${entity}"` : 'no entity_id'} is not an allowed write path`);
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
      case 'heating-mode': return setHeatingMode(hass, el.dataset.room, el.dataset.option);
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

  // ── Disclosure state ─────────────────────────────────────────────────────────────────────────
  // Which disclosure rows are open: {"<room>:<section>": true}, absent = closed. One object for the whole page
  // (every card is its own element, but a person's open rows belong to the viewer, not to a card), shared into
  // each card's ui so the render gate sees a change. Kept in memory; mirrored to localStorage so a reload keeps
  // it, where storage is unavailable (private mode, blocked) it stays in memory only.
  const DISCLOSURE_STORE = 'pulse-card:open';
  function loadDisclosure() {
    const open = {};
    try {
      const saved = JSON.parse(root.localStorage.getItem(DISCLOSURE_STORE));
      if (isObj(saved)) for (const [id, v] of Object.entries(saved)) if (v === true && DISCLOSURE_ID.test(id)) open[id] = true;
    } catch (err) { /* no storage, or unreadable: start closed */ }
    return open;
  }
  const disclosureStore = loadDisclosure();
  function toggleDisclosure(id) {
    if (typeof id !== 'string' || !DISCLOSURE_ID.test(id)) throw new Error(`pulse-card: bad disclosure id "${id}"`);
    if (disclosureStore[id]) delete disclosureStore[id]; else disclosureStore[id] = true;
    try { root.localStorage.setItem(DISCLOSURE_STORE, JSON.stringify(disclosureStore)); } catch (err) { /* memory only */ }
    return disclosureStore[id] === true;
  }

  const api = { parsedAttr, disclosureStore, toggleDisclosure, setOptimise, trackHass, depsUnchanged, makeRenderGate, RENDER_MAX_AGE_MS, deriveScenes, sceneRegistry, ROOM_TABLE, lightsStory, lightsState, verdictFor, houseActivity, parseHistory, readHistory, sentenceFor, roomActivity, splitSentence, timelineLead, unexplainedReasons, REASON_TEXT, UNDECLARED, SUPPRESS_SOURCES, STYLE, TABBAR_ENABLED, tabbarPlacement, TABS, cheapestWindow, COST_STAT, HIST_DAYS, HIST_MIN_ROWS, HIST_REFRESH_MS, histRequest, groupDailyCost, dailyCostFromWS, dayReadout, dailySummary, instantMs, localDate, energyStats, slotWindows, windowRange, coveredDay, isoDayLabel, standingNote, money, energyText, penceText, ENERGY_PATH, HOUSE_PATH, SETTINGS_PATH, takesTaps, invisibleControl, disarm, rearm, coverNeed, topGuard, HEAD_MODES, TOP_GUARD_MAX, CAMERAS_PATH, PENDING_MS, cameraParts, cameraToggle, cameraPending, perform, pendingStart, pendingFor, pendingKey, markPending, ERROR_MS, haptic, tapHaptic, HAPTIC_TYPES, HAPTICS, ACT_HAPTIC, parseClips, frigateClipsId, recentNote, slotAt, slotReadout, tooltipLeft, ratesOf, SCRUB_HOLD_MS, rateBands, DASH, formatPower, moAte, TOKENS, ROOMS, ROOM_ORDER, GARDEN_ORDER, ALL_ROOM_KEYS, THEME_LABELS, THEME_ICON, ICON, SUBSYSTEMS, subsystemOf, placed, gardenModel, gardenSub, themeSource, shortDate, ALLOWED, writeAllowed, HOUSE_NUMBERS, HOUSE_MODIFIER, HOUSE_VACATION_HOURS, CAMERAS, PTZ_DIRS, DEVICE_REASONS, ROOM_SETTINGS, MO_TOGGLES, settingFor, render, priceColour, PRICE_AT, PRICE_EXTREME_P, THEMES, COLOUR_KEYS, DEFAULT_THEME, TOKENS, COPY, checkThemes, themeOf, useTheme, colour, resolveVars, styleFor, roomModel, attentionItems, handleAction, HEATING_MODES, heatingLock, setHeatingMode, zonedClock, parsePlan, planSegments, dayPlan, planNext, parseHeatHistory, heatRequest, makeHeatLoader, HEAT_REFRESH_MS, HEAT_RETRY_MS, callService, num, parseList };
  root.PulseLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ── Custom element (browser only) ────────────────────────────────────────────────────────────
  if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined' && !customElements.get('pulse-card')) {
    class PulseCard extends HTMLElement {
      constructor() {
        super();
        this._root = this.attachShadow({ mode: 'open' });
        this._html = null;
        this._disarmed = new Map(); // invisible header controls whose taps are off while this card shows (see disarm)
        this._gate = makeRenderGate();
        this._busy = false;
        this._ui = { open: disclosureStore, top: 0, tb: 'inflow', day: 'today', fuel: 'electricity', cam: { rec: {} }, pending: {}, error: null, hist: { electricity: { status: 'loading', days: [] }, gas: { status: 'loading', days: [] } } };
        this._histBusy = false;
        this._histSeq = 0;
        this._histAt = 0;
        this._histRetryAt = 0;
        this._heat = makeHeatLoader();
        // The day's heating history rides on ui without joining the render signature: `heatRev` moves when it changes.
        Object.defineProperty(this._ui, 'heatData', { get: () => this._heat.data, enumerable: false });
        this._ui.heatRev = 0;
        this._scrub = { idx: null, slots: null, active: false, pending: null, timer: null };
        this._wireControls(this._root);
        // Price chart scrubbing (see PR for the manual test list; not testable in node).
        this._root.addEventListener('pointerdown', (ev) => this._chartDown(ev));
        this._root.addEventListener('pointermove', (ev) => this._chartMove(ev));
        this._root.addEventListener('pointerup', (ev) => this._chartUp(ev));
        this._root.addEventListener('pointercancel', () => this._chartCancel());
        this._root.addEventListener('keydown', (ev) => this._chartKey(ev));
        this._root.addEventListener('focusout', (ev) => { if (ev.target && ev.target.closest && ev.target.closest('[data-chart]') && !this._scrub.active) this._chartClear(); });
      }
      // Taps, toggles and slider drags: wired to the card's root.
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
        this._gate.reset();
      }
      // Dev only: how many hass updates rendered and how many were skipped. Read it from the console.
      get renderStats() { return { ...this._gate.stats }; }
      set hass(hass) {
        this._hass = hass;
        this._histEnsure();
        this._heatEnsure();
        this._paint(true);
        this._syncStream();
      }
      connectedCallback() {
        this._gate.reset(); // a (re)mount always renders once
        this._histEnsure();
        this._heatEnsure();
        this._tabbarProbeLater();
        this._topProbeLater();
      }
      disconnectedCallback() {
        this._gate.reset();
        this._histSeq += 1;
        this._histBusy = false;
        this._heat.cancel();
        for (const t of this._tbTimers || []) clearTimeout(t);
        for (const t of this._topTimers || []) clearTimeout(t);
        this._topTimers = null;
        rearm(this._disarmed);
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
      // The room's heating history for the day plan: only while a heating card is mounted and the room has a plan to
      // draw it on; the loader keeps the cadence (see makeHeatLoader).
      _heatEnsure() {
        const c = this._config;
        if (!c || c.mode !== 'heating' || !this._hass || !this.isConnected || !usable(state(this._hass, `sensor.${c.room}_heating_plan`))) return;
        this._heat.ensure(this._hass, c.room, Date.now(), () => { this._ui.heatRev += 1; this._paint(); });
      }
      getCardSize() { return 3; }
      // `fromHass` is true only for a hass update, the one caller allowed to skip an unchanged render. Taps,
      // timers (pending and error expiry), history arrival and scrubbing always render.
      _paint(fromHass = false) {
        // Never re-render under a finger: a slider drag or a chart scrub owns the DOM until release.
        if (!this._config || !this._hass || this._busy || this._scrub.active) return;
        if (this._config.mode === 'camera') { this._paintCamera(); return; }
        let html;
        try {
          html = this._gate.run(this._config.mode, this._config, this._hass, Date.now(), this._ui, !fromHass).html;
        } catch (err) {
          // Fail loudly in the card itself rather than leaving a blank hole.
          html = `<div class="p"><div class="card warn pad"><b>${COPY.common.cardError}</b><div class="s">${esc(err && err.message)}</div></div></div>`;
        }
        if (html === this._html) return;
        this._html = html;
        this.style.display = html ? '' : 'none';
        const kept = this._captureFocus();
        this._root.innerHTML = `<style>${styleFor(this._config)}</style>${html}`;
        this._restoreFocus(kept);
        if (this._config.mode === 'tabbar' && !this._tbProbed) this._tabbarProbeLater();
        if (!this._topTimers) this._topProbeLater();
        // The repaint replaced the chart nodes: put a live readout back instead of flickering it away.
        if (this._scrub.idx !== null) this._chartShow(this._scrub.idx, false);
      }
      // A repaint replaces the DOM, which would drop keyboard focus on a control that was just used (a stepper's
      // "+" tapped twice). The focused control is found again by its data-* identity after the paint.
      _captureFocus() {
        const active = this._root.activeElement;
        return active && active.dataset && active.dataset.act ? pendingKey(active.dataset) : null;
      }
      _restoreFocus(key) {
        if (!key) return;
        const el = [...this._root.querySelectorAll('button[data-act], a[data-act]')].find((x) => pendingKey(x.dataset) === key);
        if (el) el.focus({ preventScroll: true });
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
          parts = { live: false, rest: `<div class="pad warn"><b>${COPY.common.cardError}</b><div class="s">${esc(err && err.message)}</div></div>` };
        }
        if (!this._camShell) {
          this._root.innerHTML = `<style>${styleFor(this._config)}</style><div class="p"><div class="hm"><div class="hm-list"><div class="stream" id="cam-stream" hidden></div><div id="cam-rest"></div></div></div></div>`;
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
        const done = guarded(this._hass, this._ui, ds, now, run, this);
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
        // Attached to the document, outside the shadow root, so the card's CSS variables do not reach it.
        useTheme(this._config);
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', 'Recording');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:' + colour('scrimFull') + ';display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;gap:12px;font-family:system-ui,sans-serif';
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.autoplay = true;
        video.style.cssText = 'max-width:100%;max-height:75vh;border-radius:12px;background:' + colour('videoBg');
        const status = document.createElement('div');
        status.style.cssText = `color:${colour('textSecondary')};font-size:13px;min-height:18px`;
        status.textContent = 'Loading…';
        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.cssText = `min-height:44px;padding:0 28px;border:0;border-radius:22px;background:${colour('text')};color:${colour('bg')};font:inherit;font-size:15px;font-weight:600;cursor:pointer`;
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
      // ── top guard ──
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
              const cs = getComputedStyle(el);
              if (!rectOk(r) || !takesTaps(cs)) continue;
              if (invisibleControl(cs)) disarm(el, this._disarmed);
              else out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
            }
          }
          node = node.assignedSlot || node.parentNode || node.host || null;
        }
        return out;
      }
      _topProbe() {
        if (!this.isConnected || typeof getComputedStyle !== 'function' || !this._config || !HEAD_MODES.includes(this._config.mode)) return;
        const targets = [...this._root.querySelectorAll('[data-act]')]
          .map((el) => el.getBoundingClientRect())
          .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
        const need = coverNeed(this._headerBlockers(), targets, this._ui.top);
        // Grow only (see the comment at TOP_GUARD_MAX).
        if (need > this._ui.top) {
          this._ui.top = need;
          this._paint();
        }
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
        useTheme(this._config); // the readout's price colour is computed here, outside a render
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
          if (k === i) { b.setAttribute('stroke', colour('text')); b.setAttribute('stroke-width', '1.5'); b.setAttribute('vector-effect', 'non-scaling-stroke'); } else { b.removeAttribute('stroke'); b.removeAttribute('stroke-width'); }
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
        // A disabled control (a heating mode the controller would override) does nothing, and says nothing by buzzing.
        if (el.disabled === true) return;
        // Sliders buzz on commit (_change), not on the click that ends a drag.
        if (el.type !== 'range') tapHaptic(this, el.dataset.act);
        if (el.dataset.act === 'nav') {
          ev.preventDefault();
          const path = el.dataset.path || '';
          if (path.startsWith('/')) {
            window.history.pushState(null, '', path);
            window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
          }
          return;
        }
        if (el.dataset.act === 'disclose') {
          toggleDisclosure(el.dataset.id);
          this._paint();
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
        if (el.type === 'range') return;
        this._act(el);
      }
      _change(ev) {
        const el = ev.target;
        if (!el || el.type !== 'range' || !this._hass) return;
        this._busy = false;
        tapHaptic(this, el.dataset.act);
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
