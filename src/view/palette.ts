/** A simple colour-wheel palette from one key colour (hue rotations, same saturation and lightness). */
import * as THREE from 'three';

export const DEFAULT_PALETTE_KEY = '#cad1ee';

export const PALETTE_ROLES: [string, number][] = [
  ['key', 0],
  ['complementary', 180],
  ['split complementary', 150], ['split complementary', 210],
  ['triadic', 120], ['triadic', 240],
  ['analogous', -30], ['analogous', 30],
];

export function palette(key: string): { hex: string; role: string }[] {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(key).getHSL(hsl);
  return PALETTE_ROLES.map(([role, deg]) => {
    const h = (((hsl.h + deg / 360) % 1) + 1) % 1;
    return { role, hex: `#${new THREE.Color().setHSL(h, hsl.s, hsl.l).getHexString()}` };
  });
}
