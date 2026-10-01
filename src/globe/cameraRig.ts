import * as THREE from 'three';
import { clamp } from '../data/util';
import { GLOBE_RADIUS, angleBetween, latLonToVec3, lonDelta } from './geo';

export interface Pose {
  lat: number;
  lon: number;
  /** Height above the surface in globe radii. */
  alt: number;
  /** Radians the camera leans back from straight-down; 0 at planet scale. */
  tilt: number;
}

interface Handlers {
  onHover?: (x: number, y: number) => void;
  onLeave?: () => void;
  onClick?: (x: number, y: number) => void;
}

const MIN_ALT = 0.06;
const MAX_ALT = 6;

/**
 * Our own camera rig (no OrbitControls). The scroll story sets a desired pose each frame;
 * the user's drag and zoom are an offset on top of it. The camera follows with a critically
 * damped spring, and climbs automatically when the target is far away, so long moves arc
 * up and over the globe instead of skimming its surface.
 */
export class CameraRig {
  readonly current: Pose = { lat: 15, lon: 0, alt: 3, tilt: 0 };
  desired: Pose = { lat: 15, lon: 0, alt: 3, tilt: 0 };
  readonly offset = { lat: 0, lon: 0, zoom: 1 };
  /** Reduced motion: cut straight to the target instead of easing. */
  instant = false;
  lastInteraction = -Infinity;

