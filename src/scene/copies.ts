// Linked copies: parts / assemblies / @groups duplicated into the scene with their own pose, saved in the model's
// `copies`. A copy clones its sources' subtrees when the scene is built (geometry and materials shared), so it
// follows the CAD: re-importing or changing it changes every copy.
//
// Frame: the sources' bounding-box centre (world) is the copy's origin. A copy at `position` = that centre, rotation 0,
// sits exactly on its sources. Part ids: `copies/<id>` (the copy), `copies/<id>/<source id>` for every part in it.
import * as THREE from 'three';

export interface CopyDef {
  /** the copy's name; part id copies/<id> */
  id: string;
  /** what it copies: part ids, @groups (as in scripts) */
  of: string[];
  /** world position of the copy's centre (its sources' box centre), m */
  position: number[];
  /** degrees about X, Y, Z (about the centre) */
  rotation: number[];
}

export const COPIES_ROOT = 'copies';
export const copyPartId = (id: string) => `${COPIES_ROOT}/${id}`;
export const copyChildId = (copy: string, srcId: string) => `${COPIES_ROOT}/${copy}/${srcId}`;

/** The source objects' world box (visible geometry). */
export function sourcesBox(objs: THREE.Object3D[]): THREE.Box3 {
  const b = new THREE.Box3();
  for (const o of objs) { o.updateMatrixWorld(true); b.expandByObject(o); }
  return b;
}

export interface CopySource {
  objs: THREE.Object3D[];
  /** leave these out (removed parts) */
  skip: (o: THREE.Object3D) => boolean;
}

/**
 * Build a copy: a group at the copy's pose holding a clone of each source (meshes share geometry and their base
 * material). `register(o, id)` is called for every object that has an id in the source.
 */
export function buildCopy(def: CopyDef, src: CopySource, register: (o: THREE.Object3D, id: string) => void): { root: THREE.Group; centre: THREE.Vector3 } {
  const root = new THREE.Group();
  root.name = def.id;
  root.userData.copy = def.id;
  root.position.fromArray(def.position);
  root.quaternion.setFromEuler(new THREE.Euler(...(def.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ'));
  register(root, copyPartId(def.id));
  const box = sourcesBox(src.objs);
  const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const toCentre = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
  for (const o of src.objs) {
    if (src.skip(o)) continue;
    const c = cloneTree(o, def.id, src.skip, register);
    if (!c) continue;
    // local = (sources' centre)⁻¹ × source world
    new THREE.Matrix4().multiplyMatrices(toCentre, o.matrixWorld).decompose(c.position, c.quaternion, c.scale);
    root.add(c);
  }
  return { root, centre };
}

function cloneTree(o: THREE.Object3D, copy: string, skip: (o: THREE.Object3D) => boolean, register: (o: THREE.Object3D, id: string) => void): THREE.Object3D | null {
  if (skip(o)) return null;
  // lines, sprites, outline hulls and helpers aren't parts
  if ((o as THREE.Line).isLine || (o as THREE.Sprite).isSprite || (o as THREE.Light).isLight) return null;
  let c: THREE.Object3D;
  const m = o as THREE.Mesh;
  if (m.isMesh) {
    if (Array.isArray(m.material) || (m.material as THREE.Material).side === THREE.BackSide) return null;
    // the part's own material, not a colour / highlight clone of it
    const mat = (o.userData.baseMat0 ?? o.userData.origMat ?? m.material) as THREE.Material;
    c = (m as THREE.InstancedMesh).isInstancedMesh
      ? (() => { const s = m as THREE.InstancedMesh, x = new THREE.InstancedMesh(s.geometry, mat, s.count); x.instanceMatrix.copy(s.instanceMatrix); return x; })()
      : new THREE.Mesh(m.geometry, mat);
    c.castShadow = m.castShadow; c.receiveShadow = m.receiveShadow;
    c.userData.geomKey = m.userData.geomKey;
  } else c = new THREE.Group();
  c.name = o.name;
  c.position.copy(o.position); c.quaternion.copy(o.quaternion); c.scale.copy(o.scale);
  c.renderOrder = o.renderOrder;
  const sid = o.userData.id as string | undefined;
  if (sid) { c.userData.copyOf = sid; register(c, copyChildId(copy, sid)); }
  if (o.userData.label) c.userData.label = o.userData.label;
  for (const k of o.children) { const kc = cloneTree(k, copy, skip, register); if (kc) c.add(kc); }
  return c;
}

/** A free copy name from a base ("pump" → "pump-2"…). */
export function freeCopyName(base: string, taken: string[]): string {
  const b = base.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z_]+/, '') || 'copy';
  for (let i = 1; ; i++) { const n = `${b}-${i}`; if (!taken.includes(n)) return n; }
}
