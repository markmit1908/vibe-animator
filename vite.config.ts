import { defineConfig, loadEnv, type Plugin } from 'vite';
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
      // GET/POST /__script?name=x.anim – the Script panel's file in scripts/
      server.middlewares.use('/__script', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!/^[\w.-]+\.anim$/.test(name)) { res.statusCode = 400; res.end('bad name'); return; }
        const file = `scripts/${name}`;
        server.watcher.unwatch(file); // the panel owns this file; saving must not reload the page
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => { writeFileSync(file, body); res.end('ok'); });
          return;
        }
        if (!existsSync(file)) { res.statusCode = 404; res.end(''); return; }
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(readFileSync(file, 'utf8'));
      });
    },
  };
}

/**
 * /__assist – proxy for the AI assist panel. The page's SDK client points its baseURL here with a
 * placeholder key; this adds the real key from .env (ANTHROPIC_API_KEY, server-side only – never
 * prefixed VITE_) and streams the response back. GET /__assist/status says whether a key is set.
 */
function assistProxy(apiKey: string | undefined): Plugin {
  return {
    name: 'assist-proxy',
    configureServer(server) {
      server.middlewares.use('/__assist', async (req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (path === '/status') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ enabled: !!apiKey }));
          return;
        }
        if (!apiKey) { res.statusCode = 503; res.end(JSON.stringify({ type: 'error', error: { type: 'no_key', message: 'No ANTHROPIC_API_KEY in .env' } })); return; }
        if (!path.startsWith('/v1/messages') || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const fwd: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': apiKey };
        for (const h of ['anthropic-version', 'anthropic-beta', 'accept']) {
          const v = req.headers[h]; if (typeof v === 'string') fwd[h] = v;
        }
        const ac = new AbortController();
        req.on('close', () => { if (!res.writableEnded) ac.abort(); }); // Stop in the panel cancels upstream
        try {
          const up = await fetch(`https://api.anthropic.com${path}`, { method: 'POST', headers: fwd, body: Buffer.concat(chunks), signal: ac.signal });
          res.statusCode = up.status;
          for (const h of ['content-type', 'request-id', 'retry-after', 'x-should-retry']) { const v = up.headers.get(h); if (v) res.setHeader(h, v); }
          if (!up.body) { res.end(); return; }
          for await (const chunk of up.body as any) res.write(chunk);
          res.end();
        } catch (e: any) {
          if (!res.headersSent) res.statusCode = 502;
          res.end(ac.signal.aborted ? '' : JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(e?.message ?? e) } }));
        }
      });
    },
  };
}

/** Server-side key lookup. Prefer ANTHROPIC_API_KEY: VITE_-prefixed variables can reach browser code. */
function assistKey(env: Record<string, string>) {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  if (env.VITE_ANTHROPIC_API_KEY) {
    console.warn('[assist] Using VITE_ANTHROPIC_API_KEY – rename it to ANTHROPIC_API_KEY in .env so Vite never exposes it to the page.');
    return env.VITE_ANTHROPIC_API_KEY;
  }
  return undefined;
}

// es2022 for top-level await (CAD is loaded before the script compiles)
export default defineConfig(({ mode }) => ({
  plugins: [snapshots(), assistProxy(assistKey(loadEnv(mode, process.cwd(), '')))],
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
}));
