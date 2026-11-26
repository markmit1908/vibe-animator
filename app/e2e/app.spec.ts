// Refuel Animation end to end, on a fresh vault (playwright.config.ts): Home, the Studio, autosave, duplicate/rename,
// importing an old project zip (with its 3D model into CAD/), and the generated reactor animation playing.
import { expect, test, type Page } from "@playwright/test";
import { deflateRawSync, crc32 } from "node:zlib";

const api = (page: Page) => page.request;
const projects = async (page: Page) => (await (await api(page).get("/api/home")).json()).projects as { id: string; name: string }[];
const model = async (page: Page, id: string) => (await (await api(page).get(`/api/projects/${id}`)).json()).problem;
/** Open an animation from Home by its card. */
async function open(page: Page, name: string) {
  await page.goto("/");
  await page.getByText(name, { exact: true }).first().click();
  await expect(page).toHaveURL(/#\/p\/[0-9a-f-]{36}\//);
}
const newAnimation = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New model", exact: true }).click();
  await expect(page).toHaveURL(/#\/p\/[0-9a-f-]{36}\//);
};
const scriptOf = (m: any) => (Array.isArray(m.script.text) ? m.script.text.join("\n") : m.script.text) as string;

/** A zip like the old app's "Export project + 3D model". */
function oldProjectZip(project: object, glbName: string): Buffer {
  const files = [{ name: "project.json", data: Buffer.from(JSON.stringify(project)) },
                 { name: `cad/${glbName}`, data: Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]) }];
  const parts: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), comp = deflateRawSync(f.data), crc = crc32(f.data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

test("Home → New opens the Studio with the 3D view and the script", async ({ page }) => {
  await newAnimation(page);
  await expect(page.locator("#app canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#script .cm-content")).toContainText('label "Untitled"');
  await expect(page.locator("#tree")).toBeVisible();
});

test("a script edit autosaves into the animation file", async ({ page }) => {
  await newAnimation(page);
  await expect(page.locator("#script .cm-content")).toBeVisible({ timeout: 15_000 });
  const id = page.url().match(/#\/p\/([0-9a-f-]{36})/)![1];
  await page.locator("#script .cm-content").click();
  await page.keyboard.press("Meta+End"); await page.keyboard.press("Control+End");
  await page.keyboard.type("\nwait 3s");
  await expect.poll(async () => scriptOf(await model(page, id)), { timeout: 10_000 }).toContain("wait 3s");
});

test("duplicate and rename keep the script, snapshots and groups", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Lid lift", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "Lift"\nmove head by [0,3,0] 2s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: { bolts: true } } } }, groups: { lid: ["head", "bolts"] } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  const b = await (await api(page).post("/api/projects", { data: { name: "Lid lift copy", duplicate_of: a.id } })).json();
  expect((await api(page).patch(`/api/projects/${b.id}`, { data: { name: "Lid lift (fast)" } })).ok()).toBe(true);
  const copy = await model(page, b.id);
  expect(scriptOf(copy)).toContain("move head by [0,3,0] 2s");
  expect(copy.groups).toEqual({ lid: ["head", "bolts"] });
  expect(copy.snapshots.items.default.hidden).toEqual({ bolts: true });
  expect(copy.uuid).not.toBe(a.uuid);
  await page.reload();
  await expect(page.getByText("Lid lift (fast)")).toBeVisible();
});

test("an old project zip imports, with its 3D model into CAD/", async ({ page }) => {
  await page.goto("/");
  const project = {
    format: "refuel-project", version: 1, exportedAt: "2026-11-25T00:00:00Z",
    core: "generated: false\nscript: old.anim\ncad_models:\n  - {id: plant, file: cad/old-plant.glb, up: y}\n",
    script: { name: "old.anim", text: 'label "Old project"\nwait 1s\n' },
    snapshots: { active: "default", snapshots: { default: { locked: {}, hidden: {} } }, groups: { g: ["plant"] } },
    chat: [], view: { time: 0, mode: "shaded" }, cad: [{ id: "plant", file: "cad/old-plant.glb" }],
  };
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import old project (.zip)…", exact: true }).click();
  await (await chooser).setFiles({ name: "old-project.zip", mimeType: "application/zip", buffer: oldProjectZip(project, "old-plant.glb") });
  await expect(page).toHaveURL(/#\/p\/[0-9a-f-]{36}\//, { timeout: 15_000 });
  const id = page.url().match(/#\/p\/([0-9a-f-]{36})/)![1];
  const m = await model(page, id);
  expect(scriptOf(m)).toContain('label "Old project"');
  expect(m.scene.cad_models[0].file).toBe("CAD/old-plant.glb");
  expect(m.groups).toEqual({ g: ["plant"] });
  const glb = await api(page).get("/api/files/CAD/old-plant.glb");
  expect(glb.ok()).toBe(true);
  expect((await glb.body()).subarray(0, 4).toString()).toBe("glTF");
});

test("the generated reactor animation compiles and plays", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Reactor", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "Remove head"\ncutaway quarter\nmove head by [0,3,0] 2s\nrotate head by [0,45,0] 1s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  void a;
  await open(page, "Reactor");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await expect(page.locator("#chapter")).toHaveText("Remove head");
  await page.keyboard.press("Space");
  await expect(page.locator("#clock")).toContainText("/ 3.0 s");
  await expect.poll(async () => page.locator("#clock").textContent(), { timeout: 8_000 }).toMatch(/^3\.0 \/ 3\.0 s/);
});

test("unlocking a locked group clears the script error and is saved", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Locked lid", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "Lift"\nmove @lid by [0,3,0] 2s' },
    snapshots: { active: "default", items: { default: { locked: { head: true }, hidden: {} } } }, groups: { lid: ["head"] } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Locked lid");
  await expect(page.locator("#script .status")).toHaveText("1 error", { timeout: 15_000 });
  // the group's row in the assembly tree: its lock toggle (second toggle in the row)
  const row = page.locator("#tree .row", { hasText: "lid" }).first();
  await row.locator(".tg").nth(1).click();
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.locked.head, { timeout: 10_000 }).toBe(false);
  // and it stays fixed after reopening
  await open(page, "Locked lid");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
});

