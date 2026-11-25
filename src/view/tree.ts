import * as THREE from 'three';
import type { BuiltScene } from '../scene/build';

/**
 * Left-hand assembly tree: browse, show/hide, search and select scene objects.
 * Selection shows the object's script id (copyable) so it can be used in refuel.yaml.
 */

interface Node {
  label: string;
  id?: string;               // registry id (scriptable) if any
  objs: THREE.Object3D[];    // objects this node controls (virtual nodes control many)
  children: Node[];
  count?: string;            // badge, e.g. "×112"
  parent?: Node;
}

const CSS = `
#tree { position: fixed; top: 0; left: 0; bottom: 0; width: 320px; display: flex; flex-direction: column;
  background: rgba(14,17,21,.94); color: #d7dde4; font: 12px/1.35 system-ui, sans-serif; border-right: 1px solid #222a33; z-index: 5; }
#tree.collapsed { transform: translateX(-320px); }
#tree header { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid #222a33; }
#tree header b { flex: 1; font-size: 13px; }
#tree input[type=search] { margin: 8px; padding: 5px 8px; background: #0a0c0f; border: 1px solid #2b3540; color: inherit; border-radius: 4px; }
#tree .rows { flex: 1; overflow: auto; padding-bottom: 8px; }
#tree .row { display: flex; align-items: center; height: 22px; padding-right: 6px; white-space: nowrap; cursor: pointer; }
#tree .row:hover { background: #1b222a; }
#tree .row.sel { background: #3a2a14; }
#tree .caret { width: 16px; text-align: center; color: #7b8794; flex: none; }
#tree .eye { width: 18px; flex: none; text-align: center; color: #9aa6b2; }
#tree .eye.off { color: #444d57; }
#tree .lbl { overflow: hidden; text-overflow: ellipsis; flex: 1; }
#tree .row.hidden .lbl { color: #5b6670; }
#tree .badge { color: #7b8794; margin-left: 6px; }
#tree .info { border-top: 1px solid #222a33; padding: 8px; font-size: 11px; color: #9aa6b2; min-height: 64px; }
#tree .info code { display: block; color: #f2b705; word-break: break-all; margin: 3px 0; font: 11px ui-monospace, monospace; }
#tree button { background: #222a33; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
#tree-toggle { position: fixed; top: 8px; left: 328px; z-index: 6; }
body.tree-collapsed #tree-toggle { left: 8px; }
body:not(.tree-collapsed) #chapter, body:not(.tree-collapsed) #sub { left: 372px !important; }
body:not(.tree-collapsed) #clock { left: 344px !important; }
body.tree-collapsed #chapter, body.tree-collapsed #sub { left: 52px !important; }
`;

export class TreePanel {
  private el: HTMLElement;
  private rows: HTMLElement;
  private info: HTMLElement;
  private search: HTMLInputElement;
  private open = new Set<Node>();
  private roots: Node[] = [];
  private byObj = new Map<THREE.Object3D, Node>();
  private selected?: Node;
  private box = new THREE.Box3Helper(new THREE.Box3(), 0xf2b705);

