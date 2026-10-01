# earth is doomed

A live, scroll-driven 3D globe of the world's natural disasters. An instrument and a documentary, not a game:
the only verbs are look, scrub, scroll and zoom.

## Run it

```sh
npm install && npm run dev
```

Then open http://localhost:5173. Needs Node 20.19+ (developed on Node 24).

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server, including the GDACS proxy |
| `npm run build` | Type-check, then a production build into `dist/` |
| `npm run preview` | Serve `dist/` (the GDACS proxy works here too) |
| `npm run typecheck` | TypeScript only |
| `npm run fetch:geo` | Download the Natural Earth borders into `public/data/` if they are missing (`node scripts/fetch-geodata.mjs --force` re-downloads) |

The borders are already committed in `public/data/`, and `npm install` only fetches them if they are missing.
The app itself never downloads them from the network.

## Deploying to Vercel

Import the GitHub repo in Vercel and deploy. Nothing needs configuring:

- Vercel detects Vite: the build command is `npm run build` and the output directory is `dist`.
- `api/gdacs/search.js` becomes a serverless function at `/api/gdacs/search`, the production twin of the
  dev proxy. It forwards only the documented GDACS SEARCH endpoint and lets Vercel's CDN cache each answer
  (4 minutes for recent windows, 1 hour for older ones), so visitors share one upstream request per query.
- No environment variables, keys or databases are involved.

## Using it

- **Look**: drag the globe, or focus it and use the arrow keys. Hover a point for details; click to open it.
- **Zoom**: pinch, ctrl/⌘ + wheel, or `+` / `-`. A plain wheel scrolls the story.
- **Scroll**: planet → the country with the most severe current events → that country's most severe event.
  Picking a country or an event anywhere (rail, globe) moves the story to that depth. `Esc` steps back out.
- **Scrub**: the bar at the bottom moves the end of a 24-hour window back through the last 30 days (or a
  year). Arrow keys step an hour (a day in year view), Page Up/Down a day (a week), Home/End jump to the start
  or back to live. Play animates forward at ¼×, 1× or 4×.
- **Countries tab**: search every country and region with events in view, see counts and a type breakdown,
  and open a country to list its events grouped by area.
- **Sources tab**: every data stream the page reads, its exact endpoint, refresh cadence, how it is
  accessed, a link to its documentation, and its live status.
- **Legend**: click a type to hide or show it; shift-click to show only that type.

## Data sources

All free, public, documented, and keyless. Each fetcher fails on its own and shows a quiet "unavailable"
state; if every live feed fails, the page says so plainly instead of drawing nothing.

