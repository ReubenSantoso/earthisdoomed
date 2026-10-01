import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/300.css';
import '@fontsource/jetbrains-mono/400.css';
import 'leaflet/dist/leaflet.css';
import './styles/main.css';

import { GROUPS, GROUP_OF, RING_LIMIT, colorOf, groupCount } from './config';
import { countryStats, groupCounts, presence, visibleEvents, type CountryStat } from './data/derive';
import { getCountry } from './data/geotag';
import { DataPipeline } from './data/pipeline';
import { createStore, type State } from './data/store';
import { initialStreams } from './data/streams';
import type { DisasterEvent, LegendGroup } from './data/types';
import { DEG, clamp } from './data/util';
import { CameraRig, type Pose } from './globe/cameraRig';
import { lonDelta, rgba } from './globe/geo';
import { GlobeView, type PathDatum, type RingItem } from './globe/globe';
import { pickPoint } from './globe/picking';
import { trackPosition } from './globe/points';
import { SceneHost } from './globe/scene';
import { Counter } from './ui/counter';
import { Descent } from './ui/descent';
import { $, esc, throttle } from './ui/dom';
import { EventPanel } from './ui/eventPanel';
import { fmtCount } from './ui/format';
import { Legend } from './ui/legend';
import { Rail } from './ui/rail';
import { ErrorState, StatusLine } from './ui/status';
import { Timeline } from './ui/timeline';
import { Tooltip } from './ui/tooltip';

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = reducedQuery.matches;
document.documentElement.classList.toggle('reduced-motion', reduced);

const store = createStore({
  events: [],
  eventsVersion: 0,
  streams: initialStreams(),
  lastLiveUpdate: null,
  firstLoadDone: false,
  filters: Object.fromEntries(GROUPS.map((g) => [g.id, true])) as Record<LegendGroup, boolean>,
  range: '30d',
  cursor: Date.now(),
  live: true,
  playing: false,
  speed: 1,
  historyLoading: null,
  historyNote: null,
  focusCountry: null,
  focusPinned: false,
  focusEventId: null,
  eventPinned: false,
  hoverId: null,
  stage: 0,
  railOpen: false,
  railUserSet: false,
  railTab: 'countries',
  reducedMotion: reduced,
});

// ---------------------------------------------------------------- scene

const wrap = $('#globe-wrap');
const host = new SceneHost($('#globe-canvas') as HTMLCanvasElement, wrap);
const view = new GlobeView(host.scene, !reduced);
void view.loadCountries(`${import.meta.env.BASE_URL}data/countries-110m.geojson`);
view.points.setPulse(!reduced);

const pipeline = new DataPipeline(store);
const tooltip = new Tooltip();
const counter = new Counter(reduced);
const legend = new Legend($('#legend'), store);

let pointer: { x: number; y: number } | null = null;
let pointerDirty = false;
const rig = new CameraRig(host.camera, wrap, {
  onHover: (x, y) => {
    pointer = { x, y };
    pointerDirty = true;
  },
  onLeave: () => {
    pointer = null;
    tooltip.hide();
    setHover(null);
  },
  onClick: (x, y) => {
    const i = pick(x, y);
    if (i >= 0) actions.selectEvent(view.points.list[i].id, false);
  },
});
rig.instant = reduced;

// ---------------------------------------------------------------- lookups

let eventById = new Map<string, DisasterEvent>();
let visible: DisasterEvent[] = [];
let stats: CountryStat[] = [];

function findEvent(id: string | null | undefined): DisasterEvent | undefined {
  return id ? eventById.get(id) : undefined;
}

function recompute() {
  const s = store.get();
  visible = visibleEvents(s.events, s.cursor, s.filters);
  stats = countryStats(visible);
}

// ---------------------------------------------------------------- actions

const descent = new Descent($('#pin'), store);

