/**
 * Drawing scripts (.draw): sheets of print-quality line drawings, kept in the model's `drawings`, separate
 * from the animation script. Settings before the first `sheet` are defaults for every sheet.
 *
 *   # defaults
 *   paper A1 landscape        A0–A4, landscape | portrait
 *   scale 1:50                or: scale fit
 *   hidden on                 dashed hidden lines (off by default)
 *   crease 30                 crease angle, degrees
 *
 *   sheet core-section "Core – half section"
 *     view front              iso | front | back | top | bottom | side | left | right | <named view> | [dx, dy, dz]
 *     snapshot "refuel-start" pose: a saved snapshot (flags + placements)
 *     at 12.5s                pose: the animation at a time, or at "Chapter label"
 *     cut half x at [0,0,0]   none | half [side] | quarter [side side] [at [x,y,z]]; default: the animation's cut at that time
 *     hide @building, ~bolt   parts left out (ids, globs, @groups, names – as in animation scripts)
 *     only @core              draw just these
 *
 *   Section hatching: `hatch 2.5` (spacing in paper mm) or `hatch off`. Title block: `title`, `number`, `rev`, `drawn`,
 *   `project` (default: the animation's name); `titleblock off` leaves it out. Scale and date are filled in.
 */
import type { Cut, CutMode, CutSide } from '../view/cutaway';

export interface SheetSpec {
  name: string;
  /** 1-based line of the `sheet` line (0 for the defaults) */
  line: number;
  title?: string;
  paper?: string;
  portrait?: boolean;
  /** 1:n; 0 = fit to the sheet */
  scale?: number;
  hidden?: boolean;
  crease?: number;
  /** section hatch spacing, paper mm; 0 = off */
  hatch?: number;
  number?: string;
  rev?: string;
  drawn?: string;
  project?: string;
  titleblock?: boolean;
  view?: string | [number, number, number];
  snapshot?: string;
  at?: number | string;
  cut?: Cut;
  hide: string[];
  only: string[];
}
export interface DrawError { line: number; message: string }
export interface DrawScript { defaults: SheetSpec; sheets: SheetSpec[]; errors: DrawError[] }

export const DRAW_KEYWORDS = ['sheet', 'paper', 'scale', 'hidden', 'crease', 'hatch', 'title', 'number', 'rev', 'drawn', 'project', 'titleblock', 'view', 'snapshot', 'at', 'cut', 'hide', 'only'];
export const PAPERS = ['A0', 'A1', 'A2', 'A3', 'A4'];
const SIDES = ['x', '-x', 'y', '-y', 'z', '-z'];

/** Settings a sheet takes from the defaults when it doesn't set them. */
export function withDefaults(s: SheetSpec, d: SheetSpec): SheetSpec {
  const out = { ...s };
  for (const k of ['paper', 'portrait', 'scale', 'hidden', 'crease', 'hatch', 'number', 'rev', 'drawn', 'project', 'titleblock', 'view', 'snapshot', 'at', 'cut'] as const) if (out[k] === undefined) (out as any)[k] = d[k];
  out.hide = [...d.hide, ...s.hide];
  out.only = s.only.length ? s.only : d.only;
  return out;
}

