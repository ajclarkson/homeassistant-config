/**
 * camera-events-card
 * Config (mode: full):
 *   camera: string        Frigate camera name (e.g. "kitchen")
 *   entity: string        HA camera entity (e.g. "camera.kitchen_hd_stream")
 *   privacy: string       Switch entity to toggle (e.g. "switch.kitchen_privacy")
 *   title: string         Optional display title (defaults to camera name)
 *   ptz: boolean          Enable PTZ d-pad (derives button.{camera}_move_{dir})
 *   limit: number         Max recordings to show (default 40)
 *
 * Config (mode: recordings):
 *   camera: string        Frigate camera name
 *   title: string         Optional display title
 *   limit: number         Max recordings to show (default 40)
 *   Used inside a bubble-card pop-up — reloads each time the popup hash opens.
 */
class CameraEventsCard extends HTMLElement {
  setConfig(config) {
    if (!config.camera) throw new Error('camera-events-card: missing required config "camera"');
    this._config = { limit: 40, ptz: false, mode: 'full', ...config };
  }

  connectedCallback() {
    if (this._hass && !this._initialized) this._init();
  }

  disconnectedCallback() {
    if (this._hashHandler) window.removeEventListener('hashchange', this._hashHandler);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this.isConnected) this._init();
    if (this._config.mode === 'full') {
      if (this._streamEl) this._streamEl.hass = hass;
      this._updateStatus();
    }
  }

  _init() {
    if (this._initialized) return;
    this._initialized = true;
    if (this._config.mode === 'recordings') {
      this._buildRecordingsShell();
    } else {
      this._buildFullShell();
    }
  }

  // ── Full mode ────────────────────────────────────────────────────────────

  _buildFullShell() {
    const { camera, entity, privacy, title, ptz } = this._config;
    const label = title || (camera.charAt(0).toUpperCase() + camera.slice(1).replace(/_/g, ' '));
    const hash = `#${camera.replace(/_/g, '-')}-recordings`;

    this.innerHTML = `
<style>
  .ce { font-family: var(--primary-font-family, sans-serif); padding-bottom: 8px; }
  .ce-header { display:flex; align-items:center; justify-content:space-between; padding:4px 12px 8px; }
  .ce-title { font-size:12px; font-weight:600; text-transform:uppercase;
    letter-spacing:0.08em; color:var(--secondary-text-color); }
  .ce-chip { font-size:11px; font-weight:600; padding:3px 10px; border-radius:999px; letter-spacing:0.04em; }
  .ce-chip.live { background:rgba(76,175,80,0.18); color:#66bb6a; }
  .ce-chip.off  { background:rgba(211,47,47,0.15); color:#ef5350; }
  .ce-stream { border-radius:12px; overflow:hidden; margin:0 12px;
    background:#111; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; }
  ha-camera-stream { display:block; width:100%; }
  .ce-no-stream { color:rgba(255,255,255,0.3); font-size:13px; }
  .ce-controls { display:flex; gap:8px; padding:10px 12px 4px; align-items:stretch; }
  .ce-left { display:flex; flex-direction:column; gap:8px; flex:1; min-width:0; }
  .ce-btn { background:var(--md-sys-color-surface-container-high); border:none;
    color:var(--primary-text-color); border-radius:8px; padding:10px 14px;
    font-size:14px; font-weight:600; cursor:pointer; touch-action:manipulation;
    -webkit-tap-highlight-color:transparent; width:100%; display:flex;
    align-items:center; gap:12px; font-family:inherit; box-shadow:none; }
  .ce-btn:active { transform:scale(0.99); }
  .ce-btn-icon { --mdc-icon-size:18px; color:rgba(255,255,255,0.45); flex-shrink:0; display:flex; }
  .ce-btn.privacy-on { background:color-mix(in srgb, var(--md-sys-color-primary) 10%, var(--md-sys-color-surface-container-high)); }
  .ce-btn.privacy-on .ce-btn-icon { color:var(--md-sys-color-primary); }
  .ce-ptz { display:grid; grid-template-columns:repeat(3,40px);
    grid-template-rows:repeat(3,40px); gap:4px; flex-shrink:0; align-self:center; }
  .ce-ptz-btn { background:var(--md-sys-color-surface-container-high); border:none;
    color:var(--primary-text-color); border-radius:8px; font-size:18px;
    cursor:pointer; display:flex; align-items:center; justify-content:center;
    touch-action:manipulation; -webkit-tap-highlight-color:transparent; box-shadow:none; }
  .ce-ptz-btn:active { transform:scale(0.96); }
</style>
<div class="ce">
  <div class="ce-header">
    <span class="ce-title">${label}</span>
    <span class="ce-chip" id="status-chip"></span>
  </div>
  <div class="ce-stream" id="stream-wrap">
    ${entity ? '' : '<span class="ce-no-stream">No stream configured</span>'}
  </div>
  <div class="ce-controls">
    <div class="ce-left">
      <button class="ce-btn" id="recordings-btn">
        <ha-icon icon="mdi:video-outline" class="ce-btn-icon"></ha-icon>Recordings
      </button>
      ${privacy ? `<button class="ce-btn" id="privacy-btn">
        <ha-icon class="ce-btn-icon" id="privacy-icon"></ha-icon><span id="privacy-label"></span>
      </button>` : ''}
    </div>
    ${ptz ? `<div class="ce-ptz">
      <div></div><button class="ce-ptz-btn" data-ptz="up">↑</button><div></div>
      <button class="ce-ptz-btn" data-ptz="left">←</button><div></div><button class="ce-ptz-btn" data-ptz="right">→</button>
      <div></div><button class="ce-ptz-btn" data-ptz="down">↓</button><div></div>
    </div>` : ''}
  </div>
</div>`;

    if (entity) {
      const el = document.createElement('ha-camera-stream');
      el.hass = this._hass;
      el.stateObj = this._hass.states[entity];
      el.setAttribute('muted', '');
      el.setAttribute('controls', '');
      this.querySelector('#stream-wrap').appendChild(el);
      this._streamEl = el;
    }

    this._statusChip = this.querySelector('#status-chip');
    this._privacyBtn = this.querySelector('#privacy-btn');

    if (this._privacyBtn) {
      this._privacyBtn.addEventListener('click', () => {
        this._hass.callService('homeassistant', 'toggle', { entity_id: privacy });
      });
    }

    this.querySelector('#recordings-btn').addEventListener('click', () => {
      window.location.hash = hash;
    });

    if (ptz) {
      this.querySelectorAll('[data-ptz]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._hass.callService('button', 'press', { entity_id: `button.${camera}_move_${btn.dataset.ptz}` });
        });
      });
    }

    this._updateStatus();
  }

  _updateStatus() {
    if (!this._statusChip) return;
    const privacyState = this._config.privacy && this._hass && this._hass.states[this._config.privacy];
    const privacyOn = privacyState && privacyState.state === 'on';
    this._statusChip.textContent = privacyOn ? '● Off' : '● Live';
    this._statusChip.className = `ce-chip ${privacyOn ? 'off' : 'live'}`;
    if (this._privacyBtn) {
      const icon = this._privacyBtn.querySelector('#privacy-icon');
      const label = this._privacyBtn.querySelector('#privacy-label');
      if (icon) icon.setAttribute('icon', privacyOn ? 'mdi:eye-off' : 'mdi:eye');
      if (label) label.textContent = privacyOn ? 'Privacy on' : 'Privacy off';
      this._privacyBtn.classList.toggle('privacy-on', privacyOn);
    }
  }

  // ── Recordings mode ──────────────────────────────────────────────────────

  _buildRecordingsShell() {
    this.innerHTML = `
<style>
  .cer { font-family: var(--primary-font-family, sans-serif); padding-bottom: 8px; }
  .cer-bar { display:flex; align-items:center; justify-content:space-between;
    padding:4px 12px 8px; }
  .cer-count { font-size:12px; color:var(--secondary-text-color); }
  .cer-refresh { background:var(--md-sys-color-surface-container-high); border:none;
    color:var(--primary-text-color); border-radius:8px; padding:6px 12px;
    font-size:13px; font-weight:600; cursor:pointer; touch-action:manipulation;
    font-family:inherit; box-shadow:none; display:flex; align-items:center; gap:6px; }
  .cer-refresh:active { transform:scale(0.98); }
  .cer-state { padding:12px 16px; font-size:13px; color:var(--secondary-text-color); }
  .cer-row { display:flex; align-items:center; padding:8px 12px; border-radius:10px;
    gap:12px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
  .cer-row:active { background:rgba(255,255,255,0.08); }
  .cer-thumb { width:64px; height:46px; object-fit:cover; border-radius:6px;
    flex-shrink:0; background:#222; display:block; }
  .cer-main { font-size:14px; color:var(--primary-text-color); line-height:1.3; }
  .cer-sub { font-size:12px; color:var(--secondary-text-color); margin-top:2px; text-transform:capitalize; }
  .cer-play { color:var(--secondary-text-color); font-size:13px; flex-shrink:0; opacity:0.6; }
</style>
<div class="cer">
  <div class="cer-bar">
    <span class="cer-count" id="cer-count"></span>
    <button class="cer-refresh" id="cer-refresh"><ha-icon icon="mdi:refresh" style="--mdc-icon-size:16px"></ha-icon>Refresh</button>
  </div>
  <div id="cer-list"><div class="cer-state">Loading…</div></div>
</div>`;

    this.querySelector('#cer-refresh').addEventListener('click', () => this._loadList());

    // Reload each time the popup hash is opened
    const hash = `#${this._config.camera.replace(/_/g, '-')}-recordings`;
    this._hashHandler = () => {
      if (window.location.hash === hash) this._loadList();
    };
    window.addEventListener('hashchange', this._hashHandler);

    this._loadList();
  }

  async _loadList() {
    const list = this.querySelector('#cer-list');
    const countEl = this.querySelector('#cer-count');
    if (!list || !this._hass) return;
    list.innerHTML = '<div class="cer-state">Loading…</div>';

    try {
      const result = await this._hass.callWS({
        type: 'media_source/browse_media',
        media_content_id: `media-source://frigate/frigate/event-search/clips////${this._config.camera}/`,
      });

      const items = (result.children || [])
        .filter(c => c.frigate && c.frigate.event && c.frigate.event.has_clip)
        .slice(0, this._config.limit);

      if (countEl) countEl.textContent = `${items.length} recordings`;

      if (!items.length) {
        list.innerHTML = '<div class="cer-state">No recordings found</div>';
        return;
      }

      this._mediaIds = {};
      list.innerHTML = items.map(item => {
        const e = item.frigate.event;
        this._mediaIds[e.id] = item.media_content_id;
        const ago = this._ago(e.start_time * 1000);
        const label = (e.label || 'unknown');
        const sub = e.zones && e.zones.length ? `${label} · ${e.zones.join(', ')}` : label;
        return `<div class="cer-row" data-eid="${e.id}">
          <img class="cer-thumb" src="/api/frigate/notifications/${e.id}/snapshot.jpg" loading="lazy">
          <div style="flex:1;min-width:0">
            <div class="cer-main">${ago}</div>
            <div class="cer-sub">${sub}</div>
          </div>
          <span class="cer-play">▶</span>
        </div>`;
      }).join('');

      list.querySelectorAll('[data-eid]').forEach(el => {
        let t0 = null;
        el.addEventListener('touchstart', ev => {
          t0 = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
        }, { passive: true });
        el.addEventListener('touchend', ev => {
          if (!t0) return;
          const dx = Math.abs(ev.changedTouches[0].clientX - t0.x);
          const dy = Math.abs(ev.changedTouches[0].clientY - t0.y);
          t0 = null;
          if (dx < 10 && dy < 10) this._play(el.dataset.eid);
        }, { passive: true });
        el.addEventListener('click', () => this._play(el.dataset.eid));
      });
    } catch (e) {
      list.innerHTML = `<div class="cer-state">Failed to load: ${e.message}</div>`;
    }
  }

  // ── Shared: clip playback ────────────────────────────────────────────────

  _play(eventId) {
    const now = Date.now();
    if (this._lastPlay && now - this._lastPlay < 1200) return;
    this._lastPlay = now;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483648;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';

    const video = document.createElement('video');
    video.style.cssText = 'max-width:100%;max-height:75vh;border-radius:10px;background:#000';
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;

    const status = document.createElement('div');
    status.textContent = 'Loading…';
    status.style.cssText = 'color:rgba(255,255,255,0.5);font-size:13px;margin-top:10px;min-height:18px';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'margin-top:12px;padding:10px 28px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:20px;font-size:16px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent';

    overlay.append(video, status, closeBtn);
    document.documentElement.appendChild(overlay);

    const close = () => { overlay.remove(); video.src = ''; };

    // Bubble-phase stopPropagation: lets events reach children (closeBtn) but
    // prevents them bubbling up to document where bubble card's close handler lives
    overlay.addEventListener('pointerdown', ev => ev.stopPropagation());
    overlay.addEventListener('click', ev => {
      ev.stopPropagation();
      if (ev.target === overlay) close();
    });

    closeBtn.addEventListener('touchend', ev => { ev.preventDefault(); close(); });
    closeBtn.addEventListener('click', close);

    const mediaId = this._mediaIds && this._mediaIds[eventId];
    if (!mediaId) { status.textContent = 'Error: event not found'; return; }

    this._hass.callWS({ type: 'media_source/resolve_media', media_content_id: mediaId })
      .then(resolved => { status.textContent = ''; video.src = resolved.url; })
      .catch(err => { status.textContent = `Error: ${err.message}`; });
  }

  _ago(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 2) return 'Just now';
    if (m < 60) return `${m} mins ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    return new Date(ts).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  getCardSize() { return this._config.mode === 'recordings' ? 10 : 6; }

  getGridOptions() {
    return { columns: 12, rows: 8, min_columns: 6, min_rows: 4 };
  }
}

if (!customElements.get('camera-events-card')) {
  customElements.define('camera-events-card', CameraEventsCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'custom:camera-events-card',
  name: 'Camera Events Card',
  description: 'Live stream + Frigate recordings popup + PTZ controls',
});
