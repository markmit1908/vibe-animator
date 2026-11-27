// Refuel Animation end to end, on a fresh vault (playwright.config.ts): Home, the Studio, autosave, duplicate/rename,
// importing an old project zip (with its 3D model into CAD/), and the generated reactor animation playing.
import { expect, test, type Page } from "@playwright/test";
import { deflateRawSync, crc32 } from "node:zlib";
import { readFileSync } from "node:fs";

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

test("a new animation loads CAD: upload a .glb from disk, add one from the vault, remove one", async ({ page }) => {
  await api(page).put("/api/files/CAD/vault-model.glb?overwrite=true", { data: readFileSync(new URL("./fixtures/small.glb", import.meta.url)) });
  await newAnimation(page);
  const id = page.url().match(/#\/p\/([0-9a-f-]{36})\//)![1];
  // the empty state offers the loader
  const start = page.getByRole("button", { name: /Load a CAD model/ });
  await expect(start).toBeVisible({ timeout: 15_000 });
  await start.click();
  const pop = page.locator("#toolsbar .cadpop");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("None yet.");
  await expect(pop.getByRole("button", { name: /vault-model\.glb/ })).toBeVisible();
  // upload from disk
  const chooser = page.waitForEvent("filechooser");
  await pop.getByRole("button", { name: /Upload a \.glb/ }).click();
  await (await chooser).setFiles({ name: "From Disk.glb", mimeType: "model/gltf-binary",
    buffer: readFileSync(new URL("./fixtures/small.glb", import.meta.url)) });
  await expect.poll(async () => (await model(page, id)).scene.cad_models, { timeout: 15_000 })
    .toEqual([{ id: "From-Disk", file: "CAD/From Disk.glb", up: "y", ground: true, position: [0, 0, 0] }]);
  await expect(page.locator("#tree")).toContainText("From-Disk", { timeout: 15_000 });
  expect((await api(page).get("/api/files/CAD/From%20Disk.glb")).ok()).toBe(true);
  // add from the vault: a second model keeps its coordinates
  await page.locator("#toolsbar [data-t=cad]").click();
  await expect(pop).toContainText("From-Disk");
  await pop.getByRole("button", { name: /vault-model\.glb/ }).click();
  await expect.poll(async () => (await model(page, id)).scene.cad_models.map((m: any) => [m.id, m.ground]), { timeout: 15_000 })
    .toEqual([["From-Disk", true], ["vault-model", false]]);
  await expect(page.locator("#tree")).toContainText("vault-model", { timeout: 15_000 });
  // remove the first (the file stays in the vault)
  await page.locator("#toolsbar [data-t=cad]").click();
  page.once("dialog", (d) => d.accept());
  await pop.locator("[data-c=del]").first().click();
  await expect.poll(async () => (await model(page, id)).scene.cad_models.map((m: any) => m.id), { timeout: 15_000 }).toEqual(["vault-model"]);
  await expect(page.locator("#tree")).not.toContainText("From-Disk", { timeout: 15_000 });
  expect((await api(page).get("/api/files/CAD/From%20Disk.glb")).ok()).toBe(true);
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
  await page.getByRole("button", { name: "AI Assist", exact: true }).click();
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

test("group folders in the tree: create, file by menu and by drag, select and hide a folder, rename, delete", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Group folder test", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "F"\nmove @lid by [0,1,0] 1s' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } },
    groups: { lid: ["head", "bolts"], ves: ["vessel"], mach: ["machine"] }, folders: { Top: ["lid"] } };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Group folder test");
  const status = page.locator("#script .status");
  await expect(status).toHaveText("✓", { timeout: 15_000 });
  const row = (t: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^(▤)?${t}$`) }) }).first();
  const menu = async (r: ReturnType<typeof row>, item: RegExp) => { await r.click({ button: "right" }); await page.getByRole("menuitem", { name: item }).click(); };

  // a saved folder shows its groups when opened; the lid group isn't at the top level
  await expect(row("Top")).toBeVisible();
  await expect(row("lid")).toHaveCount(0);
  await row("Top").locator(".caret").click();
  await expect(row("lid")).toBeVisible();
  // selecting a folder selects its groups' parts
  await row("Top").click();
  await expect(page.locator("#tree .info")).toContainText("1 group, 2 parts");
  // the eye hides every part in the folder
  await row("Top").locator(".tg").first().click();
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.hidden).toEqual({ head: true, bolts: true });
  await row("Top").locator(".tg").first().click();
  await expect.poll(async () => (await model(page, a.id)).snapshots.items.default.hidden).toEqual({ head: false, bolts: false });

  // new folder from the Groups heading, then file a group with "Move to folder…"
  page.once("dialog", (d) => d.accept("Plant"));
  await menu(row("Groups"), /^New folder/);
  await expect(row("Plant")).toBeVisible();
  page.once("dialog", (d) => d.accept("Plant"));
  await menu(row("ves"), /^Move to folder/);
  await expect.poll(async () => (await model(page, a.id)).folders).toEqual({ Top: ["lid"], Plant: ["ves"] });
  // drag a group onto a folder, and a folder into another (nested)
  await row("mach").dragTo(row("Plant"));
  await expect.poll(async () => (await model(page, a.id)).folders).toEqual({ Top: ["lid"], Plant: ["ves", "mach"] });
  await row("Top").dragTo(row("Plant"));
  await expect.poll(async () => (await model(page, a.id)).folders).toEqual({ Plant: ["ves", "mach"], "Plant/Top": ["lid"] });
  // rename and delete: groups move up a level; the script is untouched
  page.once("dialog", (d) => d.accept("Lid parts"));
  await menu(row("Top"), /^Rename folder/);
  await expect.poll(async () => (await model(page, a.id)).folders).toEqual({ Plant: ["ves", "mach"], "Plant/Lid parts": ["lid"] });
  page.once("dialog", (d) => d.accept());
  await menu(row("Plant"), /^Delete folder/);
  await expect.poll(async () => (await model(page, a.id)).folders).toEqual({ "Lid parts": ["lid"] });
  expect(Object.keys((await model(page, a.id)).groups).sort()).toEqual(["lid", "mach", "ves"]);
  await expect(status).toHaveText("✓");
});

test("tree: Shift-click selects a range of rows, ⌘-click toggles one", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Range select", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "R"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Range select");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const row = (t: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^${t}$`) }) }).first();
  const selected = () => page.locator("#tree .row.sel .lbl").allTextContents();
  await row("vessel").click();
  await row("barrel").click({ modifiers: ["Shift"] });
  await expect.poll(selected).toEqual(["vessel", "head", "bolts", "barrel"]);
  await expect(page.locator("#tree .info")).toContainText("4 items selected");
  await row("head").click({ modifiers: ["Meta"] });                    // ⌘-click still toggles one row
  await expect.poll(selected).toEqual(["vessel", "bolts", "barrel"]);
  await row("machine").click({ modifiers: ["Shift"] });               // range from the last clicked row (head)
  await expect.poll(selected).toEqual(["head", "bolts", "barrel", "machine"]);
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

