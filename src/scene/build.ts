import * as THREE from 'three';
import { withCaps } from '../view/caps';

/** Everything the timeline and view need to know about the built scene. */
export interface BuiltScene {
  root: THREE.Group;
  /** Animatable objects by id: blocks, fresh/N, vessel, head, bolts, barrel, machine. */
  registry: Map<string, THREE.Object3D>;
  /** Original centre position of every core block slot, by block id. */
  slots: Map<string, THREE.Vector3>;
  /** Column centre (x, z) by column id. */
  columns: Map<string, THREE.Vector2>;
  /** Ids of all blocks (core + fresh) – used by the cutaway. */
  blockIds: string[];
  locations: Record<string, THREE.Vector3>;
  palette: Record<string, string>;
  blockHeight: number;
  coreRadius: number;
  floorY: number;
  clearance: number;
  /** Clipping planes shared by vessel/head/barrel/floor materials. */
  clipPlanes: THREE.Plane[];
  /** Materials the x-ray toggle makes translucent. */
  shellMaterials: THREE.Material[];
}

const SQ3 = Math.sqrt(3);

// Cel-shaded look: 3-band toon ramp shared by every material.
const ramp = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
const toon = (p: THREE.MeshToonMaterialParameters) => withCaps(new THREE.MeshToonMaterial({ gradientMap: ramp, ...p }));
/** The cel-shaded part material (shared ramp, section caps), for parts made elsewhere (shapes). */
export const toonMaterial = toon;
// Inverted-hull outline material (thick black silhouette).
const hullMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
// axial hex directions
const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Axial coords of hex ring k, starting at (-k, k) and walking round. */
function ring(k: number): [number, number][] {
  if (k === 0) return [[0, 0]];
  const out: [number, number][] = [];
  let q = DIRS[4][0] * k, r = DIRS[4][1] * k;
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < k; j++) {
      out.push([q, r]);
      q += DIRS[i][0]; r += DIRS[i][1];
    }
  return out;
}

