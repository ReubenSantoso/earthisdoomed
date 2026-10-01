import * as THREE from 'three';
import { HOUR, WINDOW_MS, colorOf } from '../config';
import type { DisasterEvent } from '../data/types';
import { GLOBE_RADIUS, hexToRgb, latLonToVec3, lonDelta } from './geo';

/*
 * Every event is one vertex of a single THREE.Points draw call. Time fading, filter masks,
 * pulses and highlight all happen in the shader, so scrubbing the timeline only changes a
 * uniform: no geometry is rebuilt while you drag. (three-globe's own points layer rebuilds a
 * merged mesh on every data change, which is too slow for live scrubbing over thousands of
 * points; this layer still lives inside the three-globe object and uses its coordinates.)
 */

/** Shader times are hours since this epoch, so float32 keeps sub-minute precision. */
const TIME_BASE = Date.now() - 420 * 24 * HOUR;
export const toShaderHours = (ms: number) => (Number.isFinite(ms) ? (ms - TIME_BASE) / HOUR : 1e7);

const POINT_ALTITUDE = 1.009;

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSeverity;
  attribute float aT0;
  attribute float aT1;
  attribute float aVisible;
  attribute float aDim;
  attribute float aPhase;
  attribute float aIndex;

  uniform float uCursor;
  uniform float uWindow;
  uniform float uTime;
  uniform float uPulse;
  uniform float uSizeScale;
  uniform float uPixelRatio;
  uniform float uHover;
  uniform float uSelected;
  uniform vec3 uCameraLocal;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vHighlight;

  void main() {
    float alpha = 0.0;
    if (uCursor >= aT0) {
      float age = uCursor - aT1;
      alpha = age <= 0.0 ? 1.0 : pow(clamp(1.0 - age / uWindow, 0.0, 1.0), 0.7);
    }
    alpha *= aVisible;
    alpha *= mix(1.0, 0.16, aDim);

    vec3 n = normalize(position);
    float facing = dot(n, normalize(uCameraLocal - position));
    alpha *= smoothstep(-0.03, 0.22, facing);

    float isHover = 1.0 - step(0.5, abs(aIndex - uHover));
    float isSelected = 1.0 - step(0.5, abs(aIndex - uSelected));
    vHighlight = max(isHover, isSelected);

    // Newly appeared events flare briefly (in timeline time), then settle.
    float fresh = (uCursor >= aT0) ? clamp(1.0 - (uCursor - aT0) / 2.0, 0.0, 1.0) : 0.0;

    float size = mix(2.6, 12.5, pow(aSeverity, 0.8));
    size *= 1.0 + uPulse * (0.1 + aSeverity * 0.22) * sin(uTime * (1.1 + aSeverity * 1.4) + aPhase);
    size *= 1.0 + fresh * 0.9;
    size *= 1.0 + vHighlight * 0.8;

    vColor = aColor;
    vAlpha = alpha;
    gl_PointSize = alpha > 0.002 ? size * uSizeScale * uPixelRatio : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vHighlight;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.62, 0.28, d);
    float halo = smoothstep(1.0, 0.35, d) * 0.32;
    float ring = vHighlight * smoothstep(0.1, 0.0, abs(d - 0.84));
    vec3 color = mix(vColor, vec3(1.0), core * 0.18 + ring * 0.55);
    gl_FragColor = vec4(color, (core + halo + ring * 0.9) * vAlpha);
  }
