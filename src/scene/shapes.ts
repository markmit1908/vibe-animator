/**
 * Basic modelling: simple solids made in the studio (box, cylinder, tube, sphere, cone, plane, hex prism), saved in the
 * animation (`model.shapes`), with optional linear / circular arrays. Each shape is a registered part `shapes/<name>`;
 * array copies are parts too (`shapes/<name>/<name>-<i>`), so scripts reach them by short name or glob (`pin-*`).
 * Solids are closed with outward faces, so they cut, cap and outline like CAD.
 */
import * as THREE from 'three';
import { toonMaterial } from './build';

export type ShapeKind = 'box' | 'cylinder' | 'tube' | 'sphere' | 'cone' | 'plane' | 'hex';
export type ShapeArray =
  | { type: 'linear'; count: number; step: number[] }
  | { type: 'circular'; count: number; centre: number[]; angle: number };

export interface ShapeDef {
  /** the shape's name; its part id is shapes/<id> */
  id: string;
  kind: ShapeKind;
  /** sizes in metres, per kind – see SIZES */
  size: number[];
  position: number[];
  /** degrees about X, Y, Z */
  rotation: number[];
  color: string;
  array?: ShapeArray;
}

/** The size fields of each kind (labels for the editor; values in `size`, same order). */
export const SIZES: Record<ShapeKind, { label: string; def: number }[]> = {
  box: [{ label: 'width (x)', def: 1 }, { label: 'height (y)', def: 1 }, { label: 'depth (z)', def: 1 }],
  cylinder: [{ label: 'radius', def: 0.5 }, { label: 'height', def: 1 }],
  tube: [{ label: 'outer radius', def: 0.5 }, { label: 'inner radius', def: 0.4 }, { label: 'height', def: 1 }],
  sphere: [{ label: 'radius', def: 0.5 }],
  cone: [{ label: 'radius', def: 0.5 }, { label: 'height', def: 1 }],
  plane: [{ label: 'width (x)', def: 2 }, { label: 'depth (z)', def: 2 }],
  hex: [{ label: 'across flats', def: 1 }, { label: 'height', def: 1 }],
};
export const KINDS = Object.keys(SIZES) as ShapeKind[];

export const SHAPES_ROOT = 'shapes';
export const shapePartId = (id: string) => `${SHAPES_ROOT}/${id}`;

const pos = (v: number, min = 0.001) => (Number.isFinite(v) && v > min ? v : min);

/** A vertical prism (the profile in XZ, extruded along Y, centred) – closed, outward faces. */
function prism(shape: THREE.Shape, h: number, segments = 64) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: segments });
  g.rotateX(-Math.PI / 2);          // extrusion along +Y
  g.translate(0, -h / 2, 0);
  return g;
}

export function shapeGeometry(kind: ShapeKind, s: number[]): THREE.BufferGeometry {
  const d = (i: number) => s[i] ?? SIZES[kind][i]?.def ?? 1;
  switch (kind) {
    case 'box': return new THREE.BoxGeometry(pos(d(0)), pos(d(1)), pos(d(2)));
    case 'cylinder': return new THREE.CylinderGeometry(pos(d(0)), pos(d(0)), pos(d(1)), 64);
    case 'cone': return new THREE.ConeGeometry(pos(d(0)), pos(d(1)), 64);
    case 'sphere': return new THREE.SphereGeometry(pos(d(0)), 48, 24);
    case 'plane': { const g = new THREE.PlaneGeometry(pos(d(0)), pos(d(1))); g.rotateX(-Math.PI / 2); return g; }
    case 'tube': {
      const ro = pos(d(0)), ri = Math.min(pos(d(1)), ro * 0.999);
      const sh = new THREE.Shape().absarc(0, 0, ro, 0, Math.PI * 2, false);
      sh.holes.push(new THREE.Path().absarc(0, 0, ri, 0, Math.PI * 2, true));
      return prism(sh, pos(d(2)));
    }
    case 'hex': {
      const r = pos(d(0)) / Math.sqrt(3);   // circumradius from across-flats
      const sh = new THREE.Shape();
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; if (i) sh.lineTo(r * Math.cos(a), r * Math.sin(a)); else sh.moveTo(r * Math.cos(a), r * Math.sin(a)); }
      sh.closePath();
      return prism(sh, pos(d(1)), 1);
    }
  }
}

const deg = (v: number[]) => new THREE.Euler(...(v.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ');

/** The placements of a shape and its array copies (position + orientation of each). */
export function copies(def: ShapeDef): { p: THREE.Vector3; q: THREE.Quaternion }[] {
  const p0 = new THREE.Vector3(...def.position), q0 = new THREE.Quaternion().setFromEuler(deg(def.rotation));
  const a = def.array;
  if (!a || a.count < 2) return [{ p: p0, q: q0 }];
  const n = Math.min(Math.max(Math.round(a.count), 1), 500);
  if (a.type === 'linear') {
    const st = new THREE.Vector3(...a.step);
    return Array.from({ length: n }, (_, i) => ({ p: p0.clone().addScaledVector(st, i), q: q0.clone() }));
  }
  // circular: about a vertical axis through centre (x, z); a full turn spaces n copies evenly, a part turn includes both ends
  const c = new THREE.Vector3(a.centre[0] ?? 0, 0, a.centre[1] ?? 0);
  const full = Math.abs(Math.abs(a.angle) - 360) < 1e-6;
  const stepA = THREE.MathUtils.degToRad(a.angle) / (full ? n : Math.max(n - 1, 1));
  return Array.from({ length: n }, (_, i) => {
    const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), stepA * i);
    const p = p0.clone().sub(c).applyQuaternion(r).add(c); p.y = p0.y;
    return { p, q: r.multiply(q0.clone()) };
  });
}

/**
 * Build one shape: a part `shapes/<id>` positioned at the shape (the first copy). With an array it is a group at the
 * origin holding the copies, each its own part. `register(o, id)` puts parts in the scene's registry.
 */
export function buildShape(def: ShapeDef, clipPlanes: THREE.Plane[], register: (o: THREE.Object3D, id: string) => void) {
  const geo = shapeGeometry(def.kind, def.size);
  const solid = def.kind !== 'plane';
  const mat = () => {
    const m = toonMaterial({ color: def.color, side: THREE.DoubleSide, clippingPlanes: clipPlanes, clipIntersection: true });
    if (!solid) delete m.userData.capped;       // an open surface: no section cap
    return m;
  };
  const cs = copies(def);
  const id = shapePartId(def.id);
  let root: THREE.Object3D;
  if (cs.length === 1) {
    root = new THREE.Mesh(geo, mat());
    root.position.copy(cs[0].p); root.quaternion.copy(cs[0].q);
  } else {
    root = new THREE.Group();
    cs.forEach((c, i) => {
      const m = new THREE.Mesh(geo, mat());
      m.position.copy(c.p); m.quaternion.copy(c.q);
      m.name = `${def.id}-${i}`;
      m.userData.shapeCopy = i;
      root.add(m);
      register(m, `${id}/${def.id}-${i}`);
    });
    root.userData.array = true;
  }
  root.name = def.id;
  root.userData.shape = def.id;
  register(root, id);
  return root;
}

/** A free name: "box-1", "box-2"… */
export function freeName(base: string, taken: Iterable<string>) {
  const t = new Set(taken);
  for (let i = 1; ; i++) if (!t.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Shape names: a word (letters, digits, - _), not starting with a digit. */
export const validName = (n: string) => /^[A-Za-z_][\w-]*$/.test(n);