export function buildScene(cfg: any): BuiltScene {
  const pal: Record<string, string> = cfg.palette;
  const c = cfg.core;
  const bh: number = c.block_height;
  const L = c.layers;
  const nLayers = L.bottom_reflector + L.fuel + L.top_reflector;
  const coreH = nLayers * bh;
  const v = cfg.vessel;
  const floorY = coreH + v.top_gap;

  const clipPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6), new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6)];
  const shellMaterials: THREE.Material[] = [];
  const shellMat = (color: string, extra: THREE.MeshToonMaterialParameters = {}) => {
    const m = toon({
      color, side: THREE.DoubleSide, clippingPlanes: clipPlanes, clipIntersection: true, ...extra,
    });
    shellMaterials.push(m);
    return m;
  };
  const edgeMat = (opts: { clip?: boolean } = {}) => new THREE.LineBasicMaterial({
    color: pal.edge, transparent: true, opacity: 1,
    ...(opts.clip ? { clippingPlanes: clipPlanes, clipIntersection: true } : {}),
  });
  // Inverted hull pushed out along normals (constant thickness, unlike scaling);
  // shares the cutaway planes so it is sliced with the shell.
  const shellHullMat = new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide, clippingPlanes: clipPlanes, clipIntersection: true,
  });
  shellHullMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>\n transformed += normalize(normal) * ${(cfg.outline_width ?? 0.08).toFixed(3)};`);
  };
  shellMaterials.push(shellHullMat);
  const withEdges = (mesh: THREE.Mesh, clip = false, threshold = 30) => {
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold), edgeMat({ clip })));
    if (clip) mesh.add(new THREE.Mesh(mesh.geometry, shellHullMat)); // thick silhouette on shells
    return mesh;
  };

  const root = new THREE.Group();
  const registry = new Map<string, THREE.Object3D>();
  const slots = new Map<string, THREE.Vector3>();
  const columns = new Map<string, THREE.Vector2>();
  const blockIds: string[] = [];

  // ---------- core blocks ----------
  const R = c.pitch / SQ3; // circumradius
  const blockGeo = new THREE.CylinderGeometry(R - c.gap, R - c.gap, bh * 0.98, 6);
  blockGeo.rotateY(Math.PI / 2); // flat-top orientation to match axial layout
  const blockEdges = new THREE.EdgesGeometry(blockGeo);

  const makeBlock = (id: string, color: string, pos: THREE.Vector3) => {
    const mesh = new THREE.Mesh(blockGeo, toon({ color }));
    mesh.add(new THREE.LineSegments(blockEdges, edgeMat()));
    const hull = new THREE.Mesh(blockGeo, hullMat);
    hull.scale.setScalar(1.05);
    mesh.add(hull);
    mesh.position.copy(pos);
    mesh.name = id;
    mesh.userData.kind = 'block';
    root.add(mesh);
    registry.set(id, mesh);
    blockIds.push(id);
    return mesh;
  };

  let coreRadius = 0;
  for (let k = 0; k < c.rings; k++) {
    ring(k).forEach(([q, r], i) => {
      const colId = `R${k}-${i}`;
      const x = c.pitch * (SQ3 / 2) * q;
      const z = c.pitch * (r + q / 2);
      columns.set(colId, new THREE.Vector2(x, z));
      coreRadius = Math.max(coreRadius, Math.hypot(x, z) + R);
      const fuelled = k < c.fuel_rings;
      for (let n = 0; n < nLayers; n++) {
        const isFuel = fuelled && n >= L.bottom_reflector && n < L.bottom_reflector + L.fuel;
        const id = `${colId}/L${n}`;
        const pos = new THREE.Vector3(x, bh * (n + 0.5), z);
        slots.set(id, pos.clone());
        makeBlock(id, isFuel ? pal.fuel : pal.reflector, pos);
      }
    });
  }

  // ---------- locations ----------
  const locations: Record<string, THREE.Vector3> = {};
  for (const [name, p] of Object.entries<number[]>(cfg.locations ?? {}))
    locations[name] = new THREE.Vector3(p[0], floorY + p[1], p[2]);

  // location pads
  const padGeo = new THREE.BoxGeometry(2.2, 0.05, 1.2);
  for (const [name, p] of Object.entries(locations)) {
    if (name === 'head_park') continue;
    const pad = withEdges(new THREE.Mesh(padGeo, toon({ color: pal.barrel })));
    pad.position.set(p.x + 0.75, p.y - 0.025, p.z + 0.25);
    root.add(pad);
  }

  // ---------- fresh blocks ----------
  const f = cfg.fresh;
  if (f?.count) {
    const base = locations[f.location];
    for (let i = 0; i < f.count; i++) {
      const col = i % f.per_row, row = Math.floor(i / f.per_row);
      makeBlock(`fresh/${i}`, pal.fresh, new THREE.Vector3(base.x + col * f.spacing, base.y + bh / 2, base.z + row * f.spacing));
    }
  }

  // ---------- core barrel + support plate ----------
  const barrel = new THREE.Group();
  const barrelR = coreRadius + 0.08;
  const barrelMesh = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(barrelR, barrelR, coreH, 48, 1, true), shellMat(pal.barrel)), true);
  barrelMesh.position.y = coreH / 2;
  const plate = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(v.inner_radius, v.inner_radius, 0.2, 48), shellMat(pal.barrel)), true);
  plate.position.y = -0.1;
  barrel.add(barrelMesh, plate);
  addGroup('barrel', barrel);

  // ---------- vessel ----------
  const vessel = new THREE.Group();
  const vR = v.inner_radius, vH = floorY + v.bottom_gap;
  const vesselMat = shellMat(pal.vessel);
  const shell = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(vR + v.wall, vR + v.wall, vH, 64, 1, true), vesselMat), true);
  shell.position.y = floorY - vH / 2;
  const bottom = withEdges(new THREE.Mesh(new THREE.SphereGeometry(vR + v.wall, 64, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), vesselMat), true);
  bottom.scale.y = 0.5;
  bottom.position.y = -v.bottom_gap;
  const flange = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(vR + v.wall + 0.25, vR + v.wall + 0.25, 0.2, 64, 1, true), vesselMat), true);
  flange.position.y = floorY - 0.1;
  vessel.add(shell, bottom, flange);
  addGroup('vessel', vessel);

  // operating floor with a hole for the vessel
  const floorGeo = new THREE.RingGeometry(vR + v.wall + 0.3, 9, 64);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, shellMat(pal.floor, { transparent: true, opacity: 0.85 }));
  floor.position.y = floorY - 0.001;
  root.add(floor);

  // ---------- head + bolts ----------
  const h = cfg.head;
  const head = new THREE.Group();
  const headMat = shellMat(pal.head);
  const hR = vR + v.wall + 0.25;
  const hFlange = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(hR, hR, h.flange, 64), headMat), true);
  hFlange.position.y = h.flange / 2;
  const dome = withEdges(new THREE.Mesh(new THREE.SphereGeometry(vR + v.wall, 64, 16, 0, Math.PI * 2, 0, Math.PI / 2), headMat), true, 60);
  dome.scale.y = h.height / (vR + v.wall);
  dome.position.y = h.flange;
  head.add(hFlange, dome);
  head.position.y = floorY;
  addGroup('head', head);

  const bolts = new THREE.Group();
  const boltGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.35, 8);
  const boltMat = toon({ color: pal.bolts });
  for (let i = 0; i < h.bolts; i++) {
    const a = (i / h.bolts) * Math.PI * 2;
    const b = new THREE.Mesh(boltGeo, boltMat);
    b.position.set(Math.cos(a) * (hR - 0.12), h.flange + 0.1, Math.sin(a) * (hR - 0.12));
    bolts.add(b);
  }
  bolts.position.y = floorY;
  addGroup('bolts', bolts);

  // ---------- refuelling machine (origin = grapple tip) ----------
  const m = cfg.machine;
  const clearance = m.clearance ?? floorY + 3 * bh + 0.5;
  const machine = new THREE.Group();
  const mMat = toon({ color: pal.machine });
  const mast = withEdges(new THREE.Mesh(new THREE.BoxGeometry(0.22, m.mast_length, 0.22), mMat));
  mast.position.y = 0.35 + m.mast_length / 2;
  const trolley = withEdges(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.9), mMat));
  trolley.position.y = 0.35 + m.mast_length;
  const grappleHead = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 6), mMat));
  grappleHead.position.y = 0.2;
  machine.add(mast, trolley, grappleHead);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const claw = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.04), toon({ color: pal.edge }));
    claw.position.set(Math.cos(a) * 0.12, 0.05, Math.sin(a) * 0.12);
    machine.add(claw);
  }
  machine.position.set(0, clearance, -4);
  addGroup('machine', machine);

  // lights + ground grid
  root.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(8, 20, 10);
  root.add(sun);
  const grid = new THREE.GridHelper(30, 30, 0x1f2a35, 0x141b22);
  grid.position.y = -v.bottom_gap - (vR + v.wall) * 0.5 - 0.05;
  root.add(grid);

  // generated: false -> drop the parametric reactor (keep lights + grid); CAD models are added later
  if (cfg.generated === false) {
    for (const o of [...root.children]) {
      if ((o as THREE.Light).isLight || o === grid) continue;
      root.remove(o);
      o.traverse((x) => (x as THREE.Mesh).geometry?.dispose());
    }
    registry.clear(); slots.clear(); columns.clear(); blockIds.length = 0;
    grid.position.y = 0;
  }

  function addGroup(id: string, g: THREE.Object3D) {
    g.name = id;
    root.add(g);
    registry.set(id, g);
  }

  return {
    root, registry, slots, columns, blockIds, locations, palette: pal,
    blockHeight: bh, coreRadius, floorY, clearance, clipPlanes, shellMaterials,
  };
}