test("the studio fills the editor area: nothing under the header or status bar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await newAnimation(page);
  await expect(page.locator("#app canvas")).toBeVisible({ timeout: 15_000 });
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const main = await box("main"), host = await box("main > div");
  expect(host).toEqual(main);
  await page.getByRole("button", { name: "Assist", exact: true }).click();
  const input = await box("#assist form"), footer = await box("footer");
  expect(input.y + input.height).toBeLessThanOrEqual(footer.y + 0.5);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
});

test("typing across autosaves and an outside change never garbles the script", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Typing", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "Plant overview"\nwait 2s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: { head: ["head"] } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Typing");
  const editor = page.locator("#script .cm-content");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const typeLines = async (lines: string[]) => {
    await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
    for (const l of lines) { await page.keyboard.type("\n" + l, { delay: 30 }); await page.waitForTimeout(400); }
  };
  await typeLines(["move @head by [0,3,0] 5s", "fade @head to 0 2s"]);
  await expect.poll(async () => scriptOf(await model(page, a.id)), { timeout: 10_000 }).toContain("fade @head to 0 2s");
  // an outside change through the editor (Replace from file; a version restore works the same way): the studio remounts
  const cur = await model(page, a.id);
  const replaced = { ...cur, groups: { head: ["head"], lid: ["head", "bolts"] } };
  await page.locator('input[aria-label="Replace from a model file"]').setInputFiles({ name: "Typing.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(replaced)) });
  await expect(page.locator("#tree .row", { hasText: "lid" }).first()).toBeVisible({ timeout: 10_000 });
  await typeLines(["label \"Remove lid\"", "wait 2s"]);
  await page.waitForTimeout(2500);
  const shown = (await editor.innerText()).replace(/\n+$/, "");
  const saved = await model(page, a.id);
  expect(scriptOf(saved).replace(/\n+$/, "")).toBe(shown);
  expect(shown).toContain('fade @head to 0 2s\nlabel "Remove lid"\nwait 2s');
  expect(shown).not.toMatch(/\ds\w/);           // no "5sfade"-style joins
  expect(saved.groups.lid).toEqual(["head", "bolts"]);
});

test("base colours from the tree are saved, and the script can change and reset them", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Colours", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "Colours"\ncolor head #2e86de 1s\nwait 1s\ncolor head reset 1s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Colours");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const colourOf = (id: string) => page.evaluate((id) => {
    const o = (window as any).__studio.built.registry.get(id); let c = "";
    o.traverse((x: any) => { if (!c && x.isMesh && x.material?.side !== 1) c = (x.userData.origMat ?? x.material).color.getHexString(); });
    return c;
  }, id);
  const vesselBefore = await colourOf("vessel");
  // base colour from the tree's info box
  await page.locator("#tree .row", { hasText: "head" }).first().click();
  await page.locator('#tree .info input[data-a="color"]').evaluate((el: HTMLInputElement) => { el.value = "#c0392b"; el.dispatchEvent(new Event("change")); });
  await expect.poll(async () => (await model(page, a.id)).colors).toEqual({ head: "#c0392b" });
  expect(await colourOf("head")).toBe("c0392b");
  expect(await colourOf("vessel")).toBe(vesselBefore);            // other parts keep theirs
  // the script: blue at 2 s, back to the base (red) after the reset
  await page.locator("#script .cm-stepTime", { hasText: "0.0s" }).nth(1).click();   // run to the end of `color head #2e86de 1s`
  await expect.poll(() => colourOf("head")).toBe("2e86de");
  await page.locator("#script .cm-stepTime", { hasText: "2.0s" }).click();          // end of `color head reset 1s`
  await expect.poll(() => colourOf("head")).toBe("c0392b");
  // reload: the base colour is still there
  await open(page, "Colours");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  expect(await colourOf("head")).toBe("c0392b");
});

test("assembly: remove/restore parts, display names, group rename and delete", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Assembly", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "A"\nmove machine by [0,1,0] 1s\nmove @lid by [0,3,0] 2s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: { lid: ["head", "bolts"] } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Assembly");
  const status = page.locator("#script .status");
  await expect(status).toHaveText("✓", { timeout: 15_000 });
  const row = (text: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^${text}$`) }) }).first();
  const menu = async (r: ReturnType<typeof row>, item: RegExp) => { await r.click({ button: "right" }); await page.getByRole("menuitem", { name: item }).click(); };
  const machineVisible = () => page.evaluate(() => (window as any).__studio.built.registry.get("machine").visible);

  // remove from the assembly: gone from the tree and the view, listed under Removed, saved, and the script flags it
  await menu(row("machine"), /^Remove from assembly/);
  await expect(row("Removed")).toBeVisible();
  await expect.poll(async () => (await model(page, a.id)).removed).toEqual(["machine"]);
  expect(await machineVisible()).toBe(false);
  await expect(status).toHaveText("1 error");
  // restore from the Removed section
  await row("Removed").locator(".caret").click();
  await menu(page.locator("#tree .row.supp").first(), /^Restore/);
  await expect(status).toHaveText("✓");
  await expect.poll(async () => (await model(page, a.id)).removed ?? []).toEqual([]);
  expect(await machineVisible()).toBe(true);

  // display name: the tree shows it, the script keeps the id
  page.once("dialog", (d) => d.accept("Refuelling machine"));
  await menu(row("machine"), /^Rename/);
  await expect(row("Refuelling machine")).toBeVisible();
  await expect.poll(async () => (await model(page, a.id)).labels).toEqual({ machine: "Refuelling machine" });
  await expect(status).toHaveText("✓");

  // group rename rewrites the script
  page.once("dialog", (d) => d.accept("lid-set"));
  await menu(row("lid"), /^Rename group/);
  await expect.poll(async () => scriptOf(await model(page, a.id))).toContain("move @lid-set by [0,3,0] 2s");
  await expect(status).toHaveText("✓");

  // group delete: the script flags it, with an undo
  page.once("dialog", (d) => d.accept());
  await menu(row("lid-set"), /^Delete group/);
  await expect(status).toHaveText("1 error");
  await expect.poll(async () => (await model(page, a.id)).groups).toEqual({});
});

test("type a command, pick parts in the tree, and they go into the script", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Pick", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "Pick"' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Pick");
  const editor = page.locator("#script .cm-content");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nmove ");
  await expect(page.locator("#script .pick")).toContainText("Pick parts");
  const row = (t: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^${t}$`) }) }).first();
  await row("head").click();
  await row("bolts").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await expect(editor).toContainText("move head, bolts");
  await page.keyboard.type("by [0,1,0] 1s");
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect.poll(async () => scriptOf(await model(page, a.id))).toContain("move head, bolts by [0,1,0] 1s");
  // both parts move: at the end of the step each is 1 m higher
  const y = (id: string) => page.evaluate((id) => (window as any).__studio.built.registry.get(id).position.y, id);
  const [h0, b0] = [await y("head"), await y("bolts")];
  await page.locator("#script .cm-stepTime", { hasText: "0.0s" }).last().click();
  await expect.poll(async () => +((await y("head")) - h0).toFixed(3)).toBe(1);
  expect(+((await y("bolts")) - b0).toFixed(3)).toBe(1);
});

