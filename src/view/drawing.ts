import * as THREE from 'three';
import { partHook, partPassMaterial, type SectionCaps } from './caps';

/**
 * "Hidden line" drawing mode: black visible edges on white, hidden edges removed.
 * Screen-space edge detection: the scene is rendered once with view-space normals + depth,
 * then a full-screen pass draws a line where depth jumps (silhouettes / outlines) or the
 * surface normal turns sharply (creases). Works for any model size and follows animation/cutaway.
 */
export class DrawingMode {
  enabled = false;
  /** Shaded + outline: draw only the lines, over the shaded (cel) frame already on screen. */
  overlay = false;
  lineColor = new THREE.Color(0x111111);
  paperColor = new THREE.Color(0xffffff);
  /** Leave the background transparent (PNG export). */
  set transparentBg(on: boolean) { this.mat.uniforms.clearBg.value = on ? 1 : 0; }
  /** edge (crease, part boundary) line width in CSS pixels */
  thickness = 1.25;
  /** silhouette / outline line width in CSS pixels */
  silThickness = 2.5;
  /** crease sensitivity: 1 - cos(angle) between neighbour normals */
  normalThreshold = 0.25;
  /** relative depth jump that counts as an outline */
  depthThreshold = 0.004;

  private rt: THREE.WebGLRenderTarget;
  /** normals + part ids (alpha), set per mesh as it's drawn (partHook) */
  private normalMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  /** objects hidden during the normal pass (edge lines, outline hulls, helpers) */
  private decor: THREE.Object3D[] = [];
  /** section caps, drawn into the normal pass (so the cut is outlined) */
  caps?: SectionCaps;

