/**
 * One-time, copy-only conversion of the current project (scenes/core.yaml, scenes/snapshots.yaml,
 * scripts/<script>.anim + .chat.json, public/cad/*.glb) into a SolverKit vault model file.
 * The old files are left untouched.
 *
 *   npx tsx tools/convert-to-vault.ts [vault] [name]
 *   default vault: ~/Documents/Refuel animations, default name: from the script's first label
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { canonical, readModel, SOLVER, FORMAT, type AnimModel, type CadRef } from '../src/model/file';

const vault = process.argv[2] ?? join(homedir(), 'Documents', 'Refuel animations');
const core = parse(readFileSync('scenes/core.yaml', 'utf8'));
const snaps = existsSync('scenes/snapshots.yaml') ? parse(readFileSync('scenes/snapshots.yaml', 'utf8')) ?? {} : {};
const scriptName: string = core.script ?? 'plant.anim';
const text = scriptName.endsWith('.anim') && existsSync(`scripts/${scriptName}`) ? readFileSync(`scripts/${scriptName}`, 'utf8') : '';
const chatFile = `scripts/${scriptName.replace(/\.\w+$/, '')}.chat.json`;
const chat = existsSync(chatFile) ? JSON.parse(readFileSync(chatFile, 'utf8')) : [];
const name = process.argv[3] ?? text.match(/^\s*label\s+"([^"]+)"/m)?.[1] ?? 'Animation';

// CAD: copy public/cad/<x>.glb -> <vault>/CAD/<x>.glb (shared by all animations), reference by vault path
mkdirSync(join(vault, 'CAD'), { recursive: true });
const cad: CadRef[] = (core.cad_models ?? []).map((m: any) => {
  const file = basename(String(m.file));
  const src = join('public', String(m.file)), dst = join(vault, 'CAD', file);
  if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
  return { ...m, file: `CAD/${file}` };
});

const { script: _s, cad_models: _c, ...scene } = core;
const model: AnimModel = {
  name, uuid: randomUUID(), solver: SOLVER, format: FORMAT,
  description: `Converted from the refuel-animation project (${scriptName}).`,
  scene: { ...scene, cad_models: cad },
  script: { language: 'anim', text },
  snapshots: { active: snaps.active ?? 'default', items: snaps.snapshots ?? { default: { locked: {}, hidden: {} } } },
  groups: snaps.groups ?? {},
  chat,
};
const out = join(vault, `${name.replace(/[\/\\:*?"<>|]/g, '-')}.json`);
if (existsSync(out)) { console.error(`${out} exists – not overwritten.`); process.exit(1); }
const textOut = canonical(model);
readModel(textOut); // round-trip check
writeFileSync(out, textOut);
console.log(`wrote ${out}\nCAD: ${cad.map((c) => c.file).join(', ') || 'none'}`);