test("assist: propose_shapes makes, changes and deletes shapes through an accepted card", async ({ page }) => {
  await page.goto("/");
  const m = { name: "AI shapes", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "S"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "AI shapes");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#right [data-t=assist]").click();
  // checks: bad sizes / names / kinds are problems, not cards you can accept
  const bad = await page.evaluate(async () => {
    const s = (window as any).__studio, t = s.tools.find((x: any) => x.name === "propose_shapes");
    const g = t.run({ summary: "x", changes: [{ action: "create", name: "p", kind: "tube", size: { outer_radius: 0.1, inner_radius: 0.2 } },
      { action: "create", name: "9x", kind: "box" }, { action: "update", name: "ghost" }, { action: "create", name: "q", kind: "torus" }] });
    let x = await g.next(); let p: any; for (; !x.done; x = await g.next()) p = x.value; return { ok: p.check.ok, problems: p.problems };
  });
  expect(bad.ok).toBe(false);
  expect(bad.problems.join(" | ")).toMatch(/inner_radius must be less.*bad shape name.*no shape "ghost".*kind must be/);
  // the user's request: a 6 m tube, 0.3 m inner / 0.6 m outer diameter, standing on the floor (y = 0)
  const propose = (changes: any[], summary: string) => page.evaluate(async ({ changes, summary }) => {
    const s = (window as any).__studio, t = s.tools.find((x: any) => x.name === "propose_shapes");
    let p: any; const g = t.run({ summary, changes }); for (let r = await g.next(); !r.done; r = await g.next()) if (r.value.type === "proposal") { const { type, ...x } = r.value; p = x; }
    s.assist.host.onChat([...s.assist.host.chat(), { role: "user", content: summary }, { role: "assistant", content: "Here it is.", proposal: p }]);
    s.assist.mount.refresh();
  }, { changes, summary });
  await propose([{ action: "create", name: "pipe", kind: "tube", size: { outer_radius: 0.3, inner_radius: 0.15, height: 6 }, position: [2, 3, 0], color: "#4a90d9" }], "A 6 m tube");
  const card = page.getByTestId("proposal").last();
  await expect(card).toContainText("create pipe: tube outer radius 0.3, inner radius 0.15, height 6 m at [2, 3, 0]");
  await card.getByRole("button", { name: "Accept" }).click();
  await expect.poll(async () => (await model(page, a.id)).shapes).toEqual([{ id: "pipe", kind: "tube", size: [0.3, 0.15, 6], position: [2, 3, 0], rotation: [0, 0, 0], color: "#4a90d9" }]);
  expect(await page.evaluate(() => !!(window as any).__studio.built.registry.get("shapes/pipe"))).toBe(true);
  // an update renames it and lays it along X (sizes kept); then delete
  await propose([{ action: "update", name: "pipe", rename: "duct", rotation: [0, 0, 90] }], "Lay it down");
  await page.getByTestId("proposal").last().getByRole("button", { name: "Accept" }).click();
  await expect.poll(async () => (await model(page, a.id)).shapes?.[0]).toMatchObject({ id: "duct", rotation: [0, 0, 90], size: [0.3, 0.15, 6] });
  await propose([{ action: "delete", name: "duct" }], "Remove it");
  await page.getByTestId("proposal").last().getByRole("button", { name: "Accept" }).click();
  await expect.poll(async () => (await model(page, a.id)).shapes).toEqual([]);
});

