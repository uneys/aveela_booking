// Customer accounts: email + password, Google, Apple, verification, password reset.
import { json, redirect, readJson, bad, unauthorized, conflict, clientIp, parseCookies, cookie, clearCookie, HttpError } from '../lib/http.js';
import { hashPassword, verifyPassword, dummyVerify, validPrehash, randomToken, sha256, decodeJwtPayload, appleClientSecret } from '../lib/crypto.js';
import { now, createSession, readSession, destroySession, destroyAllSessions, hit, peek, clearHits } from '../lib/core.js';
import { mail } from '../lib/email.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);

export const googleEnabled = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const appleEnabled = (env) => !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, verified: !!u.email_verified,
    hasPassword: !!u.password_hash, google: !!u.google_sub, apple: !!u.apple_sub,
  };
}

export async function currentUser(env, request) {
  const id = await readSession(env, request, 'user');
  if (!id) return null;
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return u && !u.suspended ? u : null; // a suspended account is treated as signed out everywhere
}

export const SUSPENDED_MSG = 'This account is suspended. Contact the venue if you think this is a mistake.';

// Records the sign-in time. Ignored if the database hasn't had migration 0003 yet.
async function touchLogin(env, id) {
  try { await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), id).run(); }
  catch (e) { if (!/no such column|has no column named/i.test(String(e && e.message))) throw e; }
}

export async function requireUser(env, request) {
  const u = await currentUser(env, request);
  if (!u) throw unauthorized();
  return u;
}

async function issueToken(env, purpose, userId, ttlMs) {
  const token = randomToken(32);
  await env.DB.prepare('DELETE FROM tokens WHERE user_id = ? AND purpose = ?').bind(userId, purpose).run();
  await env.DB.prepare('INSERT INTO tokens (token_hash, purpose, user_id, expires_at) VALUES (?,?,?,?)')
    .bind(await sha256(token), purpose, userId, now() + ttlMs).run();
  return token;
}

async function useToken(env, purpose, token, consume = true) {
  if (!token || token.length > 100) return null;
  const h = await sha256(token);
  const row = await env.DB.prepare('SELECT user_id, expires_at FROM tokens WHERE token_hash = ? AND purpose = ?').bind(h, purpose).first();
  if (!row || row.expires_at < now()) return null;
  if (consume) await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?').bind(h).run();
  return row.user_id;
}

// At sign-up the email goes out in the background; the "send again" button waits and reports problems.
async function sendVerification(env, ctx, user, { wait = false } = {}) {
  const token = await issueToken(env, 'verify', user.id, 24 * 3600 * 1000);
  const sending = mail.verify(env, user.email, user.name, `${env.APP_URL}/auth/verify?token=${token}`);
  if (!wait) { ctx.waitUntil(sending); return { ok: true }; }
  return sending;
}

function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(next) ? next : '/account';
}

