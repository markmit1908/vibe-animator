import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// RefuelAnim's frontend. Under `npm run dev` (@solverkit/dev) SOLVERKIT_DEV_API is its server and /api goes to it.
// The SolverKit packages' peers are one copy (this app's) even when the packages are linked from a checkout.
// `process` typed here: the template has no @types/node (it came with @anthropic-ai/sdk, dropped in D8).
declare const process: { env: Record<string, string | undefined> };
const api = process.env.SOLVERKIT_DEV_API;
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom", "sonner", "@base-ui/react", "lucide-react", "katex", "marked"] },
  server: { port: 5174, fs: { allow: [".."] }, ...(api ? { proxy: { "/api": { target: api, changeOrigin: true } } } : {}) },
});