test("parts can be named by their short name, several in one step", async ({ page }) => {
  await page.goto("/");
  const { readFileSync } = await import("node:fs");
  await api(page).put("/api/files/CAD/small.glb?overwrite=true", { data: readFileSync(new URL("./fixtures/small.glb", import.meta.url)) });
  const m = { name: "Short names", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [{ id: "plant", file: "CAD/small.glb", clip: false }] },
    script: { language: "anim", text: 'label "S"\nmove Pin_1, Pin_2 by [0,.25,0] 1s' },
    snapshots: { active: "default", items: { default: { locked: { plant: false }, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Short names");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const y = (short: string) => page.evaluate((s) => { const r = (window as any).__studio.built.registry; for (const [id, o] of r) if (id.endsWith(`/${s}`)) { o.updateWorldMatrix(true, false); return o.matrixWorld.elements[13]; } return NaN; }, short);
  const [a0, b0] = [await y("Pin_1"), await y("Pin_2")];
  await page.locator("#script .cm-stepTime", { hasText: "0.0s" }).last().click();
  await expect.poll(async () => +((await y("Pin_1")) - a0).toFixed(3)).toBe(0.25);
  expect(+((await y("Pin_2")) - b0).toFixed(3)).toBe(0.25);
  // a name shared by many parts asks for the full id
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nmove L5 by [0,1,0] 1s");
  await expect(page.locator("#script .status")).toHaveText("1 error");
});

test("lists and staggered loops: lift 1 s, vanish 0.5 s, next item 0.2 s later", async ({ page }) => {
  await page.goto("/");
  const text = ['label "Layer"', "list @top = */L11", "each @top stagger 0.2s {", "  move $ by [0,1,0] 1s", "  fade $ to 0 0.5s", "}", "wait 1s"].join("\n");
  const m = { name: "Loop", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Loop");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const tl = () => page.evaluate(() => { const p = (window as any).__studio.player; return { duration: p.duration, lines: Object.fromEntries([...p.tl.lines].map(([l, x]: any) => [l, [+x.start.toFixed(3), +x.end.toFixed(3)]])) }; });
  const t = await tl();
  expect(t.lines[3]).toEqual([0, 13.5]);           // the loop: 61 blocks, (61-1) × 0.2 + 1.5
  expect(t.lines[4]).toEqual([0, 1]);              // the first item's lift
  expect(t.lines[5]).toEqual([1, 1.5]);            //   and vanish
  expect(t.duration).toBeCloseTo(14.5, 5);         // + wait 1s
  const at = (time: number, id: string) => page.evaluate(([time, id]) => {
    const s = (window as any).__studio; s.player.seek(time); const o = s.built.registry.get(id);
    return { y: +o.position.y.toFixed(3), visible: o.visible };
  }, [time, id] as const);
  const ids: string[] = await page.evaluate(() => [...(window as any).__studio.built.registry.keys()].filter((k: string) => k.endsWith("/L11")).sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })));
  const y0 = (await at(0, ids[5])).y;
  expect((await at(1.0, ids[5])).y).toBe(y0);                 // item 5 starts at 5 × 0.2 = 1.0 s
  expect((await at(2.0, ids[5])).y).toBe(+(y0 + 1).toFixed(3)); //   lifted by 2.0 s
  for (const id of [ids[0], ids[30], ids[60]]) expect((await at(13.5, id)).visible).toBe(false); // all vanished, staying hidden
  // order, $i expressions, and a list name clashing with a tree group
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\neach @top stagger 0 order -ring {\nmove $ by [0, 1 + $i*0.1, 0] 1s\n}");
  await expect(page.locator("#script .status")).toHaveText("✓");
});

test("the colour picker offers the colours already in the model", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Swatches", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "S"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {},
    colors: { bolts: "#2e86de" } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Swatches");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const vessel = await page.evaluate(() => { let c = ""; (window as any).__studio.built.registry.get("vessel").traverse((x: any) => { if (!c && x.isMesh && x.material.side !== 1) c = "#" + x.material.color.getHexString(); }); return c; });
  await page.locator("#tree .row", { has: page.locator(".lbl", { hasText: /^head$/ }) }).first().click();
  const swatches = await page.locator("#tree .info [data-swatch]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.swatch));
  expect(swatches[0]).toBe("#2e86de");            // a base colour set in this animation comes first
  expect(swatches).toContain(vessel);             // then the model's own colours
  await page.locator(`#tree .info [data-swatch="${vessel}"]`).click();
  await expect.poll(async () => (await model(page, a.id)).colors).toEqual({ bolts: "#2e86de", head: vessel });
  // the same colours in the script's color step: completion swatches, then a chip on the value
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\ncolor head ");
  const opts = page.locator(".cm-tooltip-autocomplete li");
  await expect(opts.first()).toContainText(vessel);          // most recent base colour first
  await expect(opts.first().locator(".cm-swatchOpt")).toBeVisible();
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("#cad1ee"); // the palette too
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("reset");
  await page.keyboard.type("#2e"); await page.keyboard.press("Enter"); await page.keyboard.type(" 1s");
  await expect(page.locator("#script .cm-content")).toContainText("color head #2e86de 1s");
  await expect(page.locator("#script .status")).toHaveText("✓");
  await page.locator("#script .cm-colorChip").first().dispatchEvent("mousedown");
  await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("#");
  // second row: a palette from the key colour #cad1ee (key, complementary, split ×2, triadic ×2, analogous ×2)
  await page.keyboard.press("Escape");
  await page.locator("#tree .row", { has: page.locator(".lbl", { hasText: /^head$/ }) }).first().click();
  const pal = await page.locator('#tree .info [data-row=palette] [data-swatch]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.swatch));
  expect(pal.length).toBe(8);
  expect(pal[0]).toBe("#cad1ee");
  expect(new Set(pal).size).toBe(8);
  await page.locator('#tree .info [data-a=palkey]').evaluate((e: HTMLInputElement) => { e.value = "#c0392b"; e.dispatchEvent(new Event("change")); });
  await expect.poll(async () => (await model(page, a.id)).view?.paletteKey).toBe("#c0392b");
  await expect(page.locator('#tree .info [data-row=palette] [data-swatch]').first()).toHaveAttribute("data-swatch", "#c0392b");
});

test("assist is SolverKit's panel: a proposal card previews, accepts into the script, and the chat clears", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Assist", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "A"\nwait 2s' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Assist");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#right [data-t=assist]").click();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();       // icon button, disabled while empty
  // a proposal made by the real tool, as the loop would deliver it
  await page.evaluate(async () => {
    const s = (window as any).__studio;
    const g = s.tools.find((t: any) => t.name === "propose_script_edit").run({ text: 'label "A"\nmove head by [0,3,0] 4s', summary: "Lift the head" });
    let p: any; for (let r = await g.next(); !r.done; r = await g.next()) if (r.value.type === "proposal") { const { type, ...x } = r.value; p = x; }
    s.assist.host.onChat([{ role: "user", content: "Lift the head" }, { role: "assistant", content: "Here you go.", proposal: p }]);
    s.assist.mount.refresh();
  });
  const card = page.getByTestId("proposal");
  await expect(card).toContainText("Lift the head");
  await expect(page.getByTestId("proposal-queue")).toContainText("1 change waiting");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("assistant").getByRole("button", { name: "End preview" })).toBeVisible();
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(page.locator("#script .cm-content")).toContainText("move head by [0,3,0] 4s");
  await expect.poll(async () => (await model(page, a.id)).chat?.[1]?.proposal?.state).toBe("accepted");
  await page.locator("#right [data-t=assist]").click();
  await page.getByRole("button", { name: "Clear conversation" }).click();
  await expect.poll(async () => (await model(page, a.id)).chat).toEqual([]);
});