  private vel = { lat: 0, lon: 0, alt: 0, tilt: 0 };
  private inertia = { lat: 0, lon: 0 };
  private dragging = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart = { x: 0, y: 0, moved: 0 };
  private pinchDistance = 0;
  private lastMove = { x: 0, y: 0, t: 0 };
  private north = new THREE.Vector3();
  private surface = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private handlers: Handlers = {},
  ) {
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('pointerleave', () => this.handlers.onLeave?.());
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('keydown', this.onKey);
  }

  get isDragging() {
    return this.dragging;
  }

  resetOffset() {
    this.offset.lat = 0;
    this.offset.lon = 0;
    this.offset.zoom = 1;
    this.inertia.lat = 0;
    this.inertia.lon = 0;
  }

  /** Degrees of globe per screen pixel at the current height: keeps drags under the finger. */
  private degPerPx() {
    const fov = (this.camera.fov * Math.PI) / 180;
    return ((this.current.alt * 2 * Math.tan(fov / 2)) / this.dom.clientHeight) * (180 / Math.PI);
  }

  private target(): Pose {
    const d = this.desired;
    return {
      lat: clamp(d.lat + this.offset.lat, -80, 80),
      lon: d.lon + this.offset.lon,
      alt: clamp(d.alt * this.offset.zoom, MIN_ALT, MAX_ALT),
      tilt: d.tilt,
    };
  }

  update(dt: number) {
    if (!this.dragging && (this.inertia.lat || this.inertia.lon)) {
      this.offset.lat = clamp(this.offset.lat + this.inertia.lat * dt, -170, 170);
      this.offset.lon += this.inertia.lon * dt;
      const decay = Math.exp(-dt * 3.5);
      this.inertia.lat *= decay;
      this.inertia.lon *= decay;
      if (Math.abs(this.inertia.lat) + Math.abs(this.inertia.lon) < 0.05) this.inertia.lat = this.inertia.lon = 0;
    }
    // Keep the offset from pushing latitude past the poles.
    this.offset.lat = clamp(this.offset.lat, -80 - this.desired.lat, 80 - this.desired.lat);

    const t = this.target();
    const c = this.current;
    if (this.instant) {
      Object.assign(c, t);
    } else {
      const far = angleBetween(c.lat, c.lon, t.lat, t.lon);
      const altGoal = Math.max(t.alt, far > 0.3 ? far * 1.3 : 0);
      const w = this.dragging ? 18 : 3.3;
      const steps = Math.ceil(dt / 0.016);
      const h = dt / steps;
      const lonGoal = c.lon + lonDelta(c.lon, t.lon);
      for (let i = 0; i < steps; i++) {
        c.lat = this.spring('lat', c.lat, t.lat, w, h);
        c.lon = this.spring('lon', c.lon, lonGoal, w, h);
        // Altitude eases in log space so zooms feel even at every scale.
        c.alt = Math.exp(this.spring('alt', Math.log(c.alt), Math.log(altGoal), w * 0.9, h));
        c.tilt = this.spring('tilt', c.tilt, t.tilt, w * 0.8, h);
      }
      c.lon = ((((c.lon + 180) % 360) + 360) % 360) - 180;
    }
    this.apply();
  }

  private spring(key: keyof CameraRig['vel'], x: number, goal: number, w: number, h: number) {
    const a = w * w * (goal - x) - 2 * w * this.vel[key];
    this.vel[key] += a * h;
    return x + this.vel[key] * h;
  }

  private apply() {
    const { lat, lon, alt, tilt } = this.current;
    latLonToVec3(lat, lon, GLOBE_RADIUS, this.surface);
    this.normal.copy(this.surface).normalize();
    latLonToVec3(Math.min(lat + 0.5, 89.9), lon, GLOBE_RADIUS, this.north).sub(this.surface).normalize();
    this.dir.copy(this.normal).multiplyScalar(Math.cos(tilt)).addScaledVector(this.north, -Math.sin(tilt));
    this.camera.position.copy(this.surface).addScaledVector(this.dir, alt * GLOBE_RADIUS);
    this.camera.up.copy(this.north);
    this.camera.lookAt(this.surface);
  }

  // ---- input ----

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dom.setPointerCapture(e.pointerId);
    this.lastInteraction = performance.now();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    this.dragging = true;
    this.inertia.lat = this.inertia.lon = 0;
    this.dragStart = { x: e.clientX, y: e.clientY, moved: 0 };
    this.lastMove = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse') this.handlers.onHover?.(e.clientX, e.clientY);
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.lastInteraction = performance.now();

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDistance > 0) this.zoomBy(this.pinchDistance / d);
      this.pinchDistance = d;
      return;
    }
    if (!this.dragging) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.dragStart.moved += Math.abs(dx) + Math.abs(dy);
    const k = this.degPerPx();
    const dLon = (-dx * k) / Math.max(Math.cos((this.current.lat * Math.PI) / 180), 0.25);
    const dLat = dy * k;
    this.offset.lon += dLon;
    this.offset.lat += dLat;

    const now = performance.now();
    const dtm = Math.max(1, now - this.lastMove.t) / 1000;
    this.inertia.lon = this.inertia.lon * 0.6 + (dLon / dtm) * 0.4;
    this.inertia.lat = this.inertia.lat * 0.6 + (dLat / dtm) * 0.4;
    this.lastMove = { x: e.clientX, y: e.clientY, t: now };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    if (this.pointers.size > 0) {
      this.pinchDistance = 0;
      return;
    }
    const wasClick = this.dragging && this.dragStart.moved < 5 && e.type === 'pointerup';
    this.dragging = false;
    if (performance.now() - this.lastMove.t > 80) this.inertia.lat = this.inertia.lon = 0;
    if (wasClick) {
      this.inertia.lat = this.inertia.lon = 0;
      this.handlers.onClick?.(e.clientX, e.clientY);
    }
  };

  private onWheel = (e: WheelEvent) => {
    // Plain wheel scrolls the story. Pinch (reported as ctrl+wheel) or ctrl/⌘+wheel zooms.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.lastInteraction = performance.now();
    this.zoomBy(Math.exp(clamp(e.deltaY, -60, 60) * 0.012));
  };

  private onKey = (e: KeyboardEvent) => {
    const step = 4 * Math.min(2.5, Math.max(0.15, this.current.alt));
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        this.offset.lon -= step;
        break;
      case 'ArrowRight':
        this.offset.lon += step;
        break;
      case 'ArrowUp':
        this.offset.lat += step;
        break;
      case 'ArrowDown':
        this.offset.lat -= step;
        break;
      case '+':
      case '=':
        this.zoomBy(0.75);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / 0.75);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      this.lastInteraction = performance.now();
    }
  };

  zoomBy(factor: number) {
    const base = this.desired.alt;
    this.offset.zoom = clamp(this.offset.zoom * factor, MIN_ALT / base, MAX_ALT / base);
  }
}
