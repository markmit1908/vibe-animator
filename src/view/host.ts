/** Where the studio's panels live: the page body (old app) or the SolverKit view's container. */
let el: HTMLElement | undefined;
export const host = (): HTMLElement => el ?? document.body;
export function setHost(h: HTMLElement) { el = h; h.classList.add('studio-root'); }
