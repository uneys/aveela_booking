// Vendor admin panel API. Every route here needs an admin session, except state/setup/login.
import { json, readJson, bad, unauthorized, forbidden, notFound, conflict, clientIp, HttpError } from '../lib/http.js';
import { hashPassword, verifyPassword, dummyVerify, validPrehash, timingSafeEqual } from '../lib/crypto.js';
import {
  now, getSettings, SETTING_DEFAULTS, NUMERIC_SETTINGS, createSession, readSession, destroySession, destroyAllSessions,
  hit, peek, clearHits, audit, expireUnpaid, findClashes, newRef, isDate, sessionEndReason, venueToday, describeSlot,
  gapHours, FREE_GUARD, guardArgs, PAYMENT_METHODS,
} from '../lib/core.js';
import { publicBooking, serveSlip, readSlipUpload, storeSlip, EVENT_TYPES, SOURCES } from './bookings.js';
import { mail, statusEmail, emailProvider } from '../lib/email.js';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const LOGIN_LIMIT_ACCT = 5;
const LOGIN_LIMIT_IP = 20;

function publicAdmin(a) {
  return { id: a.id, username: a.username, name: a.name, email: a.email, isMaster: !!a.is_master, active: !!a.active, mustChange: !!a.must_change, createdAt: a.created_at, lastLoginAt: a.last_login_at };
}

async function currentAdmin(env, request) {
  const id = await readSession(env, request, 'admin');
  if (!id) return null;
  const a = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(id).first();
  return a && a.active ? a : null;
}

async function requireAdmin(env, request, { allowMustChange = false } = {}) {
  const a = await currentAdmin(env, request);
  if (!a) {
    if (sessionEndReason(request) === 'idle') {
      const s = await getSettings(env);
      throw new HttpError(401, `You were signed out after ${s.admin_idle_minutes} minutes without activity. Sign in again.`, 'idle_timeout');
    }
    throw unauthorized('Your admin session has ended. Sign in again.');
  }
  if (a.must_change && !allowMustChange) throw forbidden('Set a new password before continuing.');
  return a;
}

async function requireMaster(env, request) {
  const a = await requireAdmin(env, request);
  if (!a.is_master) throw forbidden('Only the master admin can do this.');
  return a;
}

// Website bookings use the customer's account; manual bookings may only have the details typed in.
function adminBooking(b) {
  let customer = null;
  if (b.status !== 'blocked' && (b.user_id || b.customer_name)) {
    customer = {
      id: b.user_id || null,
      name: b.customer_name || b.u_name || '',
      email: b.u_email || b.customer_email || '',
      phone: b.customer_phone || b.u_phone || '',
      hasAccount: !!(b.user_id && b.u_has_login),
    };
  }
  return { ...publicBooking(b), customer, decidedBy: b.a_name || null, createdBy: b.c_name || null };
}
function adminUser(u) {
  const methods = [u.password_hash && 'Email', u.google_sub && 'Google', u.apple_sub && 'Apple'].filter(Boolean);
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, verified: !!u.email_verified, signInWith: methods,
    hasAccount: methods.length > 0, createdAt: u.created_at, lastLoginAt: u.last_login_at || null,
    suspended: !!u.suspended, suspendedReason: u.suspended_reason || '', suspendedAt: u.suspended_at || null, suspendedBy: u.sb_name || null,
    bookings: u.n_bookings ?? null, upcoming: u.n_upcoming ?? null,
  };
}

const customerEmail = (b) => b.u_email || b.customer_email || '';

const BOOKING_SELECT = `SELECT b.*, u.name AS u_name, u.email AS u_email, u.phone AS u_phone,
  (u.password_hash IS NOT NULL OR u.google_sub IS NOT NULL OR u.apple_sub IS NOT NULL) AS u_has_login,
  a.name AS a_name, c.name AS c_name
  FROM bookings b LEFT JOIN users u ON u.id = b.user_id LEFT JOIN admins a ON a.id = b.decided_by LEFT JOIN admins c ON c.id = b.created_by`;

async function loadBooking(env, id) {
  const b = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(id).first();
  if (!b) throw notFound('Booking not found.');
  return b;
}