| Stream | Endpoint | When | Access |
| --- | --- | --- | --- |
| USGS earthquakes, past day | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` | every 5 min while the tab is visible | direct (CORS) |
| USGS catalogue (FDSN) | `earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=4.5` | history, on demand | direct |
| NASA EONET v3, live | `eonet.gsfc.nasa.gov/api/v3/events?status=all&days=14` | every 5 min while visible | direct (CORS) |
| NASA EONET v3, history | `…/events?status=all&start=…&end=…` | history, on demand | direct |
| GDACS event search | `www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH` | every 5 min while visible; history on demand | own proxy (GDACS has no CORS): Vite locally, Vercel function deployed |
| NASA GIBS VIIRS true colour (WMTS) | `gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/…` | only while an event is open | direct (map tiles) |
| NASA GIBS VIIRS thermal anomalies (WMS) | `gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?LAYERS=VIIRS_SNPP_Thermal_Anomalies_375m_All` | only for open wildfires | direct |
| Natural Earth admin-0, 1:50m and 1:110m | `public/data/*.geojson` | bundled | local file |

### Keeping the load on these services low

- Live feeds poll every 5 minutes, and only while the tab is visible. A hidden tab catches up once when it
  becomes visible again.
- History loads lazily: the last 30 days after the live picture is up, a full year only when you ask for it.
  It loads in 30-day chunks, newest first, **one request at a time**, and is cached for the session.
  Failed chunks are not cached, so they are retried the next time that range is opened.
- The GDACS proxy forwards exactly one documented endpoint, with an allowlist of query parameters and
  `pageSize` capped at 100. It sends GDACS's documented `caller` parameter and an identifying User-Agent.
  In development (`vite.config.ts`) it caches responses (4 minutes for recent windows, 1 hour for older
  ones), coalesces identical in-flight requests, and spaces upstream calls 400 ms apart, so reloading is
  served from that cache. When deployed (`api/gdacs/search.js`), Vercel's CDN caches each answer for the
  same periods, so visitors share upstream requests.
- GDACS paging stops at the first short page and has a hard page cap per query. History beyond 30 days
  asks only for orange and red alerts.
- Cloud and no-data detection in the before/after view reads pixels from tiles Leaflet already loaded
  (GIBS allows CORS), so it costs no extra requests.

## Project structure

```
src/
  main.ts            wiring: store ↔ globe ↔ UI, frame loop, camera poses
  config.ts          colours, windows, intervals
  data/              types, fetchers/ (usgs, eonet, gdacs), normalize, dedupe, geotag,
                     derive (window maths), pipeline (polling, history, merge), streams, store
  globe/             scene, cameraRig, globe (three-globe), points (GPU layer), picking, geo
  ui/                counter, legend, rail (Countries + Sources tabs), sources, tooltip, timeline,
                     eventPanel, compare (Leaflet before/after), descent (ScrollTrigger), status
  styles/main.css
api/gdacs/search.js  Vercel function: the deployed GDACS proxy
scripts/fetch-geodata.mjs
public/data/         Natural Earth borders (slimmed, rounded)
```

## Decisions I made

- **Points are a custom GPU layer inside the three-globe object.** three-globe draws the earth, borders,
  atmosphere, graticule, rings and storm tracks. Its built-in points layer rebuilds a merged mesh whenever
  data changes, which is too slow for scrubbing thousands of points. So every event is one vertex in a
  single `THREE.Points` draw call, and fading, filtering, pulses and highlights happen in the shader.
  Scrubbing only changes a uniform. A year of history (about 17,000 events) plays back at roughly 1.6 ms
  per frame.
- **The camera is my own rig**, not OrbitControls. It is a spring-damped lat/lon/altitude/tilt rig that
  climbs automatically on long moves, so it arcs over the globe rather than skimming it. The scroll
  position sets the target pose; your drag and zoom are an offset on top that resets when you change depth.
- **A plain mouse wheel scrolls the story; pinch or ctrl/⌘ + wheel zooms.** A scroll-driven page cannot
  also use the wheel for zoom.
- **What "active" means.** EONET lists about 7,200 events as "open", almost all wildfires whose last
  observation is months or years old. "Open" therefore counts as active only for a grace period after the
  last observation: wildfire 4 days, storm 1, flood and other 7, volcano and drought 14. GDACS's
  `iscurrent` gets the same treatment. Earthquakes are always instantaneous. Points fade over the 24 hours
  after an event ends.
- **Earthquake magnitudes.** The live day includes every magnitude USGS reports, as the `all_day` feed
  does. History is M4.5+, which is how the FDSN service is meant to be used globally. The density strip
  counts only M4.5+ quakes, so the live day compares fairly with the past. Because of this, the counter
  drops noticeably when you scrub off the live edge.
- **Wildfires.** The live GDACS query includes fires of any alert level updated in the last 3 days, because
  EONET's republished copies of these are often already closed. For history, EONET provides the fires and
  GDACS adds only orange and red alerts.
- **Dedupe.** Records are merged on explicit cross-references first (EONET cites GDACS event ids; USGS lists
  every network id), then by proximity: same type group, different sources, within 100 km, and within 24 h
  (15 min and 0.8 magnitude for earthquakes, so aftershocks are not merged). Two records from the same
  source are never merged by proximity. The richer record supplies the content, and the id comes from a
  fixed source priority so a selection survives re-polls.
- **Severity (0–1)** is a rough per-type mapping, used only for drawing size and rings. Magnitude M2→0 and
  M8→1; burned area on a log scale; wind speed in knots. GDACS orange and red alerts set floors of 0.6 and
  0.85, and USGS PAGER alerts set floors too.
- **Country names** use Natural Earth's short `NAME` field unless it is abbreviated ("Dem. Rep. Congo"),
  in which case the long form is used.
- **Regions within a country** are a 3×3 compass grid over the country's main landmass ("North-east",
  "Central"…), plus "Offshore" and "Outlying territory". A full admin-1 dataset is about 40 MB.
- **Coordinate repair.** Some EONET flood polygons arrive with lat/lon swapped. Pairs that are
  impossible as given are swapped back. Pairs that disagree with the country the source names are swapped
  only if the swapped point lands in that country.
- **The "most severe" country** is the one whose three most severe events in view add up highest, so one
  big event or several serious ones both count.
- **The before/after view** uses about 7 days before the event, and the event's latest active day. When
  today's imagery has not arrived yet, it steps back a day once and labels the result "latest available".
- **The thermal-anomaly layer comes over WMS.** It is published only as Mapbox vector tiles over WMTS, and
  GIBS documents WMS as the way to get vector layers rendered as images.
- **Fonts** (Inter and JetBrains Mono) are bundled through Fontsource, so nothing loads from a font CDN.
- **The globe opens facing your longitude**, estimated from your time zone.

## Known limitations

- Sources lag, revise and disagree. Nothing here is official, and severity is not a measure of human impact.
- GDACS needs a server-side proxy: the Vite dev server (`npm run dev`, `npm run preview`) or the Vercel
  function in `api/`. Other static hosts would need an equivalent; without one, GDACS shows as unavailable
  and the rest keeps working.
- Every visitor's browser polls USGS and EONET directly (their public feeds are built for this). The polling
  pauses in hidden tabs.
- History is cached in memory only, so reloading the page fetches it again (GDACS responses come from the
  proxy cache).
- Satellite imagery is regional (about 250 m to 1 km per pixel). Daily passes can be cloudy, have swath
  gaps, or arrive hours late. The view flags cloudy and empty days but cannot see through clouds.
- Ocean events are labelled "Open ocean / <nearest country>". Very remote ones still get a nearest country.
- Storm tracks crossing the antimeridian draw the long way round.
- The layout is designed down to tablet width (about 768 px). Phones work but are cramped.
- `prefers-reduced-motion` turns off auto-rotate, pulses, rings, the count-up and scroll snapping, and
  makes camera moves cut rather than fly.

## Development note

In development builds, `window.__earth` exposes the store, camera rig, scene and pipeline for poking at
state from the console. It is not included in production builds.