  constructor(private renderer: THREE.WebGLRenderer, clipPlanes: THREE.Plane[]) {
    this.normalMat = partPassMaterial('normals', clipPlanes);
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, stencilBuffer: true });   // stencil: section caps
    this.rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type, undefined, undefined, undefined, undefined, undefined, undefined, THREE.DepthStencilFormat);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tNormal: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture },
        texel: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 100 }, logDepth: { value: 0 },
        wSil: { value: 2 }, wEdge: { value: 1 }, nThr: { value: 0.25 }, dThr: { value: 0.004 },
        lineColor: { value: this.lineColor }, paper: { value: this.paperColor }, clearBg: { value: 0 }, overlay: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tNormal; uniform sampler2D tDepth; uniform vec2 texel;
        uniform float near; uniform float far; uniform float logDepth; uniform float wSil; uniform float wEdge;
        uniform float nThr; uniform float dThr;
        uniform vec3 lineColor; uniform vec3 paper; uniform float clearBg; uniform float overlay; varying vec2 vUv;
        // view distance from a depth value: three's logarithmic depth is log2(1 + w) / log2(far + 1); orthographic cameras keep linear depth (logDepth = 2)
        float lin(float d){ return logDepth > 1.5 ? near + d * (far - near) : logDepth > 0.5 ? exp2(d * log2(far + 1.0)) - 1.0 : (near * far) / (far - d * (far - near)); }
        const int MAXR = 4;
        void main(){
          float d0 = texture2D(tDepth, vUv).r;
          bool bg0 = d0 >= 0.9999;
          vec4 s0 = texture2D(tNormal, vUv);
          vec3 n0 = s0.xyz * 2.0 - 1.0;
          float z0 = lin(d0);
          // lines have a width in pixels: a pixel is covered by an edge lying between it and a neighbour, by how far
          // that edge is (half the distance) compared with half the line's width – smooth (anti-aliased) lines
          float R = min(max(wSil, wEdge) * 0.5 + 1.0, float(MAXR));
          float line = 0.0;
          for (int dy = -MAXR; dy <= MAXR; dy++) for (int dx = -MAXR; dx <= MAXR; dx++) {
            vec2 o = vec2(float(dx), float(dy));
            float dist = length(o);
            if (dist < 0.5 || dist > R) continue;
            vec2 uv = vUv + o * texel;
            float d1 = texture2D(tDepth, uv).r;
            bool bg1 = d1 >= 0.9999;
            float sil = 0.0, edg = 0.0;
            if (bg0 != bg1) sil = 1.0;                                   // silhouette against the background
            else if (!bg0) {
              // outline: the depth departs from a straight line through this pixel and the opposite neighbour
              // (0 on any flat surface, however oblique – no dotted lines at grazing angles)
              float z1 = lin(d1);
              float dm = texture2D(tDepth, vUv - o * texel).r;
              float zm = dm >= 0.9999 ? z0 + (z0 - z1) : lin(dm);
              if (abs(z1 + zm - 2.0 * z0) / z0 > dThr * dist) sil = 1.0;
              vec4 s1 = texture2D(tNormal, uv);
              if (1.0 - dot(n0, s1.xyz * 2.0 - 1.0) > nThr) edg = 1.0;   // crease
              if (abs(s1.a - s0.a) > 0.0015) edg = 1.0;                  // a different part (touching flush)
            }
            float half_ = dist * 0.5;
            if (sil > 0.0) line = max(line, clamp(wSil * 0.5 - half_ + 0.5, 0.0, 1.0));
            if (edg > 0.0) line = max(line, clamp(wEdge * 0.5 - half_ + 0.5, 0.0, 1.0));
          }
          float edge = line;
          // transparent background (PNG export): empty space clear, parts keep their paper fill (premultiplied)
          float a = (clearBg > 0.5 && bg0) ? edge : 1.0;
          gl_FragColor = overlay > 0.5 ? vec4(lineColor, edge) : vec4(mix(paper, lineColor, edge) * a, a);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Collect the decorations to hide in the normal pass (call after the scene changes). */
  collectDecor(root: THREE.Object3D, extra: THREE.Object3D[] = []) {
    this.decor = [...extra];
    root.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments || (o as THREE.Line).isLine) this.decor.push(o);
      else if ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material)?.side === THREE.BackSide) this.decor.push(o); // outline hulls
      else if ((o as THREE.Sprite).isSprite) this.decor.push(o);
    });
  }

  /** The last normal pass's depth (log depth) – the outlines compare against it. */
  get depth() { return this.rt.depthTexture; }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    if (this.rt.width !== size.x || this.rt.height !== size.y) this.rt.setSize(size.x, size.y);
    // 1) normals + depth (decorations off, background cleared to "far")
    scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) partHook(o as THREE.Mesh); });
    const vis = this.decor.map((o) => o.visible);
    this.decor.forEach((o) => (o.visible = false));
    const bg = scene.background, ov = scene.overrideMaterial;
    scene.background = null; scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x808080, 1); r.clear();
    r.render(scene, camera);
    r.setRenderTarget(null);
    scene.background = bg; scene.overrideMaterial = ov;
    this.caps?.render(r, scene, camera, this.rt);
    r.setRenderTarget(null);
    this.decor.forEach((o, i) => (o.visible = vis[i]));
    // 2) edges
    const u = this.mat.uniforms;
    u.texel.value.set(1 / size.x, 1 / size.y);
    u.near.value = camera.near; u.far.value = camera.far;
    u.logDepth.value = (camera as THREE.OrthographicCamera).isOrthographicCamera ? 2 : r.capabilities.logarithmicDepthBuffer ? 1 : 0;
    u.wSil.value = this.silThickness * r.getPixelRatio();
    u.wEdge.value = this.thickness * r.getPixelRatio();
    u.nThr.value = this.normalThreshold; u.dThr.value = this.depthThreshold;
    u.overlay.value = this.overlay ? 1 : 0;
    this.mat.transparent = this.overlay;               // overlay: blend the lines onto the shaded frame
    const ac = r.autoClear;
    if (this.overlay) r.autoClear = false;
    r.render(this.quadScene, this.quadCam);
    r.autoClear = ac;
  }
}
