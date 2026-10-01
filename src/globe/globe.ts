import * as THREE from 'three';
import ThreeGlobe from 'three-globe';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { colorOf } from '../config';
import type { DisasterEvent } from '../data/types';
import { rgba } from './geo';
import { PointsLayer } from './points';

type CountryFeature = Feature<Polygon | MultiPolygon, { name: string; iso3: string }>;

interface RingDatum {
  key: string;
  lat: number;
  lng: number;
  maxR: number;
  speed: number;
  period: number;
  color: (t: number) => string;
}

export interface PathDatum {
  id: string;
  points: { lat: number; lon: number }[];
  color: [string, string];
}

export interface RingItem {
  event: DisasterEvent;
  lat: number;
  lon: number;
}

/**
 * three-globe draws the earth, borders, atmosphere, rings and tracks.
 * The camera is ours (see cameraRig.ts); the event points are a custom GPU layer
 * parented to the globe so they share its transform.
 */
export class GlobeView {
  readonly globe: ThreeGlobe;
  readonly points = new PointsLayer();
  private land = new THREE.MeshBasicMaterial({ color: '#111a21' });
  private landFocus = new THREE.MeshBasicMaterial({ color: '#1e2c38' });
  private side = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  private focus: { name: string; iso3: string } | null = null;
  private ringKey = '';
  private ringCache = new Map<string, RingDatum>();
  private pathKey = '';

  constructor(scene: THREE.Scene, animateIn: boolean) {
    this.globe = new ThreeGlobe({ animateIn, waitForGlobeReady: false });
    this.globe
      .showGlobe(true)
      .showGraticules(true)
      .showAtmosphere(true)
      .atmosphereColor('#4d7299')
      .atmosphereAltitude(0.16)
      .globeMaterial(
        new THREE.MeshPhongMaterial({ color: '#04080c', emissive: '#020406', specular: '#0a141c', shininess: 10 }),
      )
      .polygonsTransitionDuration(300)
      .polygonCapCurvatureResolution(4)
      .ringLat('lat')
      .ringLng('lng')
      .ringColor('color')
      .ringMaxRadius('maxR')
      .ringPropagationSpeed('speed')
      .ringRepeatPeriod('period')
      .ringAltitude(0.0085)
      .ringResolution(64)
      .pathPoints('points')
      .pathPointLat('lat')
      .pathPointLng('lon')
      .pathPointAlt(0.0075)
      .pathColor('color')
      .pathStroke(null)
      .pathResolution(1)
      .pathTransitionDuration(0);
    this.applyPolygonStyle();
    // three-globe's graticule is a little loud on a near-black globe; quieten it.
    this.globe.traverse((obj) => {
      const line = obj as THREE.LineSegments;
      if (line.isLineSegments && line.material instanceof THREE.LineBasicMaterial) line.material.opacity = 0.05;
    });
    this.globe.add(this.points.object);
    scene.add(this.globe);
  }

  get radius() {
    return this.globe.getGlobeRadius();
  }

  async loadCountries(url: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fc = (await res.json()) as FeatureCollection<Polygon | MultiPolygon, { name: string; iso3: string }>;
      this.globe.polygonsData(fc.features);
    } catch (err) {
      console.warn('[globe] country outlines unavailable', err);
    }
  }

  private isFocus = (d: object) => {
    if (!this.focus) return false;
    const p = (d as CountryFeature).properties;
    return (!!this.focus.iso3 && p.iso3 === this.focus.iso3) || p.name === this.focus.name;
  };

  private applyPolygonStyle() {
    // Fresh accessor functions make three-globe re-evaluate every polygon.
    this.globe
      .polygonCapMaterial((d: object) => (this.isFocus(d) ? this.landFocus : this.land))
      .polygonSideMaterial(() => this.side)
      .polygonStrokeColor((d: object) => (this.isFocus(d) ? 'rgba(214,224,233,0.8)' : 'rgba(128,150,172,0.28)'))
      .polygonAltitude((d: object) => (this.isFocus(d) ? 0.0065 : 0.004));
  }

  setFocusCountry(focus: { name: string; iso3: string } | null) {
    if (focus?.name === this.focus?.name && focus?.iso3 === this.focus?.iso3) return;
    this.focus = focus;
    this.applyPolygonStyle();
  }

  /** Rings for the most severe events in view (and the selected one). */
  setRings(items: RingItem[], selectedId: string | null) {
    const key = items.map((r) => `${r.event.id}@${r.lat.toFixed(1)},${r.lon.toFixed(1)}`).join('|') + `#${selectedId ?? ''}`;
    if (key === this.ringKey) return;
    this.ringKey = key;
    this.globe.ringsData(items.map((r) => this.ring(r, r.event.id === selectedId)));
  }

  private ring({ event: e, lat, lon }: RingItem, selected: boolean): RingDatum {
    const key = `${e.id}@${lat.toFixed(1)},${lon.toFixed(1)}${selected ? '#sel' : ''}`;
    const cached = this.ringCache.get(key);
    if (cached) return cached;
    const s = e.severity;
    const color = colorOf(e.type);
    const quake = e.type === 'earthquake';
    const peak = selected ? 0.95 : quake ? 0.78 : 0.55;
    const d: RingDatum = {
      key,
      lat,
      lng: lon,
      // Seismic rings: bigger, faster and more frequent with magnitude.
      maxR: quake ? 1.4 + s * 5.5 : 1.1 + s * 3.2,
      speed: quake ? 0.8 + s * 2.8 : 0.45 + s * 1.1,
      period: quake ? 2600 - s * 1300 : 3800 - s * 900,
      color: (t: number) => rgba(color, peak * (1 - t) ** 1.4),
    };
    if (this.ringCache.size > 800) this.ringCache.clear();
    this.ringCache.set(key, d);
    return d;
  }

  setTracks(paths: PathDatum[]) {
    const key = paths
      .map((p) => {
        const head = p.points[p.points.length - 1];
        return `${p.id}:${p.points.length}:${head.lat.toFixed(1)},${head.lon.toFixed(1)}`;
      })
      .join('|');
    if (key === this.pathKey) return;
    this.pathKey = key;
    this.globe.pathsData(paths);
  }
}
