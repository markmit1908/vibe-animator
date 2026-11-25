import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import GUI from 'lil-gui';
import { parse } from 'yaml';
import coreYaml from '../scenes/core.yaml?raw';
import refuelYaml from '../scripts/refuel.yaml?raw';
import { buildScene } from './scene/build';
import { compile } from './timeline/compile';
import { Player } from './timeline/player';
import { applyCutaway, type CutMode } from './view/cutaway';

const cfg = parse(coreYaml);
const script = parse(refuelYaml);

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.localClippingEnabled = true;
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

let player: Player;
try {
  const tl = compile(script, built, script.camera ?? { pos: [12, 16, 14], look: [0, 5, 0] });
  player = new Player(built, tl);
} catch (e: any) {
  chapterEl.textContent = 'Script error';
  subEl.textContent = e.message;
  throw e;
}
camera.position.copy(player.tl.camera.pos);
controls.target.copy(player.tl.camera.look);

// ---------- CAD overrides (glTF in public/) ----------
const loader = new GLTFLoader();
for (const [id, path] of Object.entries<string>(cfg.overrides ?? {})) {
  const target = built.registry.get(id);
  if (!target || (target as THREE.Mesh).isMesh) { console.warn(`override: "${id}" is not a group object`); continue; }
  loader.load(`/${path}`, (gltf) => { target.clear(); target.add(gltf.scene); }, undefined, (err) => console.error(`override ${id}:`, err));
}

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

window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); ui.play(); } });
controls.addEventListener('start', () => { ui.followCamera = false; gui.controllersRecursive().forEach((c) => c.updateDisplay()); });
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- loop ----------
const clock = new THREE.Clock();
player.seek(0);
renderer.setAnimationLoop(() => {
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

  renderer.render(scene3, camera);
});
