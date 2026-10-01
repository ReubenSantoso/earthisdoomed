import L from 'leaflet';
import { DAY, colorOf } from '../config';
import type { StreamId, StreamStatus } from '../data/streams';
import type { DisasterEvent } from '../data/types';
import { esc } from './dom';
import { fmtDay, isoDate } from './format';

/*
 * Curtain-style before/after built from two synced Leaflet maps on NASA GIBS imagery.
 *   True colour: WMTS, VIIRS_SNPP_CorrectedReflectance_TrueColor, GoogleMapsCompatible_Level9
 *   Fire detections (wildfires only): WMS, VIIRS_SNPP_Thermal_Anomalies_375m_All. That layer is
 *   published only as vector tiles over WMTS, so the documented WMS endpoint renders it as PNG.
 * Cloud / no-data detection samples the tiles Leaflet already loaded (GIBS allows CORS), so it
 * costs no extra requests.
 */
const WMTS = (date: string) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const NATIVE_ZOOM = 9;
const VIIRS_START = Date.UTC(2012, 0, 20);

type Side = 'before' | 'after';

interface SideState {
  map: L.Map;
  el: HTMLElement;
  truecolor?: L.TileLayer;
  fires?: L.TileLayer.WMS;
  marker?: L.CircleMarker;
  date: number;
  loaded: number;
  errors: number;
  samples: { cloud: number; empty: number }[];
  /** Imagery loaded but the analysed tiles came back as no data. */
  verdict: 'ok' | 'cloudy' | 'nodata' | 'failed' | 'pending';
  autoStepped: boolean;
}

const ZOOM_FOR: Record<DisasterEvent['type'], number> = {
  earthquake: 7,
  wildfire: 8,
  storm: 5,
  volcano: 8,
  flood: 7,
  drought: 6,
  other: 6,
};

export class Compare {
  private root: HTMLElement;
  private stage: HTMLElement;
  private divider: HTMLElement;
  private sides: Record<Side, SideState>;
  private split = 0.5;
  private syncing = false;
  private event: DisasterEvent | null = null;
  private showFires = true;
  private probe = document.createElement('canvas');
  private totals = { tiles: 0, errors: 0, fireTiles: 0, fireErrors: 0 };

