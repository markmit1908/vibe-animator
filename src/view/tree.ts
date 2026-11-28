import { host } from './host';
import * as THREE from 'three';
import { withCaps } from './caps';
import { palette } from './palette';
import type { BuiltScene } from '../scene/build';
import { state, store, markDirty, isLocked, isHidden, isCad } from '../scene/state';

/**
 * Left-hand assembly tree.
 *  - children are built only when a node is expanded
 *  - only the rows on screen are in the DOM (virtual scrolling), so any size works
 *  - ● show/hide, 🔒 lock/unlock (locked = never moves, not scriptable)
 *  - hidden + locked CAD parts are suppressed (geometry freed) via the onChange hook
 */

interface Node {
  label: string;
  id?: string;                 // registry id, if scriptable
  obj?: THREE.Object3D;        // real object (virtual group nodes have none)
  virtualKids?: Node[];        // children of virtual nodes
  kids?: Node[];               // built lazily for real objects
  badge?: string;
  group?: string;              // a user group node ("@name")
  folder?: string;             // a folder of groups (path "a/b"; "" = the Groups section)
  memberOf?: string;           // direct member row of this group
  removedRow?: boolean;        // a row of the Removed section
  parent?: Node;
  depth: number;
}

const NOTES_W = 220;
const ROW = 22;

const CSS = `
#tree { position: absolute; top: 0; left: 0; bottom: 0; width: 340px; display: flex; flex-direction: column;
  background: rgba(14,17,21,.95); color: #d7dde4; font: 12px/1.35 system-ui, sans-serif; border-right: 1px solid #222a33; z-index: 5; }
#tree.collapsed { transform: translateX(-340px); }
#tree header { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid #222a33; }
#tree header b { flex: 1; font-size: 13px; }
#tree .snap { display: flex; gap: 4px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #222a33; }
#tree .snap select { flex: 1; min-width: 0; background: #0a0c0f; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 3px; font-size: 12px; }
#tree .snap .dirty { color: #ff8c1a; font-size: 11px; white-space: nowrap; }
#tree input[type=search] { margin: 8px; padding: 5px 8px; background: #0a0c0f; border: 1px solid #2b3540; color: inherit; border-radius: 4px; }
#tree .scroll { flex: 1; overflow: auto; position: relative; }
#tree .row { position: absolute; left: 0; right: 0; height: ${ROW}px; display: flex; align-items: center; padding-right: 6px; white-space: nowrap; cursor: pointer; }
#tree .row:hover { background: #1b222a; }
#tree .row.sel { background: #3a2a14; }
#tree .caret { width: 16px; text-align: center; color: #7b8794; flex: none; }
#tree .tg { width: 18px; flex: none; text-align: center; color: #9aa6b2; font-size: 11px; }
#tree .tg.off { color: #3d4650; }
#tree .tg.inh { opacity: .45; }
#tree .lbl { overflow: hidden; text-overflow: ellipsis; flex: 1; margin-left: 2px; }
#tree .row.hidden .lbl { color: #5b6670; }
#tree .row.supp .lbl { color: #5b6670; text-decoration: line-through; }
#tree .badge { color: #7b8794; margin-left: 6px; }
#tree .kept { color: #6fc3df; margin-left: 5px; font-size: 11px; }
#tree .kept.inh { opacity: .45; }
#tree .row.drop { outline: 1px dashed #f2b705; outline-offset: -2px; }
#tree .row .fold { color: #c9a45c; margin-right: 3px; }
#tree .info { border-top: 1px solid #222a33; padding: 8px; font-size: 11px; color: #9aa6b2; min-height: 64px; }
#tree .info code { display: block; color: #f2b705; word-break: break-all; margin: 3px 0; font: 11px ui-monospace, monospace; }
#tree .stats { white-space: pre; border-top: 1px solid #222a33; padding: 6px 8px; font: 11px ui-monospace, monospace; color: #7b8794; }
#tree button { background: #222a33; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
#tree.notes { width: ${340 + NOTES_W}px; z-index: 8; }   /* above the view bar, which can spread left in a narrow window */ #tree.notes.collapsed { transform: translateX(-${340 + NOTES_W}px); }
#tree .notesbar { display: flex; gap: 8px; align-items: center; padding: 4px 8px; border-bottom: 1px solid #222a33; color: #9aa6b2; font-size: 11.5px; }
#tree .notesbar label { display: flex; gap: 4px; align-items: center; cursor: pointer; flex: 1; }
#tree.notes .row { padding-right: ${NOTES_W + 6}px; }
#tree .note { position: absolute; right: 0; top: 0; bottom: 0; width: ${NOTES_W}px; display: flex; align-items: center; gap: 4px; padding: 0 6px; border-left: 1px solid #222a33; color: #d7dde4; box-sizing: border-box; }
#tree .note input[type=checkbox] { margin: 0; flex: none; cursor: pointer; }
#tree .note .nt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; cursor: text; }
#tree .note .nt.off { color: #5b6670; } #tree .note .more { color: #7b8794; flex: none; } #tree .note .gone { color: #c9a45c; font-size: 10.5px; flex: none; }
#tree .note .add { color: transparent; cursor: text; flex: 1; } #tree .row:hover .note .add { color: #5b6670; }
#tree .noteedit { position: absolute; z-index: 3; background: #0a0c0f; color: #d7dde4; border: 1px solid #f2b705; border-radius: 3px; padding: 1px 4px; font: 12px system-ui; box-sizing: border-box; }
#tree-toggle { position: absolute; top: 8px; left: 348px; z-index: 6; background:#222a33; color:#d7dde4; border:1px solid #2b3540; border-radius:4px; padding:3px 8px; cursor:pointer; }
.studio-root.tree-collapsed #tree-toggle { left: 8px; }
.studio-root:not(.tree-collapsed) #chapter, .studio-root:not(.tree-collapsed) #sub { left: 392px !important; }
.studio-root:not(.tree-collapsed) #clock { left: 364px !important; }
.studio-root.tree-collapsed #chapter, .studio-root.tree-collapsed #sub { left: 52px !important; }
`;

/** Inside a linked copy (src/scene/copies.ts): its parts are listed like CAD's. */
const inCopy = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.copy !== undefined) return true; return false; };

