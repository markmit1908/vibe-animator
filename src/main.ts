import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import GUI from 'lil-gui';
import { parse } from 'yaml';
import coreYaml from '../scenes/core.yaml?raw';
import { buildScene } from './scene/build';
import { compile } from './timeline/compile';
import { Player } from './timeline/player';
import { applyCutaway, type CutMode } from './view/cutaway';
import { CadManager } from './scene/cad';
import { loadStore, store, useSnapshot, captureSnapshot, writeStore, markDirty, isDirty, onDirtyChange,
  isLocked, isHidden, isCad, state, type Snapshot } from './scene/state';
import { TreePanel } from './view/tree';
import { Triad } from './view/triad';

const cfg = parse(coreYaml);
const scripts = import.meta.glob('../scripts/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const scriptName = cfg.script ?? 'refuel.yaml';
const script = parse(scripts[`../scripts/${scriptName}`] ?? 'timeline: []') ?? {};

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.localClippingEnabled = true;
renderer.info.autoReset = false; // reset once per frame so stats cover the main scene + triad
document.getElementById('app')!.appendChild(renderer.domElement);

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(cfg.palette.background);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const built = buildScene(cfg);
scene3.add(built.root);

const chapterEl = document.getElementById('chapter')!;
const subEl = document.getElementById('sub')!;
const clockEl = document.getElementById('clock')!;

// ---------- CAD models (glTF in public/) – loaded before compiling so scripts can target them ----------
await loadStore();
const cad = new CadManager(built);
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
const meshesUnder = (o: THREE.Object3D) => { const m: THREE.Mesh[] = []; o.traverse((x) => { if ((x as THREE.Mesh).isMesh) m.push(x as THREE.Mesh); }); return m; };

/** Apply hide/lock flags to a subtree: visibility, matrix auto-update, CAD suppression. */
async function reconcile(root: THREE.Object3D) {
  const supp: THREE.Mesh[] = [], rest: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D): boolean => {         // returns: whole subtree locked
    const id = (o.userData.id ?? o.name) as string;
    if (id && built.registry.get(id) === o) {
      o.userData.userHidden = state.hidden[id] === true;
      o.visible = !o.userData.userHidden && !o.userData.faded;
    }
    const locked = isLocked(o);
    o.userData.suppressedRoot = isCad(o) && state.hidden[id] === true && locked;
    if ((o as THREE.Mesh).isMesh && isCad(o)) (isHidden(o) && locked ? supp : rest).push(o as THREE.Mesh);
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
useSnapshot(store.snapshots[store.active]);
applyPlacements();
for (const o of built.root.children) await reconcile(o);

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
function buildTimeline(): boolean {
  try {
    const tl = compile(script, built, defaultCam, isLocked, store.groups);
    const t = player?.time ?? 0, playing = player?.playing ?? false;
    player = new Player(built, tl);
    player.time = t; player.playing = playing;
    subEl.textContent = '';
    return true;
  } catch (e: any) {
    chapterEl.textContent = 'Script error';
    subEl.textContent = e.message;
    console.error(e);
    return false;
  }
}
if (!buildTimeline()) player = new Player(built, { tweens: [], steps: [], duration: 0, touched: [],
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
const gui = new GUI({ title: 'Refuelling' });
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
const chapters = gui.addFolder('Chapters');
player.tl.steps.filter((s) => s.kind === 'label').forEach((s) =>
  chapters.add({ go: () => { player.seek(s.t); player.playing = true; } }, 'go').name(`${s.t.toFixed(0).padStart(3)}s  ${s.value}`));

// ---------- assembly tree + 3D picking ----------
const tree = new TreePanel(built, scene3, {
  onChange: async (objs, what) => {
    for (const o of objs) await reconcile(o);
    if (what === 'locked') { buildTimeline(); gizmoFor(tree.selectedObject); }
  },
  onSelect: (o) => gizmoFor(o),
  onGroups: () => buildTimeline(),
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
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
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
  gizmoFor(tree.selectedObject);
  tree.redraw();
  markDirty(false);
  renderSnapBar();
}
async function saveSnapshot(name: string) {
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
  const c = store.snapshots[store.active]?.camera;
  if (c) { ui.followCamera = false; camera.position.fromArray(c.pos); controls.target.fromArray(c.look); }
}
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveSnapshot(store.active); }
});
addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });

// ---------- move / rotate gizmo for the selected unlocked part ----------
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.8);
scene3.add(gizmo.getHelper());
gizmo.addEventListener('dragging-changed', (e: any) => {
  controls.enabled = !e.value;
  if (!e.value && gizmo.object) {           // drag finished: record placement
    const o = gizmo.object;
    state.placements[idOfObj(o)] = { p: o.position.toArray(), q: o.quaternion.toArray() };
    markDirty();
    buildTimeline();
  }
});
function gizmoFor(o: THREE.Object3D | undefined) {
  const id = o && idOfObj(o);
  // script-animated parts can only be placed at t = 0 (their start position)
  const ok = o && id && built.registry.get(id) === o && !isLocked(o) && (player.time === 0 || !player.tl.touched.includes(id));
  if (ok) gizmo.attach(o!); else gizmo.detach();
}
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'w') gizmo.setMode('translate');
  if (e.key === 'e') gizmo.setMode('rotate');
  if (e.key === 'Escape') { gizmo.detach(); tree.select(undefined, false); }
  if (e.key === 'r' && gizmo.object) {      // reset selected part to its original placement
    const o = gizmo.object; delete state.placements[idOfObj(o)];
    o.position.fromArray(o.userData.homeP); o.quaternion.fromArray(o.userData.homeQ);
    markDirty(); buildTimeline();
  }
});

window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); ui.play(); } });
{ const sel = new URLSearchParams(location.search).get('select'); if (sel) tree.selectId(sel); }
controls.addEventListener('start', () => { ui.followCamera = false; gui.controllersRecursive().forEach((c) => c.updateDisplay()); });
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const triad = new Triad();

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
  renderer.render(scene3, camera);
  triad.render(renderer, camera, document.body.classList.contains('tree-collapsed') ? 12 : 352);
});

// ?debug: dump CAD ids + stats into the DOM (for headless checks)
if (new URLSearchParams(location.search).has('debug')) {
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
  document.body.appendChild(pre);
}
