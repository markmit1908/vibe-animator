// Vector line drawings from the scene geometry (exact hidden-line removal → SVG on a paper sheet).
import * as THREE from 'three';
import { collectMeshes, type MeshSoup } from './collect';
export { parseDraw, withDefaults, DEFAULT_DRAW, type SheetSpec, type DrawScript } from './script';
import { hiddenLines, type HlrOptions } from './hlr';
import { toSvg, type SheetOptions } from './svg';

export { collectMeshes, hiddenLines, toSvg };
export interface DrawingOptions extends HlrOptions, SheetOptions { /** orthographic along the camera's view direction (default true) */ ortho?: boolean; exclude?: THREE.Object3D[]; only?: THREE.Object3D[] }

/** An orthographic camera looking the same way as `cam`, framing every mesh. */
export function orthoFrom(cam: THREE.Camera, soups: MeshSoup[]): THREE.OrthographicCamera {
  cam.updateMatrixWorld();
  const q = new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld);
  const inv = new THREE.Matrix4().makeRotationFromQuaternion(q).invert();
  const b = new THREE.Box3(), v = new THREE.Vector3();
  for (const s of soups) for (let i = 0; i < s.pos.length; i += 3) b.expandByPoint(v.set(s.pos[i], s.pos[i + 1], s.pos[i + 2]).applyMatrix4(inv));
  if (b.isEmpty()) b.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
  const hw = sz.x / 2 * 1.02 + 1e-6, hh = sz.y / 2 * 1.02 + 1e-6, depth = sz.z + 2;
  const o = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.5, depth + 1);
  // eye in front of the box (local +z is towards the viewer)
  o.position.set(c.x, c.y, b.max.z + 1).applyQuaternion(q);
  o.quaternion.copy(q);
  o.updateMatrixWorld(); o.updateProjectionMatrix();
  return o;
}

export function makeDrawing(root: THREE.Object3D, camera: THREE.Camera, opt: DrawingOptions = {}) {
  const t0 = performance.now();
  const soups = collectMeshes(root, { exclude: opt.exclude, only: opt.only });
  const tc = performance.now() - t0;
  const cam = opt.ortho === false ? camera : orthoFrom(camera, soups);
  const r = hiddenLines(soups, cam, opt);
  const t1 = performance.now();
  const out = toSvg(r, opt);
  const stats = { msCollect: tc, ...r.stats, msSvg: performance.now() - t1, ...Object.fromEntries(Object.entries(out.stats).map(([k, v]) => [`lines.${k}`, v])), bytes: out.svg.length };
  return { svg: out.svg, scale: out.scale, stats };
}
