import type { AlertLevel, DisasterEvent, EventType } from '../types';
import {
  BASE_SEVERITY,
  OPEN_GRACE_DAYS,
  alertFloor,
  fmtInt,
  quakeSeverity,
  stormSeverity,
  wildfireSeverity,
  withIsoTimes,
} from '../normalize';
import { DAY } from '../../config';
import { fetchJson, fixLonLat, isoDay, nonNull, parseUtc } from '../util';

/*
 * GDACS (Global Disaster Alert and Coordination System), public event SEARCH API
 * as documented at https://www.gdacs.org/gdacsapi/swagger/index.html
 * GDACS sends no CORS headers, so requests go through a caching proxy at /api/gdacs/search:
 * vite.config.ts in development, api/gdacs/search.js (a Vercel function) when deployed.
 *
 * To keep load low:
 *  - live wildfires are limited to the last 3 days; history wildfires to orange/red alerts
 *    (EONET already republishes GDACS's green fires for the past)
 *  - paging stops at the first short page, with a hard page cap per query
 *  - history beyond 30 days asks for orange/red alerts only
 */
const ENDPOINT = '/api/gdacs/search';
const PAGE_SIZE = 100;

const TYPE_OF: Record<string, EventType> = {
  EQ: 'earthquake',
  TC: 'storm',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
  TS: 'other',
};

interface GdacsFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    eventtype: string;
    eventid: number;
    episodeid?: number;
    name?: string;
    eventname?: string;
    alertlevel?: string;
    country?: string;
    fromdate?: string;
    todate?: string;
    datemodified?: string;
    iscurrent?: string;
    sourceid?: string;
    url?: { report?: string };
    severitydata?: { severity?: number; severitytext?: string; severityunit?: string };
  };
}

interface SearchParams {
  eventlist: string;
  alertlevel: string;
  fromDate: string;
  toDate: string;
}

async function search(params: SearchParams, maxPages: number): Promise<GdacsFeature[]> {
  const out: GdacsFeature[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({ ...params, pageSize: String(PAGE_SIZE), pageNumber: String(page) });
    let features: GdacsFeature[];
    try {
      const data = await fetchJson<{ features?: GdacsFeature[] }>(`${ENDPOINT}?${qs}`, 45_000);
      features = data.features ?? [];
    } catch (err) {
      // Past the last page GDACS may answer with an error instead of an empty list.
      if (page > 1) break;
      throw err;
    }
    out.push(...features);
    if (features.length < PAGE_SIZE) break;
  }
  return out;
}

function lonLatOf(geometry: GdacsFeature['geometry']): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const c = geometry.coordinates as number[];
    return fixLonLat(c[0], c[1]);
  }
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    const flat = JSON.stringify(geometry.coordinates).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    let x = 0;
    let y = 0;
    let n = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      n++;
    }
    return n ? fixLonLat(x / n, y / n) : null;
  }
  return null;
}

