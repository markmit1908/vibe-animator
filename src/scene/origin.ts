/**
 * Picking a model origin from CAD geometry: the axis of a vertical cylindrical face (fitted from the clicked mesh's
 * vertices and normals) and the height of a flat face.
 */
import * as THREE from 'three';

export interface CylinderFit { centre: THREE.Vector3; radius: number; inliers: number }

/** Fit the vertical cylinder through a ray hit on a curved face. Undefined when it isn't one (e.g. a flat or a
 *  horizontal face, or too few vertices agree). */
export function fitVerticalCylinder(hit: THREE.Intersection): CylinderFit | undefined {
  const mesh = hit.object as THREE.Mesh;
  const g = mesh.geometry as THREE.BufferGeometry;
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal');
  if (!pos || !nrm || !hit.face) return;
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  // anchor on the clicked triangle's vertex nearest the hit: vertices lie on the true circle (the hit point on a coarse
  // facet doesn't), and their normals are the surface's
  let best = -1, bd = Infinity;
  const v = new THREE.Vector3(), vn = new THREE.Vector3();
  for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
    vn.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
    if (Math.abs(vn.y) > 0.3) continue;
    const d = v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).distanceTo(hit.point);
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) return;                                 // not a wall of a vertical cylinder
  const n0 = new THREE.Vector3().fromBufferAttribute(nrm, best).applyMatrix3(nm);
  n0.y = 0; n0.normalize();
  const p0 = new THREE.Vector3().fromBufferAttribute(pos, best).applyMatrix4(mesh.matrixWorld);
  // every vertex with a horizontal normal: where its normal line meets the hit's normal line (in plan) is the axis
  const step = Math.max(1, Math.floor(pos.count / 200_000));
  const pts: [THREE.Vector3, THREE.Vector3][] = [];
  const r: number[] = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += step) {
    n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
    if (Math.abs(n.y) > 0.3) continue;
    n.y = 0; n.normalize();
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    // p0 - a·n0 = p - b·n  →  a·n0 - b·n = p0 - p  (x, z)
    const det = -n0.x * n.z + n0.z * n.x;
    if (Math.abs(det) < 0.05) continue;                 // (anti)parallel normals: no intersection
    const dx = p0.x - p.x, dz = p0.z - p.z;
    const a = (-dx * n.z + dz * n.x) / det, b = (n0.x * dz - n0.z * dx) / det;
    if (Math.abs(a - b) > 0.02 * Math.max(Math.abs(a), Math.abs(b), 1e-3)) continue; // not on the same circle
    r.push(a);
    pts.push([p.clone(), n.clone()]);
  }
  if (r.length < 3) return;
  const sorted = [...r].sort((x, y) => x - y), radius = sorted[sorted.length >> 1];   // signed: negative = inner surface
  const tol = Math.max(0.002, Math.abs(radius) * 0.02);
  const centre = new THREE.Vector3(); let k = 0;
  pts.forEach(([q, m], i) => { if (Math.abs(r[i] - radius) < tol) { centre.add(q.clone().addScaledVector(m, -radius)); k++; } });
  if (k < 3) return;
  centre.divideScalar(k); centre.y = hit.point.y;
  return { centre, radius: Math.abs(radius), inliers: k };
}

/** The height of a flat face from a hit: its y when the face is horizontal, else undefined. */
export function planeHeight(hit: THREE.Intersection): number | undefined {
  if (!hit.face) return;
  const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
  return Math.abs(n.y) > 0.95 ? hit.point.y : undefined;
}
