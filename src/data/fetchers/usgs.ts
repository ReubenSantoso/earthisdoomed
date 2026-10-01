import type { DisasterEvent, EventType } from '../types';
import { fmtInt, quakeSeverity, withIsoTimes } from '../normalize';
import { fetchJson, isoSecond, nonNull } from '../util';

/*
 * USGS Earthquake Hazards Program (public, CORS-enabled, no key).
 *   Live:    GeoJSON summary feed, "all earthquakes, past day" (updated every minute by USGS).
 *            https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 *   History: FDSN event web service, M4.5+ only.
 *            https://earthquake.usgs.gov/fdsnws/event/1/
 */
const LIVE_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const FDSN_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    url: string;
    felt: number | null;
    alert: string | null;
    tsunami: number | null;
    ids: string | null;
    type: string;
    title: string | null;
    magType: string | null;
  };
  geometry: { coordinates: [number, number, number?] } | null;
}

interface UsgsCollection {
  features: UsgsFeature[];
}

function normalize(f: UsgsFeature): DisasterEvent | null {
  const p = f.properties;
  let type: EventType;
  if (p.type === 'earthquake') type = 'earthquake';
  else if (p.type === 'volcanic eruption') type = 'volcano';
  else return null; // quarry blasts, explosions, ice quakes, sonic booms: not natural hazards

  const coords = f.geometry?.coordinates;
  if (!coords) return null;
  const [lon, lat, depth] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const mag = typeof p.mag === 'number' ? p.mag : undefined;
  const depthLabel = typeof depth === 'number' ? ` · ${fmtInt(depth)} km deep` : '';
  const refs = (p.ids ?? '')
    .split(',')
    .filter(Boolean)
    .map((id) => `USGS:${id}`);

  return withIsoTimes({
    id: `usgs:${f.id}`,
    type,
    title: p.place || p.title || 'Earthquake',
    lat,
    lon,
    severity: mag != null ? quakeSeverity(mag, p.alert, p.tsunami) : 0.15,
    magnitudeLabel: mag != null ? `M ${mag.toFixed(1)}${depthLabel}` : `magnitude pending${depthLabel}`,
    time: '',
    source: 'USGS',
    url: p.url,
    t0: p.time,
    t1: p.time,
    kind: p.magType ? `magnitude type ${p.magType}` : undefined,
    mag,
    sources: ['USGS'],
    refs: refs.length ? refs : [`USGS:${f.id}`],
    // Precise place names, magnitude type and depth: the richest earthquake record.
    detail: 5 + (mag != null ? 1 : 0) + (p.felt ? 1 : 0) + (p.alert ? 1 : 0),
  });
}

export async function fetchUsgsLive(): Promise<DisasterEvent[]> {
  const data = await fetchJson<UsgsCollection>(LIVE_FEED);
  return data.features.map(normalize).filter(nonNull);
}

export async function fetchUsgsHistory(start: number, end: number, minMagnitude: number): Promise<DisasterEvent[]> {
  const params = new URLSearchParams({
    format: 'geojson',
    starttime: isoSecond(start),
    endtime: isoSecond(end),
    minmagnitude: String(minMagnitude),
    eventtype: 'earthquake',
    orderby: 'time',
  });
  const data = await fetchJson<UsgsCollection>(`${FDSN_QUERY}?${params}`, 60_000);
  return data.features.map(normalize).filter(nonNull);
}