test("assist: propose_placement positions parts at the start (stand on, rotate, reset), even locked ones; animation still plays from there", async ({ page }) => {
  await page.goto("/");
  const m = { name: "AI place", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "P"\nmove machine by [0,1,0] 1s' },
    snapshots: { active: "default", items: { default: { locked: { vessel: true }, hidden: {} } } }, groups: {},
    shapes: [{ id: "blk", kind: "box", size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], color: "#888888" }] };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "AI place");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#right [data-t=assist]").click();
  const box = (id: string) => page.evaluate((id) => { const s = (window as any).__studio, b = new s.THREE.Box3().setFromObject(s.built.registry.get(id));
    return { min: b.min.toArray().map((v: number) => +v.toFixed(3)), max: b.max.toArray().map((v: number) => +v.toFixed(3)) }; }, id);
  const propose = (changes: any[], summary: string) => page.evaluate(async ({ changes, summary }) => {
    const s = (window as any).__studio, t = s.tools.find((x: any) => x.name === "propose_placement");
    let p: any, x: any; const g = t.run({ summary, changes }); for (x = await g.next(); !x.done; x = await g.next()) if (x.value.type === "proposal") { const { type, ...y } = x.value; p = y; }
    s.assist.host.onChat([...s.assist.host.chat(), { role: "user", content: summary }, { role: "assistant", content: "OK.", proposal: p }]);
    s.assist.mount.refresh();
    return { ok: p.check.ok, problems: p.problems, result: x.value.content };
  }, { changes, summary });
  const accept = () => page.getByTestId("proposal").last().getByRole("button", { name: "Accept" }).click();

  // bad input is a problem
  const bad = await propose([{ targets: ["ghost"], move_by: [1, 0, 0] }, { targets: ["machine"] }], "bad");
  expect(bad.ok).toBe(false);
  expect(bad.problems.join(" | ")).toMatch(/unknown target "ghost".*needs move_by/);

  // stand the machine on top of the (locked) vessel: bottom-centre to the vessel's top-centre
  const v = await box("vessel");
  const top = [(v.min[0] + v.max[0]) / 2, v.max[1], (v.min[2] + v.max[2]) / 2];
  const r1 = await propose([{ targets: ["machine"], move_to: top, anchor: "bottom" }], "Machine on the vessel");
  expect(r1.ok).toBe(true);
  await expect(page.getByTestId("proposal").last()).toContainText("Position parts");
  await accept();
  await expect.poll(async () => (await box("machine")).min[1]).toBeCloseTo(v.max[1], 2);
  await expect.poll(async () => Object.keys((await model(page, a.id)).snapshots.items.default.placements ?? {})).toEqual(["machine"]);
  // the script still animates it from the new start: at t = 1 it is 1 m higher
  const y1 = await page.evaluate(() => { const s = (window as any).__studio; s.player.seek(1); const y = new s.THREE.Box3().setFromObject(s.built.registry.get("machine")).min.y; s.player.seek(0); return y; });
  expect(y1).toBeCloseTo(v.max[1] + 1, 2);
  // a locked part moves too
  const v0 = await box("vessel");
  await propose([{ targets: ["vessel"], move_by: [2, 0, 0] }], "Shift the vessel");
  await accept();
  await expect.poll(async () => (await box("vessel")).min[0]).toBeCloseTo(v0.min[0] + 2, 2);
  // a shape: rotate 90° about z and stand it at the origin – its own numbers change
  await propose([{ targets: ["blk"], rotate: { axis: "z", degrees: 90 }, move_to: [5, 0, 0], anchor: "bottom" }], "Turn the block");
  await accept();
  await expect.poll(async () => (await model(page, a.id)).shapes[0]).toMatchObject({ position: [5, 0.5, 0], rotation: [0, 0, 90] });
  // reset
  await propose([{ targets: ["machine", "vessel"], reset: true }], "Put back");
  await accept();
  await expect.poll(async () => Object.keys((await model(page, a.id)).snapshots.items.default.placements ?? {})).toEqual([]);
  expect((await box("vessel")).min[0]).toBeCloseTo(v0.min[0], 3);
  await expect(page.locator("#script .status")).toHaveText("✓");
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

test("keep uncut: the cut leaves chosen parts whole (tool bar / saved list, script keep for one cut), shaded and hidden line; core blocks too", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const box = (id: string, z: number, color: string) => ({ id, kind: "box", size: [2, 2, 2], position: [0, 1, z], rotation: [0, 0, 0], color });
  const m = { name: "Keep uncut", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [0,1,10] look [0,1,0]\nlabel "K"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {},
    shapes: [box("back", -1.5, "#dddddd"), box("front", 1.5, "#dddddd")] };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Keep uncut");
  const status = page.locator("#script .status");
  await expect(status).toHaveText("✓", { timeout: 15_000 });
  // luminance at world points (front box: x -1..1, z 0.5..2.5; the half cut removes x > 0)
  const lum = (pts: number[][], t?: number) => page.evaluate(async ({ pts, t }) => {
    const s = (window as any).__studio;
    if (t !== undefined) { s.player.playing = false; s.player.seek(t); }
    await new Promise((r) => setTimeout(r, 200));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    return pts.map((p) => { const v = new s.THREE.Vector3(...p).project(s.camera); const d = g.getImageData(Math.round((v.x + 1) / 2 * cv.width), Math.round((1 - v.y) / 2 * cv.height), 1, 1).data; return (d[0] + d[1] + d[2]) / 3; });
  }, { pts, t });
  const cutSide = [0.75, 1.75, 2.5], keptEdge = [1, 1.75, 2.5], uncutSide = [-0.5, 1.75, 2.5];   // clear of the gizmo's arrows
  let [cutL, leftL] = await lum([cutSide, uncutSide]);
  expect(cutL).toBeLessThan(40);                 // the front box's right half is cut away (background)
  expect(leftL).toBeGreaterThan(100);            // its left half is there
  // keep the front box uncut from the tool bar: saved, badge in the tree, drawn whole
  const row = (t: string) => page.locator("#tree .row", { has: page.locator(".lbl", { hasText: new RegExp(`^${t}$`) }) }).first();
  await row("front").click();
  await page.locator("#toolsbar [data-t=keep]").click();
  await expect(page.locator("#toolsbar [data-t=keep]")).toContainText("Cut again");
  await expect.poll(async () => (await model(page, a.id)).cutKeep).toEqual(["shapes/front"]);
  await expect(row("front").locator(".kept")).toBeVisible();
  await page.keyboard.press("Escape");                                       // deselect (no highlight colour)
  [cutL] = await lum([cutSide]);
  expect(cutL).toBeGreaterThan(100);
  // hidden line: the kept box's far edge (x = 1) is drawn; the back box, cut, has none there
  await page.locator("#viewbar button", { hasText: "Hidden line" }).click();
  let [edge, backEdge] = await lum([keptEdge, [1, 1.75, -0.5]]);
  expect(edge).toBeLessThan(140);
  expect(backEdge).toBeGreaterThan(200);
  // undo: cut again
  await page.locator("#viewbar button", { hasText: "Shaded" }).first().click();
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await model(page, a.id)).cutKeep).toEqual([]);
  [cutL] = await lum([cutSide]);
  expect(cutL).toBeLessThan(40);
  // the script: keep for one cut only
  await page.evaluate(() => {
    (window as any).__studio.scriptPanel.setText('camera [0,1,10] look [0,1,0]\nlabel "K"\ncutaway half keep front\nwait 1s\ncutaway half\nwait 1s');
  });
  await expect(status).toHaveText("✓");
  expect((await lum([cutSide], 0.5))[0]).toBeGreaterThan(100);
  expect((await lum([cutSide], 1.5))[0]).toBeLessThan(40);
  // unknown parts after keep are errors on that line
  await page.evaluate(() => {
    (window as any).__studio.scriptPanel.setText('label "K"\ncutaway half keep nothing-here');
  });
  await expect(status).toHaveText("1 error");
});

