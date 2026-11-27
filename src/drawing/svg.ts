// Lay hidden-line segments out on a paper sheet and write SVG: polylines chained per layer,
// sizes in mm, line weights per ISO 128 unless overridden.
import type { HlrResult, Seg2 } from './hlr';

export const PAPER: Record<string, [number, number]> = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };

export interface Layer { name: string; weight: number; dash?: number[]; match: (s: Seg2) => boolean }
export const ISO_LAYERS: Layer[] = [
  { name: 'hidden', weight: 0.18, dash: [3, 1.5], match: (s) => s.hidden },
  { name: 'crease', weight: 0.25, match: (s) => !s.hidden && s.kind === 'crease' },
  { name: 'outline', weight: 0.5, match: (s) => !s.hidden && s.kind !== 'crease' },
];

export interface SheetOptions {
  paper?: keyof typeof PAPER | [number, number];
  portrait?: boolean;
  /** drawing scale denominator (1:n) – orthographic views only; omitted → fit to the sheet */
  scale?: number;
  margin?: number;
  layers?: Layer[];
  border?: boolean;
  title?: string;
}

const f = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Join segments that share end points into polylines and drop collinear midpoints (paper mm). */
export function chain(segs: [number, number, number, number][], tol = 0.005): [number, number][][] {
  const key = (x: number, y: number) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
  const pts: [number, number][] = [], at = new Map<string, number>();
  const id = (x: number, y: number) => { const k = key(x, y); let i = at.get(k); if (i === undefined) { i = pts.length; pts.push([x, y]); at.set(k, i); } return i; };
  const adj = new Map<number, number[]>(), seen = new Set<string>();
  const es: [number, number][] = [];
  for (const [x0, y0, x1, y1] of segs) {
    const a = id(x0, y0), b = id(x1, y1);
    if (a === b) continue;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(k)) continue; // coincident edges of touching parts: draw once
    seen.add(k);
    const e = es.length; es.push([a, b]);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(e); (adj.get(b) ?? adj.set(b, []).get(b)!).push(e);
  }
  const used = new Uint8Array(es.length), lines: [number, number][][] = [];
  const walk = (start: number, e: number) => {
    const line = [start];
    let v = start;
    while (e >= 0 && !used[e]) {
      used[e] = 1;
      v = es[e][0] === v ? es[e][1] : es[e][0];
      line.push(v);
      const nx = adj.get(v)!;
      e = nx.length === 2 ? (nx[0] === e ? nx[1] : nx[0]) : -1; // continue only through degree-2 points
    }
    return line;
  };
  // open chains from junctions/ends first, then closed loops
  for (const [v, l] of adj) if (l.length !== 2) for (const e of l) if (!used[e]) lines.push(simplify(walk(v, e).map((i) => pts[i])));
  for (let e = 0; e < es.length; e++) if (!used[e]) lines.push(simplify(walk(es[e][0], e).map((i) => pts[i])));
  return lines;
}

function simplify(l: [number, number][], tol = 0.002): [number, number][] {
  if (l.length < 3) return l;
  const out = [l[0]];
  for (let i = 1; i < l.length - 1; i++) {
    const a = out[out.length - 1], b = l[i], c = l[i + 1];
    const dx = c[0] - a[0], dy = c[1] - a[1], len = Math.hypot(dx, dy);
    const dev = len > 0 ? Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / len : Math.hypot(b[0] - a[0], b[1] - a[1]);
    const between = (b[0] - a[0]) * dx + (b[1] - a[1]) * dy >= 0 && (c[0] - b[0]) * dx + (c[1] - b[1]) * dy >= 0;
    if (dev > tol || !between) out.push(b);
  }
  out.push(l[l.length - 1]);
  return out;
}

export function toSvg(r: HlrResult, opt: SheetOptions = {}): { svg: string; scale: number | null; stats: Record<string, number> } {
  let [W, H] = typeof opt.paper === 'object' ? opt.paper : PAPER[opt.paper ?? 'A3'];
  if (opt.portrait ? W > H : H > W) [W, H] = [H, W];
  const m = opt.margin ?? 10;
  // content bounds (or the camera frame when empty)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of r.segs) for (const p of [s.a, s.b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  if (!(x1 > x0)) [x0, y0, x1, y1] = r.frame;
  let k: number, scale: number | null = null; // mm per drawing unit
  if (opt.scale && r.metric) { scale = opt.scale; k = 1000 / opt.scale; }
  else k = Math.min((W - 2 * m) / Math.max(x1 - x0, 1e-9), (H - 2 * m) / Math.max(y1 - y0, 1e-9));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const X = (x: number) => W / 2 + (x - cx) * k, Y = (y: number) => H / 2 - (y - cy) * k;

  const layers = opt.layers ?? ISO_LAYERS;
  const stats: Record<string, number> = {};
  const groups = layers.map((L) => {
    const lines = chain(r.segs.filter(L.match).map((s) => [X(s.a[0]), Y(s.a[1]), X(s.b[0]), Y(s.b[1])]));
    stats[L.name] = lines.length;
    const d = lines.map((l) => 'M' + l.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')).join('');
    const dash = L.dash ? ` stroke-dasharray="${L.dash.join(' ')}"` : '';
    return `<g id="${L.name}" inkscape:groupmode="layer" inkscape:label="${L.name}" fill="none" stroke="#000" stroke-width="${L.weight}" stroke-linecap="round" stroke-linejoin="round"${dash}>${d ? `<path d="${d}"/>` : ''}</g>`;
  });
  const border = opt.border !== false ? `<g id="border" inkscape:groupmode="layer" inkscape:label="border" fill="none" stroke="#000" stroke-width="0.7"><rect x="${m / 2}" y="${m / 2}" width="${W - m}" height="${H - m}"/></g>` : '';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
<title>${(opt.title ?? 'Drawing').replace(/[<&]/g, '')}</title>
<rect id="paper" width="${W}" height="${H}" fill="#fff"/>
${groups.join('\n')}
${border}
</svg>
`;
  return { svg, scale, stats };
}