// Reads an optional new date/time/guests from a request body. Returns null when nothing changed.
function slotChange(env, b, body) {
  const has = ['date', 'start', 'end', 'guests'].some((k) => body[k] !== undefined && body[k] !== '');
  if (!has) return null;
  const date = body.date ?? b.date, start = Number(body.start ?? b.start_hour), end = Number(body.end ?? b.end_hour);
  const guests = Number(body.guests ?? b.guests);
  if (!isDate(date)) throw bad('Pick a valid date.');
  if (date < venueToday(env)) throw bad('That date has passed.');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || end <= start) throw bad('Pick a start and end time, ending after it starts.');
  if (!Number.isInteger(guests) || guests < 1 || guests > 10000) throw bad('Enter the number of guests.');
  const timeChanged = date !== b.date || start !== b.start_hour || end !== b.end_hour;
  if (!timeChanged && guests === b.guests) return null;
  return { date, start, end, guests, timeChanged, from: describeSlot(b) };
}

const noteOf = (body) => String(body.note || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 600);

export async function handleAdmin(request, env, ctx, url, path) {
  const method = request.method;
  const ip = clientIp(request);

  if (path === '/api/admin/state' && method === 'GET') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    const a = await currentAdmin(env, request);
    const idle = a ? (await getSettings(env)).admin_idle_minutes : null;
    return json({ needsSetup: count.n === 0, setupEnabled: !!env.SETUP_TOKEN, admin: a ? publicAdmin(a) : null, idleMinutes: idle });
  }

  // Keeps the session alive while someone is actually using the panel (typing a long note, etc.).
  if (path === '/api/admin/ping' && method === 'POST') {
    await requireAdmin(env, request, { allowMustChange: true });
    return json({ ok: true });
  }

  // First run only: creates the master admin. Needs the SETUP_TOKEN secret.
  if (path === '/api/admin/setup' && method === 'POST') {
    const body = await readJson(request);
    await hit(env, `setup:ip:${ip}`, 5);
    if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 16) throw forbidden('Setup is turned off. Set the SETUP_TOKEN secret first.');
    const enc = new TextEncoder();
    const given = enc.encode(String(body.token || ''));
    const want = enc.encode(env.SETUP_TOKEN);
    if (!timingSafeEqual(given, want)) throw forbidden('Setup token is incorrect.');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    if (count.n > 0) throw conflict('Setup is already done. Sign in instead.');
    const username = String(body.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw bad('Username: 3–32 lowercase letters, numbers, dots, dashes or underscores.');
    if (!validPrehash(body.pw)) throw bad('Password could not be processed.');
    const a = await env.DB.prepare('INSERT INTO admins (username, name, email, password_hash, is_master, created_at, last_login_at) VALUES (?,?,?,?,1,?,?) RETURNING *')
      .bind(username, String(body.name || username).slice(0, 80), String(body.email || '').slice(0, 190), await hashPassword(env, body.pw), now(), now()).first();
    await audit(env, a.id, 'setup', `Master admin ${username} created`, ip);
    const set = await createSession(env, 'admin', a.id, ip);
    return json({ admin: publicAdmin(a) }, 201, { 'set-cookie': set });
  }

  if (path === '/api/admin/login' && method === 'POST') {
    const body = await readJson(request);
    const username = String(body.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username) || !validPrehash(body.pw)) throw bad('Enter your username and password.');
    await peek(env, `alogin:acct:${username}`, LOGIN_LIMIT_ACCT);
    await peek(env, `alogin:ip:${ip}`, LOGIN_LIMIT_IP);
    const a = await env.DB.prepare('SELECT * FROM admins WHERE username = ?').bind(username).first();
    let ok = false, needsRehash = false;
    if (a) ({ ok, needsRehash } = await verifyPassword(env, body.pw, a.password_hash));
    else await dummyVerify(env, body.pw);
    if (!ok || !a.active) {
      await hit(env, `alogin:acct:${username}`, LOGIN_LIMIT_ACCT);
      await hit(env, `alogin:ip:${ip}`, LOGIN_LIMIT_IP);
      await audit(env, a ? a.id : null, 'login_failed', username, ip);
      throw unauthorized('Username or password is incorrect.');
    }
    await clearHits(env, `alogin:acct:${username}`);
    const update = needsRehash
      ? env.DB.prepare('UPDATE admins SET last_login_at = ?, password_hash = ? WHERE id = ?').bind(now(), await hashPassword(env, body.pw), a.id)
      : env.DB.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').bind(now(), a.id);
    await update.run();
    await audit(env, a.id, 'login', '', ip);
    const set = await createSession(env, 'admin', a.id, ip);
    return json({ admin: publicAdmin(a) }, 200, { 'set-cookie': set });
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': await destroySession(env, request, 'admin') });
  }

  if (path === '/api/admin/password' && method === 'POST') {
    const a = await requireAdmin(env, request, { allowMustChange: true });
    const body = await readJson(request);
    if (!validPrehash(body.current) || !validPrehash(body.next)) throw bad('Password could not be processed.');
    await hit(env, `apw:${a.id}`, 6);
    const { ok } = await verifyPassword(env, body.current, a.password_hash);
    if (!ok) throw unauthorized('Current password is incorrect.');
    if (body.current === body.next) throw bad('Choose a password different from the current one.');
    await env.DB.prepare('UPDATE admins SET password_hash = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(env, body.next), a.id).run();
    await destroyAllSessions(env, 'admin', a.id, request);
    await audit(env, a.id, 'password_changed', 'Own password', ip);
    return json({ ok: true });
  }

  // ---------- everything below needs a signed-in admin ----------

  if (path === '/api/admin/overview' && method === 'GET') {
    await requireAdmin(env, request);
    await expireUnpaid(env);
    const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM bookings WHERE date >= date('now','-1 day') OR status IN ('pending','slip_uploaded') GROUP BY status").all();
    const counts = Object.fromEntries(results.map((r) => [r.status, r.n]));
    return json({ counts, settings: await getSettings(env) });
  }

  if (path === '/api/admin/bookings' && method === 'GET') {
    await requireAdmin(env, request);
    await expireUnpaid(env);
    const status = url.searchParams.get('status') || '';
    const scope = url.searchParams.get('scope') || '';
    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const where = [];
    const args = [];
    if (status) {
      const list = status.split(',').filter((s) => /^[a-z_]+$/.test(s));
      where.push(`b.status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (scope === 'upcoming') { where.push("b.date >= date('now','-1 day')"); }
    if (scope === 'past') { where.push("b.date < date('now')"); }
    if (q) {
      where.push('(b.ref LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR b.customer_name LIKE ? OR b.customer_email LIKE ? OR b.customer_phone LIKE ?)');
      args.push(...Array(6).fill(`%${q}%`));
    }
    const order = scope === 'upcoming' || status === 'pending' || status === 'slip_uploaded' ? 'b.date ASC, b.start_hour ASC' : 'b.date DESC, b.start_hour DESC';
    const sql = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 200`;
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ bookings: results.map(adminBooking) });
  }

  // Manual booking: a request that came in by phone, WhatsApp, Instagram, walk-in, etc.
  if (path === '/api/admin/bookings' && method === 'POST') {
    const a = await requireAdmin(env, request);
    const body = await readJson(request);
    const s = await getSettings(env);
    const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 190);
    const phone = String(body.phone || '').replace(/[^\d+\s()-]/g, '').trim().slice(0, 24);
    const source = SOURCES.includes(body.source) ? body.source : null;
    const eventType = EVENT_TYPES.includes(body.eventType) ? body.eventType : null;
    const date = body.date, start = Number(body.start), end = Number(body.end), guests = Number(body.guests);
    const status = ['pending', 'approved', 'confirmed'].includes(body.status) ? body.status : null;
    const notes = String(body.notes || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 1000);
    if (name.length < 2) throw bad("Enter the customer's name.");
    if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw bad('That email address looks wrong.');
    if (!email && phone.replace(/\D/g, '').length < 5) throw bad('Enter a phone number or an email, so you can reach the customer.');
    if (!source) throw bad('Pick where the request came from.');
    if (!eventType) throw bad('Pick an event type.');
    if (!isDate(date)) throw bad('Pick a date.');
    if (date < venueToday(env)) throw bad('That date has passed.');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || end <= start) throw bad('Pick a start and end time, ending after it starts.');
    if (!Number.isInteger(guests) || guests < 1 || guests > 10000) throw bad('Enter the number of guests.');
    if (!status) throw bad('Pick a status.');
    const paymentMethod = status === 'confirmed' ? (body.paymentMethod || 'cash') : '';
    if (status === 'confirmed' && !PAYMENT_METHODS[paymentMethod]) throw bad('Choose how the customer paid.');
    const amount = body.amount === undefined || body.amount === '' ? (end - start) * s.hourly_rate : Number(body.amount);
    if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) throw bad('Enter the amount as a whole number.');
    if (status !== 'pending') {
      const clashes = await findClashes(env, date, start, end);
      if (clashes.length) throw conflict(`Those hours are already taken by ${clashes.map((c) => c.ref).join(', ')}.`, 'taken');
    }
    // With an email, link the booking to that customer's account, or start one they can claim
    // later with "Forgot your password?" (then it shows on their My bookings page).
    let userId = null;
    if (email) {
      const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      userId = u ? u.id : (await env.DB.prepare('INSERT INTO users (email, name, phone, email_verified, created_at) VALUES (?,?,?,0,?) RETURNING id')
        .bind(email, name, phone, now()).first()).id;
    }
    const t = now();
    const payBy = status === 'approved' && s.pay_within_hours > 0 ? t + s.pay_within_hours * 3600 * 1000 : null;
    const g = await gapHours(env);
    const b = await env.DB.prepare(`INSERT INTO bookings (ref, user_id, event_type, date, start_hour, end_hour, guests, notes, status, amount, vendor_note,
        pay_by, decided_by, created_by, source, customer_name, customer_email, customer_phone, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ? = 'pending' OR ${FREE_GUARD} RETURNING *`)
      .bind(newRef(), userId, eventType, date, start, end, guests, notes, status, amount, noteOf(body), payBy,
        status === 'pending' ? null : a.id, a.id, source, name, email, phone, t, t, status, ...guardArgs(0, date, start, end, g)).first();
    if (!b) throw conflict('Those hours were just taken by another booking. Pick other hours.', 'taken');
    if (paymentMethod) {
      try { await env.DB.prepare('UPDATE bookings SET payment_method = ?, paid_at = ? WHERE id = ?').bind(paymentMethod, t, b.id).run(); b.payment_method = paymentMethod; }
      catch (e) { if (!/no such column|has no column named/i.test(String(e && e.message))) throw e; }
    }
    let emailed = null;
    if (email && body.notify) {
      const send = status === 'pending' ? mail.requested : status === 'approved' ? mail.approved : mail.confirmed;
      const r = await send(env, s, email, b);
      emailed = r.ok ? 'sent' : (r.error || 'failed');
    }
    await audit(env, a.id, 'manual_booking', `${b.ref} via ${source} for ${name}, ${date} ${start}-${end}, ${status}`, ip);
    return json({ booking: adminBooking(await loadBooking(env, b.id)), emailed }, 201);
  }

  if (path === '/api/admin/blocks' && method === 'POST') {
    const a = await requireAdmin(env, request);
    const body = await readJson(request);
    const date = body.date, start = Number(body.start), end = Number(body.end);
    if (!isDate(date) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || end <= start) throw bad('Pick a date and a valid time range.');
    const clashes = await findClashes(env, date, start, end);
    if (clashes.length) throw conflict(`That clashes with ${clashes.map((c) => c.ref).join(', ')}.`);
    const t = now();
    const b = await env.DB.prepare(`INSERT INTO bookings (ref, user_id, event_type, date, start_hour, end_hour, guests, notes, status, decided_by, created_at, updated_at)
      SELECT ?,NULL,'Blocked',?,?,?,0,?,'blocked',?,?,? WHERE ${FREE_GUARD} RETURNING *`)
      .bind(newRef(), date, start, end, noteOf({ note: body.reason }), a.id, t, t, ...guardArgs(0, date, start, end, await gapHours(env))).first();
    if (!b) throw conflict('Those hours were just taken by another booking.');
    await audit(env, a.id, 'block', `${b.ref} ${date} ${start}-${end}`, ip);
    return json({ booking: publicBooking(b) }, 201);
  }

  const bm = path.match(/^\/api\/admin\/bookings\/(\d+)(?:\/(approve|reject|confirm|reject-slip|cancel|slip|resend-email|reschedule))?$/);
  if (bm) {
    const a = await requireAdmin(env, request);
    const id = Number(bm[1]);
    const action = bm[2];
    const b = await loadBooking(env, id);

    if (!action && method === 'GET') {
      const clashes = await findClashes(env, b.date, b.start_hour, b.end_hour, b.id, ['pending', 'approved', 'slip_uploaded', 'confirmed', 'blocked']);
      return json({ booking: adminBooking(b), clashes });
    }
    if (action === 'slip' && method === 'GET') return serveSlip(env, b);
    if (action === 'resend-email' && method === 'POST') {
      const which = statusEmail(b);
      if (!which || !customerEmail(b)) throw bad('There is no email address for this booking.');
      await hit(env, `resend:admin:${a.id}`, 20);
      const r = await which.send(env, await getSettings(env), customerEmail(b), b);
      await audit(env, a.id, 'resend_email', `${b.ref}: ${which.label}${r.ok ? '' : ' (failed)'}`, ip);
      if (!r.ok) throw new HttpError(502, r.error || 'The email could not be sent.', 'email_failed');
      return json({ ok: true, sent: which.label, to: customerEmail(b), provider: r.provider });
    }
    // Staff attach a slip themselves (paid in person, screenshot sent on WhatsApp, etc.).
    if (action === 'slip' && method === 'POST') {
      if (!['approved', 'slip_uploaded', 'confirmed'].includes(b.status)) throw conflict('You can add a slip once the booking is approved.');
      const upload = await readSlipUpload(request);
      const key = await storeSlip(env, ctx, b, upload);
      await env.DB.prepare(`UPDATE bookings SET slip_key = ?, slip_type = ?, slip_at = ?, updated_at = ?,
          status = CASE WHEN status = 'approved' THEN 'slip_uploaded' ELSE status END WHERE id = ?`)
        .bind(key, upload.type, now(), now(), b.id).run();
      await audit(env, a.id, 'slip_added', b.ref, ip);
      return json({ booking: adminBooking(await loadBooking(env, id)) });
    }
    if (method !== 'POST' || !action) throw notFound();

    const body = await readJson(request);
    const note = noteOf(body);
    const s = await getSettings(env);
    const t = now();
    const email = customerEmail(b);
    let updated;

    if (action === 'reschedule') {
      // Change the date, hours or guests of a request before deciding on it.
      if (b.status !== 'pending') throw conflict('You can change the time only while the request is waiting for approval.');
      const ch = slotChange(env, b, body);
      if (!ch) throw bad('Nothing changed.');
      const amount = body.amount === undefined || body.amount === '' ? (ch.end - ch.start) * s.hourly_rate : Number(body.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) throw bad('Enter the amount as a whole number.');
      updated = await env.DB.prepare("UPDATE bookings SET date = ?, start_hour = ?, end_hour = ?, guests = ?, amount = ?, vendor_note = CASE WHEN ? = '' THEN vendor_note ELSE ? END, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .bind(ch.date, ch.start, ch.end, ch.guests, amount, note, note, t, id).first();
      if (!updated) throw conflict('This booking changed in the meantime. Reload and try again.');
      let emailed = null;
      if (email && body.notify && ch.timeChanged) {
        const r = await mail.timeChanged(env, s, email, updated, ch.from);
        emailed = r.ok ? 'sent' : (r.error || 'failed');
      }
      await audit(env, a.id, 'reschedule', `${b.ref}: ${ch.from} → ${describeSlot(updated)}, ${ch.guests} guests`, ip);
      const clashes = await findClashes(env, updated.date, updated.start_hour, updated.end_hour, id);
      return json({ booking: adminBooking(await loadBooking(env, id)), emailed, clashes });
    } else if (action === 'approve') {
      if (b.status !== 'pending') throw conflict('Only pending requests can be approved.');
      // The approve form can carry a changed date/time, applied in the same step.
      const ch = slotChange(env, b, body);
      const date = ch ? ch.date : b.date, start = ch ? ch.start : b.start_hour, end = ch ? ch.end : b.end_hour, guests = ch ? ch.guests : b.guests;
      const clashes = await findClashes(env, date, start, end, b.id);
      if (clashes.length) throw conflict(`Those hours are already taken by ${clashes.map((c) => c.ref).join(', ')}. Pick other hours, reject this request or cancel the other booking first.`);
      const amount = body.amount === undefined || body.amount === '' ? (ch ? (end - start) * s.hourly_rate : b.amount) : Number(body.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) throw bad('Enter the amount as a whole number.');
      const payBy = s.pay_within_hours > 0 ? t + s.pay_within_hours * 3600 * 1000 : null;
      updated = await env.DB.prepare(`UPDATE bookings SET status = 'approved', date = ?, start_hour = ?, end_hour = ?, guests = ?, amount = ?, vendor_note = ?, pay_by = ?, decided_by = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND ${FREE_GUARD} RETURNING *`)
        .bind(date, start, end, guests, amount, note, payBy, a.id, t, id, ...guardArgs(id, date, start, end, await gapHours(env))).first();
      if (!updated) {
        const again = await findClashes(env, date, start, end, id);
        throw conflict(again.length ? `Those hours were just taken by ${again.map((c) => c.ref).join(', ')}. Pick other hours.` : 'This booking changed in the meantime. Reload and try again.');
      }
      if (ch) await audit(env, a.id, 'reschedule', `${b.ref}: ${ch.from} → ${describeSlot(updated)}, ${guests} guests`, ip);
      if (email) ctx.waitUntil(mail.approved(env, s, email, updated, ch && ch.timeChanged ? ch.from : null));
    } else if (action === 'reject') {
      if (b.status !== 'pending') throw conflict('Only pending requests can be rejected.');
      updated = await env.DB.prepare("UPDATE bookings SET status = 'rejected', vendor_note = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .bind(note, a.id, t, id).first();
      if (!updated) throw conflict('This booking changed in the meantime. Reload and try again.');
      if (email) ctx.waitUntil(mail.rejected(env, s, email, updated));
    } else if (action === 'confirm') {
      // From "slip uploaded", or straight from "approved" when the money came another way (cash, transfer seen in the bank app).
      if (!['slip_uploaded', 'approved'].includes(b.status)) throw conflict('Only approved bookings can be confirmed.');
      // How they paid: a slip means bank transfer; without one, staff choose (cash, transfer seen in the bank app, other).
      const method = body.paymentMethod || (b.slip_key ? 'bank_transfer' : '');
      if (!PAYMENT_METHODS[method]) throw bad('Choose how the customer paid.');
      try {
        updated = await env.DB.prepare("UPDATE bookings SET status = 'confirmed', vendor_note = ?, payment_method = ?, paid_at = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status IN ('slip_uploaded','approved') RETURNING *")
          .bind(note || b.vendor_note, method, t, a.id, t, id).first();
      } catch (e) {
        if (!/no such column|has no column named/i.test(String(e && e.message))) throw e;
        // Database not updated to migration 0004 yet: confirm anyway, without recording the method.
        updated = await env.DB.prepare("UPDATE bookings SET status = 'confirmed', vendor_note = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status IN ('slip_uploaded','approved') RETURNING *")
          .bind(note || b.vendor_note, a.id, t, id).first();
      }
      if (!updated) throw conflict('This booking changed in the meantime. Reload and try again.');
      if (email) ctx.waitUntil(mail.confirmed(env, s, email, updated));
    } else if (action === 'reject-slip') {
      if (b.status !== 'slip_uploaded') throw conflict('There is no slip waiting for review.');
      if (!note) throw bad('Tell the customer what was wrong with the slip.');
      // Give them a fresh payment window.
      const payBy = s.pay_within_hours > 0 ? t + s.pay_within_hours * 3600 * 1000 : null;
      updated = await env.DB.prepare("UPDATE bookings SET status = 'approved', vendor_note = ?, pay_by = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'slip_uploaded' RETURNING *")
        .bind(note, payBy, a.id, t, id).first();
      if (!updated) throw conflict('This booking changed in the meantime. Reload and try again.');
      if (email) ctx.waitUntil(mail.slipRejected(env, s, email, updated));
    } else if (action === 'cancel') {
      if (['cancelled', 'rejected', 'expired'].includes(b.status)) throw conflict('This booking is already closed.');
      updated = await env.DB.prepare("UPDATE bookings SET status = 'cancelled', vendor_note = ?, decided_by = ?, updated_at = ? WHERE id = ? RETURNING *")
        .bind(note, a.id, t, id).first();
      if (email && b.status !== 'blocked') ctx.waitUntil(mail.cancelledByVenue(env, s, email, updated));
    }
    await audit(env, a.id, action, `${b.ref}${action === 'confirm' && updated && PAYMENT_METHODS[updated.payment_method] ? ` (paid by ${PAYMENT_METHODS[updated.payment_method].toLowerCase()})` : ''}${note ? ': ' + note : ''}`, ip);
    return json({ booking: adminBooking(await loadBooking(env, id)) });
  }

  // ---------- customers ----------

  if (path === '/api/admin/users' && method === 'GET') {
    await requireAdmin(env, request);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const filter = url.searchParams.get('filter') || '';
    const where = [];
    const args = [];
    if (q) { where.push('(u.email LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (filter === 'suspended') where.push('u.suspended = 1');
    if (filter === 'unverified') where.push('u.email_verified = 0 AND u.suspended = 0');
    if (filter === 'noaccount') where.push('u.password_hash IS NULL AND u.google_sub IS NULL AND u.apple_sub IS NULL');
    const { results } = await env.DB.prepare(`SELECT u.*, ad.name AS sb_name,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) AS n_bookings,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('pending','approved','slip_uploaded','confirmed') AND b.date >= date('now')) AS n_upcoming
      FROM users u LEFT JOIN admins ad ON ad.id = u.suspended_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 300`).bind(...args).all();
    const total = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(suspended) AS s FROM users').first();
    return json({ users: results.map(adminUser), total: total.n, suspended: total.s || 0 });
  }

  const um = path.match(/^\/api\/admin\/users\/(\d+)(?:\/(suspend|unsuspend))?$/);
  if (um) {
    const a = await requireAdmin(env, request);
    const u = await env.DB.prepare(`SELECT u.*, ad.name AS sb_name FROM users u LEFT JOIN admins ad ON ad.id = u.suspended_by WHERE u.id = ?`).bind(Number(um[1])).first();
    if (!u) throw notFound('Customer not found.');
    if (!um[2] && method === 'GET') {
      const { results } = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.date DESC, b.start_hour DESC LIMIT 100`).bind(u.id).all();
      return json({ user: adminUser(u), bookings: results.map(adminBooking) });
    }
    if (method !== 'POST') throw notFound();
    const body = await readJson(request);
    if (um[2] === 'suspend') {
      const reason = noteOf({ note: body.reason });
      if (!reason) throw bad('Write a short reason. Only staff see it.');
      if (u.suspended) throw conflict('This account is already suspended.');
      await env.DB.prepare('UPDATE users SET suspended = 1, suspended_reason = ?, suspended_at = ?, suspended_by = ? WHERE id = ?').bind(reason, now(), a.id, u.id).run();
      await destroyAllSessions(env, 'user', u.id);
      await env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(u.id).run();
      let cancelled = 0;
      if (body.cancelPending) {
        const r = await env.DB.prepare("UPDATE bookings SET status = 'cancelled', vendor_note = ?, decided_by = ?, updated_at = ? WHERE user_id = ? AND status = 'pending'")
          .bind('Cancelled because the account was suspended.', a.id, now(), u.id).run();
        cancelled = (r.meta && r.meta.changes) || 0;
      }
      await audit(env, a.id, 'user_suspended', `${u.email}: ${reason}${cancelled ? ` (${cancelled} pending request${cancelled === 1 ? '' : 's'} cancelled)` : ''}`, ip);
      return json({ user: adminUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first()), cancelled });
    }
    if (um[2] === 'unsuspend') {
      if (!u.suspended) throw conflict('This account is not suspended.');
      await env.DB.prepare("UPDATE users SET suspended = 0, suspended_reason = '', suspended_at = NULL, suspended_by = NULL WHERE id = ?").bind(u.id).run();
      await audit(env, a.id, 'user_unsuspended', u.email, ip);
      return json({ user: adminUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first()) });
    }
  }

  // ---------- master admin only ----------

  if (path === '/api/admin/admins' && method === 'GET') {
    await requireMaster(env, request);
    const { results } = await env.DB.prepare('SELECT * FROM admins ORDER BY is_master DESC, username').all();
    return json({ admins: results.map(publicAdmin) });
  }

  if (path === '/api/admin/admins' && method === 'POST') {
    const m = await requireMaster(env, request);
    const body = await readJson(request);
    const username = String(body.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw bad('Username: 3–32 lowercase letters, numbers, dots, dashes or underscores.');
    if (!validPrehash(body.pw)) throw bad('Password could not be processed.');
    const exists = await env.DB.prepare('SELECT id FROM admins WHERE username = ?').bind(username).first();
    if (exists) throw conflict('That username is taken.');
    const a = await env.DB.prepare('INSERT INTO admins (username, name, email, password_hash, is_master, must_change, created_at) VALUES (?,?,?,?,0,1,?) RETURNING *')
      .bind(username, String(body.name || username).slice(0, 80), String(body.email || '').slice(0, 190), await hashPassword(env, body.pw), now()).first();
    await audit(env, m.id, 'admin_added', username, ip);
    return json({ admin: publicAdmin(a) }, 201);
  }

  const am = path.match(/^\/api\/admin\/admins\/(\d+)\/(update|reset-password|make-master|delete)$/);
  if (am && method === 'POST') {
    const m = await requireMaster(env, request);
    const target = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(Number(am[1])).first();
    if (!target) throw notFound('Admin not found.');
    const body = await readJson(request);
    const self = target.id === m.id;

    if (am[2] === 'update') {
      const active = body.active === undefined ? target.active : body.active ? 1 : 0;
      if (self && !active) throw bad("You can't disable your own account.");
      await env.DB.prepare('UPDATE admins SET name = ?, email = ?, active = ? WHERE id = ?')
        .bind(String(body.name ?? target.name).slice(0, 80), String(body.email ?? target.email).slice(0, 190), active, target.id).run();
      if (!active) await destroyAllSessions(env, 'admin', target.id);
      await audit(env, m.id, active ? 'admin_updated' : 'admin_disabled', target.username, ip);
    } else if (am[2] === 'reset-password') {
      if (self) throw bad('Use "Change password" for your own account.');
      if (!validPrehash(body.pw)) throw bad('Password could not be processed.');
      await env.DB.prepare('UPDATE admins SET password_hash = ?, must_change = 1 WHERE id = ?').bind(await hashPassword(env, body.pw), target.id).run();
      await destroyAllSessions(env, 'admin', target.id);
      await audit(env, m.id, 'admin_password_reset', target.username, ip);
    } else if (am[2] === 'make-master') {
      // Handing over the master role needs the current master's password.
      if (self) throw bad('You are already the master admin.');
      if (!target.active) throw bad('Enable this admin first.');
      if (!validPrehash(body.pw)) throw bad('Enter your password to confirm.');
      await hit(env, `apw:${m.id}`, 6);
      const { ok } = await verifyPassword(env, body.pw, m.password_hash);
      if (!ok) throw unauthorized('Your password is incorrect.');
      await env.DB.batch([
        env.DB.prepare('UPDATE admins SET is_master = 1 WHERE id = ?').bind(target.id),
        env.DB.prepare('UPDATE admins SET is_master = 0 WHERE id = ?').bind(m.id),
      ]);
      await audit(env, m.id, 'master_transferred', `to ${target.username}`, ip);
    } else if (am[2] === 'delete') {
      if (self || target.is_master) throw bad("The master admin can't be removed.");
      await destroyAllSessions(env, 'admin', target.id);
      await env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(target.id).run();
      await audit(env, m.id, 'admin_removed', target.username, ip);
    }
    const fresh = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(target.id).first();
    return json({ admin: fresh ? publicAdmin(fresh) : null });
  }

  if (path === '/api/admin/settings' && method === 'GET') {
    await requireAdmin(env, request);
    const provider = emailProvider(env);
    return json({ settings: await getSettings(env), email: { provider, from: provider === 'gmail' ? env.GMAIL_USER : provider === 'resend' ? env.MAIL_FROM : null } });
  }

  if (path === '/api/admin/test-email' && method === 'POST') {
    const a = await requireAdmin(env, request);
    const body = await readJson(request);
    const s = await getSettings(env);
    const to = String(body.to || s.notify_email || a.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw bad('Enter the email address to send the test to.');
    await hit(env, `testmail:${a.id}`, 5);
    const r = await mail.test(env, to);
    await audit(env, a.id, 'test_email', `${to}${r.ok ? '' : ' (failed)'}`, ip);
    if (!r.ok) throw new HttpError(502, r.error || 'The email could not be sent.', 'email_failed');
    return json({ ok: true, to, provider: r.provider });
  }

  if (path === '/api/admin/settings' && method === 'POST') {
    const m = await requireMaster(env, request);
    const body = await readJson(request);
    const stmts = [];
    const changed = [];
    for (const k of Object.keys(SETTING_DEFAULTS)) {
      if (body[k] === undefined) continue;
      let v = String(body[k]).trim();
      if (NUMERIC_SETTINGS.includes(k)) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw bad(`${k.replace(/_/g, ' ')} must be a whole number.`);
        v = String(n);
      } else v = v.slice(0, 400);
      stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v));
      changed.push(k);
    }
    if (body.gap_hours !== undefined) {
      const g = Number(body.gap_hours);
      if (!Number.isInteger(g) || g < 0 || g > 12) throw bad('Gap between bookings: 0 to 12 hours.');
    }
    if (body.admin_idle_minutes !== undefined) {
      const m = Number(body.admin_idle_minutes);
      if (!Number.isInteger(m) || m < 5 || m > 480) throw bad('Sign out after: between 5 and 480 minutes.');
    }
    const open = Number(body.open_hour ?? (await getSettings(env)).open_hour);
    const close = Number(body.close_hour ?? (await getSettings(env)).close_hour);
    if (open < 0 || close > 24 || close <= open) throw bad('Closing hour must be after opening hour (0–24).');
    if (stmts.length) await env.DB.batch(stmts);
    await audit(env, m.id, 'settings', changed.join(', '), ip);
    return json({ settings: await getSettings(env) });
  }

  if (path === '/api/admin/audit' && method === 'GET') {
    await requireMaster(env, request);
    const { results } = await env.DB.prepare('SELECT l.*, a.username FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.at DESC LIMIT 200').all();
    return json({ entries: results });
  }

  return null;
}
