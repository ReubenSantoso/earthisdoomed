import type { SourceStatus } from './types';

/** Every network or file source the page reads. Rendered in the "Sources" tab. */
export type StreamId =
  | 'usgs-live'
  | 'usgs-history'
  | 'eonet-live'
  | 'eonet-history'
  | 'gdacs-live'
  | 'gdacs-history'
  | 'gibs-imagery'
  | 'gibs-fires'
  | 'natural-earth';

export interface StreamStatus extends SourceStatus {
  /** Short human summary of what has been loaded ("30 days", "12 tiles"...). */
  detail?: string;
}

export interface StreamInfo {
  id: StreamId;
  provider: string;
  name: string;
  provides: string;
  endpoint: string;
  docs: string;
  cadence: string;
  access: string;
  /** What to say before the stream has been used at all. */
  idleText: string;
  /** What `count` counts. */
  unit: string;
}

export const STREAMS: StreamInfo[] = [
  {
    id: 'usgs-live',
    unit: 'records',
    provider: 'USGS',
    name: 'Earthquakes, past day (GeoJSON summary feed)',
    provides: 'Every earthquake USGS recorded in the last 24 hours, all magnitudes.',
    endpoint: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    docs: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
    cadence: 'Polled every 5 minutes while this tab is visible.',
    access: 'Direct from the browser (the feed allows cross-origin requests).',
    idleText: 'waiting for first poll',
  },
  {
    id: 'usgs-history',
    unit: 'records',
    provider: 'USGS',
    name: 'Earthquake catalogue (FDSN event web service)',
    provides: 'M4.5+ earthquakes for the timeline.',
    endpoint: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=4.5&starttime=…&endtime=…',
    docs: 'https://earthquake.usgs.gov/fdsnws/event/1/',
    cadence: 'On demand in 30-day chunks: the last month after load, a year only if you ask. Cached for the session.',
    access: 'Direct, one request at a time.',
    idleText: 'not loaded yet',
  },
  {
    id: 'eonet-live',
    unit: 'records',
    provider: 'NASA EONET',
    name: 'Natural events, last 14 days (EONET v3)',
    provides: 'Wildfires, severe storms, volcanoes, floods, sea and lake ice.',
    endpoint: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=14',
    docs: 'https://eonet.gsfc.nasa.gov/docs/v3',
    cadence: 'Polled every 5 minutes while this tab is visible.',
    access: 'Direct from the browser (cross-origin allowed).',
    idleText: 'waiting for first poll',
  },
  {
    id: 'eonet-history',
    unit: 'records',
    provider: 'NASA EONET',
    name: 'Natural events by date range (EONET v3)',
    provides: 'The same event categories, for the timeline.',
    endpoint: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=all&start=…&end=…',
    docs: 'https://eonet.gsfc.nasa.gov/docs/v3',
    cadence: 'On demand in 30-day chunks, cached for the session.',
    access: 'Direct, one request at a time.',
    idleText: 'not loaded yet',
  },
  {
    id: 'gdacs-live',
    unit: 'records',
    provider: 'GDACS',
    name: 'Disaster alerts, last 7 days (event SEARCH API)',
    provides:
      'Green, orange and red alert levels for earthquakes, cyclones, floods, volcanoes and droughts, plus wildfires with burn detections in the last 3 days.',
    endpoint: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH',
    docs: 'https://www.gdacs.org/gdacsapi/swagger/index.html',
    cadence: 'Polled every 5 minutes while this tab is visible.',
    access:
      "Through this site's own small proxy, because GDACS sends no CORS headers: the Vite dev server locally, a Vercel function when deployed. Only this endpoint is forwarded, and responses are cached so visitors share requests.",
    idleText: 'waiting for first poll',
  },
  {
    id: 'gdacs-history',
    unit: 'records',
    provider: 'GDACS',
    name: 'Disaster alerts by date range (event SEARCH API)',
    provides: 'Full detail for the last 30 days; orange and red alerts only further back.',
    endpoint: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromDate=…&toDate=…',
    docs: 'https://www.gdacs.org/gdacsapi/swagger/index.html',
    cadence: 'On demand, cached for the session.',
    access: 'Through the same proxy (as above).',
    idleText: 'not loaded yet',
  },
  {
    id: 'gibs-imagery',
    unit: 'tiles',
    provider: 'NASA GIBS',
    name: 'VIIRS SNPP corrected reflectance, true colour (WMTS)',
    provides: 'Daily satellite imagery for the before/after view, about 250 m to 1 km per pixel.',
    endpoint:
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
    docs: 'https://nasa-gibs.github.io/gibs-api-docs/access-basics/',
    cadence: 'Only while an event is open, as ordinary map tiles.',
    access: 'Direct from the browser.',
    idleText: 'loads when you open an event',
  },
  {
    id: 'gibs-fires',
    unit: 'tiles',
    provider: 'NASA GIBS',
    name: 'VIIRS 375 m thermal anomalies (WMS)',
    provides: 'Active-fire detections drawn over wildfire events.',
    endpoint:
      'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&LAYERS=VIIRS_SNPP_Thermal_Anomalies_375m_All',
    docs: 'https://nasa-gibs.github.io/gibs-api-docs/access-basics/',
    cadence: 'Only while a wildfire is open.',
    access: 'Direct. This layer is vector-only over WMTS, so the WMS endpoint renders it as transparent PNGs.',
    idleText: 'loads when you open a wildfire',
  },
  {
    id: 'natural-earth',
    unit: 'countries',
    provider: 'Natural Earth',
    name: 'Admin-0 countries, 1:50m and 1:110m',
    provides: 'Borders for drawing, and for tagging every event with a country and continent.',
    endpoint: 'public/data/countries-50m.geojson, public/data/countries-110m.geojson',
    docs: 'https://www.naturalearthdata.com/downloads/50m-cultural-vectors/',
    cadence: 'Downloaded once at setup (npm run fetch:geo). Never fetched from the network at runtime.',
    access: 'Bundled with the app.',
    idleText: 'loading',
  },
];

export const initialStreams = (): Record<StreamId, StreamStatus> =>
  Object.fromEntries(STREAMS.map((s) => [s.id, { state: 'idle' }])) as Record<StreamId, StreamStatus>;
