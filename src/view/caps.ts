/**
 * Section caps. For each cut plane:
 *  1. sum passes – the cut parts are drawn additively (no depth test) clipped by that plane only: a back face (leaving a
 *     part) adds the part's colour (id) and 1, a front face (entering) subtracts them. What's left is the part(s)
 *     containing the point on the plane: parts wholly behind it, holes and cavities cancel out; overlapping solids average.
 *     Needs outward-facing winding.
 *  2. cap – a quad on the plane is drawn where the count isn't 0, in sum / count, with real depth (it covers the interior; anything really
 *     in front still hides it). A quarter cut's cap is trimmed to the other plane's removed side.
 * The quad's colour is the containing part's (× cap shade); in the line views' normal pass it draws the part's id as a
 * direction, so each part's section is outlined.
 */
import * as THREE from 'three';

export const capUniforms = {
  /** caps wanted (Controls → Caps, and the current cut isn't `nocap`) */
  capOn: { value: 1 },
  /** number of active cut planes (0 = no cut) */
  cutActive: { value: 0 },
  /** cap colour = part colour × this */
  capShade: { value: 0.55 },
};

/** Part materials: mark them as parts (capped, outlined per part). Idempotent; call again on clones. */
export function withCaps<M extends THREE.Material>(mat: M): M {
  if ((mat as any).color === undefined || mat.side === THREE.BackSide) return mat; // outline hulls etc.
  mat.userData.capped = true;
  mat.forceSinglePass = true; // transparent double-sided materials would otherwise render in two flipped passes
  return mat;
}

const VERT = `#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec3 vN;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}`;
const FRAG = (body: string, sumOnly = '') => `#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
uniform float partId; uniform vec3 partColor; uniform float capShade; uniform float sumIds; uniform float noClip;
varying vec3 vN;
void main() {
  // a part kept uncut: not clipped (normal pass), and not part of any cap (sums)
  if (noClip > 0.5) { ${sumOnly} }
  else {
  #include <clipping_planes_fragment>
  }
  ${body}
  #include <logdepthbuf_fragment>
}`;
/**
 * Override materials whose per-part values (id, colour) are set as each mesh is drawn (onPartRender) – a ShaderMaterial,
 * because three re-uploads a built-in material's uniforms only when the material changes between draws.
 *  - "normals": the line views' normal pass – rgb = view-space normal, alpha = part id
 *  - "capColour": the caps' colour pass – back faces only, rgb = part colour × shade (linear), alpha = part id
 */
export function partPassMaterial(kind: 'normals' | 'capSum', planes: THREE.Plane[]) {
  const sum = kind === 'capSum';
  const m = new THREE.ShaderMaterial({
    uniforms: { partId: { value: 0 }, partColor: { value: new THREE.Color() }, capShade: capUniforms.capShade, sumIds: { value: 0 }, noClip: { value: 0 } },
    vertexShader: VERT,
    fragmentShader: FRAG(!sum
      ? 'vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0); gl_FragColor = vec4(n * 0.5 + 0.5, partId);'
      // leaving a part (back face) adds it, entering (front face) subtracts it: what's left is the part(s) containing the
      // point where the ray starts (on the cut plane); parts wholly behind it cancel out. a = how many.
      : 'float sg = gl_FrontFacing ? -1.0 : 1.0; gl_FragColor = sumIds > 0.5 ? vec4(partId * sg, 0.0, 0.0, sg) : vec4(partColor * capShade * sg, sg);',
      sum ? 'discard;' : ''),
    side: THREE.DoubleSide,
    clipping: true, clippingPlanes: planes, clipIntersection: !sum,
    ...(sum ? {
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    } : {}),
  });
  m.userData.partPass = true;
  return m;
}

