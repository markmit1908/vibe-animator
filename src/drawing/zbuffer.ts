// A software depth buffer (NDC z + the nearest mesh per pixel) used to skip edges that are clearly buried
// behind other parts before the exact ray tests.
export interface ZBuffer { W: number; H: number; z: Float32Array; id: Int32Array }

/**
 * Rasterise triangles already projected to NDC (sx, sy, sz per vertex; NaN = behind the eye → skipped).
 * `triMesh` gives each triangle's mesh index.
 */
export function rasterise(ndc: Float32Array, idx: Uint32Array, triMesh: Int32Array, W: number, H: number): ZBuffer {
  const z = new Float32Array(W * H).fill(Infinity), id = new Int32Array(W * H).fill(-1);
  const px = (x: number) => (x + 1) * 0.5 * W - 0.5, py = (y: number) => (y + 1) * 0.5 * H - 0.5; // pixel centres at integers
  const T = idx.length / 3;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ax = px(ndc[a]), ay = py(ndc[a + 1]), az = ndc[a + 2];
    const bx = px(ndc[b]), by = py(ndc[b + 1]), bz = ndc[b + 2];
    const cx = px(ndc[c]), cy = py(ndc[c + 1]), cz = ndc[c + 2];
    if (az !== az || bz !== bz || cz !== cz) continue;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.floor(Math.max(ay, by, cy)));
    if (x0 > x1 || y0 > y1) continue;
    const m = triMesh[t], inv = 1 / area;
    // depth is affine: z = z0 + dzx·x + dzy·y
    const dzx = ((by - cy) * az + (cy - ay) * bz + (ay - by) * cz) * inv;
    const dzy = ((cx - bx) * az + (ax - cx) * bz + (bx - ax) * cz) * inv;
    const z0 = az - dzx * ax - dzy * ay;
    const ex = [ax, bx, cx], ey = [ay, by, cy];
    for (let y = y0; y <= y1; y++) {
      // this row's span: where the horizontal line crosses the three edges
      let xl = Infinity, xr = -Infinity;
      for (let e = 0; e < 3; e++) {
        const px0 = ex[e], py0 = ey[e], px1 = ex[(e + 1) % 3], py1 = ey[(e + 1) % 3];
        if ((py0 <= y && py1 >= y) || (py1 <= y && py0 >= y)) {
          if (py0 === py1) { xl = Math.min(xl, px0, px1); xr = Math.max(xr, px0, px1); }
          else { const x = px0 + (px1 - px0) * (y - py0) / (py1 - py0); xl = Math.min(xl, x); xr = Math.max(xr, x); }
        }
      }
      const xa = Math.max(x0, Math.ceil(xl)), xb = Math.min(x1, Math.floor(xr));
      let k = y * W + xa, d = z0 + dzx * xa + dzy * y;
      for (let x = xa; x <= xb; x++, k++, d += dzx) if (d < z[k]) { z[k] = d; id[k] = m; }
    }
  }
  return { W, H, z, id };
}