test("keep uncut: a core block kept uncut stays visible inside the cut", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Keep block", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "B"\ncutaway half' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Keep block");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const id = await page.evaluate(() => { const s = (window as any).__studio; return s.built.blockIds.find((b: string) => { const o = s.built.registry.get(b); return o.position.x > 0.5 && !o.visible; }); });
  expect(id).toBeTruthy();
  await page.evaluate((id) => {
    (window as any).__studio.scriptPanel.setText(`label "B"\ncutaway half keep ${id}`);
  }, id);
  await expect(page.locator("#script .status")).toHaveText("✓");
  await expect.poll(() => page.evaluate((id) => (window as any).__studio.built.registry.get(id).visible, id)).toBe(true);
});

test("outline: a glow around parts (colour, width, fades), seen through parts in front; hidden line too", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  const m = { name: "Glow", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'camera [0,1,10] look [0,1,0]\nlabel "G"\nparallel {\n  outline blk #ff2020 12px 1s\n  outline front 1s\n}\nwait 1s\noutline blk, front off 1s' },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {},
    shapes: [{ id: "front", kind: "box", size: [2, 2, 2], position: [-1.5, 1, 1.5], rotation: [0, 0, 0], color: "#888888" },
             { id: "blk", kind: "box", size: [1, 1, 1], position: [-1.5, 1, -1.5], rotation: [0, 0, 0], color: "#888888" }] };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Glow");
  const status = page.locator("#script .status");
  await expect(status).toHaveText("✓", { timeout: 15_000 });
  // rgb at world points, at time t
  const rgb = (pts: number[][], t: number, shot?: string) => page.evaluate(async ({ pts, t }) => {
    const s = (window as any).__studio;
    s.player.playing = false; s.player.seek(t);
    await new Promise((r) => setTimeout(r, 150));
    s.drawFrame();
    const cv = s.renderer.domElement as HTMLCanvasElement;
    const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; const g = c2.getContext("2d")!; g.drawImage(cv, 0, 0);
    return pts.map((p) => { const v = new s.THREE.Vector3(...p).project(s.camera); return [...g.getImageData(Math.round((v.x + 1) / 2 * cv.width), Math.round((1 - v.y) / 2 * cv.height), 1, 1).data].slice(0, 3); });
  }, { pts, t }).then(async (r) => { if (shot) await page.locator("#app canvas").screenshot({ path: shot }); return r; });
  const hidden = [-1.5, 1, -1.5];          // the small box's centre, behind the front box
  const besideHidden = [-0.9, 1, -1.5];    // just outside its silhouette (still in front of the front box)
  const outsideFront = [-0.47, 1, 0.5];    // ~3 px outside the front box's silhouette (its back edge, seen from the right), over the background
  const far = [2.5, 1, 1.5];
  const [h0, b0, o0, f0] = await rgb([hidden, besideHidden, outsideFront, far], 0);
  const [h1, b1, o1, f1] = await rgb([hidden, besideHidden, outsideFront, far], 1, process.env.GLOW_SHOT);
  expect(h1[0] - h1[2]).toBeGreaterThan(h0[0] - h0[2] + 15);     // a red tint where the box is hidden
  expect(b1[0] - b1[1]).toBeGreaterThan(b0[0] - b0[1] + 25);     // red glow just outside its silhouette, through the front box
  expect(o1[2] + o1[1] - 2 * o1[0]).toBeGreaterThan(80);         // the front box's default cyan glow over the background
  expect(o0.reduce((a, c) => a + c)).toBeLessThan(60);
  expect(f1).toEqual(f0);                                          // nothing far away
  const [h2, , o2] = await rgb([hidden, besideHidden, outsideFront], 3);
  expect(h2).toEqual(h0); expect(o2).toEqual(o0);                   // off
  // hidden line: the glow and the hidden tint too
  await page.locator("#viewbar button", { hasText: "Hidden line" }).click();
  const [hl0, bl0] = await rgb([hidden, besideHidden], 0);
  const [hl1, bl1] = await rgb([hidden, besideHidden], 1, process.env.GLOW_SHOT?.replace(".png", "-hl.png"));
  expect(hl1[1]).toBeLessThan(hl0[1] - 15);
  expect(bl1[1]).toBeLessThan(bl0[1] - 25);
  // errors
  await page.evaluate(() => (window as any).__studio.scriptPanel.setText('label "G"\noutline blk plaid 1s'));
  await expect(status).toHaveText("1 error");
  await page.evaluate(() => (window as any).__studio.scriptPanel.setText('label "G"\noutline blk 90px'));
  await expect(status).toHaveText("1 error");
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

