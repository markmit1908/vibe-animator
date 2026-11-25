import { defineConfig } from 'vite';

// es2022 for top-level await (CAD is loaded before the script compiles)
export default defineConfig({
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