`;

export class PointsLayer {
  readonly object: THREE.Points;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private events: DisasterEvent[] = [];
  private positions = new Float32Array(0);
  private visible = new Float32Array(0);
  private dim = new Float32Array(0);
  private tracked: number[] = [];
  private lastTrackCursor = NaN;
  private indexById = new Map<string, number>();

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uCursor: { value: toShaderHours(Date.now()) },
        uWindow: { value: WINDOW_MS / HOUR },
        uTime: { value: 0 },
        uPulse: { value: 1 },
        uSizeScale: { value: 1 },
        uPixelRatio: { value: 1 },
        uHover: { value: -1 },
        uSelected: { value: -1 },
        uCameraLocal: { value: new THREE.Vector3() },
      },
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
  }

  get list(): readonly DisasterEvent[] {
    return this.events;
  }

  /** World-independent local positions, read by the picker. */
  get localPositions(): Float32Array {
    return this.positions;
  }

  get visibility(): Float32Array {
    return this.visible;
  }

  indexOf(id: string | null | undefined): number {
    return id ? (this.indexById.get(id) ?? -1) : -1;
  }

  setEvents(events: DisasterEvent[]) {
    this.events = events;
    const n = events.length;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const severity = new Float32Array(n);
    const t0 = new Float32Array(n);
    const t1 = new Float32Array(n);
    const phase = new Float32Array(n);
    const index = new Float32Array(n);
    this.visible = new Float32Array(n).fill(1);
    this.dim = new Float32Array(n);
    this.tracked = [];
    this.indexById.clear();
    const v = new THREE.Vector3();

    events.forEach((e, i) => {
      latLonToVec3(e.lat, e.lon, GLOBE_RADIUS * POINT_ALTITUDE, v);
      position.set([v.x, v.y, v.z], i * 3);
      color.set(hexToRgb(colorOf(e.type)), i * 3);
      severity[i] = e.severity;
      t0[i] = toShaderHours(e.t0);
      t1[i] = toShaderHours(e.t1);
      phase[i] = (i * 2.399963) % (Math.PI * 2);
      index[i] = i;
      if (e.track && e.track.length > 1) this.tracked.push(i);
      this.indexById.set(e.id, i);
    });
    this.positions = position;
    this.lastTrackCursor = NaN;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('aSeverity', new THREE.BufferAttribute(severity, 1));
    geometry.setAttribute('aT0', new THREE.BufferAttribute(t0, 1));
    geometry.setAttribute('aT1', new THREE.BufferAttribute(t1, 1));
    geometry.setAttribute('aVisible', new THREE.BufferAttribute(this.visible, 1));
    geometry.setAttribute('aDim', new THREE.BufferAttribute(this.dim, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    this.object.geometry = geometry;
    this.geometry.dispose();
    this.geometry = geometry;
  }

  /** Filter mask (1 = drawn) and focus dimming (1 = dimmed) per event. */
  setMask(visibleFn: (e: DisasterEvent) => boolean, dimFn: (e: DisasterEvent) => boolean) {
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      this.visible[i] = visibleFn(e) ? 1 : 0;
      this.dim[i] = dimFn(e) ? 1 : 0;
    }
    const vis = this.geometry.getAttribute('aVisible') as THREE.BufferAttribute | undefined;
    const dim = this.geometry.getAttribute('aDim') as THREE.BufferAttribute | undefined;
    if (vis) vis.needsUpdate = true;
    if (dim) dim.needsUpdate = true;
  }

  setCursor(cursorMs: number) {
    this.material.uniforms.uCursor.value = toShaderHours(cursorMs);
    this.updateTracks(cursorMs);
  }

  /** Moving events (storms, icebergs) slide along their observed track as time is scrubbed. */
  private updateTracks(cursorMs: number) {
    if (!this.tracked.length) return;
    if (Math.abs(cursorMs - this.lastTrackCursor) < 10 * 60_000) return;
    this.lastTrackCursor = cursorMs;
    const v = new THREE.Vector3();
    for (const i of this.tracked) {
      const { lat, lon } = trackPosition(this.events[i].track!, cursorMs);
      latLonToVec3(lat, lon, GLOBE_RADIUS * POINT_ALTITUDE, v);
      this.positions[i * 3] = v.x;
      this.positions[i * 3 + 1] = v.y;
      this.positions[i * 3 + 2] = v.z;
    }
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos) pos.needsUpdate = true;
  }

  setHover(index: number) {
    this.material.uniforms.uHover.value = index;
  }

  setSelected(index: number) {
    this.material.uniforms.uSelected.value = index;
  }

  setPulse(on: boolean) {
    this.material.uniforms.uPulse.value = on ? 1 : 0;
  }

  frame(time: number, cameraWorld: THREE.Vector3, sizeScale: number, pixelRatio: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uSizeScale.value = sizeScale;
    u.uPixelRatio.value = pixelRatio;
    (u.uCameraLocal.value as THREE.Vector3).copy(cameraWorld);
    this.object.worldToLocal(u.uCameraLocal.value as THREE.Vector3);
  }
}

/** Position along a track at time t (clamped to its ends, linear between observations). */
export function trackPosition(track: { t: number; lat: number; lon: number }[], t: number) {
  if (t <= track[0].t) return track[0];
  const last = track[track.length - 1];
  if (t >= last.t) return last;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  return { t, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + lonDelta(a.lon, b.lon) * f };
}
