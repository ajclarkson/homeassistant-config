/*
 * Loader for pulse-card.js. This file never changes, so it is the only thing registered in
 * extra_module_url (packages/frontend.yaml), which HA reads at startup only.
 *
 * Why: a ?v=N on the card URL needed an HA restart to bump, and the companion app caches JS
 * modules hard. Here the card is fetched with `no-cache` (revalidates by ETag, 304 when
 * unchanged), then imported from a Blob URL, so an edited pulse-card.js is picked up on the next
 * dashboard load with no restart and no version bump.
 *
 * If anything fails (network, non-2xx, blob import blocked) it warns and falls back to a plain
 * import of the same path, so the card still loads, possibly from cache.
 */
(async function () {
  'use strict';

  const CARD_PATH = '/local/pulse-card.js';

  async function importFresh() {
    const res = await fetch(CARD_PATH, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${CARD_PATH}`);
    const text = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    try {
      await import(blobUrl);
    } finally {
      // The module is already evaluated; the URL is no longer needed.
      URL.revokeObjectURL(blobUrl);
    }
  }

  try {
    await importFresh();
  } catch (err) {
    console.warn('pulse-card-loader: fresh load failed, falling back to plain import', err);
    await import(CARD_PATH);
  }
})();
