// Gather the visible meshes of a scene as world-space triangle soups (one per mesh/instance).
import * as THREE from 'three';
import { sectionLoops, type Section } from './sections';

export interface MeshSoup {
  /** world-space vertex positions (x, y, z …) */
  pos: Float32Array;
  /** triangle vertex indices into pos */
  idx: Uint32Array;
  /** the part this mesh belongs to (userData.id of the nearest registered ancestor) */
  part: string;
  /** the section faces where a cut opened this mesh (for caps and hatching) */
  sections?: Section[];
  /** the material's colour (#rrggbb), for fills */
  color?: string;
  /** an occluder only (section caps): hides things, draws no edges of its own */
  occluder?: boolean;
}

const shown = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
const partOf = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.id) return String(p.userData.id); return o.uuid; };
const seeThrough = (m: THREE.Material | THREE.Material[]) => (Array.isArray(m) ? m : [m]).every((x) => x.visible === false || (x.transparent && x.opacity < 0.05) || x.side === THREE.BackSide); // BackSide = outline hulls

type P4 = [number, number, number, number];
const MESH_TOL = 1e-6; // plane: normal, constant (three's Plane: n·p + c, clipped where < 0)

/**
 * Cut a triangle soup the way the cutaway clips it on screen: split triangles by every plane and drop the cells
 * that are clipped (clipIntersection: on the negative side of every plane; otherwise of any plane).
 * Cut faces become open boundaries, so the section outline is drawn.
 */
export function clipSoup(pos: Float32Array, idx: Uint32Array, planes: P4[], intersection: boolean): { pos: Float32Array; idx: Uint32Array } {
  const d = (x: number, y: number, z: number, p: P4) => p[0] * x + p[1] * y + p[2] * z + p[3];
  const removed = (ds: number[]) => (intersection ? ds.every((v) => v < 0) : ds.some((v) => v < 0));
  const P: number[] = Array.from(pos), I: number[] = [];
  const T = idx.length / 3;
  for (let t = 0; t < T; t++) {
    const vs = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const dist = planes.map((p) => vs.map((v) => d(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], p)));
    const crosses = dist.some((ds) => Math.min(...ds) < 0 && Math.max(...ds) > 0);
    if (!crosses) {
      // whole triangle on one side of every plane: classify by its centre
      if (!removed(dist.map((ds) => ds[0] + ds[1] + ds[2]))) I.push(...vs);
      continue;
    }
    let polys: number[][][] = [vs.map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])];
    for (const p of planes) {
      const next: number[][][] = [];
      for (const poly of polys) {
        const dd = poly.map((q) => d(q[0], q[1], q[2], p));
        if (dd.every((v) => v >= 0) || dd.every((v) => v <= 0)) { next.push(poly); continue; }
        const pos2: number[][] = [], neg: number[][] = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length], da = dd[i], db = dd[(i + 1) % poly.length];
          if (da >= 0) pos2.push(a); if (da <= 0) neg.push(a);
          if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
            const s = da / (da - db), x = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
            pos2.push(x); neg.push(x);
          }
        }
        if (pos2.length >= 3) next.push(pos2);
        if (neg.length >= 3) next.push(neg);
      }
      polys = next;
    }
    for (const poly of polys) {
      const c = [0, 1, 2].map((k) => poly.reduce((s, q) => s + q[k], 0) / poly.length);
      if (removed(planes.map((p) => d(c[0], c[1], c[2], p)))) continue;
      const base = P.length / 3;
      for (const q of poly) P.push(q[0], q[1], q[2]);
      for (let k = 1; k + 1 < poly.length; k++) I.push(base, base + k, base + k + 1);
    }
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}

/** The cutaway planes a mesh is clipped by (none for parts kept uncut). */
function clipOf(mesh: THREE.Mesh): { planes: P4[]; intersection: boolean } | null {
  if (mesh.userData.uncut) return null;
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material | undefined;
  const pl = mat?.clippingPlanes;
  if (!pl?.length) return null;
  // applyCutaway parks unused planes far away: +1e9 clips nothing (so, intersected, the cut clips nothing), −1e9 clips everything (no effect on an intersection)
  if (mat!.clipIntersection && pl.some((p) => p.constant > 1e8)) return null;
  const planes = pl.filter((p) => Math.abs(p.constant) < 1e8).map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant] as P4);
  return planes.length ? { planes, intersection: !!mat!.clipIntersection } : null;
}

export interface CollectOptions {
  /** skip these objects and everything under them (gizmo, helpers, hidden parts) */ exclude?: THREE.Object3D[];
  /** draw only meshes under these objects */ only?: THREE.Object3D[];
  /** apply the materials' cutaway clip planes (default true) */ clip?: boolean;
}

/** Visible, opaque meshes under `root`, as world-space triangles cut like the view. */
export function collectMeshes(root: THREE.Object3D, opt: CollectOptions | THREE.Object3D[] = {}): MeshSoup[] {
  const o0: CollectOptions = Array.isArray(opt) ? { exclude: opt } : opt;
  const skip = new Set(o0.exclude ?? []);
  const only = o0.only ? new Set(o0.only) : null;
  const under = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (only!.has(p)) return true; return false; };
  const out: MeshSoup[] = [];
  root.updateMatrixWorld(true);
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  const walk = (o: THREE.Object3D) => {
    if (skip.has(o) || !o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(o as any).isSprite && mesh.geometry?.attributes.position && !seeThrough(mesh.material) && shown(o) && (!only || under(o))) {
      const cut = o0.clip === false ? null : clipOf(mesh);
      const m0 = (mesh.userData.origMat ?? (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)) as THREE.MeshBasicMaterial;
      const color = m0?.color ? '#' + m0.color.getHexString() : undefined;
      const g = mesh.geometry, src = g.attributes.position as THREE.BufferAttribute;
      const n = src.count;
      const idx = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({ length: n - (n % 3) }, (_, i) => i);
      const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh) : null;
      const count = inst ? inst.count : 1;
      for (let k = 0; k < count; k++) {
        if (inst) { inst.getMatrixAt(k, m); m.premultiply(o.matrixWorld); } else m.copy(o.matrixWorld);
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { v.fromBufferAttribute(src, i).applyMatrix4(m); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
        if (cut) {
          const c = clipSoup(pos, idx, cut.planes, cut.intersection);
          if (!c.idx.length) continue;
          const sections = cut.intersection && (c.idx.length !== idx.length || c.pos.length !== pos.length) ? sectionLoops(pos, idx, cut.planes, MESH_TOL * 10) : [];
          out.push({ ...c, part: partOf(o), color, ...(sections.length ? { sections } : {}) });
        }
        else out.push({ pos, idx, part: partOf(o), color });
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}
