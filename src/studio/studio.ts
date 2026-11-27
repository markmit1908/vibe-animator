import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_PALETTE_KEY, palette } from '../view/palette';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import GUI from 'lil-gui';
import { buildScene } from '../scene/build';
import { compile } from '../timeline/compile';
import { Player } from '../timeline/player';
import { fitVerticalCylinder, planeHeight } from '../scene/origin';
import { buildCopy, COPIES_ROOT, copyPartId, freeCopyName, sourcesBox, type CopyDef } from '../scene/copies';
import { buildShape, freeName, KINDS, SHAPES_ROOT, shapePartId, SIZES, validName, type ShapeDef, type ShapeKind } from '../scene/shapes';
import { capUniforms, SectionCaps, withCaps } from '../view/caps';
import { OutlineGlow } from '../view/glow';
import { applyCutaway, cutLine, DEFAULT_SIDES, toCut, Uncut, type Cut, type CutMode, type CutSide } from '../view/cutaway';
import { CadManager } from '../scene/cad';
import { setStore, setStoreWriter, store, useSnapshot, captureSnapshot, writeStore, markDirty, isDirty, onDirtyChange,
  isLocked, isHidden, isCad, state, type Snapshot } from '../scene/state';
import { TreePanel } from '../view/tree';
import { Triad } from '../view/triad';
import { host, setHost } from '../view/host';
import type { AnimModel } from '../model/file';
import { joinLines } from '../model/file';
import { DrawingMode } from '../view/drawing';
import { ScriptPanel } from '../view/scriptPanel';
import type { AssistHost, AssistMount } from '../assist/host';
import { assistClient, migrateChat, runAssist, type ChatMessage } from '../assist/loop';
import type Anthropic from '@anthropic-ai/sdk';
import { ASSIST_SYSTEM } from '../assist/system';
import { readTools, proposeTools, modelProposeTools, type ToolDeps, type ShapeChange, type PlacementInput, type PlacementPlan } from '../assist/tools';
import type { Proposal } from '../assist/loop';
import { parseAnim, toActions, type ParseError } from '../script/anim';
import { ScriptError } from '../timeline/compile';
import { applyEdit, cameraLine, type Edit, type Probe } from '../script/edit';
import { makeDrawing, withDefaults, DEFAULT_DRAW, type DrawingOptions, type SheetSpec } from '../drawing';
import { PAPER, layout, fitScale, titleBox } from '../drawing/svg';
import { DrawPanel } from '../view/drawPanel';
import { svgToPdf } from '../drawing/pdf';
import { ProgressSplash } from '../view/progress';
import { partsInRect } from '../view/boxSelect';

/** What the studio needs from its host app (SolverKit's editor). */
export interface StudioIO {
  /** Persist fields of the model (SolverKit: ctx.edit – autosaved, versioned). */
  edit(patch: Partial<AnimModel>): void;
  /** URL of a vault file (CAD .glb). */
  fileUrl(path: string): string;
  /** The assist key proxy. */
  assist: { base: string; status: string };
  /** Send the card image shown on Home (an <svg>). */
  putThumb?(svg: string): Promise<unknown> | void;
  /** Mount the assist panel (SolverKit's AssistPanel) into `el`. */
  mountAssist?(el: HTMLElement, host: AssistHost): AssistMount;
  /** Vault files: list a folder, upload a file (CAD models). */
  files?: {
    list(folder: string): Promise<{ path: string; size: number }[]>;
    upload(path: string, file: File, onProgress?: (fraction: number) => void, overwrite?: boolean): Promise<'ok' | 'exists'>;
  };
  /** Mount the studio again from the model as written (after changes the studio can't apply in place: CAD models). */
  reload?(): void;
}

/**
 * The animation studio (3D view, assembly tree, script editor, assist), mounted into `root` for one model.
 * Returns dispose(). The old single-page app (src/main.ts) is the same code over the dev server's endpoints.
 */
export async function mountStudio(root: HTMLElement, model: AnimModel, io: StudioIO): Promise<{ dispose(): void }> {
const ac = new AbortController();
let disposed = false;
/** Writes to the model; a disposed studio (replaced by a remount) must never write its older state. */
const edit = (patch: Partial<AnimModel>) => {
  if (disposed) return;
  recordUndo(patch);
  io.edit(patch);
  if (THUMB_KEYS.some((k) => k in patch)) scheduleThumb();
};
/** Edits that change what the card image shows. */
const THUMB_KEYS = ['script', 'colors', 'snapshots', 'groups', 'folders', 'labels', 'removed', 'views', 'scene', 'keyframe', 'shapes', 'cutKeep', 'copies'];
let thumbTimer: number | undefined;
/** Re-render the card image once things have been quiet for a moment. */
function scheduleThumb(delay = 2000) {
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => { if (!disposed) void renderThumb(); }, delay);
}

// ---------- undo / redo (⌘/Ctrl+Z, ⇧⌘Z / Ctrl+Y) of the animation's state ----------
// Every change goes through edit(): before the first change of a burst (400 ms), the state as it was is pushed.
// Script typing has the editor's own undo; script changes made by code (gizmo write-back, an accepted proposal) undo here.
type UndoKey = 'colors' | 'snapshots' | 'groups' | 'folders' | 'cutKeep' | 'labels' | 'removed' | 'script' | 'drawings' | 'views' | 'keyframe' | 'shapes' | 'copies';
const UNDO_KEYS: UndoKey[] = ['colors', 'snapshots', 'groups', 'folders', 'cutKeep', 'labels', 'removed', 'script', 'drawings', 'views', 'keyframe', 'shapes', 'copies'];
type DocState = Partial<Record<UndoKey, any>>;
const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const docNow: DocState = {
  colors: model.colors ?? {}, snapshots: model.snapshots ?? { active: 'default', items: {} }, groups: model.groups ?? {}, folders: model.folders ?? {},
  labels: model.labels ?? {}, removed: model.removed ?? [], cutKeep: model.cutKeep ?? [], views: model.views ?? {}, keyframe: model.keyframe, shapes: model.shapes ?? [], copies: model.copies ?? [], script: model.script ? { language: 'anim', text: joinLines(model.script.text) } : undefined,
  drawings: model.drawings ? { language: 'draw', text: joinLines(model.drawings.text) } : undefined,
};
const undoStack: DocState[] = [], redoStack: DocState[] = [];
let undoing = false, typing = false, burst = false, burstTimer: number | undefined;
function recordUndo(patch: Partial<AnimModel>) {
  const keys = UNDO_KEYS.filter((k) => k in patch);
  if (!keys.length) return;
  const changed = keys.filter((k) => JSON.stringify((patch as any)[k]) !== JSON.stringify(docNow[k]));
  if (!changed.length) return;
  if (typing && changed.every((k) => k === 'script' || k === 'drawings')) {
    // typed: the editor's undo owns it; older entries must not bring back the text from before the typing
    for (const e of [...undoStack, ...redoStack]) for (const k of changed) delete e[k];
  } else if (!undoing) {
    if (!burst) { undoStack.push(clone(docNow)); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; burst = true; }
    clearTimeout(burstTimer); burstTimer = window.setTimeout(() => (burst = false), 400);
  }
  for (const k of changed) docNow[k] = clone((patch as any)[k]);
}
const on = (t: string, f: any) => window.addEventListener(t, f, { signal: ac.signal });
root.replaceChildren();
if (getComputedStyle(root).position === 'static') root.style.position = 'relative'; // keep a host's own positioning
root.style.overflow = 'hidden';
setHost(root);
const mk = (id: string, css: string) => { const d = document.createElement('div'); d.id = id; d.style.cssText = css; root.appendChild(d); return d; };
mk('app', 'position:absolute;inset:0;background:#050607');
mk('chapter', 'position:absolute;top:20px;left:24px;font:600 22px system-ui;color:#f2f4f7;pointer-events:none;z-index:4');
mk('sub', 'position:absolute;top:52px;left:24px;font:14px system-ui;color:#9aa6b2;pointer-events:none;z-index:4');
mk('clock', 'position:absolute;bottom:16px;left:24px;font:13px ui-monospace,monospace;color:#9aa6b2;z-index:4');
const W = () => root.clientWidth || 800, H = () => root.clientHeight || 600;

const cfg: any = { ...model.scene };
// the generated reactor's defaults (palette etc.) when the model has none
cfg.palette ??= { background: '#050607', fuel: '#d98a3a', reflector: '#c8d0d9', spent: '#b8322a', fresh: '#3aa58a', vessel: '#e6ebf0', head: '#d5dde6', bolts: '#a5551f', barrel: '#bfc8d2', floor: '#1b2530', machine: '#a5551f', edge: '#000000' };
const scriptName = (model.name ?? 'animation') + '.anim';
const isAnim = true;
const animText: string = joinLines(model.script?.text);
let script: any = toActions(parseAnim(animText).steps);
let scriptErrors: ParseError[] = parseAnim(animText).errors;
// ---------- renderer / scene ----------
// alpha: PNG export with a transparent background; logarithmic depth: precision across the whole plant (less z-fighting
// where parts touch). The hidden-line pass decodes it (drawing.ts lin()).
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true, stencil: true }); // stencil: section caps
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W(), H());
renderer.localClippingEnabled = true;
renderer.info.autoReset = false; // reset once per frame so stats cover the main scene + triad
root.querySelector('#app')!.appendChild(renderer.domElement);

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(cfg.palette.background);
const camera = new THREE.PerspectiveCamera(40, W() / H(), 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const built = buildScene(withGeneratedDefaults(cfg));
scene3.add(built.root);

const chapterEl = root.querySelector<HTMLElement>('#chapter')!;
const subEl = root.querySelector<HTMLElement>('#sub')!;
const clockEl = root.querySelector<HTMLElement>('#clock')!;

// ---------- CAD models (glTF in public/) – loaded before compiling so scripts can target them ----------
setStore({ active: model.snapshots?.active ?? 'default', snapshots: model.snapshots?.items ?? {}, groups: model.groups ?? {}, folders: model.folders ?? {} });
setStoreWriter((st) => edit({ snapshots: { active: st.active, items: st.snapshots }, groups: st.groups, folders: st.folders }));
const cad = new CadManager(built, io.fileUrl);
try {
  if (cfg.cad_models?.length) {
    chapterEl.textContent = 'Loading CAD…';
    await cad.load(cfg.cad_models);
  }
} catch (e: any) {
  console.error(e);
  subEl.textContent = `CAD load failed: ${e.message}`;
}

// ---------- part state: hide / lock / suppress ----------

/** Apply hide/lock flags to a subtree: visibility, matrix auto-update, CAD suppression. */
async function reconcile(root: THREE.Object3D) {
  const supp: THREE.Mesh[] = [], rest: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D): boolean => {         // returns: whole subtree locked
    const id = (o.userData.id ?? o.name) as string;
    if (id && built.registry.get(id) === o) {
      o.userData.userHidden = state.hidden[id] === true;
      o.visible = !o.userData.userHidden && !o.userData.faded && !o.userData.removed;
    }
    const locked = isLocked(o);
    o.userData.suppressedRoot = isCad(o) && state.hidden[id] === true && locked;
    if ((o as THREE.Mesh).isMesh && isCad(o)) ((isHidden(o) && locked) || isRemoved(o) ? supp : rest).push(o as THREE.Mesh);
    let all = locked;
    for (const c of o.children) all = walk(c) && all;
    // locked objects never move: skip their matrix work every frame
    o.matrixAutoUpdate = !locked;
    if (locked) o.updateMatrix();
    o.matrixWorldAutoUpdate = !all;
    return all;
  };
  root.updateMatrixWorld(true);
  walk(root);
  cad.suppress(supp);
  await cad.restore(rest);
}
// ---------- removed parts / display names (per animation; the CAD file is untouched) ----------
const removed = new Set<string>(model.removed ?? []);
let labels: Record<string, string> = { ...(model.labels ?? {}) };
/** Named camera views (script: camera <name> 2s). */
let views: Record<string, { pos: number[]; look: number[] }> = clone(model.views ?? {});
const isRemoved = (o: THREE.Object3D): boolean => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.removed) return true; return false; };
for (const id of removed) { const o = built.registry.get(id); if (o) o.userData.removed = true; }
for (const [id, l] of Object.entries(labels)) { const o = built.registry.get(id); if (o) o.userData.label = l; }

// ---------- shapes (basic modelling): parts made in the studio, saved in the model ----------
let regVersion = 0;                                  // bumped when parts are rebuilt (shapes): kept-uncut lists re-resolve
let shapes: ShapeDef[] = clone(model.shapes ?? []);
const shapesRoot = new THREE.Group();
shapesRoot.name = 'shapes'; shapesRoot.userData.shapesRoot = true; shapesRoot.userData.id = SHAPES_ROOT;
built.root.add(shapesRoot); built.registry.set(SHAPES_ROOT, shapesRoot);
/** (Re)build every shape's parts from `shapes`; their home pose is the shape's own. */
function buildShapes() {
  regVersion++;
  for (const id of [...built.registry.keys()]) if (id.startsWith(SHAPES_ROOT + '/')) built.registry.delete(id);
  for (const c of [...shapesRoot.children]) {
    shapesRoot.remove(c);
    c.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  }
  for (const d of shapes) shapesRoot.add(buildShape(d, built.clipPlanes, (o, id) => { o.userData.id = id; built.registry.set(id, o); }));
  shapesRoot.traverse((o) => { o.userData.homeP = o.position.toArray(); o.userData.homeQ = o.quaternion.toArray(); });
  for (const id of removed) { const o = built.registry.get(id); if (o) o.userData.removed = true; }
  for (const [id, l] of Object.entries(labels)) { const o = built.registry.get(id); if (o) o.userData.label = l; }
}
buildShapes();

// ---------- copies: linked duplicates of parts / assemblies / groups (model `copies`) ----------
let copies: CopyDef[] = clone(model.copies ?? []);
const copiesRoot = new THREE.Group();
copiesRoot.name = 'copies'; copiesRoot.userData.copiesRoot = true; copiesRoot.userData.id = COPIES_ROOT;
built.root.add(copiesRoot); built.registry.set(COPIES_ROOT, copiesRoot);
/** per copy: why it's empty or incomplete */
const copyErrors = new Map<string, string>();
/** The objects a copy clones: its targets, minus removed ones and ones under another target. */
function copySources(d: CopyDef) {
  const r = resolveIds(d.of);
  const objs = r.ids.map((x) => built.registry.get(x)).filter((o): o is THREE.Object3D => !!o && !isRemoved(o) && o !== built.root && o !== copiesRoot);
  const covered = (o: THREE.Object3D) => { for (let p = o.parent; p; p = p.parent) if (objs.includes(p)) return true; return false; };
  return { objs: objs.filter((o) => !covered(o)), unknown: r.unknown };
}
/** (Re)build every copy from its sources (in order: a copy can copy an earlier copy). Sources are read at their current pose. */
async function buildCopies() {
  regVersion++;
  for (const id of [...built.registry.keys()]) if (id.startsWith(COPIES_ROOT + '/')) built.registry.delete(id);
  for (const c of [...copiesRoot.children]) copiesRoot.remove(c);   // geometry and materials are the sources'
  copyErrors.clear();
  built.root.updateMatrixWorld(true);
  for (const d of copies) {
    const { objs, unknown } = copySources(d);
    if (unknown.length) copyErrors.set(d.id, `Not found: ${unknown.join(', ')}`);
    else if (!objs.length) copyErrors.set(d.id, 'Nothing to copy (its parts were removed)');
    // locked + hidden CAD has freed its geometry: bring it back for the clone, then free it again
    const supp: THREE.Mesh[] = [];
    for (const o of objs) o.traverse((x) => { if (x.userData.suppressed) supp.push(x as THREE.Mesh); });
    if (supp.length) await cad.restore(supp);
    let clash = '';
    const { root } = buildCopy(d, { objs, skip: (o) => !!o.userData.removed }, (o, id) => {
      if (built.registry.has(id) && !clash) clash = id;
      o.userData.id = id; built.registry.set(id, o);
    });
    if (clash) copyErrors.set(d.id, `Name clash: ${clash} is used twice – rename this copy`);
    if (supp.length) cad.suppress(supp);
    copiesRoot.add(root);
    root.updateMatrixWorld(true);
  }
  copiesRoot.traverse((o) => { o.userData.homeP = o.position.toArray(); o.userData.homeQ = o.quaternion.toArray(); });
  for (const id of removed) { const o = built.registry.get(id); if (o) o.userData.removed = true; }
  for (const [id, l] of Object.entries(labels)) { const o = built.registry.get(id); if (o) o.userData.label = l; }
}
await buildCopies();

// ---------- placements (parts moved with the gizmo; saved in snapshots) ----------
for (const o of built.registry.values()) { o.userData.homeP = o.position.toArray(); o.userData.homeQ = o.quaternion.toArray(); }
const idOfObj = (o: THREE.Object3D) => (o.userData.id ?? o.name) as string;
function applyPlacements() {
  for (const o of built.registry.values()) {
    const pl = state.placements[idOfObj(o)];
    o.position.fromArray(pl?.p ?? o.userData.homeP);
    o.quaternion.fromArray(pl?.q ?? o.userData.homeQ);
    o.updateMatrix();
  }
}
// ---------- base colours (model.colors: part id or @group → #hex; a part's own colour wins) ----------
let colors: Record<string, string> = { ...(model.colors ?? {}) };
// ---------- keep uncut: parts every cut leaves whole (model.cutKeep: ids / @groups / ~names), plus a script cut's own keep ----------
let cutKeep: string[] = [...(model.cutKeep ?? [])];
const uncut = new Uncut(built.clipPlanes);
let keptMemo: { key: string; saved: THREE.Object3D[]; roots: THREE.Object3D[] } | undefined;
/** The saved list's parts, and those plus a cut's own keep ids (top-most objects only). */
function keptRoots(extra: string[] = []) {
  const key = `${regVersion}|${cutKeep.join('\u0001')}|${extra.join(',')}|${Object.keys(store.groups).length}`;
  if (keptMemo?.key !== key) {
    const top = (ids: string[]) => {
      const objs = [...new Set(ids)].map((x) => built.registry.get(x)).filter(Boolean) as THREE.Object3D[];
      return objs.filter((o) => { for (let p = o.parent; p; p = p.parent) if (objs.includes(p)) return false; return true; });
    };
    const saved = top(cutKeep.flatMap((s) => (s.startsWith('~') ? partsNamed(s.slice(1)).map(idOfObj) : resolveIds([s]).ids)));
    keptMemo = { key, saved, roots: top([...saved.map(idOfObj), ...extra]) };
  }
  return keptMemo;
}
/** Kept uncut by the saved list: 'own' (listed itself, or its group is), 'inh' (an ancestor is), or no. */
function keptState(o?: THREE.Object3D, group?: string): 'own' | 'inh' | undefined {
  if (group) return cutKeep.includes(`@${group}`) ? 'own' : undefined;
  if (!o) return;
  const saved = keptRoots().saved;
  if (saved.includes(o)) return 'own';
  for (let p = o.parent; p; p = p.parent) if (saved.includes(p)) return 'inh';
}
/** Keep the selection uncut (on) or cut it again (off): saved with the animation. */
function setKeep(specs: string[], objs: THREE.Object3D[], on: boolean) {
  if (on) cutKeep = [...new Set([...cutKeep, ...specs])];
  else {
    const within = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (objs.includes(p)) return true; return false; };
    cutKeep = cutKeep.filter((s) => !specs.includes(s) && !(s.startsWith('~') ? [] : resolveIds([s]).ids).some((x) => { const o = built.registry.get(x); return o && within(o); }));
    const still = objs.filter((o) => keptState(o));
    if (still.length) toast(`✂ Still kept uncut through an assembly or group that contains ${still.length === 1 ? 'it' : `${still.length} of them`}`);
  }
  edit({ cutKeep: [...cutKeep] });
  tree.redraw(); updateTools(); renderKeepCtl();
}
function toast(msg: string, ms = 2200) {
  undoToast.textContent = msg; undoToast.style.display = '';
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (undoToast.style.display = 'none'), ms);
}
/** Apply a cut this frame: planes, core blocks, the parts kept whole, caps on/off. */
function applyCut(cutNow: Cut | CutMode) {
  const c = toCut(cutNow);
  const roots = c.mode === 'none' ? [] : keptRoots(c.keep ?? []).roots;
  uncut.update(roots);
  applyCutaway(built, c, (o) => uncut.has(o));
  capUniforms.capOn.value = ui.caps && !c.nocap ? 1 : 0;
}
let coloured: THREE.Mesh[] = [];
let materialColours: string[] | undefined; // the model's own material colours (computed once, for the swatches)
/** Put a material on a mesh, respecting the tree's selection highlight (which keeps the real one in origMat). */
const setMat = (m: THREE.Mesh, mat: THREE.Material) => { if (m.userData.origMat) m.userData.origMat = mat; else m.material = mat; };
function applyColors() {
  for (const m of coloured) { setMat(m, m.userData.baseMat0); delete m.userData.baseMat0; m.userData.ownMat = false; }
  coloured = [];
  const entries = Object.entries(colors).sort(([a], [b]) => Number(b.startsWith('@')) - Number(a.startsWith('@'))); // groups first, parts win
  for (const [spec, hex] of entries) for (const id of resolveIds([spec]).ids) {
    built.registry.get(id)?.traverse((x) => {
      const m = x as THREE.Mesh;
      const cur = (m.userData.origMat ?? m.material) as THREE.MeshToonMaterial;
      if (!m.isMesh || !cur || cur.side === THREE.BackSide) return; // outline hulls stay black
      if (!m.userData.baseMat0) { m.userData.baseMat0 = cur; coloured.push(m); }
      const c = (m.userData.baseMat0 as THREE.Material).clone() as THREE.MeshToonMaterial;
      c.clippingPlanes = (m.userData.baseMat0 as THREE.Material).clippingPlanes; // clone() copies the planes; keep the live cutaway ones
      withCaps(c);
      c.color?.set(hex);
      setMat(m, c);
      m.userData.ownMat = true; // the compiler's highlight/fade may change it without cloning again
    });
  }
}
/** The shortest script name for a part: its last id segment when no other part shares it (else the full id). */
function shortSpec(spec: string) {
  if (spec.startsWith('@') || !spec.includes('/')) return spec;
  const short = spec.slice(spec.lastIndexOf('/') + 1);
  if (!/^[\w.#-]+$/.test(short)) return spec;
  let n = 0;
  for (const id of built.registry.keys()) if (id.slice(id.lastIndexOf('/') + 1) === short && ++n > 1) return spec;
  return short;
}
/** Remove parts from (or restore them to) this animation's assembly; saved with the animation. */
async function setRemoved(ids: string[], rem: boolean) {
  for (const id of ids) {
    const o = built.registry.get(id); if (!o) continue;
    if (rem) { removed.add(id); o.userData.removed = true; } else { removed.delete(id); delete o.userData.removed; }
  }
  for (const id of ids) { const o = built.registry.get(id); if (o) await reconcile(o); }
  edit({ removed: [...removed] });
  if (copies.length && ids.some((id) => !id.startsWith(COPIES_ROOT + '/'))) { await syncCopies(false); return; }   // copies follow their sources
  tree.rebuild();
  buildTimeline();
}
/** Set (hex) or clear (null) the base colour of parts / @groups; saved with the animation. */
function setColors(specs: string[], hex: string | null) {
  const t = player.time;
  player.seek(0);
  for (const s0 of specs) { if (hex) colors[s0] = hex; else delete colors[s0]; }
  applyColors();
  buildTimeline({ atStart: true });
  player.seek(t);
  edit({ colors: { ...colors } });
  tree.redraw();
}

useSnapshot(store.snapshots[store.active]);
applyPlacements();
for (const o of built.root.children) await reconcile(o);
applyColors();

let player!: Player;
// no camera in the script: frame everything that's loaded
const frameAll = () => {
  const box = new THREE.Box3().setFromObject(built.root);
  if (box.isEmpty()) return { pos: [12, 16, 14], look: [0, 5, 0] };
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
  const d = r / Math.sin(THREE.MathUtils.degToRad(20)) * 0.9;
  const dir = new THREE.Vector3(1, 0.8, 1.1).normalize();
  return { pos: c.clone().addScaledVector(dir, d).toArray(), look: c.toArray() };
};
const defaultCam = script.camera ?? frameAll();
// gizmo selection / drag state (declared early: buildTimeline → onTimeline reads them)
let gSel: { spec?: string; objs: THREE.Object3D[] } = { objs: [] };
let drag: { members: { o: THREE.Object3D; world: THREE.Matrix4; p: THREE.Vector3; q: THREE.Quaternion }[]; pivot: THREE.Matrix4 } | undefined;
let gizmoReady = false; // set once the gizmo exists (timeline refreshes before that skip it)
let previewUnlocked = new Set<string>(); // parts a previewed assist proposal would unlock
/** Every locked part a script animates (compiled with locks ignored, recording what it touches). */
function lockedIn(acts: ReturnType<typeof toActions>): string[] {
  const ids = new Set<string>();
  const t = player?.time ?? 0;
  player?.seek(0);
  try {
    compile(acts, built, acts.camera ?? defaultCam, (o) => { if (isLocked(o)) ids.add(idOfObj(o)); return false; }, store.groups, isRemoved, views);
  } catch { /* other errors are reported elsewhere */ } finally { player?.seek(t); }
  return [...ids];
}
/** Compile the current script. On error the previous timeline keeps playing. */
function buildTimeline(o: { atStart?: boolean } = {}): boolean {
  const t = player?.time ?? 0, playing = player?.playing ?? false;
  // compile from the start pose (positions, colours) – not the animated one. atStart: the caller already put the
  // scene at its start pose and changed it (base colours); the old player's reset would undo that change
  if (!o.atStart) player?.seek(0);
  try {
    const tl = compile(script, built, script.camera ?? defaultCam, (o) => isLocked(o) && !previewUnlocked.has(idOfObj(o)), store.groups, isRemoved, views);
    player = new Player(built, tl);
    player.playing = playing;
    player.seek(Math.min(t, tl.duration));
    subEl.textContent = '';
    scriptPanel?.setErrors(scriptErrors);
    onTimeline();
    return true;
  } catch (e: any) {
    player?.seek(t);
    if (scriptPanel && e instanceof ScriptError && e.line) {
      // locked target: offer a one-click unlock of everything that line moves
      let fix: ParseError['fix'];
      const rm = e.message.match(/^"([^"]+)" is removed from the assembly/);
      const gone = e.message.match(/Unknown group "@([^"]+)"/);
      if (rm) fix = { label: `Restore ${labels[rm[1]] ?? rm[1].split('/').pop()}`, run: () => setRemoved([rm[1]], false) };
      else if (gone && tree.lastDeletedGroup?.name === gone[1]) {
        const g = tree.lastDeletedGroup;
        fix = { label: `Undo delete @${g.name}`, run: () => { store.groups[g.name] = g.ids; tree.lastDeletedGroup = undefined; tree.rebuild(); buildTimeline(); edit({ groups: JSON.parse(JSON.stringify(store.groups)) }); } };
      } else if (/is locked/.test(e.message)) {
        const ids = lockedIn(script);
        const n = ids.length, name = n === 1 ? (labels[ids[0]] ?? ids[0].split('/').pop()) : `${n} parts`;
        if (n) {
          fix = { label: `🔓 Unlock ${name}`, run: () => { applyStateChanges([{ ids, lock: false }]); } };
          e.message = `${e.message.replace(/ – unlock it.*$/, '')}. The script animates ${n} locked part${n === 1 ? '' : 's'} – unlock ${n === 1 ? 'it' : 'them'} to play it.`;
        }
      }
      scriptPanel.setErrors([...scriptErrors, { line: e.line, from: -1, to: -1, message: e.message, fix }]);
    } else { chapterEl.textContent = 'Script error'; subEl.textContent = e.message; }
    console.error(e);
    return false;
  }
}
let onTimeline = () => {};
let scriptPanel: ScriptPanel | undefined;
if (!buildTimeline()) player = new Player(built, { tweens: [], steps: [], duration: 0, touched: [], lines: new Map(),
  camera: { pos: new THREE.Vector3(...defaultCam.pos), look: new THREE.Vector3(...defaultCam.look), initPos: new THREE.Vector3(...defaultCam.pos), initLook: new THREE.Vector3(...defaultCam.look) } });
