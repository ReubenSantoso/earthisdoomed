import { DAY, GROUPS, HOUR, QUAKE_HISTORY_MIN_MAG, WINDOW_MS, groupCount } from '../config';
import { densityByDay, type DayBin } from '../data/derive';
import type { Store } from '../data/store';
import type { DisasterEvent, RangeKey } from '../data/types';
import { rgba } from '../globe/geo';
import { esc } from './dom';
import { fmtCount, fmtDay, fmtUtc } from './format';

const RANGE_MS: Record<RangeKey, number> = { '30d': 30 * DAY, '1y': 365 * DAY };
/** Timeline time per real second at 1×: either range plays through in about a minute. */
const BASE_RATE: Record<RangeKey, number> = { '30d': 12 * HOUR, '1y': 6 * DAY };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>';

/**
 * Bottom scrubber. Dragging moves the end of a 24-hour window back in time; points
 * appear at their time and fade over the following day. Above it, a density strip
 * of new events per day, in the spirit of warming stripes.
 */
export class Timeline {
  private range: HTMLInputElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLElement;
  private note: HTMLElement;
  private ticks: HTMLElement;
  private playBtn: HTMLButtonElement;
  private liveBtn: HTMLButtonElement;
  private bins: DayBin[] = [];
  private maxBin = 1;
  private hoverBin: DayBin | null = null;
  private now = Date.now();
  private events: DisasterEvent[] = [];

