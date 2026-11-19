// Local preview without Cloudflare: runs the Worker on http://localhost:8787 with an in-memory database.
// Usage: node --no-warnings test/serve.mjs   (Node 22.5+). For real local dev use `npx wrangler dev`.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
const migrations = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
for (const f of migrations) db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a.map(norm)),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
  _exec: () => db.prepare(sql).run(...args),
});
const DB = { prepare: (s) => stmt(s), batch: async (l) => { db.exec('BEGIN'); try { l.forEach((s) => s._exec()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } } };
const kv = new Map();
const SLIPS = { put: async (k, v) => kv.set(k, v), get: async (k) => (kv.has(k) ? kv.get(k).buffer : null), delete: async (k) => kv.delete(k) };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
const ASSETS = { fetch: async (req) => {
  let p = new URL(req.url).pathname;
  if (p === '/') p = '/index.html'; else if (!extname(p)) p += '.html';
  const f = join(root, 'public', p);
  if (!existsSync(f)) return new Response(readFileSync(join(root, 'public/404.html')), { status: 404, headers: { 'content-type': types['.html'] } });
  return new Response(readFileSync(f), { headers: { 'content-type': types[extname(f)] || 'application/octet-stream' } });
} };
const PORT = Number(process.env.PORT || 8787);
const env = { DB, SLIPS, ASSETS, APP_URL: `http://localhost:${PORT}`, MAIL_FROM: 'Aveela <test@example.com>', VENUE_TZ: 'Indian/Maldives',
  SERVER_HASH_ITERATIONS: '20000', PEPPER: 'local-preview-pepper-'.padEnd(64, 'x'), SETUP_TOKEN: process.env.SETUP_TOKEN || 'local-setup-token-123' };
globalThis.__db = db;

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body, redirect: 'manual' });
  const waits = [];
  const r = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p) });
  const out = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
  const sc = r.headers.getSetCookie(); if (sc.length) out['set-cookie'] = sc;
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
  await Promise.all(waits);
}).listen(PORT, () => console.log(`Aveela preview on http://localhost:${PORT}  (setup token: ${env.SETUP_TOKEN})`));
