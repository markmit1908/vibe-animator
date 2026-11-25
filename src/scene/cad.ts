import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BuiltScene } from './build';

export interface CadModel {
  id: string;
  file: string;
  position?: number[];
  rotation_deg?: number[];
  scale?: number;
  visible?: boolean;
  /** Clip with the cutaway planes (default true). */
  clip?: boolean;
}

const ramp = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

/** Script-safe id segment: names may contain slashes or be empty. */
const seg = (name: string) => (name || 'node').replace(/\//g, '_').trim();

/**
 * Load CAD models (glTF/.glb from public/), restyle them to the cel-shaded look and
 * register every node in the scene registry as "<model id>/<child>/<grandchild>…".
 * Duplicate sibling names get "#2", "#3"…
 */
export async function loadCad(models: CadModel[], scene: BuiltScene) {
  const loader = new GLTFLoader();
  const matCache = new Map<THREE.Material, THREE.Material>();
  for (const m of models) {
    const t0 = performance.now();
    const gltf = await loader.loadAsync(`/${m.file}`);
    const root = gltf.scene;
    root.name = m.id;
    if (m.position) root.position.fromArray(m.position);
    if (m.rotation_deg) root.rotation.set(...(m.rotation_deg.map(THREE.MathUtils.degToRad) as [number, number, number]));
    if (m.scale) root.scale.setScalar(m.scale);
    root.visible = m.visible ?? true;
    root.userData.cad = true;

    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      let mat = matCache.get(src);
      if (!mat) {
        mat = new THREE.MeshToonMaterial({
          color: src.color ?? new THREE.Color(0xdddddd), gradientMap: ramp, side: THREE.DoubleSide,
          ...(m.clip !== false ? { clippingPlanes: scene.clipPlanes, clipIntersection: true } : {}),
        });
        matCache.set(src, mat);
      }
      mesh.material = mat;
    });

    const register = (o: THREE.Object3D, id: string) => {
      o.userData.id = id;
      scene.registry.set(id, o);
      const used = new Map<string, number>();
      for (const c of o.children) {
        const base = seg(c.name);
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        register(c, `${id}/${base}${n > 1 ? `#${n}` : ''}`);
      }
    };
    register(root, m.id);
    scene.root.add(root);
    let meshes = 0, instances = 0;
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { meshes++; instances += (o as THREE.InstancedMesh).count ?? 1; } });
    console.info(`CAD ${m.id}: ${meshes} meshes, ${instances} instances, ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