camera.position.copy(player.tl.camera.pos);
controls.target.copy(player.tl.camera.look);


// ---------- UI ----------
const ui = {
  play: () => { if (player.time >= player.duration) player.seek(0); player.playing = !player.playing; },
  restart: () => { player.seek(0); player.playing = true; },
  speed: 1,
  time: 0,
  cutaway: 'script' as 'script' | CutMode,
  /** the section the Controls choose (when Cutaway isn't "script") */
  halfSide: 'x' as CutSide,
  quarterSides: 'x z',
  cutAt: [0, 0, 0] as number[],
  cutCentre: 'origin',
  caps: true,
  capShade: 0.55,
  xray: false,
  followCamera: true,
};
const right = document.createElement('div'); right.id = 'right'; host().appendChild(right);
const gui = new GUI({ title: 'Controls', container: right });
const pb = gui.addFolder('Playback');
pb.add(ui, 'play').name('Play / pause  [space]');
pb.add(ui, 'restart').name('Restart');
pb.add(ui, 'speed', 0.25, 8, 0.25).onChange((v: number) => (player.speed = v));
const timeCtl = pb.add(ui, 'time', 0, player.duration, 0.01).name('Time (s)').onChange((v: number) => { player.playing = false; player.seek(v); });
const view = gui.addFolder('View');
view.add(ui, 'cutaway', ['script', 'none', 'half', 'quarter']).name('Cutaway');
view.add(ui, 'caps').name('Caps (section faces)');
view.add(ui, 'capShade', 0.25, 0.95, 0.05).name('Cap shade').onChange((v: number) => (capUniforms.capShade.value = v));
view.add(ui, 'halfSide', { '+x side': 'x', '−x side': '-x', '+z side': 'z', '−z side': '-z', 'top (+y)': 'y', 'bottom (−y)': '-y' }).name('Half removes');
view.add(ui, 'quarterSides', { '+x +z': 'x z', '+x −z': 'x -z', '−x +z': '-x z', '−x −z': '-x -z' }).name('Quarter removes');
const centreCtl = view.add(ui, 'cutCentre').name('Cut centre').disable();
const cutActions = {
  centreOnSelection: () => {
    const objs = gSel.objs;
    if (!objs.length) { alert('Select the part or group to centre the cut on first.'); return; }
    const box = new THREE.Box3(); objs.forEach((o) => box.expandByObject(o));
    ui.cutAt = box.getCenter(new THREE.Vector3()).toArray();
    ui.cutCentre = `selection [${ui.cutAt.map((v) => v.toFixed(2)).join(', ')}]`; centreCtl.updateDisplay();
    if (ui.cutaway === 'script') { ui.cutaway = 'half'; gui.controllersRecursive().forEach((c) => c.updateDisplay()); }
  },
  centreOnOrigin: () => { ui.cutAt = [0, 0, 0]; ui.cutCentre = 'origin'; centreCtl.updateDisplay(); },
  insert: () => {
    if (!scriptPanel) return;
    const v = scriptPanel.view, l = v.state.doc.line(scriptPanel.cursorLine);
    v.dispatch({ changes: { from: l.to, insert: `\n${l.text.match(/^\s*/)![0]}${cutLine(uiCut())}` } });
    showTab('script'); v.focus();
  },
};
view.add(cutActions, 'centreOnSelection').name('Centre cut on selection');
view.add(cutActions, 'centreOnOrigin').name('Centre cut on origin');
view.add(cutActions, 'insert').name('⤓ Insert this cut into the script');
// keep uncut: the saved list (every cut leaves these whole)
const keepUi = {
  kept: 'none',
  add: () => { if (!gSel.objs.length) return alert('Select the parts to keep whole first.'); setKeep(tree.selectedSpecs(), gSel.objs, true); },
  remove: () => { if (!gSel.objs.length) return alert('Select the parts to cut again first.'); setKeep(tree.selectedSpecs(), gSel.objs, false); },
  clear: () => { if (cutKeep.length) setKeep([...cutKeep], [], false); },
};
const keptCtl = view.add(keepUi, 'kept').name('Kept uncut').disable();
view.add(keepUi, 'add').name('✂ Keep selection uncut  [K]');
view.add(keepUi, 'remove').name('Cut selection again');
view.add(keepUi, 'clear').name('Clear the kept list');
function renderKeepCtl() {
  const short = (s: string) => (s.startsWith('@') || s.startsWith('~') ? s : labels[s] ?? s.slice(s.lastIndexOf('/') + 1));
  keepUi.kept = cutKeep.length ? `${cutKeep.slice(0, 3).map(short).join(', ')}${cutKeep.length > 3 ? ` +${cutKeep.length - 3}` : ''}` : 'none';
  keptCtl.updateDisplay();
}
renderKeepCtl();
/** The cut the Controls choose. */
function uiCut(): Cut {
  const mode = (ui.cutaway === 'script' ? 'half' : ui.cutaway) as CutMode;
  return { mode, sides: mode === 'half' ? [ui.halfSide] : mode === 'quarter' ? ui.quarterSides.split(' ') as CutSide[] : DEFAULT_SIDES[mode], at: ui.cutAt, nocap: !ui.caps };
}
view.add(ui, 'xray').name('X-ray shells').onChange((on: boolean) => built.shellMaterials.forEach((m) => {
  m.userData.orig ??= m.userData.baseOpacity ?? m.opacity;
  m.userData.baseOpacity = m.opacity = on ? Math.min(0.25, m.userData.orig) : m.userData.orig;
  m.transparent = true; m.depthWrite = !on;
}));
view.add(ui, 'followCamera').name('Scripted camera');
const chapters = gui.addFolder('Chapters').close();
function rebuildChapters() {
  [...chapters.controllers].forEach((c) => c.destroy());
  player.tl.steps.filter((s) => s.kind === 'label').forEach((s) =>
    chapters.add({ go: () => { player.seek(s.t); player.playing = true; } }, 'go').name(`${s.t.toFixed(0).padStart(3)}s  ${s.value}`));
  timeCtl.max(player.duration);
}
rebuildChapters();
onTimeline = () => { rebuildChapters(); if (!drag && gizmoReady) gizmoFor?.(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs); };

// ---------- script panel (.anim) ----------
function scriptChanged(text: string) {
  const doc = parseAnim(text);
  if (doc.errors.length) edit({ script: { language: 'anim', text } }); // keep the text even while it has errors
  scriptErrors = doc.errors;
  if (doc.errors.length) { scriptPanel!.setErrors(doc.errors); return; } // keep the last good timeline
  script = toActions(doc.steps);
  buildTimeline();
  edit({ script: { language: 'anim', text } });
}

let paletteKey = model.view?.paletteKey ?? DEFAULT_PALETTE_KEY;
function modelColors(): string[] {
    // base colours set in this animation (most recent first), then the model's own material colours (most common first)
    const base = [...new Set(Object.values(colors).reverse())];
    if (!materialColours) {
      const count = new Map<string, number>();
      built.root.traverse((x) => {
        const m = x as THREE.Mesh;
        const mat = (m.userData.baseMat0 ?? m.userData.origMat ?? m.material) as THREE.MeshToonMaterial | undefined;
        if (!m.isMesh || !mat?.color || mat.side === THREE.BackSide || !m.visible) return;
        const hex = `#${mat.color.getHexString()}`;
        count.set(hex, (count.get(hex) ?? 0) + 1);
      });
      materialColours = [...count].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    }
    return [...base, ...materialColours.filter((c) => !base.includes(c))];
  }

if (isAnim) {
  scriptPanel = new ScriptPanel(right, scriptName, animText, {
    change: (text, typed) => { typing = typed; try { scriptChanged(text); } finally { typing = false; } },
    save: async (text) => { typing = true; try { edit({ script: { language: 'anim', text } }); } finally { typing = false; } },
    seek: (t) => { player.playing = false; player.seek(t); gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs); },
    ids: () => [...Object.keys(store.groups).map((g) => `@${g}`), ...built.registry.keys()],
    views: () => Object.keys(views),
    cameraLine: () => cameraLine(probe),
    colors: () => [...new Set([...modelColors(), ...palette(paletteKey).map((p) => p.hex)])],
  });
  scriptPanel.setErrors(scriptErrors);
  buildTimeline(); // again now the panel exists, so compile errors (e.g. locked parts) show in the editor with their fix
}
// ---------- [Animation | Illustration | AI Assist] tabs (Animation = the controls + the .anim script) ----------
const tabs = document.createElement('div'); tabs.className = 'rtabs';
tabs.innerHTML = `<button data-t="script" class="on" title="Animation: playback and view controls, and the animation script">Animation</button><button data-t="illustration" title="Illustration: print-quality vector line drawings">Illustration</button><button data-t="assist">AI Assist</button>`;
const tabCss = document.createElement('style');
tabCss.textContent = `#right { position: absolute; top: 0; right: 0; bottom: 0; width: 420px; display: flex; flex-direction: column; z-index: 5;
  background: rgba(14,17,21,.95); border-left: 1px solid #222a33; }
#right.collapsed { transform: translateX(420px); }
#right .lil-gui.root { width: 100% !important; --width: 100%; max-height: 45vh; overflow: auto; flex: none; }
#right-toggle { position: absolute; top: 8px; right: 428px; z-index: 6; background:#222a33; color:#d7dde4; border:1px solid #2b3540; border-radius:4px; padding:3px 8px; cursor:pointer; }
.studio-root.right-collapsed #right-toggle { right: 8px; }
#right .rtabs { display: flex; border-bottom: 1px solid #222a33; flex: none; } #right .rtabs button { flex: 1; background: transparent; color: #7b8794; border: 0; border-bottom: 2px solid transparent; padding: 6px; cursor: pointer; font: 600 12px system-ui; }
  #right .rtabs button.on { color: #f2b705; border-bottom-color: #f2b705; } #script, #assist { border-top: 0 !important; } #assist { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#illustration { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#illustration .draw-script { flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid #222a33; }
#illustration .draw-script header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font: 600 12px system-ui; color: #d7dde4; }
#illustration .draw-script header .st { font-weight: 400; font-size: 11px; }
#illustration .draw-script header button { background: #1b222a; color: #d7dde4; border: 1px solid #2b3540; border-radius: 4px; padding: 3px 8px; cursor: pointer; font: 12px system-ui; }
#illustration .draw-script header button:hover { background: #26303a; }
#illustration .draw-script .ed { flex: 1; min-height: 0; overflow: auto; }
#illustration .draw-script .busy { padding: 6px 10px; font: 12px system-ui; color: #f2b705; border-top: 1px solid #222a33; }
#sheet-preview { position: absolute; inset: 0 420px 0 0; z-index: 6; background: #e9ecef; display: flex; flex-direction: column; }
.studio-root.right-collapsed #sheet-preview { right: 0; }
.studio-root:has(#sheet-preview) #viewbar { display: none; }   /* the view bar's buttons don't apply to a sheet */
#sheet-preview header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: rgba(14,17,21,.95); color: #d7dde4; font: 12px system-ui; }
#sheet-preview header .info { color: #7b8794; flex: 1; }
#sheet-preview header button { background: #1b222a; color: #d7dde4; border: 1px solid #2b3540; border-radius: 4px; padding: 3px 8px; cursor: pointer; font: 12px system-ui; }
#sheet-preview .page { flex: 1; min-height: 0; padding: 16px; display: flex; align-items: center; justify-content: center; }
#sheet-preview .page img { max-width: 100%; max-height: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.25); background: #fff; }
#sheet-preview .strip { flex: none; display: flex; gap: 8px; padding: 8px 10px; overflow-x: auto; background: rgba(14,17,21,.95); }
#sheet-preview .strip .th { flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 4px; background: transparent; border: 2px solid transparent; border-radius: 4px; cursor: pointer; color: #9aa5b1; font: 11px system-ui; }
#sheet-preview .strip .th img { height: 64px; min-width: 40px; background: #fff; box-shadow: none; }
#sheet-preview .strip .th.on { border-color: #f2b705; color: #d7dde4; }
#sheet-preview .strip .th.bad span { color: #ff6b6b; }`;
document.head.appendChild(tabCss);
right.prepend(tabs);
// ---------- Illustration: drawing controls + (phase 2) the drawing script ----------
const illEl = document.createElement('div'); illEl.id = 'illustration'; right.appendChild(illEl);
const sheet = { paper: 'A3', portrait: false, scale: 0, hidden: false, creaseDeg: 30, svg: () => exportSvg(sheetOptions()) };
const sheetOptions = (): DrawingOptions => ({ paper: sheet.paper as DrawingOptions['paper'], portrait: sheet.portrait, scale: sheet.scale || undefined, hidden: sheet.hidden, creaseDeg: sheet.creaseDeg });
const illGui = new GUI({ title: 'Controls', container: illEl });
const sh = illGui.addFolder('Sheet');
sh.add(sheet, 'paper', ['A0', 'A1', 'A2', 'A3', 'A4']).name('Paper');
sh.add(sheet, 'portrait').name('Portrait');
sh.add(sheet, 'scale', { 'Fit to sheet': 0, '1:10': 10, '1:20': 20, '1:25': 25, '1:50': 50, '1:100': 100, '1:200': 200, '1:500': 500 }).name('Scale');
const ln = illGui.addFolder('Lines');
ln.add(sheet, 'hidden').name('Hidden lines (dashed)');
ln.add(sheet, 'creaseDeg', 5, 90, 1).name('Crease angle (°)');
illGui.add(sheet, 'svg').name('⤓ Export SVG (current view, orthographic)');
let drawPanel: DrawPanel | undefined;
{
  let saveTimer: number | undefined;
  drawPanel = new DrawPanel(illEl, model.drawings ? joinLines(model.drawings.text) : DEFAULT_DRAW, {
    change: (text, typed) => {
      clearTimeout(saveTimer);
      const save = () => { typing = typed; try { edit({ drawings: { language: 'draw', text } }); } finally { typing = false; } };
      if (typed) saveTimer = window.setTimeout(save, 500); else save();
      if (typed) liveSheet();
    },
    cursor: (name) => { if (previewEl && name && sheetImgs.has(name)) showSheet(name); else if (previewEl) liveSheet(); },
    preview: (name) => void previewSheet(name),
    saveAll: () => void saveAllSheets(),
    views: () => Object.keys(views),
    snapshots: () => Object.keys(store.snapshots),
  });
}
// ---------- assist tools (read-only) ----------
const toolDeps: ToolDeps = {
  registry: built.registry,
  groups: () => store.groups,
  isLocked, isHidden,
  roots: () => built.root.children.filter((o) => built.registry.get(idOfObj(o)) === o),
  checkScript: (text) => {
    const doc = parseAnim(text);
    if (doc.errors.length) return { errors: doc.errors.map((e) => ({ line: e.line, message: e.message })) };
    const t = player.time;
    player.seek(0); // compile reads the start pose
    try {
      const acts = toActions(doc.steps);
      // locked parts are reported, not errors: accepting a proposal unlocks them (every one the script animates)
      const locked = lockedIn(acts);
      const tl = compile(acts, built, acts.camera ?? defaultCam, () => false, store.groups, isRemoved, views);
      const src = text.split('\n');
      return { errors: [], locked, duration: tl.duration, steps: [...tl.lines].sort((a, b) => a[0] - b[0]).map(([line, x]) => ({ line, ...x, text: src[line - 1].trim() })) };
    } catch (e: any) {
      return { errors: [{ line: e.line ?? 0, message: e.message }] };
    } finally { player.seek(t); }
  },
  screenshot: (view, target) => {
    const helper = gizmo.getHelper(); const hv = helper.visible; helper.visible = false;
    let cam: THREE.Camera = camera, note = 'The user\'s current view.';
    if (view !== 'current') {
      const objs = target ? resolveSpec(target) : [built.root];
      const b = worldBox(objs.length ? objs : [built.root]);
      const c = b.getCenter(new THREE.Vector3()), r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 0.5);
      const dir = { iso: [1, 0.8, 1.1], top: [0, 1, 0.001], front: [0, 0, 1], side: [1, 0, 0] }[view as 'iso'] ?? [1, 0.8, 1.1];
      const pc = new THREE.PerspectiveCamera(40, renderer.domElement.width / renderer.domElement.height, 0.05, r * 20);
      pc.position.copy(c).addScaledVector(new THREE.Vector3(...dir).normalize(), r / Math.sin(THREE.MathUtils.degToRad(20)) * 1.1);
      if (view === 'top') pc.up.set(0, 0, -1);
      pc.lookAt(c); pc.updateMatrixWorld();
      cam = pc;
      note = `${view} view framed on ${target ?? 'the whole scene'} (centre ${c.toArray().map((v) => v.toFixed(2)).join(', ')}, radius ${r.toFixed(2)} m). Y is up.`;
    }
    renderer.render(scene3, cam);
    const src = renderer.domElement, w = Math.min(1280, src.width), h = Math.round(src.height * w / src.width);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d')!.drawImage(src, 0, 0, w, h);
    helper.visible = hv;
    return { data: cv.toDataURL('image/jpeg', 0.85).split(',')[1], width: w, height: h, note };
  },
};
/** ids, globs (*) and @groups -> registry ids */
function resolveIds(specs: string[]) {
  const ids = new Set<string>(), unknown: string[] = [];
  for (const sp of specs) {
    const s0 = String(sp);
    if (s0.startsWith('@')) { const g = store.groups[s0.slice(1)]; if (g) g.forEach((x) => ids.add(x)); else unknown.push(s0); continue; }
    if (s0.includes('*')) {
      const re = new RegExp('^' + s0.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      let hit = false;
      const short = !s0.includes('/');                      // as in scripts: a glob without "/" also matches short names
      for (const id of built.registry.keys()) if (re.test(id) || (short && re.test(id.slice(id.lastIndexOf('/') + 1)))) { ids.add(id); hit = true; }
      if (!hit) unknown.push(s0);
      continue;
    }
    if (built.registry.has(s0)) { ids.add(s0); continue; }
    // a unique short name (last id segment) or display name, as scripts allow
    const named = [...built.registry.keys()].filter((id) => !id.startsWith(COPIES_ROOT + '/' ) || id.split('/').length === 2).filter((id) => id.slice(id.lastIndexOf('/') + 1) === s0 || labels[id] === s0);
    if (named.length === 1) ids.add(named[0]); else unknown.push(named.length ? `${s0} (ambiguous: ${named.length} parts – use the id)` : s0);
  }
  return { ids: [...ids], unknown };
}
const tools = [
  ...readTools(toolDeps),
  ...proposeTools({ checkScript: toolDeps.checkScript, currentScript: () => scriptPanel?.text ?? '' }),
  ...modelProposeTools({ resolve: resolveIds, groups: () => store.groups, shapes: () => shapes, planPlacement }),
];

// ---------- positioning parts (assist): a rigid world transform at the start pose → placements / shape numbers ----------
/** Targets → registered objects, dropping any covered by another target's ancestor (they move with it). */
function placeTargets(targets: string[]) {
  const r = resolveIds(targets);
  const objs = r.ids.map((x) => built.registry.get(x)).filter(Boolean) as THREE.Object3D[];
  const covered = (o: THREE.Object3D) => { for (let p = o.parent; p; p = p.parent) if (objs.includes(p)) return true; return false; };
  return { objs: objs.filter((o) => !covered(o) && o !== built.root && o !== shapesRoot && o !== copiesRoot), unknown: r.unknown };
}
/** Run f with the scene at the start pose (t = 0), matrices current; the time is put back. */
function atStart<T>(f: () => T): T {
  const t = player.time, playing = player.playing;
  player.playing = false; player.seek(0); built.root.updateMatrixWorld(true);
  try { return f(); } finally { player.seek(t); player.playing = playing; }
}
const AXES: Record<string, number[]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
function planPlacement(c: PlacementInput): PlacementPlan {
  const problems: string[] = [];
  const targets = Array.isArray(c.targets) ? c.targets.map(String) : [];
  const { objs, unknown } = placeTargets(targets);
  unknown.forEach((u) => problems.push(`unknown target "${u}"`));
  if (!objs.length && !unknown.length) problems.push(`${targets.join(', ') || 'targets'}: no parts matched`);
  const ids = objs.map(idOfObj);
  if (c.reset) return { targets, ids, reset: true, problems };
  const v3 = (v: unknown, what: string) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) { problems.push(`${what} must be [x, y, z]`); return undefined; }
    return new THREE.Vector3(...v.map(Number));
  };
  const by = v3(c.move_by, 'move_by'), to = v3(c.move_to, 'move_to');
  if (by && to) problems.push('give move_by or move_to, not both');
  if (!by && !to && !c.rotate) problems.push('a change needs move_by, move_to, rotate or reset');
  if (c.anchor && !['centre', 'bottom', 'top'].includes(c.anchor)) problems.push('anchor is centre, bottom or top');
  let axis: THREE.Vector3 | undefined;
  if (c.rotate) {
    const a = typeof c.rotate.axis === 'string' ? AXES[c.rotate.axis.toLowerCase()] : c.rotate.axis;
    if (!Array.isArray(a) || a.length !== 3 || !(Number.isFinite(+c.rotate.degrees))) problems.push('rotate needs axis (x, y, z or [x,y,z]) and degrees');
    else { axis = new THREE.Vector3(...a.map(Number)); if (axis.lengthSq() < 1e-12) { problems.push('rotate axis is zero'); axis = undefined; } else axis.normalize(); }
  }
  if (!objs.length || problems.length) return { targets, ids, problems };
  return atStart(() => {
    const box = worldBox(objs);
    const fmt = (b: THREE.Box3) => ({ centre: b.getCenter(new THREE.Vector3()).toArray(), min: b.min.toArray(), max: b.max.toArray() });
    const before = fmt(box);
    let D = new THREE.Matrix4();
    if (axis) {
      const pivot = v3(c.rotate!.pivot, 'pivot') ?? box.getCenter(new THREE.Vector3());
      const R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(+c.rotate!.degrees));
      D = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    }
    const rotated = box.clone().applyMatrix4(D);       // conservative box after the rotation
    let move = by ?? new THREE.Vector3();
    if (to) {
      const ctr = rotated.getCenter(new THREE.Vector3());
      const anchor = c.anchor === 'bottom' ? new THREE.Vector3(ctr.x, rotated.min.y, ctr.z) : c.anchor === 'top' ? new THREE.Vector3(ctr.x, rotated.max.y, ctr.z) : ctr;
      move = to.clone().sub(anchor);
    }
    D = new THREE.Matrix4().makeTranslation(move.x, move.y, move.z).multiply(D);
    // the box after: transform each part's own box (tighter than the rotated union box)
    const after = new THREE.Box3();
    for (const o of objs) after.union(new THREE.Box3().setFromObject(o).applyMatrix4(D));
    const r4 = (v: number[]) => v.map((x) => +x.toFixed(4));
    return { targets, ids, matrix: D.toArray(), before: { centre: r4(before.centre), min: r4(before.min), max: r4(before.max) },
      after: (({ centre, min, max }) => ({ centre: r4(centre), min: r4(min), max: r4(max) }))(fmt(after)),
      move: r4(move.toArray()), rotate: axis ? { axis: r4(axis.toArray()), degrees: +c.rotate!.degrees } : undefined, problems };
  });
}
/** Apply accepted placements: each target's local pose = D × its start world pose (shapes: their own numbers). */
async function applyPlacementChanges(plans: PlacementPlan[]) {
  const t = player.time, playing = player.playing;
  let shapeMoved = false;
  const moved: THREE.Object3D[] = [];
  player.playing = false; player.seek(0); built.root.updateMatrixWorld(true);
  {
    for (const pl of plans) {
      const objs = pl.ids.map((x) => built.registry.get(x)).filter(Boolean) as THREE.Object3D[];
      for (const o of objs) {
        const def = o.userData.shape !== undefined && !o.userData.array && o.parent === shapesRoot ? shapes.find((x) => x.id === o.userData.shape) : undefined;
        if (pl.reset) {
          delete state.placements[idOfObj(o)];
          o.position.fromArray(o.userData.homeP); o.quaternion.fromArray(o.userData.homeQ);
        } else {
          const w = new THREE.Matrix4().fromArray(pl.matrix!).multiply(o.matrixWorld);
          const local = o.parent ? o.parent.matrixWorld.clone().invert().multiply(w) : w;
          local.decompose(o.position, o.quaternion, new THREE.Vector3());
          if (def) {
            def.position = o.position.toArray().map((v) => +v.toFixed(4));
            def.rotation = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ').toArray().slice(0, 3).map((a) => +THREE.MathUtils.radToDeg(a as number).toFixed(3));
            delete state.placements[idOfObj(o)];
            shapeMoved = true;
          } else state.placements[idOfObj(o)] = { p: o.position.toArray(), q: o.quaternion.toArray() };
        }
        // locked parts skip matrix updates: refresh theirs now
        o.traverse((x) => { x.matrixAutoUpdate = true; x.matrixWorldAutoUpdate = true; });
        o.updateMatrixWorld(true);
        moved.push(o);
      }
    }
  }
  // rebuild from the new start pose (no seek in between: the old player would put animated parts back)
  if (shapeMoved) { buildShapes(); applyColors(); tree.rebuild(); }
  applyPlacements();
  for (const o of shapeMoved ? [...moved, shapesRoot] : moved) await reconcile(o);
  persistWorking();
  if (shapeMoved) edit({ shapes: clone(shapes) });
  buildTimeline({ atStart: true });
  player.seek(Math.min(t, player.duration)); player.playing = playing;
  tree.redraw();
  gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs);
}

