/**
 * Section caps (stencil). For each cut plane:
 *  1. stencil pass – the cut parts are drawn (no colour, no depth test) clipped by that plane only; every surface a
 *     pixel's ray crosses flips its stencil bit. Odd = the plane lies inside a solid there (holes/cavities add pairs).
 *  2. cap – a quad on the plane is drawn where the bit is set, with real depth (it covers the interior; anything really
 *     in front still hides it). A quarter cut's cap is trimmed to the other plane's removed side.
 * Cap colour: one "cap colour" pass draws only back faces (part colour × shade, unlit) into a texture; the nearest
 * back face behind a cut point belongs to the part containing it (a touching neighbour's coincident face points the
 * other way, so it isn't drawn). The quad reads that texture – also in the line views' normal pass, where the
 * different part colours give each part's section an outline.
 */
import * as THREE from 'three';

export const capUniforms = {
  /** caps wanted (Controls → Caps, and the current cut isn't `nocap`) */
  capOn: { value: 1 },
  /** number of active cut planes (0 = no cut) */
  cutActive: { value: 0 },
  /** cap colour = part colour × this */
  capShade: { value: 0.55 },
  /** 1 during the cap-colour pass: part materials draw only back faces, flat */
  capPass: { value: 0 },
  /** the part being drawn in the cap-colour pass (hashed mesh id, 0..1) – kept in alpha: each part's own section */
  capId: { value: 0 },
};

/** Part materials: the cap-colour pass hook. Idempotent; call again on clones (clone() doesn't copy onBeforeCompile). */
export function withCaps<M extends THREE.Material>(mat: M): M {
  if ((mat as any).color === undefined || mat.side === THREE.BackSide) return mat; // outline hulls etc.
  mat.userData.capped = true;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.capPass = capUniforms.capPass; sh.uniforms.capShade = capUniforms.capShade; sh.uniforms.capId = capUniforms.capId;
    sh.fragmentShader = 'uniform float capPass; uniform float capShade; uniform float capId;\n' + sh.fragmentShader.replace(/\}\s*$/,
      '  if (capPass > 0.5) { if (gl_FrontFacing) discard; gl_FragColor = vec4(linearToOutputTexel(vec4(diffuseColor.rgb * capShade, 1.0)).rgb, capId); }\n}');
  };
  mat.customProgramCacheKey = () => 'caps2';
  mat.forceSinglePass = true; // transparent double-sided materials would otherwise render in two flipped passes
  return mat;
}

const noop = () => {};
/** Before a part is drawn in the cap-colour pass: its id (golden-ratio hash of the mesh id, so neighbours differ). */
function setCapId(this: THREE.Mesh, _r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, mat: THREE.Material) {
  capUniforms.capId.value = (this.id * 0.6180339887) % 1;
  (mat as any).uniformsNeedUpdate = true;
}

