import * as THREE from 'three';
import { withCapNormal } from './caps';

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
  /** line width in device pixels */
  thickness = 1.0;
  /** crease sensitivity: 1 - cos(angle) between neighbour normals */
  normalThreshold = 0.25;
  /** relative depth jump that counts as an outline */
  depthThreshold = 0.004;

  private rt: THREE.WebGLRenderTarget;
  private normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  /** objects hidden during the normal pass (edge lines, outline hulls, helpers) */
  private decor: THREE.Object3D[] = [];

  constructor(private renderer: THREE.WebGLRenderer, clipPlanes: THREE.Plane[]) {
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.rt.depthTexture = new THREE.DepthTexture(1, 1);
    this.normalMat.clippingPlanes = clipPlanes;
    withCapNormal(this.normalMat);   // section caps: an outline where each cap meets the walls
    this.normalMat.clipIntersection = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tNormal: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture },
        texel: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 100 },
        thickness: { value: 1 }, nThr: { value: 0.25 }, dThr: { value: 0.004 },
        lineColor: { value: this.lineColor }, paper: { value: this.paperColor }, clearBg: { value: 0 }, overlay: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tNormal; uniform sampler2D tDepth; uniform vec2 texel;
        uniform float near; uniform float far; uniform float thickness; uniform float nThr; uniform float dThr;
        uniform vec3 lineColor; uniform vec3 paper; uniform float clearBg; uniform float overlay; varying vec2 vUv;
        float lin(float d){ return (near * far) / (far - d * (far - near)); }
        void main(){
          float d0 = texture2D(tDepth, vUv).r;
          vec3 n0 = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
          float z0 = lin(d0);
          float edge = 0.0;
          for (int i = 0; i < 8; i++) {
            vec2 o = vec2(i == 0 ? 1. : i == 1 ? -1. : i == 2 ? 0. : i == 3 ? 0. : i == 4 ? 1. : i == 5 ? -1. : i == 6 ? 1. : -1.,
                          i == 0 ? 0. : i == 1 ? 0. : i == 2 ? 1. : i == 3 ? -1. : i == 4 ? 1. : i == 5 ? 1. : i == 6 ? -1. : -1.);
            vec2 uv = vUv + o * texel * thickness;
            float d1 = texture2D(tDepth, uv).r;
            bool bg0 = d0 >= 0.9999, bg1 = d1 >= 0.9999;
            if (bg0 != bg1) { edge = 1.0; break; }           // silhouette against the background
            if (bg0) continue;
            float z1 = lin(d1);
            if (abs(z1 - z0) / z0 > dThr * (1.0 + length(o))) { edge = max(edge, 1.0); }  // depth step: outline
            vec3 n1 = texture2D(tNormal, uv).xyz * 2.0 - 1.0;
            if (1.0 - dot(n0, n1) > nThr) edge = max(edge, 1.0);                          // crease
          }
          // transparent background (PNG export): empty space clear, parts keep their paper fill (premultiplied)
          float a = (clearBg > 0.5 && d0 >= 0.9999) ? edge : 1.0;
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

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    if (this.rt.width !== size.x || this.rt.height !== size.y) this.rt.setSize(size.x, size.y);
    // 1) normals + depth (decorations off, background cleared to "far")
    const vis = this.decor.map((o) => o.visible);
    this.decor.forEach((o) => (o.visible = false));
    const bg = scene.background, ov = scene.overrideMaterial;
    scene.background = null; scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x808080, 1); r.clear();
    r.render(scene, camera);
    r.setRenderTarget(null);
    scene.background = bg; scene.overrideMaterial = ov;
    this.decor.forEach((o, i) => (o.visible = vis[i]));
    // 2) edges
    const u = this.mat.uniforms;
    u.texel.value.set(1 / size.x, 1 / size.y);
    u.near.value = camera.near; u.far.value = camera.far;
    u.thickness.value = this.thickness * r.getPixelRatio();
    u.nThr.value = this.normalThreshold; u.dThr.value = this.depthThreshold;
    u.overlay.value = this.overlay ? 1 : 0;
    this.mat.transparent = this.overlay;               // overlay: blend the lines onto the shaded frame
    const ac = r.autoClear;
    if (this.overlay) r.autoClear = false;
    r.render(this.quadScene, this.quadCam);
    r.autoClear = ac;
  }
}
