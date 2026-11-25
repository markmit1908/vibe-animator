import * as THREE from 'three';
import type { BuiltScene } from '../scene/build';

export type CutMode = 'none' | 'half' | 'quarter';
/** A side removed: an axis and its sign ("x" removes x > centre, "-z" removes z < centre). */
export type CutSide = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';
/** A section: what's removed (half: one side; quarter: two sides together) about a centre point. */
export interface Cut { mode: CutMode; sides?: CutSide[]; at?: number[] }

export const DEFAULT_SIDES: Record<CutMode, CutSide[]> = { none: [], half: ['x'], quarter: ['x', 'z'] };
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/** "half" or { mode, sides, at } → a full Cut. */
export function toCut(v: unknown): Cut {
  if (!v) return { mode: 'none' };
  if (typeof v === 'string') return { mode: v as CutMode, sides: DEFAULT_SIDES[v as CutMode] ?? [], at: [0, 0, 0] };
  const c = v as Cut;
  return { mode: c.mode, sides: c.sides?.length ? c.sides : DEFAULT_SIDES[c.mode] ?? [], at: c.at ?? [0, 0, 0] };
}

/**
 * Everything with the shared clip planes (shells, CAD) is cut; the region removed is where every side holds
 * (clipIntersection). Core blocks inside the cut region are hidden whole, which reads better than slicing hex blocks.
 */
export function applyCutaway(scene: BuiltScene, cutIn: Cut | CutMode) {
  const cut = toCut(cutIn);
  const sides = cut.mode === 'none' ? [] : (cut.sides ?? []).slice(0, cut.mode === 'half' ? 1 : 2);
  const c = new THREE.Vector3(...(cut.at ?? [0, 0, 0]));
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
    obj.visible = !(insideCore && inCut(p)) && !obj.userData.faded && !obj.userData.userHidden && !obj.userData.removed;
  }
}

/** The script line for a cut: "cutaway half -z at [1,0,2]". */
export function cutLine(cut: Cut) {
  const c = toCut(cut);
  if (c.mode === 'none') return 'cutaway none';
  const sides = c.sides!.join(' ') === DEFAULT_SIDES[c.mode].join(' ') ? '' : ` ${c.sides!.join(' ')}`;
  const at = c.at && c.at.some((v) => Math.abs(v) > 1e-6) ? ` at [${c.at.map((v) => +v.toFixed(3)).join(',')}]` : '';
  return `cutaway ${c.mode}${sides}${at}`;
}
