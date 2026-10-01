export const DEG = Math.PI / 180;

/**
 * GET a JSON document with a timeout. Plain GET with no custom headers, so
 * cross-origin requests stay "simple" and never trigger a preflight.
 */
export async function fetchJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const isoSecond = (ms: number) => new Date(ms).toISOString().slice(0, 19);

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number) => clamp(x, 0, 1);

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse a timestamp; strings without a zone are treated as UTC (GDACS omits the "Z"). */
export function parseUtc(s: string | null | undefined): number {
  if (!s) return NaN;
  return Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

/** Validate a [lon, lat] pair, repairing the occasional swapped pair a source emits. */
export function fixLonLat(lon: number, lat: number): [number, number] | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) return [lat, lon];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

export const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function nonNull<T>(x: T | null | undefined): x is T {
  return x != null;
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}