/** The id of the part a mesh belongs to (its nearest registered ancestor), hashed to 0..1 (golden ratio: neighbours differ). */
function partHash(m: THREE.Mesh): number {
  let h = m.userData.partHash as number | undefined;
  if (h === undefined) {
    let p: THREE.Object3D | null = m;
    while (p && p.userData.id === undefined) p = p.parent;
    h = m.userData.partHash = (((p ?? m).id * 0.6180339887) % 1) * 0.98 + 0.01;
  }
  return h;
}
/** Before a mesh is drawn with a part-pass material: its part id and colour. */
function onPartRender(this: THREE.Mesh, _r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, mat: THREE.Material) {
  if (!mat.userData.partPass) return;
  const u = (mat as THREE.ShaderMaterial).uniforms;
  u.partId.value = partHash(this);
  u.noClip.value = this.userData.uncut ? 1 : 0;
  if (u.glowColor) {                                  // outline passes (glow.ts)
    const g = this.userData.glow as { color: THREE.Color; k: number } | undefined;
    if (g) { u.glowColor.value.copy(g.color); u.glowK.value = g.k; u.glowSlot.value = this.userData.glowSlot ?? 0; }
  }
  const own = this.material as THREE.MeshToonMaterial;
  if (own?.color) u.partColor.value.copy(own.color);
  (mat as THREE.ShaderMaterial).uniformsNeedUpdate = true;
}
export function partHook(m: THREE.Mesh) { if (m.onBeforeRender !== onPartRender) m.onBeforeRender = onPartRender; }

export class SectionCaps {
  /** per plane: Σ±colour / count (rgb, a), and Σ±id / count (r, a) */
  // 32-bit floats: the sums add and cancel every part along the ray; half floats leave rounding residue that shows as
  // ghost outlines of parts behind the cut (an id change to the edge pass)
  private colourRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
  private idRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
  private sumMat: THREE.ShaderMaterial;
  private capMat: THREE.MeshBasicMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private trim = new THREE.Plane();
  private res = new THREE.Vector2();
  private idsMode = { value: 0 };
  private box?: THREE.Box3;
  private boxAge = 0;
  private floatChecked = false;

