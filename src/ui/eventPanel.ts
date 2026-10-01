import { colorOf } from '../config';
import type { StreamId, StreamStatus } from '../data/streams';
import type { DisasterEvent, SourceId } from '../data/types';
import { Compare } from './compare';
import { esc, safeUrl } from './dom';
import { fmtRelative, fmtSpan, typeName } from './format';

const SOURCE_HOME: Record<SourceId, string> = {
  USGS: 'https://earthquake.usgs.gov/earthquakes/map/',
  EONET: 'https://eonet.gsfc.nasa.gov/',
  GDACS: 'https://www.gdacs.org/',
};

function coords(lat: number, lon: number) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

/** Slide-in detail for the selected event, with the before/after imagery. */
export class EventPanel {
  private body: HTMLElement;
  private compare: Compare | null = null;
  private current: DisasterEvent | null = null;
  private open = false;

  constructor(
    private el: HTMLElement,
    onClose: () => void,
    private report: (id: StreamId, patch: Partial<StreamStatus>) => void,
  ) {
    el.innerHTML = `
      <div class="panel-inner">
        <button type="button" class="panel-close" aria-label="Close event detail">&times;</button>
        <div class="panel-body"></div>
        <section class="compare-block" aria-label="Satellite imagery before and after">
          <div class="compare-head">
            <h3>Before / after</h3>
            <span class="mono dim">VIIRS true colour · NASA GIBS</span>
          </div>
          <div class="compare-host"></div>
          <p class="compare-note">Regional imagery, about 250&nbsp;m to 1&nbsp;km per pixel: not street level. Drag the divider to compare. Daily passes can be cloudy or arrive late.</p>
        </section>
      </div>`;
    this.body = el.querySelector('.panel-body')!;
    el.querySelector('.panel-close')!.addEventListener('click', onClose);
    el.addEventListener('transitionend', (e) => {
      if (e.target === el && this.open) this.compare?.invalidate();
    });
  }

  get isOpen() {
    return this.open;
  }

  show(e: DisasterEvent) {
    const changed = this.current?.id !== e.id || this.current !== e;
    this.current = e;
    if (changed) this.render(e);
    if (!this.open) {
      this.open = true;
      this.el.dataset.open = 'true';
      this.el.removeAttribute('inert');
    }
    // Leaflet is created lazily, the first time a panel opens.
    this.compare ??= new Compare(this.el.querySelector('.compare-host')!, this.report);
    this.compare.show(e);
    requestAnimationFrame(() => this.compare?.invalidate());
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.dataset.open = 'false';
    this.el.setAttribute('inert', '');
  }

  focusTitle() {
    (this.el.querySelector('.panel-title') as HTMLElement | null)?.focus();
  }

  private render(e: DisasterEvent) {
    const alert = e.alert ? `<span class="chip chip-${e.alert}">GDACS ${e.alert} alert</span>` : '';
    const sources = e.sources
      .map((s) => {
        const href = safeUrl(s === e.source ? e.url : SOURCE_HOME[s]);
        return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${s}<span aria-hidden="true"> ↗</span></a>` : s;
      })
      .join(' · ');
    const where = [e.country, e.offshore ? null : e.sector && e.sector !== 'On land' ? `${e.sector.toLowerCase()}` : null]
      .filter(Boolean)
      .join(', ');
    this.body.innerHTML = `
      <p class="panel-type" style="--c:${colorOf(e.type)}"><i class="dot" aria-hidden="true"></i>${esc(typeName(e))}${alert}</p>
      <h2 class="panel-title" tabindex="-1">${esc(e.title)}</h2>
      <dl class="panel-facts">
        <dt>Where</dt>
        <dd>${esc(where || 'Location not tagged')}${e.region ? ` <span class="dim">· ${esc(e.region)}</span>` : ''}<br><span class="mono dim">${coords(e.lat, e.lon)}</span></dd>
        <dt>Measure</dt>
        <dd class="mono">${esc(e.magnitudeLabel || 'not reported by the source')}</dd>
        <dt>When</dt>
        <dd>${esc(fmtSpan(e))}${e.ongoing ? '' : `<br><span class="dim">${esc(fmtRelative(e.t0))}</span>`}</dd>
        <dt>Reported by</dt>
        <dd>${sources}</dd>
      </dl>`;
  }
}