export interface TreeHooks {
  /** Called after visibility/lock changes on these objects (suppression, recompile…). */
  onChange?: (objs: THREE.Object3D[], what: 'hidden' | 'locked') => void;
  stats?: () => string;
  /** Selection changed: single object, its script spec (@group / id) and all objects selected. */
  onSelect?: (obj: THREE.Object3D | undefined, spec: string | undefined, objs: THREE.Object3D[], clicked?: { spec: string; add: boolean }) => void;
  /** Base colour of a part id / "@group" (undefined: its own). */
  colorOf?: (spec: string) => string | undefined;
  /** Colours already used in the model (base colours first, then CAD material colours) – offered as swatches. */
  modelColors?: () => string[];
  /** Key colour of the generated palette (second swatch row), and changing it. */
  paletteKey?: () => string;
  onPaletteKey?: (hex: string) => void;
  /** Set (hex) or clear (null) base colours. */
  onColor?: (specs: string[], hex: string | null) => void;
  /** Display name of a part (undefined: its CAD name). */
  labelOf?: (id: string) => string | undefined;
  /** Set (name) or clear (null) a part's display name. */
  onLabel?: (id: string, label: string | null) => void;
  /** Remove parts from / restore them to this animation's assembly. */
  onRemove?: (ids: string[], removed: boolean) => void;
  /** Ids removed from the assembly. */
  removedIds?: () => string[];
  /** A group was renamed (rewrite @old → @new in the script) – called before the groups change is applied. */
  onGroupRename?: (from: string, to: string) => void;
  /** a folder (and its sub-folders) renamed: path from → to */
  onFolderRename?: (from: string, to: string) => void;
  /** Annotate… (tree menu): the selection */
  onAnnotate?: () => void;
  /** the Notes column: annotations made on exactly a row's part / group / folder (key: id, "@group" or "folder:path") */
  notes?: {
    of(key: string): { id: string; title: string; show: boolean; hidden: boolean }[];
    /** rename one (id), or add one for the row (no id) */
    title(key: string, id: string | undefined, title: string): void;
    show(id: string, on: boolean): void;
    /** the card in the view, for the note */
    open(id: string): void;
    /** the bar under the header: all on / off in the view, CSV */
    visible(): boolean; setVisible(on: boolean): void; csv(): void;
    /** the column was shown / hidden (the studio moves things over) */
    toggled(on: boolean): void;
  };
  /** Kept uncut by the animation's list: 'own', 'inh' (through an assembly) or not. */
  keptOf?: (obj: THREE.Object3D | undefined, group?: string) => 'own' | 'inh' | undefined;
  /** Keep parts uncut / cut them again. */
  onKeep?: (specs: string[], objs: THREE.Object3D[], on: boolean) => void;
  /** Duplicate the selection as a linked copy */
  onDuplicate?: () => void;
  /** a linked copy (its root): Edit copy… opens its panel */
  isCopy?: (o?: THREE.Object3D) => boolean;
  onEditCopy?: (o: THREE.Object3D) => void;
  /** User groups were created/changed (recompile the script). */
  onGroups?: () => void;
}

export class TreePanel {
  private el: HTMLElement;
  private scroll: HTMLElement;
  private spacer: HTMLElement;
  private info: HTMLElement;
  private statsEl: HTMLElement;
  private search: HTMLInputElement;
  /** Container for the snapshot bar (filled by main). */
  snapBar!: HTMLElement;
  private open = new Set<Node>();
  private roots: Node[] = [];
  private flat: Node[] = [];
  /** Selection (⌘/Ctrl-click toggles a row, Shift-click selects a range); the last one is the primary. */
  private sel: Node[] = [];
  private get selected(): Node | undefined { return this.sel[this.sel.length - 1]; }
  private box = new THREE.Box3Helper(new THREE.Box3(), 0xf2b705);
  /** Meshes currently showing the selection colour (material swapped, original in userData.origMat). */
  private lit: THREE.Mesh[] = [];
  private hiliteMats = new Map<string, THREE.Material>();
  static HILITE = '#ff8c1a';

