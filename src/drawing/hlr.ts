// Exact hidden-line removal on triangle meshes.
//
// Each feature edge is projected, split wherever it crosses a projected contour (silhouette or open
// boundary – for non-intersecting surfaces those are the only places visibility can change), and each
// piece is tested with one ray from its midpoint towards the camera against a BVH of every triangle.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { MeshSoup } from './collect';
import { featureEdges, type Edge3, type EdgeKind } from './edges';
import { rasterise, type ZBuffer } from './zbuffer';

export interface Seg2 { a: [number, number]; b: [number, number]; kind: EdgeKind; hidden: boolean; part: string }
export interface HlrOptions {
  creaseDeg?: number;
  /** keep hidden pieces (for a dashed layer) */ hidden?: boolean;
  /** depth-buffer pre-pass size (long side, pixels; 0 = off): skips edges buried behind other parts (orthographic only) */
  cullRes?: number;
}
export interface HlrResult {
  segs: Seg2[];
  /** 2D units: metres (orthographic camera) or view-height units (perspective) */
  metric: boolean;
  /** frame of the camera in those units: [xmin, ymin, xmax, ymax] */
  frame: [number, number, number, number];
  stats: Record<string, number>;
}

export function hiddenLines(soups: MeshSoup[], camera: THREE.Camera, opt: HlrOptions = {}): HlrResult {
  const t0 = performance.now();
  const stats: Record<string, number> = { meshes: soups.length };
  camera.updateMatrixWorld();
  const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  const near = (camera as THREE.PerspectiveCamera).near ?? 0;

  // scene size → tolerances
  const box = new THREE.Box3();
  let tris = 0;
  for (const s of soups) { for (let i = 0; i < s.pos.length; i += 3) box.expandByPoint(new THREE.Vector3(s.pos[i], s.pos[i + 1], s.pos[i + 2])); tris += s.idx.length / 3; }
  const diag = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
  const weldTol = diag * 1e-7 + 1e-7, rayEps = diag * 2e-6;
  stats.triangles = tris;

  // 1. feature edges
  const view = { ortho, dir: fwd.toArray() as [number, number, number], eye: eye.toArray() as [number, number, number] };
  const edges: Edge3[] = [];
  soups.forEach((s, i) => { for (const e of featureEdges(s, view, opt.creaseDeg ?? 30, weldTol, i)) edges.push(e); });
  const t1 = performance.now(); stats.edges = edges.length; stats.msEdges = t1 - t0;

  // 2. BVH over all triangles
  let total = 0; for (const s of soups) total += s.pos.length;
  const P = new Float32Array(total), I = new Uint32Array(tris * 3);
  const triMesh = new Int32Array(tris);
  { let po = 0, io = 0; soups.forEach((s, i) => { P.set(s.pos, po); triMesh.fill(i, io / 3, io / 3 + s.idx.length / 3); for (let k = 0; k < s.idx.length; k++) I[io++] = s.idx[k] + po / 3; po += s.pos.length; }); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3)); geo.setIndex(new THREE.BufferAttribute(I, 1));
  const bvh = tris ? new MeshBVH(geo, { maxLeafTris: 8 }) : null;
  const t2 = performance.now(); stats.msBvh = t2 - t1;

  // 3. project + clip each edge in clip space (linear in the 3D parameter)
  const VP = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const clip = (p: number[]) => [0, 1, 2, 3].map((r) => VP[r] * p[0] + VP[4 + r] * p[1] + VP[8 + r] * p[2] + VP[12 + r]);
  interface PE { e: Edge3; s0: number; s1: number; x0: number; y0: number; x1: number; y1: number; z0: number; z1: number; w0: number; w1: number }

  // 2b. depth pre-pass (orthographic): NDC z and the nearest mesh per pixel
  let zb: ZBuffer | null = null, marginZ = 0;
  const cullRes = opt.cullRes ?? 4096;
  if (ortho && cullRes > 0 && tris) {
    const o = camera as THREE.OrthographicCamera;
    const fw = (o.right - o.left) / o.zoom, fh = (o.top - o.bottom) / o.zoom;
    const W = fw >= fh ? cullRes : Math.max(16, Math.round(cullRes * fw / fh)), H = fh > fw ? cullRes : Math.max(16, Math.round(cullRes * fh / fw));
    const ndc = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      ndc[i] = VP[0] * x + VP[4] * y + VP[8] * z + VP[12]; ndc[i + 1] = VP[1] * x + VP[5] * y + VP[9] * z + VP[13]; ndc[i + 2] = VP[2] * x + VP[6] * y + VP[10] * z + VP[14];
    }
    zb = rasterise(ndc, I, triMesh, W, H);
    // a surface counts as in front only if it is nearer by several pixels' worth of depth (slopes, touching parts)
    marginZ = (6 * Math.max(fw / W, fh / H) + rayEps * 4) * 2 / (o.far - o.near);
  }
  const t2b = performance.now(); stats.msDepth = t2b - t2;
  /** Every pixel around every sample along the edge is covered, nearer by the margin, by another mesh. */
  const buried = (p: PE) => {
    if (!zb) return false;
    const { W, H, z, id } = zb;
    const X = (x: number) => (x + 1) * 0.5 * W - 0.5, Y = (y: number) => (y + 1) * 0.5 * H - 0.5;
    const ax = X(p.x0), ay = Y(p.y0), bx = X(p.x1), by = Y(p.y1);
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let i = 0; i <= n; i++) {
      const u = i / n, cx = Math.round(ax + (bx - ax) * u), cy = Math.round(ay + (by - ay) * u);
      const ze = p.z0 + (p.z1 - p.z0) * u - marginZ;
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        const k = y * W + x;
        if (id[k] < 0 || id[k] === p.e.mesh || !(z[k] < ze)) return false;
      }
    }
    return true;
  };
  const pes: PE[] = [];
  for (const e of edges) {
    const c0 = clip(e.a), c1 = clip(e.b);
    let s0 = 0, s1 = 1;
    // planes: w±x ≥ 0, w±y ≥ 0, w+z ≥ 0 (near), w−z ≥ 0 (far)
    const planes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let out = false;
    for (const [px, py, pz] of planes) {
      const d0 = c0[3] + px * c0[0] + py * c0[1] + pz * c0[2], d1 = c1[3] + px * c1[0] + py * c1[1] + pz * c1[2];
      if (d0 < 0 && d1 < 0) { out = true; break; }
      if (d0 < 0) s0 = Math.max(s0, d0 / (d0 - d1)); else if (d1 < 0) s1 = Math.min(s1, d0 / (d0 - d1));
    }
    if (out || s1 - s0 < 1e-9) continue;
    const at = (s: number) => c0.map((v, i) => v + (c1[i] - v) * s);
    const a = at(s0), b = at(s1);
    pes.push({ e, s0, s1, x0: a[0] / a[3], y0: a[1] / a[3], x1: b[0] / b[3], y1: b[1] / b[3], z0: a[2] / a[3], z1: b[2] / b[3], w0: a[3], w1: b[3] });
  }
  stats.projected = pes.length;

  // 4. grid of contours in NDC
  const contours = pes.filter((p) => p.e.kind !== 'crease');
  const G = Math.max(1, Math.min(2048, Math.round(Math.sqrt(contours.length) * 2)));
  const cell = (v: number) => Math.max(0, Math.min(G - 1, Math.floor(((v + 1) / 2) * G)));
  const grid: number[][] = Array.from({ length: G * G }, () => []);
  contours.forEach((c, k) => {
    for (let i = cell(Math.min(c.x0, c.x1)); i <= cell(Math.max(c.x0, c.x1)); i++)
      for (let j = cell(Math.min(c.y0, c.y1)); j <= cell(Math.max(c.y0, c.y1)); j++) grid[j * G + i].push(k);
  });
  const stamp = new Int32Array(contours.length).fill(-1);

  // 5. split + ray test
  const ray = new THREE.Ray(), pt = new THREE.Vector3();
  let rays = 0, splits = 0, culled = 0, behind = 0;
  const minNdc = 2e-5; // pieces shorter than this (1e-5 of the frame) aren't split off
  const segs: Seg2[] = [];
  const keepHidden = !!opt.hidden;
  pes.forEach((p, n) => {
    const dx = p.x1 - p.x0, dy = p.y1 - p.y0;
    if (buried(p)) {
      culled++;
      if (keepHidden) segs.push({ a: [p.x0, p.y0], b: [p.x1, p.y1], kind: p.e.kind, hidden: true, part: p.e.part });
      return;
    }
    const minU = minNdc / Math.max(Math.hypot(dx, dy), 1e-12);
    const us: number[] = [0, 1];
    for (let i = cell(Math.min(p.x0, p.x1)); i <= cell(Math.max(p.x0, p.x1)); i++)
      for (let j = cell(Math.min(p.y0, p.y1)); j <= cell(Math.max(p.y0, p.y1)); j++)
        for (const k of grid[j * G + i]) {
          if (stamp[k] === n) continue; stamp[k] = n;
          const c = contours[k]; if (c === p) continue;
          const ex = c.x1 - c.x0, ey = c.y1 - c.y0;
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-18) continue;
          const qx = c.x0 - p.x0, qy = c.y0 - p.y0;
          const u = (qx * ey - qy * ex) / den, v = (qx * dy - qy * dx) / den;
          if (!(u > minU && u < 1 - minU && v >= -1e-9 && v <= 1 + 1e-9)) continue;
          // a contour behind the edge can't hide any of it (NDC z is affine along both lines)
          const ze = p.z0 + (p.z1 - p.z0) * u, zc = c.z0 + (c.z1 - c.z0) * v;
          if (zc > ze - 1e-9) { behind++; continue; }
          us.push(u);
        }
    us.sort((a, b) => a - b);
    splits += us.length - 2;
    // u (screen) → s (3D, within the clipped piece): perspective-correct
    const sOf = (u: number) => (u * p.w0) / (p.w1 * (1 - u) + u * p.w0);
    let runStart = 0, runHidden: boolean | null = null;
    const emit = (u0: number, u1: number, hidden: boolean) => {
      if (hidden && !keepHidden) return;
      segs.push({ a: [p.x0 + dx * u0, p.y0 + dy * u0], b: [p.x0 + dx * u1, p.y0 + dy * u1], kind: p.e.kind, hidden, part: p.e.part });
    };
    for (let k = 0; k + 1 < us.length; k++) {
      const u0 = us[k], u1 = us[k + 1];
      if (u1 - u0 < minU && k + 2 < us.length) { us[k + 1] = u0; continue; } // merge a tiny piece into the next
      const s = p.s0 + (p.s1 - p.s0) * sOf((u0 + u1) / 2);
      const { a, b } = p.e;
      pt.set(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
      let far: number;
      if (ortho) { ray.direction.copy(fwd).negate(); far = eye.clone().sub(pt).dot(ray.direction) - near; }
      else { ray.direction.copy(eye).sub(pt); far = ray.direction.length() - near; ray.direction.normalize(); }
      ray.origin.copy(pt);
      rays++;
      const hit = bvh && far > rayEps ? bvh.raycastFirst(ray, THREE.DoubleSide, rayEps, far) : null;
      const hidden = !!hit;
      if (runHidden === null) runHidden = hidden;
      else if (hidden !== runHidden) { emit(runStart, u0, runHidden); runStart = u0; runHidden = hidden; }
    }
    if (runHidden !== null) emit(runStart, 1, runHidden);
  });
  const t3 = performance.now();
  stats.splits = splits; stats.rays = rays; stats.culled = culled; stats.behind = behind; stats.msHlr = t3 - t2b; stats.segments = segs.length;

  // 6. NDC → drawing units
  let sx: number, sy: number, metric = ortho;
  if (ortho) { const o = camera as THREE.OrthographicCamera; sx = (o.right - o.left) / 2 / o.zoom; sy = (o.top - o.bottom) / 2 / o.zoom; }
  else { const pc = camera as THREE.PerspectiveCamera; sy = 1; sx = pc.aspect ?? 1; metric = false; }
  for (const s of segs) { s.a = [s.a[0] * sx, s.a[1] * sy]; s.b = [s.b[0] * sx, s.b[1] * sy]; }
  geo.dispose();
  stats.msTotal = performance.now() - t0;
  return { segs, metric, frame: [-sx, -sy, sx, sy], stats };
}