test("basic modelling: add a shape, edit it, a circular array scriptable by name, rename follows the script, undo, delete", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const m = { name: "Shapes", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'label "S"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  const a = await (await api(page).post("/api/projects", { data: { name: m.name, problem: m } })).json();
  await open(page, "Shapes");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const pop = page.locator("#toolsbar .shpop");
  await page.locator("#toolsbar [data-t=shape]").click();
  await pop.locator('[data-f="kind"]').selectOption("cylinder");
  await pop.locator('[data-f="size0"]').fill("0.25");
  await pop.locator('[data-f="size1"]').fill("2");
  for (const [i, v] of ["1.5", "1", "0"].entries()) await pop.locator(`[data-f="pos${i}"]`).fill(v);
  await pop.getByRole("button", { name: "Add shape" }).click();
  await expect.poll(async () => (await model(page, a.id)).shapes?.[0]).toMatchObject({ id: "cylinder-1", kind: "cylinder", size: [0.25, 2], position: [1.5, 1, 0] });
  await expect(page.locator("#tree .row", { hasText: "cylinder-1" }).first()).toBeVisible();
  const bbox = (id: string) => page.evaluate((id) => { const s = (window as any).__studio; const b = new s.THREE.Box3().setFromObject(s.built.registry.get(id));
    return [b.min.toArray(), b.max.toArray()].map((v: number[]) => v.map((x) => +x.toFixed(2))); }, id);
  expect(await bbox("shapes/cylinder-1")).toEqual([[1.25, 0, -0.25], [1.75, 2, 0.25]]);
  // the panel now edits the selected shape: height 3 (applies as you type)
  await expect(pop).toContainText("Shape cylinder-1");
  await pop.locator('[data-f="size1"]').fill("3");
  await expect.poll(() => bbox("shapes/cylinder-1")).toEqual([[1.25, -0.5, -0.25], [1.75, 2.5, 0.25]]);
  // a circular array of 6 about the origin
  await pop.locator('[data-f="atype"]').selectOption("circular");
  await pop.locator('[data-f="count"]').fill("6");
  await expect.poll(async () => (await model(page, a.id)).shapes?.[0].array).toMatchObject({ type: "circular", count: 6, centre: [0, 0], angle: 360 });
  const copy3 = await page.evaluate(() => (window as any).__studio.built.registry.get("shapes/cylinder-1/cylinder-1-3")?.position.toArray().map((v: number) => +v.toFixed(2) + 0));
  expect(copy3).toEqual([-1.5, 1, 0]);   // half way round
  // scripts reach a copy by its short name
  await page.locator("#script .cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nmove cylinder-1-3 by [0,1,0] 1s");
  await expect(page.locator("#script .status")).toHaveText("✓");
  // rename: the script follows
  await page.locator("#tree .row", { has: page.locator(".lbl", { hasText: /^cylinder-1$/ }) }).first().click();
  await page.evaluate(() => { (window as any).__mark = (window as any).__studio; });
  await pop.locator('[data-f="id"]').fill("pins");
  await expect(page.locator("#script .cm-content")).toContainText("move pins-3 by [0,1,0] 1s");
  await expect(page.locator("#script .status")).toHaveText("✓");
  // a cut through the shapes is capped like any part
  const capped = await page.evaluate(() => { let n = 0; (window as any).__studio.built.registry.get("shapes/pins").traverse((x: any) => { if (x.isMesh && x.material.userData.capped) n++; }); return n; });
  expect(capped).toBe(6);
  // undo the rename, then delete
  expect(await page.evaluate(() => (window as any).__mark === (window as any).__studio)).toBe(true);   // no remount from a burst of edits
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.waitForTimeout(500);
  await pop.getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await model(page, a.id)).shapes).toEqual([]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await model(page, a.id)).shapes?.[0]?.id).toBe("pins");
  await expect.poll(() => page.evaluate(() => !!(window as any).__studio.built.registry.get("shapes/pins/pins-5"))).toBe(true);
});

test("SVG line drawing: exact hidden lines from the geometry, ISO layers in mm", async ({ page }) => {
  await page.goto("/");
  const m = { name: "Svg", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'label "S"' }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Svg");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  const r = await page.evaluate(() => {
    const s = (window as any).__studio, T = s.THREE;
    const box = (w: number, z: number, id: string) => { const b = new T.Mesh(new T.BoxGeometry(w, w, w), new T.MeshToonMaterial()); b.position.set(0, 1, z); b.userData.id = id; s.built.root.add(b); };
    box(2, 0, "front"); box(1, -4, "behind");              // fully hidden behind the front box, seen from +z
    s.camera.position.set(0, 1, 20); s.camera.lookAt(0, 1, 0); s.camera.updateMatrixWorld();
    const a = s.vectorDrawing({ hidden: true, paper: "A4" }), b = s.vectorDrawing({ hidden: false, paper: "A4" });
    return { svg: a.svg, stats: a.stats, plain: b.stats };
  });
  expect(r.svg).toContain('width="297mm" height="210mm"');
  for (const l of ["outline", "crease", "hidden"]) expect(r.svg).toContain(`inkscape:label="${l}"`);
  expect(r.stats["lines.outline"]).toBe(1);   // the front square, chained into one closed polyline
  expect(r.stats["lines.hidden"]).toBe(1);    // the box behind: its outline, all hidden
  expect(r.plain["lines.hidden"]).toBe(0);
  const outline = r.svg.match(/id="outline"[^>]*><path d="([^"]+)"/)![1];
  expect(outline.split("L").length).toBe(5);   // 4 corners + closing point: collinear pieces merged
});

