import * as THREE from 'three';
import { presence } from '../data/derive';
import type { PointsLayer } from './points';

const p = new THREE.Vector3();
const toCam = new THREE.Vector3();
const camLocal = new THREE.Vector3();

/**
 * Screen-space nearest-point picking. Cheap enough for many thousands of points per
 * pointer move, and independent of how the points are drawn.
 */
export function pickPoint(
  layer: PointsLayer,
  camera: THREE.Camera,
  clientX: number,
  clientY: number,
  rect: DOMRect,
  cursor: number,
): number {
  const events = layer.list;
  const pos = layer.localPositions;
  const vis = layer.visibility;
  const obj = layer.object;
  obj.updateMatrixWorld();
  camera.getWorldPosition(camLocal);
  obj.worldToLocal(camLocal);

  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < events.length; i++) {
    if (!vis[i]) continue;
    const e = events[i];
    if (presence(e, cursor) < 0.08) continue;
    p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    toCam.subVectors(camLocal, p).normalize();
    if (toCam.dot(p.clone().normalize()) < 0.06) continue; // far side of the globe
    p.applyMatrix4(obj.matrixWorld).project(camera);
    if (p.z > 1) continue;
    const sx = rect.left + ((p.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - p.y) / 2) * rect.height;
    const d = Math.hypot(sx - clientX, sy - clientY);
    const radius = 8 + e.severity * 8;
    if (d > radius) continue;
    const score = d - e.severity * 5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