export class SectionCaps {
  private colourRT = new THREE.WebGLRenderTarget(1, 1);
  private stencilMat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilRef: 1, stencilFuncMask: 1, stencilWriteMask: 1,
    stencilFail: THREE.InvertStencilOp, stencilZFail: THREE.InvertStencilOp, stencilZPass: THREE.InvertStencilOp,
  });
  private capMat: THREE.MeshBasicMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private trim = new THREE.Plane();
  private res = new THREE.Vector2();
  private idsMode = { value: 0 };
  private box?: THREE.Box3;
  private boxAge = 0;

  constructor(private planes: THREE.Plane[]) {
    const stencilTest: THREE.MeshBasicMaterialParameters = {
      stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 1, stencilFuncMask: 1, stencilWriteMask: 0,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
      side: THREE.DoubleSide, clippingPlanes: [this.trim],
    };
    this.capMat = new THREE.MeshBasicMaterial({ ...stencilTest });
    this.capMat.onBeforeCompile = (sh) => {
      sh.uniforms.capTex = { value: this.colourRT.texture }; sh.uniforms.capRes = { value: this.res }; sh.uniforms.capIds = this.idsMode;
      // shaded: the part's colour; line views: its id as a direction (so neighbouring parts' sections are outlined)
      sh.fragmentShader = 'uniform sampler2D capTex; uniform vec2 capRes; uniform float capIds;\n' + sh.fragmentShader.replace('#include <map_fragment>',
        `vec4 cap = texture2D(capTex, gl_FragCoord.xy / capRes);
         diffuseColor.rgb = capIds > 0.5 ? vec3(0.5 + 0.5 * cos(cap.a * 6.2832), 0.5 + 0.5 * sin(cap.a * 6.2832), 0.95) : cap.rgb;`);
    };
    this.capMat.toneMapped = false;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** During the cap-colour pass each part sets its id before it's drawn. */
  private tagParts(scene: THREE.Scene, on: boolean) {
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m.material as THREE.Material)?.userData?.capped !== true) return;
      m.onBeforeRender = on ? setCapId : noop;
      // no blending in the cap pass (a fading part's alpha would mix the colour; alpha holds the id there)
      const mat = m.material as THREE.Material;
      if (on) { mat.userData.capWasTransparent = mat.transparent; mat.transparent = false; }
      else if (mat.userData.capWasTransparent !== undefined) { mat.transparent = mat.userData.capWasTransparent; delete mat.userData.capWasTransparent; }
    });
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

  /**
   * Draw the caps into `target` (null = the screen), after the scene has been rendered there (colour/normals + depth;
   * the target needs a stencil buffer) – the screen, or the line views' normal pass.
   */
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null) {
    if (!this.active) return;
    const n = Math.min(capUniforms.cutActive.value, this.planes.length);
    const restore = this.partsOnly(scene);
    const bg = scene.background, ov = scene.overrideMaterial, ac = r.autoClear;
    const prevTarget = r.getRenderTarget();
    scene.background = null;
    r.getDrawingBufferSize(this.res);
    try {
      // cap colours: nearest back face per pixel, part colour × shade
      {   // (line views too: different part colours make the parts' section outlines)
        if (this.colourRT.width !== this.res.x || this.colourRT.height !== this.res.y) this.colourRT.setSize(this.res.x, this.res.y);
        capUniforms.capPass.value = 1;
        this.tagParts(scene, true);
        r.setRenderTarget(this.colourRT);
        r.autoClear = true; r.setClearColor(0x000000, 0);
        r.render(scene, camera);
        capUniforms.capPass.value = 0;
        this.tagParts(scene, false);
      }
      r.setRenderTarget(target);
      r.autoClear = false;
      this.idsMode.value = target ? 1 : 0;   // a render target here = the line views' normal pass
      // box the quad covers: the scene's size (recomputed now and then – it walks every mesh)
      if (!this.box || this.box.isEmpty() || ++this.boxAge > 120) {
        // the visible parts only (lights and helpers can be huge)
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
        // 1) parity of surfaces along each pixel's ray, the parts clipped by this plane only
        r.clearStencil();
        this.stencilMat.clippingPlanes = [pl];
        scene.overrideMaterial = this.stencilMat;
        r.render(scene, camera);
        scene.overrideMaterial = ov;
        // 2) the cap quad on the plane, where the parity is odd; a quarter cut keeps the part on the other plane's
        //    removed side (trim = that plane flipped)
        if (n > 1) this.trim.copy(this.planes[1 - i]).negate(); else this.trim.set(new THREE.Vector3(0, 1, 0), 1e9);
        this.quad.material = this.capMat;
        const p = pl.coplanarPoint(new THREE.Vector3());
        // keep the quad near the scene: project the box centre onto the plane
        if (!box.isEmpty()) pl.projectPoint(box.getCenter(new THREE.Vector3()), p);
        this.quad.position.copy(p);
        this.quad.lookAt(p.clone().add(pl.normal));
        this.quad.scale.setScalar(size);
        this.quad.updateMatrixWorld(true);
        r.render(this.quadScene, camera);
      }
    } finally {
      scene.background = bg; scene.overrideMaterial = ov; r.autoClear = ac;
      capUniforms.capPass.value = 0;
      r.setRenderTarget(prevTarget);
      restore();
    }
  }
}
