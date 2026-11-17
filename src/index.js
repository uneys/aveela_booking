// Aveela Event Space: Cloudflare Worker entry point.
// Serves the static site from /public and the booking API under /api and /auth.
import { HttpError, json, assertSameOrigin, withSecurityHeaders } from './lib/http.js';
import { expireUnpaid, now } from './lib/core.js';
import { handleAuth } from './routes/auth.js';
import { handleBookings } from './routes/bookings.js';
import { handleAdmin } from './routes/admin.js';
import { emailProvider } from './lib/email.js';

const DASH = 'Cloudflare dashboard → Workers & Pages → aveela → Settings';
const BIND = 'Cloudflare dashboard → Workers & Pages → aveela → Settings → Bindings';

// Configuration problems that stop the API from working, in plain words.
function setupProblem(env) {
  if (!env.DB) return `Server setup is incomplete: the D1 database is not connected. On Pages: add a D1 binding named DB in ${BIND}, then redeploy. On Workers: check database_id in wrangler.jsonc.`;
  if (!env.SLIPS) return `Server setup is incomplete: the KV namespace is not connected. On Pages: add a KV binding named SLIPS in ${BIND}, then redeploy. On Workers: check the kv_namespaces id in wrangler.jsonc.`;
  if (!env.APP_URL) return `Server setup is incomplete: add the variable APP_URL (your site address, e.g. https://aveela.pages.dev) in ${DASH} → Variables and Secrets, then redeploy.`;
  if (!env.PEPPER || env.PEPPER.length < 32) return `Server setup is incomplete: add the PEPPER secret (at least 32 characters) in ${DASH} → Variables and Secrets, with type "Secret".`;
  return '';
}

// GET /api/health: which parts are set up. Shows only yes/no, never secret values.
async function health(env, url) {
  const checks = {
    database: !!env.DB, slipStorage: !!env.SLIPS, pepper: !!(env.PEPPER && env.PEPPER.length >= 32),
    appUrl: env.APP_URL || null, appUrlMatches: !!env.APP_URL && env.APP_URL.replace(/\/+$/, '') === url.origin,
    tables: false, email: emailProvider(env), google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    apple: !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
  };
  const problems = [];
  if (env.DB) {
    try { await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first(); checks.tables = true; }
    catch { problems.push('Database tables are missing. Paste migrations/0001_initial.sql into the D1 console (Storage & databases → D1 → aveela → Console) and run it.'); }
  }
  const p = setupProblem(env); if (p) problems.unshift(p);
  if (env.APP_URL && !checks.appUrlMatches) problems.push(`APP_URL in wrangler.jsonc is ${env.APP_URL} but this site is ${url.origin}. Links in emails and Google/Apple sign-in need them to match.`);
  if (!checks.email) problems.push('Emails are not being sent: add the GMAIL_USER and GMAIL_APP_PASSWORD secrets (or RESEND_API_KEY). See README section 2.');
  return json({ ok: problems.filter((x) => !x.startsWith('Emails')).length === 0, checks, problems });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const isApi = path.startsWith('/api/');
  const isAuth = path.startsWith('/auth/') || path === '/auth';

  if (isApi || isAuth) {
    if (path === '/api/health') return withSecurityHeaders(await health(env, url), { noindex: true });
    const missing = setupProblem(env);
    if (missing) return withSecurityHeaders(json({ error: missing, code: 'setup' }, 500), { noindex: true });
    // JSON API mutations must come from our own pages. /auth/* are browser redirects (and Apple's
    // cross-site form POST), protected by their state cookies instead.
    if (isApi && request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request, url);
    const res =
      (await handleAuth(request, env, ctx, url, path)) ||
      (await handleBookings(request, env, ctx, url, path)) ||
      (await handleAdmin(request, env, ctx, url, path));
    if (res) return withSecurityHeaders(res, { noindex: true });
    return withSecurityHeaders(json({ error: 'Not found.' }, 404), { noindex: true });
  }

  // Static pages and assets.
  const res = await env.ASSETS.fetch(request);
  const type = res.headers.get('content-type') || '';
  const isAdminPage = path === '/admin' || path.startsWith('/admin.') || path === '/assets/admin.js';
  return withSecurityHeaders(res, { page: type.includes('text/html'), noindex: isAdminPage || path === '/account' });
}

async function housekeeping(env) {
  const t = now();
  await expireUnpaid(env);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?').bind(t).run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 24 * 3600 * 1000).run();
  await env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(t - 365 * 24 * 3600 * 1000).run();
}

export default {
  async fetch(request, env, ctx) {
    // Cloudflare Pages has no scheduled jobs, so roughly 1 request in 200 also does the cleanup.
    if (env.DB && Math.random() < 0.005) ctx.waitUntil(housekeeping(env).catch(() => {}));
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return withSecurityHeaders(json({ error: e.message, code: e.code }, e.status), { noindex: true });
      }
      console.log('Unhandled error', e && e.stack);
      const msg = String((e && e.message) || '');
      if (/no such table/i.test(msg)) {
        return withSecurityHeaders(json({ error: 'Database tables are missing. Paste migrations/0001_initial.sql into the D1 console (Storage & databases → D1 → aveela → Console) and run it.', code: 'setup' }, 500), { noindex: true });
      }
      return withSecurityHeaders(json({ error: 'Something went wrong on our side. Try again in a moment.' }, 500), { noindex: true });
    }
  },

  // Hourly housekeeping (cron in wrangler.jsonc): expire unpaid approvals, clear old sessions/tokens/limits.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(housekeeping(env));
  },
};