const actions = {
  selectEvent(id: string, viaKeyboard: boolean) {
    const e = findEvent(id);
    if (!e) return;
    store.set({ focusEventId: e.id, eventPinned: true, focusCountry: e.countryKey ?? null, focusPinned: true });
    descent.scrollToStage(2);
    if (viaKeyboard) window.setTimeout(() => panel.focusTitle(), reduced ? 60 : 900);
  },
  focusCountry(key: string) {
    store.set({
      focusCountry: key,
      focusPinned: true,
      focusEventId: null,
      eventPinned: false,
      railOpen: true,
      railTab: 'countries',
    });
    descent.scrollToStage(1);
  },
  clearFocus() {
    store.set({ focusPinned: false, eventPinned: false });
    descent.scrollToStage(0);
  },
  closePanel() {
    store.set({ eventPinned: false });
    descent.scrollToStage(1);
  },
  hover(id: string | null) {
    setHover(id);
  },
  openSources() {
    store.set({ railOpen: true, railTab: 'sources', railUserSet: true });
  },
};

const rail = new Rail($('#rail'), store, actions);
const panel = new EventPanel($('#panel'), () => actions.closePanel(), (id, patch) => pipeline.setStream(id, patch));
const timeline = new Timeline($('#timeline'), store, (range) => void pipeline.ensureRange(range));
new StatusLine($('#status'), store, () => actions.openSources());
const errorState = new ErrorState($('#error-state'), store, () => void pipeline.poll());

function setHover(id: string | null) {
  if (store.get().hoverId !== id) store.set({ hoverId: id });
}

function pick(x: number, y: number): number {
  return pickPoint(view.points, host.camera, x, y, wrap.getBoundingClientRect(), store.get().cursor);
}

// ---------------------------------------------------------------- camera poses

const planet = { lat: 18, lon: clamp((-new Date().getTimezoneOffset() / 60) * 15, -180, 180) };

function planetAlt(): number {
  const half = (host.camera.fov * DEG) / 2;
  const aspect = host.width / host.height;
  const limit = Math.min(half, Math.atan(Math.tan(half) * aspect));
  const fill = host.width < 700 ? 0.86 : 0.72;
  return 1 / Math.sin(Math.atan(fill * Math.tan(limit))) - 1;
}

function countryPose(s: State): Pose | null {
  if (!s.focusCountry) return null;
  const info = getCountry(s.focusCountry);
  const stat = stats.find((c) => c.key === s.focusCountry);
  let lat: number;
  let lon: number;
  let span: number;
  if (info) {
    [lon, lat] = info.centroid;
    span = info.span;
    // Mostly-offshore countries (island arcs, coasts): aim between the land and the events.
    const off = stat?.events.filter((e) => e.offshore) ?? [];
    if (stat && off.length > stat.events.length / 2) {
      const ev = off[0];
      lat = (lat + ev.lat) / 2;
      lon = lon + lonDelta(lon, ev.lon) / 2;
      span = Math.max(span, 8);
    }
  } else if (stat?.events.length) {
    ({ lat, lon } = stat.events[0]);
    span = 10;
  } else return null;
  const half = (host.camera.fov * DEG) / 2;
  const alt = clamp(((Math.min(span, 70) / 2) * DEG * 1.5) / Math.tan(half), 0.3, 1.9);
  return { lat: clamp(lat, -70, 75), lon, alt, tilt: 0.12 };
}

function eventPose(s: State): Pose | null {
  const e = findEvent(s.focusEventId);
  if (!e) return null;
  const p = e.track ? trackPosition(e.track, s.cursor) : e;
  const alt = e.type === 'storm' ? 0.45 : e.type === 'drought' ? 0.55 : 0.2;
  return { lat: p.lat, lon: p.lon, alt, tilt: 0.45 };
}

function blend(a: Pose, b: Pose, f: number): Pose {
  const k = f * f * (3 - 2 * f);
  return {
    lat: a.lat + (b.lat - a.lat) * k,
    lon: a.lon + lonDelta(a.lon, b.lon) * k,
    alt: Math.exp(Math.log(a.alt) + (Math.log(b.alt) - Math.log(a.alt)) * k),
    tilt: a.tilt + (b.tilt - a.tilt) * k,
  };
}