/** Apply accepted shape changes (assist): create / update (incl. rename – the script follows) / delete, then rebuild once. */
async function applyShapeChanges(changes: ShapeChange[]) {
  let rename: [string, string] | undefined;
  for (const c of changes) {
    if (c.action === 'delete') { shapes = shapes.filter((s) => s.id !== c.name); continue; }
    if (c.action === 'create') { if (!shapes.some((s) => s.id === c.def!.id)) shapes.push(clone(c.def!)); continue; }
    const i = shapes.findIndex((s) => s.id === c.name);
    if (i < 0) continue;
    shapes[i] = clone(c.def!);
    if (c.rename) { renameShapeRefs(c.name, c.rename); rename = [c.name, c.rename]; }
  }
  await syncShapes(true, rename);
  const made = changes.filter((c) => c.action !== 'delete').map((c) => built.registry.get(shapePartId(c.def!.id))).filter(Boolean) as THREE.Object3D[];
  if (made.length) tree.selectObjects(made);
}

/** Apply accepted group changes (ancestor-covered members dropped, as the tree does). */
function applyGroupChanges(changes: { action: string; name: string; ids: string[] }[]) {
  for (const c of changes) {
    if (c.action === 'delete') { delete store.groups[c.name]; for (const f of Object.values(store.folders)) { const i = f.indexOf(c.name); if (i >= 0) f.splice(i, 1); } continue; }
    const cur = new Set(c.action === 'create' ? [] : store.groups[c.name] ?? []);
    if (c.action === 'remove') c.ids.forEach((x) => cur.delete(x)); else c.ids.forEach((x) => cur.add(x));
    const objs = [...cur].map((x) => built.registry.get(x)).filter(Boolean) as THREE.Object3D[];
    const covered = (o: THREE.Object3D) => { for (let p = o.parent; p; p = p.parent) if (objs.includes(p)) return true; return false; };
    store.groups[c.name] = objs.filter((o) => !covered(o)).map(idOfObj);
  }
  edit({ groups: JSON.parse(JSON.stringify(store.groups)), folders: JSON.parse(JSON.stringify(store.folders)) });
  tree.rebuild(); buildTimeline();
}
/** Apply accepted lock/hide changes like the tree's toggles (explicit flag, descendants inherit). */
/** Lock / hide / placement changes autosave into the active snapshot (like script and group edits);
 *  the snapshot bar's Save also records the camera, Save as… makes a new snapshot. */
function persistWorking() {
  const cur = store.snapshots[store.active] ?? { locked: {}, hidden: {} };
  store.snapshots[store.active] = { ...cur, locked: { ...state.locked }, hidden: { ...state.hidden }, placements: JSON.parse(JSON.stringify(state.placements)) };
  edit({ snapshots: { active: store.active, items: JSON.parse(JSON.stringify(store.snapshots)) } });
  markDirty(false);
}
async function applyStateChanges(changes: { ids: string[]; targets?: string[]; lock?: boolean; hide?: boolean; color?: string | null; remove?: boolean; keep_uncut?: boolean }[]) {
  for (const c of changes) if (c.keep_uncut !== undefined) setKeep(c.targets ?? c.ids, c.ids.map((x) => built.registry.get(x)).filter(Boolean) as THREE.Object3D[], c.keep_uncut);
  for (const c of changes) if (c.color !== undefined) setColors(c.targets ?? c.ids, c.color);
  for (const c of changes) if (c.remove !== undefined) await setRemoved(c.ids, c.remove);
  const touched: THREE.Object3D[] = [];
  for (const c of changes) for (const id of c.ids) {
    const o = built.registry.get(id); if (!o) continue;
    for (const [flag, v] of [['locked', c.lock], ['hidden', c.hide]] as const) {
      if (v === undefined) continue;
      o.traverse((dsc) => { const did = idOfObj(dsc); if (did && did !== id) delete state[flag][did]; });
      state[flag][id] = v;
    }
    touched.push(o);
  }
  for (const o of touched) await reconcile(o);
  persistWorking(); tree.redraw(); buildTimeline();
}

// ---------- proposal preview: play a proposed script without touching the editor ----------
let previewing: Proposal | undefined;
const previewBanner = document.createElement('div');
previewBanner.style.cssText = 'position: absolute;top:12px;left:50%;transform:translateX(-50%);z-index:7;background:#3a2a14;color:#f2b705;border:1px solid #f2b705;border-radius:6px;padding:5px 10px;font:600 12px system-ui;display:none;gap:8px;align-items:center';
host().appendChild(previewBanner);
function previewProposal(p: Proposal | undefined) {
  previewing = p;
  previewUnlocked = new Set(p ? resolveIds((p.unlock as string[] | undefined) ?? []).ids : []);
  const src = p ? String(p.text) : scriptPanel?.text ?? '';
  const doc = parseAnim(src);
  if (!doc.errors.length) { script = toActions(doc.steps); buildTimeline(); }
  if (p) { player.seek(0); player.playing = true; }
  previewBanner.style.display = p ? 'flex' : 'none';
  previewBanner.innerHTML = p ? `▶ Previewing proposal: ${p.summary.replace(/</g, '&lt;')} <button style="margin-left:8px">End preview</button>` : '';
  previewBanner.querySelector('button')?.addEventListener('click', () => previewProposal(undefined));
  assist?.refresh();
}

// ---------- AI assist: SolverKit's AssistPanel, mounted by the app (io.mountAssist) ----------
let chat: ChatMessage[] = migrateChat(model.chat);
let chatTimer: number | undefined;
const assistEl = document.createElement('div'); assistEl.id = 'assist';
right.appendChild(assistEl);
const client = assistClient(io.assist.base);
const assistHost: AssistHost = {
  status: io.assist.status,
  chat: () => chat,
  onChat: (c) => {
    chat = c;
    clearTimeout(chatTimer);
    chatTimer = window.setTimeout(() => edit({ chat: JSON.parse(JSON.stringify(c)) }), 300);
  },
  start: (history, signal, effort) => (async function* () {
    const context: Anthropic.ContentBlockParam[] = [{ type: 'text', text: await assistContext() }];
    yield* runAssist({ client, system: ASSIST_SYSTEM, history, context, tools, effort, signal });
  })(),
  script: () => scriptPanel?.text ?? '',
  previewing: () => (previewing ? String(previewing.text) : undefined),
  preview: (p) => previewProposal(p),
  insertCode: (code) => {
    if (!scriptPanel) return;
    const v = scriptPanel.view, l = v.state.doc.line(scriptPanel.cursorLine);
    v.dispatch({ changes: { from: l.to, insert: `\n${code.replace(/\n$/, '')}` } });
    showTab('script'); v.focus();
  },
  accept: async (p) => {
    if (p.kind === 'groups') { applyGroupChanges(p.changes as any); return; }
    if (p.kind === 'state') { await applyStateChanges(p.changes as any); return; }
    if (p.kind === 'shapes') { await applyShapeChanges(p.changes as ShapeChange[]); return; }
    if (p.kind === 'placement') { await applyPlacementChanges(p.changes as PlacementPlan[]); return; }
    if (p.kind !== 'script edit' || !scriptPanel) return;
    if (previewing) previewProposal(undefined);
    const unlock = (p.unlock as string[] | undefined) ?? [];
    if (unlock.length) await applyStateChanges([{ ids: resolveIds(unlock).ids, lock: false }]); // the script needs these movable
    scriptPanel.setText(String(p.text));
    showTab('script');
  },
};
const assist = io.mountAssist?.(assistEl, assistHost);
const showTab = (t: string) => {
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (scriptPanel) scriptPanel.el.style.display = t === 'script' ? '' : 'none';
  assistEl.style.display = t === 'assist' ? '' : 'none';
  gui.domElement.style.display = t === 'script' ? '' : 'none';
  illEl.style.display = t === 'illustration' ? '' : 'none';
};
tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => showTab(b.dataset.t!)));
{ const q = new URLSearchParams(location.search).get('tab'); showTab(q === 'animation' ? 'script' : q ?? (scriptPanel ? 'script' : 'assist')); }

async function assistContext() {
  const lines = (scriptPanel?.text ?? '').split('\n');
  const timing = player.tl.lines;
  const numbered = lines.map((l, i) => {
    const x = timing.get(i + 1);
    return `${String(i + 1).padStart(3)}${x ? ` [${x.start.toFixed(1)}–${x.end.toFixed(1)}s]` : ''} | ${l}`;
  }).join('\n');
  const sel = gSel.spec ?? (gSel.objs.length ? gSel.objs.map(idOfObj).join(', ') : 'nothing');
  // top of the assembly tree (the get_tree tool, depth 2)
  const gen = tools.find((t) => t.name === 'get_tree')!.run({ depth: 2 });
  let r = await gen.next(); while (!r.done) r = await gen.next();
  const tree = String(r.value.content);
  const errs = parseAnim(scriptPanel?.text ?? '').errors;
  const selBox = gSel.objs.length ? worldBox(gSel.objs) : undefined;
  const flagList = (f: Record<string, boolean>, v: boolean) => Object.entries(f).filter(([, x]) => x === v).map(([k]) => k);
  const hidden = flagList(state.hidden, true), unlocked = flagList(state.locked, false);
  return `<context>
Script file: scripts/${scriptName} (${player.duration.toFixed(1)} s)${errs.length ? `\nScript errors: ${errs.map((e) => `line ${e.line}: ${e.message}`).join('; ')}` : ''}
${numbered}

Current time: ${player.time.toFixed(2)} s${player.playing ? ' (playing)' : ' (paused)'}
Selection: ${sel}${selBox && !selBox.isEmpty() ? ` – bbox centre [${selBox.getCenter(new THREE.Vector3()).toArray().map((v) => v.toFixed(2))}], size [${selBox.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(2))}] m` : ''}
Camera views: ${Object.keys(views).map((v) => `${v} (pos [${views[v].pos.map((x) => x.toFixed(1))}], look [${views[v].look.map((x) => x.toFixed(1))}])`).join(', ') || 'none'}
Shapes: ${shapes.map((s) => `${s.id} (${s.kind} [${s.size}] at [${s.position}]${s.rotation.some((r) => r) ? ` rot [${s.rotation}]°` : ''}${s.array ? `, ×${s.array.count} ${s.array.type}` : ''})`).join(', ') || 'none'}
Groups: ${Object.entries(store.groups).map(([g, ids]) => { const f = Object.entries(store.folders).find(([, gs]) => gs.includes(g))?.[0]; return `@${g} (${ids.length} members${f ? `, folder ${f}` : ''})`; }).join(', ') || 'none'}
Snapshot: ${store.active}. Explicitly hidden: ${hidden.length ? hidden.slice(0, 20).join(', ') + (hidden.length > 20 ? ` … ${hidden.length - 20} more` : '') : 'none'}. Kept uncut by every cut: ${cutKeep.join(', ') || 'none'}. Placed away from their CAD position: ${Object.keys(state.placements).slice(0, 20).join(', ') || 'none'}. Unlocked (animatable) CAD: ${unlocked.length ? unlocked.slice(0, 20).join(', ') + (unlocked.length > 20 ? ' …' : '') : 'none – CAD is locked by default'}.

Assembly (top levels; use get_tree / find_parts for more):
${tree}
</context>`;
}

const rightToggle = document.createElement('button'); rightToggle.id = 'right-toggle'; rightToggle.textContent = '☰';
rightToggle.onclick = () => { right.classList.toggle('collapsed'); host().classList.toggle('right-collapsed'); };
host().appendChild(rightToggle);

// ---------- assembly tree + 3D picking ----------
const tree = new TreePanel(built, scene3, {
  onChange: async (objs, what) => {
    if (what === 'hidden') updateTools();
    for (const o of objs) await reconcile(o);
    persistWorking();
    if (what === 'locked') { buildTimeline(); gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs); }
  },
  onSelect: (o, spec, objs, clicked) => {
    gizmoFor(o, spec, objs);
    updateTools();
    refreshShapePanel();
    refreshCopyPanel();
    if (clicked && scriptPanel?.picking) scriptPanel.insertTarget(shortSpec(clicked.spec), clicked.add); // pick mode: into the script
  },
  colorOf: (spec) => colors[spec],
  modelColors,
  paletteKey: () => paletteKey,
  onPaletteKey: (hex) => { paletteKey = hex; edit({ view: { ...(model.view ?? {}), paletteKey: hex } }); },
  labelOf: (id) => labels[id],
  onLabel: (id, l) => {
    if (l) labels[id] = l; else delete labels[id];
    const o = built.registry.get(id); if (o) { if (l) o.userData.label = l; else delete o.userData.label; }
    edit({ labels: { ...labels } });
    tree.rebuild();
  },
  removedIds: () => [...removed],
  onRemove: (ids, rem) => setRemoved(ids, rem),
  onGroupRename: (from, to) => {
    // script lines using @from follow the new name (one undoable edit); so does a base colour
    if (scriptPanel) {
      const re = new RegExp(`@${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g');
      const next = scriptPanel.text.replace(re, `@${to}`);
      if (next !== scriptPanel.text) scriptPanel.setText(next);
    }
    if (colors[`@${from}`]) { colors[`@${to}`] = colors[`@${from}`]; delete colors[`@${from}`]; edit({ colors: { ...colors } }); }
  },
  onColor: (specs, hex) => setColors(specs, hex),
  keptOf: (o, group) => keptState(o, group),
  onKeep: (specs, objs, on) => setKeep(specs, objs, on),
  onDuplicate: () => void duplicateSelection(),
  onGroups: () => { buildTimeline(); edit({ groups: JSON.parse(JSON.stringify(store.groups)), folders: JSON.parse(JSON.stringify(store.folders)) }); }, // groups are part of the animation: saved at once
  stats: () => {
    const c = cad.stats(), r = renderer.info;
    return `GPU geometries ${r.memory.geometries} · drawn ${(r.render.triangles / 1e6).toFixed(2)}M tris · ${r.render.calls} calls` +
      (c.geometries ? `\nCAD meshes loaded ${c.geometries}` : '');
  },
});
const raycaster = new THREE.Raycaster();
let down = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // was a drag
  if ((gizmo as any).axis) return; // clicked the gizmo
  const ndc = new THREE.Vector2(((e.clientX - root.getBoundingClientRect().left) / W()) * 2 - 1, -((e.clientY - root.getBoundingClientRect().top) / H()) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(built.root, true).filter((h) =>
    (h.object as THREE.Mesh).isMesh && isShown(h.object) && !clipped(h.point));
  if (originPick) { if (hits[0]) originClick(hits[0]); return; }   // Set origin: the click picks geometry, not parts
  tree.pick(hits[0]?.object, e.metaKey || e.ctrlKey || e.shiftKey);
});
const isShown = (o: THREE.Object3D | null): boolean => !o || (o.visible && isShown(o.parent));
// ---------- window / crossing select: Shift-drag a box (left → right: wholly inside; right → left: inside or crossing) ----------
{
  const band = document.createElement('div');
  band.id = 'selbox';
  band.style.cssText = 'position:fixed;z-index:20;pointer-events:none;display:none;border:1px solid #4da3ff;background:rgba(77,163,255,.08)';
  document.body.appendChild(band);
  let start: { x: number; y: number; add: boolean } | null = null;
  const rectOf = (e: PointerEvent) => ({ l: Math.min(start!.x, e.clientX), t: Math.min(start!.y, e.clientY), r: Math.max(start!.x, e.clientX), b: Math.max(start!.y, e.clientY), crossing: e.clientX < start!.x });
  const move = (e: PointerEvent) => {
    if (!start) return;
    const r = rectOf(e);
    Object.assign(band.style, { display: '', left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px`,
      borderStyle: r.crossing ? 'dashed' : 'solid', borderColor: r.crossing ? '#3ecf8e' : '#4da3ff', background: r.crossing ? 'rgba(62,207,142,.08)' : 'rgba(77,163,255,.08)' });
  };
  const up = (e: PointerEvent) => {
    removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true);
    band.style.display = 'none';
    controls.enabled = true;
    if (!start) return;
    e.stopPropagation();                           // not a click-to-pick on the canvas
    const r = rectOf(e), add = start.add;
    start = null;
    if (r.r - r.l < 3 && r.b - r.t < 3) return;    // a click, not a box
    boxSelect(r, add);
  };
  // capture on the parent: before OrbitControls (Shift-drag would pan) and the click-to-pick handler see it
  renderer.domElement.parentElement!.addEventListener('pointerdown', (e) => {
    if (e.target !== renderer.domElement || !e.shiftKey || e.button !== 0 || originPick) return;
    e.stopPropagation(); e.preventDefault();
    start = { x: e.clientX, y: e.clientY, add: e.metaKey || e.ctrlKey };
    controls.enabled = false;
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true);
  }, true);
}
/** Select the shown parts (meshes) in a screen rectangle (client px). */
function boxSelect(r: { l: number; t: number; r: number; b: number; crossing: boolean }, add = false) {
  const c = renderer.domElement.getBoundingClientRect();
  const X = (x: number) => ((x - c.left) / c.width) * 2 - 1, Y = (y: number) => -((y - c.top) / c.height) * 2 + 1;
  const rect = { x0: X(r.l), x1: X(r.r), y0: Y(r.b), y1: Y(r.t) };
  const helper = gizmo.getHelper();
  const cands: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (!o.visible || o === helper) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && o.userData.id && built.registry.get(o.userData.id) === o && !Array.isArray(m.material) && (m.material as THREE.Material).side !== THREE.BackSide && !isRemoved(o)) cands.push(m);
    o.children.forEach(walk);
  };
  walk(built.root);
  built.root.updateMatrixWorld(true);
  const t0 = performance.now();
  const hits: THREE.Object3D[] = partsInRect(cands, camera, rect, r.crossing);
  console.info(`box select (${r.crossing ? 'crossing' : 'window'}): ${hits.length} of ${cands.length} parts, ${(performance.now() - t0).toFixed(0)} ms`);
  tree.selectObjects(add ? [...new Set([...gSel.objs, ...hits])] : hits);
  updateTools();
}
const clipped = (p: THREE.Vector3) => {
  const [a, b] = built.clipPlanes;
  return a.distanceToPoint(p) < 0 && b.distanceToPoint(p) < 0;
};

