// Section faces of cut parts: closed loops where a cut plane meets a solid, the caps that fill them (occluders, so
// the inside of a cut part doesn't show through) and their hatching (45° on the paper, spacing in mm).
import * as THREE from 'three';
import type { Edge3 } from './edges';

export type P4 = [number, number, number, number];
type V3 = [number, number, number];
export interface Section {
  plane: P4; loops: V3[][];
  /** where this face meets another cut face (quarter cuts): drawn as edges */
  corners: [V3, V3][];
}

const dist = (p: V3, pl: P4) => pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3];

/** Clip a closed 3D polygon to the side of `pl` where dist < 0 (Sutherland–Hodgman). */
function clipNeg(poly: V3[], pl: P4): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = dist(a, pl), db = dist(b, pl);
    if (da < 0) out.push(a);
    if ((da < 0) !== (db < 0)) { const s = da / (da - db); out.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]); }
  }
  return out;
}

/**
 * The section loops of a mesh (world positions) for a cut with these planes (clipIntersection): on plane i, the
 * cross-section of the solid, kept where every other plane removes (the cut region's face). Open chains (meshes
 * that aren't closed) are dropped.
 */
export function sectionLoops(pos: Float32Array, idx: Uint32Array, planes: P4[], tol: number): Section[] {
  const out: Section[] = [];
  const P = (v: number): V3 => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  planes.forEach((pl, i) => {
    const key = (p: V3) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
    const pts = new Map<string, V3>(), adj = new Map<string, string[]>();
    const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); };
    for (let t = 0; t < idx.length; t += 3) {
      const v = [P(idx[t]), P(idx[t + 1]), P(idx[t + 2])];
      const d = v.map((p) => { const x = dist(p, pl); return x === 0 ? 1e-12 : x; }); // on the plane counts as the kept side
      const cut: V3[] = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3], da = d[e], db = d[(e + 1) % 3];
        if ((da < 0) !== (db < 0)) { const s = da / (da - db); cut.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]); }
      }
      if (cut.length !== 2) continue;
      const ka = key(cut[0]), kb = key(cut[1]);
      if (ka === kb) continue;
      pts.set(ka, cut[0]); pts.set(kb, cut[1]);
      link(ka, kb); link(kb, ka);
    }
    // walk closed loops
    const used = new Set<string>(), loops: V3[][] = [];
    const ek = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
    for (const start of adj.keys()) {
      for (const first of adj.get(start)!) {
        if (used.has(ek(start, first))) continue;
        const loop = [start];
        let prev = start, cur = first, closed = false;
        used.add(ek(start, first));
        while (true) {
          if (cur === start) { closed = true; break; }
          loop.push(cur);
          const nx = adj.get(cur)!.find((n) => n !== prev && !used.has(ek(cur, n)));
          if (!nx) break;
          used.add(ek(cur, nx)); prev = cur; cur = nx;
        }
        if (closed && loop.length >= 3) loops.push(loop.map((k) => pts.get(k)!));
      }
    }
    // keep the part of the section inside the cut region (the other planes' removed side)
    let kept = loops;
    planes.forEach((q, j) => { if (j !== i) kept = kept.map((l) => clipNeg(l, q)).filter((l) => l.length >= 3); });
    // sides of the kept loops lying on another plane: the corner where two cut faces meet (count each once: j > i)
    const corners: [V3, V3][] = [];
    planes.forEach((q, j) => {
      if (j <= i) return;
      const eps = tol * 10;
      for (const l of kept) for (let k = 0; k < l.length; k++) {
        const a = l[k], b = l[(k + 1) % l.length];
        if (Math.abs(dist(a, q)) < eps && Math.abs(dist(b, q)) < eps) corners.push([a, b]);
      }
    });
    if (kept.length) out.push({ plane: pl, loops: kept, corners });
  });
  return out;
}

/** A 2D frame on a plane: origin, u, v (unit, orthogonal). */
function planeFrame(pl: P4) {
  const n = new THREE.Vector3(pl[0], pl[1], pl[2]).normalize();
  const o = n.clone().multiplyScalar(-pl[3] / Math.hypot(pl[0], pl[1], pl[2]));
  const u = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  return { o, u, v };
}

