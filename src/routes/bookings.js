// Public availability, customer booking requests, bank slip upload.
import { json, readJson, bad, forbidden, notFound, conflict, clientIp } from '../lib/http.js';
import { now, getSettings, venueToday, venueHourNow, isDate, HOLDING, expireUnpaid, findClashes, newRef, hit } from '../lib/core.js';
import { requireUser, googleEnabled, appleEnabled } from './auth.js';
import { mail } from '../lib/email.js';

export const EVENT_TYPES = ['Wedding', 'Engagement', 'Birthday', 'Baby shower', 'Party', 'Corporate', 'Workshop', 'Other'];
const MAX_SLIP = 5 * 1024 * 1024;
const MONTHS_AHEAD = 18;

export function publicBooking(b) {
  return {
    id: b.id, ref: b.ref, eventType: b.event_type, date: b.date, start: b.start_hour, end: b.end_hour,
    guests: b.guests, notes: b.notes, status: b.status, amount: b.amount, vendorNote: b.vendor_note,
    payBy: b.pay_by, hasSlip: !!b.slip_key, slipAt: b.slip_at, createdAt: b.created_at, updatedAt: b.updated_at,
  };
}

function sniffSlip(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return null;
}

export async function serveSlip(env, booking) {
  if (!booking.slip_key) throw notFound('No slip uploaded yet.');
  const v = await env.SLIPS.get(booking.slip_key, { type: 'arrayBuffer' });
  if (!v) throw notFound('The slip file is missing.');
  return new Response(v, {
    headers: {
      'content-type': booking.slip_type || 'application/octet-stream',
      'content-disposition': `inline; filename="${booking.ref}-slip.${(booking.slip_type || '').split('/')[1] || 'bin'}"`,
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
}

export function validateSlot(s, env, { date, start, end }) {
  if (!isDate(date)) throw bad('Pick a date.');
  start = Number(start); end = Number(end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw bad('Pick a start and end time.');
  if (start < s.open_hour || end > s.close_hour || end <= start) throw bad(`Bookings run between the opening hours, ending after they start.`);
  if (end - start < s.min_hours) throw bad(`The minimum booking is ${s.min_hours} hours.`);
  const today = venueToday(env);
  if (date < today) throw bad('That date has passed.');
  if (date === today && start <= venueHourNow(env)) throw bad('That time has already started today.');
  const limit = new Date(); limit.setUTCMonth(limit.getUTCMonth() + MONTHS_AHEAD);
  if (date > limit.toISOString().slice(0, 10)) throw bad(`We take bookings up to ${MONTHS_AHEAD} months ahead.`);
  return { date, start, end };
}

export async function handleBookings(request, env, ctx, url, path) {
  const method = request.method;

  if (path === '/api/config' && method === 'GET') {
    const s = await getSettings(env);
    return json({
      googleEnabled: googleEnabled(env), appleEnabled: appleEnabled(env), openHour: s.open_hour, closeHour: s.close_hour,
      minHours: s.min_hours, maxGuests: s.max_guests, hourlyRate: s.hourly_rate, currency: s.currency, today: venueToday(env),
      nowHour: venueHourNow(env), eventTypes: EVENT_TYPES, monthsAhead: MONTHS_AHEAD,
    });
  }

  // Public: which hours are taken. Never exposes who booked them.
  if (path === '/api/availability' && method === 'GET') {
    const month = url.searchParams.get('month');
    if (!/^\d{4}-\d{2}$/.test(month || '')) throw bad('month must be YYYY-MM');
    await expireUnpaid(env);
    const { results } = await env.DB.prepare(
      `SELECT date, start_hour, end_hour, status FROM bookings WHERE date LIKE ? AND status IN ('pending','approved','slip_uploaded','confirmed','blocked') ORDER BY date, start_hour`
    ).bind(`${month}-%`).all();
    const days = {};
    for (const r of results) {
      const d = (days[r.date] ||= { booked: [], requested: [] });
      (HOLDING.includes(r.status) ? d.booked : d.requested).push([r.start_hour, r.end_hour]);
    }
    return new Response(JSON.stringify({ month, days }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  if (path === '/api/bookings' && method === 'GET') {
    const u = await requireUser(env, request);
    await expireUnpaid(env);
    const { results } = await env.DB.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY date DESC, start_hour DESC LIMIT 100').bind(u.id).all();
    const s = await getSettings(env);
    return json({
      bookings: results.map(publicBooking),
      payment: { bankName: s.bank_name, accountName: s.account_name, accountNumber: s.account_number, note: s.payment_note, currency: s.currency },
    });
  }

  if (path === '/api/bookings' && method === 'POST') {
    const u = await requireUser(env, request);
    if (!u.email_verified) throw forbidden('Confirm your email first. We sent you a link when you signed up.');
    const body = await readJson(request);
    const s = await getSettings(env);
    const slot = validateSlot(s, env, body);
    const eventType = EVENT_TYPES.includes(body.eventType) ? body.eventType : null;
    if (!eventType) throw bad('Pick an event type.');
    const guests = Number(body.guests);
    if (!Number.isInteger(guests) || guests < 1 || guests > s.max_guests) throw bad(`Guests must be between 1 and ${s.max_guests}.`);
    const notes = String(body.notes || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 1000);
    await hit(env, `book:${u.id}`, 10);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'pending'").bind(u.id).first();
    if (open.n >= 5) throw conflict('You already have 5 requests waiting. Wait for a reply or cancel one first.');
    await expireUnpaid(env);
    const clashes = await findClashes(env, slot.date, slot.start, slot.end);
    if (clashes.length) throw conflict('Those hours are already booked. Pick another time.', 'taken');
    const t = now();
    const amount = (slot.end - slot.start) * s.hourly_rate;
    const b = await env.DB.prepare(
      `INSERT INTO bookings (ref, user_id, event_type, date, start_hour, end_hour, guests, notes, status, amount, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?) RETURNING *`
    ).bind(newRef(), u.id, eventType, slot.date, slot.start, slot.end, guests, notes, amount, t, t).first();
    ctx.waitUntil(mail.requested(env, s, u.email, b));
    ctx.waitUntil(mail.vendorNewRequest(env, s, b, u));
    return json({ booking: publicBooking(b) }, 201);
  }

  const m = path.match(/^\/api\/bookings\/(\d+)\/(cancel|slip)$/);
  if (m) {
    const u = await requireUser(env, request);
    const b = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').bind(Number(m[1]), u.id).first();
    if (!b) throw notFound('Booking not found.');

    if (m[2] === 'cancel' && method === 'POST') {
      if (!['pending', 'approved'].includes(b.status)) throw conflict('This booking can no longer be cancelled online. Contact us.');
      const r = await env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? RETURNING *").bind(now(), b.id).first();
      return json({ booking: publicBooking(r) });
    }

    if (m[2] === 'slip' && method === 'GET') return serveSlip(env, b);

    if (m[2] === 'slip' && method === 'POST') {
      await expireUnpaid(env);
      const fresh = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
      if (fresh.status !== 'approved') {
        throw conflict(fresh.status === 'expired' ? 'The payment deadline passed. Contact us to rebook.' : 'This booking is not waiting for a slip.');
      }
      await hit(env, `slip:${u.id}`, 10);
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_SLIP + 20000) throw bad('The file is larger than 5 MB.');
      const form = await request.formData();
      const file = form.get('slip');
      if (!file || typeof file === 'string') throw bad('Choose a file to upload.');
      if (file.size > MAX_SLIP) throw bad('The file is larger than 5 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = sniffSlip(bytes);
      if (!type) throw bad('Upload a JPG, PNG, WebP or PDF.');
      if (fresh.slip_key) ctx.waitUntil(env.SLIPS.delete(fresh.slip_key));
      const key = `slip/${fresh.ref}/${now()}`;
      await env.SLIPS.put(key, bytes, { metadata: { type, booking: fresh.ref } });
      const r = await env.DB.prepare("UPDATE bookings SET status = 'slip_uploaded', slip_key = ?, slip_type = ?, slip_at = ?, updated_at = ? WHERE id = ? RETURNING *")
        .bind(key, type, now(), now(), fresh.id).first();
      const s = await getSettings(env);
      ctx.waitUntil(mail.vendorSlip(env, s, r, u));
      return json({ booking: publicBooking(r) });
    }
  }

  return null;
}