test("drawing sheets: the .draw script in the Illustration tab – view, hide, cut, scale; preview; save all to the vault; autosaved", async ({ page }) => {
  await page.goto("/");
  const draw = ['paper A4', 'scale 1:10', 'bogus line', '', 'sheet a "Both"', '  view front', '  hidden on', '', 'sheet b', '  view front', '  hide front',
    '', 'sheet c', '  view front', '  only front', '  cut half x at [0,0,0]'].join("\n");
  const m = { name: "Sheets", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'label "S"' }, drawings: { language: "draw", text: draw },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Sheets");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#right [data-t=illustration]").click();
  const panel = page.locator("#illustration .draw-script");
  await expect(panel.locator(".st")).toHaveText("1 error");                 // "bogus line"
  await page.evaluate(() => { const p = (window as any).__studio.drawPanel; p.setText(p.text.replace("bogus line\n", "")); });
  await expect(panel.locator(".st")).toHaveText("✓ 3 sheets");
  await page.evaluate(() => {
    const s = (window as any).__studio, T = s.THREE;
    const box = (w: number, z: number, id: string) => {
      const b = new T.Mesh(new T.BoxGeometry(w, w, w), new T.MeshToonMaterial({ clippingPlanes: s.built.clipPlanes, clipIntersection: true }));
      b.position.set(0, 1, z); b.userData.id = id; s.built.root.add(b); s.built.registry.set(id, b);
    };
    box(2, 0, "front"); box(1, -4, "behind");
  });
  const run = (n: string) => page.evaluate(async (n) => { const r = await (window as any).__studio.runSheet(n); return { svg: r.svg, stats: r.stats, errors: r.errors }; }, n);
  const xs = (svg: string) => { const d = svg.match(/id="outline"[^>]*><path d="([^"]+)"/)![1]; const v = [...d.matchAll(/[ML]([\d.]+) /g)].map((x) => Number(x[1])); return Math.max(...v) - Math.min(...v); };
  const a = await run("a");
  expect(a.errors).toEqual([]);
  expect(a.svg).toContain('width="297mm" height="210mm"');
  expect(a.stats["lines.outline"]).toBe(1); expect(a.stats["lines.hidden"]).toBe(1);
  expect(xs(a.svg)).toBeCloseTo(200, 0);                                     // 2 m at 1:10
  const b = await run("b");
  expect(b.stats["lines.outline"]).toBe(1); expect(b.stats["lines.hidden"]).toBe(0);
  expect(xs(b.svg)).toBeCloseTo(100, 0);                                     // only the 1 m box behind
  const c = await run("c");
  expect(c.errors).toEqual([]);
  expect(xs(c.svg)).toBeCloseTo(100, 0);                                     // the front box cut in half at x = 0
  // looking at the cut face: the section is capped (the inside of the box doesn't show) and hatched
  await page.evaluate(() => { const p = (window as any).__studio.drawPanel; p.setText(p.text + '\nsheet e "Section A-A"\n  view side\n  only front\n  cut half x\n  file section-AA\n'); });
  const e = await run("e");
  expect(e.errors).toEqual([]);
  expect(e.stats["lines.outline"]).toBe(1);                                  // the cut outline: one square
  expect(e.stats["lines.crease"]).toBe(0);                                   // nothing inside shows through
  expect(e.stats["lines.hatch"]).toBeGreaterThan(100);                       // 200 mm square at 2.5 mm, 45°
  expect(e.stats["lines.hatch"]).toBeLessThan(125);
  expect(e.svg).toContain('id="titleblock"');
  for (const t of ["Section A-A", "1:10"]) expect(e.svg).toContain(t);
  expect(e.svg).not.toContain("DRAWING NO.");
  // fills: the part colour (or tinted) under the lines, traced at 0.25 mm
  await page.evaluate(() => { const s = (window as any).__studio; s.built.registry.get("front").material.color.set("#ff0000");
    s.drawPanel.setText(s.drawPanel.text + '\nsheet f\n  view front\n  scale 1:20\n  fill colour\nsheet g\n  view front\n  fill tint\n'); });
  const fl = await run("f");
  expect(fl.errors).toEqual([]);
  const red = fl.svg.match(/<path fill="#ff0000" d="([^"]+)"/)![1];
  const nums = [...red.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
  const w = Math.max(...nums.map((p) => p[0])) - Math.min(...nums.map((p) => p[0])), h = Math.max(...nums.map((p) => p[1])) - Math.min(...nums.map((p) => p[1]));
  expect(Math.abs(w - 100)).toBeLessThan(0.6); expect(Math.abs(h - 100)).toBeLessThan(0.6);   // the 2 m box at 1:20
  expect(fl.svg).not.toContain('fill="#ffffff" d=');                          // the white box behind is hidden
  expect(fl.svg.indexOf('id="fill"')).toBeLessThan(fl.svg.indexOf('id="outline"')); // under the lines
  expect((await run("g")).svg).toContain('fill="#ff8080"');
  // the studio's own cut is back afterwards (the script has none)
  expect(await page.evaluate(() => (window as any).__studio.built.clipPlanes[0].constant)).toBeGreaterThan(1e8);
  // unknown parts are errors on the sheet's line
  await page.evaluate(() => { const p = (window as any).__studio.drawPanel; p.setText(p.text + "\nsheet d\n  hide nothing-here\n"); });
  expect((await run("d")).errors[0].message).toContain("nothing-here");
  // preview
  await page.evaluate(() => (window as any).__studio.previewSheet("c"));
  await expect(page.locator("#sheet-preview .page img")).toBeVisible();
  await expect(page.locator("#sheet-preview .strip .th")).toHaveCount(7);          // every sheet
  await expect(page.locator("#sheet-preview .strip .th.on")).toHaveAttribute("data-s", "c");
  await expect(page.locator("#sheet-preview .strip .th.bad")).toHaveCount(1);      // sheet d's unknown part
  await page.locator("#sheet-preview .strip .th[data-s=b]").click();
  await expect(page.locator("#sheet-preview header b")).toHaveText("b");
  for (const n of ["a", "section-AA", "g"]) {
    const r = await api(page).get(`/api/files/Drawings/Sheets/${n}.png`);
    expect(r.status()).toBe(200);
    expect((await r.body()).subarray(1, 4).toString()).toBe("PNG");
  }
  await page.locator("#sheet-preview [data-a=close]").click();
  await expect(page.locator("#sheet-preview")).toHaveCount(0);
  // save all → the vault
  await panel.locator("[data-a=save]").click();
  await expect.poll(async () => (await api(page).get("/api/files/Drawings/Sheets/d.pdf")).status(), { timeout: 30_000 }).toBe(200);
  await expect(panel.locator(".st")).toContainText("1 error");                    // sheet d's unknown part
  for (const n of ["a", "b", "c", "d", "section-AA"]) {
    const r = await api(page).get(`/api/files/Drawings/Sheets/${n}.svg`);
    expect(r.status()).toBe(200);
    expect(await r.text()).toContain("<svg");
    const pdf = await api(page).get(`/api/files/Drawings/Sheets/${n}.pdf`);
    expect(pdf.status()).toBe(200);
    const body = await pdf.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.toString("latin1")).toMatch(/\/MediaBox \[0 0 841\.8\d* 595\.2\d*\]/);   // A4 landscape in points
  }
  // the edited script is saved in the model
  await expect.poll(async () => { const p = (await (await api(page).get("/api/home")).json()).projects.find((x: any) => x.name === "Sheets");
    const mm = (await (await api(page).get(`/api/projects/${p.id}`)).json()).problem; const t = mm.drawings?.text; return Array.isArray(t) ? t.join("\n") : t; }, { timeout: 5_000 }).toContain("hide nothing-here");
});

