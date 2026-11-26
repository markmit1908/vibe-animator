import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_PALETTE_KEY, palette } from '../view/palette';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import GUI from 'lil-gui';
import { buildScene } from '../scene/build';
import { compile } from '../timeline/compile';
import { Player } from '../timeline/player';
import { fitVerticalCylinder, planeHeight } from '../scene/origin';
import { capUniforms, SectionCaps, withCaps } from '../view/caps';
import { applyCutaway, cutLine, DEFAULT_SIDES, type Cut, type CutMode, type CutSide } from '../view/cutaway';
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
import { readTools, proposeTools, modelProposeTools, type ToolDeps } from '../assist/tools';
import type { Proposal } from '../assist/loop';
import { parseAnim, toActions, type ParseError } from '../script/anim';
import { ScriptError } from '../timeline/compile';
import { applyEdit, cameraLine, type Edit, type Probe } from '../script/edit';

/** What the studio needs from its host app (SolverKit's editor). */
export interface StudioIO {
  /** Persist fields of the model (SolverKit: ctx.edit – autosaved, versioned). */
  edit(patch: Partial<AnimModel>): void;
  /** URL of a vault file (CAD .glb). */
  fileUrl(path: string): string;
  /** The assist key proxy. */
  assist: { base: string; status: string };
  /** Mount the assist panel (SolverKit's AssistPanel) into `el`. */
  mountAssist?(el: HTMLElement, host: AssistHost): AssistMount;
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
};

// ---------- undo / redo (⌘/Ctrl+Z, ⇧⌘Z / Ctrl+Y) of the animation's state ----------
// Every change goes through edit(): before the first change of a burst (400 ms), the state as it was is pushed.
// Script typing has the editor's own undo; script changes made by code (gizmo write-back, an accepted proposal) undo here.
type UndoKey = 'colors' | 'snapshots' | 'groups' | 'labels' | 'removed' | 'script' | 'views';
const UNDO_KEYS: UndoKey[] = ['colors', 'snapshots', 'groups', 'labels', 'removed', 'script', 'views'];
type DocState = Partial<Record<UndoKey, any>>;
const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const docNow: DocState = {
  colors: model.colors ?? {}, snapshots: model.snapshots ?? { active: 'default', items: {} }, groups: model.groups ?? {},
  labels: model.labels ?? {}, removed: model.removed ?? [], views: model.views ?? {}, script: model.script ? { language: 'anim', text: joinLines(model.script.text) } : undefined,
};
const undoStack: DocState[] = [], redoStack: DocState[] = [];
let undoing = false, typing = false, burst = false, burstTimer: number | undefined;
function recordUndo(patch: Partial<AnimModel>) {
  const keys = UNDO_KEYS.filter((k) => k in patch);
  if (!keys.length) return;
  const changed = keys.filter((k) => JSON.stringify((patch as any)[k]) !== JSON.stringify(docNow[k]));
  if (!changed.length) return;
  if (typing && changed.every((k) => k === 'script')) {
    // typed: the editor's undo owns it; older entries must not bring back the script from before the typing
    for (const e of [...undoStack, ...redoStack]) delete e.script;
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
setStore({ active: model.snapshots?.active ?? 'default', snapshots: model.snapshots?.items ?? {}, groups: model.groups ?? {} });
setStoreWriter((st) => edit({ snapshots: { active: st.active, items: st.snapshots }, groups: st.groups }));
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
// ---------- [Script | Assist] tabs ----------
const tabs = document.createElement('div'); tabs.className = 'rtabs';
tabs.innerHTML = `<button data-t="script" class="on">Script</button><button data-t="assist">Assist</button>`;
const tabCss = document.createElement('style');
tabCss.textContent = `#right { position: absolute; top: 0; right: 0; bottom: 0; width: 420px; display: flex; flex-direction: column; z-index: 5;
  background: rgba(14,17,21,.95); border-left: 1px solid #222a33; }
#right.collapsed { transform: translateX(420px); }
#right .lil-gui.root { width: 100% !important; --width: 100%; max-height: 45vh; overflow: auto; flex: none; }
#right-toggle { position: absolute; top: 8px; right: 428px; z-index: 6; background:#222a33; color:#d7dde4; border:1px solid #2b3540; border-radius:4px; padding:3px 8px; cursor:pointer; }
.studio-root.right-collapsed #right-toggle { right: 8px; }
#right .rtabs { display: flex; border-top: 1px solid #222a33; } #right .rtabs button { flex: 1; background: transparent; color: #7b8794; border: 0; border-bottom: 2px solid transparent; padding: 6px; cursor: pointer; font: 600 12px system-ui; }
  #right .rtabs button.on { color: #f2b705; border-bottom-color: #f2b705; } #script, #assist { border-top: 0 !important; } #assist { flex: 1; min-height: 0; display: flex; flex-direction: column; }`;
document.head.appendChild(tabCss);
right.insertBefore(tabs, scriptPanel?.el ?? null);
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
      for (const id of built.registry.keys()) if (re.test(id)) { ids.add(id); hit = true; }
      if (!hit) unknown.push(s0);
      continue;
    }
    if (built.registry.has(s0)) ids.add(s0); else unknown.push(s0);
  }
  return { ids: [...ids], unknown };
}
const tools = [
  ...readTools(toolDeps),
  ...proposeTools({ checkScript: toolDeps.checkScript, currentScript: () => scriptPanel?.text ?? '' }),
  ...modelProposeTools({ resolve: resolveIds, groups: () => store.groups }),
];

