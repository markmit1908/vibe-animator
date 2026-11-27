/**
 * Outlines (script `outline`): a soft glow around chosen parts, seen through whatever is in front of them.
 *  1. slots – the outlines this frame are grouped by look (colour, width, strength) into up to 4 slots (one per
 *     channel of the mask); more than 4 share the slot nearest in colour.
 *  2. mask – only the outlined parts (layer GLOW_LAYER) are drawn, no depth test, into their slot's channel (max
 *     blending), so each outline keeps its whole silhouette even behind other parts, outlined or not. Clipped like the
 *     parts (the cut; parts kept uncut aren't). Line views: 1 = covered but hidden (behind the line pass's depth),
 *     2 = covered and visible; shaded views write 2.
 *  3. distance – two separable passes: the nearest covered pixel along the row per channel, then the column.
 *  4. composite – outside a silhouette: the glow, strongest at the edge, fading out over the width. Inside, where the
 *     part is hidden: a faint tint so a buried part's shape shows (line views here; shaded views draw the outlined
 *     parts again with depth "greater" – only where something is in front – a stencil stopping layers stacking).
 */
import * as THREE from 'three';
import type { Glow } from '../timeline/compile';
import { partHook } from './caps';

export const GLOW_LAYER = 7;
const TINT = 0.3;               // the hidden tint's opacity at full strength
const MAXR = 96;                // the widest glow in device px (loop bound)
const SLOTS = 4;

const VERT = `#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}`;
const FRAG = (body: string) => `#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
uniform float partId; uniform vec3 partColor; uniform float noClip; uniform vec3 glowColor; uniform float glowK; uniform float glowSlot;
uniform sampler2D tScene; uniform float useScene; uniform vec2 screen;
void main() {
  if (noClip < 0.5) {
  #include <clipping_planes_fragment>
  }
  ${body}
  #include <logdepthbuf_fragment>
}`;
const QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** A part-pass material: per-mesh values (glow colour, strength, slot; uncut) are set as each mesh is drawn (caps.ts). */
function glowPart(body: string, planes: THREE.Plane[], extra: THREE.ShaderMaterialParameters = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: { partId: { value: 0 }, partColor: { value: new THREE.Color() }, noClip: { value: 0 },
      glowColor: { value: new THREE.Color() }, glowK: { value: 0 }, glowSlot: { value: 0 },
      tScene: { value: null }, useScene: { value: 0 }, screen: { value: new THREE.Vector2(1, 1) } },
    vertexShader: VERT, fragmentShader: FRAG(body), clipping: true, clippingPlanes: planes, clipIntersection: true, ...extra,
  });
  m.userData.partPass = true;
  return m;
}

const rt = (type: THREE.TextureDataType = THREE.FloatType) => new THREE.WebGLRenderTarget(1, 1, { type, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });

export class OutlineGlow {
  private mask = rt(THREE.HalfFloatType);   // max-blended (blending into 32-bit floats needs an extension)
  private rows = rt();
  private maskMat: THREE.ShaderMaterial;
  private tintMat: THREE.ShaderMaterial;
  private rowMat: THREE.ShaderMaterial;
  private outMat: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quad: THREE.Mesh;
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private cam = new THREE.PerspectiveCamera();
  private lit = new Set<THREE.Mesh>();
  private slots: Glow[] = [];