test("fast sheet PNG: one GPU frame per sheet in its style, on the paper with the title box", async ({ page }) => {
  await page.goto("/");
  const draw = ['paper A4', 'scale 1:10', 'dpi 100', '', 'sheet o "Outline"', '  view front', '  scale 1:20', '', 'sheet s "Shaded"', '  view front', '  style shaded', '',
    'sheet h', '  view front', '  style hidden', '  only red', '', 'sheet big', '  dpi 1200', '  paper A0'].join("\n");
  const m = { name: "Png", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'label "P"' }, drawings: { language: "draw", text: draw },
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Png");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.locator("#right [data-t=illustration]").click();
  await expect(page.locator("#illustration .draw-script .st")).toHaveText("✓ 4 sheets");
  await page.evaluate(() => {
    const s = (window as any).__studio, T = s.THREE;
    const b = new T.Mesh(new T.BoxGeometry(2, 2, 2), new T.MeshToonMaterial({ color: "#ff0000", clippingPlanes: s.built.clipPlanes, clipIntersection: true }));
    b.position.set(0, 1, 0); b.userData.id = "red"; s.built.root.add(b); s.built.registry.set("red", b);
  });
  const before = await page.evaluate(() => { const s = (window as any).__studio; return { w: s.renderer.domElement.width, t: s.player.time }; });
  const run = (n: string) => page.evaluate(async (n) => {
    const r = await (window as any).__studio.renderSheetPng(n);
    const g = r.canvas.getContext("2d"), W = r.canvas.width, H = r.canvas.height;
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data);
    // count red-ish and black pixels on the centre row
    let red = 0, dark = 0;
    const row = g.getImageData(0, Math.round(H * 0.45), W, 1).data;
    for (let i = 0; i < row.length; i += 4) { if (row[i] > 150 && row[i + 1] < 120) red++; if (row[i] + row[i + 1] + row[i + 2] < 150) dark++; }
    return { W, H, ms: r.ms, errors: r.errors, corner: px(2, 2), red, dark, bytes: r.png.size };
  }, n);
  const o = await run("o");
  expect(o.errors).toEqual([]);
  expect(o.W).toBe(Math.round(297 * 100 / 25.4)); expect(o.H).toBe(Math.round(210 * 100 / 25.4));   // A4 at 100 dpi
  expect(o.corner).toEqual([255, 255, 255, 255]);                                  // white paper
  expect(o.ms).toBeLessThan(1500);
  const red2m = 200 * 100 / 25.4;                                                  // the 2 m box at 1:10 → 200 mm (sheet o: 1:20 → half)
  expect(Math.abs(o.red - red2m / 2)).toBeLessThan(red2m * 0.05);
  expect(o.dark).toBeGreaterThanOrEqual(2);                                       // its outline
  const sh = await run("s");
  expect(Math.abs(sh.red - red2m)).toBeLessThan(red2m * 0.1);
  // a half cut frames what's left: the cut box is centred
  await page.evaluate(() => { const p = (window as any).__studio.drawPanel; p.setText(p.text + "\nsheet cut\n  view front\n  scale 1:20\n  dpi 100\n  paper A4\n  cut half x at [0,0,0]\n"); });
  const cutRow = await page.evaluate(async () => { const r = await (window as any).__studio.renderSheetPng("cut"); const g = r.canvas.getContext("2d"); const W = r.canvas.width;
    const row = g.getImageData(0, Math.round(r.canvas.height * 0.45), W, 1).data; let a = -1, b = -1; for (let x = 0; x < W; x++) if (row[x * 4] > 150 && row[x * 4 + 1] < 120) { if (a < 0) a = x; b = x; } return { a, b, W }; });
  expect(Math.abs((cutRow.a + cutRow.b) / 2 - cutRow.W * (10 + 277 / 2) / 297)).toBeLessThan(6);   // centred in the drawing area
  expect(Math.abs(cutRow.b - cutRow.a - red2m / 4)).toBeLessThan(6);                                 // 1 m wide at 1:20
  const h = await run("h");
  expect(h.red).toBe(0); expect(h.dark).toBeGreaterThan(1);                        // lines only
  const big = await run("big");
  expect(big.errors[0].message).toContain("dpi");                                   // lowered to what the GPU holds
  expect(Math.max(big.W, big.H)).toBeLessThanOrEqual(9000);
  // the studio is as it was
  expect(await page.evaluate(() => { const s = (window as any).__studio; return { w: s.renderer.domElement.width, t: s.player.time }; })).toEqual(before);
});

