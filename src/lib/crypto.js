// Password hashing, tokens and small crypto helpers (WebCrypto only, no dependencies).
//
// Password scheme ("v1"):
//   browser:  pre = PBKDF2-SHA256(password, "aveela:<realm>:<identifier>", 600000 rounds)
//             -> only `pre` (base64) is ever sent to the server
//   server:   peppered = HMAC-SHA256(key = PEPPER secret, pre)
//             stored   = PBKDF2-SHA256(peppered, random 16-byte salt, SERVER_HASH_ITERATIONS)
//             format   = v1$<iterations>$<salt b64>$<hash b64>
//
// The slow work is split so the free Workers plan's 10 ms CPU budget is respected while an
// attacker who steals the database still pays the full cost per guess, and cannot even
// start without the pepper, which lives only in Cloudflare secrets, never in D1.

const enc = new TextEncoder();

export const b64 = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
export const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
export const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(n = 32) {
  return b64url(randomBytes(n));
}

export async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function hmac(keyText, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(keyBytes, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

function serverIterations(env) {
  const n = parseInt(env.SERVER_HASH_ITERATIONS || '20000', 10);
  // Workers rejects PBKDF2 above 100,000 rounds.
  return Math.min(Math.max(Number.isFinite(n) ? n : 20000, 10000), 100000);
}

function requirePepper(env) {
  if (!env.PEPPER || env.PEPPER.length < 32) {
    throw new Error('PEPPER secret is missing or shorter than 32 characters.');
  }
  return env.PEPPER;
}

// `pre` is the browser-side PBKDF2 output: 32 bytes, base64.
export function validPrehash(pre) {
  return typeof pre === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(pre);
}

export async function hashPassword(env, pre) {
  const peppered = await hmac(requirePepper(env), pre);
  const salt = randomBytes(16);
  const it = serverIterations(env);
  const hash = await pbkdf2(peppered, salt, it);
  return `v1$${it}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(env, pre, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false };
  const it = parseInt(parts[1], 10);
  const peppered = await hmac(requirePepper(env), pre);
  const hash = await pbkdf2(peppered, unb64(parts[2]), it);
  const ok = timingSafeEqual(hash, unb64(parts[3]));
  return { ok, needsRehash: ok && it !== serverIterations(env) };
}

// Run a hash anyway when the account does not exist, so response time does not reveal it.
export async function dummyVerify(env, pre) {
  await verifyPassword(env, pre, 'v1$' + serverIterations(env) + '$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
}

// --- JWT helpers for Sign in with Apple ---

export function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  return JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
}

function pemToPkcs8(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  return unb64(body);
}

// Apple's client_secret is a short-lived ES256 JWT signed with your .p8 key.
export async function appleClientSecret(env) {
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(env.APPLE_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID })));
  const payload = b64url(enc.encode(JSON.stringify({
    iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}
