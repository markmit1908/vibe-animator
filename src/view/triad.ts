import * as THREE from 'three';

/** X-Y-Z orientation triad drawn in a corner viewport, following the main camera's rotation. */
export class Triad {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 10);

  constructor(private size = 110) {
    const axes: [THREE.Vector3, string, string][] = [
      [new THREE.Vector3(1, 0, 0), '#e5484d', 'X'],
      [new THREE.Vector3(0, 1, 0), '#46a758', 'Y'],
      [new THREE.Vector3(0, 0, 1), '#3e8ef7', 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.25, 0.12);
      (arrow.line.material as THREE.LineBasicMaterial).linewidth = 2;
      this.scene.add(arrow);
      this.scene.add(this.label(label, color, dir.clone().multiplyScalar(1.3)));
    }
  }

  private label(text: string, color: string, pos: THREE.Vector3) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = color; g.font = 'bold 44px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 32, 34);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    s.position.copy(pos); s.scale.setScalar(0.45);
    return s;
  }

  /** Render after the main scene. `left` is the x offset in CSS px (clears side panels). */
  render(renderer: THREE.WebGLRenderer, main: THREE.Camera, left: number, bottom = 36) {
    this.cam.position.set(0, 0, 4).applyQuaternion(main.quaternion);
    this.cam.quaternion.copy(main.quaternion);
    const s = this.size;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(left, bottom, s, s);
    renderer.setViewport(left, bottom, s, s);
    renderer.clearDepth();
    renderer.render(this.scene, this.cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
    renderer.autoClear = true;
  }
}
