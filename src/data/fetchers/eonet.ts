import type { DisasterEvent, EventType, TrackPoint } from '../types';
import {
  BASE_SEVERITY,
  OPEN_GRACE_DAYS,
  countryFromTitle,
  fmtInt,
  stormSeverity,
  stripTrailingId,
  wildfireSeverity,
  withIsoTimes,
} from '../normalize';
import { fetchJson, fixLonLat, isoDay, nonNull } from '../util';

/*
 * NASA EONET v3 (public, CORS-enabled, no key). https://eonet.gsfc.nasa.gov/docs/v3
 *   Live:    /events?status=all&days=14
 *   History: /events?status=all&start=YYYY-MM-DD&end=YYYY-MM-DD
 */
const API = 'https://eonet.gsfc.nasa.gov/api/v3/events';
/** Matches the longest open-event grace period, so loading history never changes "now". */
const LIVE_DAYS = 14;
const DAY_MS = 86_400_000;

const CATEGORY_TYPE: Record<string, EventType> = {
  wildfires: 'wildfire',
  severeStorms: 'storm',
  volcanoes: 'volcano',
  floods: 'flood',
  drought: 'drought',
  earthquakes: 'earthquake',
};

interface EonetGeometry {
  date: string;
  type: string;
  coordinates: unknown;
  magnitudeValue: number | null;
  magnitudeUnit: string | null;
}

interface EonetEvent {
  id: string;
  title: string;
  link: string;
  closed: string | null;
  categories: { id: string; title: string }[];
  sources: { id: string; url: string }[];
  geometry: EonetGeometry[];
}

interface Observation extends TrackPoint {
  value: number | null;
  unit: string | null;
}

function lonLatOf(g: EonetGeometry): [number, number] | null {
  if (g.type === 'Point') {
    const c = g.coordinates as number[];
    return fixLonLat(c[0], c[1]);
  }
  if (g.type === 'Polygon') {
    const ring = (g.coordinates as number[][][])[0];
    if (!ring?.length) return null;
    let x = 0;
    let y = 0;
    for (const [a, b] of ring) {
      x += a;
      y += b;
    }
    return fixLonLat(x / ring.length, y / ring.length);
  }
  return null;
}

function latestValue(obs: Observation[], units: string[]): Observation | undefined {
  for (let i = obs.length - 1; i >= 0; i--) {
    const o = obs[i];
    if (o.value != null && o.unit && units.includes(o.unit)) return o;
  }
  return undefined;
}

function normalize(ev: EonetEvent, now: number): DisasterEvent | null {
  const category = ev.categories[0];
  const type: EventType = (category && CATEGORY_TYPE[category.id]) || 'other';

  const obs: Observation[] = ev.geometry
    .map((g) => {
      const ll = lonLatOf(g);
      const t = Date.parse(g.date);
      if (!ll || !Number.isFinite(t)) return null;
      return { t, lon: ll[0], lat: ll[1], value: g.magnitudeValue, unit: g.magnitudeUnit };
    })
    .filter(nonNull)
    .sort((a, b) => a.t - b.t);
  if (!obs.length) return null;

  const first = obs[0];
  const last = obs[obs.length - 1];
  const closed = ev.closed ? Date.parse(ev.closed) : NaN;
  // Some GDACS-derived EONET floods carry forecast dates; never place a start in the future.
  const t0 = Math.min(first.t, now);
  // Closed: ends when the source says. Open: active for a grace period after the last observation.
  const openUntil = last.t + OPEN_GRACE_DAYS[type] * DAY_MS;
  let t1 = Number.isFinite(closed) ? Math.max(closed, last.t, t0) : Math.max(t0, openUntil);
  let ongoing = !Number.isFinite(closed) ? openUntil > now : closed > now;
  if (type === 'earthquake') {
    t1 = t0; // instantaneous, whatever the open/closed status says
    ongoing = false;
  }

  let severity = BASE_SEVERITY[type];
  let magnitudeLabel = '';
  let detail = 1;

  if (type === 'wildfire') {
    const o = latestValue(obs, ['hectare', 'hectares', 'acres']);
    if (o?.value) {
      const ha = o.unit === 'acres' ? o.value * 0.404686 : o.value;
      severity = wildfireSeverity(ha);
      magnitudeLabel = `${fmtInt(ha)} ha burned`;
      detail++;
    }
  } else if (type === 'storm') {
    const winds = obs.filter((o) => o.unit === 'kts' && o.value != null).map((o) => o.value as number);
    if (winds.length) {
      const latest = winds[winds.length - 1];
      const peak = Math.max(...winds);
      severity = Math.max(stormSeverity(latest), 0.8 * stormSeverity(peak));
      magnitudeLabel = peak > latest ? `${fmtInt(latest)} kt winds · peak ${fmtInt(peak)} kt` : `${fmtInt(latest)} kt winds`;
      detail++;
    }
  } else {
    const o = latestValue(obs, ['NM^2', 'km^2', 'kts', 'hectare', 'acres']);
    if (o?.value) {
      magnitudeLabel = `${fmtInt(o.value)} ${o.unit === 'NM^2' ? 'NM²' : o.unit === 'km^2' ? 'km²' : o.unit}`;
      detail++;
    }
  }

  const refs = [`EONET:${ev.id}`];
  for (const s of ev.sources) {
    const m = /eventtype=(\w+)&eventid=(\d+)/i.exec(s.url ?? '');
    if (s.id === 'GDACS' && m) refs.push(`GDACS:${m[1].toUpperCase()}:${m[2]}`);
  }

  const title = stripTrailingId(ev.title);
  const track: TrackPoint[] | undefined =
    obs.length > 1 ? obs.map(({ t, lat, lon }) => ({ t, lat, lon })) : undefined;

  return withIsoTimes({
    id: `eonet:${ev.id}`,
    type,
    title,
    lat: last.lat,
    lon: last.lon,
    severity,
    magnitudeLabel,
    time: '',
    source: 'EONET',
    url: ev.sources[0]?.url || `${API}/${ev.id}`,
    t0,
    t1,
    kind: category?.title,
    sources: ['EONET'],
    refs,
    countryHint: countryFromTitle(title),
    track,
    ongoing,
    lastSeen: last.t,
    detail: detail + (track ? 1 : 0) + (ev.sources.length ? 1 : 0),
  });
}

async function query(params: Record<string, string>, timeoutMs: number): Promise<DisasterEvent[]> {
  const qs = new URLSearchParams(params);
  const data = await fetchJson<{ events: EonetEvent[] }>(`${API}?${qs}`, timeoutMs);
  const now = Date.now();
  return data.events.map((ev) => normalize(ev, now)).filter(nonNull);
}

export function fetchEonetLive(): Promise<DisasterEvent[]> {
  return query({ status: 'all', days: String(LIVE_DAYS) }, 45_000);
}

export function fetchEonetHistory(start: number, end: number): Promise<DisasterEvent[]> {
  return query({ status: 'all', start: isoDay(start), end: isoDay(end) }, 90_000);
}