function desiredPose(s: State): Pose {
  const p: Pose = { lat: planet.lat, lon: planet.lon, alt: planetAlt(), tilt: 0 };
  const c = countryPose(s) ?? p;
  const e = eventPose(s) ?? { ...c, alt: c.alt * 0.6, tilt: 0.3 };
  return s.stage <= 1 ? blend(p, c, s.stage) : blend(c, e, s.stage - 1);
}

// ---------------------------------------------------------------- derived views

let maskKey = '';
function applyMask(force = false) {
  const s = store.get();
  const dimOthers = s.stage >= 0.5 && !!s.focusCountry;
  const key = `${dimOthers}|${s.focusCountry}|${GROUPS.map((g) => +s.filters[g.id]).join('')}`;
  if (key === maskKey && !force) return;
  maskKey = key;
  view.points.setMask(
    (e) => s.filters[GROUP_OF[e.type]],
    (e) => dimOthers && e.countryKey !== s.focusCountry,
  );
}

function ringItem(e: DisasterEvent, cursor: number): RingItem {
  const p = e.track ? trackPosition(e.track, cursor) : e;
  return { event: e, lat: p.lat, lon: p.lon };
}

function updateRings() {
  const s = store.get();
  if (s.reducedMotion) return view.setRings([], null);
  const top = visible.filter((e) => presence(e, s.cursor) > 0.3).slice(0, RING_LIMIT);
  const selected = s.stage >= 1.5 ? findEvent(s.focusEventId) : undefined;
  if (selected && !top.includes(selected)) top.push(selected);
  view.setRings(
    top.map((e) => ringItem(e, s.cursor)),
    selected?.id ?? null,
  );
}

function updateTracks() {
  const s = store.get();
  const paths: PathDatum[] = [];
  for (const e of visible) {
    if (!e.track || e.track.length < 2 || e.t0 > s.cursor) continue;
    const head = trackPosition(e.track, s.cursor);
    const points = e.track.filter((p) => p.t <= s.cursor).map(({ lat, lon }) => ({ lat, lon }));
    points.push({ lat: head.lat, lon: head.lon });
    if (points.length < 2) continue;
    const color = colorOf(e.type);
    paths.push({ id: e.id, points, color: [rgba(color, 0.05), rgba(color, 0.6)] });
  }
  view.setTracks(paths);
}

function autoFocus() {
  const s = store.get();
  const patch: Partial<State> = {};
  let country = s.focusCountry;
  if (!s.focusPinned && (s.stage < 0.5 || !country)) {
    const top = stats[0]?.key ?? null;
    if (top !== country) patch.focusCountry = country = top;
  }
  if (!s.eventPinned && (s.stage < 1.5 || !s.focusEventId)) {
    const top = stats.find((c) => c.key === country)?.events[0]?.id ?? null;
    if (top !== s.focusEventId) patch.focusEventId = top;
  }
  if (Object.keys(patch).length) store.set(patch);
}

function renderRail() {
  const s = store.get();
  rail.applyChrome(s);
  const countryMode = !!s.focusCountry && (s.focusPinned || s.stage >= 0.5);
  rail.update(
    s,
    stats,
    stats.find((c) => c.key === s.focusCountry),
    countryMode,
  );
  rail.renderSources(s);
}
rail.onQuery = renderRail;

