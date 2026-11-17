// Transactional email. Two ways to send, picked automatically:
//   1. Gmail: set GMAIL_USER and GMAIL_APP_PASSWORD (sends through smtp.gmail.com, 500 recipients/day free)
//   2. Resend: set RESEND_API_KEY (needs your own domain)
// With neither, emails are written to the logs instead of sent, so local testing still works.
// Set EMAIL_PROVIDER=gmail or EMAIL_PROVIDER=resend to force one when both are configured.
import { fmtDate, fmtHour, money } from './core.js';
import { buildMime, smtpSend } from './smtp.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function emailProvider(env) {
  const gmail = !!(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);
  const resend = !!env.RESEND_API_KEY;
  const want = String(env.EMAIL_PROVIDER || '').toLowerCase();
  if (want === 'gmail' && gmail) return 'gmail';
  if (want === 'resend' && resend) return 'resend';
  return gmail ? 'gmail' : resend ? 'resend' : null;
}

// "Aveela Event Space <bookings@x.com>" -> { name, addr }
function parseFrom(v) {
  const m = String(v || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), addr: m[2].trim() } : { name: '', addr: String(v || '').trim() };
}

export async function sendEmail(env, { to, subject, html, text, replyTo }) {
  if (!to) return { ok: false, skipped: true, error: 'No email address.' };
  const provider = emailProvider(env);
  if (!provider) {
    console.log(`[email not sent: no email provider set] to=${to} subject=${subject}\n${text}`);
    return { ok: false, skipped: true, error: 'Email sending is not set up yet (add the Gmail or Resend secrets).' };
  }
  const from = parseFrom(env.MAIL_FROM);
  try {
    if (provider === 'gmail') {
      const user = String(env.GMAIL_USER).trim();
      // Gmail always sends as the signed-in account, so only the display name comes from MAIL_FROM.
      const raw = buildMime({ fromName: from.name || 'Aveela Event Space', fromAddr: user, to, subject, text, html, replyTo });
      await smtpSend({ user, pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, ''), from: user, to, raw });
      return { ok: true, provider };
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html, text, reply_to: replyTo || undefined }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log('Resend error', res.status, body);
      return { ok: false, provider, error: `Resend refused the email (${res.status}). ${body.slice(0, 200)}` };
    }
    return { ok: true, provider };
  } catch (e) {
    console.log(`${provider} send failed`, e && e.message);
    return { ok: false, provider, error: String((e && e.message) || e) };
  }
}

