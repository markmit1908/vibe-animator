#!/usr/bin/env node
// Batch drawings: open an animation headless in the running app and save its drawing sheets (SVG + PDF) into the
// vault's Drawings/<animation>/ – the same code as the Illustration tab's "Save all".
//
//   npm run drawings -- "<animation name or id>" [sheet …] [--url http://127.0.0.1:5174] [--all]
//
// --all runs every animation that has drawing sheets. The app must be running (npm run dev).
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
let url = "http://127.0.0.1:5174", all = false;
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") url = args[++i].replace(/\/$/, "");
  else if (args[i] === "--all") all = true;
  else if (args[i] === "-h" || args[i] === "--help") { console.log('usage: npm run drawings -- "<animation>" [sheet …] [--url URL] | --all'); process.exit(0); }
  else pos.push(args[i]);
}
if (!all && !pos.length) { console.error('usage: npm run drawings -- "<animation>" [sheet …] [--url URL] | --all'); process.exit(2); }

const home = await fetch(`${url}/api/home`).then((r) => r.json()).catch(() => null);
if (!home) { console.error(`No app at ${url} – start it with npm run dev (or pass --url).`); process.exit(2); }
let targets;
if (all) {
  targets = [];
  for (const p of home.projects) {
    const m = await fetch(`${url}/api/projects/${p.id}`).then((r) => r.json());
    const t = m.problem?.drawings?.text;
    if (t && /^\s*sheet\s/m.test(Array.isArray(t) ? t.join("\n") : t)) targets.push(p);
  }
} else {
  const p = home.projects.find((x) => x.id === pos[0]) ?? home.projects.filter((x) => x.name === pos[0]);
  const list = Array.isArray(p) ? p : [p];
  if (list.length !== 1) { console.error(list.length ? `"${pos[0]}" matches ${list.length} animations – use the id` : `No animation "${pos[0]}"`); process.exit(2); }
  targets = list;
}
const sheets = all ? [] : pos.slice(1);

const browser = await chromium.launch();
let failed = 0;
try {
  for (const p of targets) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => console.error(`  page error: ${e.message}`));
    await page.goto(`${url}/#/p/${p.id}/`);
    await page.waitForFunction(() => (window).__studio?.drawPanel, null, { timeout: 120_000 });
    await page.waitForSelector("#script .status", { timeout: 120_000 });
    await page.waitForFunction(() => /✓|error/i.test(document.querySelector("#script .status")?.textContent ?? ""), null, { timeout: 600_000 });
    const t0 = Date.now();
    console.log(`${p.name}:`);
    const r = await page.evaluate((s) => (window).__studio.saveAllSheets(s), sheets);
    for (const f of r.saved) console.log(`  ${f}`);
    for (const e of r.errors) console.error(`  error${e.line ? ` (line ${e.line})` : ""}: ${e.message}`);
    console.log(`  ${r.saved.length / 2} sheet(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (r.errors.length) failed++;
    await page.close();
  }
} finally { await browser.close(); }
process.exit(failed ? 1 : 0);