test("batch drawings from the command line: npm run drawings -- <animation> [sheets]", async ({ page, baseURL }) => {
  const draw = "paper A3\nsheet one\n  view front\nsheet two\n  view top\n";
  const m = { name: "Batch", solver: "refuel-anim", format: 1, scene: { generated: true, cad_models: [] },
    script: { language: "anim", text: 'label "B"' }, drawings: { language: "draw", text: draw }, snapshots: { active: "default", items: { default: { locked: {}, hidden: {} } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  const { execFileSync } = await import("node:child_process");
  const run = (...a: string[]) => { try { return { out: execFileSync("node", ["scripts/drawings.mjs", ...a, "--url", baseURL!], { encoding: "utf8", stdio: "pipe" }), code: 0 }; }
    catch (e: any) { return { out: String(e.stdout) + String(e.stderr), code: e.status }; } };
  const r = run("Batch", "two");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Drawings/Batch/two.pdf");
  expect((await api(page).get("/api/files/Drawings/Batch/two.svg")).status()).toBe(200);
  expect((await api(page).get("/api/files/Drawings/Batch/one.svg")).status()).toBe(404);   // only the named sheet
  const bad = run("Batch", "nope");
  expect(bad.code).toBe(1);
  expect(bad.out).toContain('no sheet "nope"');
  expect(run("No such animation").code).toBe(2);
});

test("drawing sheets pose the model (at a time / chapter, a snapshot) and leave the studio as it was; undo; quarter cuts", async ({ page }) => {
  await page.goto("/");
  const draw = ["paper A4", "scale 1:100", "sheet t0", "  view front", "sheet t2", "  view front", "  at 2s", "sheet ch", "  view front", "  at \"Moved\"",
    "sheet snap", "  view front", "  snapshot \"no-a\"", "sheet q", "  view iso", "  only shapes/c", "  cut quarter x z at [10,0,0]", "  scale 1:20"].join("\n");
  const box = (id: string, x: number) => ({ id, kind: "box", size: [1, 1, 1], position: [x, 0.5, 0], rotation: [0, 0, 0], color: "#cccccc" });
  const m = { name: "Poses", solver: "refuel-anim", format: 1, scene: { generated: false, cad_models: [] },
    script: { language: "anim", text: 'label "Start"\nmove shapes/a by [-5,0,0] 2s\nlabel "Moved"\nwait 1s' }, drawings: { language: "draw", text: draw },
    shapes: [box("a", 0), box("b", 2), { id: "c", kind: "box", size: [2, 2, 2], position: [10, 1, 0], rotation: [0, 0, 0], color: "#cccccc" }],
    snapshots: { active: "default", items: { default: { locked: {}, hidden: {} }, "no-a": { locked: {}, hidden: { "shapes/a": true } } } }, groups: {} };
  await api(page).post("/api/projects", { data: { name: m.name, problem: m } });
  await open(page, "Poses");
  await expect(page.locator("#script .status")).toHaveText("✓", { timeout: 15_000 });
  await page.evaluate(() => { const s = (window as any).__studio; s.player.playing = false; s.player.seek(1); });
  const run = (n: string) => page.evaluate(async (n) => { const r = await (window as any).__studio.runSheet(n); return { svg: r.svg, stats: r.stats, errors: r.errors }; }, n);
  const width = (svg: string) => { const d = svg.match(/id="outline"[^>]*><path d="([^"]+)"/)![1]; const v = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((x) => Number(x[1])); return Math.max(...v) - Math.min(...v); };
  // the front view's width runs from a (left) to c (right)
  const w0 = width((await run("t0")).svg), w2 = width((await run("t2")).svg), wc = width((await run("ch")).svg);
  expect(w2 - w0).toBeCloseTo(50, 0);           // a moved 5 m left by 2 s: 50 mm wider at 1:100
  expect(wc).toBeCloseTo(w2, 1);                // at "Moved" = the end of the move
  const ws = width((await run("snap")).svg);
  expect(w0 - ws).toBeCloseTo(20, 0);           // a hidden by the snapshot: the left edge is b's, 2 m further right
  const snap = await run("snap");
  expect(snap.errors).toEqual([]);
  // the studio is as it was: time, positions, the snapshot's flags
  const st = await page.evaluate(() => { const s = (window as any).__studio; return { t: s.player.time, ax: s.built.registry.get("shapes/a").getWorldPosition(new s.THREE.Vector3()).x, hidden: JSON.stringify(s.state.hidden), active: s.store.active }; });
  expect(st.t).toBeCloseTo(1, 5); expect(st.ax).toBeCloseTo(-2.5, 3); expect(st.hidden).toBe("{}"); expect(st.active).toBe("default");
  // a quarter cut: both cut faces capped and hatched, nothing else broken
  const q = await run("q");
  expect(q.errors).toEqual([]);
  expect(q.stats["lines.hatch"]).toBeGreaterThan(30);
  // long verticals: the two outer edges, the notch's two edges and the corner where the cut faces meet
  const vert = [...q.svg.match(/id="outline"[^>]*><path d="([^"]+)"/)![1].split("M").filter(Boolean)].flatMap((pl) => {
    const p = pl.split("L").map((x) => x.trim().split(" ").map(Number)); const out: number[] = [];
    for (let i = 1; i < p.length; i++) if (Math.abs(p[i][0] - p[i - 1][0]) < 0.01 && Math.abs(p[i][1] - p[i - 1][1]) > 50) out.push(p[i][0]);
    return out; });
  expect(vert.length).toBe(5);
  // undo / redo of a drawing script change made by code
  await page.evaluate(() => (window as any).__studio.drawPanel.setText("sheet only\n  view top\n"));
  await page.waitForTimeout(600);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => page.evaluate(() => (window as any).__studio.drawPanel.text)).toBe(draw);
});