test("PNG export has a transparent background (shaded and hidden line)", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Png", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "P"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Png");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const alphaAt = async () => {
    const dl = page.waitForEvent("download");
    await page.locator("#viewbar [data-a=png]").click();
    const f = await (await dl).path(); const b64 = (await import("node:fs")).readFileSync(f).toString("base64");
    return page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
      const px = (x: number, y: number) => g.getImageData(x, y, 1, 1).data[3];
      let opaque = 0; for (let x = 0; x < img.width; x += 7) opaque += px(x, img.height >> 1) > 0 ? 1 : 0;
      return { corner: px(2, 2), opaque };
    }, `data:image/png;base64,${b64}`);
  };
  const shaded = await alphaAt();
  expect(shaded.corner).toBe(0);           // empty space is transparent
  expect(shaded.opaque).toBeGreaterThan(0); // the model is drawn
  await page.locator("#viewbar button", { hasText: "Hidden line" }).click();
  const hidden = await alphaAt();
  expect(hidden.corner).toBe(0);
  expect(hidden.opaque).toBeGreaterThan(0);
  await page.locator("#viewbar button", { hasText: "Shaded + outline" }).click();   // the third view
  const outline = await alphaAt();
  expect(outline.corner).toBe(0);
  expect(outline.opaque).toBeGreaterThan(0);
});

test("locked parts: the error has an Unlock button for every locked part the script moves; AI Accept unlocks them too", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Locks", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "L"\nlist @two = head, bolts\neach @two stagger 0.5s {\n  move $ by [0,1,0] 1s\n}' },
    snapshots: { active: "default", items: { default: { locked: { head: true, bolts: true, vessel: true }, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Locks");
  await expect(page.locator("#script .status")).toHaveText("1 error", { timeout: 15_000 });
  const fix = page.locator("#script .bar button.fix");
  await expect(fix).toHaveText("🔓 Unlock 2 parts");             // both loop items, not just the first
  await fix.click();
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect(fix).toBeHidden();
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.locked).toEqual({ head: false, bolts: false, vessel: true });
  // AI proposal moving the locked vessel inside a parallel block, several targets per line
  await page.locator("#right [data-t=assist]").click();
  await page.evaluate(async () => {
    const s = (window as any).__studio;
    const text = 'label "L"\nparallel {\n  move vessel, head by [0,1,0] 1s\n  color bolts #ff0000 1s\n}';
    const g = s.tools.find((t: any) => t.name === "propose_script_edit").run({ text, summary: "Lift all" });
    let p: any; for (let r = await g.next(); !r.done; r = await g.next()) if (r.value.type === "proposal") { const { type, ...x } = r.value; p = x; }
    s.assist.host.onChat([{ role: "user", content: "Lift all" }, { role: "assistant", content: "", proposal: p }]);
    s.assist.mount.refresh();
  });
  await expect(page.getByTestId("assistant")).toContainText("Accept also unlocks vessel");
  await page.getByTestId("proposal").getByRole("button", { name: "Accept" }).click();
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.locked.vessel).toBe(false);
});