// ---------- snapshots: named model states (flags + camera + placements), explicit Save ----------
const camView = () => ({ pos: camera.position.toArray(), look: controls.target.toArray() });
async function loadSnapshot(name: string) {
  const snap: Snapshot | undefined = store.snapshots[name];
  if (!snap) return;
  player.seek(0);
  store.active = name;
  useSnapshot(snap);
  applyPlacements();
  for (const o of built.root.children) await reconcile(o);
  buildTimeline();
  if (snap.camera) {
    ui.followCamera = false; gui.controllersRecursive().forEach((c) => c.updateDisplay());
    camera.position.fromArray(snap.camera.pos); controls.target.fromArray(snap.camera.look);
  }
  gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs);
  tree.redraw();
  markDirty(false);
  renderSnapBar();
}
async function saveSnapshot(name: string) {
  edit({ view: { camera: camView(), time: player.time, mode: drawing.enabled ? (drawing.overlay ? 'outline' : 'hidden') : 'shaded', paletteKey } });
  store.snapshots[name] = captureSnapshot(camView());
  store.active = name;
  await writeStore();
  markDirty(false);
  renderSnapBar();
}
function renderSnapBar() {
  const bar = tree.snapBar;
  const names = Object.keys(store.snapshots).sort();
  bar.innerHTML = `<select title="Model snapshot">${names.map((n) => `<option ${n === store.active ? 'selected' : ''}>${n.replace(/</g, '&lt;')}</option>`).join('')}</select>
    <button data-a="save" title="Save to the current snapshot">Save</button><button data-a="saveas" title="Save as a new snapshot">Save as…</button>
    <button data-a="del" title="Delete this snapshot">✕</button><span class="dirty">${isDirty() ? '● unsaved' : ''}</span>`;
  const sel = bar.querySelector('select')!;
  sel.onchange = () => {
    if (isDirty() && !confirm(`Discard unsaved changes to "${store.active}"?`)) { sel.value = store.active; return; }
    loadSnapshot(sel.value);
  };
  bar.querySelector<HTMLElement>('[data-a=save]')!.onclick = () => saveSnapshot(store.active);
  bar.querySelector<HTMLElement>('[data-a=saveas]')!.onclick = () => {
    const n = prompt('Snapshot name', `${store.active} copy`)?.trim();
    if (n) saveSnapshot(n);
  };
  bar.querySelector<HTMLElement>('[data-a=del]')!.onclick = async () => {
    if (names.length < 2) return alert('Keep at least one snapshot.');
    if (!confirm(`Delete snapshot "${store.active}"?`)) return;
    delete store.snapshots[store.active];
    await writeStore();
    markDirty(false);
    loadSnapshot(Object.keys(store.snapshots).sort()[0]);
  };
}
onDirtyChange(() => { const d = tree.snapBar.querySelector('.dirty'); if (d) d.textContent = isDirty() ? '● unsaved' : ''; });
renderSnapBar();
{ // initial camera from the active snapshot
  const c = model.view?.camera ?? store.snapshots[store.active]?.camera;
  if (c) { ui.followCamera = false; camera.position.fromArray(c.pos); controls.target.fromArray(c.look); }
}
on('keydown', (e: any) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveSnapshot(store.active); }
});
on('beforeunload', (e: any) => { if (isDirty()) e.preventDefault(); });

// ---------- move / rotate gizmo: a part, a group (@name) or a multi-selection ----------
// t = 0  -> sets the start pose (snapshot placements)
// t > 0  -> written into the .anim script at the current step (split if mid-step)
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.8);
scene3.add(gizmo.getHelper());
const proxy = new THREE.Object3D(); proxy.name = '__gizmo_pivot'; scene3.add(proxy);
gizmoReady = true;

const worldBox = (objs: THREE.Object3D[]) => { const b = new THREE.Box3(); objs.forEach((o) => b.expandByObject(o)); return b; };
const resolveSpec = (spec: string): THREE.Object3D[] => spec.startsWith('@')
  ? (store.groups[spec.slice(1)] ?? []).map((id) => built.registry.get(id)).filter(Boolean) as THREE.Object3D[]
  : [built.registry.get(spec)].filter(Boolean) as THREE.Object3D[];
const probe: Probe = {
  centre: (spec) => worldBox(resolveSpec(spec)).getCenter(new THREE.Vector3()),
  quat: (spec) => resolveSpec(spec)[0]?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion(),
  opacity: (spec) => { let o = 1; resolveSpec(spec)[0]?.traverse((m) => { const mat = (m as THREE.Mesh).material as THREE.Material; if (mat && mat.userData.baseOpacity) o = mat.opacity / mat.userData.baseOpacity; }); return +o.toFixed(3); },
  camera: () => ({ pos: camera.position.toArray(), look: controls.target.toArray() }),
};

function gizmoFor(o?: THREE.Object3D, spec?: string, objs?: THREE.Object3D[]) {
  gSel = { spec, objs: objs ?? (o ? [o] : []) };
  const ok = gSel.objs.length > 0 && gSel.objs.every((x) => !isLocked(x)) && (player.time === 0 || isAnim);
  if (!ok) { gizmo.detach(); return; }
  if (gSel.objs.length === 1 && o && !spec?.startsWith('@')) { gizmo.attach(o); return; }
  // groups / multi-selection: gizmo on a pivot at the bounding-box centre
  scene3.updateMatrixWorld(true);
  proxy.position.copy(worldBox(gSel.objs).getCenter(new THREE.Vector3()));
  proxy.quaternion.identity();
  proxy.updateMatrixWorld(true);
  gizmo.attach(proxy);
}
gizmo.addEventListener('objectChange', () => {
  if (!drag || gizmo.object !== proxy) return;
  proxy.updateMatrixWorld(true);
  const D = proxy.matrixWorld.clone().multiply(drag.pivot.clone().invert());
  for (const m of drag.members) {
    const w = D.clone().multiply(m.world);
    const local = m.o.parent ? m.o.parent.matrixWorld.clone().invert().multiply(w) : w;
    local.decompose(m.o.position, m.o.quaternion, new THREE.Vector3());
  }
});
gizmo.addEventListener('dragging-changed', (e: any) => {
  controls.enabled = !e.value;
  if (e.value) {                                     // drag start: remember the pre-drag pose
    scene3.updateMatrixWorld(true);
    drag = {
      members: gSel.objs.map((o) => ({ o, world: o.matrixWorld.clone(), p: o.position.clone(), q: o.quaternion.clone() })),
      pivot: (gizmo.object === proxy ? proxy : gSel.objs[0]).matrixWorld.clone(),
    };
    return;
  }
  if (!drag) return;
  const d = drag; drag = undefined;
  scene3.updateMatrixWorld(true);
  const now = (gizmo.object === proxy ? proxy : gSel.objs[0]).matrixWorld;
  const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), p1 = new THREE.Vector3(), q1 = new THREE.Quaternion();
  d.pivot.decompose(p0, q0, new THREE.Vector3()); now.decompose(p1, q1, new THREE.Vector3());

  if (player.time > 1e-4 && isAnim && scriptPanel) {
    // script edit: put the parts back, describe the change as a step, recompile
    for (const m of d.members) { m.o.position.copy(m.p); m.o.quaternion.copy(m.q); }
    const target = gSel.spec ?? idOfObj(gSel.objs[0]);
    const edit: Edit = gizmo.mode === 'rotate'
      ? { target, kind: 'rotate', rot: q1.clone().multiply(q0.clone().invert()), mode: scriptPanel.mode }
      : { target, kind: 'move', delta: p1.clone().sub(p0), mode: scriptPanel.mode };
    const t = player.time;
    let doc = parseAnim(scriptPanel.text);
    let out: any = applyEdit(scriptPanel.text, doc, player.tl.lines, t, edit, probe);
    if (out?.pending) {                              // mid-step: split first, recompile, then edit the first half
      scriptPanel.setText(out.text);
      doc = parseAnim(out.text);
      player.seek(t);
      out = applyEdit(out.text, doc, player.tl.lines, t, edit, probe);
    }
    if (typeof out === 'string') scriptPanel.setText(out);
    player.seek(t);
    gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs);
    return;
  }
  // start pose: a shape's own numbers (position, rotation); other parts record placements
  let shapeMoved = false, copyMoved = false;
  for (const m of d.members) {
    const cdef = m.o.parent === copiesRoot ? copies.find((x) => x.id === m.o.userData.copy) : undefined;
    if (cdef) {
      cdef.position = m.o.position.toArray().map((v) => +v.toFixed(4));
      cdef.rotation = new THREE.Euler().setFromQuaternion(m.o.quaternion, 'XYZ').toArray().slice(0, 3).map((a) => +THREE.MathUtils.radToDeg(a as number).toFixed(3));
      m.o.userData.homeP = m.o.position.toArray(); m.o.userData.homeQ = m.o.quaternion.toArray();
      delete state.placements[idOfObj(m.o)];
      copyMoved = true;
      continue;
    }
    const def = m.o.userData.shape !== undefined && !m.o.userData.array ? shapes.find((x) => x.id === m.o.userData.shape) : undefined;
    if (def && m.o.parent === shapesRoot) {
      def.position = m.o.position.toArray().map((v) => +v.toFixed(4));
      def.rotation = new THREE.Euler().setFromQuaternion(m.o.quaternion, 'XYZ').toArray().slice(0, 3).map((a) => +THREE.MathUtils.radToDeg(a as number).toFixed(3));
      delete state.placements[idOfObj(m.o)];
      shapeMoved = true;
    } else state.placements[idOfObj(m.o)] = { p: m.o.position.toArray(), q: m.o.quaternion.toArray() };
  }
  if (shapeMoved) { void syncShapes(); refreshShapePanel(); }
  if (copyMoved) { edit({ copies: clone(copies) }); refreshCopyPanel(true); }
  persistWorking();
  buildTimeline();
});
on('keydown', (e: any) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).closest?.('.cm-editor')) return;
  if (e.key === 'w') gizmo.setMode('translate');
  if (e.key === 'H' && !e.metaKey && !e.ctrlKey) void blankOthers();
  if (e.key === 'f' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleFind(true); }
  if (e.key === 'h' && !e.metaKey && !e.ctrlKey) { tree.toggleHiddenSelected(); updateTools(); }
  if (e.key === 'd' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void duplicateSelection(); }
  if (e.key === 'g' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); tree.groupSelected(); updateTools(); }
  if (e.key === 'k' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleKeep(); }
  if (e.key === 'e') gizmo.setMode('rotate');
  if (e.key === 'Escape' && originPick) { endOrigin(); return; }
  if (e.key === 'Escape') { gizmo.detach(); tree.select(undefined, false); }
  if (e.key === 'r' && gizmo.object && player.time === 0) { // reset selection to its original placement
    for (const o of gSel.objs) { delete state.placements[idOfObj(o)]; o.position.fromArray(o.userData.homeP); o.quaternion.fromArray(o.userData.homeQ); }
    persistWorking(); buildTimeline(); gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs);
  }
});

on('keydown', (e: any) => { if (e.code === 'Space' && !(e.target as HTMLElement).closest?.('.cm-editor, input')) { e.preventDefault(); ui.play(); } });
{ const sel = new URLSearchParams(location.search).get('select'); if (sel) tree.selectId(sel); }
controls.addEventListener('start', () => { ui.followCamera = false; gui.controllersRecursive().forEach((c) => c.updateDisplay()); });
const ro = new ResizeObserver(() => {
  camera.aspect = W() / H();
  camera.updateProjectionMatrix();
  renderer.setSize(W(), H());
});
ro.observe(root);

const triad = new Triad();

