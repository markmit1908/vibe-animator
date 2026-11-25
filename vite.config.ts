import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const SNAP = 'scenes/snapshots.yaml';
const LEGACY = 'scenes/state.yaml';

/**
 * GET/POST /__snapshots – named model snapshots (part flags, camera, placements)
 * stored in scenes/snapshots.yaml. On first use, scenes/state.yaml becomes snapshot "default".
 */
function snapshots(): Plugin {
  return {
    name: 'snapshots',
    configureServer(server) {
      server.watcher.unwatch([SNAP, LEGACY]); // saving must not trigger a reload
      server.middlewares.use('/__snapshots', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            writeFileSync(SNAP, '# Model snapshots – written by the viewer (Save). Safe to edit by hand.\n' + stringify(JSON.parse(body)));
            res.end('ok');
          });
          return;
        }
        let data: any;
        if (existsSync(SNAP)) data = parse(readFileSync(SNAP, 'utf8'));
        else {
          const legacy = existsSync(LEGACY) ? parse(readFileSync(LEGACY, 'utf8')) ?? {} : {};
          data = { active: 'default', snapshots: { default: { locked: legacy.locked ?? {}, hidden: legacy.hidden ?? {} } } };
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data ?? {}));
      });
    },
  };
}

// es2022 for top-level await (CAD is loaded before the script compiles)
export default defineConfig({
  plugins: [snapshots()],
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
