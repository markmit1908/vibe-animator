// Feature edges of a mesh for one view: silhouettes, open boundaries and creases.
import type { MeshSoup } from './collect';

export type EdgeKind = 'silhouette' | 'boundary' | 'crease';
export interface Edge3 { a: [number, number, number]; b: [number, number, number]; kind: EdgeKind; part: string; /** index of its mesh in the soup list */ mesh: number }

/** Camera for front/back tests: ortho → a fixed view direction; perspective → the eye position. */
export interface ViewRay { ortho: boolean; dir: [number, number, number]; eye: [number, number, number] }

/** Weld coincident vertices (sorted quantised coordinates); returns the welded index per vertex. */
function weld(pos: Float32Array, tol: number): Uint32Array {
  const n = pos.length / 3, q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) q[i] = Math.round(pos[i] / tol);
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => q[a * 3] - q[b * 3] || q[a * 3 + 1] - q[b * 3 + 1] || q[a * 3 + 2] - q[b * 3 + 2]);
  const map = new Uint32Array(n);
  let rep = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (k === 0 || q[i * 3] !== q[rep * 3] || q[i * 3 + 1] !== q[rep * 3 + 1] || q[i * 3 + 2] !== q[rep * 3 + 2]) rep = i;
    map[i] = rep;
  }
  return map;
}

export function featureEdges(m: MeshSoup, view: ViewRay, creaseDeg: number, weldTol: number, mesh = 0): Edge3[] {
  const { pos, idx } = m;
  const w = weld(pos, weldTol);
  const T = idx.length / 3;
  const nrm = new Float64Array(T * 3), facing = new Int8Array(T), ok = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const a = w[idx[t * 3]] * 3, b = w[idx[t * 3 + 1]] * 3, c = w[idx[t * 3 + 2]] * 3;
    if (a === b || b === c || a === c) continue;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-20) continue;
    nx /= l; ny /= l; nz /= l;
    nrm[t * 3] = nx; nrm[t * 3 + 1] = ny; nrm[t * 3 + 2] = nz; ok[t] = 1;
    // facing the camera: the normal points against the ray from the eye to the face
    let d: number;
    if (view.ortho) d = nx * view.dir[0] + ny * view.dir[1] + nz * view.dir[2];
    else d = nx * (pos[a] - view.eye[0]) + ny * (pos[a + 1] - view.eye[1]) + nz * (pos[a + 2] - view.eye[2]);
    facing[t] = d < 0 ? 1 : -1;
  }
  // edge → adjacent faces
  const V = pos.length / 3;
  const adj = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    if (!ok[t]) continue;
    for (let e = 0; e < 3; e++) {
      const p = w[idx[t * 3 + e]], q = w[idx[t * 3 + (e + 1) % 3]];
      const key = p < q ? p * V + q : q * V + p;
      const l = adj.get(key);
      if (l) l.push(t); else adj.set(key, [t]);
    }
  }
  let closed = true;
  for (const l of adj.values()) if (l.length === 1) { closed = false; break; }
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const out: Edge3[] = [];
  for (const [key, f] of adj) {
    let kind: EdgeKind | null = null;
    if (f.length === 1) kind = 'boundary';
    else if (f.length === 2) {
      const [s, t] = f;
      const dot = nrm[s * 3] * nrm[t * 3] + nrm[s * 3 + 1] * nrm[t * 3 + 1] + nrm[s * 3 + 2] * nrm[t * 3 + 2];
      if (facing[s] !== facing[t]) kind = 'silhouette';
      else if (dot < cosCrease && !(closed && facing[s] < 0)) kind = 'crease'; // back creases of a closed solid are always hidden
    } else kind = 'crease'; // non-manifold
    if (!kind) continue;
    const p = Math.floor(key / V) * 3, q = (key % V) * 3;
    out.push({ a: [pos[p], pos[p + 1], pos[p + 2]], b: [pos[q], pos[q + 1], pos[q + 2]], kind, part: m.part, mesh });
  }
  return out;
}
