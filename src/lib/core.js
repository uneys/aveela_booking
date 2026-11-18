// Sessions, settings, rate limits, audit log, dates.
import { randomToken, sha256 } from './crypto.js';
import { parseCookies, cookie, clearCookie, tooMany } from './http.js';

export const now = () => Date.now();

// ---------- settings ----------

export const SETTING_DEFAULTS = {
  hourly_rate: '2500', currency: 'MVR', open_hour: '8', close_hour: '24', min_hours: '2',
  max_guests: '250', pay_within_hours: '48', bank_name: '', account_name: '', account_number: '',
  payment_note: 'Please use your booking reference as the transfer remark.', notify_email: '', admin_idle_minutes: '30', gap_hours: '0',
};
export const NUMERIC_SETTINGS = ['hourly_rate', 'open_hour', 'close_hour', 'min_hours', 'max_guests', 'pay_within_hours', 'admin_idle_minutes', 'gap_hours'];

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...SETTING_DEFAULTS };
  for (const r of results) s[r.key] = r.value;
  const out = { ...s };
  for (const k of NUMERIC_SETTINGS) out[k] = parseInt(s[k], 10) || 0;
  return out;
}

// ---------- sessions ----------

// ttl: longest a session can last. idle: signed out after this long without activity.
// The admin idle time is a setting (admin_idle_minutes, default 30); customers get 14 days.
const SESSION = {
  user: { cookie: '__Host-aveela_s', ttl: 30 * 24 * 3600 * 1000, idle: 14 * 24 * 3600 * 1000, sameSite: 'Lax' },
  admin: { cookie: '__Host-aveela_a', ttl: 8 * 3600 * 1000, sameSite: 'Strict' },
};
const TOUCH_EVERY = 60 * 1000; // write last_seen at most once a minute
const endedBy = new WeakMap(); // request -> 'idle' | 'expired', for a clearer message

export const sessionEndReason = (request) => endedBy.get(request) || null;
const missingColumn = (e) => /no such column|has no column named/i.test(String((e && e.message) || e));

async function idleLimit(env, kind) {
  if (kind === 'user') return SESSION.user.idle;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_idle_minutes'").first();
  const min = parseInt(row ? row.value : '30', 10);
  return Math.min(Math.max(Number.isFinite(min) && min > 0 ? min : 30, 5), 480) * 60 * 1000;
}

export async function createSession(env, kind, subjectId, ip) {
  const token = randomToken(32);
  const cfg = SESSION[kind];
  const t = now();
  const h = await sha256(token);
  try {
    await env.DB.prepare('INSERT INTO sessions (token_hash, kind, subject_id, expires_at, created_at, ip, last_seen) VALUES (?,?,?,?,?,?,?)')
      .bind(h, kind, subjectId, t + cfg.ttl, t, ip || '', t).run();
  } catch (e) {
    if (!missingColumn(e)) throw e; // database not updated to migration 0002 yet: still let people sign in
    await env.DB.prepare('INSERT INTO sessions (token_hash, kind, subject_id, expires_at, created_at, ip) VALUES (?,?,?,?,?,?)')
      .bind(h, kind, subjectId, t + cfg.ttl, t, ip || '').run();
  }
  return cookie(cfg.cookie, token, { maxAge: cfg.ttl / 1000, sameSite: cfg.sameSite });
}

// Background requests (the admin panel's once-a-minute refresh) send x-aveela-bg: 1 and don't
// count as activity, so an unattended screen still times out.
export async function readSession(env, request, kind) {
  const cfg = SESSION[kind];
  const token = parseCookies(request)[cfg.cookie];
  if (!token || token.length > 100) return null;
  const h = await sha256(token);
  const t = now();
  let row;
  try {
    row = await env.DB.prepare('SELECT subject_id, expires_at, last_seen, created_at FROM sessions WHERE token_hash = ? AND kind = ?').bind(h, kind).first();
  } catch (e) {
    if (!missingColumn(e)) throw e;
    row = await env.DB.prepare('SELECT subject_id, expires_at FROM sessions WHERE token_hash = ? AND kind = ?').bind(h, kind).first();
    if (!row || row.expires_at < t) return null;
    return row.subject_id;
  }
  if (!row) return null;
  if (row.expires_at < t) { endedBy.set(request, 'expired'); return null; }
  const last = row.last_seen || row.created_at;
  if (t - last > (await idleLimit(env, kind))) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(h).run();
    endedBy.set(request, 'idle');
    return null;
  }
  if (request.headers.get('x-aveela-bg') !== '1' && t - last > TOUCH_EVERY) {
    await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(t, h).run();
  }
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

export function describeSlot(b) {
  return `${fmtDate(b.date)}, ${fmtHour(b.start_hour)} to ${fmtHour(b.end_hour)}`;
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

// Hours kept free between bookings for set-up and cleaning (Settings → "Gap between bookings").
export async function gapHours(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'gap_hours'").first();
  const g = parseInt(row ? row.value : '0', 10);
  return Number.isFinite(g) && g > 0 ? Math.min(g, 12) : 0;
}

// Bookings on the same date whose hours (plus the gap) overlap [start, end).
export async function findClashes(env, date, start, end, excludeId = 0, statuses = HOLDING) {
  const g = await gapHours(env);
  const q = `SELECT id, ref, status, start_hour, end_hour FROM bookings
             WHERE date = ? AND id != ? AND start_hour < ? AND end_hour > ?
             AND status IN (${statuses.map(() => '?').join(',')})`;
  const { results } = await env.DB.prepare(q).bind(date, excludeId, end + g, start - g, ...statuses).all();
  return results;
}

// SQL condition that makes a write fail if the hours were taken a moment earlier (two staff approving
// at once). The check and the write happen in one statement, so they can't interleave.
// Bind with: ...guardArgs(excludeId, date, start, end, gap)
export const FREE_GUARD = `NOT EXISTS (SELECT 1 FROM bookings o WHERE o.id != ? AND o.date = ? AND o.start_hour < ? AND o.end_hour > ?
  AND o.status IN ('approved','slip_uploaded','confirmed','blocked'))`;
export const guardArgs = (excludeId, date, start, end, g) => [excludeId, date, end + g, start - g];

export function newRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = 'AV-';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