function normalize(f: GdacsFeature, fetchedAt: number): DisasterEvent | null {
  const p = f.properties;
  const type = TYPE_OF[p.eventtype];
  if (!type) return null;
  const ll = lonLatOf(f.geometry);
  if (!ll) return null;

  const alert = (p.alertlevel?.toLowerCase() || undefined) as AlertLevel | undefined;
  const from = parseUtc(p.fromdate);
  const to = parseUtc(p.todate);
  if (!Number.isFinite(from)) return null;
  const t0 = Math.min(from, fetchedAt);
  // Earthquakes are instantaneous: GDACS's "iscurrent" only means the alert is still listed.
  const instant = type === 'earthquake';
  let t1 = Number.isFinite(to) && !instant ? Math.max(to, t0) : t0;
  // Other "iscurrent" events are still unfolding: keep them active through the time we fetched
  // them, but only within the same grace period used for EONET's open events.
  const current = p.iscurrent === 'true' && !instant;
  if (current) t1 = Math.max(t1, Math.min(fetchedAt, t1 + OPEN_GRACE_DAYS[type] * DAY));

  const sev = p.severitydata?.severity;
  const sevText = (p.severitydata?.severitytext ?? '').trim();
  let severity = BASE_SEVERITY[type];
  let magnitudeLabel = '';
  let mag: number | undefined;

  switch (type) {
    case 'earthquake': {
      if (typeof sev === 'number' && sev > 0) {
        mag = sev;
        severity = quakeSeverity(sev);
        const depth = /Depth:\s*([\d.]+)\s*km/i.exec(sevText);
        magnitudeLabel = `M ${sev.toFixed(1)}${depth ? ` · ${fmtInt(Number(depth[1]))} km deep` : ''}`;
      }
      break;
    }
    case 'storm': {
      if (typeof sev === 'number' && sev > 0) {
        severity = stormSeverity(sev / 1.852);
        const category = sevText.replace(/\s*\(.*$/, '');
        magnitudeLabel = `${category ? `${category} · ` : ''}max ${fmtInt(sev)} km/h winds`;
      }
      break;
    }
    case 'wildfire': {
      if (typeof sev === 'number' && sev > 0) {
        severity = wildfireSeverity(sev);
        magnitudeLabel = `${fmtInt(sev)} ha burned`;
      }
      break;
    }
    default:
      if (sevText && !/^magnitude 0\b/i.test(sevText)) magnitudeLabel = sevText;
  }
  severity = Math.max(severity, alertFloor(alert));

  const refs = [`GDACS:${p.eventtype}:${p.eventid}`];
  if (type === 'earthquake' && p.sourceid && /^[a-z]{2}[a-z0-9]{6,}$/i.test(p.sourceid)) {
    refs.push(`USGS:${p.sourceid}`);
  }
  const report = p.url?.report ?? `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}`;

  return withIsoTimes({
    id: `gdacs:${p.eventtype}:${p.eventid}`,
    type,
    title: p.name || p.eventname || `${type} event`,
    lat: ll[1],
    lon: ll[0],
    severity,
    magnitudeLabel,
    time: '',
    source: 'GDACS',
    url: report,
    t0,
    t1,
    kind: type === 'storm' ? 'Tropical cyclone' : undefined,
    mag,
    alert,
    sources: ['GDACS'],
    refs,
    countryHint: p.country?.split(',')[0]?.trim() || undefined,
    ongoing: current && t1 >= fetchedAt - DAY,
    lastSeen: Number.isFinite(to) ? Math.min(to, fetchedAt) : t0,
    detail: 1 + (alert ? 2 : 0) + (sevText ? 1 : 0) + (p.country ? 1 : 0) + (Number.isFinite(to) ? 1 : 0),
  });
}

/** One record per GDACS event: keep the latest episode. */
function latestEpisodes(features: GdacsFeature[]): GdacsFeature[] {
  const byEvent = new Map<string, GdacsFeature>();
  for (const f of features) {
    const key = `${f.properties.eventtype}:${f.properties.eventid}`;
    const prev = byEvent.get(key);
    if (!prev || (f.properties.episodeid ?? 0) > (prev.properties.episodeid ?? 0)) byEvent.set(key, f);
  }
  return [...byEvent.values()];
}

async function run(queries: { params: SearchParams; maxPages: number }[]): Promise<DisasterEvent[]> {
  const features: GdacsFeature[] = [];
  // Sequential on purpose: one GDACS request at a time.
  for (const q of queries) features.push(...(await search(q.params, q.maxPages)));
  const fetchedAt = Date.now();
  return latestEpisodes(features)
    .map((f) => normalize(f, fetchedAt))
    .filter(nonNull);
}

export function fetchGdacsLive(): Promise<DisasterEvent[]> {
  const now = Date.now();
  const toDate = isoDay(now + DAY);
  return run([
    {
      params: { eventlist: 'EQ;TC;FL;VO;DR', alertlevel: 'green;orange;red', fromDate: isoDay(now - 7 * DAY), toDate },
      maxPages: 4,
    },
    // Fires with burn detections in the last 3 days, any alert level: EONET's copies of these
    // are often already closed, so GDACS is the fresher record of what is burning now.
    { params: { eventlist: 'WF', alertlevel: 'green;orange;red', fromDate: isoDay(now - 3 * DAY), toDate }, maxPages: 2 },
  ]);
}

/** Full detail for the most recent month; orange/red alerts only further back. */
export function fetchGdacsHistory(start: number, end: number, alertsOnly: boolean): Promise<DisasterEvent[]> {
  const fromDate = isoDay(start);
  const toDate = isoDay(end);
  if (alertsOnly) {
    return run([
      { params: { eventlist: 'EQ;TC;FL;VO;DR;WF', alertlevel: 'orange;red', fromDate, toDate }, maxPages: 6 },
    ]);
  }
  return run([
    { params: { eventlist: 'EQ;TC;FL;VO;DR', alertlevel: 'green;orange;red', fromDate, toDate }, maxPages: 8 },
    { params: { eventlist: 'WF', alertlevel: 'orange;red', fromDate, toDate }, maxPages: 2 },
  ]);
}
