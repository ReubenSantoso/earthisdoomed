import type { AlertLevel, DisasterEvent, EventType } from './types';
import { clamp01 } from './util';

/*
 * Severity is a rough 0..1 number used only to size points and pick which events get rings.
 * Each source reports intensity differently, so each type gets its own mapping.
 */

/** M2 → 0, M5 → 0.5, M8 → 1. USGS PAGER alerts and tsunami flags raise the floor. */
export function quakeSeverity(mag: number, pagerAlert?: string | null, tsunami?: number | null): number {
  let s = clamp01((mag - 2) / 6);
  if (pagerAlert === 'yellow') s = Math.max(s, 0.7);
  else if (pagerAlert === 'orange') s = Math.max(s, 0.85);
  else if (pagerAlert === 'red') s = Math.max(s, 0.95);
  if (tsunami) s = Math.min(1, s + 0.05);
  return s;
}

/** Log scale on burned area: 100 ha → ~0, 5,000 ha → ~0.46, 100,000 ha → ~0.81. */
export function wildfireSeverity(hectares?: number | null): number {
  if (!hectares || hectares <= 0) return BASE_SEVERITY.wildfire;
  return Math.max(0.08, clamp01((Math.log10(hectares) - 2) / 3.7));
}

/** Sustained wind in knots: tropical storm (34 kt) → ~0.15, category 5 (137 kt) → ~0.97. */
export function stormSeverity(kts?: number | null): number {
  if (!kts) return BASE_SEVERITY.storm;
  return Math.max(0.15, clamp01((kts - 25) / 115));
}

export const BASE_SEVERITY: Record<EventType, number> = {
  earthquake: 0.3,
  wildfire: 0.25,
  storm: 0.3,
  volcano: 0.5,
  flood: 0.35,
  drought: 0.3,
  other: 0.12,
};

/**
 * How long an event the source still lists as "open" counts as active after its last
 * observation. EONET keeps thousands of fires "open" for months or years after their last
 * update, so "open" alone is not evidence that something is happening now.
 */
export const OPEN_GRACE_DAYS: Record<EventType, number> = {
  earthquake: 1,
  storm: 1,
  wildfire: 4,
  flood: 7,
  other: 7,
  volcano: 14,
  drought: 14,
};

/** GDACS alert levels set a floor: orange and red events are never drawn small. */
export function alertFloor(alert?: AlertLevel): number {
  if (alert === 'red') return 0.85;
  if (alert === 'orange') return 0.6;
  return 0;
}

export function alertRank(alert?: AlertLevel): number {
  return alert === 'red' ? 3 : alert === 'orange' ? 2 : alert === 'green' ? 1 : 0;
}

/** EONET titles often end in a GDACS numeric id ("Wildfire in Brazil 1032493"). */
export function stripTrailingId(title: string): string {
  return title.replace(/\s+\d{5,}$/, '').trim();
}

/** "Wildfire in Brazil" → "Brazil". Used only as a hint to sanity-check coordinates. */
export function countryFromTitle(title: string): string | undefined {
  const m = /\bin ([A-Z][^,]*?)(?:,.*)?$/.exec(title);
  return m ? m[1].trim() : undefined;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Fill the ISO `time` / `endTime` fields from the numeric t0 / t1. */
export function withIsoTimes(e: DisasterEvent): DisasterEvent {
  e.time = new Date(e.t0).toISOString();
  e.endTime = Number.isFinite(e.t1) && e.t1 > e.t0 ? new Date(e.t1).toISOString() : undefined;
  return e;
}
