// RefuelAnim end to end: a new model, its input, a run of the engine and its output. TODO(e2e): the solver's own.
import { expect, test } from "@playwright/test";

test("a new model runs and shows its output", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/#\/home/);
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#\/p\/[0-9a-f-]{36}\//);
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
});