  constructor(planes: THREE.Plane[]) {
    // mask: coverage in the slot's channel; line views: 1 if this fragment is hidden behind the scene, 2 if visible
    this.maskMat = glowPart(`
      float v = 2.0;
      if (useScene > 0.5) {
        #ifdef USE_LOGDEPTHBUF
          float fd = log2(vFragDepth) * logDepthBufFC * 0.5;
        #else
          float fd = gl_FragCoord.z;
        #endif
        if (fd > texture2D(tScene, gl_FragCoord.xy / screen).r + 1e-5) v = 1.0;
      }
      int sl = int(glowSlot + 0.5);
      gl_FragColor = vec4(sl == 0 ? v : 0.0, sl == 1 ? v : 0.0, sl == 2 ? v : 0.0, sl == 3 ? v : 0.0);`, planes, {
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    // hidden tint (shaded views): only where something is in front (depth greater), once per pixel (stencil)
    this.tintMat = glowPart(`gl_FragColor = vec4(glowColor, ${TINT.toFixed(2)} * glowK);`, planes, {
      side: THREE.FrontSide, transparent: true, depthWrite: false, depthFunc: THREE.GreaterDepth,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    });
    this.tintMat.toneMapped = false;
    // rows: per channel, |dx| to the nearest covered pixel along the row (1e4: none within reach)
    this.rowMat = new THREE.ShaderMaterial({
      uniforms: { tMask: { value: this.mask.texture }, texel: { value: new THREE.Vector2() }, R: { value: 0 } },
      vertexShader: QUAD_VERT,
      fragmentShader: `
        uniform sampler2D tMask; uniform vec2 texel; uniform float R; varying vec2 vUv;
        void main() {
          vec4 best = vec4(1e4);
          for (int i = 0; i <= ${MAXR}; i++) {
            float dx = float(i);
            if (dx > R) break;
            vec4 a = texture2D(tMask, vUv + vec2(dx, 0.0) * texel), b = texture2D(tMask, vUv - vec2(dx, 0.0) * texel);
            vec4 hit = step(0.5, max(a, b));
            best = min(best, mix(vec4(1e4), vec4(dx), hit));
          }
          gl_FragColor = best;
        }`,
      depthTest: false, depthWrite: false,
    });
    // columns + composite
    this.outMat = new THREE.ShaderMaterial({
      uniforms: {
        tRows: { value: this.rows.texture }, tMask: { value: this.mask.texture }, useScene: { value: 0 },
        texel: { value: new THREE.Vector2() }, R: { value: 0 },
        cols: { value: Array.from({ length: SLOTS }, () => new THREE.Color()) }, widths: { value: new THREE.Vector4() }, ks: { value: new THREE.Vector4() },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: `
        uniform sampler2D tRows; uniform sampler2D tMask; uniform float useScene; uniform vec2 texel; uniform float R;
        uniform vec3 cols[${SLOTS}]; uniform vec4 widths; uniform vec4 ks; varying vec2 vUv;
        void main() {
          vec4 d2 = vec4(1e8);
          for (int i = 0; i <= ${MAXR}; i++) {
            float dy = float(i);
            if (dy > R) break;
            vec4 a = texture2D(tRows, vUv + vec2(0.0, dy) * texel), b = texture2D(tRows, vUv - vec2(0.0, dy) * texel);
            vec4 m = min(a, b);
            d2 = min(d2, m * m + dy * dy);
          }
          vec4 d = sqrt(d2);
          vec4 cov = texture2D(tMask, vUv);
          vec3 col = vec3(0.0); float alpha = 0.0;
          for (int s = 0; s < ${SLOTS}; s++) {
            float ds = d[s], w = max(widths[s], 1.0), k = ks[s];
            float a = 0.0;
            if (cov[s] > 0.5) a = (useScene > 0.5 && cov[s] < 1.5) ? ${TINT.toFixed(2)} * k : 0.0;   // inside: tint if hidden (line views)
            else if (ds < w) { float n = ds / w; a = k * pow(1.0 - n, 0.8); }                          // the glow: bright at the edge, fading out
            col = col * (1.0 - a) + cols[s] * a; alpha = alpha * (1.0 - a) + a;
          }
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(col / alpha, alpha);
        }`,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.outMat.toneMapped = false;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.rowMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** The outlined parts this frame (registry objects with `userData.outline`, strength > 0). Cheap when none. */
  update(roots: THREE.Object3D[]) {
    const now = new Set<THREE.Mesh>();
    this.slots = [];
    const slotOf = (g: Glow) => {
      const same = this.slots.findIndex((s) => s.color.equals(g.color) && Math.abs(s.width - g.width) < 0.05 && Math.abs(s.k - g.k) < 0.01);
      if (same >= 0) return same;
      if (this.slots.length < SLOTS) { this.slots.push(g); return this.slots.length - 1; }
      // more looks than channels: the slot nearest in colour
      let best = 0, bd = Infinity;
      this.slots.forEach((s, i) => { const dd = (s.color.r - g.color.r) ** 2 + (s.color.g - g.color.g) ** 2 + (s.color.b - g.color.b) ** 2; if (dd < bd) { bd = dd; best = i; } });
      return best;
    };
    // assemblies first, so an outline on one of their parts wins
    const depth = (o: THREE.Object3D) => { let n = 0; for (let p = o.parent; p; p = p.parent) n++; return n; };
    for (const r of [...roots].sort((a, b) => depth(a) - depth(b))) {
      const g = r.userData.outline as Glow | undefined;
      if (!g || g.k <= 0.001) continue;
      const slot = slotOf(g);
      r.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m.material as THREE.Material)?.side === THREE.BackSide) return;   // not outline hulls
        m.userData.glow = g; m.userData.glowSlot = slot;
        m.layers.enable(GLOW_LAYER);
        partHook(m);
        now.add(m);
      });
    }
    for (const m of this.lit) if (!now.has(m)) { m.layers.disable(GLOW_LAYER); delete m.userData.glow; delete m.userData.glowSlot; }
    this.lit = now;
  }

  get active() { return this.lit.size > 0; }

  /**
   * Draw the outlines over the frame on screen. sceneDepth: the line views' depth (log depth); without it the hidden
   * tint is drawn as geometry against the screen's depth buffer (shaded views).
   */
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, sceneDepth?: THREE.Texture) {
    if (!this.active) return;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    for (const t of [this.mask, this.rows]) if (t.width !== size.x || t.height !== size.y) t.setSize(size.x, size.y);
    const pr = r.getPixelRatio();
    const R = Math.min(MAXR, Math.ceil(Math.max(...this.slots.map((s) => s.width)) * pr));
    const bg = scene.background, ov = scene.overrideMaterial, ac = r.autoClear;
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    this.cam.copy(camera); this.cam.layers.set(GLOW_LAYER);
    scene.background = null;
    try {
      // 1) mask
      const mu = this.maskMat.uniforms;
      mu.tScene.value = sceneDepth ?? null; mu.useScene.value = sceneDepth ? 1 : 0; mu.screen.value.set(size.x, size.y);
      scene.overrideMaterial = this.maskMat;
      r.setRenderTarget(this.mask); r.setClearColor(0x000000, 0); r.clear(); r.render(scene, this.cam);
      // 2) hidden tint as geometry (shaded): over the screen, against its depth
      r.setRenderTarget(null);
      r.autoClear = false;
      if (!sceneDepth) {
        r.clearStencil();
        scene.overrideMaterial = this.tintMat;
        r.render(scene, this.cam);
      }
      scene.overrideMaterial = ov;
      // 3) rows, then columns + composite onto the screen
      const texel = new THREE.Vector2(1 / size.x, 1 / size.y);
      this.rowMat.uniforms.texel.value.copy(texel); this.rowMat.uniforms.R.value = R;
      this.quad.material = this.rowMat;
      r.setRenderTarget(this.rows); r.setClearColor(0x000000, 0); r.clear(); r.render(this.quadScene, this.quadCam);
      const u = this.outMat.uniforms;
      u.texel.value.copy(texel); u.R.value = R; u.useScene.value = sceneDepth ? 1 : 0;
      for (let i = 0; i < SLOTS; i++) {
        const s = this.slots[i];
        (u.cols.value as THREE.Color[])[i].copy(s?.color ?? new THREE.Color());
        u.widths.value.setComponent(i, s ? s.width * pr : 1);
        u.ks.value.setComponent(i, s ? s.k : 0);
      }
      this.quad.material = this.outMat;
      r.setRenderTarget(null);
      r.render(this.quadScene, this.quadCam);
    } finally {
      scene.background = bg; scene.overrideMaterial = ov; r.autoClear = ac; r.setClearColor(cc, ca);
      r.setRenderTarget(null);
    }
  }
}