const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');
const targets = (s: string) => s.split(',').map(unq).filter(Boolean);
const vec = (s: string): [number, number, number] | null => {
  const m = s.trim().match(/^\[\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\]$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export function parseDraw(text: string): DrawScript {
  const errors: DrawError[] = [];
  const defaults: SheetSpec = { name: '', line: 0, hide: [], only: [] };
  const sheets: SheetSpec[] = [];
  let cur = defaults;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const src = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!src) return;
    const err = (message: string) => errors.push({ line, message });
    const m = src.match(/^(\S+)\s*(.*)$/)!;
    const kw = m[1], rest = m[2].trim();
    switch (kw) {
      case 'sheet': {
        const mm = rest.match(/^([\w.-]+)\s*(?:"(.*)")?\s*$/);
        if (!mm) { err('sheet needs a name (letters, digits, - _ .), then an optional "Title"'); return; }
        if (sheets.some((s) => s.name === mm[1])) err(`sheet "${mm[1]}" is defined twice`);
        cur = { name: mm[1], line, title: mm[2], hide: [], only: [] };
        sheets.push(cur);
        return;
      }
      case 'title': cur.title = unq(rest); return;
      case 'number': case 'rev': case 'drawn': case 'project':
        if (!rest) { err(`${kw}: a value (quoted if it has spaces)`); return; }
        cur[kw] = unq(rest); return;
      case 'titleblock':
        if (rest !== 'on' && rest !== 'off') { err('titleblock: on or off'); return; }
        cur.titleblock = rest === 'on'; return;
      case 'hatch': {
        if (rest === 'off') { cur.hatch = 0; return; }
        const n = Number(rest.replace(/mm$/, ''));
        if (!(n > 0)) { err('hatch: spacing in mm (e.g. 2.5) or off'); return; }
        cur.hatch = n; return;
      }
      case 'paper': {
        const [p, o] = rest.split(/\s+/);
        if (!PAPERS.includes(p?.toUpperCase())) { err(`paper: one of ${PAPERS.join(', ')}`); return; }
        cur.paper = p.toUpperCase();
        if (o && o !== 'portrait' && o !== 'landscape') err('paper: landscape or portrait');
        if (o) cur.portrait = o === 'portrait';
        return;
      }
      case 'scale': {
        if (rest === 'fit') { cur.scale = 0; return; }
        const mm = rest.match(/^1\s*:\s*(\d+(?:\.\d+)?)$/);
        if (!mm || !(Number(mm[1]) > 0)) { err('scale: 1:n (e.g. 1:50) or fit'); return; }
        cur.scale = Number(mm[1]);
        return;
      }
      case 'hidden':
        if (rest !== 'on' && rest !== 'off') { err('hidden: on or off'); return; }
        cur.hidden = rest === 'on'; return;
      case 'crease': {
        const n = Number(rest);
        if (!(n > 0 && n < 180)) { err('crease: an angle in degrees (e.g. 30)'); return; }
        cur.crease = n; return;
      }
      case 'view': {
        if (!rest) { err('view: iso, front, back, top, bottom, side, left, right, a named view or [dx, dy, dz]'); return; }
        if (rest.startsWith('[')) { const v = vec(rest); if (!v) { err('view: a direction like [1, 0.8, 1]'); return; } cur.view = v; return; }
        cur.view = unq(rest); return;
      }
      case 'snapshot': if (!rest) { err('snapshot: a snapshot name'); return; } cur.snapshot = unq(rest); return;
      case 'at': {
        const mm = rest.match(/^(\d+(?:\.\d+)?)\s*s?$/);
        if (mm) { cur.at = Number(mm[1]); return; }
        if (/^".*"$/.test(rest)) { cur.at = unq(rest); return; }
        err('at: a time (12.5s) or a chapter "Label"'); return;
      }
      case 'cut': {
        const mm = rest.match(/^(none|half|quarter)((?:\s+-?[xyz])*)\s*(?:at\s+(.+))?$/);
        if (!mm) { err('cut: none | half [side] | quarter [side side] [at [x, y, z]]'); return; }
        const mode = mm[1] as CutMode;
        const sides = mm[2].trim().split(/\s+/).filter(Boolean) as CutSide[];
        if (sides.some((s) => !SIDES.includes(s))) { err('cut: sides are x, -x, y, -y, z, -z'); return; }
        if (mode === 'half' && sides.length > 1) { err('cut half takes one side'); return; }
        if (mode === 'quarter' && sides.length && sides.length !== 2) { err('cut quarter takes two sides'); return; }
        let at: number[] | undefined;
        if (mm[3]) { const v = vec(mm[3]); if (!v) { err('cut … at [x, y, z]'); return; } at = v; }
        cur.cut = { mode, ...(sides.length ? { sides } : {}), ...(at ? { at } : {}) };
        return;
      }
      case 'hide': case 'only': {
        const t = targets(rest);
        if (!t.length) { err(`${kw}: parts (ids, @groups, names), comma separated`); return; }
        cur[kw].push(...t); return;
      }
      default: err(`unknown command "${kw}" (${DRAW_KEYWORDS.join(', ')})`);
    }
  });
  return { defaults, sheets, errors };
}

export const DEFAULT_DRAW = `# Drawing sheets: each "sheet" is one SVG. Lines before the first sheet are defaults.
paper A3 landscape
scale fit
hidden off

sheet overview "Overview"
  view iso

sheet front "Front elevation"
  view front
`;
