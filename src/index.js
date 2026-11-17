// Aveela Event Space: Cloudflare Worker entry point.
// Serves the static site from /public and the booking API under /api and /auth.
import { HttpError, json, assertSameOrigin, withSecurityHeaders } from './lib/http.js';
import { expireUnpaid, now } from './lib/core.js';
import { handleAuth } from './routes/auth.js';
import { handleBookings } from './routes/bookings.js';
import { handleAdmin } from './routes/admin.js';

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const isApi = path.startsWith('/api/');
  const isAuth = path.startsWith('/auth/') || path === '/auth';

  if (isApi || isAuth) {
    if (!env.APP_URL) return json({ error: 'APP_URL is not configured.' }, 500);
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

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return withSecurityHeaders(json({ error: e.message, code: e.code }, e.status), { noindex: true });
      }
      console.log('Unhandled error', e && e.stack);
      return withSecurityHeaders(json({ error: 'Something went wrong on our side. Try again in a moment.' }, 500), { noindex: true });
    }
  },

  // Hourly housekeeping (cron in wrangler.jsonc): expire unpaid approvals, clear old sessions/tokens/limits.
  async scheduled(event, env, ctx) {
    const t = now();
    ctx.waitUntil((async () => {
      await expireUnpaid(env);
      await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
      await env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?').bind(t).run();
      await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 24 * 3600 * 1000).run();
      await env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(t - 365 * 24 * 3600 * 1000).run();
    })());
  },
};
