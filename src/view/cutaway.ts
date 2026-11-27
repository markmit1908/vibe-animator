import * as THREE from 'three';
import type { BuiltScene } from '../scene/build';
import { capUniforms } from './caps';

export type CutMode = 'none' | 'half' | 'quarter';
/** A side removed: an axis and its sign ("x" removes x > centre, "-z" removes z < centre). */
export type CutSide = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';
/** A section: what's removed (half: one side; quarter: two sides together) about a centre point. */
export interface Cut {
  mode: CutMode; sides?: CutSide[]; at?: number[];
  /** leave this cut open (no section caps) */ nocap?: boolean;
  /** part ids this cut leaves whole (script `keep …`; the animation's saved list is added to it) */ keep?: string[];
}

export const DEFAULT_SIDES: Record<CutMode, CutSide[]> = { none: [], half: ['x'], quarter: ['x', 'z'] };
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/** "half" or { mode, sides, at } → a full Cut. */
export function toCut(v: unknown): Cut {
  if (!v) return { mode: 'none' };
  if (typeof v === 'string') return { mode: v as CutMode, sides: DEFAULT_SIDES[v as CutMode] ?? [], at: [0, 0, 0] };
  const c = v as Cut;
  return { mode: c.mode, sides: c.sides?.length ? c.sides : DEFAULT_SIDES[c.mode] ?? [], at: c.at ?? [0, 0, 0], nocap: c.nocap, keep: c.keep };
}

/**
 * Everything with the shared clip planes (shells, CAD) is cut; the region removed is where every side holds
 * (clipIntersection). Core blocks inside the cut region are hidden whole, which reads better than slicing hex blocks –
 * unless they are kept uncut (`kept`).
 */
export function applyCutaway(scene: BuiltScene, cutIn: Cut | CutMode, kept: (o: THREE.Object3D) => boolean = () => false) {
  const cut = toCut(cutIn);
  const sides = cut.mode === 'none' ? [] : (cut.sides ?? []).slice(0, cut.mode === 'half' ? 1 : 2);
  const c = new THREE.Vector3(...(cut.at ?? [0, 0, 0]));
  capUniforms.cutActive.value = sides.length;
  scene.clipPlanes.forEach((pl, i) => {
    const sd = sides[i];
    if (!sd) {
      // unused plane: with no sides it clips nothing; otherwise it must clip everything (the region is the intersection)
      pl.normal.set(1, 0, 0); pl.constant = sides.length ? -1e9 : 1e9;
      return;
    }
    const s = sd.startsWith('-') ? -1 : 1, a = AX[sd.slice(-1) as 'x' | 'y' | 'z'];
    pl.normal.copy(a).multiplyScalar(-s);        // clipped where normal·p + constant < 0, i.e. s·(p - c) > 0
    pl.constant = s * a.dot(c);
  });

  const eps = 0.05;
  const inCut = (p: THREE.Vector3) => sides.length > 0 && sides.every((sd) => {
    const s = sd.startsWith('-') ? -1 : 1, k = sd.slice(-1) as 'x' | 'y' | 'z';
    return s * (p[k] - c[k]) > eps;
  });
  for (const id of scene.blockIds) {
    const obj = scene.registry.get(id)!;
    const p = obj.position;
    const insideCore = Math.hypot(p.x, p.z) < scene.coreRadius + 0.1 && p.y < scene.floorY;
    obj.visible = !(insideCore && inCut(p) && !kept(obj)) && !obj.userData.faded && !obj.userData.userHidden && !obj.userData.removed;
  }
}

/**
 * Parts left whole by the cut ("keep uncut"). Each drawable under a kept root draws without the clip planes:
 *  - shaded: its material is swapped for an unclipped twin (cached per material), or – a material of its own (a colour
 *    or tween clone: `ownMat`) – has its planes taken off in place; put back when it is no longer kept
 *  - cap sums and the line views' normal pass: `userData.uncut`, read per draw in caps.ts (`noClip`): not clipped, and
 *    no contribution to the caps
 * `update` runs every frame; it rescans only when the kept roots change.
 */
export class Uncut {
  private key = '';
  private roots = new Set<THREE.Object3D>();
  private kept = new Set<THREE.Object3D>();
  private touched = new Set<THREE.Object3D>();
  private twin = new Map<THREE.Material, THREE.Material>();
  private srcOf = new WeakMap<THREE.Material, THREE.Material>();
  constructor(private live: THREE.Plane[]) {}

  /** Is this object (or an ancestor) kept uncut? */
  has(o: THREE.Object3D) { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (this.roots.has(p)) return true; return false; }
  get size() { return this.roots.size; }

  update(roots: THREE.Object3D[]) {
    const key = roots.map((o) => o.id).sort((a, b) => a - b).join(',');
    if (key !== this.key) {
      this.key = key;
      this.roots = new Set(roots);
      for (const o of this.kept) delete o.userData.uncut;
      this.kept.clear();
      for (const r of roots) r.traverse((o) => {
        if (!(o as THREE.Mesh).material) return;
        o.userData.uncut = true; this.kept.add(o); this.touched.add(o);
      });
    }
    if (!this.touched.size) return;
    for (const o of this.touched) {
      const m = o as THREE.Mesh, mat = m.material as THREE.Material;
      if (!mat || Array.isArray(mat)) { this.touched.delete(o); continue; }
      if (this.kept.has(o)) {
        if (!mat.clippingPlanes?.length) continue;
        o.userData.wasClipped = true;
        if (m.userData.ownMat && !m.userData.origMat) mat.clippingPlanes = [];   // its own material: in place
        else m.material = this.twinOf(mat);
        continue;
      }
      // no longer kept: back to the live planes
      const src = this.srcOf.get(mat);
      if (src) m.material = src;
      else if (o.userData.wasClipped && mat.clippingPlanes && !mat.clippingPlanes.length) mat.clippingPlanes = this.live;
      delete o.userData.wasClipped;
      this.touched.delete(o);
    }
  }

  private twinOf(src: THREE.Material) {
    let t = this.twin.get(src);
    if (!t) {
      t = src.clone();
      t.clippingPlanes = [];
      this.twin.set(src, t); this.srcOf.set(t, src);
    }
    return t;
  }
}

/** The script line for a cut: "cutaway half -z at [1,0,2]". */
export function cutLine(cut: Cut) {
  const c = toCut(cut);
  if (c.mode === 'none') return 'cutaway none';
  const sides = c.sides!.join(' ') === DEFAULT_SIDES[c.mode].join(' ') ? '' : ` ${c.sides!.join(' ')}`;
  const at = c.at && c.at.some((v) => Math.abs(v) > 1e-6) ? ` at [${c.at.map((v) => +v.toFixed(3)).join(',')}]` : '';
  return `cutaway ${c.mode}${sides}${at}${c.nocap ? ' nocap' : ''}`;
}
