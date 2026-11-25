import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RefuelAnim end to end (e2e/): its server on a fresh vault and Vite proxying /api to it, as `npm run dev` runs them.
// E2E_PORT: the page; the API on E2E_PORT + 1000.
const port = Number(process.env.E2E_PORT ?? 5173);
const api = port + 1000;
export default defineConfig({
  testDir: "e2e",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: [
    {
      command: `.venv/bin/python -m uvicorn refuelanim_server.app:app --host 127.0.0.1 --port ${api} --app-dir server`,
      url: `http://127.0.0.1:${api}/api/about`,
      env: { REFUELANIM_PROJECTS: mkdtempSync(join(tmpdir(), "refuelanim-e2e-")) },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}`,
      env: { SOLVERKIT_DEV_API: `http://127.0.0.1:${api}` },
      reuseExistingServer: false,
    },
  ],
});
