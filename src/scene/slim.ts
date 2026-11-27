// A slimmed copy of a CAD model: the parts removed in an animation physically left out of the .glb.
// Removed parts become empty placeholder nodes (same names, no mesh, no children): part ids are numbered by
// name among siblings ("bolt", "bolt#2"…), so deleting a node could renumber the rest and break scripts / groups.
// Runs in the browser: three's GLTFLoader maps our part ids to glTF nodes (parser.associations), gltf-transform
// edits and writes the file (hierarchy and names kept), unused meshes / materials / buffers are pruned.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { childIds } from './cad';

export interface SlimResult { glb: Uint8Array; emptied: number; skipped: string[]; before: number; after: number }

/** `bytes`: the model's .glb; `modelId`: its id in the animation; `removed`: removed part ids (any model's). */
export async function slimGlb(bytes: ArrayBuffer, modelId: string, removed: string[]): Promise<SlimResult> {
  const mine = removed.filter((id) => id.startsWith(`${modelId}/`));
  // our ids → glTF node / primitive indices
  const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '');
  const assoc = (gltf.parser as any).associations as Map<THREE.Object3D, { nodes?: number; meshes?: number; primitives?: number }>;
  const byId = new Map<string, THREE.Object3D>();
  const walk = (o: THREE.Object3D, id: string) => { byId.set(id, o); for (const [c, cid] of childIds(o, id)) walk(c, cid); };
  walk(gltf.scene, `${modelId}/model`);
  const nodes = new Set<number>(), prims = new Map<number, Set<number>>(), skipped: string[] = [];
  for (const id of mine) {
    const o = byId.get(id);
    const a = o && assoc.get(o);
    if (!o || !a) { skipped.push(id); continue; }
    if (a.nodes !== undefined) nodes.add(a.nodes);
    else if (a.meshes !== undefined && a.primitives !== undefined) (prims.get(a.meshes) ?? prims.set(a.meshes, new Set()).get(a.meshes)!).add(a.primitives);
    else skipped.push(id);
  }
  const [{ WebIO }, { ALL_EXTENSIONS }, { prune }] = await Promise.all([import('@gltf-transform/core'), import('@gltf-transform/extensions'), import('@gltf-transform/functions')]);
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(bytes));
  const all = doc.getRoot().listNodes();
  const kill = (n: (typeof all)[number]) => { for (const c of n.listChildren()) kill(c); n.dispose(); };
  let emptied = 0;
  for (const i of nodes) {
    const n = all[i];
    if (!n || n.isDisposed()) continue;            // inside another removed part
    n.setMesh(null);
    for (const c of n.listChildren()) kill(c);
    emptied++;
  }
  // primitives of a multi-primitive mesh: only when all of them go (the loader names them by position too)
  const meshes = doc.getRoot().listMeshes();
  for (const [mi, ps] of prims) {
    const mesh = meshes[mi];
    if (!mesh) continue;
    if (ps.size < mesh.listPrimitives().length) { skipped.push(`${modelId}: ${ps.size} of ${mesh.listPrimitives().length} pieces of mesh ${mesh.getName() || mi}`); continue; }
    for (const n of all) if (n.getMesh() === mesh) { n.setMesh(null); emptied++; }
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true, keepIndices: true }));
  const glb = await io.writeBinary(doc);
  return { glb, emptied, skipped, before: bytes.byteLength, after: glb.byteLength };
}
