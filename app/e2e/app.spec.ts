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
  const input = await box("#assist .input"), footer = await box("footer");
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