export async function handleAuth(request, env, ctx, url, path) {
  const ip = clientIp(request);
  const method = request.method;

  if (path === '/api/me' && method === 'GET') {
    return json({ user: publicUser(await currentUser(env, request)) });
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    const body = await readJson(request);
    const email = cleanEmail(body.email);
    const name = cleanName(body.name);
    const phone = String(body.phone || '').replace(/[^\d+\s-]/g, '').slice(0, 24);
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    if (name.length < 2) throw bad('Enter your name.');
    if (!validPrehash(body.pw)) throw bad('Password could not be processed. Reload the page and try again.');
    await hit(env, `signup:ip:${ip}`, 10);
    const exists = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (exists && exists.suspended) throw new HttpError(403, SUSPENDED_MSG, 'suspended');
    if (exists && !exists.password_hash && !exists.google_sub && !exists.apple_sub) {
      // The venue booked for this email by phone/WhatsApp. Prove it's theirs by email before setting a password.
      await hit(env, `forgot:acct:${email}`, 3);
      const token = await issueToken(env, 'reset', exists.id, 3600 * 1000);
      ctx.waitUntil(mail.reset(env, exists.email, `${env.APP_URL}/account?reset=${token}`));
      throw conflict("The venue already has bookings under this email. We've emailed you a link to set your password and see them.", 'claim');
    }
    if (exists) throw conflict('An account with this email already exists. Sign in instead.', 'exists');
    const hash = await hashPassword(env, body.pw);
    const r = await env.DB.prepare('INSERT INTO users (email, name, phone, password_hash, email_verified, created_at) VALUES (?,?,?,?,0,?) RETURNING *')
      .bind(email, name, phone, hash, now()).first();
    await touchLogin(env, r.id);
    await sendVerification(env, ctx, r);
    const set = await createSession(env, 'user', r.id, ip);
    return json({ user: publicUser(r) }, 201, { 'set-cookie': set });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    const email = cleanEmail(body.email);
    if (!EMAIL_RE.test(email) || !validPrehash(body.pw)) throw bad('Enter your email and password.');
    // Two limits: per account (stops targeted guessing) and per network (stops spraying).
    await peek(env, `login:acct:${email}`, 8);
    await peek(env, `login:ip:${ip}`, 30);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    let ok = false, needsRehash = false;
    if (u && u.password_hash) ({ ok, needsRehash } = await verifyPassword(env, body.pw, u.password_hash));
    else await dummyVerify(env, body.pw);
    if (!ok) {
      await hit(env, `login:acct:${email}`, 8);
      await hit(env, `login:ip:${ip}`, 30);
      if (u && !u.password_hash && (u.google_sub || u.apple_sub)) throw unauthorized(`This account uses ${u.google_sub ? 'Google' : 'Apple'} sign-in. Use that button, or reset your password to add one.`);
      if (u && !u.password_hash) throw unauthorized('No password is set for this email yet. Use "Forgot your password?" to set one and see your bookings.');
      throw unauthorized('Email or password is incorrect.');
    }
    await clearHits(env, `login:acct:${email}`);
    if (u.suspended) throw new HttpError(403, SUSPENDED_MSG, 'suspended');
    await touchLogin(env, u.id);
    if (needsRehash) await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(env, body.pw), u.id).run();
    const set = await createSession(env, 'user', u.id, ip);
    return json({ user: publicUser(u) }, 200, { 'set-cookie': set });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': await destroySession(env, request, 'user') });
  }

  if (path === '/api/auth/profile' && method === 'POST') {
    const u = await requireUser(env, request);
    const body = await readJson(request);
    const name = cleanName(body.name);
    const phone = String(body.phone || '').replace(/[^\d+\s-]/g, '').slice(0, 24);
    if (name.length < 2) throw bad('Enter your name.');
    const r = await env.DB.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ? RETURNING *').bind(name, phone, u.id).first();
    return json({ user: publicUser(r) });
  }

  if (path === '/api/auth/resend-verification' && method === 'POST') {
    const u = await requireUser(env, request);
    if (u.email_verified) return json({ ok: true, already: true });
    await hit(env, `verify:${u.id}`, 4);
    const r = await sendVerification(env, ctx, u, { wait: true });
    if (!r.ok) throw new HttpError(502, "We couldn't send the confirmation email right now. Try again in a few minutes, or contact us.", 'email_failed');
    return json({ ok: true, to: u.email });
  }

  if (path === '/auth/verify' && method === 'GET') {
    const userId = await useToken(env, 'verify', url.searchParams.get('token'));
    if (!userId) return redirect('/account?verify=expired');
    await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(userId).run();
    return redirect('/account?verified=1');
  }

  if (path === '/api/auth/forgot' && method === 'POST') {
    const body = await readJson(request);
    const email = cleanEmail(body.email);
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    await hit(env, `forgot:ip:${ip}`, 6);
    await hit(env, `forgot:acct:${email}`, 3);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (u && !u.suspended) {
      const token = await issueToken(env, 'reset', u.id, 3600 * 1000);
      ctx.waitUntil(mail.reset(env, u.email, `${env.APP_URL}/account?reset=${token}`));
    }
    // Same answer either way, so this can't be used to find out who has an account.
    return json({ ok: true });
  }

  if (path === '/api/auth/reset-info' && method === 'GET') {
    const userId = await useToken(env, 'reset', url.searchParams.get('token'), false);
    if (!userId) throw bad('This reset link has expired. Ask for a new one.', 'expired');
    const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
    return json({ email: u.email });
  }

  if (path === '/api/auth/reset' && method === 'POST') {
    const body = await readJson(request);
    if (!validPrehash(body.pw)) throw bad('Password could not be processed.');
    const userId = await useToken(env, 'reset', body.token);
    if (!userId) throw bad('This reset link has expired. Ask for a new one.', 'expired');
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    if (target && target.suspended) throw new HttpError(403, SUSPENDED_MSG, 'suspended');
    // Clicking the emailed link also proves the address belongs to them.
    await env.DB.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').bind(await hashPassword(env, body.pw), userId).run();
    await destroyAllSessions(env, 'user', userId);
    const set = await createSession(env, 'user', userId, ip);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    return json({ user: publicUser(u) }, 200, { 'set-cookie': set });
  }

  // ---------- Google ----------
  if (path === '/auth/google' && method === 'GET') {
    if (!googleEnabled(env)) return redirect('/account?oauth=unavailable');
    const state = randomToken(18), nonce = randomToken(18), verifier = randomToken(48);
    const challenge = (await sha256(verifier));
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.APP_URL}/auth/google/callback`, response_type: 'code',
      scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, {
      'set-cookie': cookie('__Host-aveela_o', JSON.stringify({ p: 'google', state, nonce, verifier, next: safeNext(url.searchParams.get('next')) }), { maxAge: 600, sameSite: 'Lax' }),
    });
  }

  if (path === '/auth/google/callback' && method === 'GET') {
    const saved = readOAuthCookie(request, 'google');
    if (!saved || url.searchParams.get('state') !== saved.state || !url.searchParams.get('code')) return oauthFail('google');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${env.APP_URL}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: saved.verifier,
      }),
    });
    if (!res.ok) return oauthFail('google');
    const tok = await res.json();
    // The id_token came straight from Google's token endpoint over TLS, authenticated with our
    // client secret, so its claims can be trusted after these checks.
    let c;
    try { c = decodeJwtPayload(tok.id_token); } catch { return oauthFail('google'); }
    const issOk = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
    if (!issOk || c.aud !== env.GOOGLE_CLIENT_ID || c.exp * 1000 < now() || c.nonce !== saved.nonce || !c.email || !c.email_verified) return oauthFail('google');
    const user = await upsertOAuthUser(env, 'google_sub', c.sub, cleanEmail(c.email), cleanName(c.name));
    if (user.suspended) return redirect('/account?oauth=suspended', { 'set-cookie': clearCookie('__Host-aveela_o', 'Lax') });
    await touchLogin(env, user.id);
    const set = await createSession(env, 'user', user.id, ip);
    const h = new Headers({ location: saved.next, 'cache-control': 'no-store' });
    h.append('set-cookie', set);
    h.append('set-cookie', clearCookie('__Host-aveela_o', 'Lax'));
    return new Response(null, { status: 302, headers: h });
  }

  // ---------- Apple ----------
  if (path === '/auth/apple' && method === 'GET') {
    if (!appleEnabled(env)) return redirect('/account?oauth=unavailable');
    const state = randomToken(18), nonce = randomToken(18);
    const q = new URLSearchParams({
      client_id: env.APPLE_CLIENT_ID, redirect_uri: `${env.APP_URL}/auth/apple/callback`, response_type: 'code',
      response_mode: 'form_post', scope: 'name email', state, nonce: await sha256(nonce),
    });
    // Apple posts the result back cross-site, so this short-lived cookie must be SameSite=None.
    return redirect(`https://appleid.apple.com/auth/authorize?${q}`, {
      'set-cookie': cookie('__Host-aveela_o', JSON.stringify({ p: 'apple', state, nonce, next: safeNext(url.searchParams.get('next')) }), { maxAge: 600, sameSite: 'None' }),
    });
  }

  if (path === '/auth/apple/callback' && method === 'POST') {
    const saved = readOAuthCookie(request, 'apple');
    const form = await request.formData();
    if (!saved || form.get('state') !== saved.state || !form.get('code')) return oauthFail('apple');
    const res = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.APPLE_CLIENT_ID, client_secret: await appleClientSecret(env), code: form.get('code'),
        grant_type: 'authorization_code', redirect_uri: `${env.APP_URL}/auth/apple/callback`,
      }),
    });
    if (!res.ok) return oauthFail('apple');
    const tok = await res.json();
    let c;
    try { c = decodeJwtPayload(tok.id_token); } catch { return oauthFail('apple'); }
    if (c.iss !== 'https://appleid.apple.com' || c.aud !== env.APPLE_CLIENT_ID || c.exp * 1000 < now() || c.nonce !== await sha256(saved.nonce) || !c.email) return oauthFail('apple');
    let name = '';
    try { const u = JSON.parse(form.get('user') || '{}'); name = cleanName([u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ')); } catch {}
    const verified = c.email_verified === true || c.email_verified === 'true';
    if (!verified) return oauthFail('apple');
    const user = await upsertOAuthUser(env, 'apple_sub', c.sub, cleanEmail(c.email), name);
    if (user.suspended) return new Response(null, { status: 303, headers: { location: '/account?oauth=suspended', 'set-cookie': clearCookie('__Host-aveela_o', 'None') } });
    await touchLogin(env, user.id);
    const set = await createSession(env, 'user', user.id, ip);
    const h = new Headers({ location: saved.next, 'cache-control': 'no-store' });
    h.append('set-cookie', set);
    h.append('set-cookie', clearCookie('__Host-aveela_o', 'None'));
    // 303 turns Apple's POST into a normal GET of the next page.
    return new Response(null, { status: 303, headers: h });
  }

  return null;
}

function readOAuthCookie(request, provider) {
  try {
    const v = JSON.parse(parseCookies(request)['__Host-aveela_o'] || 'null');
    return v && v.p === provider ? v : null;
  } catch { return null; }
}

function oauthFail(provider) {
  return redirect(`/account?oauth=failed&provider=${provider}`, { 'set-cookie': clearCookie('__Host-aveela_o', provider === 'apple' ? 'None' : 'Lax') });
}

async function upsertOAuthUser(env, column, sub, email, name) {
  let u = await env.DB.prepare(`SELECT * FROM users WHERE ${column} = ?`).bind(sub).first();
  if (u) return u;
  u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (u) {
    // The provider verified this email, so it's safe to link it to the existing account.
    return env.DB.prepare(`UPDATE users SET ${column} = ?, email_verified = 1, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ? RETURNING *`)
      .bind(sub, name, u.id).first();
  }
  return env.DB.prepare(`INSERT INTO users (email, name, ${column}, email_verified, created_at) VALUES (?,?,?,1,?) RETURNING *`)
    .bind(email, name || email.split('@')[0], sub, now()).first();
}
