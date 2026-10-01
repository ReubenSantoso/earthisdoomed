import {
  COLD_RETRY_MS,
  HISTORY_CHUNK_MS,
  LIVE_POLL_MS,
  QUAKE_HISTORY_MIN_MAG,
  RANGE_CHUNKS,
} from '../config';
import { dedupe } from './dedupe';
import { fetchEonetHistory, fetchEonetLive } from './fetchers/eonet';
import { fetchGdacsHistory, fetchGdacsLive } from './fetchers/gdacs';
import { fetchUsgsHistory, fetchUsgsLive } from './fetchers/usgs';
import { allCountries, loadCountries, tagEvents } from './geotag';
import type { Store } from './store';
import type { StreamId, StreamStatus } from './streams';
import type { DisasterEvent, RangeKey, SourceId } from './types';
import { unique } from './util';

export const SOURCES: SourceId[] = ['USGS', 'EONET', 'GDACS'];

const LIVE: Record<SourceId, () => Promise<DisasterEvent[]>> = {
  USGS: fetchUsgsLive,
  EONET: fetchEonetLive,
  GDACS: fetchGdacsLive,
};

const LIVE_STREAM: Record<SourceId, StreamId> = { USGS: 'usgs-live', EONET: 'eonet-live', GDACS: 'gdacs-live' };
const HISTORY_STREAM: Record<SourceId, StreamId> = {
  USGS: 'usgs-history',
  EONET: 'eonet-history',
  GDACS: 'gdacs-history',
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Owns all network access.
 *  - Live feeds: polled every 5 minutes, skipped while the tab is hidden, each source isolated.
 *  - History: fetched lazily in 30-day chunks, newest first, strictly one request at a time,
 *    cached in memory for the session. Failed chunks are not cached, so a later toggle retries.
 */
export class DataPipeline {
  private live: Partial<Record<SourceId, DisasterEvent[]>> = {};
  private history = new Map<string, DisasterEvent[]>();
  private pollTimer: number | undefined;
  private lastPollAt = 0;
  private polling = false;
  /** History chunk boundaries are fixed at load so cached chunks never shift. */
  private readonly anchor = Date.now();
  private historyQueue: Promise<void> = Promise.resolve();
  private rebuildPending: Promise<void> | null = null;
  private rebuildTail: Promise<void> = Promise.resolve();

  constructor(private store: Store) {}

  start() {
    void this.poll();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - this.lastPollAt > LIVE_POLL_MS) void this.poll();
    });
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    window.clearTimeout(this.pollTimer);
    this.lastPollAt = Date.now();
    try {
      await Promise.all(SOURCES.map((id) => this.pollSource(id)));
      await this.rebuild();
      const streams = this.store.get().streams;
      if (SOURCES.some((id) => streams[LIVE_STREAM[id]].state === 'ok')) this.store.set({ lastLiveUpdate: Date.now() });
      this.store.set({ firstLoadDone: true });
    } finally {
      this.polling = false;
      const s = this.store.get();
      const cold = s.events.length === 0 && SOURCES.every((id) => s.streams[LIVE_STREAM[id]].state === 'error');
      this.pollTimer = window.setTimeout(
        () => {
          if (document.visibilityState === 'visible') void this.poll();
        },
        cold ? COLD_RETRY_MS : LIVE_POLL_MS,
      );
    }
  }

  setStream(id: StreamId, patch: Partial<StreamStatus>) {
    const streams = this.store.get().streams;
    this.store.set({ streams: { ...streams, [id]: { ...streams[id], ...patch } } });
  }

  private async pollSource(id: SourceId) {
    const stream = LIVE_STREAM[id];
    if (!this.live[id]) this.setStream(stream, { state: 'loading' });
    try {
      const events = await LIVE[id]();
      this.live[id] = events;
      this.setStream(stream, { state: 'ok', updatedAt: Date.now(), count: events.length, message: undefined });
    } catch (err) {
      // Keep whatever this source gave us last time; just mark it unavailable.
      console.warn(`[${id}] live feed unavailable: ${message(err)}`);
      this.setStream(stream, { state: 'error', message: message(err) });
    }
  }

  /** Summarise what history each source has contributed so far. */
  private reportHistory(loading: Set<SourceId>, failed: Set<SourceId>) {
    for (const id of SOURCES) {
      let count = 0;
      let chunks = 0;
      for (const [key, list] of this.history) {
        if (!key.startsWith(`${id}:`)) continue;
        count += list.length;
        chunks++;
      }
      if (!chunks && !loading.has(id) && !failed.has(id)) continue;
      const months = this.loadedMonths(id);
      this.setStream(HISTORY_STREAM[id], {
        state: loading.has(id) ? 'loading' : failed.has(id) && !chunks ? 'error' : 'ok',
        count,
        updatedAt: chunks ? Date.now() : undefined,
        detail: months ? `${months === 1 ? 'last 30 days' : `last ${months} months`}${failed.has(id) ? ', partly unavailable' : ''}` : undefined,
        message: failed.has(id) ? 'some requests failed; they will be retried next time this range is opened' : undefined,
      });
    }
  }

  private loadedMonths(id: SourceId): number {
    if (id === 'GDACS') {
      const alerts = [...this.history.keys()].find((k) => k.startsWith('GDACS:alerts:'));
      return alerts ? Number(alerts.split(':')[2]) : this.history.has('GDACS:0') ? 1 : 0;
    }
    let n = 0;
    while (this.history.has(`${id}:${n}`)) n++;
    return n;
  }

  /** Queue loading the history a range needs. Safe to call repeatedly. */
  ensureRange(range: RangeKey): Promise<void> {
    this.historyQueue = this.historyQueue.then(() => this.loadRange(range));
    return this.historyQueue;
  }

  private async loadRange(range: RangeKey) {
    const chunks = RANGE_CHUNKS[range];
    const jobs: { key: string; run: () => Promise<DisasterEvent[]> }[] = [];
    for (let i = 0; i < chunks; i++) {
      const end = this.anchor - i * HISTORY_CHUNK_MS;
      const start = end - HISTORY_CHUNK_MS;
      jobs.push({ key: `USGS:${i}`, run: () => fetchUsgsHistory(start, end, QUAKE_HISTORY_MIN_MAG) });
      jobs.push({ key: `EONET:${i}`, run: () => fetchEonetHistory(start, end) });
      if (i === 0) jobs.push({ key: 'GDACS:0', run: () => fetchGdacsHistory(start, end, false) });
    }
    if (chunks > 1) {
      const end = this.anchor - HISTORY_CHUNK_MS;
      const start = this.anchor - chunks * HISTORY_CHUNK_MS;
      jobs.push({ key: `GDACS:alerts:${chunks}`, run: () => fetchGdacsHistory(start, end, true) });
    }

    const pending = jobs.filter((j) => !this.history.has(j.key));
    if (!pending.length) return;
    let done = jobs.length - pending.length;
    this.store.set({ historyLoading: { done, total: jobs.length, range }, historyNote: null });
    const loading = new Set(pending.map((j) => j.key.split(':')[0] as SourceId));
    const failed = new Set<SourceId>();
    this.reportHistory(loading, failed);
    for (const job of pending) {
      const source = job.key.split(':')[0] as SourceId;
      try {
        this.history.set(job.key, await job.run());
      } catch (err) {
        failed.add(source);
        console.warn(`[history] ${job.key} unavailable: ${message(err)}`);
      }
      done++;
      if (!pending.slice(pending.indexOf(job) + 1).some((j) => j.key.startsWith(`${source}:`))) loading.delete(source);
      this.reportHistory(loading, failed);
      this.store.set({ historyLoading: { done, total: jobs.length, range } });
      void this.rebuild();
    }
    await this.rebuild();
    this.store.set({
      historyLoading: null,
      historyNote: failed.size ? `history partly unavailable: ${unique(failed).join(', ')}` : null,
    });
  }

  /** Merge everything loaded so far. Calls are serialised and coalesced. */
  rebuild(): Promise<void> {
    if (this.rebuildPending) return this.rebuildPending;
    const run = this.rebuildTail.then(async () => {
      this.rebuildPending = null;
      const bordersOk = await loadCountries();
      if (this.store.get().streams['natural-earth'].state === 'idle') {
        this.setStream(
          'natural-earth',
          bordersOk
            ? { state: 'ok', updatedAt: Date.now(), count: allCountries().length, detail: 'bundled locally' }
            : { state: 'error', message: 'public/data/countries-50m.geojson missing; run npm run fetch:geo' },
        );
      }
      const all: DisasterEvent[] = [];
      for (const list of this.history.values()) all.push(...list);
      for (const id of SOURCES) all.push(...(this.live[id] ?? []));
      await tagEvents(all);
      const events = dedupe(all);
      this.store.set({ events, eventsVersion: this.store.get().eventsVersion + 1 });
    });
    this.rebuildPending = run;
    this.rebuildTail = run.catch((err) => console.error('[pipeline] rebuild failed', err));
    return run;
  }
}