  constructor(
    container: HTMLElement,
    private report: (id: StreamId, patch: Partial<StreamStatus>) => void,
  ) {
    container.innerHTML = `
      <div class="cmp-stage">
        <div class="cmp-map" data-side="before"></div>
        <div class="cmp-map cmp-top" data-side="after"></div>
        <span class="cmp-label cmp-label-before mono" data-label="before"></span>
        <span class="cmp-label cmp-label-after mono" data-label="after"></span>
        <p class="cmp-empty" data-empty="before" hidden></p>
        <p class="cmp-empty" data-empty="after" hidden></p>
        <div class="cmp-divider" role="slider" tabindex="0" aria-label="Before and after divider"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="50% before, 50% after">
          <span class="cmp-handle" aria-hidden="true"></span>
        </div>
        <div class="cmp-failed" hidden>
          <p>Satellite imagery could not be loaded. NASA GIBS may be unreachable right now.</p>
        </div>
      </div>
      <div class="cmp-dates">
        <div class="cmp-date" data-date-side="before">
          <span class="dim">Before</span>
          <button type="button" class="nudge" data-nudge="before:-1" aria-label="Before: one day earlier">&lsaquo;</button>
          <span class="mono" data-date="before"></span>
          <button type="button" class="nudge" data-nudge="before:1" aria-label="Before: one day later">&rsaquo;</button>
        </div>
        <div class="cmp-date" data-date-side="after">
          <span class="dim">After</span>
          <button type="button" class="nudge" data-nudge="after:-1" aria-label="After: one day earlier">&lsaquo;</button>
          <span class="mono" data-date="after"></span>
          <button type="button" class="nudge" data-nudge="after:1" aria-label="After: one day later">&rsaquo;</button>
        </div>
      </div>
      <label class="cmp-fires" hidden><input type="checkbox" checked /> Show VIIRS fire detections</label>`;
    this.root = container;
    this.stage = container.querySelector('.cmp-stage')!;
    this.divider = container.querySelector('.cmp-divider')!;

    const mapOptions: L.MapOptions = {
      zoomControl: false,
      attributionControl: false,
      minZoom: 2,
      maxZoom: 11,
      zoomSnap: 0.5,
      zoomAnimation: false, // keeps the two maps in lockstep
      worldCopyJump: true,
      keyboard: false,
    };
    const make = (side: Side): SideState => {
      const el = container.querySelector<HTMLElement>(`[data-side="${side}"]`)!;
      return {
        map: L.map(el, mapOptions).setView([0, 0], 3),
        el,
        date: Date.now(),
        loaded: 0,
        errors: 0,
        samples: [],
        verdict: 'pending',
        autoStepped: false,
      };
    };
    this.sides = { before: make('before'), after: make('after') };
    const after = this.sides.after.map;
    L.control.zoom({ position: 'topright' }).addTo(after);
    L.control.attribution({ position: 'bottomright', prefix: false }).addAttribution('NASA GIBS · VIIRS SNPP').addTo(after);

    const sync = (from: L.Map, to: L.Map) => {
      if (this.syncing) return;
      this.syncing = true;
      to.setView(from.getCenter(), from.getZoom(), { animate: false });
      this.syncing = false;
    };
    this.sides.before.map.on('move zoom', () => sync(this.sides.before.map, after));
    after.on('move zoom', () => sync(after, this.sides.before.map));

    this.bindDivider();
    container.querySelector('.cmp-dates')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-nudge]');
      if (!b) return;
      const [side, step] = b.dataset.nudge!.split(':') as [Side, string];
      this.nudge(side, Number(step));
    });
    container.querySelector<HTMLInputElement>('.cmp-fires input')!.addEventListener('change', (e) => {
      this.showFires = (e.target as HTMLInputElement).checked;
      this.applyLayers('before');
      this.applyLayers('after');
    });
    this.applySplit();
  }

  /** Show imagery for an event: about 7 days before it, and its date (or the latest available). */
  show(e: DisasterEvent) {
    const sameEvent = this.event?.id === e.id;
    this.event = e;
    if (sameEvent) return;
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const startDay = Math.floor(e.t0 / DAY) * DAY;
    const lastActive = Math.min(Number.isFinite(e.t1) ? e.t1 : Date.now(), Date.now());
    const afterDay = Math.min(today, Math.floor(lastActive / DAY) * DAY);
    this.sides.after.date = afterDay;
    this.sides.before.date = Math.max(VIIRS_START, Math.min(startDay, afterDay) - 7 * DAY);
    this.sides.after.autoStepped = false;
    this.sides.before.autoStepped = false;

    const zoom = ZOOM_FOR[e.type];
    for (const side of ['before', 'after'] as Side[]) {
      const st = this.sides[side];
      st.map.setView([e.lat, e.lon], zoom, { animate: false });
      st.marker?.remove();
      st.marker = L.circleMarker([e.lat, e.lon], {
        radius: 7,
        color: colorOf(e.type),
        weight: 1.5,
        fill: false,
        interactive: false,
      }).addTo(st.map);
    }
    (this.root.querySelector('.cmp-fires') as HTMLElement).hidden = e.type !== 'wildfire';
    this.applyLayers('before');
    this.applyLayers('after');
  }

  /** Leaflet needs this after its container changes size (panel slide-in). */
  invalidate() {
    this.sides.before.map.invalidateSize({ animate: false });
    this.sides.after.map.invalidateSize({ animate: false });
  }

  private nudge(side: Side, days: number) {
    const st = this.sides[side];
    const other = this.sides[side === 'before' ? 'after' : 'before'];
    const today = Math.floor(Date.now() / DAY) * DAY;
    let date = st.date + days * DAY;
    if (side === 'before') date = Math.min(date, other.date - DAY);
    else date = Math.max(date, other.date + DAY);
    date = Math.max(VIIRS_START, Math.min(today, date));
    if (date === st.date) return;
    st.date = date;
    st.autoStepped = true; // a manual choice: no automatic stepping back
    this.applyLayers(side);
  }

  private applyLayers(side: Side) {
    const st = this.sides[side];
    const date = isoDate(st.date);
    st.truecolor?.remove();
    st.fires?.remove();
    st.loaded = 0;
    st.errors = 0;
    st.samples = [];
    st.verdict = 'pending';
    this.renderLabels();
    this.renderEmpty(side);

    const layer = L.tileLayer(WMTS(date), {
      maxNativeZoom: NATIVE_ZOOM,
      maxZoom: 11,
      tileSize: 256,
      crossOrigin: 'anonymous',
      bounds: L.latLngBounds([-85.0511, -180], [85.0511, 180]),
    });
    layer.on('tileload', (ev: L.TileEvent) => {
      st.loaded++;
      this.totals.tiles++;
      this.sample(st, ev);
    });
    layer.on('tileerror', () => {
      st.errors++;
      this.totals.errors++;
    });
    // Leaflet fires "load" midway through its own tile bookkeeping, so evaluate (which may swap
    // this layer out) on the next task, and only if this layer is still the one on the map.
    layer.on('load', () =>
      window.setTimeout(() => {
        if (st.truecolor === layer) this.evaluate(side);
      }, 0),
    );
    layer.addTo(st.map);
    st.truecolor = layer;

    if (this.event?.type === 'wildfire' && this.showFires) {
      const fires = L.tileLayer.wms(WMS, {
        layers: 'VIIRS_SNPP_Thermal_Anomalies_375m_All',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        maxZoom: 11,
        opacity: 0.95,
        time: date,
      } as L.WMSOptions);
      fires.on('tileload', () => this.totals.fireTiles++);
      fires.on('tileerror', () => this.totals.fireErrors++);
      fires.on('load', () =>
        this.report('gibs-fires', {
          state: this.totals.fireTiles || !this.totals.fireErrors ? 'ok' : 'error',
          count: this.totals.fireTiles,
          updatedAt: Date.now(),
          detail: `latest ${date}`,
          message: this.totals.fireErrors && !this.totals.fireTiles ? 'fire detection tiles failed to load' : undefined,
        }),
      );
      fires.addTo(st.map);
      st.fires = fires;
    }
  }

  /** Classify a loaded tile's pixels as cloud (bright, grey) or empty (black: no pass yet). */
  private sample(st: SideState, ev: L.TileEvent) {
    const center = st.map.project(st.map.getCenter(), Math.min(st.map.getZoom(), NATIVE_ZOOM)).divideBy(256).floor();
    const c = (ev as L.TileEvent & { coords: L.Coords }).coords;
    if (!c || Math.abs(c.x - center.x) > 1 || Math.abs(c.y - center.y) > 1) return;
    try {
      const size = 24;
      this.probe.width = this.probe.height = size;
      const ctx = this.probe.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(ev.tile as HTMLImageElement, 0, 0, size, size);
      const px = ctx.getImageData(0, 0, size, size).data;
      let cloud = 0;
      let empty = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max < 12) empty++;
        else if (max > 175 && max - min < 28) cloud++;
      }
      const n = px.length / 4;
      st.samples.push({ cloud: cloud / n, empty: empty / n });
    } catch {
      // A tainted canvas means we cannot inspect pixels; skip the analysis quietly.
    }
  }

  private evaluate(side: Side) {
    const st = this.sides[side];
    if (st.loaded === 0 && st.errors > 0) st.verdict = 'failed';
    else if (st.samples.length) {
      const avg = (k: 'cloud' | 'empty') => st.samples.reduce((n, s) => n + s[k], 0) / st.samples.length;
      const empty = avg('empty');
      const cloud = avg('cloud');
      st.verdict = empty > 0.45 ? 'nodata' : cloud > 0.7 ? 'cloudy' : 'ok';
    } else st.verdict = 'ok';

    // Today's imagery is often still arriving: step the "after" side back a day, once.
    const today = Math.floor(Date.now() / DAY) * DAY;
    if (side === 'after' && st.verdict === 'nodata' && !st.autoStepped && st.date >= today - DAY) {
      st.autoStepped = true;
      st.date -= DAY;
      if (st.date <= this.sides.before.date) this.sides.before.date = st.date - 7 * DAY;
      this.applyLayers('before');
      this.applyLayers('after');
      return;
    }
    this.renderEmpty(side);
    this.reportImagery();
  }

  private reportImagery() {
    const failedBoth = this.sides.before.verdict === 'failed' && this.sides.after.verdict === 'failed';
    (this.stage.querySelector('.cmp-failed') as HTMLElement).hidden = !failedBoth;
    this.report('gibs-imagery', {
      state: failedBoth ? 'error' : 'ok',
      count: this.totals.tiles,
      updatedAt: Date.now(),
      detail: `showing ${isoDate(this.sides.before.date)} → ${isoDate(this.sides.after.date)}`,
      message: failedBoth ? 'tiles failed to load' : undefined,
    });
  }

  private renderEmpty(side: Side) {
    const st = this.sides[side];
    const el = this.stage.querySelector<HTMLElement>(`[data-empty="${side}"]`)!;
    const text =
      st.verdict === 'nodata'
        ? 'No clear satellite pass yet: cloud cover or imagery lag.'
        : st.verdict === 'cloudy'
          ? 'Mostly cloud on this date. Try a day either side.'
          : st.verdict === 'failed'
            ? 'Imagery for this date did not load.'
            : '';
    el.hidden = !text;
    el.textContent = text;
    st.el.classList.toggle('is-dim', st.verdict === 'nodata' || st.verdict === 'failed');
  }

  private renderLabels() {
    const today = Math.floor(Date.now() / DAY) * DAY;
    for (const side of ['before', 'after'] as Side[]) {
      const st = this.sides[side];
      const label = fmtDay(st.date);
      const latest = side === 'after' && st.autoStepped && st.date < today && this.event && st.date < this.event.t0;
      this.root.querySelector(`[data-date="${side}"]`)!.textContent = label;
      this.stage.querySelector(`[data-label="${side}"]`)!.innerHTML = `${esc(side)} · ${esc(label)}${
        latest ? ' <span class="dim">(latest available)</span>' : ''
      }`;
    }
  }

  private bindDivider() {
    let dragging = false;
    const move = (clientX: number) => {
      const r = this.stage.getBoundingClientRect();
      this.split = Math.min(0.98, Math.max(0.02, (clientX - r.left) / r.width));
      this.applySplit();
    };
    this.divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.divider.addEventListener('pointermove', (e) => dragging && move(e.clientX));
    const end = (e: PointerEvent) => {
      dragging = false;
      if (this.divider.hasPointerCapture(e.pointerId)) this.divider.releasePointerCapture(e.pointerId);
    };
    this.divider.addEventListener('pointerup', end);
    this.divider.addEventListener('pointercancel', end);
    this.divider.addEventListener('keydown', (e) => {
      const steps: Record<string, number> = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 };
      if (!(e.key in steps)) return;
      e.preventDefault();
      this.split = Math.min(0.98, Math.max(0.02, this.split + steps[e.key]));
      this.applySplit();
    });
  }

  private applySplit() {
    const pct = this.split * 100;
    this.sides.after.el.style.clipPath = `inset(0 0 0 ${pct}%)`;
    this.divider.style.left = `${pct}%`;
    const before = Math.round(pct);
    this.divider.setAttribute('aria-valuenow', String(before));
    this.divider.setAttribute('aria-valuetext', `${before}% before, ${100 - before}% after`);
  }
}