  constructor(private scene: BuiltScene, three: THREE.Scene, private hooks: TreeHooks = {}) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    this.el = document.createElement('div'); this.el.id = 'tree';
    this.el.innerHTML = `<header><b>Assembly</b><span title="● visible   🔒 locked (never moves)   locked + hidden CAD = suppressed (freed from memory)" style="cursor:help;color:#7b8794">ⓘ</span><button data-a="collapse">Collapse all</button><button data-a="notes" title="Notes: a column of the annotations on each part, solid, group or folder (click one to edit it, an empty cell to add one)">✎ Notes</button></header>
      <div class="snap"></div><div class="notesbar" hidden></div>
      <input type="search" placeholder="Search parts… (Enter)" /><div class="scroll"><div class="spacer"></div></div>
      <div class="info">Click a part in the tree or the 3D view.</div><div class="stats"></div>`;
    host().appendChild(this.el);
    const toggle = document.createElement('button'); toggle.id = 'tree-toggle'; toggle.textContent = '☰';
    toggle.onclick = () => { this.el.classList.toggle('collapsed'); host().classList.toggle('tree-collapsed'); };
    host().appendChild(toggle);
    this.scroll = this.el.querySelector('.scroll')!;
    this.spacer = this.el.querySelector('.spacer')!;
    const notesBtn = this.el.querySelector<HTMLElement>('[data-a=notes]')!;
    if (!this.hooks.notes) notesBtn.hidden = true;
    let on = false;
    try { on = localStorage.getItem('refuel.notesOpen') === '1'; } catch { /* private mode */ }
    notesBtn.onclick = () => this.setNotes(!this.notesOn);
    queueMicrotask(() => { if (on && this.hooks.notes) this.setNotes(true); });
    this.info = this.el.querySelector('.info')!;
    this.statsEl = this.el.querySelector('.stats')!;
    this.search = this.el.querySelector('input')!;
    this.snapBar = this.el.querySelector('.snap')!;
    let t: number | undefined;
    this.search.oninput = () => { clearTimeout(t); t = window.setTimeout(() => this.refresh(), 200); };
    this.scroll.onscroll = () => this.draw();
    this.el.tabIndex = -1;
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'F2') { e.preventDefault(); this.renameSelected(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.sel.some((n) => n.removedRow) ? this.restoreSelected() : this.removeSelected(); }
    });
    this.el.querySelector<HTMLElement>('[data-a=collapse]')!.onclick = () => { this.open.clear(); this.roots.forEach((r) => this.open.add(r)); this.refresh(); };
    new ResizeObserver(() => this.draw()).observe(this.scroll);
    this.box.visible = false; // kept for reference; selection is shown by colour
    three.add(this.box);
    this.rebuild();
  }

  // ---------- model ----------
  rebuild() {
    // keep what was open, the selection and the scroll position (rows are rebuilt: match them by a stable key)
    const prev = this.roots.length ? this.viewState() : undefined;
    this.open.clear();                 // the old rows go; buildRoots opens its defaults, restoreView the rest
    this.buildRoots();
    if (prev) this.restoreView(prev);
    this.refresh();
    if (prev) this.scroll.scrollTop = prev.scroll;
  }

  /** A row's stable key: its path of ids / groups / folders / labels from the root. */
  private keyOf(n: Node): string {
    const own = n.group !== undefined ? `@${n.group}` : n.folder !== undefined ? `f:${n.folder}` : n.removedRow ? `r:${n.id}` : n.id ? `i:${n.id}` : `l:${n.label}`;
    return n.parent ? `${this.keyOf(n.parent)}>${own}` : own;
  }
  private viewState() {
    const open = new Set<string>(), closed = new Set<string>();
    const walk = (n: Node) => {
      if (this.open.has(n)) { open.add(this.keyOf(n)); this.kids(n).forEach(walk); } else closed.add(this.keyOf(n));
    };
    this.roots.forEach(walk);
    return { open, closed, sel: this.sel.map((n) => this.keyOf(n)), scroll: this.scroll.scrollTop };
  }
  private restoreView(v: { open: Set<string>; closed: Set<string>; sel: string[] }) {
    const sel = new Map<string, Node>();
    const want = new Set(v.sel);
    const walk = (n: Node) => {
      const k = this.keyOf(n);
      if (want.has(k)) sel.set(k, n);
      if (v.open.has(k)) this.open.add(n); else if (v.closed.has(k)) this.open.delete(n);
      if (this.open.has(n)) this.kids(n).forEach(walk);
    };
    this.roots.forEach(walk);
    if (this.sel.length) this.sel = v.sel.map((k) => sel.get(k)).filter((n): n is Node => !!n);
  }

  private buildRoots() {
    const reg = this.scene.registry;
    const mk = (label: string, depth: number, extra: Partial<Node> = {}): Node => ({ label, depth, ...extra });
    // generated core: blocks grouped by column (virtual nodes)
    const cols = new Map<string, string[]>();
    const fresh: string[] = [];
    for (const id of this.scene.blockIds) {
      const [col] = id.split('/');
      if (col === 'fresh') fresh.push(id); else (cols.get(col) ?? cols.set(col, []).get(col)!).push(id);
    }
    const gen = mk('Generated model', 0);
    const core = mk('core', 1, { badge: `${cols.size} columns`, parent: gen });
    core.virtualKids = [...cols.entries()].map(([c, ids]) => {
      const n = mk(c, 2, { parent: core });
      n.virtualKids = ids.filter((id) => !reg.get(id)!.userData.removed).map((id) => mk(this.hooks.labelOf?.(id) ?? id.split('/')[1], 3, { id, obj: reg.get(id), parent: n }));
      return n;
    });
    const freshN = mk('fresh fuel', 1, { parent: gen });
    freshN.virtualKids = fresh.filter((id) => !reg.get(id)!.userData.removed).map((id) => mk(this.hooks.labelOf?.(id) ?? id, 2, { id, obj: reg.get(id), parent: freshN }));
    const keep = (id: string) => reg.has(id) && !reg.get(id)!.userData.removed;
    gen.virtualKids = [core, ...['vessel', 'head', 'bolts', 'barrel', 'machine'].filter(keep)
      .map((id) => mk(this.hooks.labelOf?.(id) ?? id, 1, { id, obj: reg.get(id), parent: gen })), freshN];

    const cadRoots = this.scene.root.children.filter((o) => o.userData.cad);
    this.roots = this.scene.blockIds.length || reg.has('vessel') ? [gen] : [];
    this.open.add(gen);
    const groupNames = Object.keys(store.groups ?? {});
    const folderPaths = Object.keys(store.folders ?? {});
    if (groupNames.length || folderPaths.length) {
      // groups, in folders (display only; a folder may hold folders): path "a/b" → group names
      const inFolder = new Map<string, string>();
      for (const [path, names] of Object.entries(store.folders)) for (const n of names) if (store.groups[n]) inFolder.set(n, path);
      const paths = new Set<string>();
      for (const path of folderPaths) { const segs = path.split('/'); for (let i = 1; i <= segs.length; i++) paths.add(segs.slice(0, i).join('/')); }
      const groupNode = (name: string, depth: number, parent: Node) => {
        const ids = store.groups[name];
        const gn = mk(name, depth, { parent, group: name, id: `@${name}`, badge: `${ids.length}` });
        gn.virtualKids = ids.filter((id) => reg.has(id)).map((id) => ({ ...this.objNode(reg.get(id)!, depth + 1, gn), label: this.hooks.labelOf?.(id) ?? id, memberOf: name }));
        return gn;
      };
      const fill = (parent: Node, path: string, depth: number): Node[] => {
        const subs = [...paths].filter((x) => parentPath(x) === path).sort(natural).map((x) => {
          const f = mk(x.slice(x.lastIndexOf('/') + 1), depth, { parent, folder: x });
          f.virtualKids = fill(f, x, depth + 1);
          f.badge = `${this.groupsIn(f).length}`;
          if (this.openFolders.has(x)) this.open.add(f);
          return f;
        });
        return [...subs, ...groupNames.filter((n) => (inFolder.get(n) ?? '') === path).sort(natural).map((n) => groupNode(n, depth, parent))];
      };
      const g = mk('Groups', 0, { folder: '' });
      g.virtualKids = fill(g, '', 1);
      this.roots.unshift(g);
      this.open.add(g);
    }
    if (cadRoots.length) {
      const cad = mk('CAD', 0);
      cad.virtualKids = cadRoots.map((o) => this.objNode(o, 1, cad));
      this.roots.push(cad);
      this.open.add(cad);
    }
    // shapes made in the studio (an array's copies under it)
    const shapesRoot = this.scene.root.children.find((o) => o.userData.shapesRoot);
    if (shapesRoot?.children.length) {
      const sn = mk('Shapes', 0, { badge: String(shapesRoot.children.length) });
      sn.virtualKids = shapesRoot.children.filter((o) => !o.userData.removed).map((o) => {
        const n = this.objNode(o, 1, sn);
        if (o.userData.array) n.virtualKids = o.children.filter((c) => !c.userData.removed).map((c) => this.objNode(c, 2, n));
        return n;
      });
      this.roots.push(sn);
      this.open.add(sn);
    }
    // linked copies (each with its cloned parts under it)
    const copiesRoot = this.scene.root.children.find((o) => o.userData.copiesRoot);
    if (copiesRoot?.children.length) {
      const cn = mk('Copies', 0, { badge: String(copiesRoot.children.length) });
      cn.virtualKids = copiesRoot.children.filter((o) => !o.userData.removed).map((o) => this.objNode(o, 1, cn));
      this.roots.push(cn);
      this.open.add(cn);
    }
    // parts removed from this animation's assembly: listed here, with Restore
    const removed = (this.hooks.removedIds?.() ?? []).filter((id) => reg.has(id));
    if (removed.length) {
      const rn = mk('Removed', 0, { badge: String(removed.length) });
      rn.virtualKids = removed.map((id) => ({ ...this.objNode(reg.get(id)!, 1, rn), removedRow: true, label: this.hooks.labelOf?.(id) ?? id }));
      this.roots.push(rn);
    }
  }

  /** Node for a CAD object. Chains of single-child levels are compacted into one row
   *  ("a › b › c"); the row stands for the deepest object (ids are unchanged). */
  private objNode(o: THREE.Object3D, depth: number, parent?: Node): Node {
    const names: string[] = [];
    const nameOf = (x: THREE.Object3D) => x.name || (x.userData.id as string).split('/').pop()!;
    if ((isCad(o) || inCopy(o)) && o.userData.copy === undefined) {
      while (o.children.length === 1 && o.children[0].userData.id && !(o as THREE.Mesh).isMesh) {
        if (!['model', 'root'].includes(o.name) || !names.length) names.push(nameOf(o));
        o = o.children[0];
      }
    }
    names.push(nameOf(o));
    const own = this.hooks.labelOf?.((o.userData.id ?? o.name) as string);
    const label = own ?? names.filter((n, i) => i === 0 || !['model', 'root'].includes(n)).join(' › ');
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? `×${(o as THREE.InstancedMesh).count}` : undefined;
    return { label, depth, parent, id: o.userData.id ?? o.name, obj: o, badge: inst ?? (o.children.length ? String(o.children.length) : undefined) };
  }

  private kids(n: Node): Node[] {
    if (n.virtualKids) return n.virtualKids;
    if (!n.obj || n.obj.userData.kind === 'block') return [];
    if (!n.kids) {
      // generated groups (vessel, head…) have unnamed internals – don't list them
      n.kids = isCad(n.obj) || inCopy(n.obj) ? n.obj.children.filter((c) => c.userData.id && !c.userData.removed).map((c) => this.objNode(c, n.depth + 1, n)) : [];
    }
    return n.kids;
  }

  private objsOf(n: Node): THREE.Object3D[] {
    if (n.obj) return [n.obj];
    return (n.virtualKids ?? []).flatMap((k) => this.objsOf(k));
  }

  /** Group names in a folder node (and its sub-folders). */
  private groupsIn(n: Node): string[] {
    return (n.virtualKids ?? []).flatMap((k) => (k.group ? [k.group] : k.folder !== undefined ? this.groupsIn(k) : []));
  }
  /** Script spec of a row: "@group", a folder's groups ("@a, @b"), or the id. */
  private specOf(n: Node): string | undefined {
    if (n.group) return `@${n.group}`;
    if (n.folder !== undefined) { const gs = this.groupsIn(n); return gs.length ? gs.map((g) => `@${g}`).join(', ') : undefined; }
    return n.id;
  }
  /** Folders the user opened (kept across rebuilds). */
  private openFolders = new Set<string>();

  // ---------- flatten + virtual draw ----------
  private refresh() {
    const q = this.search.value.trim().toLowerCase();
    const out: Node[] = [];
    if (q) {
      // search walks the whole registry (fast; nothing rendered except matches on screen)
      const walk = (n: Node) => {
        if (n.label.toLowerCase().includes(q) || n.id?.toLowerCase().includes(q)) out.push({ ...n, depth: 0, label: n.id ?? n.label, parent: n.parent });
        this.kids(n).forEach(walk);
      };
      this.roots.forEach(walk);
    } else {
      const walk = (n: Node) => { out.push(n); if (this.open.has(n)) this.kids(n).forEach(walk); };
      this.roots.forEach(walk);
    }
    this.flat = out;
    this.spacer.style.height = `${out.length * ROW}px`;
    this.draw();
  }

  /** The Notes column: shown / hidden (remembered). */
  notesOn = false;
  setNotes(on: boolean) {
    this.notesOn = on;
    this.el.classList.toggle('notes', on);
    this.el.querySelector('[data-a=notes]')!.classList.toggle('on', on);
    const bar = this.el.querySelector<HTMLElement>('.notesbar')!;
    bar.hidden = !on;
    if (on) {
      bar.innerHTML = `<label title="Show or hide every annotation in the 3D view"><input type="checkbox" ${this.hooks.notes!.visible() ? 'checked' : ''}> Show notes in the view</label><button data-a="csv" title="Export every annotation with its parts as CSV">⤓ CSV</button>`;
      bar.querySelector<HTMLInputElement>('input')!.onchange = (e) => this.hooks.notes!.setVisible((e.target as HTMLInputElement).checked);
      bar.querySelector<HTMLElement>('[data-a=csv]')!.onclick = () => this.hooks.notes!.csv();
    }
    try { localStorage.setItem('refuel.notesOpen', on ? '1' : '0'); } catch { /* private mode */ }
    this.hooks.notes?.toggled(on);
    this.draw();
  }
  /** A row's annotation key: its part id, "@group" or "folder:path" (none for headings and removed rows). */
  private noteKey(n: Node): string | undefined {
    if (n.removedRow) return;
    if (n.folder !== undefined) return n.folder ? `folder:${n.folder}` : undefined;
    if (n.group) return `@${n.group}`;
    return n.obj ? n.id : undefined;
  }
  /** Edit a row's note title over its cell (rows are redrawn as the tree scrolls, so the box floats above them). */
  private editNote(cell: HTMLElement, key: string, id: string | undefined, title: string) {
    this.el.querySelector('.noteedit')?.remove();
    const box = document.createElement('input');
    box.className = 'noteedit'; box.value = title; box.placeholder = 'Note title';
    const rc = cell.getBoundingClientRect(), rt = this.el.getBoundingClientRect();
    Object.assign(box.style, { left: `${rc.left - rt.left + 2}px`, top: `${rc.top - rt.top + 1}px`, width: `${rc.width - 4}px`, height: `${rc.height - 2}px` });
    this.el.appendChild(box);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return; done = true;
      box.remove();
      const t = box.value.trim();
      if (save && t !== title && (t || id)) this.hooks.notes!.title(key, id, t);
    };
    box.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    box.onblur = () => finish(true);
    this.scroll.addEventListener('scroll', () => finish(true), { once: true });
    box.focus(); box.select();
  }

  private draw() {
    const top = this.scroll.scrollTop, h = this.scroll.clientHeight;
    const from = Math.max(0, Math.floor(top / ROW) - 10), to = Math.min(this.flat.length, Math.ceil((top + h) / ROW) + 10);
    const frag = document.createDocumentFragment();
    frag.appendChild(this.spacer);
    for (let i = from; i < to; i++) frag.appendChild(this.row(this.flat[i], i));
    this.scroll.replaceChildren(frag);
    this.statsEl.textContent = this.hooks.stats?.() ?? '';
  }

  private row(n: Node, i: number) {
    const objs = this.objsOf(n);
    const hidden = objs.length > 0 && objs.every(isHidden);
    const locked = objs.length > 0 && objs.every(isLocked);
    const explicitH = n.id !== undefined && n.id in state.hidden;
    const explicitL = n.id !== undefined && n.id in state.locked;
    const supp = n.obj?.userData.suppressedRoot || n.removedRow || (n.memberOf && n.obj?.userData.removed);
    const r = document.createElement('div');
    const sameAsSel = this.sel.some((x) => x === n || (n.id && x.id === n.id && !x.group === !n.group));
    r.className = 'row' + (sameAsSel ? ' sel' : '') + (hidden ? ' hidden' : '') + (supp ? ' supp' : '');
    r.style.top = `${i * ROW}px`;
    r.style.paddingLeft = `${n.depth * 12}px`;
    const hasKids = !this.search.value && this.kids(n).length > 0;
    r.innerHTML = `<span class="caret">${hasKids ? (this.open.has(n) ? '▾' : '▸') : ''}</span>
      <span class="tg ${hidden ? 'off' : ''} ${explicitH ? '' : 'inh'}" title="show / hide">●</span>
      <span class="tg ${locked ? '' : 'off'} ${explicitL ? '' : 'inh'}" title="lock / unlock">${locked ? '🔒' : '🔓'}</span>
      <span class="lbl" title="${esc(n.id ?? n.folder ?? n.label)}">${n.folder ? '<span class="fold">▤</span>' : ''}${esc(n.label)}</span>${(() => { const c = this.hooks.colorOf?.(n.group ? `@${n.group}` : n.id ?? ''); return c ? `<span style="width:9px;height:9px;border-radius:2px;margin-left:6px;flex:none;background:${c}"></span>` : ''; })()}${(() => { const k = n.folder === undefined && !n.removedRow ? this.hooks.keptOf?.(n.obj, n.group) : undefined; return k ? `<span class="kept ${k}" title="${k === 'own' ? 'Kept uncut: cuts leave it whole' : 'Kept uncut through an assembly it belongs to'}">✂</span>` : ''; })()}${n.badge ? `<span class="badge">${n.badge}</span>` : ''}`;
    const [caret, eye, lock] = r.children as unknown as HTMLElement[];
    // the Notes column: this row's own annotations – checkbox + title (+N), "part hidden"; click to edit, empty to add
    const key = this.notesOn ? this.noteKey(n) : undefined;
    if (this.notesOn) {
      const cell = document.createElement('span'); cell.className = 'note';
      const ns = key ? this.hooks.notes!.of(key) : [];
      const first = ns[0];
      if (first) {
        cell.innerHTML = `<input type="checkbox" ${first.show ? 'checked' : ''} title="Show this note in the view (a hidden part hides it anyway)"><span class="nt${first.show ? '' : ' off'}" title="${esc(first.title)} – click to edit, double-click for the note">${esc(first.title || '(untitled)')}</span>${ns.length > 1 ? `<span class="more" title="${esc(ns.slice(1).map((x) => x.title).join(', '))}">+${ns.length - 1}</span>` : ''}${first.hidden ? '<span class="gone" title="Its part is hidden">part hidden</span>' : ''}`;
        const cb = cell.querySelector<HTMLInputElement>('input')!;
        cb.onclick = (e) => { e.stopPropagation(); this.hooks.notes!.show(first.id, cb.checked); };
        const nt = cell.querySelector<HTMLElement>('.nt')!;
        let clickT: number | undefined;
        nt.onclick = (e) => { e.stopPropagation(); clearTimeout(clickT); clickT = window.setTimeout(() => this.editNote(cell, key!, first.id, first.title), 220); };
        nt.ondblclick = (e) => { e.stopPropagation(); clearTimeout(clickT); this.hooks.notes!.open(first.id); };
      } else if (key) {
        cell.innerHTML = `<span class="add" title="Add a note for this row">+ note</span>`;
        cell.querySelector<HTMLElement>('.add')!.onclick = (e) => { e.stopPropagation(); this.editNote(cell, key, undefined, ''); };
      }
      cell.ondblclick = (e) => e.stopPropagation();
      r.appendChild(cell);
    }
    caret.onclick = (e) => { e.stopPropagation(); this.toggleOpen(n); };
    eye.onclick = (e) => { e.stopPropagation(); this.setFlag(n, 'hidden', !hidden); };
    lock.onclick = (e) => { e.stopPropagation(); this.setFlag(n, 'locked', !locked); };
    r.onmousedown = (e) => { if (e.shiftKey) e.preventDefault(); }; // no text selection on shift-click
    r.onclick = (e) => (e.shiftKey ? this.selectRange(n, e.metaKey || e.ctrlKey) : this.select(n, false, e.metaKey || e.ctrlKey));
    r.oncontextmenu = (e) => {
      e.preventDefault();
      if (!this.sel.includes(n)) this.select(n, false);
      this.menu(e.clientX, e.clientY);
    };
    r.ondblclick = () => this.toggleOpen(n);
    // drag groups / folders onto a folder (or the Groups heading = top level)
    if (n.group || n.folder) {
      r.draggable = true;
      r.ondragstart = (e) => {
        const drag = this.sel.includes(n) ? this.sel.filter((x) => x.group || x.folder) : [n];
        e.dataTransfer!.setData('text/x-groups', JSON.stringify(drag.map((x) => (x.group ? { group: x.group } : { folder: x.folder }))));
        e.dataTransfer!.effectAllowed = 'move';
      };
    }
    if (n.folder !== undefined) {
      r.ondragover = (e) => { if (e.dataTransfer?.types.includes('text/x-groups')) { e.preventDefault(); r.classList.add('drop'); } };
      r.ondragleave = () => r.classList.remove('drop');
      r.ondrop = (e) => {
        e.preventDefault(); r.classList.remove('drop');
        try { this.moveTo(JSON.parse(e.dataTransfer!.getData('text/x-groups')), n.folder!); } catch { /* not ours */ }
      };
    }
    return r;
  }

  private toggleOpen(n: Node) {
    const opening = !this.open.has(n);
    opening ? this.open.add(n) : this.open.delete(n);
    if (n.folder) opening ? this.openFolders.add(n.folder) : this.openFolders.delete(n.folder);
    this.refresh();
  }

  /** Set a flag on a node: explicit flag on its id(s); descendants' explicit flags are cleared so they inherit. */
  private setFlag(n: Node, what: 'hidden' | 'locked', value: boolean) {
    const objs = this.objsOf(n);
    const flags = state[what];
    for (const o of objs) {
      const id = (o.userData.id ?? o.name) as string;
      o.traverse((d) => { const did = (d.userData.id ?? d.name) as string; if (did && did !== id) delete flags[did]; });
      flags[id] = value;
    }
    markDirty();
    this.hooks.onChange?.(objs, what);
    this.refresh();
    this.updateInfo();
  }

  // ---------- selection ----------
  select(n: Node | undefined, reveal: boolean, additive = false) {
    this.anchor = n;
    if (additive && n) {
      const i = this.sel.findIndex((x) => x === n || (n.id && x.id === n.id));
      if (i >= 0) this.sel.splice(i, 1); else this.sel.push(n);
    } else this.sel = n ? [n] : [];
    this.highlight();
    const one = this.sel.length === 1 ? this.sel[0] : undefined;
    const clicked = n && this.specOf(n);
    this.hooks.onSelect?.(one?.obj, one && one.folder === undefined ? (one.group ? `@${one.group}` : one.id) : undefined, this.sel.flatMap((x) => this.objsOf(x)),
      clicked && this.sel.includes(n!) ? { spec: clicked, add: additive } : undefined);
    if (n && reveal) {
      this.search.value = '';
      for (let p = n.parent; p; p = p.parent) this.open.add(p);
    }
    this.updateInfo();
    this.refresh();
    if (n && reveal) {
      const i = this.flat.findIndex((x) => x === n || (n.id && x.id === n.id));
      if (i >= 0) this.scroll.scrollTop = Math.max(0, i * ROW - this.scroll.clientHeight / 2);
    }
  }

  /** Row the last plain / ⌘-click landed on: where a Shift-click range starts. */
  private anchor?: Node;
  /** Shift-click: every visible row from the anchor to n (⌘/Ctrl+Shift adds the range to the selection). */
  selectRange(n: Node, add = false) {
    const same = (a: Node, b: Node) => a === b || (!!a.id && a.id === b.id && !a.group === !b.group);
    const i = this.anchor ? this.flat.findIndex((x) => same(x, this.anchor!)) : -1, j = this.flat.findIndex((x) => same(x, n));
    if (i < 0 || j < 0) return this.select(n, false, add);
    const range = this.flat.slice(Math.min(i, j), Math.max(i, j) + 1)
      .filter((x) => x.depth > 0 && !x.removedRow === !n.removedRow);            // not the section headings; don't mix Removed rows in
    const keep = add ? this.sel.filter((x) => !range.some((r) => same(r, x))) : [];
    this.sel = [...keep, ...range.filter((x) => x !== n), n];                       // the clicked row is the primary
    this.highlight();
    this.hooks.onSelect?.(undefined, undefined, this.sel.flatMap((x) => this.objsOf(x)));
    this.updateInfo();
    this.refresh();
  }

  /** Currently selected real object (single object nodes only). */
  get selectedObject(): THREE.Object3D | undefined { return this.sel.length === 1 ? this.selected?.obj : undefined; }
  /** Redraw rows + info (after external state changes). */
  redraw() { this.refresh(); this.updateInfo(); }

  /** Select by registry id (e.g. from ?select=). */
  selectId(id: string) { const o = this.scene.registry.get(id); if (o) this.pick(o); }

  /** Select many objects at once (e.g. every part matching a name); one selection event. */
  selectObjects(objs: THREE.Object3D[]) {
    const nodes = [...new Set(objs.map((o) => this.nodeOf(o)).filter(Boolean) as Node[])];
    this.sel = nodes;
    this.highlight();
    const one = nodes.length === 1 ? nodes[0] : undefined;
    this.hooks.onSelect?.(one?.obj, one ? one.id : undefined, nodes.flatMap((x) => this.objsOf(x)));
    this.updateInfo();
    this.refresh();
  }

  /** The tree row of a registered object (materialising lazy levels). */
  private nodeOf(obj: THREE.Object3D): Node | undefined {
    const chain: THREE.Object3D[] = [];
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (this.scene.registry.get((o.userData.id ?? o.name) as string) === o) chain.unshift(o);
    let level = this.roots, found: Node | undefined;
    const search = (nodes: Node[], target: THREE.Object3D): Node | undefined => {
      for (const n of nodes) {
        if (n.obj === target) return n;
        if (!n.obj && !n.group && n.folder === undefined && !n.removedRow) { const r = search(this.kids(n), target); if (r) return r; }
      }
    };
    for (const o of chain) { const n = search(level, o); if (!n) continue; found = n; level = this.kids(n); }
    return found?.obj === obj ? found : undefined;
  }

  /** Select the registered object containing this 3D object (from a 3D pick). */
  pick(obj: THREE.Object3D | undefined, additive = false) {
    if (!obj) return additive ? undefined : this.select(undefined, false);
    // chain of registered ancestors, root first
    const chain: THREE.Object3D[] = [];
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (this.scene.registry.get((o.userData.id ?? o.name) as string) === o) chain.unshift(o);
    if (!chain.length) return this.select(undefined, false);
    // walk the tree model down the chain, materialising lazy children as needed
    let level = this.roots;
    let found: Node | undefined;
    const search = (nodes: Node[], target: THREE.Object3D): Node | undefined => {
      for (const n of nodes) {
        if (n.obj === target) return n;
        if (!n.obj) { const r = search(this.kids(n), target); if (r) return r; }
      }
    };
    for (const o of chain) {
      const n = search(level, o);
      if (!n) continue; // compacted level: the row is a deeper object in the chain
      found = n;
      level = this.kids(n);
    }
    this.select(found, true, additive);
  }

  /** Colour the selected meshes; restore the previous selection's materials. */
  private highlight() {
    for (const m of this.lit) { m.material = m.userData.origMat; delete m.userData.origMat; }
    this.lit = [];
    for (const o of this.sel.flatMap((n) => this.objsOf(n))) o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh || m.userData.origMat) return;
      const orig = m.material as THREE.Material;
      if (orig.side === THREE.BackSide) return; // outline hulls stay black
      const clip = orig.clippingPlanes?.length ? 'clip' : 'noclip';
      let h = this.hiliteMats.get(clip);
      if (!h) {
        h = withCaps(new THREE.MeshToonMaterial({ color: TreePanel.HILITE, side: THREE.DoubleSide,
          clippingPlanes: orig.clippingPlanes ?? undefined, clipIntersection: orig.clipIntersection }));
        this.hiliteMats.set(clip, h);
      }
      m.userData.origMat = orig;
      m.material = h;
      this.lit.push(m);
    });
  }

  private updateInfo() {
    const n = this.selected;
    if (!n) { this.info.textContent = 'Click a part in the tree or the 3D view. ⌘/Ctrl-click to select several.'; return; }
    if (this.sel.length > 1) {
      this.info.innerHTML = `<div>${this.sel.length} items selected</div>
        <div style="margin-top:4px"><button data-a="group">Group…</button></div>${this.colorRow()}`;
      this.wireGroupButtons();
      this.wireColor();
      return;
    }
    if (n.folder !== undefined) {
      const gs = this.groupsIn(n);
      this.info.innerHTML = `<div><span class="fold">▤</span> ${n.folder ? esc(n.folder) : 'Groups'} · ${gs.length} group${gs.length === 1 ? '' : 's'}, ${this.objsOf(n).length} parts</div>
        <div style="margin-top:3px;color:#7b8794">Drag groups or folders onto a folder to file them. Folders are for the tree only; scripts use the groups.</div>
        <div style="margin-top:4px"><button data-a="newfolder">New folder…</button>${n.folder ? ` <button data-a="frename">Rename</button> <button data-a="fdelete">Delete folder</button>` : ''}</div>${gs.length ? this.colorRow() : ''}`;
      const on = (a: string, f: () => void) => this.info.querySelector<HTMLElement>(`[data-a=${a}]`)?.addEventListener('click', f);
      on('newfolder', () => this.newFolder(n.folder!));
      on('frename', () => this.renameSelected());
      on('fdelete', () => this.removeSelected());
      this.wireColor();
      return;
    }
    const box = new THREE.Box3();
    this.objsOf(n).forEach((o) => box.expandByObject(o));
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const objs = this.objsOf(n);
    const locked = objs.every(isLocked);
    this.info.innerHTML = `<div>${esc(n.label)}${n.badge ? ` <span class="badge">${n.badge}</span>` : ''} · ${locked ? '🔒 locked' : '🔓 movable'}</div>
      ${n.id ? `<code>${esc(n.id)}</code><button data-a="copy">Copy id</button>` : '<div><i>group (not scriptable by id)</i></div>'}
      ${box.isEmpty() ? '' : `<div style="margin-top:4px">size ${fmt(size)} m · centre ${fmt(c)}</div>`}
      <div style="margin-top:4px">${n.group ? `<button data-a="ungroup">Delete group</button> <button data-a="rename">Rename</button> <button data-a="movefolder">Move to folder…</button>`
        : n.memberOf ? `<button data-a="unmember">Remove from ${esc(n.memberOf)}</button>`
        : n.removedRow ? `<button data-a="restore">Restore</button>`
        : n.id ? `<button data-a="group">Group…</button> <button data-a="partrename" title="F2">Rename</button> <button data-a="partremove" title="Delete">Remove</button>` : ''}</div>`;
    this.info.insertAdjacentHTML('beforeend', this.colorRow());
    this.info.querySelector<HTMLElement>('[data-a=copy]')?.addEventListener('click', () => navigator.clipboard?.writeText(n.id!));
    this.wireGroupButtons();
    this.wireColor();
  }

  // ---------- base colours ----------
  /** Specs of the selection: "@group" for group rows, ids for parts (virtual folders: their parts). */
  /** Script specs of the selection ("@group", ids; folders: their groups). */
  selectedSpecs() { return this.selSpecs(); }
  /** The folder path when the selection is one folder row. */
  selectedFolder(): string | undefined { return this.sel.length === 1 && this.sel[0].folder ? this.sel[0].folder : undefined; }
  private selSpecs(): string[] {
    return [...new Set(this.sel.flatMap((n) => (n.group ? [`@${n.group}`] : n.folder !== undefined ? this.groupsIn(n).map((g) => `@${g}`) : n.id ? [n.id] : this.objsOf(n).map((o) => (o.userData.id ?? o.name) as string))))];
  }
  private colorRow() {
    if (!this.hooks.onColor) return '';
    const specs = this.selSpecs();
    const cur = specs.map((sp) => this.hooks.colorOf?.(sp)).find(Boolean);
    const used = (this.hooks.modelColors?.() ?? []).slice(0, 18);
    const swatches = used.length ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:6px" title="Colours already in the model">${used.map((c) =>
      `<button data-swatch="${c}" title="${c}" style="width:16px;height:16px;padding:0;border-radius:3px;border:1px solid ${c === cur ? '#f2b705' : '#2b3540'};background:${c};cursor:pointer"></button>`).join('')}</div>` : '';
    const key = this.hooks.paletteKey?.();
    const sw = (c: string, t: string) => `<button data-swatch="${c}" title="${t}" style="width:16px;height:16px;padding:0;border-radius:3px;border:1px solid ${c === cur ? '#f2b705' : '#2b3540'};background:${c};cursor:pointer"></button>`;
    const pal = key ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:5px;align-items:center" data-row="palette">
      <label style="display:flex;align-items:center;gap:4px;margin-right:4px;color:#7b8794;font-size:11px" title="Pick the key colour; the palette (complementary, split complementary, triadic, analogous) is built from it">Palette
        <input type="color" data-a="palkey" value="${key}" style="width:30px;height:18px;padding:0;border:1px solid #2b3540;background:none;cursor:pointer"></label>
      ${palette(key).map((p) => sw(p.hex, `${p.role} ${p.hex}`)).join('')}</div>` : '';
    return `${swatches}${pal}<div style="margin-top:6px;display:flex;align-items:center;gap:6px">Colour
      <input type="color" data-a="color" value="${cur ?? '#cccccc'}" title="Any colour" style="width:34px;height:20px;padding:0;border:1px solid #2b3540;background:none">
      ${cur ? `<span style="font:11px ui-monospace,monospace">${cur}</span><button data-a="uncolor" title="Back to the CAD / default colour">Reset</button>` : '<span style="color:#7b8794">default</span>'}</div>`;
  }
  private wireColor() {
    const specs = this.selSpecs();
    const inp = this.info.querySelector<HTMLInputElement>('[data-a=color]');
    if (inp) inp.onchange = () => this.hooks.onColor?.(specs, inp.value);
    const pk = this.info.querySelector<HTMLInputElement>('[data-a=palkey]');
    if (pk) pk.onchange = () => { this.hooks.onPaletteKey?.(pk.value); this.updateInfo(); };
    this.info.querySelectorAll<HTMLElement>('[data-swatch]').forEach((b) => (b.onclick = () => this.hooks.onColor?.(specs, b.dataset.swatch!)));
    this.info.querySelector<HTMLElement>('[data-a=uncolor]')?.addEventListener('click', () => this.hooks.onColor?.(specs, null));
  }

  // ---------- utility tools (the floating tool bar) ----------
  /** The selection's parts: how many, and whether all of them are hidden (blanked). */
  selectionInfo() {
    const objs = this.sel.filter((n) => !n.removedRow).flatMap((n) => this.objsOf(n));
    return { count: this.sel.length, allHidden: objs.length > 0 && objs.every(isHidden) };
  }
  /** Blank (hide) the selected parts, or unblank them when they are all hidden. */
  toggleHiddenSelected() {
    const { count, allHidden } = this.selectionInfo();
    if (!count) return;
    this.sel.filter((n) => !n.removedRow).forEach((n) => this.setFlag(n, 'hidden', !allHidden));
    this.updateInfo();
  }
  /** Make a group (@name) from the selection, or add it to an existing group. */
  groupSelected() {
    if (!this.sel.length) return;
    const ids = [...new Set(this.sel.flatMap((n) => this.objsOf(n)).map((o) => (o.userData.id ?? o.name) as string))];
    const existing = Object.keys(store.groups).join(', ');
    const name = prompt(`Group name (new, or existing to add to)${existing ? `\nExisting: ${existing}` : ''}`)?.trim().replace(/\s+/g, '-');
    if (!name) return;
    const set = new Set([...(store.groups[name] ?? []), ...ids]);
    // drop members already covered by an ancestor member
    const objs = [...set].map((id) => this.scene.registry.get(id)).filter(Boolean) as THREE.Object3D[];
    const covered = (o: THREE.Object3D) => { for (let p = o.parent; p; p = p.parent) if (objs.includes(p)) return true; return false; };
    store.groups[name] = objs.filter((o) => !covered(o)).map((o) => (o.userData.id ?? o.name) as string);
    this.groupsChanged();
  }

  // ---------- user groups ----------
  private wireGroupButtons() {
    const on = (a: string, f: () => void) => this.info.querySelector<HTMLElement>(`[data-a=${a}]`)?.addEventListener('click', f);
    on('group', () => this.groupSelected());
    on('ungroup', () => this.removeSelected());
    on('rename', () => this.renameSelected());
    on('partrename', () => this.renameSelected());
    on('partremove', () => this.removeSelected());
    on('restore', () => this.restoreSelected());
    on('movefolder', () => this.moveSelectedPrompt());
    on('unmember', () => {
      const n = this.selected!;
      store.groups[n.memberOf!] = store.groups[n.memberOf!].filter((id) => id !== n.id);
      this.sel = []; this.groupsChanged();
    });
  }

  // ---------- rename / remove / restore (context menu, F2, Delete) ----------
  /** The last deleted group, for "Undo delete" (a script line still using it offers it as a quick-fix). */
  lastDeletedGroup?: { name: string; ids: string[] };

  private partIds(nodes = this.sel) {
    return [...new Set(nodes.filter((n) => !n.group && n.folder === undefined && !n.removedRow).flatMap((n) => (n.id && n.obj ? [n.id] : this.objsOf(n).map((o) => (o.userData.id ?? o.name) as string))))];
  }

  renameSelected() {
    const n = this.selected;
    if (!n || this.sel.length !== 1) return;
    if (n.folder !== undefined) {
      if (!n.folder) return;
      const leaf = prompt('Rename folder', n.label)?.trim();
      if (!leaf || leaf === n.label) return;
      if (leaf.includes('/')) return alert('Folder names can\'t contain "/".');
      this.materialize();
      const parent = parentPath(n.folder), to = parent ? `${parent}/${leaf}` : leaf;
      if (Object.keys(store.folders).some((p) => p === to || p.startsWith(`${to}/`))) return alert(`A folder "${leaf}" already exists here.`);
      this.hooks.onFolderRename?.(n.folder, to);
      store.folders = Object.fromEntries(Object.entries(store.folders).map(([p, gs]) => [p === n.folder || p.startsWith(`${n.folder}/`) ? to + p.slice(n.folder!.length) : p, gs]));
      for (const p of [...this.openFolders]) if (p === n.folder || p.startsWith(`${n.folder}/`)) { this.openFolders.delete(p); this.openFolders.add(to + p.slice(n.folder.length)); }
      this.sel = []; this.groupsChanged();
      return;
    }
    if (n.group) {
      const to = prompt('Rename group (script lines using it are updated)', n.group)?.trim().replace(/\s+/g, '-');
      if (!to || to === n.group) return;
      if (!/^[\w.-]+$/.test(to)) return alert('Group names use letters, digits, - _ and .');
      if (store.groups[to]) return alert(`A group @${to} already exists.`);
      this.hooks.onGroupRename?.(n.group, to);
      store.groups[to] = store.groups[n.group]; delete store.groups[n.group];
      for (const gs of Object.values(store.folders)) { const i = gs.indexOf(n.group); if (i >= 0) gs[i] = to; }
      this.sel = []; this.groupsChanged();
      return;
    }
    if (!n.id || !n.obj) return;
    const name = prompt('Display name (empty: the CAD name). Scripts keep using the id.', this.hooks.labelOf?.(n.id) ?? n.label);
    if (name === null) return;
    this.hooks.onLabel?.(n.id, name.trim() || null);
  }

  removeSelected() {
    const fold = this.sel.length === 1 ? this.sel[0].folder : undefined;
    if (fold) {
      const n = this.sel[0];
      if (!confirm(`Delete folder "${n.label}"? Its groups and folders move up a level; groups and parts are not deleted.`)) return;
      this.materialize();
      const up = parentPath(fold);
      const next: Record<string, string[]> = {};
      for (const [p, gs] of Object.entries(store.folders)) {
        const q = p === fold ? up : p.startsWith(`${fold}/`) ? (up ? `${up}/` : '') + p.slice(fold.length + 1) : p;
        if (q) next[q] = [...(next[q] ?? []), ...gs]; // top level: groups simply leave the folder
        else if (p !== fold) next[p] = gs;
      }
      store.folders = next;
      this.sel = []; this.groupsChanged();
      return;
    }
    const groups = this.sel.filter((n) => n.group).map((n) => n.group!);
    if (groups.length === 1 && this.sel.length === 1) {
      const g = groups[0];
      if (!confirm(`Delete group "@${g}"? Its parts are not affected.`)) return;
      this.lastDeletedGroup = { name: g, ids: store.groups[g] };
      delete store.groups[g]; this.unfile([g]); this.sel = []; this.groupsChanged();
      return;
    }
    const ids = this.partIds();
    if (!ids.length) return;
    this.sel = []; this.highlight();
    this.hooks.onRemove?.(ids, true);
  }

  restoreSelected() {
    const ids = [...new Set(this.sel.filter((n) => n.removedRow || n.obj?.userData.removed).map((n) => n.id!).filter(Boolean))];
    if (ids.length) { this.sel = []; this.hooks.onRemove?.(ids, false); }
  }

  private menuEl?: HTMLElement;
  private menu(x: number, y: number) {
    this.menuEl?.remove();
    const n = this.selected; if (!n) return;
    const many = this.sel.length > 1;
    const items: [string, () => void][] = [];
    if (n.removedRow) items.push([`Restore${many ? ` ${this.sel.length} parts` : ''}`, () => this.restoreSelected()]);
    else if (n.folder !== undefined && !many) {
      items.push(['New folder…', () => this.newFolder(n.folder!)]);
      if (n.folder) items.push(['Rename folder…  F2', () => this.renameSelected()], ['Move to folder…', () => this.moveSelectedPrompt()], ['Delete folder  ⌫', () => this.removeSelected()]);
    }
    else if (this.sel.every((x) => x.group || x.folder)) {
      if (!many) items.push(['Rename group…  F2', () => this.renameSelected()], ['Delete group  ⌫', () => this.removeSelected()]);
      items.push([`Move to folder…${many ? ` (${this.sel.length})` : ''}`, () => this.moveSelectedPrompt()]);
    }
    else {
      if (!many && n.id && n.obj) items.push(['Rename (display name)…  F2', () => this.renameSelected()]);
      if (this.partIds().length) items.push([`Remove from assembly${many ? ` (${this.partIds().length})` : ''}  ⌫`, () => this.removeSelected()]);
      if (!many && n.memberOf) items.push([`Remove from @${n.memberOf}`, () => { store.groups[n.memberOf!] = store.groups[n.memberOf!].filter((i) => i !== n.id); this.sel = []; this.groupsChanged(); }]);
    }
    if (!n.removedRow) {
      const objs = this.sel.flatMap((s) => this.objsOf(s));
      const allLocked = objs.length > 0 && objs.every(isLocked), allHidden = objs.length > 0 && objs.every(isHidden);
      items.push([allLocked ? 'Unlock' : 'Lock', () => this.sel.forEach((s) => this.setFlag(s, 'locked', !allLocked))]);
      items.push([allHidden ? 'Show' : 'Hide', () => this.sel.forEach((s) => this.setFlag(s, 'hidden', !allHidden))]);
    }
    if (!n.removedRow && this.hooks.onKeep) {
      const objs = this.sel.flatMap((s) => this.objsOf(s));
      const all = objs.length > 0 && this.sel.every((s) => s.group ? this.hooks.keptOf?.(undefined, s.group) : s.obj ? this.hooks.keptOf?.(s.obj) : false);
      if (objs.length) items.push([all ? 'Cut again' : 'Keep uncut  K', () => this.hooks.onKeep!(this.selSpecs(), objs, !all)]);
    }
    if (!many && n.obj && this.hooks.isCopy?.(n.obj)) items.push(['Edit copy…', () => this.hooks.onEditCopy!(n.obj!)]);
    if (!n.removedRow && n.folder === undefined && this.hooks.onDuplicate) items.push(['Duplicate (linked copy)  ⌘D', () => this.hooks.onDuplicate!()]);
    if (!n.removedRow && this.hooks.onAnnotate && (n.folder || n.group || n.id)) items.push(['Annotate…', () => this.hooks.onAnnotate!()]);
    if (!many && n.id) items.push(['Copy id', () => navigator.clipboard?.writeText(n.id!)]);
    const m = document.createElement('div');
    m.className = 'treemenu';
    m.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:50;background:#14191f;border:1px solid #2b3540;border-radius:6px;padding:4px;min-width:200px;box-shadow:0 6px 20px #0008;font:12px system-ui;color:#d7dde4`;
    for (const [label, f] of items) {
      const b = document.createElement('div');
      b.textContent = label; b.setAttribute('role', 'menuitem');
      b.style.cssText = 'padding:5px 10px;border-radius:4px;cursor:pointer;white-space:pre';
      b.onmouseenter = () => (b.style.background = '#26303a'); b.onmouseleave = () => (b.style.background = '');
      b.onclick = () => { m.remove(); f(); };
      m.appendChild(b);
    }
    document.body.appendChild(m);
    this.menuEl = m;
    const close = (e: Event) => { if (!m.contains(e.target as HTMLElement)) { m.remove(); removeEventListener('mousedown', close, true); } };
    setTimeout(() => addEventListener('mousedown', close, true));
  }

  // ---------- folders of groups (tree only) ----------
  /** Take groups out of whatever folder holds them. */
  /** Make implied parent folders explicit (so they survive their children moving away). */
  private materialize() {
    for (const p of Object.keys(store.folders)) { const segs = p.split('/'); for (let i = 1; i < segs.length; i++) store.folders[segs.slice(0, i).join('/')] ??= []; }
  }
  private unfile(names: string[]) {
    for (const gs of Object.values(store.folders)) for (const g of names) { const i = gs.indexOf(g); if (i >= 0) gs.splice(i, 1); }
  }
  /** New folder inside `parent` ("" = top level); the selected groups go into it. */
  newFolder(parent = '') {
    const leaf = prompt('New folder name')?.trim();
    if (!leaf) return;
    if (leaf.includes('/')) return alert('Folder names can\'t contain "/".');
    const path = parent ? `${parent}/${leaf}` : leaf;
    if (!Object.keys(store.folders).some((p) => p === path || p.startsWith(`${path}/`))) store.folders[path] = [];
    this.openFolders.add(path); if (parent) this.openFolders.add(parent);
    const gs = this.sel.filter((n) => n.group).map((n) => n.group!);
    if (gs.length) { this.unfile(gs); store.folders[path].push(...gs); }
    this.sel = []; this.groupsChanged();
  }
  /** Move groups and folders into folder `to` ("" = top level). */
  moveTo(items: { group?: string; folder?: string }[], to: string) {
    this.materialize();
    const groups = items.filter((i) => i.group && store.groups[i.group]).map((i) => i.group!);
    this.unfile(groups);
    if (to) (store.folders[to] ??= []).push(...groups);
    for (const { folder } of items) {
      if (!folder || to === folder || to.startsWith(`${folder}/`)) continue; // not into itself
      const leaf = folder.slice(folder.lastIndexOf('/') + 1), dest = to ? `${to}/${leaf}` : leaf;
      if (dest === folder) continue;
      if (Object.keys(store.folders).some((p) => p === dest || p.startsWith(`${dest}/`))) { alert(`"${leaf}" already exists there.`); continue; }
      store.folders = Object.fromEntries(Object.entries(store.folders).map(([p, gs]) => [p === folder || p.startsWith(`${folder}/`) ? dest + p.slice(folder.length) : p, gs]));
      if (this.openFolders.delete(folder)) this.openFolders.add(dest);
    }
    if (to) this.openFolders.add(to);
    this.groupsChanged();
  }
  /** Ask for a folder and move the selected groups / folders there. */
  moveSelectedPrompt() {
    const items = this.sel.filter((n) => n.group || n.folder).map((n) => (n.group ? { group: n.group } : { folder: n.folder }));
    if (!items.length) return;
    const all = [...new Set(Object.keys(store.folders).flatMap((p) => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort(natural);
    const to = prompt(`Move to folder (a/b makes nested folders; empty = top level)${all.length ? `\nFolders: ${all.join(', ')}` : ''}`)?.trim();
    if (to === undefined) return;
    const path = to.split('/').map((s) => s.trim()).filter(Boolean).join('/');
    if (path && !(path in store.folders)) store.folders[path] = [];
    this.moveTo(items, path);
  }

  private groupsChanged() {
    markDirty();
    this.highlight();
    this.rebuild();
    this.updateInfo();
    this.hooks.onGroups?.();
  }

  /** Per frame: keep selection box on animated objects; refresh stats occasionally. */
  private frame = 0;
  update() {
    if (++this.frame % 30 === 0) this.statsEl.textContent = this.hooks.stats?.() ?? '';
  }
}

const parentPath = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const fmt = (v: THREE.Vector3) => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
