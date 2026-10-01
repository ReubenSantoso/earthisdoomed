import type { Store } from '../data/store';
import type { StreamId } from '../data/streams';
import { esc } from './dom';
import { fmtAgoShort, fmtRelative } from './format';

const LIVE: { id: StreamId; name: string }[] = [
  { id: 'usgs-live', name: 'USGS' },
  { id: 'eonet-live', name: 'EONET' },
  { id: 'gdacs-live', name: 'GDACS' },
];

/** "updated 42s ago · USGS · EONET · GDACS" with a quiet per-source state. Opens the Sources tab. */
export class StatusLine {
  constructor(
    private el: HTMLElement,
    private store: Store,
    onOpenSources: () => void,
  ) {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) onOpenSources();
    });
    this.render();
    window.setInterval(() => this.render(), 1000);
  }

  render() {
    const s = this.store.get();
    const ago = s.lastLiveUpdate ? `updated ${fmtAgoShort(s.lastLiveUpdate)} ago` : 'connecting';
    const parts = LIVE.map(({ id, name }) => {
      const st = s.streams[id];
      const title =
        st.state === 'ok'
          ? `${name}: ${st.count ?? 0} records, ${st.updatedAt ? fmtRelative(st.updatedAt) : ''}`
          : st.state === 'error'
            ? `${name} unavailable${st.message ? `: ${st.message}` : ''}`
            : `${name}: loading`;
      return `<span class="st st-${st.state}" title="${esc(title)}"><i aria-hidden="true"></i>${name}${
        st.state === 'error' ? ' <span class="st-off">unavailable</span>' : ''
      }</span>`;
    }).join('');
    this.el.innerHTML = `<button type="button" class="status-btn" title="Open the Sources tab"><span>${esc(ago)}</span>${parts}</button>`;
  }
}

/** Shown only when every live feed failed and there is nothing to draw. */
export class ErrorState {
  constructor(
    private el: HTMLElement,
    private store: Store,
    private onRetry: () => void,
  ) {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-retry]')) this.onRetry();
    });
  }

  update() {
    const s = this.store.get();
    const failed = LIVE.every(({ id }) => s.streams[id].state === 'error');
    if (!(failed && s.events.length === 0)) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="error-card">
        <h2>No feeds are answering right now</h2>
        <p>USGS, NASA EONET and GDACS all failed to respond, so there is nothing honest to draw. The page will keep trying every minute.</p>
        <ul class="mono">${LIVE.map(({ id, name }) => `<li>${name}: ${esc(s.streams[id].message ?? 'no response')}</li>`).join('')}</ul>
        <button type="button" class="btn" data-retry>Try again now</button>
      </div>`;
  }
}
