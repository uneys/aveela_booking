// Public availability, customer booking requests, bank slip upload.
import { json, readJson, bad, forbidden, notFound, conflict, clientIp, HttpError } from '../lib/http.js';
import { now, getSettings, venueToday, venueHourNow, isDate, HOLDING, expireUnpaid, findClashes, newRef, hit, describeSlot, gapHours } from '../lib/core.js';
import { requireUser, googleEnabled, appleEnabled } from './auth.js';
import { mail, statusEmail } from '../lib/email.js';

export const EVENT_TYPES = ['Wedding', 'Engagement', 'Birthday', 'Baby shower', 'Party', 'Corporate', 'Workshop', 'Other'];
// Where a booking request came from. 'website' is set automatically; the rest are for manual bookings.
export const SOURCES = ['Phone call', 'WhatsApp', 'Viber', 'Instagram', 'Facebook', 'Email', 'Walk-in', 'Other'];
const MAX_SLIP = 5 * 1024 * 1024;
const MONTHS_AHEAD = 18;

export function publicBooking(b) {
  return {
    id: b.id, ref: b.ref, eventType: b.event_type, date: b.date, start: b.start_hour, end: b.end_hour,
    guests: b.guests, notes: b.notes, status: b.status, amount: b.amount, vendorNote: b.vendor_note,
    payBy: b.pay_by, hasSlip: !!b.slip_key, slipAt: b.slip_at, createdAt: b.created_at, updatedAt: b.updated_at,
    source: b.source || 'website',
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

// Reads and checks an uploaded slip from a multipart form field named "slip".
export async function readSlipUpload(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_SLIP + 20000) throw bad('The file is larger than 5 MB.');
  const form = await request.formData();
  const file = form.get('slip');
  if (!file || typeof file === 'string') throw bad('Choose a file to upload.');
  if (file.size > MAX_SLIP) throw bad('The file is larger than 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffSlip(bytes);
  if (!type) throw bad('Upload a JPG, PNG, WebP or PDF.');
  return { bytes, type };
}

// Saves a slip in KV (replacing any earlier one) and returns its key.
export async function storeSlip(env, ctx, booking, { bytes, type }) {
  if (booking.slip_key) ctx.waitUntil(env.SLIPS.delete(booking.slip_key));
  const key = `slip/${booking.ref}/${now()}`;
  await env.SLIPS.put(key, bytes, { metadata: { type, booking: booking.ref } });
  return key;
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
      nowHour: venueHourNow(env), eventTypes: EVENT_TYPES, sources: SOURCES, monthsAhead: MONTHS_AHEAD, gapHours: s.gap_hours,
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
    const g = await gapHours(env);
    for (const r of results) {
      const d = (days[r.date] ||= { booked: [], requested: [] });
      // Held bookings also block the set-up/cleaning gap on either side.
      if (HOLDING.includes(r.status)) d.booked.push([Math.max(0, r.start_hour - g), Math.min(24, r.end_hour + g)]);
      else d.requested.push([r.start_hour, r.end_hour]);
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

  const m = path.match(/^\/api\/bookings\/(\d+)\/(cancel|slip|resend-email|change)$/);
  if (m) {
    const u = await requireUser(env, request);
    const b = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').bind(Number(m[1]), u.id).first();
    if (!b) throw notFound('Booking not found.');

    // Customers can change the date, hours or guests while the request is still waiting.
    if (m[2] === 'change' && method === 'POST') {
      if (b.status !== 'pending') throw conflict('This request was already answered, so it can no longer be changed online. Contact us instead.');
      const body = await readJson(request);
      const s = await getSettings(env);
      const slot = validateSlot(s, env, { date: body.date, start: body.start, end: body.end });
      const guests = Number(body.guests ?? b.guests);
      if (!Number.isInteger(guests) || guests < 1 || guests > s.max_guests) throw bad(`Guests must be between 1 and ${s.max_guests}.`);
      if (slot.date === b.date && slot.start === b.start_hour && slot.end === b.end_hour && guests === b.guests) throw bad('Nothing changed.');
      await hit(env, `change:${u.id}`, 10);
      await expireUnpaid(env);
      if ((await findClashes(env, slot.date, slot.start, slot.end, b.id)).length) throw conflict('Those hours are already booked. Pick another time.', 'taken');
      const from = describeSlot(b);
      const r = await env.DB.prepare("UPDATE bookings SET date = ?, start_hour = ?, end_hour = ?, guests = ?, amount = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .bind(slot.date, slot.start, slot.end, guests, (slot.end - slot.start) * s.hourly_rate, now(), b.id).first();
      if (!r) throw conflict('This request changed in the meantime. Reload and try again.');
      ctx.waitUntil(mail.vendorChanged(env, s, r, u, from));
      return json({ booking: publicBooking(r) });
    }

    if (m[2] === 'cancel' && method === 'POST') {
      if (!['pending', 'approved'].includes(b.status)) throw conflict('This booking can no longer be cancelled online. Contact us.');
      const r = await env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? RETURNING *").bind(now(), b.id).first();
      return json({ booking: publicBooking(r) });
    }

    if (m[2] === 'slip' && method === 'GET') return serveSlip(env, b);

    // Customer asks for the latest email about this booking again (e.g. confirmation went to spam).
    if (m[2] === 'resend-email' && method === 'POST') {
      if (!['pending', 'approved', 'confirmed'].includes(b.status)) throw bad('There is no email to resend for this booking.');
      await hit(env, `resend:user:${u.id}`, 3);
      const which = statusEmail(b);
      const r = await which.send(env, await getSettings(env), u.email, b);
      if (!r.ok) throw new HttpError(502, "We couldn't send the email right now. Try again later or contact us.", 'email_failed');
      return json({ ok: true, sent: which.label, to: u.email });
    }

    if (m[2] === 'slip' && method === 'POST') {
      await expireUnpaid(env);
      const fresh = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
      if (fresh.status !== 'approved') {
        throw conflict(fresh.status === 'expired' ? 'The payment deadline passed. Contact us to rebook.' : 'This booking is not waiting for a slip.');
      }
      await hit(env, `slip:${u.id}`, 10);
      const upload = await readSlipUpload(request);
      const type = upload.type;
      const key = await storeSlip(env, ctx, fresh, upload);
      const r = await env.DB.prepare("UPDATE bookings SET status = 'slip_uploaded', slip_key = ?, slip_type = ?, slip_at = ?, updated_at = ? WHERE id = ? RETURNING *")
        .bind(key, type, now(), now(), fresh.id).first();
      const s = await getSettings(env);
      ctx.waitUntil(mail.vendorSlip(env, s, r, u));
      return json({ booking: publicBooking(r) });
    }
  }

  return null;
}
