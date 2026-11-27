// A drawing's SVG as a vector PDF page of the same size (jsPDF + svg2pdf.js, loaded on first use).

/** The sheet size in mm from the SVG's width/height ("420mm"). */
export function svgSizeMm(svg: string): [number, number] {
  const w = svg.match(/<svg[^>]*\swidth="([\d.]+)mm"/), h = svg.match(/<svg[^>]*\sheight="([\d.]+)mm"/);
  if (!w || !h) throw new Error('not a drawing SVG (no width/height in mm)');
  return [Number(w[1]), Number(h[1])];
}

export async function svgToPdf(svg: string, title = 'Drawing'): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const [W, H] = svgSizeMm(svg);
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: W > H ? 'landscape' : 'portrait', compress: true });
  doc.setProperties({ title, creator: 'Refuel Animation' });
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
  // svg2pdf measures text, so the element must be in the document while it converts
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
  holder.appendChild(el);
  document.body.appendChild(holder);
  try { await svg2pdf(el, doc, { x: 0, y: 0, width: W, height: H }); } finally { holder.remove(); }
  return doc.output('blob');
}
