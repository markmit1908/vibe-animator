import { host } from './host';
import * as THREE from 'three';
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
  memberOf?: string;           // direct member row of this group
  removedRow?: boolean;        // a row of the Removed section
  parent?: Node;
  depth: number;
}

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
#tree .info { border-top: 1px solid #222a33; padding: 8px; font-size: 11px; color: #9aa6b2; min-height: 64px; }
#tree .info code { display: block; color: #f2b705; word-break: break-all; margin: 3px 0; font: 11px ui-monospace, monospace; }
#tree .stats { white-space: pre; border-top: 1px solid #222a33; padding: 6px 8px; font: 11px ui-monospace, monospace; color: #7b8794; }
#tree button { background: #222a33; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
#tree-toggle { position: absolute; top: 8px; left: 348px; z-index: 6; background:#222a33; color:#d7dde4; border:1px solid #2b3540; border-radius:4px; padding:3px 8px; cursor:pointer; }
.studio-root.tree-collapsed #tree-toggle { left: 8px; }
.studio-root:not(.tree-collapsed) #chapter, .studio-root:not(.tree-collapsed) #sub { left: 392px !important; }
.studio-root:not(.tree-collapsed) #clock { left: 364px !important; }
.studio-root.tree-collapsed #chapter, .studio-root.tree-collapsed #sub { left: 52px !important; }
`;

export interface TreeHooks {
  /** Called after visibility/lock changes on these objects (suppression, recompile…). */
  onChange?: (objs: THREE.Object3D[], what: 'hidden' | 'locked') => void;
  stats?: () => string;
  /** Selection changed: single object, its script spec (@group / id) and all objects selected. */
  onSelect?: (obj: THREE.Object3D | undefined, spec: string | undefined, objs: THREE.Object3D[], clicked?: { spec: string; add: boolean }) => void;
  /** Base colour of a part id / "@group" (undefined: its own). */
  colorOf?: (spec: string) => string | undefined;
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
  /** Selection (⌘/Ctrl/Shift-click adds); the last one is the primary. */
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
    this.el.innerHTML = `<header><b>Assembly</b><span title="● visible   🔒 locked (never moves)   locked + hidden CAD = suppressed (freed from memory)" style="cursor:help;color:#7b8794">ⓘ</span><button data-a="collapse">Collapse all</button></header>
      <div class="snap"></div>
      <input type="search" placeholder="Search parts… (Enter)" /><div class="scroll"><div class="spacer"></div></div>
      <div class="info">Click a part in the tree or the 3D view.</div><div class="stats"></div>`;
    host().appendChild(this.el);
    const toggle = document.createElement('button'); toggle.id = 'tree-toggle'; toggle.textContent = '☰';
    toggle.onclick = () => { this.el.classList.toggle('collapsed'); host().classList.toggle('tree-collapsed'); };
    host().appendChild(toggle);
    this.scroll = this.el.querySelector('.scroll')!;
    this.spacer = this.el.querySelector('.spacer')!;
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
    const groups = Object.entries(store.groups ?? {});
    if (groups.length) {
      const g = mk('Groups', 0);
      g.virtualKids = groups.sort(([a], [b]) => a.localeCompare(b)).map(([name, ids]) => {
        const gn = mk(name, 1, { parent: g, group: name, id: `@${name}`, badge: `${ids.length}` });
        gn.virtualKids = ids.filter((id) => reg.has(id)).map((id) => ({ ...this.objNode(reg.get(id)!, 2, gn), label: this.hooks.labelOf?.(id) ?? id, memberOf: name }));
        return gn;
      });
      this.roots.unshift(g);
      this.open.add(g);
    }
    if (cadRoots.length) {
      const cad = mk('CAD', 0);
      cad.virtualKids = cadRoots.map((o) => this.objNode(o, 1, cad));
      this.roots.push(cad);
      this.open.add(cad);
    }
    // parts removed from this animation's assembly: listed here, with Restore
    const removed = (this.hooks.removedIds?.() ?? []).filter((id) => reg.has(id));
    if (removed.length) {
      const rn = mk('Removed', 0, { badge: String(removed.length) });
      rn.virtualKids = removed.map((id) => ({ ...this.objNode(reg.get(id)!, 1, rn), removedRow: true, label: this.hooks.labelOf?.(id) ?? id }));
      this.roots.push(rn);
    }
    this.refresh();
  }

  /** Node for a CAD object. Chains of single-child levels are compacted into one row
   *  ("a › b › c"); the row stands for the deepest object (ids are unchanged). */
  private objNode(o: THREE.Object3D, depth: number, parent?: Node): Node {
    const names: string[] = [];
    const nameOf = (x: THREE.Object3D) => x.name || (x.userData.id as string).split('/').pop()!;
    if (isCad(o)) {
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
      n.kids = isCad(n.obj) ? n.obj.children.filter((c) => c.userData.id && !c.userData.removed).map((c) => this.objNode(c, n.depth + 1, n)) : [];
    }
    return n.kids;
  }

  private objsOf(n: Node): THREE.Object3D[] {
    if (n.obj) return [n.obj];
    return (n.virtualKids ?? []).flatMap((k) => this.objsOf(k));
  }

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
      <span class="lbl" title="${esc(n.id ?? n.label)}">${esc(n.label)}</span>${(() => { const c = this.hooks.colorOf?.(n.group ? `@${n.group}` : n.id ?? ''); return c ? `<span style="width:9px;height:9px;border-radius:2px;margin-left:6px;flex:none;background:${c}"></span>` : ''; })()}${n.badge ? `<span class="badge">${n.badge}</span>` : ''}`;
    const [caret, eye, lock] = r.children as unknown as HTMLElement[];
    caret.onclick = (e) => { e.stopPropagation(); this.toggleOpen(n); };
    eye.onclick = (e) => { e.stopPropagation(); this.setFlag(n, 'hidden', !hidden); };
    lock.onclick = (e) => { e.stopPropagation(); this.setFlag(n, 'locked', !locked); };
    r.onclick = (e) => this.select(n, false, e.metaKey || e.ctrlKey || e.shiftKey);
    r.oncontextmenu = (e) => {
      e.preventDefault();
      if (!this.sel.includes(n)) this.select(n, false);
      this.menu(e.clientX, e.clientY);
    };
    r.ondblclick = () => this.toggleOpen(n);
    return r;
  }

  private toggleOpen(n: Node) { this.open.has(n) ? this.open.delete(n) : this.open.add(n); this.refresh(); }

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
    if (additive && n) {
      const i = this.sel.findIndex((x) => x === n || (n.id && x.id === n.id));
      if (i >= 0) this.sel.splice(i, 1); else this.sel.push(n);
    } else this.sel = n ? [n] : [];
    this.highlight();
    const one = this.sel.length === 1 ? this.sel[0] : undefined;
    const clicked = n && (n.group ? `@${n.group}` : n.id);
    this.hooks.onSelect?.(one?.obj, one ? (one.group ? `@${one.group}` : one.id) : undefined, this.sel.flatMap((x) => this.objsOf(x)),
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

  /** Currently selected real object (single object nodes only). */
  get selectedObject(): THREE.Object3D | undefined { return this.sel.length === 1 ? this.selected?.obj : undefined; }
  /** Redraw rows + info (after external state changes). */
  redraw() { this.refresh(); this.updateInfo(); }

  /** Select by registry id (e.g. from ?select=). */
  selectId(id: string) { const o = this.scene.registry.get(id); if (o) this.pick(o); }

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
        h = new THREE.MeshToonMaterial({ color: TreePanel.HILITE, side: THREE.DoubleSide,
          clippingPlanes: orig.clippingPlanes ?? undefined, clipIntersection: orig.clipIntersection });
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
    const box = new THREE.Box3();
    this.objsOf(n).forEach((o) => box.expandByObject(o));
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const objs = this.objsOf(n);
    const locked = objs.every(isLocked);
    this.info.innerHTML = `<div>${esc(n.label)}${n.badge ? ` <span class="badge">${n.badge}</span>` : ''} · ${locked ? '🔒 locked' : '🔓 movable'}</div>
      ${n.id ? `<code>${esc(n.id)}</code><button data-a="copy">Copy id</button>` : '<div><i>group (not scriptable by id)</i></div>'}
      ${box.isEmpty() ? '' : `<div style="margin-top:4px">size ${fmt(size)} m · centre ${fmt(c)}</div>`}
      <div style="margin-top:4px">${n.group ? `<button data-a="ungroup">Delete group</button> <button data-a="rename">Rename</button>`
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
  private selSpecs(): string[] {
    return [...new Set(this.sel.flatMap((n) => (n.group ? [`@${n.group}`] : n.id ? [n.id] : this.objsOf(n).map((o) => (o.userData.id ?? o.name) as string))))];
  }
  private colorRow() {
    if (!this.hooks.onColor) return '';
    const specs = this.selSpecs();
    const cur = specs.map((sp) => this.hooks.colorOf?.(sp)).find(Boolean);
    return `<div style="margin-top:6px;display:flex;align-items:center;gap:6px">Colour
      <input type="color" data-a="color" value="${cur ?? '#cccccc'}" style="width:34px;height:20px;padding:0;border:1px solid #2b3540;background:none">
      ${cur ? `<span style="font:11px ui-monospace,monospace">${cur}</span><button data-a="uncolor" title="Back to the CAD / default colour">Reset</button>` : '<span style="color:#7b8794">default</span>'}</div>`;
  }
  private wireColor() {
    const specs = this.selSpecs();
    const inp = this.info.querySelector<HTMLInputElement>('[data-a=color]');
    if (inp) inp.onchange = () => this.hooks.onColor?.(specs, inp.value);
    this.info.querySelector<HTMLElement>('[data-a=uncolor]')?.addEventListener('click', () => this.hooks.onColor?.(specs, null));
  }

  // ---------- user groups ----------
  private wireGroupButtons() {
    const on = (a: string, f: () => void) => this.info.querySelector<HTMLElement>(`[data-a=${a}]`)?.addEventListener('click', f);
    on('group', () => {
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
    });
    on('ungroup', () => this.removeSelected());
    on('rename', () => this.renameSelected());
    on('partrename', () => this.renameSelected());
    on('partremove', () => this.removeSelected());
    on('restore', () => this.restoreSelected());
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
    return [...new Set(nodes.filter((n) => !n.group && !n.removedRow).flatMap((n) => (n.id && n.obj ? [n.id] : this.objsOf(n).map((o) => (o.userData.id ?? o.name) as string))))];
  }

  renameSelected() {
    const n = this.selected;
    if (!n || this.sel.length !== 1) return;
    if (n.group) {
      const to = prompt('Rename group (script lines using it are updated)', n.group)?.trim().replace(/\s+/g, '-');
      if (!to || to === n.group) return;
      if (!/^[\w.-]+$/.test(to)) return alert('Group names use letters, digits, - _ and .');
      if (store.groups[to]) return alert(`A group @${to} already exists.`);
      this.hooks.onGroupRename?.(n.group, to);
      store.groups[to] = store.groups[n.group]; delete store.groups[n.group];
      this.sel = []; this.groupsChanged();
      return;
    }
    if (!n.id || !n.obj) return;
    const name = prompt('Display name (empty: the CAD name). Scripts keep using the id.', this.hooks.labelOf?.(n.id) ?? n.label);
    if (name === null) return;
    this.hooks.onLabel?.(n.id, name.trim() || null);
  }

  removeSelected() {
    const groups = this.sel.filter((n) => n.group).map((n) => n.group!);
    if (groups.length === 1 && this.sel.length === 1) {
      const g = groups[0];
      if (!confirm(`Delete group "@${g}"? Its parts are not affected.`)) return;
      this.lastDeletedGroup = { name: g, ids: store.groups[g] };
      delete store.groups[g]; this.sel = []; this.groupsChanged();
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
    else if (n.group && !many) items.push(['Rename group…  F2', () => this.renameSelected()], ['Delete group  ⌫', () => this.removeSelected()]);
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

const fmt = (v: THREE.Vector3) => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
