import * as THREE from 'three';
import { DEG } from '../data/util';

/** three-globe's globe radius, in scene units. */
export const GLOBE_RADIUS = 100;

/** Same spherical convention as three-globe's getCoords (y up, lon 0 facing +z). */
export function latLonToVec3(lat: number, lon: number, r = GLOBE_RADIUS, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = (90 - lat) * DEG;
  const theta = (90 - lon) * DEG;
  return out.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

/** Shortest signed longitude difference b - a, in degrees. */
export function lonDelta(a: number, b: number): number {
  return ((((b - a + 180) % 360) + 360) % 360) - 180;
}

/** Great-circle angle between two lat/lon points, radians. */
export function angleBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse "#rrggbb" into 0..1 sRGB components (no colour-management conversion). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha.toFixed(3)})`;
}
