// Annotations in the 3D view: a card (title; the note on hover / when selected) with a leader line to a point on
// the geometry. Cards are HTML over the canvas – a fixed size on screen – and the leaders an SVG overlay; both are
// re-projected every frame. The studio says where each annotation's anchor is and whether it can be seen.
import * as THREE from 'three';

export interface Annotation {
  id: string;
  title: string;
  note: string;
  /** what it's about: a part id, "@group" or "folder:Path/To/Folder" */
  target: string;
  /** the picked point, in that part's own frame (it follows the part); absent → the target's box centre */
  anchor?: { part: string; local: number[] };
  /** where the label sits from the anchor, world m */
  offset: number[];
  /** shown in the view (the layer toggle hides them all) */
  show: boolean;
}

export interface AnnotationHooks {
  /** the anchor's world point now, and whether it can be seen (not blanked, removed or cut away); null = nothing to point at */
  anchor(a: Annotation): { p: THREE.Vector3; visible: boolean } | null;
  /** the label was dragged: its new offset (world m) */
  moved(a: Annotation, offset: number[]): void;
  /** title / note edited */
  edited(a: Annotation, title: string, note: string): void;
  remove(a: Annotation): void;
  /** a card was clicked: select what it's about */
  picked(a: Annotation): void;
}

const CSS = `
#annotations { position: absolute; inset: 0; pointer-events: none; z-index: 3; overflow: hidden; }
#annotations svg { position: absolute; inset: 0; width: 100%; height: 100%; }
#annotations svg line { stroke: #f2b705; stroke-width: 1.25; }
#annotations svg circle { fill: #f2b705; }
#annotations .ann { position: absolute; pointer-events: auto; max-width: 240px; background: rgba(14,17,21,.92); color: #e8edf2;
  border: 1px solid #f2b705; border-radius: 5px; padding: 3px 8px; font: 12px system-ui; cursor: grab; user-select: none; white-space: nowrap; }
#annotations .ann.sel { box-shadow: 0 0 0 2px rgba(242,183,5,.45); }
#annotations .ann .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
#annotations .ann .n { display: none; white-space: pre-wrap; color: #b7c0c9; margin-top: 3px; font-size: 11.5px; }
#annotations .ann:hover .n, #annotations .ann.sel .n { display: block; }
#annotations .ann.dim { opacity: .35; }
#annotations .ann.edit { cursor: default; white-space: normal; width: 240px; }
#annotations .ann.edit input, #annotations .ann.edit textarea { width: 100%; box-sizing: border-box; background: #0a0c0f; color: inherit;
  border: 1px solid #2b3540; border-radius: 4px; padding: 3px 5px; font: 12px system-ui; margin: 2px 0; }
#annotations .ann.edit textarea { min-height: 54px; resize: vertical; }
#annotations .ann.edit .row { display: flex; gap: 4px; justify-content: flex-end; margin-top: 3px; }
#annotations .ann.edit button { background: #1b222a; color: #d7dde4; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 8px; cursor: pointer; font: 11.5px system-ui; }`;

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class AnnotationLayer {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private cards = new Map<string, HTMLElement>();
  private list: Annotation[] = [];
  /** the layer toggle */
  visible = true;
  selected?: string;
  editing?: string;
  private ac = new AbortController();
  private drag?: { a: Annotation; plane: THREE.Plane; grab: THREE.Vector3; start: THREE.Vector3 };

  constructor(parent: HTMLElement, private camera: () => THREE.Camera, private canvas: HTMLCanvasElement, private hooks: AnnotationHooks) {
    if (!document.getElementById('annotations-css')) { const s = document.createElement('style'); s.id = 'annotations-css'; s.textContent = CSS; document.head.appendChild(s); }
    this.el = document.createElement('div'); this.el.id = 'annotations';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.el.appendChild(this.svg);
    parent.appendChild(this.el);
    addEventListener('pointermove', (e) => this.dragMove(e), { signal: this.ac.signal });
    addEventListener('pointerup', () => this.dragEnd(), { signal: this.ac.signal });
  }

  /** The annotations to show (rebuilds the cards whose text changed). */
  set(list: Annotation[]) {
    this.list = list;
    for (const [id, c] of this.cards) if (!list.some((a) => a.id === id)) { c.remove(); this.cards.delete(id); }
    for (const a of list) {
      let c = this.cards.get(a.id);
      if (!c) { c = this.card(a); this.cards.set(a.id, c); this.el.appendChild(c); }
      if (this.editing !== a.id) this.fill(c, a);
    }
  }

  private fill(c: HTMLElement, a: Annotation) {
    const key = `${a.title}\u0001${a.note}`;
    if (c.dataset.key === key && !c.classList.contains('edit')) return;
    c.dataset.key = key;
    c.classList.remove('edit');
    c.innerHTML = `<div class="t">${esc(a.title || '(untitled)')}</div>${a.note ? `<div class="n">${esc(a.note)}</div>` : ''}`;
  }

  private card(a: Annotation): HTMLElement {
    const c = document.createElement('div');
    c.className = 'ann'; c.dataset.id = a.id; c.tabIndex = 0;
    c.addEventListener('pointerdown', (e) => {
      if (this.editing === a.id || e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const cur = this.list.find((x) => x.id === a.id); if (!cur) return;
      this.select(cur.id); this.hooks.picked(cur);
      const anc = this.hooks.anchor(cur); if (!anc) return;
      // drag in the plane through the label, facing the camera
      const cam = this.camera(), label = anc.p.clone().add(new THREE.Vector3(...cur.offset));
      const n = cam.getWorldDirection(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, label);
      const grab = this.onPlane(e, plane);
      if (grab) this.drag = { a: cur, plane, grab, start: new THREE.Vector3(...cur.offset) };
    });
    c.addEventListener('dblclick', (e) => { e.stopPropagation(); this.edit(a.id); });
    c.addEventListener('keydown', (e) => {
      if (this.editing === a.id) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); const cur = this.list.find((x) => x.id === a.id); if (cur) this.hooks.remove(cur); }
      if (e.key === 'Enter') { e.preventDefault(); this.edit(a.id); }
    });
    return c;
  }

  select(id?: string) {
    this.selected = id;
    for (const [k, c] of this.cards) c.classList.toggle('sel', k === id);
  }

  /** Open the editor on a card: title, note, Delete; Enter in the title / Done saves, Esc cancels. */
  edit(id: string) {
    const a = this.list.find((x) => x.id === id), c = this.cards.get(id);
    if (!a || !c) return;
    this.editing = id; this.select(id);
    c.classList.add('edit');
    c.innerHTML = `<input data-f="t" placeholder="Title" value="${esc(a.title)}"><textarea data-f="n" placeholder="Note">${esc(a.note)}</textarea>
      <div class="row"><button data-a="del" title="Delete this annotation">Delete</button><span style="flex:1"></span><button data-a="ok">Done</button></div>`;
    const t = c.querySelector<HTMLInputElement>('[data-f=t]')!, n = c.querySelector<HTMLTextAreaElement>('[data-f=n]')!;
    const done = (save: boolean) => {
      if (this.editing !== id) return;
      this.editing = undefined;
      c.dataset.key = '';
      if (save) this.hooks.edited(a, t.value.trim(), n.value.trim());
      this.fill(c, this.list.find((x) => x.id === id) ?? a);
    };
    c.querySelector<HTMLElement>('[data-a=ok]')!.onclick = () => done(true);
    c.querySelector<HTMLElement>('[data-a=del]')!.onclick = () => { this.editing = undefined; this.hooks.remove(a); };
    c.onkeydown = (e) => {
      e.stopPropagation();                                   // keep viewer shortcuts out of the fields
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); done(true); }
    };
    c.addEventListener('focusout', (e) => { if (!c.contains(e.relatedTarget as Node)) done(true); });
    t.focus(); t.select();
  }

  private onPlane(e: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera());
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  }
  private dragMove(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    const p = this.onPlane(e, d.plane); if (!p) return;
    const off = d.start.clone().add(p.sub(d.grab));
    d.a.offset = off.toArray().map((v) => +v.toFixed(4));
  }
  private dragEnd() {
    const d = this.drag; if (!d) return;
    this.drag = undefined;
    if (d.start.distanceTo(new THREE.Vector3(...d.a.offset)) > 1e-6) this.hooks.moved(d.a, d.a.offset);
  }

  /** Per frame: place the cards and leaders. */
  update() {
    const cam = this.camera(), r = this.canvas.getBoundingClientRect(), host = this.el.getBoundingClientRect();
    const W = r.width, H = r.height, ox = r.left - host.left, oy = r.top - host.top;
    const scr = (p: THREE.Vector3) => { const v = p.clone().project(cam); return { x: ox + (v.x + 1) / 2 * W, y: oy + (1 - v.y) / 2 * H, behind: v.z > 1 || v.z < -1 }; };
    let lines = '';
    for (const a of this.list) {
      const c = this.cards.get(a.id)!;
      const anc = this.visible && a.show ? this.hooks.anchor(a) : null;
      if (!anc || (!anc.visible && this.editing !== a.id && this.selected !== a.id)) { c.style.display = 'none'; continue; }
      const p = scr(anc.p), l = scr(anc.p.clone().add(new THREE.Vector3(...a.offset)));
      if (p.behind || l.behind) { c.style.display = 'none'; continue; }
      c.style.display = '';
      c.classList.toggle('dim', !anc.visible);
      const w = c.offsetWidth, h = c.offsetHeight;
      c.style.left = `${l.x - w / 2}px`; c.style.top = `${l.y - h / 2}px`;
      // the leader stops at the card's edge
      const dx = p.x - l.x, dy = p.y - l.y, k = Math.min(Math.abs(dx) > 1e-6 ? (w / 2) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? (h / 2) / Math.abs(dy) : Infinity, 1);
      const ex = l.x + dx * k, ey = l.y + dy * k;
      if (Math.hypot(p.x - ex, p.y - ey) > 2) lines += `<line x1="${ex.toFixed(1)}" y1="${ey.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"/>`;
      lines += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5"/>`;
    }
    this.svg.innerHTML = lines;
  }

  dispose() { this.ac.abort(); this.el.remove(); }
}
