// Minimal SMTP client for sending through Gmail (smtp.gmail.com:465, implicit TLS) from a
// Cloudflare Worker or Pages Function, using Cloudflare's TCP sockets. No dependencies.
// Gmail needs an App Password (Google account → Security → 2-Step Verification → App passwords).
import { b64 } from './crypto.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8b64 = (s) => b64(enc.encode(String(s)));

// RFC 2047 for non-ASCII header text (subjects, names).
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8b64(s)}?=`;
}

function wrap76(s) {
  return s.replace(/.{1,76}/g, '$&\r\n');
}

function cleanAddr(a) {
  const v = String(a || '').trim();
  if (!/^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(v)) throw new Error(`Invalid email address: ${v}`);
  return v;
}

export function buildMime({ fromName, fromAddr, to, subject, text, html, replyTo }) {
  const boundary = 'av-' + crypto.randomUUID();
  const domain = fromAddr.split('@')[1];
  const headers = [
    `From: ${encodeHeader(fromName)} <${fromAddr}>`,
    `To: <${to}>`,
    replyTo ? `Reply-To: <${cleanAddr(replyTo)}>` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  // Base64 bodies: no long lines, and no line can start with "." (so no dot-stuffing issues).
  return [
    headers.join('\r\n'), '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(utf8b64(text || '')),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(utf8b64(html || '')),
    `--${boundary}--`, '',
  ].join('\r\n');
}

export async function smtpSend({ host = 'smtp.gmail.com', port = 465, user, pass, from, to, raw, timeoutMs = 20000 }) {
  // Tests can swap the socket in; on Cloudflare this is the real TCP socket API.
  const connect = globalThis.__aveelaSmtpConnect || (await import('cloudflare:sockets')).connect;
  const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buf = '';

  async function reply(expect) {
    for (;;) {
      const lines = buf.split('\r\n');
      // A reply is complete when a line has a space after the 3-digit code ("250 OK").
      const end = lines.findIndex((l) => /^\d{3} /.test(l));
      if (end >= 0) {
        const text = lines.slice(0, end + 1).join('\n');
        buf = lines.slice(end + 1).join('\r\n');
        const code = Number(text.slice(text.lastIndexOf('\n') + 1, text.lastIndexOf('\n') + 4));
        if (!expect.includes(code)) throw new Error(`Mail server said: ${text.replace(/\n/g, ' ').slice(0, 300)}`);
        return code;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('Mail server closed the connection.');
      buf += dec.decode(value, { stream: true });
    }
  }
  const send = (line) => writer.write(enc.encode(line + '\r\n'));

  const work = (async () => {
    await reply([220]);
    await send('EHLO aveela'); await reply([250]);
    await send('AUTH PLAIN ' + utf8b64(`\0${user}\0${pass}`)); await reply([235]);
    await send(`MAIL FROM:<${cleanAddr(from)}>`); await reply([250]);
    await send(`RCPT TO:<${cleanAddr(to)}>`); await reply([250, 251]);
    await send('DATA'); await reply([354]);
    await writer.write(enc.encode(raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.\r\n'));
    await reply([250]);
    await send('QUIT');
    try { await reply([221]); } catch {}
  })();

  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Mail server did not answer in time.')), timeoutMs); });
  try {
    await Promise.race([work, timeout]);
  } catch (e) {
    const m = String(e.message || e);
    if (/\b535\b/.test(m)) throw new Error('Gmail rejected the sign-in. Use a Google App Password (not your normal password) and check GMAIL_USER.');
    if (/\b550 5\.4\.5\b|quota/i.test(m)) throw new Error('Gmail daily sending limit reached. It resets within 24 hours.');
    throw e;
  } finally {
    clearTimeout(timer);
    try { await writer.close(); } catch {}
    try { socket.close(); } catch {}
  }
}