  constructor(
    private el: HTMLElement,
    private store: Store,
    private ensureRange: (range: RangeKey) => void,
  ) {
    el.innerHTML = `
      <div class="tl-controls">
        <button type="button" class="tl-play" aria-label="Play the timeline">${PLAY}</button>
        <div class="tl-speed seg" role="group" aria-label="Playback speed">
          <button type="button" data-speed="0.25" aria-pressed="false">¼×</button>
          <button type="button" data-speed="1" aria-pressed="true">1×</button>
          <button type="button" data-speed="4" aria-pressed="false">4×</button>
        </div>
      </div>
      <div class="tl-main">
        <div class="tl-head">
          <span class="tl-readout mono" aria-live="off"></span>
          <span class="tl-note mono" aria-live="polite"></span>
          <span class="status" id="status"></span>
        </div>
        <div class="tl-track">
          <canvas class="tl-density" title="New events per day (earthquakes M${QUAKE_HISTORY_MIN_MAG}+ so days compare fairly)"></canvas>
          <input class="tl-range" type="range" min="0" max="720" step="1" value="720" aria-label="Timeline: end of the 24-hour window" />
        </div>
        <div class="tl-ticks mono" aria-hidden="true"></div>
      </div>
      <div class="tl-side">
        <button type="button" class="tl-live" aria-pressed="true" title="Return to now">Live</button>
        <div class="tl-ranges seg" role="group" aria-label="Timeline range">
          <button type="button" data-range="30d" aria-pressed="true">30 days</button>
          <button type="button" data-range="1y" aria-pressed="false">1 year</button>
        </div>
      </div>`;

    this.range = el.querySelector('.tl-range')!;
    this.canvas = el.querySelector('.tl-density')!;
    this.readout = el.querySelector('.tl-readout')!;
    this.note = el.querySelector('.tl-note')!;
    this.ticks = el.querySelector('.tl-ticks')!;
    this.playBtn = el.querySelector('.tl-play')!;
    this.liveBtn = el.querySelector('.tl-live')!;

    this.range.addEventListener('input', () => this.setFromSlider(Number(this.range.value)));
    this.range.addEventListener('keydown', (e) => this.onKey(e));
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.liveBtn.addEventListener('click', () =>
      this.store.set({ live: true, cursor: Date.now(), playing: false }),
    );
    el.querySelector('.tl-speed')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-speed]');
      if (b) this.store.set({ speed: Number(b.dataset.speed) });
    });
    el.querySelector('.tl-ranges')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-range]');
      if (!b) return;
      const range = b.dataset.range as RangeKey;
      const start = this.now - RANGE_MS[range];
      const s = this.store.get();
      this.store.set({ range, cursor: Math.max(s.cursor, start + WINDOW_MS) });
      this.ensureRange(range);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.hoverBin = this.binAt(e.clientX);
      this.renderReadout();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverBin = null;
      this.renderReadout();
    });
    this.canvas.addEventListener('click', (e) => {
      const bin = this.binAt(e.clientX);
      if (!bin) return;
      const end = Math.min(bin.start + DAY, this.now);
      this.store.set({ cursor: end, live: end >= this.now - HOUR, playing: false });
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  private get rangeStart() {
    return this.now - RANGE_MS[this.store.get().range];
  }

  setNow(now: number) {
    this.now = now;
  }

  setEvents(events: DisasterEvent[]) {
    this.events = events;
    this.rebin();
  }

  /** Recompute density bins (events changed, range changed, or the day rolled over). */
  rebin() {
    this.bins = densityByDay(this.events, this.rangeStart, this.now);
    this.maxBin = Math.max(1, ...this.bins.map((b) => b.total));
    this.renderTicks();
    this.sync();
  }

  private setFromSlider(hours: number) {
    const max = Number(this.range.max);
    const live = hours >= max - 0.5;
    this.store.set({ cursor: live ? this.now : this.rangeStart + hours * HOUR, live, playing: false });
  }

  private onKey(e: KeyboardEvent) {
    const s = this.store.get();
    const small = s.range === '30d' ? HOUR : DAY;
    const big = s.range === '30d' ? DAY : 7 * DAY;
    let delta = 0;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        delta = -(e.shiftKey ? big : small);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        delta = e.shiftKey ? big : small;
        break;
      case 'PageDown':
        delta = -big;
        break;
      case 'PageUp':
        delta = big;
        break;
      case 'Home':
        this.store.set({ cursor: this.rangeStart + WINDOW_MS, live: false, playing: false });
        e.preventDefault();
        return;
      case 'End':
        this.store.set({ cursor: this.now, live: true, playing: false });
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    const cursor = Math.min(this.now, Math.max(this.rangeStart, s.cursor + delta));
    this.store.set({ cursor, live: cursor >= this.now - HOUR / 2, playing: false });
  }

  private togglePlay() {
    const s = this.store.get();
    if (s.playing) return this.store.set({ playing: false });
    const atEnd = s.live || s.cursor >= this.now - HOUR;
    this.store.set({ playing: true, live: false, cursor: atEnd ? this.rangeStart + WINDOW_MS : s.cursor });
  }

  /** Advance playback. Called every animation frame. */
  frame(dt: number) {
    const s = this.store.get();
    if (!s.playing) return;
    const cursor = s.cursor + dt * BASE_RATE[s.range] * s.speed;
    if (cursor >= this.now) this.store.set({ cursor: this.now, live: true, playing: false });
    else this.store.set({ cursor });
  }

  /** Reflect store state in the controls. */
  sync() {
    const s = this.store.get();
    const max = Math.round(RANGE_MS[s.range] / HOUR);
    if (this.range.max !== String(max)) this.range.max = String(max);
    const value = Math.round((s.cursor - this.rangeStart) / HOUR);
    if (document.activeElement !== this.range || s.playing) this.range.value = String(value);
    else if (Math.abs(Number(this.range.value) - value) > 1) this.range.value = String(value);
    this.range.setAttribute('aria-valuetext', `${fmtUtc(s.cursor)}${s.live ? ', live' : ''}`);

    this.playBtn.innerHTML = s.playing ? PAUSE : PLAY;
    this.playBtn.setAttribute('aria-label', s.playing ? 'Pause the timeline' : 'Play the timeline');
    this.playBtn.classList.toggle('is-on', s.playing);
    this.liveBtn.setAttribute('aria-pressed', String(s.live));
    this.liveBtn.textContent = s.live ? 'Live' : 'Back to live';
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s.speed));
    }
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-range]')) {
      b.setAttribute('aria-pressed', String(b.dataset.range === s.range));
    }
    const loading = s.historyLoading;
    this.note.textContent = loading
      ? `loading ${loading.range === '1y' ? 'a year of' : '30 days of'} history · ${loading.done}/${loading.total}`
      : (s.historyNote ?? '');
    this.renderReadout();
    this.draw();
  }

  private renderReadout() {
    const s = this.store.get();
    if (this.hoverBin) {
      const b = this.hoverBin;
      const parts = GROUPS.filter((g) => b.counts[g.id]).map((g) => groupCount(g.id, b.counts[g.id]));
      this.readout.innerHTML = `${esc(fmtDay(b.start))}: ${fmtCount(b.total)} new <span class="dim">${esc(parts.join(', '))}</span>`;
      return;
    }
    this.readout.innerHTML = s.live
      ? `<span class="live-dot" aria-hidden="true"></span>live · ${esc(fmtUtc(s.cursor))}`
      : esc(fmtUtc(s.cursor));
  }

  private binAt(clientX: number): DayBin | null {
    const r = this.canvas.getBoundingClientRect();
    const t = this.rangeStart + ((clientX - r.left) / r.width) * (this.now - this.rangeStart);
    return this.bins.find((b) => t >= b.start && t < b.start + DAY) ?? null;
  }

  private renderTicks() {
    const s = this.store.get();
    const start = this.rangeStart;
    const span = this.now - start;
    const out: string[] = [];
    if (s.range === '30d') {
      const first = Math.ceil(start / DAY) * DAY;
      for (let t = first; t <= this.now; t += DAY) {
        const d = new Date(t);
        if (d.getUTCDay() !== 1) continue; // Mondays
        out.push(`<span style="left:${(((t - start) / span) * 100).toFixed(2)}%">${fmtDay(t)}</span>`);
      }
    } else {
      const d = new Date(start);
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      while (t <= this.now) {
        const m = new Date(t);
        const label = m.getUTCMonth() === 0 ? String(m.getUTCFullYear()) : MONTHS[m.getUTCMonth()];
        out.push(`<span style="left:${(((t - start) / span) * 100).toFixed(2)}%">${label}</span>`);
        t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1);
      }
    }
    this.ticks.innerHTML = out.join('');
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const start = this.rangeStart;
    const span = this.now - start;
    const x = (t: number) => ((t - start) / span) * w;
    const s = this.store.get();

    // The visible 24-hour window.
    const x0 = Math.max(0, x(s.cursor - WINDOW_MS));
    const x1 = Math.min(w, x(s.cursor));
    ctx.fillStyle = 'rgba(220,228,236,0.07)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);

    for (const bin of this.bins) {
      const bx0 = Math.max(0, x(bin.start));
      const bx1 = Math.min(w, x(bin.start + DAY));
      const bw = bx1 - bx0;
      if (bw <= 0) continue;
      const gap = bw > 4 ? 1 : bw > 2 ? 0.5 : 0;
      if (!bin.total) {
        ctx.fillStyle = 'rgba(220,228,236,0.08)';
        ctx.fillRect(bx0 + gap, h - 1, bw - gap * 2, 1);
        continue;
      }
      const inWindow = bin.start + DAY > s.cursor - WINDOW_MS && bin.start <= s.cursor;
      const total = Math.sqrt(bin.total / this.maxBin) * (h - 2);
      let y = h;
      for (const g of GROUPS) {
        const n = bin.counts[g.id];
        if (!n) continue;
        const seg = (total * n) / bin.total;
        ctx.fillStyle = rgba(g.color, inWindow ? 0.95 : 0.55);
        ctx.fillRect(bx0 + gap, y - seg, Math.max(0.5, bw - gap * 2), seg);
        y -= seg;
      }
    }

    ctx.fillStyle = 'rgba(236,240,244,0.85)';
    ctx.fillRect(Math.min(w - 1, x1) - 0.5, 0, 1, h);
  }
}
