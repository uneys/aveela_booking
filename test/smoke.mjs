// End-to-end smoke test: runs the real Worker against an in-memory SQLite stand-in for D1.
// Usage: node --no-warnings test/smoke.mjs   (Node 22.5+)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- D1 shim ----------
function d1(db) {
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(norm)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec('BEGIN'); try { for (const s of list) s._exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; },
  };
}
const db = new DatabaseSync(':memory:');
const migrations = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
for (const f of migrations) db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));

const kv = new Map();
const SLIPS = {
  put: async (k, v) => kv.set(k, v),
  get: async (k) => (kv.has(k) ? kv.get(k).buffer : null),
  delete: async (k) => kv.delete(k),
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
const ASSETS = {
  fetch: async (req) => {
    let p = new URL(req.url).pathname;
    if (p === '/') p = '/index.html';
    else if (!extname(p)) p += '.html';
    const f = join(root, 'public', p);
    if (!existsSync(f)) return new Response('Not found', { status: 404 });
    return new Response(readFileSync(f), { headers: { 'content-type': types[extname(f)] || 'application/octet-stream' } });
  },
};

const env = {
  DB: d1(db), SLIPS, ASSETS, APP_URL: 'https://aveela.test', MAIL_FROM: 'Aveela <a@b.c>', VENUE_TZ: 'Indian/Maldives',
  SERVER_HASH_ITERATIONS: '20000', PEPPER: 'p'.repeat(64), SETUP_TOKEN: 'setup-token-123456789',
};

// Capture "emails" (logged because RESEND_API_KEY is unset).
const mails = [];
const origLog = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[email not sent')) mails.push(s); else origLog(...a); };

// ---------- client ----------
async function prehash(realm, id, password) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(`aveela:${realm}:${id.trim().toLowerCase()}`), iterations: 600000 }, k, 256);
  return Buffer.from(bits).toString('base64');
}

