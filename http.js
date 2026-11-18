// Small HTTP helpers shared by every route.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const bad = (msg, code = 'bad_request') => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Sign in to continue.') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'You do not have access to this.') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found.') => new HttpError(404, msg, 'not_found');
export const conflict = (msg, code = 'conflict') => new HttpError(409, msg, code);
export const tooMany = (msg = 'Too many attempts. Wait 15 minutes and try again.') => new HttpError(429, msg, 'rate_limited');

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });
}

export async function readJson(request, maxBytes = 20000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw bad('Request is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw bad('Request is too large.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw bad('Request body must be JSON.');
  }
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookie(name, value, { maxAge, sameSite = 'Lax', httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  return c;
}

export const clearCookie = (name, sameSite = 'Lax') => cookie(name, '', { maxAge: 0, sameSite });

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '0.0.0.0';
}

// State-changing API calls must come from our own pages: same Origin and a custom header
// (a cross-site form cannot set it, and a cross-site fetch with it would need CORS we never grant).
export function assertSameOrigin(request, url) {
  if (request.headers.get('x-aveela') !== '1') throw forbidden('Request blocked.');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw forbidden('Request blocked.');
}

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self' https://accounts.google.com https://appleid.apple.com",
  "object-src 'none'",
].join('; ');

export function withSecurityHeaders(response, { page = false, noindex = false } = {}) {
  const r = new Response(response.body, response);
  const h = r.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('cross-origin-opener-policy', 'same-origin-allow-popups');
  if (page) {
    h.set('content-security-policy', PAGE_CSP);
    h.set('x-frame-options', 'DENY');
  }
  if (noindex) h.set('x-robots-tag', 'noindex, nofollow');
  return r;
}