  constructor(private scene: BuiltScene, private three: THREE.Scene, private onSelect?: (id?: string) => void) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    this.el = document.createElement('div'); this.el.id = 'tree';
    this.el.innerHTML = `<header><b>Assembly</b><button data-a="collapse">Collapse all</button></header>
      <input type="search" placeholder="Search parts…" /><div class="rows"></div><div class="info">Click a part in the tree or the 3D view.</div>`;
    document.body.appendChild(this.el);
    const toggle = document.createElement('button'); toggle.id = 'tree-toggle'; toggle.textContent = '☰';
    toggle.style.cssText = 'background:#222a33;color:#d7dde4;border:1px solid #2b3540;border-radius:4px;padding:3px 8px;cursor:pointer';
    toggle.onclick = () => { this.el.classList.toggle('collapsed'); document.body.classList.toggle('tree-collapsed'); };
    document.body.appendChild(toggle);
    this.rows = this.el.querySelector('.rows')!;
    this.info = this.el.querySelector('.info')!;
    this.search = this.el.querySelector('input')!;
    this.search.oninput = () => this.render();
    this.el.querySelector<HTMLElement>('[data-a=collapse]')!.onclick = () => { this.open.clear(); this.render(); };
    this.box.visible = false;
    three.add(this.box);
    this.rebuild();
  }

  /** Rebuild the model (call after CAD loads). */
  rebuild() {
    const reg = this.scene.registry;
    const node = (label: string, id: string | undefined, objs: THREE.Object3D[], children: Node[] = [], count?: string): Node => {
      const n: Node = { label, id, objs, children, count };
      children.forEach((c) => (c.parent = n));
      if (objs.length === 1) this.byObj.set(objs[0], n);
      return n;
    };
    this.byObj.clear();

    // generated core: group blocks by column (virtual nodes)
    const cols = new Map<string, Node[]>();
    const fresh: Node[] = [];
    for (const id of this.scene.blockIds) {
      const obj = reg.get(id)!;
      const [col, layer] = id.split('/');
      const leaf = node(layer, id, [obj]);
      if (col === 'fresh') fresh.push(node(id, id, [obj])); else (cols.get(col) ?? cols.set(col, []).get(col)!).push(leaf);
    }
    const colNodes = [...cols.entries()].map(([c, kids]) => node(c, undefined, kids.flatMap((k) => k.objs), kids));
    const generated = node('Generated model', undefined, [], [
      node('core', undefined, colNodes.flatMap((c) => c.objs), colNodes, `${colNodes.length} columns`),
      ...['vessel', 'head', 'bolts', 'barrel', 'machine'].filter((id) => reg.has(id)).map((id) => node(id, id, [reg.get(id)!])),
      node('fresh fuel', undefined, fresh.flatMap((f) => f.objs), fresh),
    ]);

    // CAD models: mirror the Object3D hierarchy
    const mirror = (o: THREE.Object3D): Node => {
      const kids = o.children.map(mirror);
      const inst = (o as THREE.InstancedMesh).isInstancedMesh ? `×${(o as THREE.InstancedMesh).count}` : undefined;
      const id = o.userData.id as string;
      return node(o.name || id.split('/').pop()!, id, [o], kids, inst ?? (kids.length ? `${kids.length}` : undefined));
    };
    const cad = this.scene.root.children.filter((o) => o.userData.cad).map(mirror);
    this.roots = [generated, ...(cad.length ? [node('CAD', undefined, [], cad)] : [])];
    this.open.add(generated);
    if (cad.length) this.open.add(this.roots[1]);
    this.render();
  }

  private isHidden(n: Node) { return n.objs.length > 0 && n.objs.every((o) => o.userData.userHidden); }

  private setHidden(n: Node, hidden: boolean) {
    for (const o of n.objs) { o.userData.userHidden = hidden; o.visible = !hidden && !o.userData.faded; }
    for (const c of n.children) this.setHidden(c, hidden);
  }

  private render() {
    const q = this.search.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let rendered = 0;
    const MAX = 3000;
    const row = (n: Node, depth: number, showPath = false) => {
      if (rendered++ > MAX) return;
      const r = document.createElement('div');
      r.className = 'row' + (n === this.selected ? ' sel' : '') + (this.isHidden(n) ? ' hidden' : '');
      r.style.paddingLeft = `${depth * 12}px`;
      const caret = n.children.length ? (this.open.has(n) ? '▾' : '▸') : '';
      const label = showPath && n.id ? n.id : n.label;
      r.innerHTML = `<span class="caret">${caret}</span><span class="eye ${this.isHidden(n) ? 'off' : ''}">●</span>
        <span class="lbl" title="${n.id ?? n.label}">${escape(label)}</span>${n.count ? `<span class="badge">${n.count}</span>` : ''}`;
      (r.children[0] as HTMLElement).onclick = (e) => { e.stopPropagation(); this.open.has(n) ? this.open.delete(n) : this.open.add(n); this.render(); };
      (r.children[1] as HTMLElement).onclick = (e) => { e.stopPropagation(); this.setHidden(n, !this.isHidden(n)); this.render(); };
      r.onclick = () => this.select(n, false);
      r.ondblclick = () => { this.open.has(n) ? this.open.delete(n) : this.open.add(n); this.render(); };
      frag.appendChild(r);
      if (!q && this.open.has(n)) n.children.forEach((c) => row(c, depth + 1));
    };
    if (q) {
      const walk = (n: Node) => { if (n.label.toLowerCase().includes(q) || n.id?.toLowerCase().includes(q)) row(n, 0, true); n.children.forEach(walk); };
      this.roots.forEach(walk);
    } else this.roots.forEach((n) => row(n, 0));
    if (rendered > MAX) { const m = document.createElement('div'); m.style.padding = '6px'; m.textContent = `… more (refine search)`; frag.appendChild(m); }
    this.rows.replaceChildren(frag);
    this.rows.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  /** Select a tree node (from the tree, or from a 3D pick). */
  select(n: Node | undefined, reveal: boolean) {
    this.selected = n;
    if (n && reveal) { this.search.value = ''; for (let p = n.parent; p; p = p.parent) this.open.add(p); }
    this.updateInfo();
    this.render();
    this.onSelect?.(n?.id);
  }

  /** Select by registry id (e.g. from ?select=). */
  selectId(id: string) {
    const obj = this.scene.registry.get(id);
    if (obj) this.pick(obj);
  }

  /** Select whatever registered object contains this 3D object. */
  pick(obj: THREE.Object3D | undefined) {
    let o = obj;
    while (o && !this.byObj.has(o)) o = o.parent ?? undefined;
    this.select(o ? this.byObj.get(o) : undefined, true);
  }

  private updateInfo() {
    const n = this.selected;
    if (!n) { this.info.textContent = 'Click a part in the tree or the 3D view.'; this.box.visible = false; return; }
    const box = new THREE.Box3();
    n.objs.forEach((o) => box.expandByObject(o));
    const size = box.getSize(new THREE.Vector3());
    this.box.box.copy(box); this.box.visible = !box.isEmpty();
    const c = box.getCenter(new THREE.Vector3());
    this.info.innerHTML = `<div>${escape(n.label)}${n.count ? ` <span class="badge">${n.count}</span>` : ''}</div>
      ${n.id ? `<code>${escape(n.id)}</code><button data-a="copy">Copy id</button>` : '<div><i>group (not scriptable by id)</i></div>'}
      <div style="margin-top:4px">size ${fmt(size)} m · centre ${fmt(c)}</div>`;
    this.info.querySelector<HTMLElement>('[data-a=copy]')?.addEventListener('click', () => navigator.clipboard?.writeText(n.id!));
  }

  /** Keep the selection box glued to animated objects. */
  update() {
    if (!this.selected || !this.box.visible) return;
    this.box.box.makeEmpty();
    this.selected.objs.forEach((o) => this.box.box.expandByObject(o));
  }
}

const fmt = (v: THREE.Vector3) => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