test("floating tools: blank / unblank the selection, and group it", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Tools", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "T"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Tools");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const blank = page.locator("#toolsbar [data-t=blank]"), group = page.locator("#toolsbar [data-t=group]");
  await expect(blank).toBeDisabled();
  const row = (t: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^${t}$`) }) }).first();
  await row("head").click(); await row("bolts").click({ modifiers: ["Meta"] });
  await blank.click();
  await expect(blank).toContainText("Unblank");
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.hidden).toEqual({ head: true, bolts: true });
  await page.keyboard.press("h");                                     // H toggles back
  await expect(blank).toContainText("Blank");
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.hidden).toEqual({ head: false, bolts: false });
  // reverse blank: everything not selected goes off, the selection stays on
  await page.locator("#toolsbar [data-t=others]").click();
  await expect.poll(async () => { const h = (await model(page, a.id)).snapshots.items.default.hidden; return [h.vessel, h['R1-1/L1'], h.machine, h.head, h.bolts]; })
    .toEqual([true, true, true, false, false]);
  await page.locator("#toolsbar [data-t=showall]").click();           // show all
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.hidden).toEqual({});
  page.once("dialog", (d) => d.accept("lid set"));
  await group.click();
  await expect.poll(async () => (await model(page, a.id)).groups).toEqual({ "lid-set": ["head", "bolts"] });
});

test("undo / redo (⌘Z / ⇧⌘Z): colour, blank and group changes; the script editor keeps its own undo", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Undo", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "U"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {},
    colors: { bolts: "#2e86de" } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Undo");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const row = (t: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^${t}$`) }) }).first();
  const saved = () => model(page, a.id);
  await row("head").click();
  await page.locator('#tree .info [data-swatch="#2e86de"]').first().click();       // an accidental colour
  await expect.poll(async () => (await saved()).colors).toEqual({ bolts: "#2e86de", head: "#2e86de" });
  await page.waitForTimeout(900);
  await page.locator("#toolsbar [data-t=blank]").click();                            // and a blank
  await expect.poll(async () => (await saved()).snapshots.items.default.hidden).toEqual({ head: true });
  await page.waitForTimeout(900);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("ControlOrMeta+z");                                      // undo the blank
  await expect.poll(async () => (await saved()).snapshots.items.default.hidden).toEqual({});
  await page.keyboard.press("ControlOrMeta+z");                                      // undo the colour
  await expect.poll(async () => (await saved()).colors).toEqual({ bolts: "#2e86de" });
  const headColour = () => page.evaluate(() => { let c = ""; (window as any).__studio.built.registry.get("head").traverse((x: any) => { const mt = x.userData.origMat ?? x.material; if (!c && x.isMesh && mt.side !== 1) c = "#" + mt.color.getHexString(); }); return c; }); // origMat: under the selection highlight
  expect(await headColour()).not.toBe("#2e86de");
  await page.keyboard.press("ControlOrMeta+Shift+z");                                // redo the colour
  await expect.poll(async () => (await saved()).colors).toEqual({ bolts: "#2e86de", head: "#2e86de" });
  expect(await headColour()).toBe("#2e86de");
  // typing in the script: ⌘Z there is the editor's undo, not the studio's
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nwait 1s");
  await expect.poll(async () => (await saved()).script.text).toContain("wait 1s");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#script .cm-content")).not.toContainText("wait 1s");
  expect((await saved()).colors).toEqual({ bolts: "#2e86de", head: "#2e86de" });     // the colour stays
});

test("camera views: save from the tools bar, use as `camera <name> 2s`; unknown names are errors", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Views", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "V"\nwait 1s' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Views");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#toolsbar [data-t=views]").click();
  const cam = () => page.evaluate(() => { const s = (window as any).__studio; return s.player.tl.camera.pos.toArray().map((x: number) => +x.toFixed(2)); });
  await page.evaluate(() => { const s = (window as any).__studio; s.ui.followCamera = false; s.camera.position.set(30, 5, 0); s.controls.target.set(0, 2, 0); s.controls.update(); });
  page.once("dialog", (d) => d.accept("side"));
  await page.locator("#toolsbar .vpop [data-v=save]").click();
  await expect.poll(async () => (await model(page, a.id)).views?.side?.pos.map((x: number) => +x.toFixed(1))).toEqual([30, 5, 0]);
  // insert into the script, then play it: the camera ends at the view
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.locator("#toolsbar .vpop [data-n=side] [data-v=ins]").click();
  await expect(page.locator("#script .cm-content")).toContainText("camera side 2s");
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect.poll(() => page.evaluate(() => (window as any).__studio.player.duration)).toBe(3);
  await page.evaluate(() => { const s = (window as any).__studio; s.player.playing = false; s.player.seek(3); });
  expect(await cam()).toEqual([30, 5, 0]);
  // an unknown view is an error
  await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\ncamera nowhere 1s");
  await expect(page.locator("#script .status")).toHaveText("1 error");
});