function client(ip = '1.1.1.1') {
  const jar = {};
  return async function call(method, path, body, extra = {}) {
    const headers = { 'cf-connecting-ip': ip, origin: 'https://aveela.test', 'x-aveela': '1', ...extra.headers };
    const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) headers.cookie = cookieStr;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const waits = [];
    const res = await worker.fetch(new Request('https://aveela.test' + path, { method, headers, body: payload, redirect: 'manual' }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v;
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : null;
    return { status: res.status, data, res };
  };
}

let passed = 0;
function ok(cond, msg) { if (!cond) { origLog('FAIL:', msg); process.exit(1); } passed++; origLog('  ok', msg); }
const linkFrom = (re) => { for (let i = mails.length - 1; i >= 0; i--) { const m = mails[i].match(re); if (m) return m[1]; } return null; };

const day = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

// ---------- run ----------
origLog('Pages');
const anon = client('9.9.9.9');
let r = await anon('GET', '/');
ok(r.status === 200 && r.res.headers.get('content-security-policy')?.includes("script-src 'self'"), 'home page served with CSP');
r = await anon('GET', '/api/config');
ok(r.data.openHour === 8 && r.data.googleEnabled === false, 'config endpoint');
r = await anon('POST', '/api/auth/login', { email: 'a@b.co', pw: 'x' }, { headers: { 'x-aveela': '' } });
ok(r.status === 403, 'POST without custom header is blocked (CSRF)');

origLog('Admin setup');
const adm = client('2.2.2.2');
r = await adm('GET', '/api/admin/state');
ok(r.data.needsSetup === true, 'needs setup');
r = await adm('POST', '/api/admin/setup', { token: 'wrong', username: 'owner', pw: await prehash('admin', 'owner', 'master-pass-123!') });
ok(r.status === 403, 'wrong setup token refused');
r = await adm('POST', '/api/admin/setup', { token: env.SETUP_TOKEN, username: 'owner', name: 'Owner', pw: await prehash('admin', 'owner', 'master-pass-123!') });
ok(r.status === 201 && r.data.admin.isMaster, 'master admin created');
r = await adm('POST', '/api/admin/setup', { token: env.SETUP_TOKEN, username: 'owner2', pw: await prehash('admin', 'owner2', 'x'.repeat(12)) });
ok(r.status === 409, 'setup cannot run twice');
const stored = db.prepare('SELECT password_hash FROM admins').get().password_hash;
ok(/^v1\$20000\$/.test(stored), 'admin hash stored as v1$20000$salt$hash');
r = await adm('POST', '/api/admin/settings', { bank_name: 'Bank of Maldives', account_name: 'Aveela Pvt Ltd', account_number: '7730000123456', hourly_rate: 3000, notify_email: 'owner@aveela.test' });
ok(r.data.settings.hourly_rate === 3000, 'master updates settings');

origLog('Customer signup');
const cust = client('3.3.3.3');
r = await cust('POST', '/api/auth/signup', { name: 'Aisha', email: 'Aisha@Example.com', pw: await prehash('user', 'aisha@example.com', 'customer-pass-1') });
ok(r.status === 201 && r.data.user.verified === false, 'signup creates unverified account and signs in');
r = await cust('POST', '/api/bookings', { eventType: 'Birthday', date: day, start: 10, end: 14, guests: 50 });
ok(r.status === 403, 'unverified user cannot book');
const vtoken = linkFrom(/auth\/verify\?token=([\w-]+)/);
r = await cust('GET', `/auth/verify?token=${vtoken}`);
ok(r.status === 302 && r.res.headers.get('location') === '/account?verified=1', 'email verification link works');
r = await cust('GET', `/auth/verify?token=${vtoken}`);
ok(r.res.headers.get('location') === '/account?verify=expired', 'verification link is single use');

origLog('Availability and booking');
r = await cust('POST', '/api/bookings', { eventType: 'Birthday', date: day, start: 10, end: 11, guests: 50 });
ok(r.status === 400 && /minimum/.test(r.data.error), 'minimum hours enforced');
r = await cust('POST', '/api/bookings', { eventType: 'Birthday', date: day, start: 10, end: 14, guests: 50, notes: 'Balloon arch' });
ok(r.status === 201 && r.data.booking.status === 'pending' && r.data.booking.amount === 12000, 'request created, priced 4h x 3000');
const bid = r.data.booking.id;
ok(mails.some((m) => m.includes('owner@aveela.test') && m.includes('New booking request')), 'vendor notified of new request');
r = await anon('GET', `/api/availability?month=${day.slice(0, 7)}`);
ok(JSON.stringify(r.data.days[day].requested) === '[[10,14]]' && r.data.days[day].booked.length === 0, 'availability shows pending as requested');
ok(!JSON.stringify(r.data).includes('Aisha'), 'availability does not leak customer data');

const other = client('4.4.4.4');
await other('POST', '/api/auth/signup', { name: 'Ben', email: 'ben@example.com', pw: await prehash('user', 'ben@example.com', 'ben-password-1') });
await other('GET', `/auth/verify?token=${linkFrom(/auth\/verify\?token=([\w-]+)/)}`);
r = await other('POST', '/api/bookings', { eventType: 'Corporate', date: day, start: 12, end: 16, guests: 20 });
ok(r.status === 201, 'overlapping pending requests are allowed (vendor decides)');
const bid2 = r.data.booking.id;
r = await other('GET', `/api/bookings/${bid}/slip`);
ok(r.status === 404, "a customer can't see another customer's booking");

origLog('Vendor approval');
r = await adm('GET', `/api/admin/bookings/${bid}`);
ok(r.data.clashes.length === 1 && r.data.clashes[0].id === bid2, 'admin sees the clashing request');
r = await adm('POST', `/api/admin/bookings/${bid}/approve`, { amount: 11000, note: 'Includes setup time' });
ok(r.data.booking.status === 'approved' && r.data.booking.amount === 11000 && r.data.booking.payBy, 'approved with custom amount and deadline');
ok(mails.some((m) => m.includes('aisha@example.com') && m.includes('Approved') && m.includes('7730000123456')), 'approval email has bank details');
r = await adm('POST', `/api/admin/bookings/${bid2}/approve`, {});
ok(r.status === 409, 'approving a clashing request is refused');
r = await other('POST', '/api/bookings', { eventType: 'Corporate', date: day, start: 13, end: 15, guests: 20 });
ok(r.status === 409, 'new requests over approved hours are refused');
r = await anon('GET', `/api/availability?month=${day.slice(0, 7)}`);
ok(JSON.stringify(r.data.days[day].booked) === '[[10,14]]', 'approved hours show as booked');

origLog('Bank slip');
const fd = new FormData();
fd.append('slip', new Blob([new Uint8Array([0x3c, 0x73, 0x76, 0x67])], { type: 'image/png' }), 'x.png');
r = await cust('POST', `/api/bookings/${bid}/slip`, fd);
ok(r.status === 400, 'non-image disguised as PNG is rejected');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fd2 = new FormData(); fd2.append('slip', new Blob([png], { type: 'image/png' }), 'slip.png');
r = await cust('POST', `/api/bookings/${bid}/slip`, fd2);
ok(r.data.booking.status === 'slip_uploaded' && r.data.booking.hasSlip, 'slip uploaded');
r = await adm('GET', `/api/admin/bookings/${bid}/slip`);
ok(r.status === 200 && r.res.headers.get('content-type') === 'image/png' && r.res.headers.get('content-security-policy').includes('sandbox'), 'admin can view slip, sandboxed');
r = await adm('POST', `/api/admin/bookings/${bid}/reject-slip`, { note: 'Amount does not match' });
ok(r.data.booking.status === 'approved', 'slip rejected sends booking back to awaiting payment');
const fd3 = new FormData(); fd3.append('slip', new Blob([png], { type: 'image/png' }), 'slip.png');
await cust('POST', `/api/bookings/${bid}/slip`, fd3);
r = await adm('POST', `/api/admin/bookings/${bid}/confirm`, { note: 'See you there' });
ok(r.data.booking.status === 'confirmed', 'vendor confirms payment');
ok(mails.some((m) => m.includes('aisha@example.com') && m.includes('Confirmed')), 'confirmation email sent');
r = await cust('POST', `/api/bookings/${bid}/cancel`, {});
ok(r.status === 409, 'customer cannot cancel a confirmed booking online');

origLog('Admin users and security');
r = await adm('POST', '/api/admin/admins', { username: 'staff', name: 'Staff', pw: await prehash('admin', 'staff', 'temporary-pass-1') });
ok(r.status === 201 && r.data.admin.mustChange, 'master adds an admin with a temporary password');
const staffId = r.data.admin.id;
const staff = client('5.5.5.5');
r = await staff('POST', '/api/admin/login', { username: 'staff', pw: await prehash('admin', 'staff', 'temporary-pass-1') });
ok(r.status === 200 && r.data.admin.mustChange, 'staff signs in');
r = await staff('GET', '/api/admin/bookings?status=pending');
ok(r.status === 403, 'staff must change password before doing anything');
r = await staff('POST', '/api/admin/password', { current: await prehash('admin', 'staff', 'temporary-pass-1'), next: await prehash('admin', 'staff', 'my-own-strong-pass') });
ok(r.status === 200, 'staff changes password');
r = await staff('GET', '/api/admin/bookings?status=pending');
ok(r.status === 200 && r.data.bookings.length === 1, 'staff can now see requests');
r = await staff('GET', '/api/admin/admins');
ok(r.status === 403, 'staff cannot manage admins');
r = await staff('POST', '/api/admin/settings', { hourly_rate: 1 });
ok(r.status === 403, 'staff cannot change settings');
r = await adm('POST', `/api/admin/admins/${staffId}/update`, { active: false });
ok(!r.data.admin.active, 'master disables staff');
r = await staff('GET', '/api/admin/bookings');
ok(r.status === 401, "disabled admin's session stops working");

const attacker = client('6.6.6.6');
let last;
for (let i = 0; i < 6; i++) last = await attacker('POST', '/api/admin/login', { username: 'owner', pw: await prehash('admin', 'owner', 'guess' + i) });
ok(last.status === 429, 'admin login locks after 5 wrong passwords');
const attacker2 = client('7.7.7.7');
r = await attacker2('POST', '/api/admin/login', { username: 'owner', pw: await prehash('admin', 'owner', 'master-pass-123!') });
ok(r.status === 429, 'lock is per account too, even with the right password from a new IP');

origLog('Password reset');
r = await anon('POST', '/api/auth/forgot', { email: 'nobody@example.com' });
ok(r.status === 200, 'forgot password gives the same answer for unknown emails');
await anon('POST', '/api/auth/forgot', { email: 'ben@example.com' });
const rtoken = linkFrom(/account\?reset=([\w-]+)/);
r = await anon('GET', `/api/auth/reset-info?token=${rtoken}`);
ok(r.data.email === 'ben@example.com', 'reset link resolves email');
r = await anon('POST', '/api/auth/reset', { token: rtoken, pw: await prehash('user', 'ben@example.com', 'new-ben-pass') });
ok(r.status === 200, 'password reset');
const ben2 = client('8.8.8.8');
r = await ben2('POST', '/api/auth/login', { email: 'ben@example.com', pw: await prehash('user', 'ben@example.com', 'new-ben-pass') });
ok(r.status === 200, 'sign in with new password');

origLog('Blocks and expiry');
r = await adm('POST', '/api/admin/blocks', { date: day, start: 18, end: 22, reason: 'Phone booking' });
ok(r.status === 201, 'admin blocks hours');
r = await other('GET', '/api/me');
ok(r.data.user === null, 'password reset signed out old sessions');
r = await ben2('POST', '/api/bookings', { eventType: 'Party', date: day, start: 19, end: 21, guests: 10 });
ok(r.status === 409, 'blocked hours cannot be requested');
const ev = client('8.8.4.4');
await ev('POST', '/api/auth/signup', { name: 'Cara', email: 'cara@example.com', pw: await prehash('user', 'cara@example.com', 'cara-password') });
await ev('GET', `/auth/verify?token=${linkFrom(/auth\/verify\?token=([\w-]+)/)}`);
r = await ev('POST', '/api/bookings', { eventType: 'Party', date: day, start: 8, end: 10, guests: 10 });
await adm('POST', `/api/admin/bookings/${r.data.booking.id}/approve`, {});
db.prepare('UPDATE bookings SET pay_by = ? WHERE id = ?').run(Date.now() - 1000, r.data.booking.id);
r = await anon('GET', `/api/availability?month=${day.slice(0, 7)}`);
ok(!JSON.stringify(r.data.days[day].booked).includes('[8,10]'), 'unpaid approval expires and frees the hours');

origLog('Google and Apple sign-in (provider servers stubbed)');
const fakeJwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
Object.assign(env, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', APPLE_CLIENT_ID: 'com.aveela.web', APPLE_TEAM_ID: 'TEAM', APPLE_KEY_ID: 'KEY',
  APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----` });
let nextClaims, sentSecret;
globalThis.fetch = async (u, init) => {
  if (String(u).includes('appleid.apple.com/auth/token')) sentSecret = new URLSearchParams(init.body).get('client_secret');
  return new Response(JSON.stringify({ id_token: fakeJwt(nextClaims) }), { headers: { 'content-type': 'application/json' } });
};
r = await anon('GET', '/api/config');
ok(r.data.googleEnabled && r.data.appleEnabled, 'both providers enabled once keys are set');
const g = client('10.0.0.1');
r = await g('GET', '/auth/google?next=/account');
const gq = new URL(r.res.headers.get('location')).searchParams;
ok(gq.get('code_challenge_method') === 'S256' && gq.get('state'), 'Google redirect uses state + PKCE');
nextClaims = { iss: 'https://accounts.google.com', aud: 'gid', exp: Date.now() / 1000 + 600, nonce: 'wrong', sub: 'g-1', email: 'aisha@example.com', email_verified: true, name: 'Aisha' };
r = await g('GET', `/auth/google/callback?state=${gq.get('state')}&code=abc`);
ok(r.res.headers.get('location').startsWith('/account?oauth=failed'), 'Google token with wrong nonce is rejected');
r = await g('GET', '/auth/google?next=/account');
const gq2 = new URL(r.res.headers.get('location')).searchParams;
nextClaims.nonce = gq2.get('nonce');
r = await g('GET', `/auth/google/callback?state=wrongstate&code=abc`);
ok(r.res.headers.get('location').startsWith('/account?oauth=failed'), 'Google callback with wrong state is rejected');
r = await g('GET', '/auth/google?next=/account');
const gq3 = new URL(r.res.headers.get('location')).searchParams;
nextClaims.nonce = gq3.get('nonce');
r = await g('GET', `/auth/google/callback?state=${gq3.get('state')}&code=abc`);
ok(r.status === 302 && r.res.headers.get('location') === '/account', 'Google sign-in succeeds');
r = await g('GET', '/api/me');
ok(r.data.user.email === 'aisha@example.com' && r.data.user.google && r.data.user.hasPassword, 'Google linked to the existing email account');

const ap = client('10.0.0.2');
r = await ap('GET', '/auth/apple');
const aq = new URL(r.res.headers.get('location')).searchParams;
ok(aq.get('response_mode') === 'form_post', 'Apple redirect uses form_post');
const cookieLine = r.res.headers.getSetCookie()[0];
ok(/SameSite=None/.test(cookieLine), 'Apple state cookie is SameSite=None for the cross-site POST');
const savedNonce = JSON.parse(decodeURIComponent(cookieLine.split(';')[0].split('=').slice(1).join('='))).nonce;
const hashed = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(savedNonce))).toString('base64url');
nextClaims = { iss: 'https://appleid.apple.com', aud: 'com.aveela.web', exp: Date.now() / 1000 + 600, nonce: hashed, sub: 'apple-1', email: 'new@privaterelay.appleid.com', email_verified: 'true' };
const form = new FormData(); form.append('state', aq.get('state')); form.append('code', 'xyz'); form.append('user', JSON.stringify({ name: { firstName: 'Dana', lastName: 'Ali' } }));
r = await ap('POST', '/auth/apple/callback', form, { headers: { origin: 'https://appleid.apple.com', 'x-aveela': '' } });
ok(r.status === 303 && r.res.headers.get('location') === '/account', 'Apple sign-in succeeds via cross-site POST');
const [h, pl, sig] = sentSecret.split('.');
const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(h + '.' + pl));
ok(valid && JSON.parse(Buffer.from(pl, 'base64url')).sub === 'com.aveela.web', 'Apple client_secret is a valid ES256 JWT');
r = await ap('GET', '/api/me');
ok(r.data.user.name === 'Dana Ali' && r.data.user.verified && r.data.user.apple, 'new Apple account created with name, verified');

origLog('Cloudflare Pages entry points');
const pagesApi = (await import('../functions/api/[[path]].js')).onRequest;
const pagesAuth = (await import('../functions/auth/[[path]].js')).onRequest;
const pctx = (path) => ({ request: new Request('https://aveela.test' + path, { redirect: 'manual' }), env, waitUntil: () => {} });
r = await pagesApi(pctx('/api/config'));
ok(r.status === 200 && (await r.json()).openHour === 8, 'Pages function serves /api/*');
r = await pagesApi(pctx('/api/health'));
ok((await r.json()).checks.tables === true, 'Pages health check reports tables present');
r = await pagesAuth(pctx('/auth/verify?token=nope'));
ok(r.status === 302 && r.headers.get('location') === '/account?verify=expired', 'Pages function serves /auth/*');

origLog(`\nAll ${passed} checks passed.`);
