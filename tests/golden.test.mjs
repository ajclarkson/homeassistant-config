// Pulse card tests: golden. Run: cd tests && npm test (or node --test golden.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Raw, asTheme, P, NOW, FULL, mk, withRooms, renderAll, calmRooms, richHass, allCards } from './helpers.mjs';

// ── Whole-page golden: every page and the stylesheet, hashed ────────────────────────────────────────
// tests/fixtures/golden.json holds a sha256 per rendered page (and for the stylesheet), taken against the default
// theme. Pages carry var(--pulse-token) instead of hex, so each page is first resolved against the default theme's
// values; a changed colour, class or word then shows as a changed hash. After an intended change, regenerate with
// PULSE_GOLDEN_WRITE=1 node golden.test.mjs (from tests/) and review the diff.
const sha = (s) => createHash('sha256').update(s).digest('hex');
const goldenPages = () => {
  const rooms = P.ROOM_ORDER.map(FULL);
  const calmRooms = P.ROOM_ORDER.map((k) => ({ ...FULL(k), target_reason: '', labels: [], pres_labels: [], heat_labels: [], ext_open: false }));
  const scenarios = {
    attention: withRooms(rooms, [{ room: 'Bedroom', key: 'bedroom', kind: 'window_open_heating_on', text: 'Open window while heating', nav: '/x' }]),
    calm: withRooms(calmRooms, []),
    bare: mk(),
  };
  const pages = {};
  for (const [name, hass] of Object.entries(scenarios)) for (const [k, v] of Object.entries(renderAll(hass))) pages[`${name}/${k}`] = v;
  // The full card list (every mode, room sheets open, cameras, house pages) on the richest fixture.
  const rich = richHass();
  for (const [label, m, c, ui] of allCards()) pages[`rich/${label}`] = Raw.render(m, asTheme(c), rich, NOW, ui);
  return pages;
};
const goldenFile = new URL('./fixtures/golden.json', import.meta.url).pathname;
if (process.env.PULSE_GOLDEN_WRITE) {
  const pages = Object.fromEntries(Object.entries(goldenPages()).map(([k, v]) => [k, Raw.resolveVars ? Raw.resolveVars(v, Raw.DEFAULT_THEME) : v]));
  writeFileSync(goldenFile, JSON.stringify({ style: sha(Raw.resolveVars ? Raw.resolveVars(Raw.STYLE, Raw.DEFAULT_THEME) : Raw.STYLE), pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, sha(v)])) }, null, 1) + '\n');
  console.log('wrote', goldenFile);
} else {
  test('the default theme renders the same pages and stylesheet as the golden', () => {
    const golden = JSON.parse(readFileSync(goldenFile, 'utf8'));
    const resolve = (s) => (P.resolveVars ? P.resolveVars(s, Raw.DEFAULT_THEME) : s);
    assert.equal(sha(resolve(P.STYLE)), golden.style, 'stylesheet changed');
    const pages = goldenPages();
    assert.deepEqual(Object.keys(pages).sort(), Object.keys(golden.pages).sort());
    const changed = Object.keys(pages).filter((k) => sha(resolve(pages[k])) !== golden.pages[k]);
    assert.deepEqual(changed, [], `pages changed under the default theme: ${changed.slice(0, 8).join(', ')}`);
  });
}
