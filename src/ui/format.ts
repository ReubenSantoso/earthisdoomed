import { TYPE_LABEL } from '../config';
import type { DisasterEvent } from '../data/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export const fmtCount = (n: number) => Math.round(n).toLocaleString('en-US');

/** "30 Sep 2026, 21:55 UTC" */
export function fmtUtc(ms: number, withYear = true): string {
  const d = new Date(ms);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`;
  return `${date}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "30 Sep" */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Sep 2026" */
export function fmtMonth(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "YYYY-MM-DD" in UTC. */
export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function fmtRelative(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  let text: string;
  if (s < 45) return future ? 'in a moment' : 'just now';
  if (s < 3600) text = `${Math.round(s / 60)} min`;
  else if (s < 86_400) text = `${Math.round(s / 3600)} h`;
  else if (s < 86_400 * 45) text = `${Math.round(s / 86_400)} days`;
  else text = `${Math.round(s / (86_400 * 30))} months`;
  if (text.startsWith('1 days')) text = '1 day';
  return future ? `in ${text}` : `${text} ago`;
}

export function fmtAgoShort(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function typeName(e: DisasterEvent): string {
  if (e.type === 'other' && e.kind) return e.kind;
  return TYPE_LABEL[e.type];
}

/** Short "when" for lists: "3 h ago", or "ongoing" for long-running events. */
export function fmtWhen(e: DisasterEvent, now = Date.now()): string {
  if (e.ongoing && now - e.t0 > 36 * 3_600_000) return `ongoing, began ${fmtRelative(e.t0, now)}`;
  return fmtRelative(e.t0, now);
}

/** Ongoing / duration line for the panel. */
export function fmtSpan(e: DisasterEvent, now = Date.now()): string {
  const last = e.lastSeen ?? e.t0;
  const updated = last - e.t0 > 60_000;
  if (e.ongoing) return `since ${fmtUtc(e.t0)} · ongoing${updated ? `, last update ${fmtRelative(last, now)}` : ''}`;
  return updated ? `${fmtUtc(e.t0)} → ${fmtUtc(last)} (last update)` : fmtUtc(e.t0);
}
