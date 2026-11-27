// Part fills: a colour-index buffer at paper resolution, traced into even-odd polygons per colour.
// The exact lines are drawn over them, so the traced edges (a fraction of a line width) stay under the strokes.
import { rasterise } from './zbuffer';

export interface Fill { color: string; loops: [number, number][][] }

/**
 * Trace regions of equal value in `id` (W × H, -1 = empty) into loops in pixel-corner coordinates
 * (x right, y up from the bottom row). Loops are chained arbitrarily at 4-way corners – fine for even-odd fills.
 */
export function traceRegions(id: Int32Array, W: number, H: number, simplifyPx = 0.75): Map<number, [number, number][][]> {
  // boundary runs per value: horizontal (between rows y-1 and y) and vertical (between columns x-1 and x)
  const segs = new Map<number, number[]>(); // value → [x0, y0, x1, y1, …]
  const add = (v: number, x0: number, y0: number, x1: number, y1: number) => { if (v < 0) return; (segs.get(v) ?? segs.set(v, []).get(v)!).push(x0, y0, x1, y1); };
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : id[y * W + x]);
  for (let y = 0; y <= H; y++) {
    let runA = -2, runB = -2, start = 0;
    for (let x = 0; x <= W; x++) {
      const a = x < W ? at(x, y - 1) : -3, b = x < W ? at(x, y) : -3;
      const same = a === runA && b === runB;
      if (!same) {
        if (runA !== runB && runA > -2) { add(runA, start, y, x, y); add(runB, start, y, x, y); }
        runA = a; runB = b; start = x;
      }
    }
  }
  for (let x = 0; x <= W; x++) {
    let runA = -2, runB = -2, start = 0;
    for (let y = 0; y <= H; y++) {
      const a = y < H ? at(x - 1, y) : -3, b = y < H ? at(x, y) : -3;
      if (!(a === runA && b === runB)) {
        if (runA !== runB && runA > -2) { add(runA, x, start, x, y); add(runB, x, start, x, y); }
        runA = a; runB = b; start = y;
      }
    }
  }
  const out = new Map<number, [number, number][][]>();
  for (const [v, s] of segs) {
    // runs end where any boundary changes, so the region's own runs meet end to end: chain them
    const key = (x: number, y: number) => y * (W + 1) + x;
    const adj = new Map<number, number[]>();
    const n = s.length / 4;
    for (let e = 0; e < n; e++) for (const k of [key(s[e * 4], s[e * 4 + 1]), key(s[e * 4 + 2], s[e * 4 + 3])]) (adj.get(k) ?? adj.set(k, []).get(k)!).push(e);
    const used = new Uint8Array(n), loops: [number, number][][] = [];
    for (let e0 = 0; e0 < n; e0++) {
      if (used[e0]) continue;
      const loop: [number, number][] = [[s[e0 * 4], s[e0 * 4 + 1]]];
      let e = e0, cx = s[e0 * 4 + 2], cy = s[e0 * 4 + 3];
      used[e] = 1;
      for (;;) {
        loop.push([cx, cy]);
        const nx = adj.get(key(cx, cy))!.find((f) => !used[f]);
        if (nx === undefined) break;
        used[nx] = 1; e = nx;
        const fx = s[e * 4], fy = s[e * 4 + 1];
        if (fx === cx && fy === cy) { cx = s[e * 4 + 2]; cy = s[e * 4 + 3]; } else { cx = fx; cy = fy; }
      }
      if (loop.length >= 4) loops.push(dp(loop, simplifyPx));
    }
    out.set(v, loops);
  }
  return out;
}

/** Douglas–Peucker on an open polyline (loops keep their first = last point). */
function dp(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = L > 0 ? Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L : Math.hypot(pts[k][0] - ax, pts[k][1] - ay);
      if (d > best) { best = d; bi = k; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Fills from projected triangles (NDC, as for the depth pass): a colour index per triangle, palette of hex colours. */
export function makeFills(ndc: Float32Array, idx: Uint32Array, triColor: Int32Array, palette: string[], W: number, H: number, sx: number, sy: number): Fill[] {
  const zb = rasterise(ndc, idx, triColor, W, H);
  const regions = traceRegions(zb.id, W, H);
  // pixel corners → drawing units (NDC × half frame)
  const X = (x: number) => (x / W * 2 - 1) * sx, Y = (y: number) => (y / H * 2 - 1) * sy;
  return [...regions].map(([c, loops]) => ({ color: palette[c], loops: loops.map((l) => l.map(([x, y]) => [X(x), Y(y)] as [number, number])) }));
}
