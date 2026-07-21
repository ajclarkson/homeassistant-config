class MoTimelineCard extends HTMLElement {
  setConfig(config) {
    this._config = config;
  }

  set hass(hass) {
    this._hass = hass;
    const state = hass.states['sensor.mo_timeline'];
    const sig = state ? state.last_changed : null;
    if (sig === this._sig) return;
    this._sig = sig;
    this._render(
      (state && state.attributes.eating) || [],
      (state && state.attributes.spotted) || []
    );
  }

  _render(eating, spotted) {
    this.innerHTML = `
<style>
  .mo-wrap { padding: 0 4px 16px; font-family: var(--primary-font-family, sans-serif); }
  .mo-heading { font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--secondary-text-color); padding: 16px 12px 6px; }
  .mo-row { display: flex; align-items: center; padding: 8px 12px; border-radius: 10px;
    gap: 12px; user-select: none; -webkit-tap-highlight-color: transparent; cursor: pointer; }
  .mo-row:active { background: rgba(255,255,255,0.08); }
  .mo-thumb { width: 64px; height: 46px; object-fit: cover; border-radius: 6px;
    flex-shrink: 0; background: #222; display: block; }
  .mo-label { font-size: 14px; color: var(--primary-text-color); line-height: 1.3; }
  .mo-sub { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
  .mo-play { color: var(--secondary-text-color); font-size: 13px; flex-shrink: 0; opacity: 0.6; }
  .mo-empty { padding: 8px 12px; font-size: 13px; color: var(--secondary-text-color); }
</style>
<div class="mo-wrap">
  <div class="mo-heading">Eating · ${eating.length}</div>
  ${eating.length ? eating.map(e => this._row(e)).join('') : '<div class="mo-empty">No eating events</div>'}
  <div class="mo-heading">Spotted · ${spotted.length}</div>
  ${spotted.length ? spotted.slice(0, 15).map(e => this._row(e)).join('') : '<div class="mo-empty">No sightings</div>'}
</div>`;

    this.querySelectorAll('[data-eid]').forEach(el => {
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
  }

  _row(e) {
    const ago = this._fmt(e.ts);
    const thumb = `/api/frigate/notifications/${e.event_id}/snapshot.jpg`;
    return `<div class="mo-row" data-eid="${e.event_id}">
      <img class="mo-thumb" src="${thumb}" loading="lazy">
      <div style="flex:1;min-width:0">
        <div class="mo-label">${ago}</div>
        <div class="mo-sub">${e.room}</div>
      </div>
      <span class="mo-play">▶</span>
    </div>`;
  }

  _fmt(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const eventDay = new Date(d); eventDay.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today - eventDay) / 86400000);
    if (diffDays === 0) return `Today, ${time}`;
    if (diffDays === 1) return `Yesterday, ${time}`;
    return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + `, ${time}`;
  }

  _play(eventId) {
    const now = Date.now();
    if (this._lastPlay && now - this._lastPlay < 1200) return;
    this._lastPlay = now;

    // Build overlay + video synchronously — required for iOS autoplay in gesture context
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';

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

    let blobUrl = null;
    const close = () => { overlay.remove(); if (blobUrl) URL.revokeObjectURL(blobUrl); };
    closeBtn.addEventListener('touchend', ev => { ev.preventDefault(); close(); });
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });

    // HA uses Bearer token auth (not cookies), so video src alone won't authenticate.
    // Fetch with token then play from a blob URL.
    const token = this._hass.auth.data.access_token;
    fetch(`/api/frigate/notifications/${eventId}/clip.mp4`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.blob();
    }).then(blob => {
      blobUrl = URL.createObjectURL(blob);
      status.textContent = '';
      video.src = blobUrl;
    }).catch(err => {
      status.textContent = `Error: ${err.message}`;
    });
  }

  getCardSize() { return 5; }
}

if (!customElements.get('mo-timeline-card')) {
  customElements.define('mo-timeline-card', MoTimelineCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'custom:mo-timeline-card',
  name: 'Mo Timeline Card',
  description: 'Mo daily activity timeline',
});
