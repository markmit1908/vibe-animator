// A progress card at the bottom left of the viewport for long jobs (drawings, PDF export): title, current step, a progress bar.
// The drawing passes are synchronous and block the main thread, so the bar's moving stripe is a CSS transform
// animation (runs on the compositor and keeps moving while JS is busy); `step()` waits for a paint before returning.

const CSS = `
#progress-splash { position: absolute; left: 16px; bottom: 40px; z-index: 50; pointer-events: none; font: 13px system-ui; color: #d7dde4;
  animation: progress-in .15s ease-out; }
#progress-splash .box { width: min(340px, calc(100vw - 32px)); padding: 12px 14px; background: #14191f; border: 1px solid #2b3540;
  border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
#progress-splash .title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
#progress-splash .msg { color: #9aa5b1; min-height: 1.3em; margin-bottom: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#progress-splash .track { position: relative; height: 6px; border-radius: 3px; background: #222a33; overflow: hidden; }
#progress-splash .bar { position: absolute; inset: 0 auto 0 0; width: 0; background: #f2b705; border-radius: 3px; transition: width .2s ease-out; }
#progress-splash .stripe { position: absolute; top: 0; bottom: 0; left: 0; width: 30%; will-change: transform;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.45), transparent); animation: progress-stripe 1.1s linear infinite; }
#progress-splash .foot { display: flex; justify-content: space-between; margin-top: 8px; color: #5b6670; font-size: 11.5px; }
@keyframes progress-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes progress-stripe { from { transform: translateX(-100%); } to { transform: translateX(400%); } }`;

const paint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export class ProgressSplash {
  private el?: HTMLElement;
  private t0 = 0;
  private timer = 0;
  constructor(private parent: () => HTMLElement) {}

  get active() { return !!this.el; }

  /** Show the splash (or retitle it if already shown). */
  async start(title: string, msg = '') {
    if (!document.getElementById('progress-splash-css')) {
      const s = document.createElement('style'); s.id = 'progress-splash-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    if (!this.el) {
      this.el = document.createElement('div'); this.el.id = 'progress-splash';
      this.el.innerHTML = `<div class="box" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="title"></div><div class="msg"></div>
        <div class="track"><div class="bar"></div><div class="stripe"></div></div><div class="foot"><span class="pct"></span><span class="time"></span></div></div>`;
      this.parent().appendChild(this.el);
      this.t0 = performance.now();
      this.timer = window.setInterval(() => this.tick(), 250);
    }
    this.el.querySelector('.title')!.textContent = title;
    await this.step(msg, 0);
  }

  /** Update the message and the fraction done (0–1), then wait until it has painted. */
  async step(msg: string, frac?: number) {
    if (!this.el) return;
    this.el.querySelector('.msg')!.textContent = msg;
    if (frac !== undefined) {
      const p = Math.round(Math.max(0, Math.min(1, frac)) * 100);
      this.el.querySelector<HTMLElement>('.bar')!.style.width = `${p}%`;
      this.el.querySelector('.pct')!.textContent = `${p}%`;
      this.el.querySelector('.box')!.setAttribute('aria-valuenow', String(p));
    }
    this.tick();
    await paint();
  }

  done() {
    clearInterval(this.timer);
    this.el?.remove(); this.el = undefined;
  }

  private tick() {
    if (this.el) this.el.querySelector('.time')!.textContent = `${((performance.now() - this.t0) / 1000).toFixed(1)} s`;
  }
}