/** Apply accepted group changes (ancestor-covered members dropped, as the tree does). */
function applyGroupChanges(changes: { action: string; name: string; ids: string[] }[]) {
  for (const c of changes) {
    if (c.action === 'delete') { delete store.groups[c.name]; continue; }
    const cur = new Set(c.action === 'create' ? [] : store.groups[c.name] ?? []);
    if (c.action === 'remove') c.ids.forEach((x) => cur.delete(x)); else c.ids.forEach((x) => cur.add(x));
    const objs = [...cur].map((x) => built.registry.get(x)).filter(Boolean) as THREE.Object3D[];
    const covered = (o: THREE.Object3D) => { for (let p = o.parent; p; p = p.parent) if (objs.includes(p)) return true; return false; };
    store.groups[c.name] = objs.filter((o) => !covered(o)).map(idOfObj);
  }
  edit({ groups: JSON.parse(JSON.stringify(store.groups)) });
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
async function applyStateChanges(changes: { ids: string[]; targets?: string[]; lock?: boolean; hide?: boolean; color?: string | null; remove?: boolean }[]) {
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
};
tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => showTab(b.dataset.t!)));
showTab(new URLSearchParams(location.search).get('tab') ?? (scriptPanel ? 'script' : 'assist'));

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
Groups: ${Object.entries(store.groups).map(([g, ids]) => `@${g} (${ids.length} members)`).join(', ') || 'none'}
Snapshot: ${store.active}. Explicitly hidden: ${hidden.length ? hidden.slice(0, 20).join(', ') + (hidden.length > 20 ? ` … ${hidden.length - 20} more` : '') : 'none'}. Unlocked (animatable) CAD: ${unlocked.length ? unlocked.slice(0, 20).join(', ') + (unlocked.length > 20 ? ' …' : '') : 'none – CAD is locked by default'}.

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
  onGroups: () => { buildTimeline(); edit({ groups: JSON.parse(JSON.stringify(store.groups)) }); }, // groups are part of the animation: saved at once
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
  // start pose: record placements for every member
  for (const m of d.members) state.placements[idOfObj(m.o)] = { p: m.o.position.toArray(), q: m.o.quaternion.toArray() };
  persistWorking();
  buildTimeline();
});
on('keydown', (e: any) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).closest?.('.cm-editor')) return;
  if (e.key === 'w') gizmo.setMode('translate');
  if (e.key === 'H' && !e.metaKey && !e.ctrlKey) void blankOthers();
  if (e.key === 'f' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleFind(true); }
  if (e.key === 'h' && !e.metaKey && !e.ctrlKey) { tree.toggleHiddenSelected(); updateTools(); }
  if (e.key === 'g' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); tree.groupSelected(); updateTools(); }
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
function drawFrame() {
  if (!drawing.enabled) { renderer.render(scene3, camera); caps.render(renderer, scene3, camera, null); return; }
  if (drawing.overlay) { renderer.render(scene3, camera); caps.render(renderer, scene3, camera, null); }   // shaded + outline: the cel-shaded frame, lines on top
  drawing.render(scene3, camera);
  const h = gizmo.getHelper();
  if (gizmo.object) { renderer.autoClear = false; renderer.clearDepth(); renderer.render(h, camera); renderer.autoClear = true; }
}