/** Even-odd fill of the loops as triangles (outer loops with their holes), for occlusion. */
export function capTriangles(s: Section): { pos: Float32Array; idx: Uint32Array } {
  const { o, u, v } = planeFrame(s.plane);
  const to2 = (p: V3) => { const d = new THREE.Vector3(...p).sub(o); return new THREE.Vector2(d.dot(u), d.dot(v)); };
  const loops = s.loops.map((l) => l.map(to2));
  const inside = (p: THREE.Vector2, l: THREE.Vector2[]) => {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) if ((l[i].y > p.y) !== (l[j].y > p.y) && p.x < ((l[j].x - l[i].x) * (p.y - l[i].y)) / (l[j].y - l[i].y) + l[i].x) c = !c;
    return c;
  };
  // nesting depth of each loop: even = outer boundary, odd = hole of the smallest loop containing it
  const parents = loops.map((l, i) => loops.map((_, j) => j).filter((j) => j !== i && inside(l[0], loops[j])));
  const depth = parents.map((p) => p.length);
  const P: number[] = [], I: number[] = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((_, j) => depth[j] === depth[i] + 1 && parents[j].includes(i)); // directly inside
    const contour = THREE.ShapeUtils.isClockWise(outer) ? [...outer].reverse() : outer;
    const hs = holes.map((h) => (THREE.ShapeUtils.isClockWise(h) ? h : [...h].reverse()));
    const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
    const all = [...contour, ...hs.flat()], base = P.length / 3;
    for (const q of all) { const w = o.clone().addScaledVector(u, q.x).addScaledVector(v, q.y); P.push(w.x, w.y, w.z); }
    for (const t of tris) I.push(base + t[0], base + t[1], base + t[2]);
  });
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}

/**
 * Hatch lines over a section, in 3D on its plane, laid out on the screen: lines at `angleDeg` to the paper's
 * x axis, `spacing` apart (drawing units, i.e. metres for orthographic views). Skipped for a plane seen edge-on.
 */
export function hatchEdges(s: Section, camera: THREE.Camera, spacing: number, angleDeg: number, part: string, mesh: number): Edge3[] {
  camera.updateMatrixWorld();
  const R = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const U = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const F = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  const n = new THREE.Vector3(s.plane[0], s.plane[1], s.plane[2]);
  const nf = n.dot(F);
  if (Math.abs(nf) < 1e-3 * n.length()) return [];
  const O = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const scr = (p: V3) => { const d = new THREE.Vector3(...p).sub(O); return [d.dot(R), d.dot(U)]; };
  // screen point → the point on the plane under it
  const lift = (x: number, y: number): V3 => {
    const b = O.clone().addScaledVector(R, x).addScaledVector(U, y);
    const z = -(n.dot(b) + s.plane[3]) / nf;
    b.addScaledVector(F, z);
    return [b.x, b.y, b.z];
  };
  const a = (angleDeg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx; // line direction, normal
  const loops = s.loops.map((l) => l.map(scr));
  let cmin = Infinity, cmax = -Infinity;
  for (const l of loops) for (const [x, y] of l) { const c = x * nx + y * ny; cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); }
  const out: Edge3[] = [];
  if (!(cmax > cmin) || (cmax - cmin) / spacing > 20000) return out;
  for (let c = Math.ceil(cmin / spacing) * spacing; c <= cmax; c += spacing) {
    const ts: number[] = [];
    for (const l of loops) for (let i = 0; i < l.length; i++) {
      const p = l[i], q = l[(i + 1) % l.length];
      const cp = p[0] * nx + p[1] * ny - c, cq = q[0] * nx + q[1] * ny - c;
      if ((cp < 0) !== (cq < 0)) { const s2 = cp / (cp - cq); const x = p[0] + (q[0] - p[0]) * s2, y = p[1] + (q[1] - p[1]) * s2; ts.push(x * dx + y * dy); }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const at = (t: number) => lift(nx * c + dx * t, ny * c + dy * t);
      out.push({ a: at(ts[k]), b: at(ts[k + 1]), kind: 'hatch', part, mesh });
    }
  }
  return out;
}
