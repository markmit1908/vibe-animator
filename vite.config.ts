import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const STATE = 'scenes/state.yaml';

/** GET/POST /__state – persists part lock/hide flags from the assembly tree to scenes/state.yaml. */
function partState(): Plugin {
  return {
    name: 'part-state',
    configureServer(server) {
      server.watcher.unwatch(STATE); // saving must not trigger a reload
      server.middlewares.use('/__state', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const s = JSON.parse(body);
            const sorted = (o: Record<string, boolean>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
            writeFileSync(STATE, '# Written by the assembly tree (lock / hide). Safe to edit by hand.\n' +
              stringify({ locked: sorted(s.locked ?? {}), hidden: sorted(s.hidden ?? {}) }));
            res.end('ok');
          });
          return;
        }
        const s = existsSync(STATE) ? parse(readFileSync(STATE, 'utf8')) ?? {} : {};
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ locked: s.locked ?? {}, hidden: s.hidden ?? {} }));
      });
    },
  };
}

// es2022 for top-level await (CAD is loaded before the script compiles)
export default defineConfig({
  plugins: [partState()],
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
