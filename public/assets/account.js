// Customer account page: sign in, my bookings, cancel, upload bank slip, profile, password reset.
(function () {
  const A = window.Aveela;
  const { esc } = A;
  const app = document.getElementById('app');
  const topnav = document.getElementById('topnav');
  const q = new URLSearchParams(location.search);
  let payment = null;

  function cleanUrl() { history.replaceState(null, '', '/account'); }

  function nav() {
    topnav.innerHTML = A.me
      ? '<a class="btn btn-ghost btn-sm" href="/#book">Book a date</a><button class="btn btn-ghost btn-sm" id="out" type="button">Sign out</button>'
      : '<a class="btn btn-ghost btn-sm" href="/">Back to site</a>';
    const out = document.getElementById('out');
    if (out) out.addEventListener('click', async () => {
      await A.api('POST', '/api/auth/logout').catch(() => {});
      A.me = null; nav(); signedOut();
    });
  }

  function signedOut(message) {
    app.innerHTML = `<h1>Your bookings</h1><p class="lede">${esc(message || 'Sign in to see your requests, pay and upload bank slips.')}</p><div class="acct-auth"></div>`;
    A.auth.render(app.querySelector('.acct-auth'), {
      next: '/account', title: 'Sign in',
      onDone: (u) => { nav(); dashboard(); if (!u.verified) A.toast('Account created. Check your email to confirm it.'); },
    });
  }

  async function resetFlow(token) {
    app.innerHTML = '<p style="opacity:.7">Checking your link…</p>';
    let email;
    try { email = (await A.api('GET', '/api/auth/reset-info?token=' + encodeURIComponent(token))).email; }
    catch (e) { cleanUrl(); return signedOut(e.message); }
    app.innerHTML = `<h1>Choose a new password</h1><p class="lede">For ${esc(email)}</p>
      <form class="form acct-auth" novalidate>
        <label class="fld"><span>New password</span><input name="pw" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="fld"><span>Type it again</span><input name="pw2" type="password" autocomplete="new-password" minlength="8" required></label>
        <p class="hint">At least 8 characters.</p><p class="form-err" role="alert"></p>
        <button class="btn btn-primary" type="submit">Save password and sign in</button></form>`;
    const form = app.querySelector('form'), err = app.querySelector('.form-err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const f = Object.fromEntries(new FormData(form));
      if (f.pw.length < 8) { err.textContent = 'Passwords are at least 8 characters.'; return; }
      if (f.pw !== f.pw2) { err.textContent = "The two passwords don't match."; return; }
      try {
        await A.busy(form.querySelector('button'), 'Saving…', async () => {
          const r = await A.api('POST', '/api/auth/reset', { token, pw: await A.prehash('user', email, f.pw) });
          A.me = r.user;
        });
        cleanUrl(); nav(); dashboard(); A.toast('Password saved. You are signed in.');
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  function statusLine(b) {
    switch (b.status) {
      case 'pending': return 'The venue is reviewing your request. You’ll get an email when they reply.';
      case 'approved': return 'Approved! Transfer the amount below and upload the bank slip to confirm your date.';
      case 'slip_uploaded': return 'Thanks, we have your slip. The venue will check the payment and email your confirmation.';
      case 'confirmed': return 'Your booking is confirmed. See you there!';
      case 'rejected': return 'The venue could not take this booking.';
      case 'cancelled': return 'This booking was cancelled.';
      case 'expired': return 'The payment deadline passed, so the hours were released. Send a new request if you still want this date.';
      default: return '';
    }
  }

  function card(b) {
    const cfg = A.config;
    const hrs = b.end - b.start;
    let pay = '';
    if (b.status === 'approved') {
      const rows = [['Amount', A.fmtMoney(cfg.currency, b.amount)], ['Bank', payment.bankName], ['Account name', payment.accountName], ['Account number', payment.accountNumber], ['Remark', b.ref]]
        .filter((r) => r[1]);
      pay = `<div class="pay"><h4>Payment</h4><dl>${rows.map((r) => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>
        ${payment.note ? `<p class="hint" style="margin:0 0 12px">${esc(payment.note)}</p>` : ''}
        ${b.payBy ? `<p class="hint" style="margin:0 0 12px">Upload the slip by ${esc(A.fmtWhen(b.payBy))}, or the hours are released.</p>` : ''}
        <label class="btn btn-gold file-pick">Upload bank slip<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-slip="${b.id}"></label>
        <p class="hint" style="margin:8px 0 0">JPG, PNG, WebP or PDF, up to 5 MB.</p></div>`;
    }
    const actions = [];
    if (b.hasSlip) actions.push(`<a class="btn btn-ghost btn-sm" href="/api/bookings/${b.id}/slip" target="_blank" rel="noopener">View my slip</a>`);
    if (['pending', 'approved', 'confirmed'].includes(b.status)) actions.push(`<button class="btn btn-ghost btn-sm" type="button" data-resend="${b.id}">Email me this again</button>`);
    if (b.status === 'pending') actions.push(`<button class="btn btn-ghost btn-sm" type="button" data-change="${b.id}">Change date or time</button>`);
    if (b.status === 'pending' || b.status === 'approved') actions.push(`<button class="btn btn-danger btn-sm" type="button" data-cancel="${b.id}">Cancel request</button>`);
    return `<article class="bk">
      <div class="bk-head"><h3>${esc(b.eventType)} · ${esc(A.fmtDate(b.date, { weekday: 'long', month: 'long' }))}</h3>${A.chip(b.status)}</div>
      <p class="bk-meta"><span>${A.fmtHour(b.start)} to ${A.fmtHour(b.end)} (${hrs} h)</span><span>${b.guests} guests</span>${b.amount ? `<span>${esc(A.fmtMoney(cfg.currency, b.amount))}</span>` : ''}</p>
      <p class="bk-ref">Ref ${esc(b.ref)}</p>
      <p style="margin:10px 0 0;font-size:15px">${esc(statusLine(b))}</p>
      ${b.vendorNote ? `<p class="bk-note">From the venue: ${esc(b.vendorNote)}</p>` : ''}
      ${pay}
      ${actions.length ? `<div class="bk-actions">${actions.join('')}</div>` : ''}
    </article>`;
  }

  async function dashboard() {
    const u = A.me;
    app.innerHTML = '<p style="opacity:.7">Loading your bookings…</p>';
    let data;
    try { data = await A.api('GET', '/api/bookings'); } catch (e) { app.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; return; }
    payment = data.payment;
    const first = (u.name || '').split(' ')[0] || 'there';
    const upcoming = data.bookings.filter((b) => !['rejected', 'cancelled', 'expired'].includes(b.status));
    const closed = data.bookings.filter((b) => ['rejected', 'cancelled', 'expired'].includes(b.status));
    app.innerHTML = `
      <h1>Hi ${esc(first)}</h1>
      <p class="lede">Your requests and bookings at Aveela.</p>
      ${!u.verified ? `<div class="banner"><span>Confirm your email (${esc(u.email)}) to send booking requests.</span><button class="btn btn-gold btn-sm" type="button" id="resend">Send the link again</button></div>` : ''}
      ${upcoming.length ? `<div class="cards">${upcoming.map(card).join('')}</div>`
        : '<div class="empty"><p>No bookings yet. Check a date on the home page and send a request.</p><a class="btn btn-primary" href="/#book">Check a date</a></div>'}
      ${closed.length ? `<h2 style="font:400 26px var(--serif);margin:40px 0 14px">Past and closed</h2><div class="cards">${closed.map(card).join('')}</div>` : ''}
      <section class="profile"><h2>Your details</h2>
        <form class="form" id="profile" novalidate>
          <div class="row2"><label class="fld"><span>Name</span><input name="name" value="${esc(u.name)}" maxlength="80" autocomplete="name"></label>
          <label class="fld"><span>Phone</span><input name="phone" value="${esc(u.phone)}" maxlength="24" type="tel" autocomplete="tel"></label></div>
          <p class="hint">Signed in as ${esc(u.email)}${u.google ? ' with Google' : ''}${u.apple ? ' with Apple' : ''}.</p>
          <p class="form-err" role="alert"></p>
          <div><button class="btn btn-ghost" type="submit">Save details</button></div>
        </form></section>`;

    const resend = document.getElementById('resend');
    if (resend) resend.addEventListener('click', () => A.busy(resend, 'Sending…', () => A.api('POST', '/api/auth/resend-verification'))
      .then(() => { resend.textContent = 'Sent. Check your inbox'; resend.disabled = true; })
      .catch((e) => A.toast(e.message, 'error')));

    app.querySelectorAll('[data-cancel]').forEach((btn) => btn.addEventListener('click', () => {
      const m = A.modal(`<h2 class="dlg-title">Cancel this request?</h2><p class="dlg-intro">The hours will be released for other guests. This can't be undone.</p>
        <div class="row2"><button class="btn btn-ghost" type="button" data-no>Keep it</button><button class="btn btn-danger" type="button" data-yes>Yes, cancel</button></div>`, { label: 'Cancel request' });
      m.el.querySelector('[data-no]').addEventListener('click', m.close);
      const yes = m.el.querySelector('[data-yes]');
      yes.addEventListener('click', () => A.busy(yes, 'Cancelling…', () => A.api('POST', `/api/bookings/${btn.dataset.cancel}/cancel`))
        .then(() => { m.close(); A.toast('Request cancelled.'); dashboard(); })
        .catch((e) => A.toast(e.message, 'error')));
    }));

    app.querySelectorAll('[data-change]').forEach((btn) => btn.addEventListener('click', () => changeRequest(data.bookings.find((x) => x.id === +btn.dataset.change))));

    app.querySelectorAll('[data-resend]').forEach((btn) => btn.addEventListener('click', () =>
      A.busy(btn, 'Sending…', () => A.api('POST', `/api/bookings/${btn.dataset.resend}/resend-email`, {}))
        .then((r) => { A.toast(`Sent to ${r.to}. Check your spam folder if you don't see it.`); btn.textContent = 'Sent'; btn.disabled = true; })
        .catch((e) => A.toast(e.message, 'error'))));

    app.querySelectorAll('[data-slip]').forEach((input) => input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { A.toast('That file is larger than 5 MB.', 'error'); input.value = ''; return; }
      const label = input.parentElement;
      const fd = new FormData(); fd.append('slip', file);
      label.firstChild.textContent = 'Uploading…';
      try { await A.api('POST', `/api/bookings/${input.dataset.slip}/slip`, fd); A.toast('Slip uploaded. We’ll email you once the payment is checked.'); dashboard(); }
      catch (e) { A.toast(e.message, 'error'); label.firstChild.textContent = 'Upload bank slip'; input.value = ''; }
    }));

    const pf = document.getElementById('profile');
    pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(pf));
      const err = pf.querySelector('.form-err'); err.textContent = '';
      try { await A.busy(pf.querySelector('button'), 'Saving…', async () => { A.me = (await A.api('POST', '/api/auth/profile', f)).user; }); A.toast('Details saved.'); }
      catch (ex) { err.textContent = ex.message; }
    });
  }

  // Change the date, hours or guests of a request that hasn't been answered yet.
  function changeRequest(b) {
    const cfg = A.config;
    const opts = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${A.fmtHour(h)}</option>`).join('');
    const max = new Date(cfg.today + 'T12:00:00Z'); max.setUTCMonth(max.getUTCMonth() + cfg.monthsAhead);
    const m = A.modal(`<h2 class="dlg-title">Change your request</h2><p class="dlg-intro">Pick a new date or time. The venue hasn't answered yet, so nothing else changes.</p>
      <form class="form" novalidate>
        <div class="row2"><label class="fld"><span>Date</span><input name="date" type="date" min="${cfg.today}" max="${max.toISOString().slice(0, 10)}" value="${esc(b.date)}"></label>
          <label class="fld"><span>Guests</span><input name="guests" type="number" min="1" max="${cfg.maxGuests}" value="${b.guests}"></label></div>
        <div class="row2"><label class="fld"><span>From</span><select name="start">${opts(cfg.openHour, cfg.closeHour - 1, b.start)}</select></label>
          <label class="fld"><span>To</span><select name="end">${opts(cfg.openHour + 1, cfg.closeHour, b.end)}</select></label></div>
        <p class="hint" data-msg aria-live="polite"></p>
        <p class="form-err" role="alert"></p>
        <button class="btn btn-gold btn-block" type="submit">Save changes</button></form>`, { label: 'Change request' });
    const form = m.el.querySelector('form'), msg = m.el.querySelector('[data-msg]'), err = m.el.querySelector('.form-err');
    const months = {};
    async function check() {
      const f = Object.fromEntries(new FormData(form)), st = +f.start, en = +f.end;
      err.textContent = '';
      if (!f.date) { msg.textContent = 'Pick a date.'; return; }
      if (en - st < cfg.minHours) { msg.textContent = `The minimum booking is ${cfg.minHours} hours.`; return; }
      try { months[f.date.slice(0, 7)] ||= (await A.api('GET', `/api/availability?month=${f.date.slice(0, 7)}`)).days; } catch { msg.textContent = ''; return; }
      const day = months[f.date.slice(0, 7)][f.date] || { booked: [] };
      const clash = day.booked.some((r) => st < r[1] && en > r[0]);
      msg.textContent = clash ? 'Those hours are already booked. Pick another time.' : `Open. About ${A.fmtMoney(cfg.currency, (en - st) * cfg.hourlyRate)} for ${en - st} hours.`;
    }
    form.addEventListener('change', check); check();
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const f = Object.fromEntries(new FormData(form));
      try {
        await A.busy(form.querySelector('button'), 'Saving…', () => A.api('POST', `/api/bookings/${b.id}/change`, { date: f.date, start: +f.start, end: +f.end, guests: +f.guests }));
        m.close(); A.toast('Request updated. The venue has been told.'); dashboard();
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  (async function init() {
    try { await A.loadConfig(); } catch { app.innerHTML = '<h1>Your bookings</h1><p class="lede">Online booking is not available right now. Please try again later.</p>'; return; }
    const reset = q.get('reset');
    if (reset) { nav(); return resetFlow(reset); }
    await A.loadMe().catch(() => null);
    nav();
    if (q.get('verified')) A.toast('Email confirmed. You can now send booking requests.');
    if (q.get('verify') === 'expired') A.toast('That confirmation link has expired or was already used. Send a new one below.', 'error');
    const oauthMsg = q.get('oauth') === 'failed' ? `Sign-in with ${q.get('provider') === 'apple' ? 'Apple' : 'Google'} didn't complete. Try again or use your email.`
      : q.get('oauth') === 'unavailable' ? "That sign-in option isn't set up yet. Use your email instead." : '';
    if (q.toString()) cleanUrl();
    if (!A.me) return signedOut(oauthMsg || undefined);
    if (oauthMsg) A.toast(oauthMsg, 'error');
    dashboard();
  })();
})();
