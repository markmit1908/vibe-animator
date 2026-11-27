import * as THREE from 'three';
import type { BuiltScene } from '../scene/build';
import { bodyMaterials, setOpacity, type Timeline, type StepEvent } from './compile';

/** Deterministic playback: seek(t) resets the scene and re-applies every tween up to t. */
export class Player {
  time = 0;
  playing = false;
  speed = 1;
  private initial = new Map<THREE.Object3D, { pos: THREE.Vector3; quat: THREE.Quaternion; colors: THREE.Color[] }>();

  constructor(public scene: BuiltScene, public tl: Timeline) {
    // only objects the script animates are reset each frame (CAD can add thousands of nodes)
    for (const id of tl.touched) {
      const obj = scene.registry.get(id)!;
      this.initial.set(obj, { pos: obj.position.clone(), quat: obj.quaternion.clone(), colors: bodyMaterials(obj).map((m) => m.color.clone()) });
    }
  }

  get duration() { return this.tl.duration; }

  tick(dt: number) {
    if (!this.playing) return;
    this.time += dt * this.speed;
    if (this.time >= this.duration) { this.time = this.duration; this.playing = false; }
    this.seek(this.time);
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(t, this.duration));
    for (const [obj, s] of this.initial) {
      obj.position.copy(s.pos);
      obj.quaternion.copy(s.quat);
      bodyMaterials(obj).forEach((m, i) => m.color.copy(s.colors[i]));
      setOpacity(obj, 1);
      delete obj.userData.outline;
    }
    const cam = this.tl.camera;
    cam.pos.copy(cam.initPos); cam.look.copy(cam.initLook);
    for (const tw of this.tl.tweens) {
      if (tw.start > this.time) break;
      tw.apply(tw.dur > 0 ? Math.min(1, (this.time - tw.start) / tw.dur) : 1);
    }
  }

  /** Latest step event of a kind at the current time. */
  current(kind: StepEvent['kind']): StepEvent | undefined {
    let found: StepEvent | undefined;
    for (const s of this.tl.steps) { if (s.t > this.time + 1e-6) break; if (s.kind === kind) found = s; }
    return found;
  }
}
