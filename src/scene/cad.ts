import * as THREE from 'three';
import { withCaps } from '../view/caps';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BuiltScene } from './build';

export interface CadModel {
  id: string;
  file: string;
  /** Model up axis as converted by step2gltf (which assumes Z-up): z (default), x, -x, y, -y. */
  up?: 'z' | 'x' | '-x' | 'y' | '-y';
  /** Place the model's base at `position` (centred in x/z) instead of using its own origin. */
  ground?: boolean;
  position?: number[];
  rotation_deg?: number[];
  scale?: number;
  /** Clip with the cutaway planes (default true). */
  /** Ignored (the cutaway always cuts CAD); kept so older files load. */
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

/** Child ids follow names; duplicate sibling names get "#2", "#3"… */
function childIds(o: THREE.Object3D, id: string): [THREE.Object3D, string][] {
  const used = new Map<string, number>();
  return o.children.map((c) => {
    const base = seg(c.name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return [c, `${id}/${base}${n > 1 ? `#${n}` : ''}`];
  });
}

const UP: Record<string, THREE.Euler> = {
  z: new THREE.Euler(0, 0, 0),
  x: new THREE.Euler(0, 0, Math.PI / 2),
  '-x': new THREE.Euler(0, 0, -Math.PI / 2),
  y: new THREE.Euler(Math.PI / 2, 0, 0),
  '-y': new THREE.Euler(-Math.PI / 2, 0, 0),
};

/**
 * Loads CAD models and manages geometry suppression.
 * Every node is registered as "<model id>/<child>/…" in the scene registry.
 */
export class CadManager {
  private loader = new GLTFLoader();
  private matCache = new Map<THREE.Material, THREE.Material>();
  private models = new Map<string, CadModel>();
  /** geometry uuid -> live geometry and the meshes currently using it */
  private geoms = new Map<string, { geo: THREE.BufferGeometry; users: Set<THREE.Mesh> }>();
  private static EMPTY = new THREE.BufferGeometry();

  /** urlFor: where a model's file is fetched from (old app: /<file>; SolverKit: /api/files/<vault path>). */
  constructor(private scene: BuiltScene, private urlFor: (file: string) => string = (f) => `/${f}`) {}

  async load(models: CadModel[]) {
    for (const m of models) {
      const t0 = performance.now();
      const gltf = await this.loader.loadAsync(this.urlFor(m.file));
      this.models.set(m.id, m);

      // wrapper = model root (scriptable as the model id); inner = glTF scene, oriented
      const wrapper = new THREE.Group();
      wrapper.name = m.id;
      wrapper.userData.cad = true;
      const inner = gltf.scene;
      inner.name = 'model';
      inner.rotation.copy(UP[m.up ?? 'z']);
      if (m.rotation_deg) {
        const extra = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(m.rotation_deg.map(THREE.MathUtils.degToRad) as [number, number, number])));
        inner.quaternion.premultiply(extra);
      }
      if (m.scale) inner.scale.setScalar(m.scale);
      wrapper.add(inner);
      if (m.ground) {
        inner.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(inner);
        const c = box.getCenter(new THREE.Vector3());
        inner.position.set(-c.x, -box.min.y, -c.z);
      }
      if (m.position) wrapper.position.fromArray(m.position);

      this.restyle(inner, m);
      this.register(wrapper, m.id);
      this.scene.root.add(wrapper);
      wrapper.updateMatrixWorld(true);

      let meshes = 0, instances = 0;
      inner.traverse((o) => { if ((o as THREE.Mesh).isMesh) { meshes++; instances += (o as THREE.InstancedMesh).count ?? 1; } });
      console.info(`CAD ${m.id}: ${meshes} meshes, ${instances} instances, ${(performance.now() - t0).toFixed(0)} ms`);
    }
  }

  private restyle(root: THREE.Object3D, _m: CadModel) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      let mat = this.matCache.get(src);
      if (!mat) {
        mat = withCaps(new THREE.MeshToonMaterial({
          color: src.color ?? new THREE.Color(0xdddddd), gradientMap: ramp, side: THREE.DoubleSide,
          clippingPlanes: this.scene.clipPlanes, clipIntersection: true, // the cutaway cuts CAD too
        }));
        mat.userData.cullable = true;   // closed solids: back faces are culled unless a cut shows them (caps)
        this.matCache.set(src, mat);
      }
      mesh.material = mat;
      this.track(mesh);
    });
  }

  private track(mesh: THREE.Mesh) {
    const g = mesh.geometry;
    mesh.userData.geomKey ??= g.uuid;
    const e = this.geoms.get(mesh.userData.geomKey) ?? { geo: g, users: new Set<THREE.Mesh>() };
    e.users.add(mesh);
    this.geoms.set(mesh.userData.geomKey, e);
  }

  private register(o: THREE.Object3D, id: string) {
    o.userData.id = id;
    this.scene.registry.set(id, o);
    for (const [c, cid] of childIds(o, id)) this.register(c, cid);
  }

  /** Free these meshes' geometry (shared geometry is freed when its last user goes). */
  suppress(meshes: THREE.Mesh[]) {
    for (const mesh of meshes) {
      if (mesh.userData.suppressed) continue;
      const e = this.geoms.get(mesh.userData.geomKey);
      mesh.geometry = CadManager.EMPTY;
      mesh.userData.suppressed = true;
      if (e) {
        e.users.delete(mesh);
        if (!e.users.size) { e.geo.dispose(); this.geoms.delete(mesh.userData.geomKey); }
      }
    }
  }

  /** Restore suppressed meshes; reloads the model file if their geometry was freed. */
  async restore(meshes: THREE.Mesh[]) {
    const todo = meshes.filter((m) => m.userData.suppressed);
    if (!todo.length) return;
    const missing = todo.filter((m) => !this.geoms.has(m.userData.geomKey));
    for (const modelId of new Set(missing.map((m) => (m.userData.id as string).split('/')[0]))) {
      const m = this.models.get(modelId)!;
      const fresh = (await this.loader.loadAsync(this.urlFor(m.file))).scene;
      // walk the fresh copy with the same id scheme (root "model" sits under the wrapper id)
      const byId = new Map<string, THREE.Object3D>();
      const walk = (x: THREE.Object3D, id: string) => { byId.set(id, x); for (const [c, cid] of childIds(x, id)) walk(c, cid); };
      walk(fresh, `${modelId}/model`);
      for (const mesh of missing.filter((x) => (x.userData.id as string).startsWith(`${modelId}/`))) {
        if (this.geoms.has(mesh.userData.geomKey)) continue;
        const src = byId.get(mesh.userData.id) as THREE.Mesh | undefined;
        if (src?.isMesh) this.geoms.set(mesh.userData.geomKey, { geo: src.geometry, users: new Set() });
      }
      // let the rest of the fresh parse be garbage-collected
      fresh.traverse((x) => { const g = (x as THREE.Mesh).geometry; if (g && ![...this.geoms.values()].some((e) => e.geo === g)) g.dispose(); });
    }
    for (const mesh of todo) {
      const e = this.geoms.get(mesh.userData.geomKey);
      if (!e) continue;
      mesh.geometry = e.geo;
      e.users.add(mesh);
      mesh.userData.suppressed = false;
    }
  }

  /** Live geometry stats for the UI. */
  stats() {
    let tris = 0;
    for (const { geo, users } of this.geoms.values()) {
      const n = (geo.index?.count ?? geo.attributes.position?.count ?? 0) / 3;
      tris += n * users.size;
    }
    return { geometries: this.geoms.size, triangles: tris };
  }
}
