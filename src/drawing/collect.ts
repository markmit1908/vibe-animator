// Gather the visible meshes of a scene as world-space triangle soups (one per mesh/instance).
import * as THREE from 'three';

export interface MeshSoup {
  /** world-space vertex positions (x, y, z …) */
  pos: Float32Array;
  /** triangle vertex indices into pos */
  idx: Uint32Array;
  /** the part this mesh belongs to (userData.id of the nearest registered ancestor) */
  part: string;
}

const shown = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
const partOf = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.id) return String(p.userData.id); return o.uuid; };
const seeThrough = (m: THREE.Material | THREE.Material[]) => (Array.isArray(m) ? m : [m]).every((x) => x.visible === false || (x.transparent && x.opacity < 0.05) || x.side === THREE.BackSide); // BackSide = outline hulls

/** Visible, opaque meshes under `root`, skipping anything under `exclude` (gizmo, helpers). */
export function collectMeshes(root: THREE.Object3D, exclude: THREE.Object3D[] = []): MeshSoup[] {
  const skip = new Set(exclude);
  const out: MeshSoup[] = [];
  root.updateMatrixWorld(true);
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  const walk = (o: THREE.Object3D) => {
    if (skip.has(o) || !o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(o as any).isSprite && mesh.geometry?.attributes.position && !seeThrough(mesh.material) && shown(o)) {
      const g = mesh.geometry, src = g.attributes.position as THREE.BufferAttribute;
      const n = src.count;
      const idx = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({ length: n - (n % 3) }, (_, i) => i);
      const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh) : null;
      const count = inst ? inst.count : 1;
      for (let k = 0; k < count; k++) {
        if (inst) { inst.getMatrixAt(k, m); m.premultiply(o.matrixWorld); } else m.copy(o.matrixWorld);
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { v.fromBufferAttribute(src, i).applyMatrix4(m); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
        out.push({ pos, idx, part: partOf(o) });
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}