test("script blank / unblank / blank others work on locked parts", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Blanks", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "B"\nblank head 1s\nwait 1s\nunblank head\nblank others head, bolts 1s\nwait 1s\nunblank all' },
    snapshots: { active: "default", items: { default: { locked: { head: true, vessel: true }, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Blanks");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });   // locked parts: no error
  const vis = (t: number) => page.evaluate((t) => { const s = (window as any).__studio; s.player.playing = false; s.player.seek(t);
    const r = (id: string) => s.built.registry.get(id).visible; return [r("head"), r("bolts"), r("vessel"), r("machine")]; }, t);
  expect(await vis(1.5)).toEqual([false, true, true, true]);    // blank head
  expect(await vis(3.5)).toEqual([true, true, false, false]); // blank others: only head + bolts left
  expect(await vis(4.1)).toEqual([true, true, true, true]);   // unblank all
});

test("Tab accepts the highlighted completion in the script", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Tab", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "T"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Tab");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nunbl");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("unblank");
  await page.waitForTimeout(150);                 // CodeMirror ignores an accept in the first 75 ms of the list
  await page.keyboard.press("Tab");
  await expect(page.locator("#script .cm-content")).toContainText("unblank");
});

test("script completion is context sensitive", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const m = { name: "Ctx", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "C"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: { lid: ["head"] } };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Ctx");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const ed = page.locator("#script .cm-content");
  await ed.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  const tip = page.locator(".cm-tooltip-autocomplete");
  const at = async (text: string) => {
    await page.keyboard.press("Escape"); await page.keyboard.press("End"); await page.keyboard.press("Shift+Home");
    await page.keyboard.type(text); await page.waitForTimeout(500);
    return (await tip.count()) ? (await tip.locator("li").allTextContents()).join("|") : "";
  };
  await page.keyboard.press("Enter");
  expect(await at("mo")).toContain("move");                     // a verb at the start
  expect(await at("move @l")).toContain("@lid");                // a target
  expect(await at("move @lid ")).toMatch(/^by\|to$/);           // its keywords, not part ids
  expect(await at("move @lid by [0,")).toBe("");                // inside a vector: nothing
  expect(await at("move @lid by [0,1,0] 2")).toBe("");          // a number: nothing
  expect(await at("move @lid by [0,1,0] 2s ")).toContain("ease");
  expect(await at("move @lid by [0,1,0] 2s ")).not.toContain("@lid");
  expect(await at("rotate @lid by [0,90,0] ")).toContain("about");
  expect(await at("fade @lid ")).toBe("to");
  expect(await at("blank ")).toContain("others");
  expect(await at("unblank ")).toContain("all");
  expect(await at("each @lid ")).toBe("stagger|order");
  expect(await at("each @lid order ")).toContain("ring");
  expect(await at("cutaway ")).toBe("none|half|quarter");
  expect(await at('label "Lift @l')).toBe("");                   // in a string: nothing
  expect(await at("wait ")).toBe("");
});

test("select by name (tool) and ~name targets (script)", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Named", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "N"\nblank ~L1 1s' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Named");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  // script: ~L1 blanks every L1.. block (names containing "L1": L1, L10, L11 …)
  const hiddenL = await page.evaluate(() => { const s = (window as any).__studio; s.player.playing = false; s.player.seek(2);
    const r = s.built.registry; return [r.get("R1-1/L1").visible, r.get("R1-1/L10").visible, r.get("R1-1/L2").visible]; });
  expect(hiddenL).toEqual([false, false, true]);
  // tool: select every block whose name contains "l2", then blank them
  await page.locator("#toolsbar [data-t=find]").click();
  await page.locator("#toolsbar .fpop input").fill("l2");
  await expect(page.locator("#toolsbar .fpop .hint")).toContainText("match");
  await page.locator("#toolsbar .fpop input").press("Enter");
  await expect(page.locator("#tree .info")).toContainText("items selected");
  await page.locator("#toolsbar [data-t=blank]").click();
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.hidden["R1-1/L2"]).toBe(true);
});

test("cutaway sections: which side, and centred on a point or a target", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Cuts", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "C"\ncutaway half -x\nwait 1s\ncutaway quarter x -z at [0,0,0]\nwait 1s\ncutaway half y at head\nwait 1s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Cuts");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const planes = (t: number) => page.evaluate(async (t) => { const s = (window as any).__studio; s.player.playing = false; s.player.seek(t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return s.built.clipPlanes.map((p: any) => [...p.normal.toArray().map((v: number) => Math.round(v) + 0), Math.abs(p.constant) > 1e8 ? Math.sign(p.constant) * 1e9 : +p.constant.toFixed(2)]); }, t);
  expect(await planes(0.5)).toEqual([[1, 0, 0, 0], [1, 0, 0, -1e9]]);    // half -x: removes x < 0 (second plane unused)
  expect(await planes(1.5)).toEqual([[-1, 0, 0, 0], [0, 0, 1, 0]]);                                                        // quarter x -z
  const p3 = await planes(2.5);                                                                                            // half y at head: top removed above the head's centre
  expect(p3[0].slice(0, 3)).toEqual([0, -1, 0]);
  expect(p3[0][3]).toBeGreaterThan(1);
});

