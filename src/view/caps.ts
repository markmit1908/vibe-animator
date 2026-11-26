/**
 * Section caps: through a cut you only see a solid's inside (its back faces), so drawing back faces flat in a darker
 * version of the part's colour reads as a solid cut face. No extra meshes or passes – a few lines added to each part
 * material's fragment shader, driven by shared uniforms (set each frame from the cutaway). In the edge pass
 * (hidden line / shaded + outline) back faces get a fixed "cap normal", so the section outline is drawn.
 */
import * as THREE from 'three';

export const capUniforms = {
  /** caps wanted (Controls → Caps, and the current cut isn't `nocap`) */
  capOn: { value: 1 },
  /** a cut is active (no cut: back faces are left alone) */
  cutActive: { value: 0 },
  /** cap colour = part colour × this */
  capShade: { value: 0.55 },
};

const CAP_DECL = 'uniform float capOn; uniform float cutActive; uniform float capShade;\n';
const capped = (sh: { uniforms: Record<string, THREE.IUniform>; fragmentShader: string }, body: string) => {
  Object.assign(sh.uniforms, capUniforms);
  sh.fragmentShader = CAP_DECL + sh.fragmentShader.replace(/\}\s*$/, `  if (!gl_FrontFacing && capOn > 0.5 && cutActive > 0.5) { ${body} }\n}`);
};

/** Give a part material its section cap (idempotent; call again on clones – clone() doesn't copy onBeforeCompile). */
export function withCaps<M extends THREE.Material>(mat: M): M {
  if ((mat as any).color === undefined || mat.side === THREE.BackSide) return mat; // outline hulls etc.
  mat.onBeforeCompile = (sh) => capped(sh, 'gl_FragColor = linearToOutputTexel(vec4(diffuseColor.rgb * capShade, diffuseColor.a));');
  mat.customProgramCacheKey = () => 'caps';
  // one pass even when transparent (fading): three's two-pass back/front rendering flips the winding, so back faces
  // would read as front facing and get no cap
  mat.forceSinglePass = true;
  return mat;
}

/** Back-face culling for closed solids (materials marked userData.cullable, and their clones): culled unless a cut is
 *  active, when the back faces are the section caps. Culling removes z-fighting between a part's inside faces and its
 *  neighbours' outside faces. Run each frame (cheap: only changes a material when it differs). */
export function updateCulling(root: THREE.Object3D, cutActive: boolean) {
  const side = cutActive ? THREE.DoubleSide : THREE.FrontSide;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of [m.material, m.userData.origMat] as THREE.Material[]) if (mat?.userData?.cullable && mat.side !== side) { mat.side = side; mat.needsUpdate = true; }
  });
}

/** The edge pass's normal material: back faces get one fixed normal, so the cap's boundary is a crease line. */
export function withCapNormal(mat: THREE.MeshNormalMaterial) {
  mat.onBeforeCompile = (sh) => capped(sh, 'gl_FragColor = vec4(0.5, 0.5, 0.0, 1.0);');
  mat.customProgramCacheKey = () => 'capnormal';
  return mat;
}
