import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import type { FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import type { DisasterEvent } from './types';
import { DEG, clamp01, wrapLon, yieldToMain } from './util';

/*
 * Country / region tagging against Natural Earth admin-0 (50m), shipped in public/data/
 * by `npm run fetch:geo`. Never fetched from the network at runtime.
 *  - point-in-polygon with a bounding-box prefilter
 *  - ocean events fall back to the nearest country: "Open ocean / <country>"
 *  - results are cached in memory by rounded coordinate
 */

interface CountryProps {
  name: string;
  iso3: string;
  continent: string;
  subregion: string;
}

type BBox = [number, number, number, number];

export interface CountryInfo {
  key: string;
  name: string;
  iso3: string;
  continent: string;
  subregion: string;
  /** [lon, lat] centroid of the largest landmass, used to aim the camera. */
  centroid: [number, number];
  /** Bounding box of the largest landmass. */
  bbox: BBox;
  /** Diagonal of that box in degrees: a rough size for camera distance. */
  span: number;
}

export interface Tag {
  countryKey: string;
  country: string;
  region: string;
  subregion: string;
  iso3: string;
  offshore: boolean;
  sector: string;
}

interface PolyRec {
  country: CountryInfo;
  bbox: BBox;
  geometry: Polygon;
  outer: Position[];
}

const polys: PolyRec[] = [];
const countries = new Map<string, CountryInfo>();
const tagCache = new Map<string, Tag>();
let ready: Promise<boolean> | null = null;

export function loadCountries(): Promise<boolean> {
  ready ??= (async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/countries-50m.geojson`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      index((await res.json()) as FeatureCollection<Polygon | MultiPolygon, CountryProps>);
      return true;
    } catch (err) {
      console.warn('[geotag] country borders unavailable; run `npm run fetch:geo`. Events stay untagged.', err);
      return false;
    }
  })();
  return ready;
}

export const getCountry = (key: string | null | undefined) => (key ? countries.get(key) : undefined);
export const allCountries = () => [...countries.values()];

function continentLabel(c: string): string {
  return c === 'Seven seas (open ocean)' ? 'Open ocean' : c;
}

function bboxOf(ring: Position[]): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function signedArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function centroidOf(ring: Position[]): [number, number] {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-9) {
    const [x0, y0, x1, y1] = bboxOf(ring);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

function index(fc: FeatureCollection<Polygon | MultiPolygon, CountryProps>) {
  for (const f of fc.features) {
    const p = f.properties;
    if (!p?.name || !f.geometry) continue;
    const polygons: Position[][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let main = polygons[0];
    let mainArea = -1;
    for (const poly of polygons) {
      const area = Math.abs(signedArea(poly[0]));
      if (area > mainArea) {
        mainArea = area;
        main = poly;
      }
    }
    const bbox = bboxOf(main[0]);
    const info: CountryInfo = {
      key: p.name,
      name: p.name,
      iso3: p.iso3,
      continent: continentLabel(p.continent),
      subregion: p.subregion,
      centroid: centroidOf(main[0]),
      bbox,
      span: Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]),
    };
    countries.set(info.key, info);
    for (const poly of polygons) {
      polys.push({ country: info, bbox: bboxOf(poly[0]), geometry: { type: 'Polygon', coordinates: poly }, outer: poly[0] });
    }
  }
}

function containing(lat: number, lon: number): CountryInfo | null {
  const pt = point([lon, lat]);
  for (const rec of polys) {
    const [x0, y0, x1, y1] = rec.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (booleanPointInPolygon(pt, rec.geometry)) return rec.country;
  }
  return null;
}

/** Equirectangular distance in degrees; accurate enough to rank neighbours. */
function approxDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = Math.abs(wrapLon(lon2 - lon1)) * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y);
}

/** A distance that can never exceed the true approxDeg to any vertex inside the box. */
function bboxLowerBound(lat: number, lon: number, [x0, y0, x1, y1]: BBox): number {
  const dy = lat < y0 ? y0 - lat : lat > y1 ? lat - y1 : 0;
  let dx = 0;
  if (lon < x0 || lon > x1) dx = Math.min(Math.abs(wrapLon(x0 - lon)), Math.abs(wrapLon(x1 - lon)));
  const maxAbsLat = Math.min(89.9, Math.max(Math.abs(lat), Math.abs(y0), Math.abs(y1)));
  return Math.hypot(dx * Math.cos(maxAbsLat * DEG), dy);
}

function nearest(lat: number, lon: number): CountryInfo | null {
  const candidates = polys.map((rec) => ({ rec, lb: bboxLowerBound(lat, lon, rec.bbox) }));
  candidates.sort((a, b) => a.lb - b.lb);
  let best = Infinity;
  let bestCountry: CountryInfo | null = null;
  for (const { rec, lb } of candidates) {
    if (lb >= best) break;
    for (const v of rec.outer) {
      const d = approxDeg(lat, lon, v[1], v[0]);
      if (d < best) {
        best = d;
        bestCountry = rec.country;
      }
    }
  }
  return bestCountry;
}

/**
 * A coarse "region within the country": a 3×3 compass grid over the main landmass.
 * (A full admin-1 dataset is ~40 MB; this keeps grouping useful for large countries.)
 */
function sectorOf(c: CountryInfo, lat: number, lon: number): string {
  const [x0, y0, x1, y1] = c.bbox;
  const w = x1 - x0;
  const h = y1 - y0;
  if (lon < x0 - w * 0.15 || lon > x1 + w * 0.15 || lat < y0 - h * 0.15 || lat > y1 + h * 0.15) return 'Outlying territory';
  if (c.span < 6) return 'On land';
  const fx = clamp01((lon - x0) / w);
  const fy = clamp01((lat - y0) / h);
  const ns = fy > 2 / 3 ? 'North' : fy < 1 / 3 ? 'South' : '';
  const ew = fx > 2 / 3 ? 'east' : fx < 1 / 3 ? 'west' : '';
  if (!ns && !ew) return 'Central';
  if (!ns) return ew === 'east' ? 'East' : 'West';
  return ew ? `${ns}-${ew}` : ns;
}

export function tagPoint(lat: number, lon: number): Tag | null {
  if (!polys.length) return null;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = tagCache.get(key);
  if (hit) return hit;

  let tag: Tag;
  const inside = containing(lat, lon);
  if (inside) {
    tag = {
      countryKey: inside.key,
      country: inside.name,
      region: inside.continent,
      subregion: inside.subregion,
      iso3: inside.iso3,
      offshore: false,
      sector: sectorOf(inside, lat, lon),
    };
  } else {
    const near = nearest(lat, lon);
    tag = {
      countryKey: near?.key ?? 'Open ocean',
      country: near ? `Open ocean / ${near.name}` : 'Open ocean',
      region: near?.continent ?? 'Open ocean',
      subregion: near?.subregion ?? '',
      iso3: near?.iso3 ?? '',
      offshore: true,
      sector: 'Offshore',
    };
  }
  tagCache.set(key, tag);
  return tag;
}

const ALIASES: Record<string, string> = {
  'united states': 'united states of america',
  usa: 'united states of america',
  russia: 'russian federation',
  'democratic republic of the congo': 'dem rep congo',
  'dr congo': 'dem rep congo',
  'czech republic': 'czechia',
  'ivory coast': 'cote divoire',
};

function canon(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/^the /, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[s] ?? s;
}

function namesMatch(hint: string, country: string): boolean {
  const a = canon(hint);
  const b = canon(country);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

/** Tag one event in place. If the source names a country that the coordinates disagree with,
 *  try the swapped pair (some feeds occasionally emit [lat, lon]) and keep it only if it matches. */
export function tagEvent(e: DisasterEvent): void {
  if (e.tagged) return;
  let tag = tagPoint(e.lat, e.lon);
  if (!tag) return; // borders not loaded
  if (e.countryHint && (tag.offshore || !namesMatch(e.countryHint, tag.country)) && Math.abs(e.lon) <= 90) {
    const swapped = tagPoint(e.lon, e.lat);
    if (swapped && !swapped.offshore && namesMatch(e.countryHint, swapped.country)) {
      const lat = e.lon;
      e.lon = e.lat;
      e.lat = lat;
      tag = swapped;
    }
  }
  Object.assign(e, tag);
  e.tagged = true;
}

export async function tagEvents(events: DisasterEvent[]): Promise<void> {
  let n = 0;
  for (const e of events) {
    if (e.tagged) continue;
    tagEvent(e);
    if (++n % 300 === 0) await yieldToMain();
  }
}
