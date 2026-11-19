// Stress test: random mixes of every booking action, checking after each step that no two
// bookings holding the venue overlap. Usage: node --no-warnings test/overlap-fuzz.mjs [rounds]
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(join(root, 'migrations')).sort()) db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
const st = (sql, a = []) => ({ bind: (...x) => st(sql, x.map(norm)), first: async () => db.prepare(sql).get(...a) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...a) }), run: async () => ({ meta: { changes: db.prepare(sql).run(...a).changes } }), _exec: () => db.prepare(sql).run(...a) });
const kv = new Map();
const env = { DB: { prepare: (s) => st(s), batch: async (l) => l.forEach((x) => x._exec()) },
  SLIPS: { put: async (k, v) => kv.set(k, v), get: async (k) => kv.get(k)?.buffer ?? null, delete: async (k) => kv.delete(k) },
  ASSETS: { fetch: async () => new Response('') }, APP_URL: 'https://a.test', PEPPER: 'p'.repeat(40), SETUP_TOKEN: 'setup-token-123456789' };
console.log = () => {};
const out = process.stdout;

const pre = async (realm, id, pw) => { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(`aveela:${realm}:${id}`), iterations: 600000 }, k, 256)).toString('base64'); };
function client(ip) {
  const jar = {};
  return async (method, path, body) => {
    const headers = { 'x-aveela': '1', origin: 'https://a.test', 'cf-connecting-ip': ip };
    if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    let payload; if (body instanceof FormData) payload = body; else if (body) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const waits = [];
    const r = await worker.fetch(new Request('https://a.test' + path, { method, headers, body: payload, redirect: 'manual' }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
}

let seed = Number(process.env.SEED || 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const adm = client('1.0.0.1');
await adm('POST', '/api/admin/setup', { token: env.SETUP_TOKEN, username: 'owner', pw: await pre('admin', 'owner', 'master-pass-123!') });
const GAP = Number(process.env.GAP || 0);
await adm('POST', '/api/admin/settings', { min_hours: 1, open_hour: 0, close_hour: 24, max_guests: 500, gap_hours: GAP });
const customers = [];
for (let i = 0; i < 3; i++) {
  const c = client('2.0.0.' + i), email = `c${i}@x.test`;
  await c('POST', '/api/auth/signup', { name: 'C' + i, email, pw: await pre('user', email, 'password-' + i) });
  db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
  customers.push(c);
}
const days = [1, 2, 3].map((n) => new Date(Date.now() + (40 + n) * 864e5).toISOString().slice(0, 10));
const HOLD = ['approved', 'slip_uploaded', 'confirmed', 'blocked'];
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function overlaps() {
  const rows = db.prepare(`SELECT id, ref, date, start_hour s, end_hour e, status FROM bookings WHERE status IN (${HOLD.map(() => '?').join(',')})`).all(...HOLD);
  const bad = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (a.date === b.date && a.s < b.e + GAP && b.s < a.e + GAP) bad.push([a, b]);
  }
  return bad;
}

const rounds = Number(process.argv[2] || 1500);
const counts = {};
for (let n = 0; n < rounds; n++) {
  // keep rate limits out of the way; they are tested elsewhere
  db.prepare('DELETE FROM rate_limits').run();
  const all = db.prepare('SELECT id, status, user_id FROM bookings').all();
  const of = (s) => all.filter((b) => s.includes(b.status));
  const slot = () => { const s = rint(0, 22); return { date: pick(days), start: s, end: rint(s + 1, Math.min(24, s + 6)) }; };
  const op = pick(['request', 'request', 'approve', 'approve', 'approveMoved', 'reschedule', 'manual', 'block', 'change', 'slip', 'adminSlip', 'confirm', 'rejectSlip', 'cancel', 'custCancel', 'expire']);
  let r = null, target = null;
  const cu = pick(customers);
  if (op === 'request') r = await cu('POST', '/api/bookings', { eventType: 'Party', guests: 10, ...slot() });
  else if (op === 'approve' && (target = pick(of(['pending'])))) r = await adm('POST', `/api/admin/bookings/${target.id}/approve`, {});
  else if (op === 'approveMoved' && (target = pick(of(['pending'])))) r = await adm('POST', `/api/admin/bookings/${target.id}/approve`, { ...slot(), guests: 10 });
  else if (op === 'reschedule' && (target = pick(of(['pending'])))) r = await adm('POST', `/api/admin/bookings/${target.id}/reschedule`, { ...slot(), guests: 10 });
  else if (op === 'manual') r = await adm('POST', '/api/admin/bookings', { name: 'Manual Guest', phone: '7770000', source: 'WhatsApp', eventType: 'Party', guests: 5, status: pick(['pending', 'approved', 'confirmed']), ...slot() });
  else if (op === 'block') r = await adm('POST', '/api/admin/blocks', slot());
  else if (op === 'change' && (target = pick(of(['pending']).filter((b) => b.user_id)))) {
    const owner = customers[db.prepare('SELECT email FROM users WHERE id = ?').get(target.user_id)?.email?.match(/c(\d)/)?.[1]];
    if (owner) r = await owner('POST', `/api/bookings/${target.id}/change`, { guests: 10, ...slot() });
  } else if (op === 'slip' && (target = pick(of(['approved']).filter((b) => b.user_id)))) {
    const owner = customers[db.prepare('SELECT email FROM users WHERE id = ?').get(target.user_id)?.email?.match(/c(\d)/)?.[1]];
    if (owner) { const fd = new FormData(); fd.append('slip', new Blob([png], { type: 'image/png' }), 's.png'); r = await owner('POST', `/api/bookings/${target.id}/slip`, fd); }
  } else if (op === 'adminSlip' && (target = pick(of(['approved', 'slip_uploaded', 'confirmed'])))) {
    const fd = new FormData(); fd.append('slip', new Blob([png], { type: 'image/png' }), 's.png'); r = await adm('POST', `/api/admin/bookings/${target.id}/slip`, fd);
  } else if (op === 'confirm' && (target = pick(of(['approved', 'slip_uploaded'])))) r = await adm('POST', `/api/admin/bookings/${target.id}/confirm`, {});
  else if (op === 'rejectSlip' && (target = pick(of(['slip_uploaded'])))) r = await adm('POST', `/api/admin/bookings/${target.id}/reject-slip`, { note: 'no' });
  else if (op === 'cancel' && (target = pick(of(['pending', 'approved', 'slip_uploaded', 'confirmed', 'blocked'])))) r = await adm('POST', `/api/admin/bookings/${target.id}/cancel`, { note: 'x' });
  else if (op === 'custCancel' && (target = pick(of(['pending', 'approved']).filter((b) => b.user_id)))) {
    const owner = customers[db.prepare('SELECT email FROM users WHERE id = ?').get(target.user_id)?.email?.match(/c(\d)/)?.[1]];
    if (owner) r = await owner('POST', `/api/bookings/${target.id}/cancel`, {});
  } else if (op === 'expire' && (target = pick(of(['approved'])))) {
    db.prepare('UPDATE bookings SET pay_by = ? WHERE id = ?').run(Date.now() - 1000, target.id);
    r = await adm('GET', '/api/admin/overview');
  }
  if (r) counts[op + ':' + r.status] = (counts[op + ':' + r.status] || 0) + 1;
  if (r && r.status >= 500) { out.write(`\nSERVER ERROR on ${op}: ${JSON.stringify(r.data)}\n`); process.exit(1); }
  const bad = overlaps();
  if (bad.length) { out.write(`\nOVERLAP after step ${n} (${op} on ${target ? target.id : 'new'}): ${JSON.stringify(bad[0])}\n`); process.exit(1); }
}
const held = db.prepare(`SELECT COUNT(*) n FROM bookings WHERE status IN ('approved','slip_uploaded','confirmed','blocked')`).get().n;
out.write(`No overlaps in ${rounds} random steps (${db.prepare('SELECT COUNT(*) n FROM bookings').get().n} bookings, ${held} holding hours).\n`);
out.write(Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join('  ') + '\n');