  constructor(private planes: THREE.Plane[]) {
    this.sumMat = partPassMaterial('capSum', []);
    this.capMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, clippingPlanes: [this.trim] });
    this.capMat.onBeforeCompile = (sh) => {
      sh.uniforms.capTex = { value: this.colourRT.texture }; sh.uniforms.idTex = { value: this.idRT.texture };
      sh.uniforms.capRes = { value: this.res }; sh.uniforms.capIds = this.idsMode;
      // no solid here (count 0): no cap. Shaded: the containing part's colour; line views: its id as a direction (so
      // neighbouring parts' sections are outlined), and the id in alpha as in the normal pass
      sh.fragmentShader = 'uniform sampler2D capTex; uniform sampler2D idTex; uniform vec2 capRes; uniform float capIds;\n' +
        sh.fragmentShader.replace('#include <map_fragment>',
          `// a pixel exactly on a buried part's silhouette can count the part's near face but not its far one (GPU tie-
           // breaking on shared edges), leaving a stray ±1 / id: take the most common count in the 3×3 neighbourhood
           // and that neighbour's sums, so isolated pixels and 1-px lines are out-voted
           float cnts[9]; vec2 offs[9];
           for (int k = 0; k < 9; k++) {
             vec2 o = vec2(float(k - (k / 3) * 3 - 1), float(k / 3 - 1));
             offs[k] = o;
             cnts[k] = floor(texture2D(capTex, (gl_FragCoord.xy + o) / capRes).a + 0.5);
           }
           int best = 4; int bestN = 0;
           for (int k = 0; k < 9; k++) {
             int nk = 0;
             for (int j = 0; j < 9; j++) if (cnts[j] == cnts[k]) nk++;
             if (nk > bestN || (nk == bestN && k == 4)) { bestN = nk; best = k; }
           }
           float cnt = 0.0; vec2 bo = vec2(0.0);
           for (int k = 0; k < 9; k++) if (k == best) { cnt = cnts[k]; bo = offs[k]; }
           if (abs(cnt) < 0.5) discard;
           vec2 suv = (gl_FragCoord.xy + bo) / capRes;
           vec4 cs = texture2D(capTex, suv);
           float id = capIds > 0.5 ? texture2D(idTex, suv).r / cnt : 0.0;
           diffuseColor.rgb = capIds > 0.5 ? vec3(0.5 + 0.5 * cos(id * 6.2832), 0.5 + 0.5 * sin(id * 6.2832), 0.95) : clamp(cs.rgb / cnt, 0.0, 1.0);`)
          .replace(/\}\s*$/, '  if (capIds > 0.5) gl_FragColor.a = id;\n}');
    };
    this.capMat.toneMapped = false;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Is anything to cap now? */
  get active() { return capUniforms.capOn.value > 0.5 && capUniforms.cutActive.value > 0; }

  /** Hide what isn't a capped part (lines, sprites, outline hulls, helpers) for the cap passes; returns a restore. */
  private partsOnly(scene: THREE.Scene) {
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (!o.visible || o === scene) return;
      const m = o as THREE.Mesh;
      const isPart = m.isMesh && ((m.material as THREE.Material)?.userData?.capped === true);
      if (isPart || (!m.isMesh && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints && !(o as THREE.Sprite).isSprite)) return;
      o.visible = false; hidden.push(o);
    });
    return () => hidden.forEach((o) => (o.visible = true));
  }

  /** Draw the caps into `target` (null = the screen, or the line views' normal pass), after the scene is drawn there. */
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null) {
    if (!this.active) return;
    if (this.floatChecked !== true) {
      // additive blending into float targets needs EXT_float_blend (desktop GPUs have it); else half floats
      this.floatChecked = true;
      if (!r.extensions.get('EXT_float_blend')) for (const rt of [this.colourRT, this.idRT]) { rt.texture.type = THREE.HalfFloatType; rt.dispose(); }
    }
    const n = Math.min(capUniforms.cutActive.value, this.planes.length);
    const restore = this.partsOnly(scene);
    const bg = scene.background, ov = scene.overrideMaterial, ac = r.autoClear;
    const prevTarget = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color()), clearA = r.getClearAlpha();
    scene.background = null;
    r.getDrawingBufferSize(this.res);
    const ids = !!target;                    // a render target here = the line views' normal pass
    this.idsMode.value = ids ? 1 : 0;
    try {
      for (const rt of [this.colourRT, this.idRT]) if (rt.width !== this.res.x || rt.height !== this.res.y) rt.setSize(this.res.x, this.res.y);
      scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) partHook(o as THREE.Mesh); });
      // box the quad covers: the visible parts (recomputed now and then – it walks every mesh; lights/helpers can be huge)
      if (!this.box || this.box.isEmpty() || ++this.boxAge > 120) {
        const b = new THREE.Box3(), mb = new THREE.Box3();
        scene.traverseVisible((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || (m.material as THREE.Material)?.userData?.capped !== true) return;
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          b.union(mb.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld));
        });
        this.box = b; this.boxAge = 0;
      }
      const box = this.box;
      const size = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length() * 2;
      for (let i = 0; i < n; i++) {
        const pl = this.planes[i];
        // 1) the signed sums along each pixel's ray, the parts clipped by this plane only
        this.sumMat.clippingPlanes = [pl];
        scene.overrideMaterial = this.sumMat;
        r.autoClear = true; r.setClearColor(0x000000, 0);
        this.sumMat.uniforms.sumIds.value = 0;
        r.setRenderTarget(this.colourRT); r.render(scene, camera);
        if (ids) { this.sumMat.uniforms.sumIds.value = 1; r.setRenderTarget(this.idRT); r.render(scene, camera); }
        scene.overrideMaterial = ov;
        // 2) the cap quad on the plane where a part contains the point; a quarter cut keeps the part on the other
        //    plane's removed side (trim = that plane flipped)
        if (n > 1) this.trim.copy(this.planes[1 - i]).negate(); else this.trim.set(new THREE.Vector3(0, 1, 0), 1e9);
        const p = pl.coplanarPoint(new THREE.Vector3());
        if (!box.isEmpty()) pl.projectPoint(box.getCenter(new THREE.Vector3()), p);
        this.quad.position.copy(p);
        this.quad.lookAt(p.clone().add(pl.normal));
        this.quad.scale.setScalar(size);
        this.quad.updateMatrixWorld(true);
        r.setRenderTarget(target); r.autoClear = false;
        r.render(this.quadScene, camera);
      }
    } finally {
      scene.background = bg; scene.overrideMaterial = ov; r.autoClear = ac;
      r.setClearColor(clear, clearA);
      r.setRenderTarget(prevTarget);
      restore();
    }
  }
}
