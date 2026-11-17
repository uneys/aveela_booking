// Vendor admin panel API. Every route here needs an admin session, except state/setup/login.
import { json, readJson, bad, unauthorized, forbidden, notFound, conflict, clientIp } from '../lib/http.js';
import { hashPassword, verifyPassword, dummyVerify, validPrehash, timingSafeEqual } from '../lib/crypto.js';
import {
  now, getSettings, SETTING_DEFAULTS, NUMERIC_SETTINGS, createSession, readSession, destroySession, destroyAllSessions,
  hit, peek, clearHits, audit, expireUnpaid, findClashes, newRef, isDate,
} from '../lib/core.js';
import { publicBooking, serveSlip } from './bookings.js';
import { mail } from '../lib/email.js';

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
  if (!a) throw unauthorized('Your admin session has ended. Sign in again.');
  if (a.must_change && !allowMustChange) throw forbidden('Set a new password before continuing.');
  return a;
}

async function requireMaster(env, request) {
  const a = await requireAdmin(env, request);
  if (!a.is_master) throw forbidden('Only the master admin can do this.');
  return a;
}

function adminBooking(b) {
  return { ...publicBooking(b), customer: b.user_id ? { id: b.user_id, name: b.u_name, email: b.u_email, phone: b.u_phone } : null, decidedBy: b.a_name || null };
}

const BOOKING_SELECT = `SELECT b.*, u.name AS u_name, u.email AS u_email, u.phone AS u_phone, a.name AS a_name
  FROM bookings b LEFT JOIN users u ON u.id = b.user_id LEFT JOIN admins a ON a.id = b.decided_by`;

async function loadBooking(env, id) {
  const b = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(id).first();
  if (!b) throw notFound('Booking not found.');
  return b;
}

const noteOf = (body) => String(body.note || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 600);

export async function handleAdmin(request, env, ctx, url, path) {
  const method = request.method;
  const ip = clientIp(request);

  if (path === '/api/admin/state' && method === 'GET') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    const a = await currentAdmin(env, request);
    return json({ needsSetup: count.n === 0, setupEnabled: !!env.SETUP_TOKEN, admin: a ? publicAdmin(a) : null });
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
    if (q) { where.push('(b.ref LIKE ? OR u.email LIKE ? OR u.name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const order = scope === 'upcoming' || status === 'pending' || status === 'slip_uploaded' ? 'b.date ASC, b.start_hour ASC' : 'b.date DESC, b.start_hour DESC';
    const sql = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 200`;
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ bookings: results.map(adminBooking) });
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
      VALUES (?,NULL,'Blocked',?,?,?,0,?,'blocked',?,?,?) RETURNING *`).bind(newRef(), date, start, end, noteOf({ note: body.reason }), a.id, t, t).first();
    await audit(env, a.id, 'block', `${b.ref} ${date} ${start}-${end}`, ip);
    return json({ booking: publicBooking(b) }, 201);
  }

  const bm = path.match(/^\/api\/admin\/bookings\/(\d+)(?:\/(approve|reject|confirm|reject-slip|cancel|slip))?$/);
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
    if (method !== 'POST' || !action) throw notFound();

    const body = await readJson(request);
    const note = noteOf(body);
    const s = await getSettings(env);
    const t = now();
    const email = b.u_email;
    let updated;

    if (action === 'approve') {
      if (b.status !== 'pending') throw conflict('Only pending requests can be approved.');
      const clashes = await findClashes(env, b.date, b.start_hour, b.end_hour, b.id);
      if (clashes.length) throw conflict(`Those hours are already taken by ${clashes.map((c) => c.ref).join(', ')}. Reject this request or cancel the other booking first.`);
      const amount = body.amount === undefined || body.amount === '' ? b.amount : Number(body.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) throw bad('Enter the amount as a whole number.');
      const payBy = s.pay_within_hours > 0 ? t + s.pay_within_hours * 3600 * 1000 : null;
      updated = await env.DB.prepare("UPDATE bookings SET status = 'approved', amount = ?, vendor_note = ?, pay_by = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .bind(amount, note, payBy, a.id, t, id).first();
      if (!updated) throw conflict('This booking changed in the meantime. Reload and try again.');
      if (email) ctx.waitUntil(mail.approved(env, s, email, updated));
    } else if (action === 'reject') {
      if (b.status !== 'pending') throw conflict('Only pending requests can be rejected.');
      updated = await env.DB.prepare("UPDATE bookings SET status = 'rejected', vendor_note = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .bind(note, a.id, t, id).first();
      if (!updated) throw conflict('This booking changed in the meantime. Reload and try again.');
      if (email) ctx.waitUntil(mail.rejected(env, s, email, updated));
    } else if (action === 'confirm') {
      if (b.status !== 'slip_uploaded') throw conflict('Only bookings with an uploaded slip can be confirmed.');
      updated = await env.DB.prepare("UPDATE bookings SET status = 'confirmed', vendor_note = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'slip_uploaded' RETURNING *")
        .bind(note || b.vendor_note, a.id, t, id).first();
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
    await audit(env, a.id, action, `${b.ref}${note ? ': ' + note : ''}`, ip);
    return json({ booking: adminBooking(await loadBooking(env, id)) });
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
    return json({ settings: await getSettings(env) });
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
