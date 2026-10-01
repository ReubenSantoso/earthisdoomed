import type { EventType, LegendGroup, RangeKey } from './data/types';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Events are "in view" while active, then fade over this long after they end. */
export const WINDOW_MS = DAY;

export const LIVE_POLL_MS = 5 * 60_000;
/** Retry delay when every live source failed on the first attempt. */
export const COLD_RETRY_MS = 60_000;

/** History is fetched lazily in chunks of this length, newest first, one request at a time. */
export const HISTORY_CHUNK_MS = 30.5 * DAY;
export const RANGE_CHUNKS: Record<RangeKey, number> = { '30d': 1, '1y': 12 };

/** USGS history queries use this floor (per the FDSN service's intended use for global history). */
export const QUAKE_HISTORY_MIN_MAG = 4.5;

/** Only the most severe events in view get animated rings. */
export const RING_LIMIT = 24;

export const GROUP_OF: Record<EventType, LegendGroup> = {
  earthquake: 'earthquake',
  wildfire: 'wildfire',
  storm: 'storm',
  volcano: 'volcano',
  flood: 'flood',
  drought: 'other',
  other: 'other',
};

export const GROUPS: { id: LegendGroup; label: string; color: string }[] = [
  { id: 'earthquake', label: 'Earthquakes', color: '#d9a24c' },
  { id: 'wildfire', label: 'Wildfires', color: '#e0653f' },
  { id: 'storm', label: 'Storms', color: '#5fc3ce' },
  { id: 'volcano', label: 'Volcanoes', color: '#cf6db6' },
  { id: 'flood', label: 'Floods', color: '#5d8fe0' },
  { id: 'other', label: 'Drought & other', color: '#bca985' },
];

const NOUNS: Record<LegendGroup, [string, string]> = {
  earthquake: ['earthquake', 'earthquakes'],
  wildfire: ['wildfire', 'wildfires'],
  storm: ['storm', 'storms'],
  volcano: ['volcano', 'volcanoes'],
  flood: ['flood', 'floods'],
  other: ['drought or other', 'droughts and other'],
};

/** "1 flood", "3 floods". */
export const groupCount = (id: LegendGroup, n: number) => `${n.toLocaleString('en-US')} ${NOUNS[id][n === 1 ? 0 : 1]}`;

export const GROUP_COLOR = Object.fromEntries(GROUPS.map((g) => [g.id, g.color])) as Record<LegendGroup, string>;

export const TYPE_LABEL: Record<EventType, string> = {
  earthquake: 'Earthquake',
  wildfire: 'Wildfire',
  storm: 'Storm',
  volcano: 'Volcano',
  flood: 'Flood',
  drought: 'Drought',
  other: 'Other',
};

export const colorOf = (type: EventType) => GROUP_COLOR[GROUP_OF[type]];