test("set origin moves the CAD and the saved cameras so the point is (0,0,0)", async ({ page }) => {
  await page.goto("/");
  const { readFileSync } = await import("node:fs");
  await api(page).put("/api/files/CAD/small.glb?overwrite=true", { data: readFileSync(new URL("./fixtures/small.glb", import.meta.url)) });
  const m = { name: "Origin", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [{ id: "plant", file: "CAD/small.glb", position: [1, 0, 0] }] },
    script: { language: "anim", text: 'label "O"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {}, camera: { pos: [5, 5, 5], look: [1, 2, 3] } } } }, groups: {},
    views: { side: { pos: [10, 2, 0], look: [1, 2, 3] } } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Origin");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await expect(page.locator("#toolsbar [data-t=origin]")).toBeVisible();
  await page.evaluate(() => { const s = (window as any).__studio; s.setOrigin(new s.camera.position.constructor(1, 2, 3)); });
  await expect.poll(async () => (await model(page, a.id)).scene.cad_models[0].position).toEqual([0, -2, -3]);
  const saved = await model(page, a.id);
  expect(saved.views.side).toEqual({ pos: [9, 0, -3], look: [0, 0, 0] });
  expect(saved.snapshots.items.default.camera).toEqual({ pos: [4, 3, 2], look: [0, 0, 0] });
});

test("the cutaway also cuts parts with a base colour or a script fade/colour (shaded view)", async ({ page }) => {
  await page.goto("/");
  const m = { name: "CutCol", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "C"\nfade head to 0.5 1s\ncolor barrel #ff0000\ncutaway half' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {}, colors: { vessel: "#2e86de" } };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "CutCol");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const live = await page.evaluate(() => {
    const s = (window as any).__studio; s.player.playing = false; s.player.seek(2);
    const out: Record<string, boolean> = {};
    for (const id of ["vessel", "head", "barrel"]) {
      let ok = true;
      s.built.registry.get(id).traverse((x: any) => { const mt = x.userData?.origMat ?? x.material;
        if (x.isMesh && mt.side !== 1 && mt.clippingPlanes?.length && mt.clippingPlanes !== s.built.clipPlanes) ok = false; });
      out[id] = ok;
    }
    return out;
  });
  expect(live).toEqual({ vessel: true, head: true, barrel: true });
});

test("section caps: a cut solid shows a darker cap face (off with nocap / the Caps switch)", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "CapBox", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [8,1,0.5] look [0,1,0]\nlabel "B"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "CapBox");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  // a closed solid box (2 m) at the origin, cut by "half" (x > 0 removed): looking from +x we see its cap
  const centre = async () => {
    await page.waitForTimeout(300);
    const shot = await page.locator("#app canvas").screenshot();
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
      const d = g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data; return d[0] + d[1] + d[2];
    }, shot.toString("base64"));
  };
  await page.evaluate(() => (window as any).__studio.addTestBox());
  const lit = await centre();
  await page.evaluate(() => { (window as any).__studio.capUniforms.capShade.value = 0.2; });
  const dark = await centre();
  expect(dark).toBeLessThan(lit - 60);                       // the cap is drawn, in the part colour × shade
  // a part that is fading (transparent) is still capped
  await page.evaluate(() => { const s = (window as any).__studio; s.built.root.children.at(-1).material.transparent = true; s.built.root.children.at(-1).material.opacity = 0.99; });
  const fading = await centre();
  expect(Math.abs(fading - dark)).toBeLessThan(25);
  await page.evaluate(() => { (window as any).__studio.ui.caps = false; });
  const noCap = await centre();
  expect(noCap).not.toBe(dark);                               // no cap: we see into the box (its far inside wall)
});

test("stencil section caps: touching parts get flat caps in their own colour (no streaks at the joints)", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "Stack", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [6,4,3] look [0,1.5,0]\nlabel "S"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Stack");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const samples = await page.evaluate(async () => {
    const s = (window as any).__studio; s.addTestStack();
    await new Promise((r) => setTimeout(r, 300));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    // points on the cut plane x = 0 inside each block (block i spans y i..i+1), incl. close to the joints
    const out: Record<number, number[][]> = { 0: [], 1: [], 2: [] };
    for (let i = 0; i < 3; i++) for (const y of [0.08, 0.5, 0.92]) for (const z of [-0.7, 0, 0.7]) {
      const v = new s.THREE.Vector3(0, i + y, z).project(s.camera);
      const px = Math.round((v.x + 1) / 2 * cv.width), py = Math.round((1 - v.y) / 2 * cv.height);
      out[i].push([...g.getImageData(px, py, 1, 1).data.slice(0, 3)]);
    }
    return out;
  });
  const expected = [[0x6f, 0xa8, 0x6f], [0x6f, 0x8f, 0xd0], [0xd0, 0x8f, 0x6f]];
  for (let i = 0; i < 3; i++) {
    // flat: every sample of a block's cap is the same colour, the block's colour × the cap shade (sRGB-ish: darker, same hue)
    const first = samples[i][0];
    for (const px of samples[i]) for (let k = 0; k < 3; k++) expect(Math.abs(px[k] - first[k])).toBeLessThan(6);
    const dominant = expected[i].indexOf(Math.max(...expected[i]));
    expect(first.indexOf(Math.max(...first))).toBe(dominant);
    expect(Math.max(...first)).toBeLessThan(Math.max(...expected[i]));
  }
});

test("assist: propose_script_patch proposes small edits as a full diff card; bad finds are errors", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Patch", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "P"\nwait 2s\nwait 1s' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Patch");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const r = await page.evaluate(async () => {
    const s = (window as any).__studio, t = s.tools.find((x: any) => x.name === "propose_script_patch");
    const run = async (input: any) => { const bad = t.validate(input); if (bad) return { bad };
      const g = t.run(input); let p: any, x = await g.next(); for (; !x.done; x = await g.next()) if (x.value.type === "proposal") p = x.value; return { p, result: x.value }; };
    const ok = await run({ summary: "Lift the head", edits: [{ find: "wait 2s", replace: "wait 2s\nmove head by [0,3,0] 4s" }] });
    const missing = await run({ summary: "x", edits: [{ find: "wait 9s", replace: "" }] });
    const twice = await run({ summary: "x", edits: [{ find: "wait", replace: "pause" }] });
    const empty = await run({ summary: "x", edits: [] });
    return { text: ok.p?.text, ok: ok.p?.check.ok, missing: missing.result?.is_error, twice: twice.result?.content, empty: empty.bad };
  });
  expect(r.text).toBe('label "P"\nwait 2s\nmove head by [0,3,0] 4s\nwait 1s\n');
  expect(r.ok).toBe(true);
  expect(r.missing).toBe(true);
  expect(r.twice).toContain("more than once");
  expect(r.empty).toContain("non-empty");
});

