// Window / crossing selection (CAD style): a rectangle on the screen picks the parts (meshes) wholly inside it
// (window, dragged left → right) or inside or crossing it (crossing, right → left). Parts behind others count.
import * as THREE from 'three';

export interface Rect { x0: number; y0: number; x1: number; y1: number }   // NDC, x0 < x1, y0 < y1

const v = new THREE.Vector4();
const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

/** Project a point (world) to NDC; null when behind the eye. */
function ndc(p: THREE.Vector3, vp: THREE.Matrix4, out: THREE.Vector2): boolean {
  v.set(p.x, p.y, p.z, 1).applyMatrix4(vp);
  if (v.w <= 1e-9) return false;
  out.set(v.x / v.w, v.y / v.w);
  return true;
}
const inside = (p: THREE.Vector2, r: Rect) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/** Does the 2D triangle abc touch the rectangle? (vertices in, rect corners in, or edges crossing) */
function triTouches(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, r: Rect): boolean {
  if (inside(a, r) || inside(b, r) || inside(c, r)) return true;
  if (Math.max(a.x, b.x, c.x) < r.x0 || Math.min(a.x, b.x, c.x) > r.x1 || Math.max(a.y, b.y, c.y) < r.y0 || Math.min(a.y, b.y, c.y) > r.y1) return false;
  // a rect corner inside the triangle
  const s = (p: THREE.Vector2, q: THREE.Vector2, x: number, y: number) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
  for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]) {
    const d1 = s(a, b, x, y), d2 = s(b, c, x, y), d3 = s(c, a, x, y);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
  }
  // an edge crossing a rect side (Liang–Barsky clip of the segment)
  const seg = (p: THREE.Vector2, q: THREE.Vector2) => {
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dy = q.y - p.y;
    for (const [pp, qq] of [[-dx, p.x - r.x0], [dx, r.x1 - p.x], [-dy, p.y - r.y0], [dy, r.y1 - p.y]]) {
      if (pp === 0) { if (qq < 0) return false; continue; }
      const t = qq / pp;
      if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
  };
  return seg(a, b) || seg(b, c) || seg(c, a);
}

/**
 * The meshes in `candidates` picked by the rectangle. Window: every vertex inside (behind-the-eye vertices fail it).
 * Crossing: any triangle touching the rectangle. Bounding boxes decide most meshes without looking at vertices.
 */
export function partsInRect(candidates: THREE.Mesh[], camera: THREE.Camera, r: Rect, crossing: boolean): THREE.Mesh[] {
  camera.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const out: THREE.Mesh[] = [];
  const p2 = new THREE.Vector2(), a2 = new THREE.Vector2(), b2 = new THREE.Vector2(), c2 = new THREE.Vector2();
  const w = new THREE.Vector3(), m = new THREE.Matrix4(), mi = new THREE.Matrix4();
  for (const mesh of candidates) {
    const g = mesh.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos || !pos.count) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? mesh as THREE.InstancedMesh : null;
    const n = inst ? inst.count : 1;
    let all = true, any = false;
    for (let k = 0; k < n && (crossing ? !any : all); k++) {
      if (inst) { inst.getMatrixAt(k, mi); m.multiplyMatrices(mesh.matrixWorld, mi); } else m.copy(mesh.matrixWorld);
      // 1) the box: all corners in → in; all corners off one side → out
      const bb = g.boundingBox!;
      let cin = 0, behind = 0, left = 0, right = 0, below = 0, above = 0;
      for (let i = 0; i < 8; i++) {
        corners[i].set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m);
        if (!ndc(corners[i], vp, p2)) { behind++; continue; }
        if (inside(p2, r)) cin++;
        if (p2.x < r.x0) left++; if (p2.x > r.x1) right++; if (p2.y < r.y0) below++; if (p2.y > r.y1) above++;
      }
      if (cin === 8) { any = true; continue; }
      if (!behind && (left === 8 || right === 8 || below === 8 || above === 8)) { all = false; continue; }
      if (behind === 8) { all = false; continue; }
      // 2) the geometry
      if (!crossing) {
        for (let i = 0; i < pos.count; i++) {
          w.fromBufferAttribute(pos, i).applyMatrix4(m);
          if (!ndc(w, vp, p2) || !inside(p2, r)) { all = false; break; }
        }
        if (all) any = true;
      } else {
        const idx = g.index, tris = idx ? idx.count / 3 : pos.count / 3;
        const P = (i: number, o: THREE.Vector2) => ndc(w.fromBufferAttribute(pos, i).applyMatrix4(m), vp, o);
        for (let t = 0; t < tris; t++) {
          const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          if (!P(i0, a2) || !P(i1, b2) || !P(i2, c2)) continue;
          if (triTouches(a2, b2, c2, r)) { any = true; break; }
        }
      }
    }
    if (crossing ? any : all && any) out.push(mesh);
  }
  return out;
}