// ---------- undo / redo: restore a recorded state in place ----------
const undoToast = document.createElement('div');
undoToast.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:8;background:rgba(14,17,21,.95);color:#d7dde4;border:1px solid #2b3540;border-radius:6px;padding:5px 12px;font:12px system-ui;display:none;pointer-events:none';
host().appendChild(undoToast);
let toastTimer: number | undefined;
const WHAT: Record<UndoKey, string> = { colors: 'colour', snapshots: 'move / lock / hide', groups: 'groups', labels: 'rename', removed: 'remove / restore', script: 'script edit', views: 'views' };
async function restoreDoc(d: DocState, verb: string) {
  const what = UNDO_KEYS.filter((k) => d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(docNow[k])).map((k) => WHAT[k]);
  undoing = true;
  try {
    const t = player.time;
    player.seek(0);
    if (d.groups) store.groups = clone(d.groups);
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
    for (const o of built.root.children) await reconcile(o);
    if (d.script && scriptPanel && d.script.text !== scriptPanel.text) {
      docNow.script = clone(d.script);
      scriptPanel.setText(d.script.text);            // recompiles (not recorded: undoing)
    }
    buildTimeline({ atStart: true });
    player.seek(Math.min(t, player.duration));
    edit({ colors: { ...colors }, snapshots: { active: store.active, items: clone(store.snapshots) }, groups: clone(store.groups), labels: { ...labels }, removed: [...removed], views: clone(views) });
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
  <button data-t="find" title="Select by name: every part whose name contains the text (or matches a glob with *), e.g. V-005202-001 – then Blank, Group, colour… (F)"><span class="i">⌕</span><span class="l">Select by name</span></button>
  <div class="fpop" hidden><input placeholder="Part of a name, e.g. V-005202-001" spellcheck="false"><div class="hint"></div><button data-f="go">Select</button></div>
  <button data-t="showall" title="Show all: unblank every part (removed parts stay removed)"><span class="i">●</span><span class="l">Show all</span></button>
  <button data-t="origin" title="Set the model origin: click a cylindrical face (its axis), then a flat face (its height); the model moves so that point is (0,0,0)"><span class="i">⊕</span><span class="l">Set origin</span></button>
  <button data-t="views" title="Camera views: save the current view (position and target), go to one, or put it in the script (camera <name> 2s)"><span class="i">📷</span><span class="l">Views</span></button>
  <div class="vpop" hidden></div>
  <button data-t="group" title="Create a group from the selected parts, or add them to one (G)"><span class="i">⊞</span><span class="l">Group</span></button>`;
host().appendChild(toolbar);
{
  const css = document.createElement('style');
  css.textContent = `#toolsbar { position: absolute; left: 352px; top: 50%; transform: translateY(-50%); z-index: 6; display: flex; flex-direction: column; gap: 4px; padding: 4px;
      background: rgba(14,17,21,.9); border: 1px solid #2b3540; border-radius: 6px; font: 11px system-ui; }
    .studio-root.tree-collapsed #toolsbar { left: 12px; }
    #toolsbar button { width: 60px; text-align: center; line-height: 1.15; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 5px 2px; background: #1b222a; color: #d7dde4; border: 1px solid #2b3540; border-radius: 4px; cursor: pointer; font: inherit; }
    #toolsbar button .i { font-size: 16px; line-height: 1; }
    #toolsbar button:hover:not(:disabled) { background: #26303a; } #toolsbar button:disabled { opacity: .4; cursor: default; }
    #toolsbar button.on { border-color: #f2b705; color: #f2b705; }
    #toolsbar .vpop { position: absolute; left: calc(100% + 6px); top: 0; width: 250px; background: rgba(14,17,21,.97); border: 1px solid #2b3540; border-radius: 6px; padding: 8px; color: #d7dde4; display: flex; flex-direction: column; gap: 4px; }
    #toolsbar .vpop[hidden], #toolsbar .fpop[hidden] { display: none; }
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
  const blank = toolbar.querySelector<HTMLButtonElement>('[data-t=blank]')!, group = toolbar.querySelector<HTMLButtonElement>('[data-t=group]')!;
  blank.disabled = group.disabled = toolbar.querySelector<HTMLButtonElement>('[data-t=others]')!.disabled = !count;
  blank.querySelector('.l')!.textContent = allHidden ? 'Unblank' : 'Blank';
  blank.classList.toggle('on', allHidden);
}
toolbar.querySelector<HTMLElement>('[data-t=blank]')!.onclick = () => { tree.toggleHiddenSelected(); updateTools(); };
toolbar.querySelector<HTMLElement>('[data-t=others]')!.onclick = () => void blankOthers();
toolbar.querySelector<HTMLElement>('[data-t=showall]')!.onclick = () => void showAll();
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
}
renderViews();
toolbar.querySelector<HTMLElement>('[data-t=views]')!.onclick = () => {
  vpop.hidden = !vpop.hidden;
  toolbar.querySelector('[data-t=views]')!.classList.toggle('on', !vpop.hidden);
};
toolbar.querySelector<HTMLElement>('[data-t=group]')!.onclick = () => { tree.groupSelected(); updateTools(); };
updateTools();

// ---------- loop ----------
const clock = new THREE.Clock();
player.seek(Number(new URLSearchParams(location.search).get('t') ?? 0));
renderer.setAnimationLoop(() => {
  renderer.info.reset();
  const dt = Math.min(clock.getDelta(), 0.1);
  if (player.playing) player.tick(dt); else player.seek(player.time);

  const cutNow = ui.cutaway === 'script' ? (player.current('cutaway')?.value ?? 'none') as Cut | CutMode : uiCut();
  applyCutaway(built, cutNow);
  capUniforms.capOn.value = ui.caps && !(typeof cutNow === 'object' && cutNow.nocap) ? 1 : 0;

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
(window as any).__studio = { built, state, store, cad, tree, tools, camera, controls, ui, setOrigin, capUniforms, withCaps, caps, drawing, renderer, scene3, drawFrame, THREE,
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
  }, assist: { host: assistHost, mount: assist }, get player() { return player; } };

return {
  dispose() {
    disposed = true;
    scriptPanel?.destroy();
    clearTimeout(chatTimer);
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
