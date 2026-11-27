// Lay hidden-line segments out on a paper sheet and write SVG: polylines chained per layer,
// sizes in mm, line weights per ISO 128 unless overridden.
import type { HlrResult, Seg2 } from './hlr';

export const PAPER: Record<string, [number, number]> = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };

export interface Layer { name: string; weight: number; dash?: number[]; match: (s: Seg2) => boolean }
export const ISO_LAYERS: Layer[] = [
  { name: 'hidden', weight: 0.18, dash: [3, 1.5], match: (s) => s.hidden },
  { name: 'crease', weight: 0.25, match: (s) => !s.hidden && s.kind === 'crease' },
  { name: 'outline', weight: 0.5, match: (s) => !s.hidden && (s.kind === 'silhouette' || s.kind === 'boundary') },
  { name: 'hatch', weight: 0.18, match: (s) => !s.hidden && s.kind === 'hatch' },
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
  /** the title block (bottom right); false = none */
  titleBlock?: TitleBlock | false;
}
export interface TitleBlock { title?: string; sheet?: string; number?: string; rev?: string; drawn?: string; project?: string; date?: string }

const TB_W = 180, TB_H = 32;
/** Paper size (mm) and the area left for the drawing: inside the margin, above the title block. */
export function layout(opt: SheetOptions) {
  let [W, H] = typeof opt.paper === 'object' ? opt.paper : PAPER[opt.paper ?? 'A3'];
  if (opt.portrait ? W > H : H > W) [W, H] = [H, W];
  const m = opt.margin ?? 10;
  const tb = opt.titleBlock !== false;
  const area = { x0: m, y0: m, x1: W - m, y1: H - m - (tb ? TB_H : 0) };
  return { W, H, m, area, tb };
}
/** mm per drawing unit to fit a frame (w × h drawing units) into the sheet's area. */
export function fitScale(opt: SheetOptions, w: number, h: number) {
  const { area } = layout(opt);
  return Math.min((area.x1 - area.x0) / Math.max(w, 1e-9), (area.y1 - area.y0) / Math.max(h, 1e-9));
}
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function titleBlockSvg(W: number, H: number, m: number, tb: TitleBlock, scale: string, paper: string): string {
  const x = W - m / 2 - TB_W, y = H - m / 2 - TB_H;
  const cols = [70, 30, 40, 40];
  const cx = cols.map((_, i) => x + cols.slice(0, i).reduce((a, b) => a + b, 0));
  const cell = (i: number, row: number, label: string, value: string) => {
    const yy = y + 14 + row * 9;
    return `<text x="${f(cx[i] + 1.5)}" y="${f(yy + 2.6)}" font-size="2">${esc(label)}</text><text x="${f(cx[i] + 1.5)}" y="${f(yy + 7.2)}" font-size="3.5">${esc(value)}</text>`;
  };
  const lines = [`M${f(x)} ${f(y + 14)}H${f(x + TB_W)}`, `M${f(x)} ${f(y + 23)}H${f(x + TB_W)}`, ...cx.slice(1).map((c) => `M${f(c)} ${f(y + 14)}V${f(y + TB_H)}`)].join('');
  return `<g id="titleblock" inkscape:groupmode="layer" inkscape:label="titleblock" font-family="Helvetica, Arial, sans-serif" fill="#000">
<rect x="${f(x)}" y="${f(y)}" width="${TB_W}" height="${TB_H}" fill="#fff" stroke="#000" stroke-width="0.5"/>
<path d="${lines}" fill="none" stroke="#000" stroke-width="0.25"/>
<text x="${f(x + 2)}" y="${f(y + 4.2)}" font-size="2">TITLE</text><text x="${f(x + 2)}" y="${f(y + 11)}" font-size="6" font-weight="bold">${esc(tb.title ?? '')}</text>
${cell(0, 0, 'DRAWING NO.', tb.number ?? '')}${cell(1, 0, 'REV', tb.rev ?? '')}${cell(2, 0, 'SCALE', scale)}${cell(3, 0, 'SHEET', tb.sheet ?? '')}
${cell(0, 1, 'PROJECT', tb.project ?? '')}${cell(1, 1, 'DRAWN', tb.drawn ?? '')}${cell(2, 1, 'DATE', tb.date ?? '')}${cell(3, 1, 'SIZE', paper)}
</g>`;
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
  const { W, H, m, area, tb } = layout(opt);
  // content bounds (or the camera frame when empty)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of r.segs) for (const p of [s.a, s.b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  if (!(x1 > x0)) [x0, y0, x1, y1] = r.frame;
  let k: number, scale: number | null = null; // mm per drawing unit
  if (opt.scale && r.metric) { scale = opt.scale; k = 1000 / opt.scale; }
  else k = fitScale(opt, x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ax = (area.x0 + area.x1) / 2, ay = (area.y0 + area.y1) / 2;
  const X = (x: number) => ax + (x - cx) * k, Y = (y: number) => ay - (y - cy) * k;

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
<title>${esc(opt.title ?? 'Drawing')}</title>
<rect id="paper" width="${W}" height="${H}" fill="#fff"/>
${groups.join('\n')}
${border}
${tb ? titleBlockSvg(W, H, m, opt.titleBlock || {}, scale ? `1:${scale}` : 'NTS', typeof opt.paper === 'object' ? `${W}×${H}` : opt.paper ?? 'A3') : ''}
</svg>
`;
  return { svg, scale, stats };
}