// ---------- view toolbar (floating, top right of the viewport): style, standard views, PNG export ----------
const drawing = new DrawingMode(renderer, built.clipPlanes);
const caps = new SectionCaps(built.clipPlanes);
const glow = new OutlineGlow(built.clipPlanes);   // script `outline`: glows around parts
drawing.caps = caps;
const viewDirs: Record<string, [number, number, number]> = { iso: [1, 0.8, 1.1], front: [0, 0, 1], top: [0, 1, 0.0001], side: [1, 0, 0] };
function viewFrom(dir: [number, number, number]) {
  const b = new THREE.Box3();
  built.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && isShown(o) && (o as THREE.Mesh).geometry?.attributes?.position) b.expandByObject(o); });
  if (b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() / 2;
  ui.followCamera = false; gui.controllersRecursive().forEach((x) => x.updateDisplay());
  camera.position.copy(c).addScaledVector(new THREE.Vector3(...dir).normalize(), r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05);
  camera.up.set(0, 1, 0);
  controls.target.copy(c);
  camera.near = Math.max(0.005, r / 5000); camera.far = r * 20; camera.updateProjectionMatrix(); // log depth: a small near is fine
  controls.update();
}
let lastView = 'view';
/** Vector line drawing of the current view (src/drawing). */
function vectorDrawing(opt: DrawingOptions = {}) {
  const r = makeDrawing(scene3, camera, { exclude: [gizmo.getHelper()], title: scriptName, titleBlock: { title: model.name }, ...opt });
  console.info('drawing', r.stats);
  return r;
}
// ---------- drawing sheets (Illustration tab: the .draw script) ----------
const SHEET_VIEWS: Record<string, [number, number, number]> = { iso: [1, 0.8, 1.1], front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0], bottom: [0, -1, 0], side: [1, 0, 0], right: [1, 0, 0], left: [-1, 0, 0] };
const drawingsFolder = () => `Drawings/${(model.name ?? 'animation').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'animation'}`;
/** Draw one sheet: set its view and pose, draw, then put the studio back as it was. */
interface SheetCtx { spec: SheetSpec; cam: THREE.PerspectiveCamera; hide: THREE.Object3D[]; only?: THREE.Object3D[]; err(message: string): void }
/** Pose the studio for a sheet (snapshot, time, cut, hide/only), run `body` synchronously, then restore the studio. */
async function withSheet<T>(name: string, body: (c: SheetCtx) => T): Promise<{ out: T; errors: { line: number; message: string }[]; spec: SheetSpec } | null> {
  const parsed = drawPanel!.parsed;
  const s0 = parsed.sheets.find((x) => x.name === name);
  if (!s0) return null;
  const spec = withDefaults(s0, parsed.defaults);
  const errors: { line: number; message: string }[] = [];
  const err = (message: string) => errors.push({ line: spec.line, message });
  // view direction (orthographic)
  const v = spec.view ?? 'iso';
  let dir = new THREE.Vector3(...SHEET_VIEWS.iso);
  if (Array.isArray(v)) dir.set(...v);
  else if (SHEET_VIEWS[v]) dir.set(...SHEET_VIEWS[v]);
  else if (views[v]) dir.fromArray(views[v].pos).sub(new THREE.Vector3().fromArray(views[v].look));
  else err(`view: no view "${v}" (iso, front, back, top, bottom, side, left, right, or a saved view: ${Object.keys(views).join(', ') || 'none saved'})`);
  if (dir.lengthSq() < 1e-12) { err('view: the direction is zero'); dir.set(...SHEET_VIEWS.iso); }
  dir.normalize();
  const cam = new THREE.PerspectiveCamera();
  cam.up.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.999) cam.up.set(0, 0, -Math.sign(dir.y)); // plan views: north (−z) up
  cam.position.copy(dir); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();

  const t0 = player.time, playing = player.playing, dirty = isDirty();
  player.playing = false;
  let saved: Snapshot | null = null;
  const pose = async (snap: Snapshot) => { player.seek(0); useSnapshot(snap); applyPlacements(); for (const o of built.root.children) await reconcile(o); buildTimeline(); };
  try {
    if (spec.snapshot !== undefined) {
      const snap = store.snapshots[spec.snapshot];
      if (!snap) err(`snapshot: no snapshot "${spec.snapshot}" (${Object.keys(store.snapshots).join(', ')})`);
      else { saved = captureSnapshot(camView()); await pose(snap); }
    }
    let t = 0;
    if (typeof spec.at === 'number') t = Math.min(spec.at, player.duration);
    else if (typeof spec.at === 'string') {
      const step = player.tl.steps.find((x) => x.kind === 'label' && x.value === spec.at);
      if (step) t = step.t; else err(`at: no chapter "${spec.at}" in the animation`);
    }
    // everything from here to the drawing is synchronous: no frame can change the pose in between
    player.seek(t);
    applyCut(spec.cut ?? ((player.current('cutaway')?.value ?? 'none') as Cut | CutMode));
    const objs = (specs: string[], what: string) => {
      const named = specs.filter((x) => x.startsWith('~')).flatMap((x) => { const o = partsNamed(x.slice(1)); if (!o.length) err(`${what}: nothing named "${x.slice(1)}"`); return o; });
      const r = resolveIds(specs.filter((x) => !x.startsWith('~')));
      if (r.unknown.length) err(`${what}: unknown ${r.unknown.join(', ')}`);
      return [...r.ids.map((id) => built.registry.get(id)!).filter(Boolean), ...named];
    };
    const hide = objs(spec.hide, 'hide'), only = spec.only.length ? objs(spec.only, 'only') : undefined;
    return { out: body({ spec, cam, hide, only, err }), errors, spec };
  } finally {
    if (saved) await pose(saved);
    markDirty(dirty);
    player.seek(Math.min(t0, player.duration)); player.playing = playing;
  }
}
/** The exact drawing of a sheet (SVG). */
async function runSheet(name: string): Promise<{ svg: string; stats: Record<string, number>; errors: { line: number; message: string }[]; spec: SheetSpec } | null> {
  const r = await withSheet(name, ({ spec, cam, hide, only, err }) => {
    const d = makeDrawing(scene3, cam, {
      exclude: [gizmo.getHelper(), ...hide], only, title: spec.title ?? spec.name,
      paper: (spec.paper ?? 'A3') as DrawingOptions['paper'], portrait: spec.portrait, scale: spec.scale || undefined, hidden: spec.hidden, creaseDeg: spec.crease, hatch: spec.hatch, fill: spec.fill,
      titleBlock: spec.titleblock === false ? false : { title: spec.title ?? spec.name },
    });
    if (spec.scale && !d.scale) err('scale: only orthographic views have a scale');
    return d;
  });
  return r && { svg: r.out.svg, stats: r.out.stats, errors: r.errors, spec: r.spec };
}
/** The fast raster sheet (PNG): one GPU frame in the sheet's style, on the paper with border and title box. */
async function renderSheetPng(name: string): Promise<{ png: Blob; canvas: HTMLCanvasElement; ms: number; errors: { line: number; message: string }[]; spec: SheetSpec } | null> {
  const t0 = performance.now();
  const r = await withSheet(name, ({ spec, cam, hide, only, err }) => {
    const style = spec.style ?? 'outline';
    // the parts drawn: visible meshes under `only` (or everything), minus `hide` and the gizmo
    const skip = new Set<THREE.Object3D>([gizmo.getHelper(), ...hide]);
    const drawn: THREE.Mesh[] = [];
    const walk = (o: THREE.Object3D) => {
      if (!o.visible || skip.has(o)) return;
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry?.attributes?.position && !Array.isArray((o as THREE.Mesh).material) && ((o as THREE.Mesh).material as THREE.Material).side !== THREE.BackSide) drawn.push(o as THREE.Mesh);
      o.children.forEach(walk);
    };
    (only ?? [built.root]).forEach(walk);
    // frame: the parts' bounds in view space (each mesh's box corners; the pose was just set, so update the matrices)
    scene3.updateMatrixWorld();
    const inv = cam.matrixWorld.clone().invert(), b = new THREE.Box3(), v = new THREE.Vector3();
    // a half cut (an axis plane) trims each cut part's world box to the side kept, as the exact drawing frames what's left
    const half = capUniforms.cutActive.value === 1 ? built.clipPlanes[0] : null;
    const wb = new THREE.Box3();
    for (const o of drawn) {
      const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
      wb.copy(g.boundingBox!).applyMatrix4(o.matrixWorld);
      const mats = (o.material as THREE.Material).clippingPlanes;
      if (half && mats?.length && !o.userData.uncut) {
        const nrm = half.normal, ax = Math.abs(nrm.x) > 0.5 ? 'x' : Math.abs(nrm.y) > 0.5 ? 'y' : 'z', sg = Math.sign(nrm[ax]), at = -half.constant / nrm[ax];
        if (sg > 0) wb.min[ax] = Math.max(wb.min[ax], at); else wb.max[ax] = Math.min(wb.max[ax], at);   // kept where normal·p + constant ≥ 0
        if (wb.isEmpty()) continue;
      }
      for (let i = 0; i < 8; i++) b.expandByPoint(v.set(i & 1 ? wb.max.x : wb.min.x, i & 2 ? wb.max.y : wb.min.y, i & 4 ? wb.max.z : wb.min.z).applyMatrix4(inv));
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const opt = { paper: (spec.paper ?? 'A3') as keyof typeof PAPER, portrait: spec.portrait, titleBlock: spec.titleblock === false ? false as const : {} };
    const { W, H, m: margin, area } = layout(opt);
    const sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const k = spec.scale ? 1000 / spec.scale : fitScale(opt, sz.x * 1.02, sz.y * 1.02);   // mm per metre (exact: 2 % margin around the frame)
    // pixels: the paper at `dpi`, lowered to what the GPU can hold
    let dpi = spec.dpi ?? 150;
    const maxPx = Math.min(renderer.capabilities.maxTextureSize, 8192);
    const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
    if (Math.max(aw, ah) * dpi / 25.4 > maxPx) { const d2 = Math.floor(maxPx * 25.4 / Math.max(aw, ah)); err(`dpi: ${dpi} is more than the GPU can draw at ${spec.paper ?? 'A3'} – used ${d2}`); dpi = d2; }
    const px = dpi / 25.4, rw = Math.round(aw * px), rh = Math.round(ah * px);
    // an orthographic camera over the drawing area, far enough back that depth (and the line pass's thresholds) behave
    const hw = aw / 2 / k, hh = ah / 2 / k, depth = Math.max(sz.z, 1e-3), back = depth + Math.max(hw, hh);
    const o = new THREE.OrthographicCamera(-hw, hw, hh, -hh, back - depth - 0.01 * depth, back + 0.01 * depth + 1e-3);
    o.quaternion.copy(cam.quaternion);
    o.position.set(c.x, c.y, b.max.z + (back - depth)).applyMatrix4(cam.matrixWorld);
    o.updateMatrixWorld(); o.updateProjectionMatrix();
    // render: the canvas resized, transparent background (no grids), the sheet's style; everything put back after
    const save = { enabled: drawing.enabled, overlay: drawing.overlay, pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()), bg: scene3.background,
      sil: drawing.silThickness, th: drawing.thickness, gizmo: gizmo.getHelper().visible };
    const hidden: THREE.Object3D[] = [];
    scene3.traverse((x) => { if (((x as THREE.GridHelper).type === 'GridHelper' || skip.has(x) || (only && (x as THREE.Mesh).isMesh && !only.some((y) => y === x || isAncestor(y, x)))) && x.visible) { hidden.push(x); x.visible = false; } });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * px); canvas.height = Math.round(H * px);
    try {
      drawing.enabled = style !== 'shaded'; drawing.overlay = style === 'outline';
      drawing.silThickness = Math.min(7, 0.5 * px); drawing.thickness = Math.min(7, 0.25 * px);   // ISO weights in mm
      if (drawing.enabled) drawing.collectDecor(scene3, [gizmo.getHelper()]);
      gizmo.getHelper().visible = false;
      renderer.setPixelRatio(1); renderer.setSize(rw, rh, false);
      scene3.background = null; renderer.setClearColor(0x000000, 0); drawing.transparentBg = true;
      drawFrame(o);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(renderer.domElement, Math.round(area.x0 * px), Math.round(area.y0 * px));
      // border and title box, as in the SVG
      g.strokeStyle = '#000'; g.lineWidth = 0.7 * px; g.strokeRect(margin / 2 * px, margin / 2 * px, (W - margin) * px, (H - margin) * px);
      if (spec.titleblock !== false) {
        const scale = spec.scale ? `1:${spec.scale}` : 'NTS', tb = titleBox(W, H, margin, spec.title ?? spec.name, scale);
        g.fillStyle = '#fff'; g.fillRect(tb.x * px, tb.y * px, tb.w * px, tb.h * px);
        g.lineWidth = 0.5 * px; g.strokeRect(tb.x * px, tb.y * px, tb.w * px, tb.h * px);
        g.fillStyle = '#000'; g.textBaseline = 'alphabetic';
        g.font = `bold ${4 * px}px Helvetica, Arial, sans-serif`; g.textAlign = 'left'; g.fillText(spec.title ?? spec.name, (tb.x + 3) * px, (tb.y + 7.4) * px);
        g.font = `${2.5 * px}px Helvetica, Arial, sans-serif`; g.textAlign = 'right'; g.fillText(scale, (tb.x + tb.w - 3) * px, (tb.y + 7.4) * px);
      }
    } finally {
      hidden.forEach((x) => (x.visible = true));
      scene3.background = save.bg; drawing.transparentBg = false;
      gizmo.getHelper().visible = save.gizmo;
      drawing.enabled = save.enabled; drawing.overlay = save.overlay; drawing.silThickness = save.sil; drawing.thickness = save.th;
      if (drawing.enabled) drawing.collectDecor(scene3, [gizmo.getHelper()]);
      renderer.setPixelRatio(save.pr); renderer.setSize(save.size.x, save.size.y, false);
    }
    return canvas;
  });
  if (!r) return null;
  const png = await new Promise<Blob>((res, rej) => r.out.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  return { png, canvas: r.out, ms: performance.now() - t0, errors: r.errors, spec: r.spec };
}
const isAncestor = (a: THREE.Object3D, b: THREE.Object3D) => { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; };
const progress = new ProgressSplash(() => host());
// ---------- sheet preview: fast PNGs of every sheet, a strip of thumbnails, the chosen one full size ----------
interface SheetImg { url: string; ms: number; errors: { line: number; message: string }[]; spec: SheetSpec }
let previewEl: HTMLElement | undefined, previewCur: string | undefined;
const sheetImgs = new Map<string, SheetImg>();
function closePreview() {
  clearTimeout(liveTimer);
  previewEl?.remove(); previewEl = undefined; previewCur = undefined;
  for (const x of sheetImgs.values()) URL.revokeObjectURL(x.url);
  sheetImgs.clear();
}
function ensurePreviewEl() {
  if (previewEl) return previewEl;
  previewEl = document.createElement('div'); previewEl.id = 'sheet-preview';
  previewEl.innerHTML = `<header><b></b><span class="info"></span><button data-a="png" title="This sheet's PNG (fast render)">⤓ PNG</button>
    <button data-a="dl" title="The exact line drawing (hidden-line removal from the geometry; takes longer)">⤓ SVG</button><button data-a="pdf" title="The exact drawing as a vector PDF">⤓ PDF</button><button data-a="close">✕ Close</button></header>
    <div class="page"><img alt="sheet"></div><div class="strip"></div>`;
  previewEl.querySelector<HTMLElement>('[data-a=close]')!.onclick = closePreview;
  const fileOf = () => sheetImgs.get(previewCur!)?.spec.file ?? previewCur!;
  const download = (url: string, name: string) => { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };
  previewEl.querySelector<HTMLElement>('[data-a=png]')!.onclick = () => { const x = sheetImgs.get(previewCur!); if (x) download(x.url, `${fileOf()}.png`); };
  // SVG / PDF: the exact drawing, made on demand
  const exact = async (pdf: boolean) => {
    const name = previewCur!, fn = fileOf();
    await progress.start(`Exact drawing “${name}”`, 'Hidden-line removal from the geometry…');
    try {
      const r = await runSheet(name);
      if (!r) return;
      drawPanel!.setRunErrors(r.errors);
      let blob = new Blob([r.svg], { type: 'image/svg+xml' });
      if (pdf) { await progress.step('Converting to a vector PDF…', 0.8); blob = await svgToPdf(r.svg, r.spec.title ?? name); }
      const u = URL.createObjectURL(blob); download(u, `${fn}.${pdf ? 'pdf' : 'svg'}`); setTimeout(() => URL.revokeObjectURL(u), 1000);
    } finally { progress.done(); }
  };
  previewEl.querySelector<HTMLElement>('[data-a=dl]')!.onclick = () => void exact(false);
  previewEl.querySelector<HTMLElement>('[data-a=pdf]')!.onclick = () => void exact(true);
  host().appendChild(previewEl);
  return previewEl;
}
/** Show `name` full size and mark it in the strip. */
function showSheet(name: string) {
  const el = ensurePreviewEl(), x = sheetImgs.get(name);
  previewCur = name;
  el.querySelectorAll<HTMLElement>('.strip .th').forEach((t) => t.classList.toggle('on', t.dataset.s === name));
  if (!x) return;
  el.querySelector('b')!.textContent = x.spec.title ?? name;
  const paper = `${x.spec.paper ?? 'A3'} ${x.spec.portrait ? 'portrait' : 'landscape'}, ${x.spec.scale ? `1:${x.spec.scale}` : 'fit'}, ${x.spec.style ?? 'outline'}`;
  el.querySelector('.info')!.textContent = `${paper} · ${Math.round(x.ms)} ms${x.errors.length ? ` · ${x.errors.length} problem(s), see the script` : ''}`;
  el.querySelector<HTMLImageElement>('.page img')!.src = x.url;
}
/** The strip: one thumbnail per sheet in the script, in order (missing images show as blank). */
function syncStrip() {
  const strip = ensurePreviewEl().querySelector<HTMLElement>('.strip')!;
  const names = drawPanel!.parsed.sheets.map((x) => x.name);
  strip.replaceChildren(...names.map((n) => {
    const t = document.createElement('button'); t.className = 'th'; t.dataset.s = n; t.title = n;
    const x = sheetImgs.get(n);
    t.innerHTML = `<img alt=""><span></span>`;
    if (x) t.querySelector('img')!.src = x.url;
    t.querySelector('span')!.textContent = n;
    t.classList.toggle('on', n === previewCur); t.classList.toggle('bad', !!x?.errors.length);
    t.onclick = () => showSheet(n);
    return t;
  }));
}
/** Fast-render one sheet into the preview (replacing its image). */
async function renderIntoPreview(name: string): Promise<{ png: Blob; spec: SheetSpec; errors: { line: number; message: string }[] } | null> {
  const r = await renderSheetPng(name);
  if (!r) return null;
  const old = sheetImgs.get(name);
  if (old) URL.revokeObjectURL(old.url);
  sheetImgs.set(name, { url: URL.createObjectURL(r.png), ms: r.ms, errors: r.errors, spec: r.spec });
  return { png: r.png, spec: r.spec, errors: r.errors };
}
/** Live preview: while the preview is open, re-render the cursor's sheet ~300 ms after typing stops (not saved). */
let liveTimer = 0, liveBusy = false, liveAgain = false;
function liveSheet() {
  if (!previewEl) return;
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(async () => {
    if (liveBusy || progress.active) { liveAgain = true; if (!liveBusy) liveSheet(); return; }
    const name = drawPanel!.sheetAtCursor();
    if (!name || !previewEl) return;
    liveBusy = true;
    try {
      const r = await renderIntoPreview(name);
      if (!previewEl) return;
      syncStrip();
      if (r) { showSheet(name); drawPanel!.setRunErrors(r.errors); }
    } finally {
      liveBusy = false;
      if (liveAgain) { liveAgain = false; liveSheet(); }
    }
  }, 300);
}
/** Preview: fast PNGs of every sheet (saved to the vault), the strip, and `focus` (the cursor's sheet) full size. */
async function previewSheet(focus: string, save = true) {
  const sheets = drawPanel!.parsed.sheets;
  if (!sheets.length) return;
  const N = sheets.length, errors: { line: number; message: string }[] = [];
  drawPanel!.busy(`Rendering ${N} sheet${N === 1 ? '' : 's'}…`);
  await progress.start(`Preview ${N} sheet${N === 1 ? '' : 's'}`, '');
  try {
    // the focused sheet first, so it shows while the rest render
    const order = [focus, ...sheets.map((x) => x.name).filter((n) => n !== focus)].filter((n) => sheets.some((x) => x.name === n));
    for (const [i, n] of order.entries()) {
      await progress.step(`Rendering ${n} (${i + 1} of ${N})…`, i / N);
      const r = await renderIntoPreview(n);
      if (!r) continue;
      errors.push(...r.errors);
      if (i === 0) { syncStrip(); showSheet(n); } else syncStrip();
      if (save && io.files) await io.files.upload(`${drawingsFolder()}/${r.spec.file ?? n}.png`, new File([r.png], `${r.spec.file ?? n}.png`, { type: 'image/png' }), undefined, true);
    }
    await progress.step('Done', 1);
  } finally { drawPanel!.busy(null); progress.done(); }
  drawPanel!.setRunErrors(errors);
  if (!errors.length) drawPanel!.setStatus(save && io.files ? `Previewed ${N} sheet${N === 1 ? '' : 's'} · PNGs in ${drawingsFolder()}/` : `Previewed ${N} sheet${N === 1 ? '' : 's'}`);
}
/** Draw every sheet (or the named ones) and save <sheet>.svg and .pdf into the vault's Drawings/<animation>/. */
async function saveAllSheets(only?: string[]): Promise<{ saved: string[]; errors: { line: number; message: string }[] }> {
  const errors: { line: number; message: string }[] = [], saved: string[] = [];
  const sheets = drawPanel!.parsed.sheets.filter((x) => !only?.length || only.includes(x.name));
  for (const n of only ?? []) if (!drawPanel!.parsed.sheets.some((x) => x.name === n)) errors.push({ line: 0, message: `no sheet "${n}"` });
  if (drawPanel!.parsed.errors.length) errors.push(...drawPanel!.parsed.errors);
  if (!sheets.length) { drawPanel!.setStatus('No sheets to save', true); return { saved, errors }; }
  if (!io.files) { drawPanel!.setStatus('No vault access', true); return { saved, errors: [...errors, { line: 0, message: 'no vault access' }] }; }
  const N = sheets.length, at = (i: number, f: number) => (i + f) / N;
  await progress.start(`Saving ${N} sheet${N === 1 ? '' : 's'}`, '');
  try {
    for (const [i, sh] of sheets.entries()) {
      drawPanel!.busy(`Drawing ${sh.name} (${i + 1} of ${sheets.length})…`);
      await progress.step(`Drawing ${sh.name} (${i + 1} of ${N})…`, at(i, 0));
      const r = await runSheet(sh.name);
      if (!r) continue;
      errors.push(...r.errors);
      const fn = r.spec.file ?? sh.name, base = `${drawingsFolder()}/${fn}`;
      await progress.step(`Saving ${fn}.svg (${i + 1} of ${N})…`, at(i, 0.7));
      await io.files.upload(`${base}.svg`, new File([r.svg], `${fn}.svg`, { type: 'image/svg+xml' }), undefined, true);
      drawPanel!.busy(`Writing ${sh.name}.pdf (${i + 1} of ${sheets.length})…`);
      await progress.step(`Writing ${fn}.pdf (${i + 1} of ${N})…`, at(i, 0.8));
      const pdf = await svgToPdf(r.svg, r.spec.title ?? sh.name);
      await io.files.upload(`${base}.pdf`, new File([pdf], `${fn}.pdf`, { type: 'application/pdf' }), undefined, true);
      await progress.step(`Rendering ${fn}.png (${i + 1} of ${N})…`, at(i, 0.9));
      const img = await renderSheetPng(sh.name);
      if (img) await io.files.upload(`${base}.png`, new File([img.png], `${fn}.png`, { type: 'image/png' }), undefined, true);
      saved.push(`${base}.svg`, `${base}.pdf`);
      await progress.step(`Saved ${sh.name} (${i + 1} of ${N})`, at(i, 1));
    }
  } finally { drawPanel!.busy(null); progress.done(); }
  drawPanel!.setRunErrors(errors.filter((e) => e.line > 0));
  if (!errors.length) drawPanel!.setStatus(`Saved ${saved.length / 2} sheet${saved.length === 2 ? '' : 's'} (SVG + PDF) to ${drawingsFolder()}/`);
  return { saved, errors };
}
async function exportSvg(opt: DrawingOptions = {}) {
  await progress.start('Export SVG', 'Drawing hidden lines for the current view…');
  let svg: string;
  try { svg = vectorDrawing(opt).svg; await progress.step('Writing the file…', 1); } finally { progress.done(); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = `${scriptName.replace(/\.\w+$/, '')}-${lastView}-t${player.time.toFixed(1)}s.svg`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportPng() {
  const pr = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.min(4, pr * 2)); // 2× resolution
  renderer.setSize(W(), H(), false);
  // transparent background: no scene background or ground grid, clear to alpha 0
  const bg = scene3.background, grids: THREE.Object3D[] = [];
  scene3.traverse((o) => { if ((o as THREE.GridHelper).type === 'GridHelper' && o.visible) { grids.push(o); o.visible = false; } });
  scene3.background = null; renderer.setClearColor(0x000000, 0); drawing.transparentBg = true;
  drawFrame();
  const url = renderer.domElement.toDataURL('image/png');
  scene3.background = bg; grids.forEach((o) => (o.visible = true)); drawing.transparentBg = false;
  renderer.setPixelRatio(pr); renderer.setSize(W(), H(), false);
  const a = document.createElement('a');
  a.href = url; a.download = `${scriptName.replace(/\.\w+$/, '')}-${drawing.enabled ? (drawing.overlay ? 'shaded-outline' : 'hidden-line') : 'shaded'}-${lastView}-t${player.time.toFixed(1)}s.png`;
  a.click();
}
{
  const css = document.createElement('style');
  css.textContent = `#viewbar { position: absolute; top: 8px; right: 468px; z-index: 7; display: flex; gap: 4px; padding: 4px; background: rgba(14,17,21,.9); border: 1px solid #2b3540; border-radius: 6px; font: 12px system-ui; }
    #viewbar { flex-wrap: wrap; justify-content: flex-end; max-width: calc(100% - 396px - 476px); }
    .studio-root.tree-collapsed #viewbar { max-width: calc(100% - 56px - 476px); }
    .studio-root.right-collapsed #viewbar { right: 48px; max-width: calc(100% - 396px - 56px); }
    .studio-root.right-collapsed.tree-collapsed #viewbar { max-width: calc(100% - 112px); }
    .studio-root.paper #chapter { color: #111 !important; } .studio-root.paper #sub, .studio-root.paper #clock { color: #555 !important; }
    #viewbar .grp { display: flex; } #viewbar .sep { width: 1px; background: #2b3540; margin: 0 4px; }
    #viewbar button { background: #1b222a; color: #d7dde4; border: 1px solid #2b3540; padding: 3px 8px; cursor: pointer; font: inherit; }
    #viewbar .grp button + button { border-left: 0; } #viewbar .grp button:first-child { border-radius: 4px 0 0 4px; } #viewbar .grp button:last-child { border-radius: 0 4px 4px 0; }
    #viewbar button.on { background: #f2b705; color: #111; border-color: #f2b705; } #viewbar button:hover:not(.on) { background: #26303a; }
    #viewbar { position: absolute; } #viewbar > button { border-radius: 4px; }
    #viewbar .pop { position: absolute; top: calc(100% + 6px); right: 0; width: 260px; background: rgba(14,17,21,.97); border: 1px solid #2b3540; border-radius: 6px; padding: 8px 10px; color: #d7dde4; display: flex; flex-direction: column; gap: 6px; }
    #viewbar .pop[hidden] { display: none; }
    #viewbar .pop label { display: grid; grid-template-columns: 1fr 100px 36px; align-items: center; gap: 6px; font-size: 11px; }
    #viewbar .pop input[type=color] { grid-column: 2 / 4; width: 100%; height: 20px; background: none; border: 1px solid #2b3540; padding: 0; }
    #viewbar .pop span { color: #9aa6b2; text-align: right; font: 11px ui-monospace, monospace; }`;
  document.head.appendChild(css);
  const bar = document.createElement('div'); bar.id = 'viewbar';
  bar.innerHTML = `<div class="grp"><button data-m="shaded" class="on" title="Shaded (cel) view">Shaded</button><button data-m="outline" title="Shaded + outline: the cel-shaded view with the hidden-line edges drawn over it">Shaded + outline</button><button data-m="hidden" title="Hidden line: visible edges only, black on white">Hidden line</button></div>
    <div class="sep"></div>
    <div class="grp"><button data-v="iso">Iso</button><button data-v="front">Front</button><button data-v="top">Top</button><button data-v="side">Side</button><button data-v="fit" title="Fit everything visible in the current direction">Fit</button></div>
    <div class="sep"></div>
    <button data-a="png" title="Save the view as a PNG at 2× resolution, with a transparent background">⤓ PNG</button>
    <button data-a="cfg" title="Hidden-line settings">⚙</button>
    <div class="pop" hidden>
      <label>Silhouette weight <input type="range" data-k="sil" min="0.5" max="6" step="0.25"><span></span></label>
      <label>Edge weight <input type="range" data-k="thickness" min="0.5" max="6" step="0.25"><span></span></label>
      <label>Crease angle <input type="range" data-k="angle" min="5" max="90" step="1"><span></span></label>
      <label>Outline sensitivity <input type="range" data-k="depth" min="1" max="20" step="1"><span></span></label>
      <label>Line colour <input type="color" data-k="line"></label>
      <label>Paper colour <input type="color" data-k="paper"></label>
      <button data-a="reset">Reset</button>
    </div>`;
  host().appendChild(bar);
  const setMode = (m: string) => {
    drawing.enabled = m === 'hidden' || m === 'outline';
    drawing.overlay = m === 'outline';
    host().classList.toggle('paper', m === 'hidden');
    if (drawing.enabled) drawing.collectDecor(scene3, [gizmo.getHelper()]);
    bar.querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  };
  bar.querySelectorAll<HTMLElement>('[data-m]').forEach((b) => (b.onclick = () => setMode(b.dataset.m!)));
  bar.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => (b.onclick = () => {
    const v = b.dataset.v!;
    if (v === 'fit') viewFrom(camera.position.clone().sub(controls.target).normalize().toArray() as [number, number, number]);
    else { lastView = v; viewFrom(viewDirs[v]); }
  }));
  bar.querySelector<HTMLElement>('[data-a=png]')!.onclick = exportPng;

  // hidden-line settings (remembered in this browser)
  const DEF = { sil: 2.5, thickness: 1.25, angle: 41, depth: 4, line: '#111111', paper: '#ffffff' };
  let cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('hiddenLine') ?? '{}')); } catch { /* storage unavailable */ }
  const pop = bar.querySelector<HTMLElement>('.pop')!;
  const apply = () => {
    drawing.thickness = cfg.thickness; drawing.silThickness = cfg.sil;
    drawing.normalThreshold = 1 - Math.cos(THREE.MathUtils.degToRad(cfg.angle));
    drawing.depthThreshold = cfg.depth / 1000;
    drawing.lineColor.set(cfg.line); drawing.paperColor.set(cfg.paper);
    pop.querySelectorAll<HTMLInputElement>('input').forEach((i) => {
      const v = (cfg as any)[i.dataset.k!]; i.value = String(v);
      const out = i.nextElementSibling as HTMLElement | null;
      if (out?.tagName === 'SPAN') out.textContent = i.dataset.k === 'angle' ? `${v}°` : i.dataset.k === 'thickness' || i.dataset.k === 'sil' ? `${v}px` : String(v);
    });
    try { localStorage.setItem('hiddenLine', JSON.stringify(cfg)); } catch { /* ignore */ }
  };
  pop.querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.oninput = () => {
    (cfg as any)[i.dataset.k!] = i.type === 'range' ? Number(i.value) : i.value;
    if (!drawing.enabled) setMode('hidden'); // show the effect while adjusting
    apply();
  }));
  pop.querySelector<HTMLElement>('[data-a=reset]')!.onclick = () => { cfg = { ...DEF }; apply(); };
  bar.querySelector<HTMLElement>('[data-a=cfg]')!.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
  pop.onclick = (e) => e.stopPropagation();
  on('click', () => (pop.hidden = true));
  pop.onkeydown = (e) => e.stopPropagation();
  apply();
  if (new URLSearchParams(location.search).has('viewcfg')) pop.hidden = false;
  const m = new URLSearchParams(location.search).get('mode'); if (m) setMode(m);
  const v = new URLSearchParams(location.search).get('view'); if (v && viewDirs[v]) { lastView = v; requestAnimationFrame(() => viewFrom(viewDirs[v])); }
}

