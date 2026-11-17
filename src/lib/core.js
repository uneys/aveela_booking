// Sessions, settings, rate limits, audit log, dates.
import { randomToken, sha256 } from './crypto.js';
import { parseCookies, cookie, clearCookie, tooMany } from './http.js';

export const now = () => Date.now();

// ---------- settings ----------

export const SETTING_DEFAULTS = {
  hourly_rate: '2500', currency: 'MVR', open_hour: '8', close_hour: '24', min_hours: '2',
  max_guests: '250', pay_within_hours: '48', bank_name: '', account_name: '', account_number: '',
  payment_note: 'Please use your booking reference as the transfer remark.', notify_email: '',
};
export const NUMERIC_SETTINGS = ['hourly_rate', 'open_hour', 'close_hour', 'min_hours', 'max_guests', 'pay_within_hours'];

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...SETTING_DEFAULTS };
  for (const r of results) s[r.key] = r.value;
  const out = { ...s };
  for (const k of NUMERIC_SETTINGS) out[k] = parseInt(s[k], 10) || 0;
  return out;
}

// ---------- sessions ----------

const SESSION = {
  user: { cookie: '__Host-aveela_s', ttl: 30 * 24 * 3600 * 1000, sameSite: 'Lax' },
  admin: { cookie: '__Host-aveela_a', ttl: 8 * 3600 * 1000, sameSite: 'Strict' },
};

export async function createSession(env, kind, subjectId, ip) {
  const token = randomToken(32);
  const cfg = SESSION[kind];
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, kind, subject_id, expires_at, created_at, ip) VALUES (?,?,?,?,?,?)')
    .bind(await sha256(token), kind, subjectId, t + cfg.ttl, t, ip || '').run();
  return cookie(cfg.cookie, token, { maxAge: cfg.ttl / 1000, sameSite: cfg.sameSite });
}

export async function readSession(env, request, kind) {
  const cfg = SESSION[kind];
  const token = parseCookies(request)[cfg.cookie];
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare('SELECT subject_id, expires_at FROM sessions WHERE token_hash = ? AND kind = ?')
    .bind(await sha256(token), kind).first();
  if (!row || row.expires_at < now()) return null;
  return row.subject_id;
}

export async function destroySession(env, request, kind) {
  const cfg = SESSION[kind];
  const token = parseCookies(request)[cfg.cookie];
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return clearCookie(cfg.cookie, cfg.sameSite);
}

export async function destroyAllSessions(env, kind, subjectId, exceptRequest) {
  let keep = '';
  if (exceptRequest) {
    const token = parseCookies(exceptRequest)[SESSION[kind].cookie];
    if (token) keep = await sha256(token);
  }
  await env.DB.prepare('DELETE FROM sessions WHERE kind = ? AND subject_id = ? AND token_hash != ?').bind(kind, subjectId, keep).run();
}

// ---------- rate limiting ----------
// Fixed 15-minute windows kept in D1. Check before running any password hash.

const WINDOW = 15 * 60 * 1000;

export async function hit(env, key, limit) {
  const t = now();
  const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || t - row.window_start > WINDOW) {
    await env.DB.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start')
      .bind(key, t).run();
    return;
  }
  if (row.count >= limit) throw tooMany();
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
}

export async function peek(env, key, limit) {
  const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (row && now() - row.window_start <= WINDOW && row.count >= limit) throw tooMany();
}

export async function clearHits(env, key) {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

// ---------- audit ----------

export async function audit(env, adminId, action, detail, ip) {
  await env.DB.prepare('INSERT INTO audit_log (admin_id, action, detail, ip, at) VALUES (?,?,?,?,?)')
    .bind(adminId || null, action, String(detail || '').slice(0, 500), ip || '', now()).run();
}

// ---------- dates (venue local time) ----------

export function venueToday(env) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: env.VENUE_TZ || 'Indian/Maldives', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

export function venueHourNow(env) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: env.VENUE_TZ || 'Indian/Maldives', hour: '2-digit', hourCycle: 'h23' }).format(new Date()), 10);
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

export function fmtHour(h) {
  if (h === 0 || h === 24) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function fmtDate(d) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function money(settings, amount) {
  return `${settings.currency} ${Number(amount).toLocaleString('en-US')}`;
}

// Bookings that hold their time slot.
export const HOLDING = ['approved', 'slip_uploaded', 'confirmed', 'blocked'];

export async function expireUnpaid(env) {
  await env.DB.prepare("UPDATE bookings SET status = 'expired', updated_at = ? WHERE status = 'approved' AND pay_by IS NOT NULL AND pay_by < ?")
    .bind(now(), now()).run();
}

export async function findClashes(env, date, start, end, excludeId = 0, statuses = HOLDING) {
  const q = `SELECT id, ref, status, start_hour, end_hour FROM bookings
             WHERE date = ? AND id != ? AND start_hour < ? AND end_hour > ?
             AND status IN (${statuses.map(() => '?').join(',')})`;
  const { results } = await env.DB.prepare(q).bind(date, excludeId, end, start, ...statuses).all();
  return results;
}

export function newRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = 'AV-';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
