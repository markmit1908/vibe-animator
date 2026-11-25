import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import GUI from 'lil-gui';
import { buildScene } from '../scene/build';
import { compile } from '../timeline/compile';
import { Player } from '../timeline/player';
import { applyCutaway, type CutMode } from '../view/cutaway';
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
import { AssistPanel } from '../view/assistPanel';
import { ASSIST_SYSTEM } from '../assist/system';
import { readTools, proposeTools, modelProposeTools, lineDiff, type ToolDeps } from '../assist/tools';
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
}

/**
 * The animation studio (3D view, assembly tree, script editor, assist), mounted into `root` for one model.
 * Returns dispose(). The old single-page app (src/main.ts) is the same code over the dev server's endpoints.
 */
export async function mountStudio(root: HTMLElement, model: AnimModel, io: StudioIO): Promise<{ dispose(): void }> {
const ac = new AbortController();
let disposed = false;
/** Writes to the model; a disposed studio (replaced by a remount) must never write its older state. */
const edit = (patch: Partial<AnimModel>) => { if (!disposed) io.edit(patch); };
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
const renderer = new THREE.WebGLRenderer({ antialias: true });
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
/** Compile the current script. On error the previous timeline keeps playing. */
function buildTimeline(o: { atStart?: boolean } = {}): boolean {
  const t = player?.time ?? 0, playing = player?.playing ?? false;
  // compile from the start pose (positions, colours) – not the animated one. atStart: the caller already put the
  // scene at its start pose and changed it (base colours); the old player's reset would undo that change
  if (!o.atStart) player?.seek(0);
  try {
    const tl = compile(script, built, script.camera ?? defaultCam, (o) => isLocked(o) && !previewUnlocked.has(idOfObj(o)), store.groups, isRemoved);
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
        const find = (steps: any[]): any => { for (const st of steps) { if (st.line === e.line) return st; const c = st.children && find(st.children); if (c) return c; } };
        const tg = find(parseAnim(scriptPanel.text).steps)?.target?.value as string | undefined;
        if (tg) {
          const ids = resolveIds([tg]).ids.filter((x) => isLocked(built.registry.get(x)!));
          fix = { label: `Unlock ${tg}${ids.length > 1 ? ` (${ids.length} parts)` : ''}`, run: () => { applyStateChanges([{ ids, lock: false }]); } };
          e.message = `${tg} is locked (${ids.length} part${ids.length === 1 ? '' : 's'}) – unlock it to animate it`;
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
if (isAnim) {
  scriptPanel = new ScriptPanel(right, scriptName, animText, {
    change: (text) => {
      const doc = parseAnim(text);
      if (doc.errors.length) edit({ script: { language: 'anim', text } }); // keep the text even while it has errors
      scriptErrors = doc.errors;
      if (doc.errors.length) { scriptPanel!.setErrors(doc.errors); return; } // keep the last good timeline
      script = toActions(doc.steps);
      buildTimeline();
      edit({ script: { language: 'anim', text } });
    },
    save: async (text) => { edit({ script: { language: 'anim', text } }); },
    seek: (t) => { player.playing = false; player.seek(t); gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs); },
    ids: () => [...Object.keys(store.groups).map((g) => `@${g}`), ...built.registry.keys()],
    cameraLine: () => cameraLine(probe),
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
  #right .rtabs button.on { color: #f2b705; border-bottom-color: #f2b705; } #script, #assist { border-top: 0 !important; }`;
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
      // locked targets are reported, not errors: accepting a proposal unlocks them
      const locked = new Set<string>();
      const walk = (steps: any[]) => steps.forEach((st) => {
        const tg = st.target?.value;
        if (tg && ['move', 'rotate', 'hide', 'show', 'fade', 'highlight', 'pivot'].includes(st.verb)) {
          const r = resolveIds([tg]);
          if (r.ids.some((x) => isLocked(built.registry.get(x)!))) locked.add(tg);
        }
        if (st.children) walk(st.children);
      });
      walk(doc.steps);
      const tl = compile(acts, built, acts.camera ?? defaultCam, () => false, store.groups, isRemoved);
      const src = text.split('\n');
      return { errors: [], locked: [...locked], duration: tl.duration, steps: [...tl.lines].sort((a, b) => a[0] - b[0]).map(([line, x]) => ({ line, ...x, text: src[line - 1].trim() })) };
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
  assist.refreshCards();
}

// conversation is saved beside the script (scripts/<name>.chat.json)
const savedChat = (model.chat ?? []) as any[];
let chatTimer: number | undefined;
const assist = new AssistPanel(right, {
  saveHistory: (h) => {
    clearTimeout(chatTimer);
    chatTimer = window.setTimeout(() => edit({ chat: JSON.parse(JSON.stringify(h)) }), 300);
  },
  endpoints: io.assist,
  system: () => ASSIST_SYSTEM,
  context: async () => [{ type: 'text', text: await assistContext() }],
  tools: () => tools,
  insertCode: (code) => {
    if (!scriptPanel) return;
    const v = scriptPanel.view, l = v.state.doc.line(scriptPanel.cursorLine);
    v.dispatch({ changes: { from: l.to, insert: `\n${code.replace(/\n$/, '')}` } });
    showTab('script'); v.focus();
  },
  renderProposal: (p, el, decide) => {
    if (p.kind === 'groups' || p.kind === 'state') {
      const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const lines = p.kind === 'groups'
        ? (p.changes as any[]).map((c) => `${c.action} <b>@${esc(c.name)}</b>${c.ids.length ? ` – ${c.ids.length} part${c.ids.length > 1 ? 's' : ''}: ${esc(c.ids.slice(0, 4).map((x: string) => x.split('/').pop()).join(', '))}${c.ids.length > 4 ? ' …' : ''}` : ''}`)
        : (p.changes as any[]).map((c) => `${[c.lock === true ? '🔒 lock' : c.lock === false ? '🔓 unlock' : '', c.hide === true ? 'hide' : c.hide === false ? 'show' : '', c.color ? `colour <span style="display:inline-block;width:9px;height:9px;background:${c.color}"></span> ${c.color}` : c.color === null ? 'reset colour' : '', c.remove === true ? 'remove from assembly' : c.remove === false ? 'restore' : ''].filter(Boolean).join(' + ')} – ${esc((c.targets as string[]).join(', '))} (${c.ids.length} part${c.ids.length === 1 ? '' : 's'})`);
      const probs = (p.problems as string[] | undefined) ?? [];
      el.innerHTML = `<ul style="margin:6px 0;padding-left:18px">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
        ${probs.length ? `<div class="err">${probs.map(esc).join('<br>')}</div>` : ''}
        ${p.state ? '' : `<div style="display:flex;gap:6px"><button data-a="accept" ${p.check.ok ? '' : 'disabled'}>Accept</button><button data-a="reject">Reject</button></div>`}`;
      el.querySelector<HTMLElement>('[data-a=accept]')?.addEventListener('click', async () => {
        if (p.kind === 'groups') applyGroupChanges(p.changes as any); else await applyStateChanges(p.changes as any);
        decide('accepted');
      });
      el.querySelector<HTMLElement>('[data-a=reject]')?.addEventListener('click', () => decide('rejected'));
      return;
    }
    if (p.kind !== 'script edit') return;
    const diff = lineDiff(String(p.base ?? ''), String(p.text));
    // show changes with 2 lines of context
    const keep = diff.map((_, i) => diff.slice(Math.max(0, i - 2), i + 3).some(([k]) => k !== ' '));
    let html = '', gap = false;
    diff.forEach(([k, l], i) => {
      if (!keep[i]) { if (!gap) html += '<div style="color:#5b6670">⋯</div>'; gap = true; return; }
      gap = false;
      const c = k === '+' ? 'background:#16301c;color:#9be9a8' : k === '-' ? 'background:#3a1a1a;color:#ffaaaa;text-decoration:line-through' : 'color:#7b8794';
      html += `<div style="${c}">${k} ${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`;
    });
    const errs = (p.errors as any[] | undefined) ?? [];
    el.innerHTML = `<pre style="max-height:260px;overflow:auto;margin:6px 0;padding:4px 6px;background:#0a0c0f;border-radius:4px;font:11px ui-monospace,monospace;white-space:pre">${html}</pre>
      ${errs.length ? `<div class="err">${errs.map((e) => `line ${e.line}: ${e.message}`).join('<br>').replace(/</g, '&lt;').replace(/&lt;br>/g, '<br>')}</div>` : ''}
      ${p.state ? '' : `<div style="display:flex;gap:6px;margin-top:4px">
        ${p.check.ok ? `<button data-a="preview">${previewing === p ? '■ End preview' : '▶ Preview'}</button>` : ''}
        <button data-a="accept" ${p.check.ok ? '' : 'title="It does not compile – you can still accept and fix it in the editor"'}>${(p.unlock as string[] | undefined)?.length ? `Accept + unlock ${(p.unlock as string[]).join(', ')}` : 'Accept'}</button>
        <button data-a="reject">Reject</button></div>`}`;
    el.querySelector<HTMLElement>('[data-a=preview]')?.addEventListener('click', () => previewProposal(previewing === p ? undefined : p));
    el.querySelector<HTMLElement>('[data-a=accept]')?.addEventListener('click', async () => {
      if (!scriptPanel) return;
      if (scriptPanel.text !== p.base && !confirm('The script has changed since this was proposed. Replace it with the proposal anyway?')) return;
      if (previewing) previewProposal(undefined);
      const unlock = (p.unlock as string[] | undefined) ?? [];
      if (unlock.length) await applyStateChanges([{ ids: resolveIds(unlock).ids, lock: false }]); // the script needs these movable
      scriptPanel.setText(String(p.text));
      decide('accepted');
      showTab('script');
    });
    el.querySelector<HTMLElement>('[data-a=reject]')?.addEventListener('click', () => { if (previewing === p) previewProposal(undefined); decide('rejected'); });
  },
}, Array.isArray(savedChat) ? savedChat : []);
const showTab = (t: string) => {
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (scriptPanel) scriptPanel.el.style.display = t === 'script' ? '' : 'none';
  assist.el.style.display = t === 'assist' ? '' : 'none';
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
    for (const o of objs) await reconcile(o);
    persistWorking();
    if (what === 'locked') { buildTimeline(); gizmoFor(gSel.objs.length === 1 ? gSel.objs[0] : undefined, gSel.spec, gSel.objs); }
  },
  onSelect: (o, spec, objs, clicked) => {
    gizmoFor(o, spec, objs);
    if (clicked && scriptPanel?.picking) scriptPanel.insertTarget(shortSpec(clicked.spec), clicked.add); // pick mode: into the script
  },
  colorOf: (spec) => colors[spec],
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
  edit({ view: { camera: camView(), time: player.time, mode: drawing.enabled ? 'hidden' : 'shaded' } });
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
  if (e.key === 'e') gizmo.setMode('rotate');
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
  camera.near = Math.max(0.01, r / 500); camera.far = r * 20; camera.updateProjectionMatrix();
  controls.update();
}
let lastView = 'view';
function exportPng() {
  const pr = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.min(4, pr * 2)); // 2× resolution
  renderer.setSize(W(), H(), false);
  drawFrame();
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setPixelRatio(pr); renderer.setSize(W(), H(), false);
  const a = document.createElement('a');
  a.href = url; a.download = `${scriptName.replace(/\.\w+$/, '')}-${drawing.enabled ? 'hidden-line' : 'shaded'}-${lastView}-t${player.time.toFixed(1)}s.png`;
  a.click();
}
{
  const css = document.createElement('style');
  css.textContent = `#viewbar { position: absolute; top: 8px; right: 468px; z-index: 6; display: flex; gap: 4px; padding: 4px; background: rgba(14,17,21,.9); border: 1px solid #2b3540; border-radius: 6px; font: 12px system-ui; }
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
  bar.innerHTML = `<div class="grp"><button data-m="shaded" class="on" title="Shaded (cel) view">Shaded</button><button data-m="hidden" title="Hidden line: visible edges only, black on white">Hidden line</button></div>
    <div class="sep"></div>
    <div class="grp"><button data-v="iso">Iso</button><button data-v="front">Front</button><button data-v="top">Top</button><button data-v="side">Side</button><button data-v="fit" title="Fit everything visible in the current direction">Fit</button></div>
    <div class="sep"></div>
    <button data-a="png" title="Save the view as a PNG at 2× resolution">⤓ PNG</button>
    <button data-a="cfg" title="Hidden-line settings">⚙</button>
    <div class="pop" hidden>
      <label>Line weight <input type="range" data-k="thickness" min="0.5" max="4" step="0.25"><span></span></label>
      <label>Crease angle <input type="range" data-k="angle" min="5" max="90" step="1"><span></span></label>
      <label>Outline sensitivity <input type="range" data-k="depth" min="1" max="20" step="1"><span></span></label>
      <label>Line colour <input type="color" data-k="line"></label>
      <label>Paper colour <input type="color" data-k="paper"></label>
      <button data-a="reset">Reset</button>
    </div>`;
  host().appendChild(bar);
  const setMode = (m: string) => {
    drawing.enabled = m === 'hidden';
    host().classList.toggle('paper', drawing.enabled);
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
  const DEF = { thickness: 1, angle: 41, depth: 4, line: '#111111', paper: '#ffffff' };
  let cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('hiddenLine') ?? '{}')); } catch { /* storage unavailable */ }
  const pop = bar.querySelector<HTMLElement>('.pop')!;
  const apply = () => {
    drawing.thickness = cfg.thickness;
    drawing.normalThreshold = 1 - Math.cos(THREE.MathUtils.degToRad(cfg.angle));
    drawing.depthThreshold = cfg.depth / 1000;
    drawing.lineColor.set(cfg.line); drawing.paperColor.set(cfg.paper);
    pop.querySelectorAll<HTMLInputElement>('input').forEach((i) => {
      const v = (cfg as any)[i.dataset.k!]; i.value = String(v);
      const out = i.nextElementSibling as HTMLElement | null;
      if (out?.tagName === 'SPAN') out.textContent = i.dataset.k === 'angle' ? `${v}°` : i.dataset.k === 'thickness' ? `${v}px` : String(v);
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
  if (!drawing.enabled) { renderer.render(scene3, camera); return; }
  drawing.render(scene3, camera);
  const h = gizmo.getHelper();
  if (gizmo.object) { renderer.autoClear = false; renderer.clearDepth(); renderer.render(h, camera); renderer.autoClear = true; }
}

// ---------- loop ----------
const clock = new THREE.Clock();
player.seek(Number(new URLSearchParams(location.search).get('t') ?? 0));
renderer.setAnimationLoop(() => {
  renderer.info.reset();
  const dt = Math.min(clock.getDelta(), 0.1);
  if (player.playing) player.tick(dt); else player.seek(player.time);

  const mode = (ui.cutaway === 'script' ? player.current('cutaway')?.value ?? 'none' : ui.cutaway) as CutMode;
  applyCutaway(built, mode);

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
  const msg: any = { role: 'assistant', content: 'Here is a change that lifts the head.', proposals: [] };
  for (let r = await g.next(); !r.done; r = await g.next()) if (r.value.type === 'proposal') msg.proposals.push(r.value.proposal);
  assist.history.push({ role: 'user', content: 'Lift the head 3 m' }, msg);
  assist.refreshCards();
}

// ?debug=model-proposals: run propose_groups / propose_state and apply them (headless check; nothing is saved)
if (new URLSearchParams(location.search).get('debug') === 'model-proposals') {
  const run = async (name: string, input: any) => {
    const g = tools.find((x) => x.name === name)!.run(input); let p: any, r = await g.next();
    for (; !r.done; r = await g.next()) if (r.value.type === 'proposal') p = r.value.proposal;
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
(window as any).__studio = { built, state, store, cad, tree };

return {
  dispose() {
    disposed = true;
    scriptPanel?.destroy();
    clearTimeout(chatTimer);
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