/** One frame of the main view in the current style (+ gizmo on top in drawing mode). */
// near/far follow the scene so large models are never cut at the back (log depth copes with the range)
let sceneSphere: THREE.Sphere | null = null, sphereAt = 0;
function fitClipRange() {
  const now = performance.now();
  if (!sceneSphere || now - sphereAt > 1000) {
    const b = new THREE.Box3();
    built.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible && (o as THREE.Mesh).geometry) b.expandByObject(o); });
    sceneSphere = b.isEmpty() ? null : b.getBoundingSphere(new THREE.Sphere());
    sphereAt = now;
    if (!sceneSphere) return;
  }
  const d = camera.position.distanceTo(sceneSphere.center), r = sceneSphere.radius;
  const far = (d + r) * 1.1 + 1, near = Math.max(0.005, Math.min(far / 1e6 * 10, Math.max(d - r, 0) * 0.5) || 0.005);
  if (Math.abs(camera.far - far) > far * 0.01 || camera.near !== near) { camera.far = far; camera.near = near; camera.updateProjectionMatrix(); }
}
function drawFrame(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = camera) {
  const main = cam === camera;
  if (main) fitClipRange();
  const camera3 = cam;
  // outlines: the parts the script outlines now (only animated parts can carry one)
  if (main) glow.update(player.tl.touched.map((id) => built.registry.get(id)).filter((o) => o?.userData.outline) as THREE.Object3D[]);
  if (!drawing.enabled) { renderer.render(scene3, camera3); caps.render(renderer, scene3, camera3, null); main && glow.render(renderer, scene3, camera); return; }
  if (drawing.overlay) { renderer.render(scene3, camera3); caps.render(renderer, scene3, camera3, null); }   // shaded + outline: the cel-shaded frame, lines on top
  drawing.render(scene3, camera3);
  main && glow.render(renderer, scene3, camera, drawing.depth ?? undefined);
  const h = gizmo.getHelper();
  if (main && gizmo.object) { renderer.autoClear = false; renderer.clearDepth(); renderer.render(h, camera3); renderer.autoClear = true; }
}

// ---------- undo / redo: restore a recorded state in place ----------
const undoToast = document.createElement('div');
undoToast.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:8;background:rgba(14,17,21,.95);color:#d7dde4;border:1px solid #2b3540;border-radius:6px;padding:5px 12px;font:12px system-ui;display:none;pointer-events:none';
host().appendChild(undoToast);
let toastTimer: number | undefined;
const WHAT: Record<UndoKey, string> = { colors: 'colour', snapshots: 'move / lock / hide', groups: 'groups', folders: 'folders', cutKeep: 'keep uncut', labels: 'rename', removed: 'remove / restore', script: 'script edit', drawings: 'drawing script edit', views: 'views', keyframe: 'thumbnail', shapes: 'shapes', copies: 'copies' };
async function restoreDoc(d: DocState, verb: string) {
  const what = UNDO_KEYS.filter((k) => d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(docNow[k])).map((k) => WHAT[k]);
  undoing = true;
  try {
    const t = player.time;
    player.seek(0);
    if (d.groups) store.groups = clone(d.groups);
    if (d.folders) store.folders = clone(d.folders);
    if (d.cutKeep) cutKeep = clone(d.cutKeep);
    if (d.snapshots) {
      store.active = d.snapshots.active; store.snapshots = clone(d.snapshots.items);
      useSnapshot(store.snapshots[store.active] ?? { locked: {}, hidden: {} });
      applyPlacements();
    }
    if (d.removed) {
      removed.clear(); for (const id of d.removed) removed.add(id);
      for (const [id, o] of built.registry) { if (removed.has(id)) o.userData.removed = true; else delete o.userData.removed; }
    }
    if (d.labels) {
      labels = clone(d.labels);
      for (const [id, o] of built.registry) { if (labels[id]) o.userData.label = labels[id]; else delete o.userData.label; }
    }
    if (d.colors) { colors = clone(d.colors); applyColors(); }
    if (d.views) { views = clone(d.views); renderViews(); }
    if ('keyframe' in d) keyframe = clone(d.keyframe);
    if (d.shapes) { shapes = clone(d.shapes); buildShapes(); applyPlacements(); applyColors(); tree.rebuild(); }
    // copies follow their sources: rebuild when they or what they copy (removed parts, groups) changed
    if (d.copies || (copies.length && (d.removed || d.groups))) { if (d.copies) copies = clone(d.copies); await buildCopies(); applyPlacements(); applyColors(); await reconcile(copiesRoot); tree.rebuild(); }
    for (const o of built.root.children) await reconcile(o);
    if (d.script && scriptPanel && d.script.text !== scriptPanel.text) {
      docNow.script = clone(d.script);
      scriptPanel.setText(d.script.text);            // recompiles (not recorded: undoing)
    }
    if (d.drawings && drawPanel && d.drawings.text !== drawPanel.text) { docNow.drawings = clone(d.drawings); drawPanel.setText(d.drawings.text); }
    buildTimeline({ atStart: true });
    player.seek(Math.min(t, player.duration));
    edit({ colors: { ...colors }, snapshots: { active: store.active, items: clone(store.snapshots) }, groups: clone(store.groups), folders: clone(store.folders), cutKeep: [...cutKeep], labels: { ...labels }, removed: [...removed], views: clone(views), shapes: clone(shapes), copies: clone(copies) });
    tree.rebuild();
    gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs);
    updateTools(); renderSnapBar(); markDirty(false);
  } finally { undoing = false; }
  undoToast.textContent = `${verb}${what.length ? `: ${what.join(', ')}` : ''}`;
  undoToast.style.display = '';
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (undoToast.style.display = 'none'), 1600);
}
async function undo() {
  const d = undoStack.pop(); if (!d) return;
  burst = false; redoStack.push(clone(docNow));
  await restoreDoc(d, '↶ Undo');
}
async function redo() {
  const d = redoStack.pop(); if (!d) return;
  burst = false; undoStack.push(clone(docNow));
  await restoreDoc(d, '↷ Redo');
}
on('keydown', (e: KeyboardEvent) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  // text boxes (script editor, chat, names) keep their own undo
  const el = e.target as HTMLElement;
  if (el.closest?.('.cm-editor') || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['color', 'checkbox', 'range', 'button'].includes((el as HTMLInputElement).type))) return;
  e.preventDefault();
  if (k === 'y' || e.shiftKey) void redo(); else void undo();
});

// ---------- utility tools: floating bar on the left of the 3D view ----------
const toolbar = document.createElement('div'); toolbar.id = 'toolsbar';
toolbar.innerHTML = `<button data-t="blank" title="Blank / unblank the selected parts (H)"><span class="i">◐</span><span class="l">Blank</span></button>
  <button data-t="others" title="Reverse blank: hide everything that is not selected (⇧H)"><span class="i">◑</span><span class="l">Blank others</span></button>
  <button data-t="keep" title="Keep uncut: cuts leave the selected parts whole (saved with the animation; K). A script cut can add its own: cutaway half x keep @lid"><span class="i">✂</span><span class="l">Keep uncut</span></button>
  <button data-t="find" title="Select by name: every part whose name contains the text (or matches a glob with *), e.g. V-005202-001 – then Blank, Group, colour… (F)"><span class="i">⌕</span><span class="l">Select by name</span></button>
  <div class="fpop" hidden><input placeholder="Part of a name, e.g. V-005202-001" spellcheck="false"><div class="hint"></div><button data-f="go">Select</button></div>
  <button data-t="showall" title="Show all: unblank every part (removed parts stay removed)"><span class="i">●</span><span class="l">Show all</span></button>
  <button data-t="origin" title="Set the model origin: click a cylindrical face (its axis), then a flat face (its height); the model moves so that point is (0,0,0)"><span class="i">⊕</span><span class="l">Set origin</span></button>
  <button data-t="shape" title="Shapes: add a box, cylinder, tube, sphere, cone, plane or hex prism – sizes, position, colour, linear / circular arrays. Select a shape to edit it."><span class="i">◇</span><span class="l">Shape</span></button>
  <div class="shpop" hidden></div>
  <button data-t="dup" title="Duplicate the selection (parts, assemblies or a group) as a linked copy: it follows the CAD, has its own position and rotation, and scripts can animate it (⌘D)"><span class="i">⧉</span><span class="l">Duplicate</span></button>
  <div class="cppop" hidden></div>
  <button data-t="thumb" title="Thumbnail: this moment (time, camera, view style) becomes the card image on Home. A thumbnail step in the script takes priority."><span class="i">📌</span><span class="l">Thumbnail</span></button>
  <button data-t="views" title="Camera views: save the current view (position and target), go to one, or put it in the script (camera <name> 2s)"><span class="i">📷</span><span class="l">Views</span></button>
  <div class="vpop" hidden></div>
  <button data-t="cad" title="CAD models: load a .glb (from the vault's CAD folder or from disk) into this animation, or remove one"><span class="i">📦</span><span class="l">CAD</span></button>
  <div class="vpop cadpop" hidden></div>
  <button data-t="group" title="Create a group from the selected parts, or add them to one (G)"><span class="i">⊞</span><span class="l">Group</span></button>`;
host().appendChild(toolbar);
/** Keep the tool bar clear of the view toolbar, which wraps to more rows in narrow windows. */
function layoutToolbar() {
  const vb = host().querySelector<HTMLElement>('#viewbar');
  const h = host().getBoundingClientRect();
  const below = vb ? vb.getBoundingClientRect().bottom - h.top + 8 : 64;
  toolbar.style.top = `${Math.max(64, Math.round(below))}px`;
}
{ const tro = new ResizeObserver(layoutToolbar); tro.observe(root); const vb = host().querySelector('#viewbar'); if (vb) tro.observe(vb); }
layoutToolbar();
{
  const css = document.createElement('style');
  css.textContent = `#toolsbar { position: absolute; left: 352px; top: 64px; z-index: 6; display: flex; flex-direction: column; gap: 4px; padding: 4px;
      background: rgba(14,17,21,.9); border: 1px solid #2b3540; border-radius: 6px; font: 11px system-ui; }
    .studio-root.tree-collapsed #toolsbar { left: 12px; }
    #toolsbar button { width: 60px; text-align: center; line-height: 1.15; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 5px 2px; background: #1b222a; color: #d7dde4; border: 1px solid #2b3540; border-radius: 4px; cursor: pointer; font: inherit; }
    #toolsbar button .i { font-size: 16px; line-height: 1; }
    #toolsbar button:hover:not(:disabled) { background: #26303a; } #toolsbar button:disabled { opacity: .4; cursor: default; }
    #toolsbar button.on { border-color: #f2b705; color: #f2b705; }
    #toolsbar .vpop { position: absolute; left: calc(100% + 6px); top: 0; width: 250px; background: rgba(14,17,21,.97); border: 1px solid #2b3540; border-radius: 6px; padding: 8px; color: #d7dde4; display: flex; flex-direction: column; gap: 4px; }
    #toolsbar .vpop[hidden], #toolsbar .fpop[hidden], #toolsbar :is(.shpop, .cppop)[hidden] { display: none; }
    #toolsbar :is(.shpop, .cppop) { position: absolute; left: calc(100% + 6px); top: 0; width: 290px; max-height: 80vh; overflow: auto; background: rgba(14,17,21,.97); border: 1px solid #2b3540; border-radius: 6px; padding: 8px 10px; color: #d7dde4; display: flex; flex-direction: column; gap: 5px; font: 12px system-ui; }
    #toolsbar :is(.shpop, .cppop) b { font-size: 12px; }
    #toolsbar :is(.shpop, .cppop) .r { display: grid; grid-template-columns: 82px 1fr; align-items: center; gap: 6px; }
    #toolsbar :is(.shpop, .cppop) .v3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
    #toolsbar :is(.shpop, .cppop) input, #toolsbar :is(.shpop, .cppop) select { width: 100%; box-sizing: border-box; background: #0a0c0f; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 4px; font: 11.5px ui-monospace, monospace; }
    #toolsbar :is(.shpop, .cppop) input[type=color] { height: 20px; padding: 0; }
    #toolsbar :is(.shpop, .cppop) .acts { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
    #toolsbar :is(.shpop, .cppop) button { width: auto; flex-direction: row; padding: 3px 8px; }
    #toolsbar :is(.shpop, .cppop) .hint { color: #7b8794; font-size: 10.5px; }
    #toolsbar :is(.shpop, .cppop) .err { color: #e5484d; font-size: 11px; }
    #toolsbar .fpop { position: absolute; left: calc(100% + 6px); top: 0; width: 260px; background: rgba(14,17,21,.97); border: 1px solid #2b3540; border-radius: 6px; padding: 8px; color: #d7dde4; display: flex; flex-direction: column; gap: 6px; }
    #toolsbar .fpop input { background: #0a0c0f; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 4px 6px; font: 12px ui-monospace, monospace; }
    #toolsbar .fpop button { width: auto; flex-direction: row; justify-content: center; padding: 4px; }
    #toolsbar .fpop .hint { color: #7b8794; font-size: 10.5px; }
    #toolsbar .vpop .row { display: flex; align-items: center; gap: 4px; }
    #toolsbar .vpop .row .n { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #toolsbar .vpop button { width: auto; flex-direction: row; padding: 3px 6px; }
    #toolsbar .vpop .hint { color: #7b8794; font-size: 10.5px; }`;
  document.head.appendChild(css);
}
/** Reverse blank: hide everything outside the selection (siblings along each selected part's path), show the selection. */
async function blankOthers() {
  const sel = gSel.objs.filter((o) => built.registry.get(idOfObj(o)) === o);
  if (!sel.length) return;
  const keep = new Set<THREE.Object3D>();
  for (const o of sel) for (let p: THREE.Object3D | null = o; p; p = p.parent) keep.add(p);
  const hide = new Set<string>();
  for (const o of keep) {
    if (sel.includes(o)) continue;                       // inside a selected part: leave it as it is
    // the top-most registered parts under each child that isn't on a selected path (containers like the core aren't parts)
    const off = (c: THREE.Object3D) => {
      if (keep.has(c)) return;
      if (built.registry.get(idOfObj(c)) === c) hide.add(idOfObj(c)); else c.children.forEach(off);
    };
    o.children.forEach(off);
  }
  for (const id of hide) state.hidden[id] = true;
  for (const o of keep) { const id = idOfObj(o); if (built.registry.get(id) === o && state.hidden[id]) state.hidden[id] = false; }
  for (const o of built.root.children) await reconcile(o);
  persistWorking(); tree.redraw(); buildTimeline(); updateTools();
}
/** Parts whose name (last id segment, display name or node name) contains `q` (case-insensitive), or matches it as a
 *  glob with *. Top-most matches only (a match's own sub-parts aren't listed again); removed parts are skipped. */
function partsNamed(q: string): THREE.Object3D[] {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const re = q.includes('*') ? new RegExp(`^${q.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : undefined;
  const hit = (o: THREE.Object3D) => {
    const id = idOfObj(o);
    return [id.slice(id.lastIndexOf('/') + 1), labels[id] ?? '', o.name].some((n) => { n = n.toLowerCase(); return re ? re.test(n) : n.includes(q); });
  };
  const out: THREE.Object3D[] = [];
  for (const [id, o] of built.registry) {
    if (built.registry.get(id) !== o || isRemoved(o) || !hit(o)) continue;
    let covered = false;
    for (let p = o.parent; p && !covered; p = p.parent) if (built.registry.get(idOfObj(p)) === p && hit(p)) covered = true;
    if (!covered) out.push(o);
  }
  return out;
}
// ---- model origin: the axis of a cylindrical face at the height of a flat face → (0,0,0) ----
let originPick: { step: 1 | 2; centre?: THREE.Vector3; radius?: number } | undefined;
const originBanner = document.createElement('div');
originBanner.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:7;background:#14202c;color:#d7dde4;border:1px solid #f2b705;border-radius:6px;padding:6px 10px;font:12px system-ui;display:none;gap:8px;align-items:center';
host().appendChild(originBanner);
const originMarker = new THREE.Group();
{
  const m = new THREE.LineBasicMaterial({ color: 0xf2b705, depthTest: false });
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 32 * Math.PI), 0, Math.sin(i / 32 * Math.PI)))), m);
  const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)]), m);
  originMarker.add(ring, axis); originMarker.renderOrder = 999; originMarker.visible = false;
  scene3.add(originMarker);
}
function originStatus(text: string) {
  originBanner.innerHTML = `⊕ ${text} <button data-o="cancel">Cancel</button>`;
  originBanner.style.display = 'flex';
  originBanner.querySelector<HTMLElement>('[data-o=cancel]')!.onclick = () => endOrigin();
}
function endOrigin() {
  originPick = undefined; originBanner.style.display = 'none'; originMarker.visible = false;
  toolbar.querySelector('[data-t=origin]')!.classList.remove('on');
}
function startOrigin() {
  if (!cfg.cad_models?.length) { alert('Set origin moves the CAD model – this animation has none.'); return; }
  originPick = { step: 1 };
  toolbar.querySelector('[data-t=origin]')!.classList.add('on');
  originStatus('1 / 2: click a <b>cylindrical face</b> (e.g. the vessel wall) – its axis is the origin in plan.');
}
function originClick(hit: THREE.Intersection) {
  if (!originPick) return;
  if (originPick.step === 1) {
    const fit = fitVerticalCylinder(hit);
    if (!fit) { originStatus('That isn\'t a vertical cylindrical face – click the curved wall of a vertical cylinder.'); return; }
    originPick = { step: 2, centre: fit.centre, radius: fit.radius };
    originMarker.position.copy(fit.centre); originMarker.scale.set(fit.radius, Math.max(fit.radius, 0.5), fit.radius); originMarker.visible = true;
    originStatus(`Axis at x ${fit.centre.x.toFixed(3)}, z ${fit.centre.z.toFixed(3)} (Ø ${(fit.radius * 2).toFixed(3)} m). 2 / 2: click a <b>flat face</b> at the origin's height.`);
    return;
  }
  const y = planeHeight(hit);
  if (y === undefined) { originStatus('That face isn\'t horizontal – click a flat (horizontal) face for the height.'); return; }
  const o = new THREE.Vector3(originPick.centre!.x, y, originPick.centre!.z);
  originMarker.position.y = y;
  if (!confirm(`Set the origin to this point?\n[${o.toArray().map((v) => v.toFixed(3)).join(', ')}] becomes (0, 0, 0): the CAD moves by [${o.toArray().map((v) => (-v).toFixed(3)).join(', ')}].\n\nSaved views and snapshot cameras move with it. Absolute numbers in the script (move … to, camera [..], cutaway at [..]) are not changed.`)) { endOrigin(); return; }
  setOrigin(o);
  endOrigin();
}
/** Move every CAD model (and the saved cameras) so the point o is the world origin; the studio reloads. */
function setOrigin(o: THREE.Vector3) {
  const shift = (v: number[]) => v.map((x, i) => +(x - o.getComponent(i)).toFixed(6));
  const scene = clone(model.scene ?? {});
  scene.cad_models = (cfg.cad_models ?? []).map((m: any) => ({ ...m, position: shift(m.position ?? [0, 0, 0]) }));
  for (const v of Object.values(views)) { v.pos = shift(v.pos); v.look = shift(v.look); }
  const items = clone(store.snapshots);
  for (const sn of Object.values(items) as any[]) if (sn.camera) sn.camera = { pos: shift(sn.camera.pos), look: shift(sn.camera.look) };
  edit({ scene, views: clone(views), snapshots: { active: store.active, items }, view: { ...(model.view ?? {}), camera: { pos: shift(camView().pos), look: shift(camView().look) } } });
  io.reload?.();
}
// ---- thumbnail: a keyframe of the animation is the card image on Home ----
let keyframe = model.keyframe;
type Mode = 'shaded' | 'outline' | 'hidden';
const viewMode = (): Mode => (drawing.enabled ? (drawing.overlay ? 'outline' : 'hidden') : 'shaded');
/** The frame to show: a script `thumbnail` step wins, then the saved keyframe, then the opening frame. */
function thumbFrame(): { t: number; camera?: { pos: number[]; look: number[] }; mode: Mode; from: 'script' | 'keyframe' | 'default' } {
  const st = player.tl.steps.find((x) => x.kind === 'thumbnail');
  if (st) return { t: st.t, mode: st.value as Mode, from: 'script' };
  if (keyframe) return { t: keyframe.t, camera: keyframe.camera, mode: keyframe.mode ?? 'shaded', from: 'keyframe' };
  return { t: 0, mode: 'shaded', from: 'default' };
}
const THUMB_W = 480, THUMB_H = 300;
/** Render the thumbnail frame off-screen (the view on screen is put back as it was) and send it as the card. */
async function renderThumb(): Promise<string | undefined> {
  if (!io.putThumb || disposed) return;
  const f = thumbFrame();
  const save = { t: player.time, playing: player.playing, pos: camera.position.clone(), look: controls.target.clone(), aspect: camera.aspect,
    enabled: drawing.enabled, overlay: drawing.overlay, pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()) };
  let url: string;
  try {
    player.playing = false;
    player.seek(Math.min(f.t, player.duration));
    applyCut((player.current('cutaway')?.value ?? 'none') as Cut | CutMode);
    const cam = f.camera ?? { pos: player.tl.camera.pos.toArray(), look: player.tl.camera.look.toArray() };
    camera.position.fromArray(cam.pos); camera.lookAt(new THREE.Vector3(...cam.look));
    camera.aspect = THUMB_W / THUMB_H; camera.updateProjectionMatrix();
    drawing.enabled = f.mode !== 'shaded'; drawing.overlay = f.mode === 'outline';
    if (drawing.enabled) drawing.collectDecor(scene3, [gizmo.getHelper()]);
    renderer.setPixelRatio(1); renderer.setSize(THUMB_W, THUMB_H, false);
    gizmo.getHelper().visible = false;
    drawFrame();
    url = renderer.domElement.toDataURL('image/jpeg', 0.85);
  } finally {
    gizmo.getHelper().visible = true;
    renderer.setPixelRatio(save.pr); renderer.setSize(save.size.x, save.size.y, false);
    drawing.enabled = save.enabled; drawing.overlay = save.overlay;
    camera.aspect = save.aspect; camera.updateProjectionMatrix();
    camera.position.copy(save.pos); controls.target.copy(save.look); controls.update();
    player.seek(save.t); player.playing = save.playing;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${THUMB_W} ${THUMB_H}" width="${THUMB_W}" height="${THUMB_H}"><image href="${url}" width="${THUMB_W}" height="${THUMB_H}"/></svg>`;
  await io.putThumb(svg);
  return svg;
}
/** The Thumbnail button: this moment (time, camera, view style) is the card image. */
function setKeyframe() {
  keyframe = { t: +player.time.toFixed(3), camera: camView(), mode: viewMode() };
  edit({ keyframe: clone(keyframe) });
  const script = player.tl.steps.some((x) => x.kind === 'thumbnail');
  undoToast.textContent = script ? '📌 Saved – but the script\'s thumbnail step is used while it\'s there' : `📌 Thumbnail: ${keyframe.t.toFixed(1)} s, ${keyframe.mode}`;
  undoToast.style.display = '';
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (undoToast.style.display = 'none'), 2200);
  clearTimeout(thumbTimer); void renderThumb();
}
/** Put a tools-bar popover beside its button, inside the view (clear of the view toolbar at the top). */
function placePop(pop: HTMLElement, btn: string) {
  if (pop.hidden) return;
  const b = toolbar.querySelector<HTMLElement>(`[data-t=${btn}]`)!;
  pop.style.top = `${b.offsetTop}px`;
  const r = pop.getBoundingClientRect(), h = host().getBoundingClientRect();
  let dy = 0;
  if (r.bottom > h.bottom - 8) dy -= r.bottom - (h.bottom - 8);
  if (r.top + dy < h.top + 64) dy += h.top + 64 - (r.top + dy);
  pop.style.top = `${b.offsetTop + dy}px`;
}

