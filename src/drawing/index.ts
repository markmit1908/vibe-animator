// Vector line drawings from the scene geometry (exact hidden-line removal → SVG on a paper sheet).
import * as THREE from 'three';
import { collectMeshes, type MeshSoup } from './collect';
export { parseDraw, withDefaults, DEFAULT_DRAW, type SheetSpec, type DrawScript } from './script';
import { hiddenLines, type HlrOptions } from './hlr';
import { fitScale, toSvg, type SheetOptions } from './svg';
import { capTriangles, hatchEdges } from './sections';
import type { Edge3 } from './edges';

export { collectMeshes, hiddenLines, toSvg };
export interface DrawingOptions extends HlrOptions, SheetOptions { /** orthographic along the camera's view direction (default true) */ ortho?: boolean; exclude?: THREE.Object3D[]; only?: THREE.Object3D[];
  /** section hatch spacing on the paper, mm (0 = no hatching; default 2.5) */ hatch?: number;
  /** part fills under the lines: the part colours, or tinted halfway to white */ fill?: 'off' | 'tint' | 'colour';
  /** fill tracing resolution on the paper, mm per pixel (default 0.25) */ fillMm?: number }

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
  // section faces: caps hide what's inside a cut part; hatching at 45° / 135° (alternating by part), spacing in paper mm
  const extra: Edge3[] = [];
  let k = 0; // mm per metre
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
    const o = cam as THREE.OrthographicCamera;
    k = opt.scale ? 1000 / opt.scale : fitScale(opt, (o.right - o.left) / o.zoom, (o.top - o.bottom) / o.zoom);
  }
  const hatchMm = opt.hatch ?? 2.5;
  const parts = new Map<string, number>();
  const n0 = soups.length;
  for (let i = 0; i < n0; i++) {
    const s = soups[i];
    if (!s.sections) continue;
    if (!parts.has(s.part)) parts.set(s.part, parts.size);
    for (const sec of s.sections) {
      const cap = capTriangles(sec);
      if (!cap.idx.length) continue;
      soups.push({ ...cap, part: s.part, color: s.color, occluder: true });
      if (hatchMm > 0 && k > 0) extra.push(...hatchEdges(sec, cam, hatchMm / k, parts.get(s.part)! % 2 ? 135 : 45, s.part, soups.length - 1));
    }
  }
  let fill: { palette: string[]; meshColor: Int32Array; res: number } | undefined;
  if (opt.fill && opt.fill !== 'off' && k > 0) {
    const o = cam as THREE.OrthographicCamera;
    const palette: string[] = [], at = new Map<string, number>();
    const tint = (hex: string) => opt.fill !== 'tint' ? hex.toLowerCase() : '#' + [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) + 255) / 2).toString(16).padStart(2, '0')).join(''); // halfway to white, in sRGB
    const meshColor = Int32Array.from(soups, (s) => {
      if (!s.color) return -1;
      const c = tint(s.color);
      if (!at.has(c)) { at.set(c, palette.length); palette.push(c); }
      return at.get(c)!;
    });
    fill = { palette, meshColor, res: Math.max(o.right - o.left, o.top - o.bottom) / o.zoom * k / (opt.fillMm ?? 0.25) };
  }
  const r = hiddenLines(soups, cam, { ...opt, extra, fillBuffer: fill });
  const t1 = performance.now();
  const out = toSvg(r, opt);
  const stats = { msCollect: tc, ...r.stats, msSvg: performance.now() - t1, ...Object.fromEntries(Object.entries(out.stats).map(([k, v]) => [`lines.${k}`, v])), bytes: out.svg.length };
  return { svg: out.svg, scale: out.scale, stats };
}