function layout(env, title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f3f1ec;font-family:Helvetica,Arial,sans-serif;color:#18223a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
  <tr><td style="background:#18223a;color:#f5f1ea;padding:22px 28px;font-family:Georgia,serif;font-size:22px">Aveela Event Space</td></tr>
  <tr><td style="padding:28px">
  <h1 style="font-family:Georgia,serif;font-weight:normal;font-size:24px;margin:0 0 16px">${esc(title)}</h1>
  ${bodyHtml}
  </td></tr>
  <tr><td style="padding:18px 28px;background:#f8f6f2;font-size:12px;color:#6b7280">You're receiving this because of a booking or account at ${esc(env.APP_URL)}.</td></tr>
  </table></td></tr></table></body></html>`;
}

const p = (t) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px">${t}</p>`;
const button = (href, label) => `<p style="margin:22px 0"><a href="${esc(href)}" style="background:#18223a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:15px;display:inline-block">${esc(label)}</a></p>`;

function bookingTable(s, b) {
  const rows = [
    ['Reference', b.ref],
    ['Event', b.event_type],
    ['Date', fmtDate(b.date)],
    ['Time', `${fmtHour(b.start_hour)} to ${fmtHour(b.end_hour)}`],
    ['Guests', String(b.guests)],
  ];
  if (b.amount) rows.push(['Amount', money(s, b.amount)]);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:6px 0 18px;font-size:14px">${rows
    .map(([k, v]) => `<tr><td style="padding:8px 0;border-top:1px solid #eee;color:#6b7280;width:38%">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid #eee">${esc(v)}</td></tr>`)
    .join('')}</table>`;
}

function bookingText(s, b) {
  return `Reference: ${b.ref}\nEvent: ${b.event_type}\nDate: ${fmtDate(b.date)}\nTime: ${fmtHour(b.start_hour)} to ${fmtHour(b.end_hour)}\nGuests: ${b.guests}${b.amount ? `\nAmount: ${money(s, b.amount)}` : ''}`;
}

// Which email goes with a booking's current status (used by the "resend email" buttons).
export function statusEmail(b) {
  switch (b.status) {
    case 'pending': return { label: 'request received', send: mail.requested };
    case 'approved': return b.slip_key ? { label: 'new slip request', send: mail.slipRejected } : { label: 'payment details', send: mail.approved };
    case 'confirmed': return { label: 'booking confirmation', send: mail.confirmed };
    case 'rejected': return { label: 'declined', send: mail.rejected };
    case 'cancelled': return { label: 'cancellation', send: mail.cancelledByVenue };
    default: return null;
  }
}

export const mail = {
  verify(env, to, name, link) {
    return sendEmail(env, {
      to, subject: 'Confirm your email for Aveela',
      html: layout(env, 'Confirm your email', p(`Hi ${esc(name || 'there')}, confirm your email so you can request bookings.`) + button(link, 'Confirm email') + p('This link works for 24 hours.')),
      text: `Hi ${name || 'there'},\n\nConfirm your email so you can request bookings:\n${link}\n\nThis link works for 24 hours.`,
    });
  },
  reset(env, to, link) {
    return sendEmail(env, {
      to, subject: 'Reset your Aveela password',
      html: layout(env, 'Reset your password', p('Someone asked to reset the password for this account. If it was you, choose a new password:') + button(link, 'Choose a new password') + p("This link works for 1 hour. If you didn't ask, you can ignore this email.")),
      text: `Reset your password:\n${link}\n\nThis link works for 1 hour. If you didn't ask, ignore this email.`,
    });
  },
  requested(env, s, to, b) {
    return sendEmail(env, {
      to, subject: `We got your request ${b.ref}`,
      html: layout(env, 'Request received', p("Thanks! We'll check the date and reply soon. You'll get an email when we approve or decline it.") + bookingTable(s, b) + button(`${env.APP_URL}/account`, 'View my bookings')),
      text: `Thanks! We'll check the date and reply soon.\n\n${bookingText(s, b)}\n\n${env.APP_URL}/account`,
    });
  },
  approved(env, s, to, b) {
    const bank = [s.bank_name && `Bank: ${s.bank_name}`, s.account_name && `Account name: ${s.account_name}`, s.account_number && `Account number: ${s.account_number}`].filter(Boolean);
    const deadline = b.pay_by ? new Date(b.pay_by).toLocaleString('en-GB', { timeZone: env.VENUE_TZ || 'Indian/Maldives', dateStyle: 'full', timeStyle: 'short' }) : '';
    return sendEmail(env, {
      to, subject: `Approved: ${b.ref}. Please complete payment`,
      html: layout(env, 'Your booking is approved',
        p(`Great news, your date is approved. To lock it in, transfer <strong>${esc(money(s, b.amount))}</strong> and upload the bank slip${deadline ? ` by <strong>${esc(deadline)}</strong>` : ''}.`) +
        bookingTable(s, b) +
        (bank.length ? `<p style="font-size:15px;line-height:1.7;margin:0 0 14px;background:#f8f6f2;padding:14px 16px;border-radius:10px">${bank.map(esc).join('<br>')}</p>` : '') +
        (s.payment_note ? p(esc(s.payment_note)) : '') +
        (b.vendor_note ? p(`Note from us: ${esc(b.vendor_note)}`) : '') +
        button(`${env.APP_URL}/account`, 'Upload bank slip')),
      text: `Your booking is approved. Transfer ${money(s, b.amount)} and upload the bank slip${deadline ? ` by ${deadline}` : ''}.\n\n${bookingText(s, b)}\n\n${bank.join('\n')}\n${s.payment_note || ''}\n${b.vendor_note ? 'Note from us: ' + b.vendor_note : ''}\n\nUpload the slip: ${env.APP_URL}/account`,
    });
  },
  rejected(env, s, to, b) {
    return sendEmail(env, {
      to, subject: `About your request ${b.ref}`,
      html: layout(env, "We can't host this booking", p("Sorry, we can't take this request.") + (b.vendor_note ? p(`Reason: ${esc(b.vendor_note)}`) : '') + bookingTable(s, b) + button(`${env.APP_URL}/#book`, 'Pick another date')),
      text: `Sorry, we can't take this request.${b.vendor_note ? '\nReason: ' + b.vendor_note : ''}\n\n${bookingText(s, b)}`,
    });
  },
  slipRejected(env, s, to, b) {
    return sendEmail(env, {
      to, subject: `Please upload a new slip for ${b.ref}`,
      html: layout(env, 'We need a new bank slip', p("We couldn't match the slip you uploaded to the payment.") + (b.vendor_note ? p(`Reason: ${esc(b.vendor_note)}`) : '') + bookingTable(s, b) + button(`${env.APP_URL}/account`, 'Upload a new slip')),
      text: `We couldn't match your slip to the payment.${b.vendor_note ? '\nReason: ' + b.vendor_note : ''}\n\n${bookingText(s, b)}\n\n${env.APP_URL}/account`,
    });
  },
  confirmed(env, s, to, b) {
    return sendEmail(env, {
      to, subject: `Confirmed: ${b.ref} on ${fmtDate(b.date)}`,
      html: layout(env, 'Your booking is confirmed', p("Payment received. Your date is confirmed and the venue is yours for these hours. We can't wait to host you!") + bookingTable(s, b) + (b.vendor_note ? p(`Note from us: ${esc(b.vendor_note)}`) : '') + p('Keep this email as your booking confirmation.')),
      text: `Payment received. Your booking is confirmed.\n\n${bookingText(s, b)}${b.vendor_note ? '\n\nNote from us: ' + b.vendor_note : ''}\n\nKeep this email as your confirmation.`,
    });
  },
  cancelledByVenue(env, s, to, b) {
    return sendEmail(env, {
      to, subject: `Booking ${b.ref} was cancelled`,
      html: layout(env, 'Your booking was cancelled', p('We had to cancel this booking.') + (b.vendor_note ? p(`Reason: ${esc(b.vendor_note)}`) : '') + bookingTable(s, b) + p('Reply to this email if you have questions.')),
      text: `We had to cancel this booking.${b.vendor_note ? '\nReason: ' + b.vendor_note : ''}\n\n${bookingText(s, b)}`,
    });
  },
  vendorNewRequest(env, s, b, customer) {
    return sendEmail(env, {
      to: s.notify_email, subject: `New booking request ${b.ref} for ${fmtDate(b.date)}`, replyTo: customer.email,
      html: layout(env, 'New booking request', p(`${esc(customer.name)} (${esc(customer.email)}) asked for:`) + bookingTable(s, b) + (b.notes ? p(`Notes: ${esc(b.notes)}`) : '') + button(`${env.APP_URL}/admin`, 'Open admin panel')),
      text: `${customer.name} (${customer.email}) asked for:\n${bookingText(s, b)}\n${b.notes ? 'Notes: ' + b.notes : ''}\n\n${env.APP_URL}/admin`,
    });
  },
  test(env, to) {
    return sendEmail(env, {
      to, subject: 'Test email from your Aveela booking site',
      html: layout(env, 'Email is working', p('This is a test from the admin panel. If you can read this, booking emails will reach your customers.')),
      text: 'This is a test from the admin panel. If you can read this, booking emails will reach your customers.',
    });
  },
  vendorSlip(env, s, b, customer) {
    return sendEmail(env, {
      to: s.notify_email, subject: `Bank slip uploaded for ${b.ref}`,
      html: layout(env, 'Bank slip uploaded', p(`${esc(customer.name)} uploaded a payment slip. Check it and confirm the booking.`) + bookingTable(s, b) + button(`${env.APP_URL}/admin`, 'Review payment')),
      text: `${customer.name} uploaded a payment slip.\n${bookingText(s, b)}\n\n${env.APP_URL}/admin`,
    });
  },
};
