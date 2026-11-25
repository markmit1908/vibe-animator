import type { BuiltScene } from '../scene/build';

export type CutMode = 'none' | 'half' | 'quarter';

/**
 * Shells (vessel, head, barrel, floor) are clipped by planes; core blocks inside the
 * cut region are hidden whole, which reads better than slicing hex blocks.
 * Cut region: half = x > 0, quarter = x > 0 and z > 0.
 */
export function applyCutaway(scene: BuiltScene, mode: CutMode) {
  const [px, pz] = scene.clipPlanes;
  px.constant = mode === 'none' ? 1e6 : 0;
  pz.constant = mode === 'quarter' ? 0 : mode === 'half' ? -1e6 : 1e6;

  const eps = 0.05;
  for (const id of scene.blockIds) {
    const obj = scene.registry.get(id)!;
    const p = obj.position;
    const insideCore = Math.hypot(p.x, p.z) < scene.coreRadius + 0.1 && p.y < scene.floorY;
    const cut = mode === 'half' ? p.x > eps : mode === 'quarter' ? p.x > eps && p.z > eps : false;
    if (insideCore && cut) obj.visible = false;
  }
}