// ---- shapes: rebuild after a change; the Shape panel ----
/** Rebuild the shapes in place (placements, colours, state, tree, timeline) and save them. */
async function syncShapes(save = true, rename?: [string, string]) {
  const t = player.time, playing = player.playing;
  player.playing = false;
  player.seek(0);
  const from = rename && shapePartId(rename[0]), to = rename && shapePartId(rename[1]);
  const keep = gSel.objs.map(idOfObj).map((id) => (from && to && (id === from || id.startsWith(from + '/')) ? to + id.slice(from.length).replace(`/${rename![0]}-`, `/${rename![1]}-`) : id));
  buildShapes();
  applyPlacements();
  applyColors();
  await reconcile(shapesRoot);
  tree.rebuild();
  buildTimeline({ atStart: true });
  player.seek(Math.min(t, player.duration)); player.playing = playing;
  if (keep.some((id) => id.startsWith(SHAPES_ROOT + '/'))) {
    const still = keep.map((id) => built.registry.get(id)).filter(Boolean) as THREE.Object3D[];
    if (still.length) tree.selectObjects(still); else tree.select(undefined, false);
  }
  if (save) edit({ shapes: clone(shapes) });
}
const shpop = toolbar.querySelector<HTMLElement>('.shpop')!;
/** The shape the selection belongs to (a shape, or a copy in its array). */
function selectedShape(): ShapeDef | undefined {
  if (gSel.objs.length !== 1) return;
  for (let p: THREE.Object3D | null = gSel.objs[0]; p && p !== shapesRoot; p = p.parent)
    if (p.userData.shape !== undefined && p.parent === shapesRoot) return shapes.find((s) => s.id === p!.userData.shape);
}
let newKind: ShapeKind = 'box';
const num = (v: number) => String(+(+v).toFixed(4));
let shownShape: string | undefined;
function refreshShapePanel(force = false) {
  if (shpop.hidden) return;
  const def = selectedShape();
  // typing in the panel re-selects the shape after each change: don't re-render under the cursor
  if (!force && def && def.id === shownShape && shpop.contains(document.activeElement)) return;
  shownShape = def?.id;
  const d: ShapeDef = def ?? { id: freeName(newKind, shapes.map((s) => s.id)), kind: newKind, size: SIZES[newKind].map((f) => f.def),
    position: controls.target.toArray().map((v) => +v.toFixed(2)), rotation: [0, 0, 0], color: '#c8d0d9' };
  const a = d.array;
  const v3 = (k: string, v: number[]) => `<div class="v3">${[0, 1, 2].map((i) => `<input type="number" step="0.05" data-f="${k}${i}" value="${num(v[i] ?? 0)}">`).join('')}</div>`;
  shpop.innerHTML = `<b>${def ? `Shape <code>${d.id}</code>` : 'New shape'}</b>
    <div class="r">Kind <select data-f="kind">${KINDS.map((k) => `<option ${k === d.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="r">Name <input data-f="id" value="${d.id}" spellcheck="false"></div>
    ${SIZES[d.kind].map((f, i) => `<div class="r">${f.label} <input type="number" step="0.05" min="0" data-f="size${i}" value="${num(d.size[i] ?? f.def)}"></div>`).join('')}
    <div class="r">Position ${v3('pos', d.position)}</div>
    <div class="r">Rotation° ${v3('rot', d.rotation)}</div>
    <div class="r">Colour <input type="color" data-f="color" value="${d.color}"></div>
    <div class="r">Array <select data-f="atype"><option value="">none</option><option value="linear" ${a?.type === 'linear' ? 'selected' : ''}>linear</option><option value="circular" ${a?.type === 'circular' ? 'selected' : ''}>circular</option></select></div>
    ${a ? `<div class="r">Count <input type="number" min="1" max="500" step="1" data-f="count" value="${a.count}"></div>` : ''}
    ${a?.type === 'linear' ? `<div class="r">Step ${v3('step', a.step)}</div>` : ''}
    ${a?.type === 'circular' ? `<div class="r">Centre x, z <div class="v3"><input type="number" step="0.05" data-f="cx" value="${num(a.centre[0])}"><input type="number" step="0.05" data-f="cz" value="${num(a.centre[1])}"></div></div>
      <div class="r">Angle° <input type="number" step="15" data-f="angle" value="${num(a.angle)}"></div>` : ''}
    <div class="err"></div>
    <div class="acts">${def ? '<button data-s="dup">Duplicate</button><button data-s="del">Delete</button><button data-s="new">New…</button>' : '<button data-s="add">Add shape</button>'}</div>
    <div class="hint">${def ? 'Changes apply as you type. In scripts: ' + `<code>${d.id}</code>` + (a ? `, copies <code>${d.id}-0</code>… (<code>${d.id}-*</code>)` : '') : 'Placed at the view centre. Select a shape to edit it.'}</div>`;
  const q = <T extends HTMLElement>(f: string) => shpop.querySelector<T>(`[data-f="${f}"]`);
  const errEl = shpop.querySelector<HTMLElement>('.err')!;
  /** The form as a shape (undefined + a message when it isn't valid). */
  const read = (): ShapeDef | undefined => {
    const n = (f: string, dflt = 0) => { const x = parseFloat(q<HTMLInputElement>(f)?.value ?? ''); return Number.isFinite(x) ? x : dflt; };
    const kind = q<HTMLSelectElement>('kind')!.value as ShapeKind;
    const id = q<HTMLInputElement>('id')!.value.trim();
    if (!validName(id)) { errEl.textContent = 'Name: letters, digits, - and _, not starting with a digit'; return; }
    if (id !== (def?.id ?? '') && shapes.some((s) => s.id === id)) { errEl.textContent = `There's already a shape called ${id}`; return; }
    errEl.textContent = '';
    const at = q<HTMLSelectElement>('atype')!.value;
    const count = Math.max(1, Math.min(500, Math.round(n('count', 4))));
    const array = at === 'linear' ? { type: 'linear' as const, count, step: [0, 1, 2].map((i) => n(`step${i}`, i === 0 ? 1 : 0)) }
      : at === 'circular' ? { type: 'circular' as const, count, centre: [n('cx'), n('cz')], angle: n('angle', 360) } : undefined;
    return { id, kind, size: SIZES[kind].map((f, i) => Math.max(0.001, n(`size${i}`, f.def))), position: [0, 1, 2].map((i) => n(`pos${i}`)),
      rotation: [0, 1, 2].map((i) => n(`rot${i}`)), color: q<HTMLInputElement>('color')!.value, ...(array ? { array } : {}) };
  };
  // kind / array type change the fields: re-render
  q<HTMLSelectElement>('kind')!.onchange = () => {
    const k = q<HTMLSelectElement>('kind')!.value as ShapeKind;
    if (!def) { newKind = k; refreshShapePanel(); return; }
    def.kind = k; def.size = SIZES[k].map((f) => f.def);
    void syncShapes().then(() => refreshShapePanel(true));
  };
  q<HTMLSelectElement>('atype')!.onchange = () => {
    const t = q<HTMLSelectElement>('atype')!.value;
    const arr = t === 'linear' ? { type: 'linear' as const, count: 4, step: [1, 0, 0] } : t === 'circular' ? { type: 'circular' as const, count: 6, centre: [0, 0], angle: 360 } : undefined;
    if (!def) { const r = read(); if (r) { pendingNew = { ...r, ...(arr ? { array: arr } : { array: undefined }) }; renderPending(); } return; }
    if (arr) def.array = arr; else delete def.array;
    void syncShapes().then(() => refreshShapePanel(true));
  };
  // editing: apply as you type
  let timer: number | undefined;
  if (def) shpop.querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const r = read(); if (!r) return;
      const old = def.id;
      Object.assign(def, r); if (!r.array) delete def.array;
      if (r.id !== old) { renameShapeRefs(old, r.id); shownShape = r.id; }
      void syncShapes(true, r.id !== old ? [old, r.id] : undefined);
    }, 250);
  }));
  const act = (k: string, f: () => void) => shpop.querySelector<HTMLElement>(`[data-s="${k}"]`)?.addEventListener('click', f);
  act('add', () => {
    const r = read(); if (!r) return;
    shapes.push(r);
    void syncShapes().then(() => { tree.selectId(shapePartId(r.id)); refreshShapePanel(); });
  });
  act('dup', () => {
    if (!def) return;
    const c: ShapeDef = { ...clone(def), id: freeName(def.id.replace(/-\d+$/, ''), shapes.map((s) => s.id)), position: [def.position[0] + 1, def.position[1], def.position[2]] };
    shapes.push(c);
    void syncShapes().then(() => { tree.selectId(shapePartId(c.id)); refreshShapePanel(); });
  });
  act('del', () => {
    if (!def) return;
    shapes = shapes.filter((s) => s !== def);
    tree.select(undefined, false);
    void syncShapes().then(() => refreshShapePanel(true));
  });
  act('new', () => { tree.select(undefined, false); refreshShapePanel(); });
  shpop.onkeydown = (e) => e.stopPropagation();   // keep viewer shortcuts out of the fields
  placePop(shpop, 'shape');
}
let pendingNew: ShapeDef | undefined;
/** A new shape's form after its array type changed (keeps what was typed). */
function renderPending() {
  const p = pendingNew; pendingNew = undefined;
  if (!p) return;
  // render the "new shape" form with these values: add it as a temporary edit target, then re-read on Add
  newKind = p.kind;
  refreshShapePanel();
  const set = (f: string, v: string) => { const el = shpop.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-f="${f}"]`); if (el) el.value = v; };
  set('id', p.id); p.size.forEach((v, i) => set(`size${i}`, num(v))); p.position.forEach((v, i) => set(`pos${i}`, num(v)));
  p.rotation.forEach((v, i) => set(`rot${i}`, num(v))); set('color', p.color);
  if (p.array) {
    // the array fields only exist once the form knows the type: insert them
    const t = shpop.querySelector<HTMLSelectElement>('[data-f="atype"]')!; t.value = p.array.type;
    const row = t.closest('.r')!;
    const extra = p.array.type === 'linear'
      ? `<div class="r">Count <input type="number" min="1" max="500" step="1" data-f="count" value="${p.array.count}"></div><div class="r">Step <div class="v3">${p.array.step.map((v, i) => `<input type="number" step="0.05" data-f="step${i}" value="${num(v)}">`).join('')}</div></div>`
      : `<div class="r">Count <input type="number" min="1" max="500" step="1" data-f="count" value="${p.array.count}"></div><div class="r">Centre x, z <div class="v3"><input type="number" step="0.05" data-f="cx" value="${num(p.array.centre[0])}"><input type="number" step="0.05" data-f="cz" value="${num(p.array.centre[1])}"></div></div><div class="r">Angle° <input type="number" step="15" data-f="angle" value="${num(p.array.angle)}"></div>`;
    row.insertAdjacentHTML('afterend', extra);
  }
}
/** A shape renamed: its part ids change – follow in the script, colours and labels. */
function renameShapeRefs(oldId: string, newId: string) {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (scriptPanel) {
    const re = new RegExp(`(^|[\\s,/=])${esc(oldId)}(?=(-\\d+|-\\*)?(?![\\w-]))`, 'gm');
    const next = scriptPanel.text.replace(re, `$1${newId}`);
    if (next !== scriptPanel.text) scriptPanel.setText(next);
  }
  const from = shapePartId(oldId), to = shapePartId(newId);
  const mv = (k: string) => (k === from || k.startsWith(from + '/') ? to + k.slice(from.length).replace(`/${oldId}-`, `/${newId}-`) : k);
  colors = Object.fromEntries(Object.entries(colors).map(([k, v]) => [mv(k), v]));
  labels = Object.fromEntries(Object.entries(labels).map(([k, v]) => [mv(k), v]));
  edit({ colors: { ...colors }, labels: { ...labels } });
}

// ---- copies: Duplicate, rebuild after a change, the Copy panel ----
/** Rebuild the copies in place (placements, colours, state, tree, timeline) and save them. */
async function syncCopies(save = true, select?: string) {
  const t = player.time, playing = player.playing;
  player.playing = false;
  player.seek(0);
  const keep = select ? [select] : gSel.objs.map(idOfObj);
  await buildCopies();
  applyPlacements();
  applyColors();
  await reconcile(copiesRoot);
  tree.rebuild();
  buildTimeline({ atStart: true });
  player.seek(Math.min(t, player.duration)); player.playing = playing;
  const still = keep.map((id) => built.registry.get(id)).filter(Boolean) as THREE.Object3D[];
  if (still.length) tree.selectObjects(still); else if (keep.some((id) => id.startsWith(COPIES_ROOT + '/'))) tree.select(undefined, false);
  if (save) edit({ copies: clone(copies) });
  refreshCopyPanel();   // not under the cursor while typing in it
}
/** The copy the selection is (its root), if any. */
function selectedCopy(): CopyDef | undefined {
  if (gSel.objs.length !== 1) return;
  const o = gSel.objs[0];
  return o.parent === copiesRoot ? copies.find((c) => c.id === o.userData.copy) : undefined;
}
/** Duplicate: the selected copy again (same sources), or the selection as a new copy – one box width along x. */
async function duplicateSelection() {
  if (!gSel.objs.length) return;
  const cur = selectedCopy();
  const taken = copies.map((c) => c.id);
  let def: CopyDef;
  if (cur) {
    const o = gSel.objs[0], w = sourcesBox([o]).getSize(new THREE.Vector3()).x;
    def = { ...clone(cur), id: freeCopyName(cur.id.replace(/-\d+$/, ''), taken), position: [cur.position[0] + w * 1.1, cur.position[1], cur.position[2]] };
  } else {
    const specs = tree.selectedSpecs().filter((s) => s !== COPIES_ROOT && s !== SHAPES_ROOT);
    if (!specs.length) return;
    const b = sourcesBox(gSel.objs);
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), w = b.getSize(new THREE.Vector3()).x;
    const base = specs[0].startsWith('@') ? specs[0].slice(1) : (gSel.objs[0].userData.label ?? specs[0].split('/').pop()!);
    def = { id: freeCopyName(String(base), taken), of: specs, position: [+(c.x + w * 1.1).toFixed(4), +c.y.toFixed(4), +c.z.toFixed(4)], rotation: [0, 0, 0] };
  }
  copies.push(def);
  cppop.hidden = false;
  await syncCopies(true, copyPartId(def.id));
}
function renameCopyRefs(oldId: string, newId: string) {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (scriptPanel) {
    const re = new RegExp(`(^|[\\s,=]|${esc(COPIES_ROOT)}/)${esc(oldId)}(?![\\w-])`, 'gm');
    const next = scriptPanel.text.replace(re, `$1${newId}`);
    if (next !== scriptPanel.text) scriptPanel.setText(next);
  }
  const from = copyPartId(oldId), to = copyPartId(newId);
  const mv = (k: string) => (k === from || k.startsWith(from + '/') ? to + k.slice(from.length) : k);
  colors = Object.fromEntries(Object.entries(colors).map(([k, v]) => [mv(k), v]));
  labels = Object.fromEntries(Object.entries(labels).map(([k, v]) => [mv(k), v]));
  for (const g of Object.keys(store.groups)) store.groups[g] = store.groups[g].map(mv);
  const rm = [...removed].map(mv); removed.clear(); rm.forEach((x) => removed.add(x));
  edit({ colors: { ...colors }, labels: { ...labels }, groups: clone(store.groups), removed: [...removed] });
}
const cppop = toolbar.querySelector<HTMLElement>('.cppop')!;
let shownCopy: string | undefined;
/** The Copy panel: shown while a copy is selected – name, sources, position, rotation; Select source, Delete. */
function refreshCopyPanel(force = false) {
  const def = selectedCopy();
  if (!def) { cppop.hidden = true; shownCopy = undefined; return; }
  cppop.hidden = false;
  if (!force && def.id === shownCopy && cppop.contains(document.activeElement)) return;
  shownCopy = def.id;
  const v3 = (k: string, v: number[]) => `<div class="v3">${[0, 1, 2].map((i) => `<input type="number" step="0.05" data-f="${k}${i}" value="${num(v[i] ?? 0)}">`).join('')}</div>`;
  const err = copyErrors.get(def.id), a = def.array;
  cppop.innerHTML = `<b>Copy <code>${def.id}</code></b>
    <div class="r">Name <input data-f="id" value="${def.id}" spellcheck="false"></div>
    <div class="r">Of <input data-f="of" value="${def.of.join(', ')}" spellcheck="false" title="Part ids, @groups – as in scripts"></div>
    <div class="r">Position ${v3('pos', def.position)}</div>
    <div class="r">Rotation° ${v3('rot', def.rotation)}</div>
    <div class="r">Mirror <select data-f="mirror"><option value="">none</option>${(['x', 'y', 'z'] as const).map((k) => `<option ${def.mirror === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="r">Array <select data-f="atype"><option value="">none</option><option value="linear" ${a?.type === 'linear' ? 'selected' : ''}>linear</option><option value="circular" ${a?.type === 'circular' ? 'selected' : ''}>circular</option></select></div>
    ${a ? `<div class="r">Count <input type="number" min="1" max="500" step="1" data-f="count" value="${a.count}"></div>` : ''}
    ${a?.type === 'linear' ? `<div class="r">Step (m) ${v3('step', a.step)}</div>` : ''}
    ${a?.type === 'circular' ? `<div class="r">Axis x, z <div class="v3"><input type="number" step="0.05" data-f="cx" value="${num(a.centre[0])}"><input type="number" step="0.05" data-f="cz" value="${num(a.centre[1])}"></div></div>
      <div class="r">Angle° <input type="number" step="15" data-f="angle" value="${num(a.angle)}"></div>` : ''}
    <div class="err">${err ?? ''}</div>
    <div class="acts"><button data-s="dup">Duplicate</button><button data-s="src">Select source</button><button data-s="del">Delete</button></div>
    <div class="hint">Linked: follows its source. Position is the copy's centre (m); a circular array turns about a vertical axis. In scripts: <code>${def.id}</code>${a ? `, members <code>${def.id}-0</code>… (<code>${def.id}-*</code>)` : ''}; parts inside by full id <code>${copyPartId(a ? def.id + '-0' : def.id)}/…</code></div>`;
  const q = <T extends HTMLElement>(f: string) => cppop.querySelector<T>(`[data-f="${f}"]`)!;
  const errEl = cppop.querySelector<HTMLElement>('.err')!;
  q<HTMLSelectElement>('mirror').onchange = () => {
    const v = q<HTMLSelectElement>('mirror').value as CopyDef['mirror'] | '';
    if (v) def.mirror = v; else delete def.mirror;
    void syncCopies(true, copyPartId(def.id)).then(() => refreshCopyPanel(true));
  };
  q<HTMLSelectElement>('atype').onchange = () => {
    const t = q<HTMLSelectElement>('atype').value;
    const w = +(sourcesBox(copySources(def).objs).getSize(new THREE.Vector3()).x * 1.1).toFixed(3) || 1;
    if (t === 'linear') def.array = { type: 'linear', count: 4, step: [w, 0, 0] };
    else if (t === 'circular') def.array = { type: 'circular', count: 6, centre: [0, 0], angle: 360 };
    else delete def.array;
    void syncCopies(true, copyPartId(def.id)).then(() => refreshCopyPanel(true));
  };
  let timer: number | undefined;
  cppop.querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const n = (f: string) => { const x = parseFloat(q<HTMLInputElement>(f).value); return Number.isFinite(x) ? x : 0; };
      const id = q<HTMLInputElement>('id').value.trim();
      if (!validName(id)) { errEl.textContent = 'Name: letters, digits, - and _, not starting with a digit'; return; }
      if (id !== def.id && copies.some((c) => c.id === id)) { errEl.textContent = `There's already a copy called ${id}`; return; }
      const of = q<HTMLInputElement>('of').value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!of.length) { errEl.textContent = 'Of: what to copy (part ids, @groups)'; return; }
      errEl.textContent = '';
      const old = def.id;
      let rebuild = id !== old || of.join(',') !== def.of.join(',');
      if (def.array) {
        const count = Math.max(1, Math.min(500, Math.round(n('count') || 1)));
        const arr: CopyDef['array'] = def.array.type === 'linear' ? { type: 'linear', count, step: [0, 1, 2].map((k) => n(`step${k}`)) }
          : { type: 'circular', count, centre: [n('cx'), n('cz')], angle: n('angle') || 360 };
        if (JSON.stringify(arr) !== JSON.stringify(def.array)) { def.array = arr; rebuild = true; }
      }
      def.position = [0, 1, 2].map((k) => n(`pos${k}`)); def.rotation = [0, 1, 2].map((k) => n(`rot${k}`));
      def.of = of;
      if (id !== old) { renameCopyRefs(old, id); def.id = id; shownCopy = id; }
      if (rebuild) { void syncCopies(true, copyPartId(id)); return; }
      // just the pose: move the copy in place
      const o = built.registry.get(copyPartId(id));
      if (o) {
        o.position.fromArray(def.position);
        o.quaternion.setFromEuler(new THREE.Euler(...(def.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ'));
        o.userData.homeP = o.position.toArray(); o.userData.homeQ = o.quaternion.toArray();
        delete state.placements[idOfObj(o)];
        buildTimeline({ atStart: true });
        gizmoFor(o, gSel.spec, gSel.objs);
      }
      edit({ copies: clone(copies) });
    }, 250);
  }));
  const act = (k: string, f: () => void) => cppop.querySelector<HTMLElement>(`[data-s="${k}"]`)?.addEventListener('click', f);
  act('dup', () => void duplicateSelection());
  act('src', () => { const objs = copySources(def).objs; if (objs.length) tree.selectObjects(objs); });
  act('del', () => { copies = copies.filter((c) => c !== def); tree.select(undefined, false); void syncCopies(); });
  cppop.onkeydown = (e) => e.stopPropagation();
  placePop(cppop, 'dup');
}

