import { DAY, GROUPS, GROUP_OF, QUAKE_HISTORY_MIN_MAG, WINDOW_MS } from '../config';
import type { DisasterEvent, LegendGroup } from './types';

/** Active at some point inside (cursor - window, cursor]. */
export function isActive(e: DisasterEvent, cursor: number, windowMs = WINDOW_MS): boolean {
  return e.t0 <= cursor && e.t1 > cursor - windowMs;
}

/** 1 while active, fading to 0 over the window after the event ends. Mirrors the point shader. */
export function presence(e: DisasterEvent, cursor: number, windowMs = WINDOW_MS): number {
  if (cursor < e.t0) return 0;
  const age = cursor - e.t1;
  if (age <= 0) return 1;
  return Math.max(0, 1 - age / windowMs) ** 0.7;
}

export const emptyCounts = (): Record<LegendGroup, number> =>
  Object.fromEntries(GROUPS.map((g) => [g.id, 0])) as Record<LegendGroup, number>;

let memo: { events: DisasterEvent[]; cursor: number; filters: unknown; result: DisasterEvent[] } | null = null;

/** Events in the window that pass the legend filters, most severe first. */
export function visibleEvents(
  events: DisasterEvent[],
  cursor: number,
  filters: Record<LegendGroup, boolean>,
): DisasterEvent[] {
  if (memo && memo.events === events && memo.cursor === cursor && memo.filters === filters) return memo.result;
  const result = events.filter((e) => filters[GROUP_OF[e.type]] && isActive(e, cursor));
  result.sort((a, b) => b.severity - a.severity);
  memo = { events, cursor, filters, result };
  return result;
}

/** Window counts per group, ignoring filters (so the legend can show what a filter hides). */
export function groupCounts(events: DisasterEvent[], cursor: number): Record<LegendGroup, number> {
  const counts = emptyCounts();
  for (const e of events) if (isActive(e, cursor)) counts[GROUP_OF[e.type]]++;
  return counts;
}

export interface CountryStat {
  key: string;
  region: string;
  count: number;
  byGroup: Record<LegendGroup, number>;
  /** Sum of the three highest severities: favours places with several serious events. */
  score: number;
  maxSeverity: number;
  events: DisasterEvent[];
}

export function countryStats(visible: DisasterEvent[]): CountryStat[] {
  const map = new Map<string, CountryStat>();
  for (const e of visible) {
    const key = e.countryKey ?? 'Unknown';
    let s = map.get(key);
    if (!s) {
      s = { key, region: e.region ?? 'Unknown', count: 0, byGroup: emptyCounts(), score: 0, maxSeverity: 0, events: [] };
      map.set(key, s);
    }
    s.count++;
    s.byGroup[GROUP_OF[e.type]]++;
    s.events.push(e);
    // Prefer the on-land region label when a country has both land and ocean events.
    if (!e.offshore && e.region) s.region = e.region;
  }
  for (const s of map.values()) {
    s.events.sort((a, b) => b.severity - a.severity);
    s.maxSeverity = s.events[0]?.severity ?? 0;
    s.score = s.events.slice(0, 3).reduce((sum, e) => sum + e.severity, 0);
  }
  return [...map.values()].sort((a, b) => b.score - a.score || b.count - a.count);
}

export interface DayBin {
  start: number;
  total: number;
  counts: Record<LegendGroup, number>;
}

/**
 * New events per UTC day, for the density strip. Earthquakes below the history floor are
 * excluded so the live day (which includes small quakes) compares fairly with the past.
 */
export function densityByDay(events: DisasterEvent[], rangeStart: number, rangeEnd: number): DayBin[] {
  const first = Math.floor(rangeStart / DAY) * DAY;
  const days = Math.max(1, Math.ceil((rangeEnd - first) / DAY));
  const bins: DayBin[] = Array.from({ length: days }, (_, i) => ({ start: first + i * DAY, total: 0, counts: emptyCounts() }));
  for (const e of events) {
    if (e.t0 < first || e.t0 > rangeEnd) continue;
    if (e.type === 'earthquake' && (e.mag ?? 0) < QUAKE_HISTORY_MIN_MAG) continue;
    const bin = bins[Math.floor((e.t0 - first) / DAY)];
    if (!bin) continue;
    bin.total++;
    bin.counts[GROUP_OF[e.type]]++;
  }
  return bins;
}