test("hidden line: a line where two parts touch flush (part ids), smooth lines, separate silhouette weight", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "Joints", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [8,1.5,0] look [0,1.5,0]\nlabel "J"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Joints");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#viewbar button", { hasText: "Hidden line" }).click();
  // looking straight at the stack's side (x = 1 face): the joints at y = 1 and y = 2 are flush – only the part ids differ
  const column = await page.evaluate(async () => {
    const s = (window as any).__studio; s.addTestStack();
    await new Promise((r) => setTimeout(r, 300));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    const at = (y: number) => { const v = new s.THREE.Vector3(1, y, 0.3).project(s.camera); return [Math.round((v.x + 1) / 2 * cv.width), Math.round((1 - v.y) / 2 * cv.height)]; };
    const lum = (p: number[]) => { const d = g.getImageData(p[0], p[1], 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
    return { joint1: lum(at(1)), joint2: lum(at(2)), mid: lum(at(0.5)), mid2: lum(at(1.5)) };
  });
  expect(column.joint1).toBeLessThan(140);     // a line at each joint
  expect(column.joint2).toBeLessThan(140);
  expect(column.mid).toBeGreaterThan(220);     // paper inside the faces
  expect(column.mid2).toBeGreaterThan(220);
});

test("section caps: overlapping solids (a dowel in a block without a hole) are capped, not holed", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "Dowel", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [6,1,0.01] look [0,0.6,0]\nlabel "D"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Dowel");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const px = await page.evaluate(async () => {
    const s = (window as any).__studio; s.addTestDowel();
    await new Promise((r) => setTimeout(r, 300));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    const at = (y: number, z: number) => { const v = new s.THREE.Vector3(0, y, z).project(s.camera); return [...g.getImageData(Math.round((v.x + 1) / 2 * cv.width), Math.round((1 - v.y) / 2 * cv.height), 1, 1).data.slice(0, 3)]; };
    return { overlap: at(0.5, 0), block: at(0.5, 0.7), dowelAbove: at(1.3, 0) };
  });
  // inside the overlap the cap is drawn (not a hole): the two parts' cap colours averaged, a flat patch
  const avg = px.block.map((v: number, k: number) => (v + px.dowelAbove[k]) / 2);
  expect(px.overlap.every((v: number, k: number) => Math.abs(v - avg[k]) < 20)).toBe(true);
});

test("section caps: a part buried behind the cut (dowel without a hole) doesn't show through the cap", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "Buried", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [6,1,0.01] look [0,0.6,0]\nlabel "B"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Buried");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const px = await page.evaluate(async () => {
    const s = (window as any).__studio; s.addTestDowel();
    // move the dowel wholly behind the cut plane (x < 0), still inside the block
    s.built.root.children.find((c: any) => c.userData.id === "test-dowel").position.set(-0.6, 0.5, 0);
    s.built.root.children.find((c: any) => c.userData.id === "test-dowel").scale.set(1, 0.5, 1);
    await new Promise((r) => setTimeout(r, 300));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    const at = (y: number, z: number) => { const v = new s.THREE.Vector3(0, y, z).project(s.camera); return [...g.getImageData(Math.round((v.x + 1) / 2 * cv.width), Math.round((1 - v.y) / 2 * cv.height), 1, 1).data.slice(0, 3)]; };
    return { infront: at(0.5, 0), beside: at(0.5, 0.7) };
  });
  // the cap in front of the buried dowel is the block's cap colour, same as beside it
  expect(px.infront.every((v: number, k: number) => Math.abs(v - px.beside[k]) < 8)).toBe(true);
});

test("section caps: no ghost lines in the cap from many parts buried behind the cut (hidden line)", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "Ghosts", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [7,1,0.01] look [0,1,0]\nlabel "G"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Ghosts");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#viewbar button", { hasText: "Hidden line" }).click();
  const dark = await page.evaluate(async () => {
    const s = (window as any).__studio; s.addTestBuried(60);
    await new Promise((r) => setTimeout(r, 300));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    // the cap's inner area: the cut face of the big block (x = 0, y 0.3..1.7, z −1.2..1.2)
    const P = (y: number, z: number) => { const v = new s.THREE.Vector3(0, y, z).project(s.camera); return [Math.round((v.x + 1) / 2 * cv.width), Math.round((1 - v.y) / 2 * cv.height)]; };
    const [x0, y0] = P(1.7, -1.2), [x1, y1] = P(0.3, 1.2);
    const d = g.getImageData(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200) n++;
    return n;
  });
  expect(dark).toBe(0);
});

test("thumbnail: the button saves a keyframe and sends the card; a script thumbnail step wins; the view is put back", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Thumb", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "T"\nwait 2s\ncutaway half\nwait 2s' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Thumb");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.evaluate(() => { const s = (window as any).__studio; s.player.playing = false; s.player.seek(3); s.ui.followCamera = false; s.camera.position.set(9, 6, 9); s.controls.target.set(0, 3, 0); s.controls.update(); });
  await page.locator("#viewbar button", { hasText: "Hidden line" }).click();
  await page.locator("#toolsbar [data-t=thumb]").click();
  await expect.poll(async () => (await model(page, a.id)).keyframe?.mode).toBe("hidden");
  const kf = (await model(page, a.id)).keyframe;
  expect(kf.t).toBeCloseTo(3, 1);
  expect(kf.camera.pos.map((v: number) => Math.round(v))).toEqual([9, 6, 9]);
  // the card on the store is the rendered frame
  await expect.poll(async () => (await (await api(page).get(`/api/projects/${a.id}/thumb`)).text()).includes("data:image/jpeg")).toBe(true);
  // the view on screen is unchanged
  const after = await page.evaluate(() => { const s = (window as any).__studio; return { t: s.player.time, pos: s.camera.position.toArray().map(Math.round) }; });
  expect(after).toEqual({ t: 3, pos: [9, 6, 9] });
  // a script thumbnail step takes priority
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nthumbnail outline");
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect.poll(() => page.evaluate(() => (window as any).__studio.thumbFrame())).toMatchObject({ from: "script", mode: "outline", t: 4 });
});