/** Show all: clear every hide flag. */
async function showAll() {
  if (!Object.values(state.hidden).some(Boolean)) return;
  state.hidden = {};
  for (const o of built.root.children) await reconcile(o);
  persistWorking(); tree.redraw(); buildTimeline(); updateTools();
}
function updateTools() {
  const { count, allHidden } = tree.selectionInfo();
  toolbar.querySelector<HTMLButtonElement>('[data-t=dup]')!.disabled = !count;
  const blank = toolbar.querySelector<HTMLButtonElement>('[data-t=blank]')!, group = toolbar.querySelector<HTMLButtonElement>('[data-t=group]')!;
  blank.disabled = group.disabled = toolbar.querySelector<HTMLButtonElement>('[data-t=others]')!.disabled = !count;
  blank.querySelector('.l')!.textContent = allHidden ? 'Unblank' : 'Blank';
  blank.classList.toggle('on', allHidden);
  const keep = toolbar.querySelector<HTMLButtonElement>('[data-t=keep]')!, allKept = keptAll();
  keep.disabled = !count;
  keep.classList.toggle('on', allKept);
  keep.querySelector('.l')!.textContent = allKept ? 'Cut again' : 'Keep uncut';
}
function keptAll() { return gSel.objs.length > 0 && gSel.objs.every((o) => keptState(o)); }
function toggleKeep() { if (gSel.objs.length) setKeep(tree.selectedSpecs(), gSel.objs, !keptAll()); }
toolbar.querySelector<HTMLElement>('[data-t=keep]')!.onclick = toggleKeep;
toolbar.querySelector<HTMLElement>('[data-t=blank]')!.onclick = () => { tree.toggleHiddenSelected(); updateTools(); };
toolbar.querySelector<HTMLElement>('[data-t=others]')!.onclick = () => void blankOthers();
toolbar.querySelector<HTMLElement>('[data-t=showall]')!.onclick = () => void showAll();
toolbar.querySelector<HTMLElement>('[data-t=thumb]')!.onclick = setKeyframe;
toolbar.querySelector<HTMLElement>('[data-t=dup]')!.onclick = () => void duplicateSelection();
toolbar.querySelector<HTMLElement>('[data-t=shape]')!.onclick = () => {
  shpop.hidden = !shpop.hidden;
  toolbar.querySelector('[data-t=shape]')!.classList.toggle('on', !shpop.hidden);
  refreshShapePanel();
};
scheduleThumb(4000);   // the card for this animation as it opens (CAD loaded)
toolbar.querySelector<HTMLElement>('[data-t=origin]')!.onclick = () => (originPick ? endOrigin() : startOrigin());
// select by name
const fpop = toolbar.querySelector<HTMLElement>('.fpop')!, finput = fpop.querySelector('input')!, fhint = fpop.querySelector<HTMLElement>('.hint')!;
const findCount = () => {
  const n = partsNamed(finput.value).length;
  fhint.textContent = finput.value.trim() ? `${n} part${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''}` : 'Contains the text (case-insensitive); * for a glob.';
};
const findGo = () => {
  const objs = partsNamed(finput.value);
  if (!objs.length) return;
  tree.selectObjects(objs); updateTools();
  fhint.textContent = `Selected ${objs.length}. Blank (H), Blank others (⇧H), Group (G) or colour them.`;
};
const toggleFind = (open = fpop.hidden) => {
  fpop.hidden = !open; toolbar.querySelector('[data-t=find]')!.classList.toggle('on', open);
  placePop(fpop, 'find');
  if (open) { findCount(); finput.focus(); finput.select(); }
};
toolbar.querySelector<HTMLElement>('[data-t=find]')!.onclick = () => toggleFind();
finput.oninput = findCount;
finput.onkeydown = (e) => {
  e.stopPropagation();                                  // keep viewer shortcuts out of the box
  if (e.key === 'Enter') findGo();
  if (e.key === 'Escape') toggleFind(false);
};
fpop.querySelector<HTMLElement>('[data-f=go]')!.onclick = findGo;
// ---- camera views ----
const vpop = toolbar.querySelector<HTMLElement>('.vpop')!;
const escH = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function saveViews() { edit({ views: clone(views) }); buildTimeline(); renderViews(); }
function renderViews() {
  const names = Object.keys(views);
  vpop.innerHTML = `<button data-v="save">＋ Save current view…</button>
    ${names.map((n) => `<div class="row" data-n="${escH(n)}"><button class="n" data-v="go" title="Go to this view">${escH(n)}</button>
      <button data-v="ins" title="Insert “camera ${escH(n)} 2s” into the script">⤓ script</button>
      <button data-v="upd" title="Replace with the current view">⟳</button><button data-v="del" title="Delete">✕</button></div>`).join('')}
    <div class="hint">${names.length ? 'In the script: <code>camera &lt;name&gt; 2s</code> moves the camera to a view over 2 s.' : 'Saved views can be used in the script: camera &lt;name&gt; 2s'}</div>`;
  vpop.querySelector<HTMLElement>('[data-v=save]')!.onclick = () => {
    let i = names.length + 1; while (views[`view${i}`]) i++;
    const name = prompt('Name for this camera view (a word: letters, digits, - and _)', `view${i}`)?.trim().replace(/\s+/g, '-');
    if (!name || !/^[A-Za-z_][\w-]*$/.test(name)) return;
    if (views[name] && !confirm(`Replace the view "${name}"?`)) return;
    views[name] = camView(); saveViews();
  };
  vpop.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    const n = row.dataset.n!;
    row.querySelector<HTMLElement>('[data-v=go]')!.onclick = () => {
      ui.followCamera = false; gui.controllersRecursive().forEach((c) => c.updateDisplay());
      camera.position.fromArray(views[n].pos); controls.target.fromArray(views[n].look); controls.update();
    };
    row.querySelector<HTMLElement>('[data-v=ins]')!.onclick = () => {
      if (!scriptPanel) return;
      const v = scriptPanel.view, l = v.state.doc.line(scriptPanel.cursorLine);
      v.dispatch({ changes: { from: l.to, insert: `\n${l.text.match(/^\s*/)![0]}camera ${n} 2s` } });
      showTab('script'); v.focus();
    };
    row.querySelector<HTMLElement>('[data-v=upd]')!.onclick = () => { views[n] = camView(); saveViews(); };
    row.querySelector<HTMLElement>('[data-v=del]')!.onclick = () => { delete views[n]; saveViews(); };
  });
  placePop(vpop, 'views');
}
renderViews();
toolbar.querySelector<HTMLElement>('[data-t=views]')!.onclick = () => {
  vpop.hidden = !vpop.hidden;
  placePop(vpop, 'views');
  toolbar.querySelector('[data-t=views]')!.classList.toggle('on', !vpop.hidden);
};
toolbar.querySelector<HTMLElement>('[data-t=group]')!.onclick = () => { tree.groupSelected(); updateTools(); };
// ---- CAD models: load a .glb from the vault's CAD folder (or upload one from disk), remove one ----
const cadpop = toolbar.querySelector<HTMLElement>('.cadpop')!;
const cadList = (): any[] => cfg.cad_models ?? [];
let cadBusy = '';
/** Write the scene's CAD list; the studio mounts again to load it. */
function setCad(list: any[]) {
  edit({ scene: { ...clone(model.scene ?? {}), cad_models: list } });
  if (io.reload) io.reload(); else location.reload();
}
function addCad(file: string) {
  const list = cadList();
  if (list.some((m) => m.file === file)) { toast(`${file} is already loaded`); return; }
  const base = (file.split('/').pop() ?? 'cad').replace(/\.glb$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'cad';
  let id = base, i = 2;
  while (list.some((m) => m.id === id)) id = `${base}-${i++}`;
  // the converter writes Y-up metres; the first model stands centred on the origin, later ones keep their coordinates
  setCad([...list, { id, file, up: 'y', ground: list.length === 0, position: [0, 0, 0] }]);
}
async function renderCad() {
  const list = cadList();
  const mb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
  cadpop.innerHTML = `<b>CAD models in this animation</b>
    ${list.length ? list.map((m, i) => `<div class="row"><span class="n" title="${escH(m.file)}">${escH(m.id)} <span class="hint">${escH(m.file)}</span></span>
      <button data-c="del" data-i="${i}" title="Remove from this animation (the file stays in the vault)">✕</button></div>`).join('') : '<div class="hint">None yet.</div>'}
    <b style="margin-top:6px">Add</b>
    <div class="vault"><div class="hint">Loading the vault's CAD folder…</div></div>
    <button data-c="up" ${cadBusy ? 'disabled' : ''}>⤒ Upload a .glb from disk…</button>
    ${cadBusy ? `<div class="hint busy">${escH(cadBusy)}</div>` : ''}
    <div class="hint">Convert STEP files with tools/step2gltf.py (--split for very big ones). Part ids start with the model's id.</div>`;
  cadpop.querySelectorAll<HTMLElement>('[data-c=del]').forEach((b) => (b.onclick = () => {
    const m = list[+b.dataset.i!];
    if (!confirm(`Remove ${m.id} (${m.file}) from this animation?\nScript lines and groups that use its parts will show errors. The file stays in the vault.`)) return;
    setCad(list.filter((_, j) => j !== +b.dataset.i!));
  }));
  cadpop.querySelector<HTMLElement>('[data-c=up]')!.onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.glb,model/gltf-binary';
    inp.onchange = () => { const f = inp.files?.[0]; if (f) void uploadCad(f); };
    inp.click();
  };
  const box = cadpop.querySelector<HTMLElement>('.vault')!;
  if (!io.files) { box.innerHTML = '<div class="hint">(no vault access)</div>'; return; }
  try {
    const files = (await io.files.list('CAD')).filter((f) => /\.glb$/i.test(f.path) && !list.some((m) => m.file === f.path));
    box.innerHTML = files.length
      ? files.map((f) => `<div class="row"><button class="n" data-f="${escH(f.path)}" title="Load ${escH(f.path)} into this animation">＋ ${escH(f.path.replace(/^CAD\//, ''))}</button><span class="hint">${mb(f.size)}</span></div>`).join('')
      : '<div class="hint">No other .glb files in the vault\'s CAD folder.</div>';
    box.querySelectorAll<HTMLElement>('[data-f]').forEach((b) => (b.onclick = () => addCad(b.dataset.f!)));
  } catch (e) { box.innerHTML = `<div class="hint">Couldn't list the CAD folder: ${escH(String(e))}</div>`; }
  placePop(cadpop, 'cad');
}
async function uploadCad(f: File) {
  if (!io.files) return;
  if (!/\.glb$/i.test(f.name)) { alert('Pick a .glb file (convert STEP with tools/step2gltf.py).'); return; }
  const path = `CAD/${f.name}`;
  const go = async (overwrite: boolean) => io.files!.upload(path, f, (x) => { cadBusy = `Uploading ${f.name}: ${Math.round(x * 100)}%`; const h = cadpop.querySelector('.busy'); if (h) h.textContent = cadBusy; }, overwrite);
  cadBusy = `Uploading ${f.name}…`; void renderCad();
  try {
    let r = await go(false);
    if (r === 'exists') {
      if (!confirm(`The vault already has ${path}. Replace it? (Other animations that use it will load the new file.)`)) { cadBusy = ''; void renderCad(); return; }
      r = await go(true);
    }
    cadBusy = '';
    addCad(path);
  } catch (e) { cadBusy = ''; alert(`Upload failed: ${e}`); void renderCad(); }
}
function toggleCad(open = cadpop.hidden) {
  cadpop.hidden = !open;
  toolbar.querySelector('[data-t=cad]')!.classList.toggle('on', open);
  if (open) void renderCad();
}
toolbar.querySelector<HTMLElement>('[data-t=cad]')!.onclick = () => toggleCad();
// an empty animation: say how to start (gone once the scene has parts, however they got there)
let emptyPrompt: HTMLElement | undefined;
if (!cadList().length && !(model.shapes ?? []).length) {
  const empty = emptyPrompt = document.createElement('div');
  empty.style.cssText = 'position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);z-index:5;text-align:center;color:#d7dde4;font:13px system-ui;background:rgba(14,17,21,.9);border:1px solid #2b3540;border-radius:8px;padding:16px 20px;display:flex;flex-direction:column;gap:10px;align-items:center';
  empty.innerHTML = `<div>This animation has no 3D model yet.</div>
    <button data-e="cad" style="padding:6px 14px;background:#1b222a;color:#f2b705;border:1px solid #f2b705;border-radius:5px;cursor:pointer;font:inherit">📦 Load a CAD model (.glb)…</button>
    <div style="color:#7b8794;font-size:11px">or add shapes with the Shape tool</div>`;
  empty.querySelector<HTMLElement>('[data-e=cad]')!.onclick = () => { empty.remove(); toggleCad(true); };
  host().appendChild(empty);
  toolbar.querySelector<HTMLElement>('[data-t=shape]')!.addEventListener('click', () => empty.remove());
}
updateTools();

// ---------- loop ----------
const clock = new THREE.Clock();
player.seek(Number(new URLSearchParams(location.search).get('t') ?? 0));
renderer.setAnimationLoop(() => {
  if (emptyPrompt && built.root.getObjectByProperty('isMesh', true)) { emptyPrompt.remove(); emptyPrompt = undefined; }
  renderer.info.reset();
  const dt = Math.min(clock.getDelta(), 0.1);
  if (player.playing) player.tick(dt); else player.seek(player.time);

  const cutNow = ui.cutaway === 'script' ? (player.current('cutaway')?.value ?? 'none') as Cut | CutMode : uiCut();
  applyCut(cutNow);

  if (ui.followCamera) { camera.position.copy(player.tl.camera.pos); controls.target.copy(player.tl.camera.look); }
  controls.update();

  const lbl = player.current('label');
  chapterEl.textContent = lbl?.value ?? '';
  subEl.textContent = lbl?.sub ?? '';
  clockEl.textContent = `${player.time.toFixed(1)} / ${player.duration.toFixed(1)} s${player.playing ? '' : '  (paused)'}`;
  if (ui.time !== player.time) { ui.time = player.time; timeCtl.updateDisplay(); }

  tree.update();
  scriptPanel?.setTiming(player.tl.lines, player.time);
  drawFrame();
  triad.render(renderer, camera, host().classList.contains('tree-collapsed') ? 12 : 352);
});

// ?debug: dump CAD ids + stats into the DOM (for headless checks)
if (new URLSearchParams(location.search).has('debug') && new URLSearchParams(location.search).get('debug') !== 'assist') {
  const pre = document.createElement('pre'); pre.id = 'debug'; pre.style.display = 'none';
  const ids = [...built.registry.keys()].filter((k) => k.startsWith('plant'));
  const supp: string[] = [];
  built.root.traverse((o) => { if (o.userData.suppressed) supp.push(o.userData.id); });
  const before = cad.stats();
  // ?debug=restore: unhide everything and check suppressed geometry comes back
  if (new URLSearchParams(location.search).get('debug') === 'restore') {
    for (const k of Object.keys(state.hidden)) delete state.hidden[k];
    for (const o of built.root.children) await reconcile(o);
  }
  const after: string[] = [];
  built.root.traverse((o) => { if (o.userData.suppressed) after.push(o.userData.id); });
  pre.textContent = JSON.stringify({ ids, supp, before, after: { supp: after, cad: cad.stats() } }, null, 1);
  host().appendChild(pre);
}

// ?debug=assist: run each read tool and dump the results (headless check without the API)
if (new URLSearchParams(location.search).get('debug') === 'assist') {
  const out: Record<string, any> = {};
  const call = async (name: string, input: any) => {
    const g = tools.find((t) => t.name === name)!.run(input);
    let r = await g.next(); while (!r.done) r = await g.next();
    const c = r.value.content;
    return typeof c === 'string' ? c : (c as any[]).map((b) => b.type === 'image' ? `<image ${b.source.data.length} b64 chars>` : b.text).join(' ');
  };
  out.find = await call('find_parts', { query: 'R1-1/L1*', limit: 5 });
  out.part = await call('get_part', { id: 'head' });
  out.tree = (await call('get_tree', { depth: 2 })).split('\n').slice(0, 8).join('\n');
  out.checkBad = await call('check_script', { text: 'move head by [0,1,0] 2s\nbogus\nmove nope by [1,0,0] 1s' });
  out.checkOk = await call('check_script', { text: 'label "a"\nmove head by [0,3,0] 2s\nwait 1s' });
  out.shot = await call('screenshot', { view: 'iso', target: 'head' });
  out.contextChars = (await assistContext()).length;
  const pre = document.createElement('pre'); pre.id = 'debug'; pre.style.display = 'none';
  pre.textContent = JSON.stringify(out, null, 1); host().appendChild(pre);
}

// ?debug=proposal: inject a proposal made by the real tool (headless check of the card)
if (new URLSearchParams(location.search).get('debug') === 'proposal' && scriptPanel) {
  const t = tools.find((x) => x.name === 'propose_script_edit')!;
  const draft = scriptPanel.text.replace(/^wait 2s$/m, 'wait 1s\nmove head by [0,3,0] 4s\nhighlight head spent 1s');
  const g = t.run({ text: draft, summary: 'Lift the head 3 m and mark it' });
  let prop: any;
  for (let r = await g.next(); !r.done; r = await g.next()) if (r.value.type === 'proposal') { const { type: _t, ...p } = r.value; prop = p; }
  assistHost.onChat([...chat, { role: 'user', content: 'Lift the head 3 m' }, { role: 'assistant', content: 'Here is a change that lifts the head.', proposal: prop }]);
  assist?.refresh();
}

// ?debug=model-proposals: run propose_groups / propose_state and apply them (headless check; nothing is saved)
if (new URLSearchParams(location.search).get('debug') === 'model-proposals') {
  const run = async (name: string, input: any) => {
    const g = tools.find((x) => x.name === name)!.run(input); let p: any, r = await g.next();
    for (; !r.done; r = await g.next()) if (r.value.type === 'proposal') p = r.value;
    return { p, result: r.value.content };
  };
  const out: any = {};
  const g1 = await run('propose_groups', { summary: 'Group the head and its bolts', changes: [{ action: 'create', name: 'lid-set', parts: ['head', 'bolts'] }] });
  out.groupsCheck = g1.p.check; out.groupsResult = g1.result;
  applyGroupChanges(g1.p.changes); out.groupsAfter = store.groups['lid-set'];
  const g2 = await run('propose_groups', { summary: 'bad', changes: [{ action: 'add', name: 'nope', parts: ['ghost'] }] });
  out.badCheck = g2.p.check; out.badProblems = g2.p.problems;
  const s1 = await run('propose_state', { summary: 'Unlock and show the lid set', changes: [{ targets: ['@lid-set', 'R1-1/L1*'], lock: false, hide: false }] });
  out.stateCheck = s1.p.check;
  await applyStateChanges(s1.p.changes);
  out.after = { headLocked: isLocked(built.registry.get('head')!), headHidden: isHidden(built.registry.get('head')!), L10hidden: isHidden(built.registry.get('R1-1/L10')!), dirty: isDirty() };
  const pre = document.createElement('pre'); pre.id = 'debug2'; pre.style.display = 'none';
  pre.textContent = JSON.stringify(out, null, 1); host().appendChild(pre);
}

// read-only handle for tests and debugging
(window as any).__studio = { boxSelect, get copies() { return copies; }, duplicateSelection, renderSheetPng, svgToPdf, vectorDrawing, exportSvg, runSheet, previewSheet, saveAllSheets, get drawPanel() { return drawPanel; }, built, state, store, cad, tree, tools, camera, controls, ui, setOrigin, renderThumb, thumbFrame, capUniforms, withCaps, caps, drawing, renderer, scene3, drawFrame, THREE,
  /** tests: a block with many small parts buried behind the cut plane (x < 0), like dowels without holes */
  addTestBuried: (count = 60) => {
    const mk = (col: number) => withCaps(new THREE.MeshToonMaterial({ color: col, side: THREE.DoubleSide, clippingPlanes: built.clipPlanes, clipIntersection: true }));
    const b = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), mk(0x8f8fb0)); b.position.y = 1; b.userData.id = 'test-big'; built.root.add(b);
    for (let i = 0; i < count; i++) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 16), mk(0xb0b0b0));
      c.position.set(-0.15 - (i % 6) * 0.22, 0.4 + Math.floor(i / 6) % 5 * 0.3, -1.2 + (i * 0.37) % 2.4); c.userData.id = `test-pin-${i}`; built.root.add(c);
    }
  },
  /** tests: a block with a dowel overlapping it (no modelled hole – common in CAD assemblies) */
  addTestDowel: () => {
    const mk = (col: number) => withCaps(new THREE.MeshToonMaterial({ color: col, side: THREE.DoubleSide, clippingPlanes: built.clipPlanes, clipIntersection: true }));
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), mk(0x6f8fd0)); b.position.y = 0.5; b.userData.id = 'test-block'; built.root.add(b);
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.6, 32), mk(0xd0d06f)); d.position.y = 0.8; d.userData.id = 'test-dowel'; built.root.add(d);
  },
  /** tests: three touching boxes stacked (the joints are where back-face caps failed), each with a hole */
  addTestStack: () => {
    const cols = [0x6fa86f, 0x6f8fd0, 0xd08f6f];
    cols.forEach((col, i) => {
      const m = withCaps(new THREE.MeshToonMaterial({ color: col, side: THREE.DoubleSide, clippingPlanes: built.clipPlanes, clipIntersection: true }));
      const b = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), m); b.position.y = 0.5 + i; b.userData.id = `test-block-${i}`; built.root.add(b);
    });
  },
  /** tests: a closed 2 m box at the origin with a capped, clipped part material */
  addTestBox: () => {
    const m = withCaps(new THREE.MeshToonMaterial({ color: 0xd0d0d0, side: THREE.DoubleSide, clippingPlanes: built.clipPlanes, clipIntersection: true }));
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), m); b.position.y = 1; built.root.add(b);
  }, assist: { host: assistHost, mount: assist }, get player() { return player; }, get scriptPanel() { return scriptPanel; } };

return {
  dispose() {
    disposed = true;
    scriptPanel?.destroy();
    clearTimeout(chatTimer); clearTimeout(thumbTimer);
    assist?.dispose();
    renderer.setAnimationLoop(null);
    ac.abort(); ro.disconnect();
    gizmo.dispose?.(); controls.dispose();
    gui.destroy();
    renderer.dispose();
    root.replaceChildren();
  },
};
}

/** The generated reactor's config defaults (buildScene needs them even when generated:false drops it). */
function withGeneratedDefaults(c: any) {
  return {
    generated: false,
    core: { rings: 5, pitch: 0.36, gap: 0.01, fuel_rings: 3, block_height: 0.8, layers: { bottom_reflector: 2, fuel: 8, top_reflector: 2 } },
    vessel: { inner_radius: 2.2, wall: 0.12, bottom_gap: 1.0, top_gap: 0.6 },
    head: { height: 1.1, flange: 0.25, bolts: 24 },
    machine: { mast_length: 12 },
    locations: {}, fresh: { count: 0 },
    ...c,
  };
}
