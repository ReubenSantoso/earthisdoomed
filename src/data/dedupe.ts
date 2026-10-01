import { GROUP_OF } from '../config';
import type { AlertLevel, DisasterEvent, SourceId } from './types';
import { alertRank, withIsoTimes } from './normalize';
import { haversineKm, unique, wrapLon } from './util';

/*
 * One physical event often appears in several feeds (USGS + GDACS quakes,
 * EONET's GDACS-sourced fires and floods). Merge them so each is drawn once.
 *
 *  1. Same id fetched twice (live and history overlap): the later copy wins.
 *  2. Explicit cross-references: EONET cites GDACS event ids, USGS lists every network id.
 *  3. Proximity: same type group, different sources, within ~100 km and close in time
 *     (24 h interval gap in general, 15 min for earthquakes because their times are exact
 *     and aftershocks cluster). A cluster never absorbs two records from the same source
 *     through proximity, so neighbouring aftershocks stay separate.
 *
 * The richer record (higher `detail`) supplies the content; the id comes from a fixed
 * source priority so selections survive re-polls.
 */

const MAX_KM = 100;
const QUAKE_TOLERANCE_MS = 15 * 60_000;
const DEFAULT_TOLERANCE_MS = 24 * 3_600_000;
const QUAKE_MAX_MAG_DIFF = 0.8;
const SOURCE_PRIORITY: Record<SourceId, number> = { USGS: 0, EONET: 1, GDACS: 2 };

function endOf(e: DisasterEvent, now: number) {
  return Number.isFinite(e.t1) ? e.t1 : now;
}

function timeGap(a: DisasterEvent, b: DisasterEvent, now: number) {
  return Math.max(0, Math.max(a.t0, b.t0) - Math.min(endOf(a, now), endOf(b, now)));
}

export function dedupe(input: DisasterEvent[]): DisasterEvent[] {
  const now = Date.now();

  const byId = new Map<string, DisasterEvent>();
  for (const e of input) byId.set(e.id, e);
  const events = [...byId.values()];
  const n = events.length;

  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const clusterSources = events.map((e) => new Set<SourceId>(e.sources));
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[rb] = ra;
    for (const s of clusterSources[rb]) clusterSources[ra].add(s);
  };
  const disjoint = (a: number, b: number) => {
    const sa = clusterSources[find(a)];
    for (const s of clusterSources[find(b)]) if (sa.has(s)) return false;
    return true;
  };

  // 2. explicit references
  const byRef = new Map<string, number>();
  events.forEach((e, i) => {
    for (const ref of e.refs) {
      const j = byRef.get(ref);
      if (j === undefined) byRef.set(ref, i);
      else union(j, i);
    }
  });

  // 3. proximity, bucketed on a 1° grid
  const grid = new Map<string, number[]>();
  const cell = (lat: number, lon: number) => [Math.floor(lat), Math.floor(wrapLon(lon))] as const;
  events.forEach((e, i) => {
    const [ci, cj] = cell(e.lat, e.lon);
    const key = `${ci}:${cj}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  for (let i = 0; i < n; i++) {
    const e = events[i];
    const [ci, cj] = cell(e.lat, e.lon);
    const lonCells = Math.min(180, Math.ceil(MAX_KM / (111.32 * Math.max(Math.cos((e.lat * Math.PI) / 180), 0.01))));
    let best = -1;
    let bestScore = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -lonCells; dj <= lonCells; dj++) {
        let cjj = cj + dj;
        if (cjj < -180) cjj += 360;
        if (cjj > 179) cjj -= 360;
        const bucket = grid.get(`${ci + di}:${cjj}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === i) continue;
          const o = events[j];
          if (GROUP_OF[o.type] !== GROUP_OF[e.type]) continue;
          if (e.sources.some((s) => o.sources.includes(s))) continue;
          const km = haversineKm(e.lat, e.lon, o.lat, o.lon);
          if (km > MAX_KM) continue;
          const quake = e.type === 'earthquake' || o.type === 'earthquake';
          const tolerance = quake ? QUAKE_TOLERANCE_MS : DEFAULT_TOLERANCE_MS;
          const gap = timeGap(e, o, now);
          if (gap > tolerance) continue;
          if (quake && e.mag != null && o.mag != null && Math.abs(e.mag - o.mag) > QUAKE_MAX_MAG_DIFF) continue;
          const score = km / MAX_KM + gap / tolerance;
          if (score < bestScore && disjoint(i, j)) {
            best = j;
            bestScore = score;
          }
        }
      }
    }
    if (best >= 0 && disjoint(i, best)) union(i, best);
  }

  const clusters = new Map<number, DisasterEvent[]>();
  events.forEach((e, i) => {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(e);
    else clusters.set(root, [e]);
  });

  const out: DisasterEvent[] = [];
  for (const items of clusters.values()) out.push(items.length === 1 ? items[0] : merge(items));
  return out;
}

function merge(items: DisasterEvent[]): DisasterEvent {
  const byPriority = (a: DisasterEvent, b: DisasterEvent) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
  const rich = [...items].sort((a, b) => b.detail - a.detail || byPriority(a, b));
  const best = rich[0];
  const anchor = [...items].sort((a, b) => byPriority(a, b) || a.id.localeCompare(b.id))[0];
  const first = <T>(get: (e: DisasterEvent) => T | undefined | null | ''): T | undefined => {
    for (const e of rich) {
      const v = get(e);
      if (v != null && v !== '') return v as T;
    }
    return undefined;
  };

  let alert: AlertLevel | undefined;
  for (const e of items) if (alertRank(e.alert) > alertRank(alert)) alert = e.alert;
  const tracks = items.map((e) => e.track).filter((t) => t && t.length > 1);
  tracks.sort((a, b) => b!.length - a!.length);

  return withIsoTimes({
    ...best,
    id: anchor.id,
    magnitudeLabel: first((e) => e.magnitudeLabel) ?? '',
    url: first((e) => e.url) ?? best.url,
    severity: Math.max(...items.map((e) => e.severity)),
    alert,
    t0: Math.min(...items.map((e) => e.t0)),
    t1: Math.max(...items.map((e) => e.t1)),
    mag: first((e) => e.mag),
    kind: first((e) => e.kind),
    countryHint: first((e) => e.countryHint),
    track: tracks[0],
    ongoing: items.some((e) => e.ongoing),
    lastSeen: Math.max(...items.map((e) => e.lastSeen ?? e.t0)),
    sources: unique(items.flatMap((e) => e.sources)).sort((a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b]),
    refs: unique(items.flatMap((e) => e.refs)),
    detail: Math.max(...items.map((e) => e.detail)),
  });
}
