export type EventType = 'earthquake' | 'wildfire' | 'storm' | 'volcano' | 'flood' | 'drought' | 'other';

/** Legend / filter groups. Drought shares the tan "drought & other" group. */
export type LegendGroup = 'earthquake' | 'wildfire' | 'storm' | 'volcano' | 'flood' | 'other';

export type AlertLevel = 'green' | 'orange' | 'red';

export type SourceId = 'USGS' | 'EONET' | 'GDACS';

export interface TrackPoint {
  t: number;
  lat: number;
  lon: number;
}

/**
 * The single normalized shape every fetcher produces.
 *
 * The first block is the public contract
 * (`id, type, title, lat, lon, severity, magnitudeLabel, time, endTime?, source, url, country?, region?`).
 * The second block is derived or optional enrichment used for rendering, dedupe and grouping.
 */
export interface DisasterEvent {
  id: string;
  type: EventType;
  title: string;
  lat: number;
  lon: number;
  /** 0..1, source-derived; only used to decide what is drawn larger. */
  severity: number;
  magnitudeLabel: string;
  /** ISO 8601 start (or occurrence) time. */
  time: string;
  /** ISO 8601 end time, when the source gives one. */
  endTime?: string;
  source: SourceId;
  url: string;
  /** Country name, or "Open ocean / <nearest country>". */
  country?: string;
  /** Continent. */
  region?: string;

  /** Start, ms since epoch. */
  t0: number;
  /** End, ms since epoch. Infinity while the source still lists it as open. */
  t1: number;
  /** Source-specific sub-kind ("Sea and Lake Ice", "Tropical Cyclone"...). */
  kind?: string;
  /** Earthquake magnitude, kept numerically so history and live can be compared. */
  mag?: number;
  alert?: AlertLevel;
  /** Every source that reported this event (after dedupe). */
  sources: SourceId[];
  /** Cross-source identifiers such as "GDACS:WF:1032493" or "USGS:us7000abcd". */
  refs: string[];
  /** Country named by the source itself; used to sanity-check coordinates. */
  countryHint?: string;
  /** Grouping key: the containing country, or the nearest one for ocean events. */
  countryKey?: string;
  iso3?: string;
  subregion?: string;
  offshore?: boolean;
  /** Coarse within-country area ("North-east", "Offshore"...). */
  sector?: string;
  /** The source still lists it as active (and it was observed recently). */
  ongoing?: boolean;
  /** Time of the latest observation or update from the source, ms. */
  lastSeen?: number;
  /** Moving events (storms, icebergs) carry their observed positions. */
  track?: TrackPoint[];
  /** How much information the record carries; dedupe keeps the richer record. */
  detail: number;
  /** Set once geotagging has run on this object. */
  tagged?: boolean;
}

export interface SourceStatus {
  state: 'idle' | 'loading' | 'ok' | 'error';
  updatedAt?: number;
  count?: number;
  message?: string;
}

export type RangeKey = '30d' | '1y';
