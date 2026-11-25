import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

// ---------- minimal zip (deflate) writer / reader – enough for project archives ----------
function zipWrite(files: { name: string; data: Buffer }[]) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), comp = deflateRawSync(f.data), crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function zipRead(buf: Buffer) {
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('not a zip file');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(ds, ds + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const SNAP = 'scenes/snapshots.yaml';

/** Restore a project's text files (backing up the current ones). Returns the backup folder. */
function applyProject(p: any) {
  if (p?.format !== 'refuel-project') throw new Error('not a refuel project file');
  const name = String(p.script?.name ?? '');
  if (name && !/^[\w.-]+\.anim$/.test(name)) throw new Error('bad script name');
  const dir = `data/backups/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(dir, { recursive: true });
  const files = ['scenes/core.yaml', SNAP, ...(name ? [`scripts/${name}`, `scripts/${name.replace(/\.anim$/, '')}.chat.json`] : [])];
  for (const f of files) if (existsSync(f)) copyFileSync(f, `${dir}/${f.replace(/\//g, '__')}`);
  if (typeof p.core === 'string') writeFileSync('scenes/core.yaml', p.core);
  if (p.snapshots) writeFileSync(SNAP, '# Model snapshots – written by the viewer (Save). Safe to edit by hand.\n' + stringify(p.snapshots));
  if (name && typeof p.script.text === 'string') writeFileSync(`scripts/${name}`, p.script.text);
  if (name && Array.isArray(p.chat)) writeFileSync(`scripts/${name.replace(/\.anim$/, '')}.chat.json`, JSON.stringify(p.chat, null, 1));
  return dir;
}
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
      // GET /__project?script=x.anim – the project's text files (export); POST – restore them (import, with a backup)
      server.middlewares.use('/__project', (req, res) => {
        const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            let p: any;
            try { p = JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
            try { const dir = applyProject(p); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, backup: dir })); }
            catch (e: any) { res.statusCode = 400; res.end(e.message); }
          });
          return;
        }
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('script') ?? '';
        const ok = /^[\w.-]+\.anim$/.test(name);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          core: read('scenes/core.yaml'),
          script: ok ? { name, text: read(`scripts/${name}`) ?? '' } : null,
          chat: ok ? JSON.parse(read(`scripts/${name.replace(/\.anim$/, '')}.chat.json`) ?? '[]') : [],
        }));
      });
      // POST /__zip – body: project JSON → zip of project.json + the CAD .glb files it references
      server.middlewares.use('/__zip', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          try {
            if (req.method === 'PUT') {                        // import a project zip
              const files = zipRead(buf);
              const pj = files.get('project.json');
              if (!pj) throw new Error('project.json missing from the zip');
              const p = JSON.parse(pj.toString('utf8'));
              const cad: string[] = [];
              for (const [name, data] of files) {
                const m = name.match(/^cad\/([\w.-]+\.glb)$/);
                if (!m) continue;
                if (data.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${name} is not a .glb`);
                mkdirSync('public/cad', { recursive: true });
                const target = `public/cad/${m[1]}`;
                if (existsSync(target)) { mkdirSync('data/backups/cad', { recursive: true }); copyFileSync(target, `data/backups/cad/${Date.now()}-${m[1]}`); }
                writeFileSync(target, data); cad.push(m[1]);
              }
              const dir = applyProject(p);
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: true, backup: dir, cad, project: { view: p.view, working: p.working, cad: p.cad } }));
              return;
            }
            const p = JSON.parse(buf.toString('utf8'));         // export
            const files = [{ name: 'project.json', data: Buffer.from(JSON.stringify(p, null, 1)) }];
            for (const c of p.cad ?? []) {
              const f = `public/${c.file}`;
              if (/^cad\/[\w.-]+\.glb$/.test(c.file) && existsSync(f)) files.push({ name: c.file, data: readFileSync(f) });
            }
            res.setHeader('content-type', 'application/zip');
            res.end(zipWrite(files));
          } catch (e: any) { res.statusCode = 400; res.end(String(e.message ?? e)); }
        });
      });
      // POST /__cad?name=x.glb – (re)import a converted CAD model into public/cad/
      server.middlewares.use('/__cad', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (req.method !== 'POST' || !/^[\w.-]+\.glb$/.test(name)) { res.statusCode = 400; res.end('POST a .glb with ?name=x.glb'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'glTF') { res.statusCode = 400; res.end('not a binary glTF (.glb) file'); return; }
          mkdirSync('public/cad', { recursive: true });
          writeFileSync(`public/cad/${name}`, buf);
          res.end('ok');
        });
      });
      // GET/POST /__chat?name=x.anim – the assist conversation, saved beside the script as x.chat.json
      server.middlewares.use('/__chat', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!/^[\w.-]+\.anim$/.test(name)) { res.statusCode = 400; res.end('bad name'); return; }
        const file = `scripts/${name.replace(/\.anim$/, '')}.chat.json`;
        server.watcher.unwatch(file);
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            try { JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
            writeFileSync(file, body); res.end('ok');
          });
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(existsSync(file) ? readFileSync(file, 'utf8') : '[]');
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