let captionKey = '';
function renderCaption() {
  const s = store.get();
  const stat = stats.find((c) => c.key === s.focusCountry);
  const top = stat?.events[0];
  const key = `${s.focusCountry}|${s.focusPinned}|${s.live}|${stat?.count}|${top?.id}`;
  if (key === captionKey) return;
  captionKey = key;
  const el = $('#caption-country');
  if (!s.focusCountry) {
    el.innerHTML = '';
    return;
  }
  const breakdown = stat
    ? GROUPS.filter((g) => stat.byGroup[g.id])
        .map((g) => groupCount(g.id, stat.byGroup[g.id]))
        .join(', ')
    : '';
  el.innerHTML = `
    <p class="caption-kicker mono">${s.focusPinned ? 'Your selection' : s.live ? 'Most severe right now' : 'Most severe in this window'}</p>
    <h2 class="caption-title">${esc(s.focusCountry)}</h2>
    <p>${stat ? `${fmtCount(stat.count)} ${stat.count === 1 ? 'event' : 'events'} in view: ${esc(breakdown)}.` : 'Nothing in view here right now.'}</p>
    ${top ? `<p class="caption-dim">The most severe: ${esc(top.title)}${top.magnitudeLabel ? `, ${esc(top.magnitudeLabel)}` : ''}. Scroll to go closer.</p>` : ''}`;
}

const announce = throttle(() => {
  const s = store.get();
  if (s.playing || !s.firstLoadDone) return;
  const top = visible[0];
  $('#sr-summary').textContent = `${fmtCount(visible.length)} events ${
    s.live ? 'in the last 24 hours' : 'in the selected 24-hour window'
  }.${top ? ` Most severe: ${top.title}${top.country ? `, ${top.country}` : ''}.` : ''}`;
}, 5000);

function updateCounter(animate: boolean) {
  const s = store.get();
  if (!s.firstLoadDone) return;
  const down = (['usgs-live', 'eonet-live', 'gdacs-live'] as const).every((id) => s.streams[id].state === 'error');
  if (down && s.events.length === 0) return counter.unavailable();
  counter.update(visibleEvents(s.events, s.cursor, s.filters).length, s.live, s.cursor, animate);
}

function syncSelection() {
  const s = store.get();
  const showSelected = s.stage >= 1.5 || s.eventPinned;
  view.points.setSelected(showSelected ? view.points.indexOf(s.focusEventId) : -1);
  const info = getCountry(s.focusCountry);
  view.setFocusCountry(s.stage >= 0.5 && info ? { name: info.name, iso3: info.iso3 } : null);
}

function syncStageUi() {
  const s = store.get();
  const deep = s.stage >= 0.5;
  if (!s.railUserSet && s.railOpen !== deep) store.set({ railOpen: deep, railTab: deep ? 'countries' : s.railTab });
  $('#masthead').classList.toggle('compact', s.stage >= 0.3 || s.railOpen);
  const ev = s.stage >= 1.5 ? findEvent(s.focusEventId) : undefined;
  if (ev) panel.show(ev);
  else panel.hide();
  document.body.dataset.panel = panel.isOpen ? 'open' : 'closed';
}

const heavy = throttle(() => {
  const s = store.get();
  recompute();
  autoFocus();
  legend.update(groupCounts(s.events, s.cursor), s.filters);
  updateRings();
  updateTracks();
  renderRail();
  renderCaption();
  announce();
}, 200);

// ---------------------------------------------------------------- subscriptions

store.subscribe(['events'], (s) => {
  eventById = new Map(s.events.map((e) => [e.id, e]));
  view.points.setEvents(s.events);
  view.points.setCursor(s.cursor);
  applyMask(true);
  timeline.setEvents(s.events);
  recompute();
  syncSelection();
  syncStageUi();
  heavy();
  updateCounter(true);
  errorState.update();
});

store.subscribe(['cursor'], (s) => {
  view.points.setCursor(s.cursor);
  updateCounter(s.live && !s.playing);
  heavy();
});

store.subscribe(['cursor', 'live', 'playing', 'speed', 'historyLoading', 'historyNote'], () => timeline.sync());
store.subscribe(['range'], () => timeline.rebin());

store.subscribe(['filters'], () => {
  applyMask();
  updateCounter(true);
  heavy();
});

store.subscribe(['focusCountry', 'focusPinned', 'focusEventId', 'eventPinned', 'stage'], () => {
  applyMask();
  syncSelection();
  syncStageUi();
  heavy();
});

store.subscribe(['railOpen', 'railTab'], (s) => {
  rail.applyChrome(s);
  rail.renderSources(s, true);
  syncStageUi();
  heavy();
});

store.subscribe(['streams', 'lastLiveUpdate'], (s) => {
  rail.renderSources(s);
  errorState.update();
  updateCounter(false);
});

store.subscribe(['hoverId'], (s) => view.points.setHover(view.points.indexOf(s.hoverId)));

store.subscribe(['firstLoadDone'], (s) => {
  if (!s.firstLoadDone) return;
  updateCounter(true);
  // History for the scrubber loads lazily once the live picture is up.
  const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1200));
  idle(() => void pipeline.ensureRange('30d'));
});

// ---------------------------------------------------------------- frame loop

const RAIL_SHIFT = 340;
const PANEL_SHIFT = 444;
let shift = 0;
let band = 0;
let focusKey = '';
let framesSincePick = 0;

function targetShift(s: State): number {
  const w = host.width;
  if (w < 900) return 0;
  let x = 0;
  if (s.railOpen && !(panel.isOpen && w < 1100)) x += RAIL_SHIFT / 2;
  if (panel.isOpen) x -= PANEL_SHIFT / 2;
  return x;
}

host.onFrame((dt, time) => {
  const s = store.get();

  const nextBand = s.stage < 0.5 ? 0 : s.stage < 1.5 ? 1 : 2;
  if (nextBand !== band) {
    // Leaving the planet view: keep wherever the user had turned the globe.
    if (band === 0) {
      planet.lat = rig.current.lat;
      planet.lon = rig.current.lon;
    }
    rig.resetOffset();
    band = nextBand;
  }
  const fk = `${s.focusCountry}|${s.focusEventId}`;
  if (fk !== focusKey) {
    if (band > 0) rig.resetOffset();
    focusKey = fk;
  }

  if (!s.reducedMotion && s.stage < 0.02 && !rig.isDragging && performance.now() - rig.lastInteraction > 3500) {
    planet.lon = ((planet.lon + dt * 2.4 + 540) % 360) - 180;
  }

  rig.desired = desiredPose(s);
  rig.update(dt);

  shift += (targetShift(s) - shift) * (1 - Math.exp(-dt * 5));
  host.setViewShift(shift);

  const scale = clamp(1.3 / Math.pow(rig.current.alt + 0.3, 0.4), 0.7, 2.1) * clamp(host.height / 900, 0.85, 1.25);
  view.points.frame(time, host.camera.position, scale, host.pixelRatio);
  timeline.frame(dt);

  framesSincePick++;
  if (pointer && (pointerDirty || framesSincePick > 8) && !rig.isDragging) {
    pointerDirty = false;
    framesSincePick = 0;
    const i = pick(pointer.x, pointer.y);
    const e = i >= 0 ? view.points.list[i] : undefined;
    setHover(e?.id ?? null);
    if (e) tooltip.show(e, pointer.x, pointer.y);
    else tooltip.hide();
    wrap.style.cursor = e ? 'pointer' : '';
  }
});

// ---------------------------------------------------------------- clock, keys, motion

window.setInterval(() => {
  const now = Date.now();
  timeline.setNow(now);
  if (store.get().live) store.set({ cursor: now });
  timeline.rebin();
}, 30_000);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (panel.isOpen) actions.closePanel();
  else if (store.get().railOpen) store.set({ railOpen: false, railUserSet: true });
});

reducedQuery.addEventListener('change', (e) => {
  store.set({ reducedMotion: e.matches });
  rig.instant = e.matches;
  view.points.setPulse(!e.matches);
  document.documentElement.classList.toggle('reduced-motion', e.matches);
  updateRings();
});

rail.applyChrome(store.get());
timeline.sync();
pipeline.start();

if (import.meta.env.DEV) {
  // Dev-only handle for poking at state from the console. Not included in production builds.
  void import('gsap/ScrollTrigger').then(({ ScrollTrigger }) => {
    Object.assign(window, { __earth: { store, rig, host, view, pipeline, ScrollTrigger } });
  });
}
