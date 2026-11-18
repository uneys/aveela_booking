// Vendor admin panel.
(function () {
  const A = window.Aveela;
  const { esc } = A;
  const root = document.getElementById('root');
  const MIN_ADMIN_PW = 12;
  let me = null, settings = null, counts = {}, pollTimer = null;
  let idleMinutes = 30, lastActivity = Date.now(), lastPing = Date.now(), idleTimer = null, warn = null;

  // Any 401 while signed in (session timed out, or ended on another device) returns to the sign-in screen.
  const rawApi = A.api;
  A.api = async (method, path, body, opts) => {
    try { return await rawApi(method, path, body, opts); }
    catch (e) {
      if (e.status === 401 && me && !/\/api\/admin\/(login|setup|state|password)$|\/make-master$/.test(path)) expire(e.message);
      throw e;
    }
  };

  const brand = '<div class="gate-brand"><svg viewBox="0 0 24 28" width="20" height="24" aria-hidden="true"><path d="M3 27V12a9 9 0 0 1 18 0v15" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 27V13a4 4 0 0 1 8 0v14" fill="#e9963a"/></svg>Aveela admin</div>';

  function pwProblem(pw, username) {
    if (pw.length < MIN_ADMIN_PW) return `Admin passwords need at least ${MIN_ADMIN_PW} characters.`;
    if (username && pw.toLowerCase().includes(username.toLowerCase())) return "Don't include the username in the password.";
    return '';
  }

  function randomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => chars[x % chars.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  }

  // ---------- gates: setup, login, forced password change ----------

  function gate(inner) {
    root.innerHTML = `<div class="gate"><div class="gate-card">${brand}${inner}</div></div>`;
    return root.querySelector('.gate-card');
  }

  function formSubmit(form, label, fn) {
    const err = form.querySelector('.form-err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await A.busy(form.querySelector('button[type=submit]'), label, () => fn(Object.fromEntries(new FormData(form)))); }
      catch (ex) { err.textContent = ex.message; }
    });
  }

  function setupScreen(enabled) {
    if (!enabled) {
      gate('<h1>Finish setup</h1><p class="sub">Set the SETUP_TOKEN secret in Cloudflare (see the README), then reload this page to create the master admin.</p>');
      return;
    }
    const c = gate(`<h1>Create the master admin</h1><p class="sub">This runs once. The master admin can add other admins and change settings.</p>
      <form class="form" novalidate autocomplete="off">
        <label class="fld"><span>Setup token</span><input name="token" type="password" required autocomplete="off"></label>
        <label class="fld"><span>Username</span><input name="username" required pattern="[a-z0-9._-]{3,32}" autocomplete="username" autocapitalize="none"></label>
        <div class="row2"><label class="fld"><span>Your name</span><input name="name" maxlength="80"></label><label class="fld"><span>Email</span><input name="email" type="email" maxlength="190"></label></div>
        <label class="fld"><span>Password</span><input name="pw" type="password" required autocomplete="new-password"></label>
        <label class="fld"><span>Type it again</span><input name="pw2" type="password" required autocomplete="new-password"></label>
        <p class="hint">At least ${MIN_ADMIN_PW} characters. A long phrase is best.</p>
        <p class="form-err" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Create master admin</button></form>`);
    formSubmit(c.querySelector('form'), 'Creating…', async (f) => {
      const username = f.username.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Username: 3–32 lowercase letters, numbers, dots, dashes or underscores.');
      const p = pwProblem(f.pw, username); if (p) throw new Error(p);
      if (f.pw !== f.pw2) throw new Error("The two passwords don't match.");
      const r = await A.api('POST', '/api/admin/setup', { token: f.token, username, name: f.name, email: f.email, pw: await A.prehash('admin', username, f.pw) });
      me = r.admin; start();
    });
  }

  function loginScreen(message) {
    const c = gate(`<h1>Sign in</h1><p class="sub">Venue staff only.</p>${message ? `<div class="warn" role="status">${esc(message)}</div>` : ''}
      <form class="form" novalidate>
        <label class="fld"><span>Username</span><input name="username" required autocomplete="username" autocapitalize="none"></label>
        <label class="fld"><span>Password</span><input name="pw" type="password" required autocomplete="current-password"></label>
        <p class="form-err" role="alert"></p><button class="btn btn-primary btn-block" type="submit">Sign in</button></form>`);
    c.querySelector('input').focus();
    formSubmit(c.querySelector('form'), 'Signing in…', async (f) => {
      const username = f.username.trim().toLowerCase();
      if (!username || !f.pw) throw new Error('Enter your username and password.');
      const r = await A.api('POST', '/api/admin/login', { username, pw: await A.prehash('admin', username, f.pw) });
      me = r.admin; start();
    });
  }

  function passwordForm(title, sub, onDone) {
    return `<h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>
      <form class="form" novalidate id="pwform">
        <label class="fld"><span>Current password</span><input name="current" type="password" required autocomplete="current-password"></label>
        <label class="fld"><span>New password</span><input name="next" type="password" required autocomplete="new-password"></label>
        <label class="fld"><span>Type it again</span><input name="next2" type="password" required autocomplete="new-password"></label>
        <p class="hint">At least ${MIN_ADMIN_PW} characters. Other devices will be signed out.</p>
        <p class="form-err" role="alert"></p><div><button class="btn btn-primary" type="submit">Save new password</button></div></form>`;
  }
  function wirePasswordForm(el, onDone) {
    formSubmit(el.querySelector('#pwform'), 'Saving…', async (f) => {
      const p = pwProblem(f.next, me.username); if (p) throw new Error(p);
      if (f.next !== f.next2) throw new Error("The two new passwords don't match.");
      const [current, next] = await Promise.all([A.prehash('admin', me.username, f.current), A.prehash('admin', me.username, f.next)]);
      await A.api('POST', '/api/admin/password', { current, next });
      onDone();
    });
  }

  function mustChangeScreen() {
    const c = gate(passwordForm('Set your own password', 'You signed in with a temporary password. Choose a new one to continue.'));
    wirePasswordForm(c, () => { me.mustChange = false; A.toast('Password saved.'); start(); });
  }

  // ---------- sign-out after inactivity ----------
  // The server signs a session out after `admin_idle_minutes` without activity (Settings). Here we
  // track real activity (mouse, keys, touch), share it across tabs, warn 2 minutes before, and ping
  // the server every few minutes while someone is working so a long form doesn't get cut off.

  const ACT_KEY = 'aveela_admin_active';
  const sharedActivity = () => { try { return Math.max(lastActivity, Number(localStorage.getItem(ACT_KEY)) || 0); } catch { return lastActivity; } };

  function markActive() {
    const t = Date.now();
    if (t - lastActivity < 3000 && !warn) return;
    lastActivity = t;
    try { localStorage.setItem(ACT_KEY, String(t)); } catch {}
    if (warn) { warn.close(); warn = null; }
    if (me && t - lastPing > 4 * 60 * 1000) { lastPing = t; A.api('POST', '/api/admin/ping', {}).catch(() => {}); }
  }

  function startIdle() {
    stopIdle();
    lastActivity = lastPing = Date.now();
    try { localStorage.setItem(ACT_KEY, String(lastActivity)); } catch {}
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach((ev) => window.addEventListener(ev, markActive, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', idleTick);
    idleTimer = setInterval(idleTick, 1000);
  }

  function stopIdle() {
    clearInterval(idleTimer); idleTimer = null;
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach((ev) => window.removeEventListener(ev, markActive, { capture: true }));
    document.removeEventListener('visibilitychange', idleTick);
    if (warn) { warn.close(); warn = null; }
  }

  function idleTick() {
    if (!me) return;
    const limit = idleMinutes * 60 * 1000;
    const left = limit - (Date.now() - sharedActivity());
    if (left <= 0) {
      A.api('POST', '/api/admin/logout').catch(() => {});
      expire(`You were signed out after ${idleMinutes} minutes without activity.`);
      return;
    }
    if (left <= 120000) {
      const mmss = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
      if (!warn) {
        warn = A.modal(`<h2 class="dlg-title">Still there?</h2><p class="dlg-intro">For security, you'll be signed out in <strong data-left>${mmss}</strong> because there's been no activity.</p>
          <div class="row2"><button class="btn btn-ghost" type="button" data-out>Sign out now</button><button class="btn btn-primary" type="button" data-stay>Stay signed in</button></div>`,
          { label: 'Sign-out warning', onClose: () => { warn = null; } });
        warn.el.querySelector('[data-stay]').addEventListener('click', () => { lastPing = 0; lastActivity = 0; markActive(); });
        warn.el.querySelector('[data-out]').addEventListener('click', () => { A.api('POST', '/api/admin/logout').catch(() => {}); expire('You signed out.'); });
      } else {
        const el = warn.el.querySelector('[data-left]');
        if (el) el.textContent = mmss;
      }
    } else if (warn) { warn.close(); warn = null; }
  }

  function expire(message) {
    if (!me) return;
    me = null;
    stopIdle();
    clearInterval(pollTimer);
    closeDrawer();
    document.querySelectorAll('.modal').forEach((m) => m.remove());
    document.body.style.overflow = '';
    loginScreen(message);
  }

  // ---------- shell ----------

  const VIEWS = [
    { id: 'requests', label: 'Requests', count: 'pending' },
    { id: 'payments', label: 'Payments to check', count: 'slip_uploaded' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'all', label: 'All bookings' },
    { id: 'customers', label: 'Customers' },
    { id: 'new', label: 'New booking' },
    { id: 'block', label: 'Block time' },
    { sep: true, master: true },
    { id: 'admins', label: 'Admin users', master: true },
    { id: 'settings', label: 'Settings', master: true },
    { id: 'activity', label: 'Activity log', master: true },
    { sep: true },
    { id: 'password', label: 'Change password' },
  ];

  function shell() {
    root.innerHTML = `
      <div class="mobile-top"><span style="font:400 18px var(--serif)">Aveela admin</span><button type="button" id="menuBtn" aria-expanded="false">Menu</button></div>
      <div class="shell">
        <aside class="side" id="side">${brand}
          ${VIEWS.filter((v) => !v.master || me.isMaster).map((v) => v.sep ? '<div class="sep"></div>'
            : `<a href="#${v.id}" data-view="${v.id}"><span>${esc(v.label)}</span>${v.count ? `<span class="count" data-count="${v.count}" hidden></span>` : ''}</a>`).join('')}
          <button class="navbtn" type="button" id="logout">Sign out</button>
          <div class="who">Signed in as <strong>${esc(me.name || me.username)}</strong>${me.isMaster ? '<br>Master admin' : ''}</div>
        </aside>
        <main class="main" id="main"></main>
      </div>
      <div class="drawer-shade" id="shade"></div><aside class="drawer" id="drawer" aria-label="Booking details"></aside>`;
    document.getElementById('logout').addEventListener('click', async () => {
      await A.api('POST', '/api/admin/logout').catch(() => {});
      expire('You signed out.');
    });
    const side = document.getElementById('side'), menuBtn = document.getElementById('menuBtn');
    menuBtn.addEventListener('click', () => { const on = side.classList.toggle('on'); menuBtn.setAttribute('aria-expanded', on); });
    side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('on'); });
    document.getElementById('shade').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  }

  async function refreshCounts() {
    try {
      const r = await A.api('GET', '/api/admin/overview', undefined, { bg: true });
      counts = r.counts; settings = r.settings;
      if (settings.admin_idle_minutes) idleMinutes = settings.admin_idle_minutes;
      document.querySelectorAll('[data-count]').forEach((el) => {
        const n = counts[el.dataset.count] || 0;
        el.textContent = n; el.hidden = !n;
      });
    } catch (e) { /* a 401 is handled by the A.api wrapper */ }
  }

  function route() {
    if (!me) return;
    let id = location.hash.slice(1) || 'requests';
    const v = VIEWS.find((x) => x.id === id && (!x.master || me.isMaster));
    if (!v) id = 'requests';
    document.querySelectorAll('[data-view]').forEach((a) => a.setAttribute('aria-current', a.dataset.view === id ? 'page' : 'false'));
    closeDrawer();
    ({ requests, payments, upcoming, all, customers, new: newBooking, block, admins, settings: settingsView, activity, password }[id])();
  }

  const main = () => document.getElementById('main');

  // ---------- booking lists ----------

  function rowHtml(b) {
    const via = b.source && b.source !== 'website' ? ` · via ${esc(b.source)}` : '';
    const cust = b.customer ? `${esc(b.customer.name)}<div class="muted">${esc(b.customer.email || b.customer.phone)}${via}</div>` : '<span class="muted">Blocked by venue</span>';
    return `<tr data-id="${b.id}" tabindex="0">
      <td><strong>${esc(A.fmtDate(b.date))}</strong><div class="muted">${A.fmtHour(b.start)}–${A.fmtHour(b.end)}</div></td>
      <td>${esc(b.eventType)}<div class="muted">${esc(b.ref)}</div></td>
      <td>${cust}</td><td>${b.guests || '–'}</td>
      <td>${b.amount ? esc(A.fmtMoney(settings.currency, b.amount)) : '–'}</td>
      <td>${A.chip(b.status)}</td></tr>`;
  }
  function cardHtml(b) {
    return `<article class="bk" data-id="${b.id}" tabindex="0"><div class="bk-head"><strong>${esc(A.fmtDate(b.date))}, ${A.fmtHour(b.start)}–${A.fmtHour(b.end)}</strong>${A.chip(b.status)}</div>
      <div class="muted">${esc(b.eventType)} · ${b.customer ? esc(b.customer.name) : 'Blocked'} · ${esc(b.ref)}</div></article>`;
  }

  async function list(title, sub, query, emptyText, { search = false } = {}) {
    const m = main();
    m.innerHTML = `<h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>
      ${search ? '<div class="toolbar"><label class="fld"><span>Search reference, name or email</span><input type="search" id="q"></label></div>' : ''}
      <div id="list"><p class="muted">Loading…</p></div>`;
    async function load(extra = '') {
      const box = document.getElementById('list');
      try {
        const { bookings } = await A.api('GET', '/api/admin/bookings?' + query + extra);
        if (!bookings.length) { box.innerHTML = `<div class="panel"><p style="margin:0">${esc(emptyText)}</p></div>`; return; }
        box.innerHTML = `<table class="table"><thead><tr><th>Date</th><th>Event</th><th>Customer</th><th>Guests</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>${bookings.map(rowHtml).join('')}</tbody></table><div class="cards-admin">${bookings.map(cardHtml).join('')}</div>`;
        box.querySelectorAll('[data-id]').forEach((el) => {
          const open = () => openBooking(+el.dataset.id, () => load(extra));
          el.addEventListener('click', open);
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        });
      } catch (e) { box.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; }
    }
    if (search) {
      let t;
      document.getElementById('q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => load('&q=' + encodeURIComponent(e.target.value)), 250); });
    }
    load();
  }

  const requests = () => list('Requests', 'New booking requests waiting for your decision. Oldest dates first.', 'status=pending', 'No requests waiting. Nice.');
  const payments = () => list('Payments to check', 'Customers uploaded these bank slips. Check the money arrived, then confirm.', 'status=slip_uploaded', 'No slips waiting for review.');
  const upcoming = () => list('Upcoming', 'Approved, paid and blocked bookings from today on.', 'status=approved,slip_uploaded,confirmed,blocked&scope=upcoming', 'Nothing booked yet.');
  const all = () => list('All bookings', 'Every request, newest dates first.', 'scope=', 'No bookings yet.', { search: true });

  // ---------- booking drawer ----------

  function closeDrawer() {
    const d = document.getElementById('drawer'), s = document.getElementById('shade');
    if (d) d.classList.remove('on');
    if (s) s.classList.remove('on');
  }

  async function openBooking(id, onChange) {
    const d = document.getElementById('drawer');
    d.innerHTML = '<p class="muted">Loading…</p>';
    d.classList.add('on'); document.getElementById('shade').classList.add('on');
    let data;
    try { data = await A.api('GET', `/api/admin/bookings/${id}`); } catch (e) { d.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; return; }
    const b = data.booking, cur = settings.currency, hrs = b.end - b.start;
    const holding = data.clashes.filter((c) => ['approved', 'slip_uploaded', 'confirmed', 'blocked'].includes(c.status));
    const pending = data.clashes.filter((c) => c.status === 'pending');
    const slipUrl = `/api/admin/bookings/${b.id}/slip`;
    let actions = '';
    if (b.status === 'pending') {
      const hourOpts = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
        .map((h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${A.fmtHour(h)}</option>`).join('');
      actions = `<div class="actbox">
        <h3 style="font:600 15px var(--sans);margin:0">Date and time <span class="muted" style="font-weight:400">(change before approving if needed)</span></h3>
        <div class="grid2"><label class="fld"><span>Date</span><input id="rsDate" type="date" value="${esc(b.date)}"></label>
          <label class="fld"><span>Guests</span><input id="rsGuests" type="number" min="1" value="${b.guests}"></label></div>
        <div class="row2"><label class="fld"><span>From</span><select id="rsStart">${hourOpts(0, 23, b.start)}</select></label>
          <label class="fld"><span>To</span><select id="rsEnd">${hourOpts(1, 24, b.end)}</select></label></div>
        <p class="nb-avail" id="rsMsg" aria-live="polite"></p>
        <label class="fld"><span>Amount to charge (${esc(cur)})</span><input id="amount" type="number" min="0" step="1" value="${b.amount}"></label>
        <p class="hint" style="margin-top:-6px" id="rsPrice">${hrs} hours × ${esc(A.fmtMoney(cur, settings.hourly_rate))} = ${esc(A.fmtMoney(cur, hrs * settings.hourly_rate))}. Change it for discounts or extras.</p>
        <label class="fld"><span>Message to the customer (optional for approval, recommended when rejecting)</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div id="rsSave" style="display:none;gap:8px;padding:12px;border-radius:10px;background:#f4f6fa">
          <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="rsNotify" ${b.customer && b.customer.email ? 'checked' : 'disabled'}> Email the customer about the new time</label>
          <div><button class="btn btn-ghost btn-sm" type="button" id="rsBtn">Save new time without approving</button></div>
          <p class="hint" style="margin:0">Or approve straight away: the new time is used and the approval email mentions the change.</p>
        </div>
        <div class="row2"><button class="btn btn-danger" type="button" data-act="reject">Reject</button><button class="btn btn-primary" type="button" data-act="approve">Approve and request payment</button></div></div>`;
    } else if (b.status === 'slip_uploaded') {
      actions = `<div class="actbox">
        <label class="fld"><span>Message to the customer (included in the email)</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div class="row2"><button class="btn btn-danger" type="button" data-act="reject-slip">Slip doesn't match</button><button class="btn btn-primary" type="button" data-act="confirm">Payment received, confirm</button></div></div>`;
    } else if (b.status === 'approved') {
      actions = `<div class="actbox">
        <p class="hint" style="margin:0">Got the money another way (cash, a transfer you can see, a slip sent on WhatsApp)? Attach the slip if you have one, then confirm.</p>
        <label class="fld"><span>Message to the customer (included in the email)</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div class="row2"><button class="btn btn-danger" type="button" data-act="cancel">Cancel booking</button><button class="btn btn-primary" type="button" data-act="confirm">Payment received, confirm</button></div></div>`;
    } else if (['confirmed', 'blocked'].includes(b.status)) {
      actions = `<div class="actbox">
        <label class="fld"><span>${b.status === 'blocked' ? 'Note' : 'Reason (sent to the customer)'}</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div><button class="btn btn-danger" type="button" data-act="cancel">${b.status === 'blocked' ? 'Remove block' : 'Cancel booking'}</button></div></div>`;
    }
    if (['approved', 'slip_uploaded', 'confirmed'].includes(b.status)) {
      actions += `<div class="actbox"><label class="btn btn-ghost file-pick" style="justify-self:start">${b.hasSlip ? 'Replace slip or receipt' : 'Attach slip or receipt'}
        <input type="file" id="adminSlip" accept="image/jpeg,image/png,image/webp,application/pdf"></label></div>`;
    }
    d.innerHTML = `<button class="modal-x" type="button" aria-label="Close">×</button>
      <h2>${esc(b.eventType)}</h2>${A.chip(b.status)}
      <dl class="kv">
        <dt>Reference</dt><dd>${esc(b.ref)}</dd>
        <dt>Date</dt><dd>${esc(A.fmtDate(b.date, { weekday: 'long', month: 'long' }))}</dd>
        <dt>Time</dt><dd>${A.fmtHour(b.start)} to ${A.fmtHour(b.end)} (${hrs} h)</dd>
        <dt>Guests</dt><dd>${b.guests || '–'}</dd>
        <dt>Amount</dt><dd>${b.amount ? esc(A.fmtMoney(cur, b.amount)) : '–'}</dd>
        ${b.customer ? `<dt>Customer</dt><dd>${esc(b.customer.name)}${b.customer.email ? `<br><a href="mailto:${esc(b.customer.email)}">${esc(b.customer.email)}</a>` : ''}${b.customer.phone ? `<br><a href="tel:${esc(b.customer.phone.replace(/[^\d+]/g, ''))}">${esc(b.customer.phone)}</a>` : ''}${!b.customer.email ? '<br><span class="muted">No email, so no automatic emails</span>' : ''}</dd>` : ''}
        ${b.customer && b.customer.id ? `<dt></dt><dd><button class="linkish" type="button" id="toCustomer" style="color:#3a4f86">View customer and their bookings</button></dd>` : ''}
        ${b.source && b.source !== 'website' ? `<dt>Came in via</dt><dd>${esc(b.source)}${b.createdBy ? `, added by ${esc(b.createdBy)}` : ''}</dd>` : ''}
        ${b.notes ? `<dt>${b.status === 'blocked' ? 'Reason' : 'Their notes'}</dt><dd>${esc(b.notes)}</dd>` : ''}
        ${b.vendorNote ? `<dt>Your note</dt><dd>${esc(b.vendorNote)}</dd>` : ''}
        ${b.payBy && b.status === 'approved' ? `<dt>Pay by</dt><dd>${esc(A.fmtWhen(b.payBy))}</dd>` : ''}
        <dt>Requested</dt><dd>${esc(A.fmtWhen(b.createdAt))}</dd>
        ${b.decidedBy ? `<dt>Handled by</dt><dd>${esc(b.decidedBy)}</dd>` : ''}
      </dl>
      ${holding.length && b.status === 'pending' ? `<div class="warn">These hours are already taken by ${holding.map((c) => esc(c.ref)).join(', ')}. Reject this request, or cancel the other booking first.</div>` : ''}
      ${pending.length ? `<div class="warn">Other requests overlap these hours: ${pending.map((c) => esc(c.ref)).join(', ')}. Approving this one will block them from being approved.</div>` : ''}
      ${b.hasSlip ? `<h3 style="font:600 15px var(--sans);margin:18px 0 0">Bank slip <span class="muted">uploaded ${esc(A.fmtWhen(b.slipAt))}</span></h3>
        <a href="${slipUrl}" target="_blank" rel="noopener"><img class="slip-view" src="${slipUrl}" alt="Bank slip for ${esc(b.ref)}"></a>` : ''}
      ${actions}
      ${b.customer && RESEND_LABEL[b.status] ? `<div class="actbox"><p class="hint" style="margin:0">Customer didn't get it, or it went to spam?</p>
        <div><button class="btn btn-ghost" type="button" id="resend">Resend ${esc(RESEND_LABEL[b.status])} email</button></div></div>` : ''}`;
    d.querySelector('.modal-x').addEventListener('click', closeDrawer);
    // Changing the date/time of a pending request.
    if (b.status === 'pending') {
      const R = (id) => d.querySelector('#' + id);
      let amountTouched = false, monthCache = {};
      R('amount').addEventListener('input', () => { amountTouched = true; });
      const changed = () => R('rsDate').value !== b.date || +R('rsStart').value !== b.start || +R('rsEnd').value !== b.end || +R('rsGuests').value !== b.guests;
      async function rsCheck() {
        const date = R('rsDate').value, st = +R('rsStart').value, en = +R('rsEnd').value, msg = R('rsMsg');
        const h = en - st;
        R('rsSave').style.display = changed() ? 'grid' : 'none';
        if (h > 0) {
          R('rsPrice').textContent = `${h} hours × ${A.fmtMoney(cur, settings.hourly_rate)} = ${A.fmtMoney(cur, h * settings.hourly_rate)}. Change it for discounts or extras.`;
          if (!amountTouched && changed()) R('amount').value = h * settings.hourly_rate;
          if (!amountTouched && !changed()) R('amount').value = b.amount;
        }
        msg.dataset.tone = '';
        if (!date) { msg.textContent = 'Pick a date.'; msg.dataset.tone = 'bad'; return; }
        if (h <= 0) { msg.textContent = 'The end time needs to be after the start.'; msg.dataset.tone = 'bad'; return; }
        if (!changed()) { msg.textContent = ''; return; }
        const month = date.slice(0, 7);
        try { monthCache[month] ||= (await A.api('GET', `/api/availability?month=${month}`)).days; } catch (e) { msg.textContent = e.message; return; }
        const day = monthCache[month][date] || { booked: [] };
        const clash = day.booked.filter((r) => st < r[1] && en > r[0]);
        if (clash.length) { msg.textContent = `Already booked then: ${clash.map((r) => `${A.fmtHour(r[0])}–${A.fmtHour(r[1])}`).join(', ')}. Pick other hours.`; msg.dataset.tone = 'bad'; }
        else { msg.textContent = `${A.fmtDate(date, { weekday: 'long', month: 'long' })}, ${A.fmtHour(st)}–${A.fmtHour(en)} is free.`; msg.dataset.tone = 'ok'; }
      }
      ['rsDate', 'rsStart', 'rsEnd', 'rsGuests'].forEach((id) => R(id).addEventListener('change', rsCheck));
      R('rsGuests').addEventListener('input', rsCheck);
      R('rsBtn').addEventListener('click', () => {
        const err = d.querySelector('.form-err'); err.textContent = '';
        A.busy(R('rsBtn'), 'Saving…', () => A.api('POST', `/api/admin/bookings/${b.id}/reschedule`, {
          date: R('rsDate').value, start: +R('rsStart').value, end: +R('rsEnd').value, guests: +R('rsGuests').value,
          amount: R('amount').value === '' ? undefined : Number(R('amount').value), note: (d.querySelector('#note') || {}).value || '', notify: R('rsNotify').checked,
        })).then((r) => {
          const em = r.emailed === 'sent' ? ' Customer emailed.' : r.emailed ? ` Email failed: ${r.emailed}` : '';
          A.toast(`New time saved.${em}`, r.emailed && r.emailed !== 'sent' ? 'error' : '');
          openBooking(b.id, onChange); if (onChange) onChange();
        }).catch((e) => { err.textContent = e.message; });
      });
    }

    const tc = d.querySelector('#toCustomer');
    if (tc) tc.addEventListener('click', () => openCustomer(b.customer.id));

    const as = d.querySelector('#adminSlip');
    if (as) as.addEventListener('change', async () => {
      const file = as.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { A.toast('That file is larger than 5 MB.', 'error'); as.value = ''; return; }
      const fd = new FormData(); fd.append('slip', file);
      as.parentElement.firstChild.textContent = 'Uploading…';
      try { await A.api('POST', `/api/admin/bookings/${b.id}/slip`, fd); A.toast('Slip attached.'); refreshCounts(); openBooking(b.id, onChange); if (onChange) onChange(); }
      catch (e) { A.toast(e.message, 'error'); openBooking(b.id, onChange); }
    });
    const rs = d.querySelector('#resend');
    if (rs) rs.addEventListener('click', () => A.busy(rs, 'Sending…', () => A.api('POST', `/api/admin/bookings/${b.id}/resend-email`, {}))
      .then((r) => A.toast(`Sent the ${r.sent} email to ${r.to}.`))
      .catch((e) => A.toast(e.message, 'error')));
    // CSP blocks inline handlers, so wire the PDF fallback here.
    const img = d.querySelector('.slip-view');
    if (img) { img.addEventListener('error', () => { const s = document.createElement('span'); s.className = 'btn btn-ghost btn-sm'; s.textContent = 'Open the slip in a new tab'; img.replaceWith(s); }); }
    d.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const note = (d.querySelector('#note') || {}).value || '';
      const err = d.querySelector('.form-err'); err.textContent = '';
      if (act === 'reject-slip' && !note.trim()) { err.textContent = 'Tell the customer what was wrong with the slip.'; return; }
      if ((act === 'cancel' || act === 'reject') && !btn.dataset.sure) {
        btn.dataset.sure = '1'; btn.textContent = act === 'reject' ? 'Click again to reject' : 'Click again to confirm'; return;
      }
      const body = { note };
      if (act === 'approve') {
        body.amount = d.querySelector('#amount').value === '' ? undefined : Number(d.querySelector('#amount').value);
        Object.assign(body, { date: d.querySelector('#rsDate').value, start: +d.querySelector('#rsStart').value, end: +d.querySelector('#rsEnd').value, guests: +d.querySelector('#rsGuests').value });
      }
      try {
        await A.busy(btn, 'Saving…', () => A.api('POST', `/api/admin/bookings/${b.id}/${act}`, body));
        const msg = { approve: 'Approved. Payment details emailed.', reject: 'Rejected. Customer emailed.', confirm: 'Confirmed. Confirmation emailed.', 'reject-slip': 'Customer asked for a new slip.', cancel: 'Cancelled.' }[act];
        A.toast(msg); closeDrawer(); refreshCounts(); if (onChange) onChange();
      } catch (ex) { err.textContent = ex.message; }
    }));
  }

  const RESEND_LABEL = { pending: 'request received', approved: 'payment details', confirmed: 'confirmation', rejected: 'declined', cancelled: 'cancellation' };

  // ---------- customers ----------

  function customerStatus(u) {
    if (u.suspended) return '<span class="chip chip-off" style="background:#fdeceb;color:#c0392b">Suspended</span>';
    if (!u.hasAccount) return '<span class="chip chip-wait">Added by staff</span>';
    if (!u.verified) return '<span class="chip chip-act">Email not confirmed</span>';
    return '<span class="chip chip-good">Active</span>';
  }

  async function customers() {
    const m = main();
    m.innerHTML = `<h1>Customers</h1><p class="sub" id="cSub">Everyone with an account, plus customers you added to manual bookings.</p>
      <div class="toolbar">
        <label class="fld"><span>Search name, email or phone</span><input type="search" id="cq"></label>
        <div class="seg" role="tablist" aria-label="Show" style="margin:18px 0 0">
          <button type="button" role="tab" aria-selected="true" data-f="">All</button>
          <button type="button" role="tab" aria-selected="false" data-f="suspended">Suspended</button>
          <button type="button" role="tab" aria-selected="false" data-f="unverified">Not confirmed</button>
          <button type="button" role="tab" aria-selected="false" data-f="noaccount">Added by staff</button>
        </div>
      </div>
      <div id="clist"><p class="muted">Loading…</p></div>`;
    let filter = '', q = '', t;
    async function load() {
      const box = document.getElementById('clist');
      try {
        const r = await A.api('GET', `/api/admin/users?filter=${filter}&q=${encodeURIComponent(q)}`);
        document.getElementById('cSub').textContent = `${r.total} customer${r.total === 1 ? '' : 's'}${r.suspended ? `, ${r.suspended} suspended` : ''}. Everyone with an account, plus customers you added to manual bookings.`;
        if (!r.users.length) { box.innerHTML = '<div class="panel"><p style="margin:0">No customers match.</p></div>'; return; }
        box.innerHTML = `<table class="table"><thead><tr><th>Customer</th><th>Phone</th><th>Signs in with</th><th>Joined</th><th>Last sign-in</th><th>Bookings</th><th>Status</th></tr></thead><tbody>
          ${r.users.map((u) => `<tr data-uid="${u.id}" tabindex="0"><td><strong>${esc(u.name || '–')}</strong><div class="muted">${esc(u.email)}</div></td>
            <td>${esc(u.phone || '–')}</td><td>${u.signInWith.length ? esc(u.signInWith.join(', ')) : '<span class="muted">Not signed up</span>'}</td>
            <td class="muted">${esc(A.fmtWhen(u.createdAt).split(',')[0])}</td><td class="muted">${u.lastLoginAt ? esc(A.fmtWhen(u.lastLoginAt)) : '–'}</td>
            <td>${u.bookings}${u.upcoming ? `<div class="muted">${u.upcoming} upcoming</div>` : ''}</td><td>${customerStatus(u)}</td></tr>`).join('')}
          </tbody></table>
          <div class="cards-admin">${r.users.map((u) => `<article class="bk" data-uid="${u.id}" tabindex="0"><div class="bk-head"><strong>${esc(u.name || u.email)}</strong>${customerStatus(u)}</div>
            <div class="muted">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''} · ${u.bookings} booking${u.bookings === 1 ? '' : 's'}</div></article>`).join('')}</div>`;
        box.querySelectorAll('[data-uid]').forEach((el) => {
          const open = () => openCustomer(+el.dataset.uid, load);
          el.addEventListener('click', open);
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        });
      } catch (e) { box.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; }
    }
    m.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
      m.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-selected', x === b));
      filter = b.dataset.f; load();
    }));
    document.getElementById('cq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; load(); }, 250); });
    load();
  }

  async function openCustomer(id, onChange) {
    const d = document.getElementById('drawer');
    d.innerHTML = '<p class="muted">Loading…</p>';
    d.classList.add('on'); document.getElementById('shade').classList.add('on');
    let data;
    try { data = await A.api('GET', `/api/admin/users/${id}`); } catch (e) { d.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; return; }
    const u = data.user;
    const pending = data.bookings.filter((b) => b.status === 'pending').length;
    d.innerHTML = `<button class="modal-x" type="button" aria-label="Close">×</button>
      <h2>${esc(u.name || u.email)}</h2>${customerStatus(u)}
      <dl class="kv">
        <dt>Email</dt><dd><a href="mailto:${esc(u.email)}">${esc(u.email)}</a>${u.verified ? '' : ' <span class="muted">(not confirmed)</span>'}</dd>
        ${u.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(u.phone.replace(/[^\d+]/g, ''))}">${esc(u.phone)}</a></dd>` : ''}
        <dt>Signs in with</dt><dd>${u.signInWith.length ? esc(u.signInWith.join(', ')) : 'Not signed up yet (added by staff)'}</dd>
        <dt>Joined</dt><dd>${esc(A.fmtWhen(u.createdAt))}</dd>
        <dt>Last sign-in</dt><dd>${u.lastLoginAt ? esc(A.fmtWhen(u.lastLoginAt)) : '–'}</dd>
        ${u.suspended ? `<dt>Suspended</dt><dd>${esc(A.fmtWhen(u.suspendedAt))}${u.suspendedBy ? ` by ${esc(u.suspendedBy)}` : ''}<br><strong>Reason:</strong> ${esc(u.suspendedReason)}</dd>` : ''}
      </dl>
      <h3 style="font:600 15px var(--sans);margin:20px 0 8px">Bookings (${data.bookings.length})</h3>
      ${data.bookings.length ? `<div style="display:grid;gap:8px">${data.bookings.map((b) => `<button type="button" class="bk" data-bid="${b.id}" style="text-align:left;background:#f7f8fa;border:0;border-radius:12px;padding:12px 14px;cursor:pointer;font:inherit">
          <div class="bk-head" style="margin:0 0 4px"><strong>${esc(A.fmtDate(b.date))}, ${A.fmtHour(b.start)}–${A.fmtHour(b.end)}</strong>${A.chip(b.status)}</div>
          <div class="muted">${esc(b.eventType)} · ${esc(b.ref)}${b.source && b.source !== 'website' ? ` · via ${esc(b.source)}` : ''}</div></button>`).join('')}</div>` : '<p class="muted">No bookings.</p>'}
      <div class="actbox">
        ${u.suspended ? `<p style="margin:0">They can't sign in, request bookings or reset their password while suspended. Approved and confirmed bookings stay as they are.</p>
            <p class="form-err" role="alert"></p><div><button class="btn btn-primary" type="button" id="unsuspend">Restore account</button></div>`
          : `<h3 style="font:600 15px var(--sans);margin:0">Suspend account</h3>
            <p class="hint" style="margin:0">They're signed out at once and can't sign in, request bookings or reset their password. Approved and confirmed bookings stay as they are, so cancel those separately if needed.</p>
            <label class="fld"><span>Reason (only staff see this)</span><textarea id="susReason" maxlength="600" placeholder="e.g. repeated fake requests"></textarea></label>
            ${pending ? `<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="susCancel" checked> Also cancel their ${pending} pending request${pending === 1 ? '' : 's'}</label>` : ''}
            <p class="form-err" role="alert"></p><div><button class="btn btn-danger" type="button" id="suspend">Suspend account</button></div>`}
      </div>`;
    d.querySelector('.modal-x').addEventListener('click', closeDrawer);
    d.querySelectorAll('[data-bid]').forEach((el) => el.addEventListener('click', () => openBooking(+el.dataset.bid, () => { if (onChange) onChange(); })));
    const err = d.querySelector('.form-err');
    const sus = d.querySelector('#suspend');
    if (sus) sus.addEventListener('click', () => {
      err.textContent = '';
      const reason = d.querySelector('#susReason').value.trim();
      if (!reason) { err.textContent = 'Write a short reason. Only staff see it.'; return; }
      if (!sus.dataset.sure) { sus.dataset.sure = '1'; sus.textContent = 'Click again to suspend'; return; }
      const cancelPending = !!(d.querySelector('#susCancel') && d.querySelector('#susCancel').checked);
      A.busy(sus, 'Suspending…', () => A.api('POST', `/api/admin/users/${u.id}/suspend`, { reason, cancelPending }))
        .then((r) => { A.toast(`${u.name || u.email} suspended${r.cancelled ? `, ${r.cancelled} pending request${r.cancelled === 1 ? '' : 's'} cancelled` : ''}.`); refreshCounts(); openCustomer(u.id, onChange); if (onChange) onChange(); })
        .catch((e) => { err.textContent = e.message; });
    });
    const un = d.querySelector('#unsuspend');
    if (un) un.addEventListener('click', () => A.busy(un, 'Restoring…', () => A.api('POST', `/api/admin/users/${u.id}/unsuspend`, {}))
      .then(() => { A.toast('Account restored. They can sign in again.'); openCustomer(u.id, onChange); if (onChange) onChange(); })
      .catch((e) => { err.textContent = e.message; }));
  }

  // ---------- new booking (requests by phone, WhatsApp, Instagram, walk-in…) ----------

  async function newBooking() {
    const m = main();
    m.innerHTML = '<h1>New booking</h1><p class="sub">Loading…</p>';
    const cfg = await A.loadConfig();
    const s = settings;
    const today = cfg.today;
    const hourOpts = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .map((h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${A.fmtHour(h)}${h < s.open_hour || h > s.close_hour ? ' (outside hours)' : ''}</option>`).join('');
    const defStart = Math.min(Math.max(18, s.open_hour), Math.max(s.open_hour, s.close_hour - s.min_hours));
    const defEnd = Math.min(s.close_hour, defStart + Math.max(4, s.min_hours));
    m.innerHTML = `<h1>New booking</h1><p class="sub">For requests that came in by phone, WhatsApp, Instagram, email or in person. It's saved just like a website booking.</p>
      <form class="form" novalidate id="nb" style="max-width:760px" autocomplete="off">
        <div class="panel"><h2>Customer</h2>
          <div class="grid2">
            <label class="fld"><span>Name</span><input name="name" required maxlength="80"></label>
            <label class="fld"><span>Came in through</span><select name="source">${cfg.sources.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
            <label class="fld"><span>Phone</span><input name="phone" type="tel" maxlength="24" placeholder="+960 7xx xxxx"></label>
            <label class="fld"><span>Email (optional, needed for automatic emails)</span><input name="email" type="email" maxlength="190"></label>
          </div>
          <p class="hint" style="margin-top:10px">With an email, the booking also appears on the customer's <em>My bookings</em> page if they sign in with that address later.</p>
        </div>
        <div class="panel"><h2>Event</h2>
          <div class="grid2">
            <label class="fld"><span>Event</span><select name="eventType">${cfg.eventTypes.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
            <label class="fld"><span>Guests</span><input name="guests" type="number" min="1" value="100" inputmode="numeric"></label>
            <label class="fld"><span>Date</span><input name="date" type="date" min="${today}" required></label>
            <div class="row2"><label class="fld"><span>From</span><select name="start">${hourOpts(0, 23, defStart)}</select></label>
            <label class="fld"><span>To</span><select name="end">${hourOpts(1, 24, defEnd)}</select></label></div>
          </div>
          <div class="astrip" id="nbStrip" aria-hidden="true"></div>
          <p class="nb-avail" id="nbAvail" aria-live="polite">Pick a date to check availability.</p>
          <label class="fld" style="margin-top:6px"><span>Customer's notes or requests (optional)</span><textarea name="notes" maxlength="1000" placeholder="Theme, set-up time, catering, decorations…"></textarea></label>
        </div>
        <div class="panel"><h2>Status and payment</h2>
          <div class="grid2">
            <label class="fld"><span>Status</span><select name="status">
              <option value="approved">Approved, waiting for payment</option>
              <option value="confirmed">Confirmed, already paid</option>
              <option value="pending">Pending, decide later</option></select></label>
            <label class="fld"><span>Amount (${esc(s.currency)})</span><input name="amount" type="number" min="0" step="1"></label>
          </div>
          <p class="hint" id="nbPrice" style="margin-top:8px"></p>
          <label class="fld" style="margin-top:10px"><span>Message to the customer (optional, included in the email)</span><textarea name="note" maxlength="600"></textarea></label>
          <label style="display:flex;gap:10px;align-items:center;margin-top:12px;font-size:15px"><input type="checkbox" name="notify" checked disabled> <span id="nbNotifyLabel">Email the customer (add an email above)</span></label>
        </div>
        <p class="form-err" role="alert"></p>
        <div><button class="btn btn-primary" type="submit">Save booking</button></div>
      </form>`;

    const form = document.getElementById('nb');
    const F = (n) => form.elements[n];
    let amountTouched = false, avail = { days: {} }, lastMonth = '';
    F('amount').addEventListener('input', () => { amountTouched = true; });

    function price() {
      const h = Number(F('end').value) - Number(F('start').value);
      document.getElementById('nbPrice').textContent = h > 0 ? `${h} hours × ${A.fmtMoney(s.currency, s.hourly_rate)} = ${A.fmtMoney(s.currency, h * s.hourly_rate)}. Change the amount for discounts or extras.` : '';
      if (!amountTouched && h > 0) F('amount').value = h * s.hourly_rate;
    }
    function notifyState() {
      const has = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(F('email').value.trim());
      F('notify').disabled = !has;
      const st = F('status').value;
      document.getElementById('nbNotifyLabel').textContent = !has ? 'Email the customer (add an email above)'
        : st === 'approved' ? 'Email the customer the payment details' : st === 'confirmed' ? 'Email the customer a booking confirmation' : 'Email the customer that we got their request';
    }
    const within = (h, ranges) => ranges.some((r) => h >= r[0] && h < r[1]);
    async function check() {
      price();
      const d = F('date').value, st = Number(F('start').value), en = Number(F('end').value);
      const strip = document.getElementById('nbStrip'), msg = document.getElementById('nbAvail');
      msg.dataset.tone = '';
      if (!d) { strip.innerHTML = ''; msg.textContent = 'Pick a date to check availability.'; return; }
      const month = d.slice(0, 7);
      if (month !== lastMonth) {
        try { avail = await A.api('GET', `/api/availability?month=${month}`); lastMonth = month; }
        catch (e) { msg.textContent = e.message; return; }
      }
      if (F('date').value !== d) return;
      const day = avail.days[d] || { booked: [], requested: [] };
      let html = '', clash = false, asked = false;
      for (let h = 0; h < 24; h++) {
        const sel = h >= st && h < en, booked = within(h, day.booked), req = within(h, day.requested);
        if (sel && booked) clash = true;
        if (sel && req) asked = true;
        html += `<span class="ah ${booked ? 'booked' : req ? 'req' : ''} ${sel ? 'sel' : ''} ${h < s.open_hour || h >= s.close_hour ? 'off' : ''}" title="${A.fmtHour(h)}"></span>`;
      }
      strip.innerHTML = html + `<span class="al">12am</span><span class="am">12pm</span><span class="ar">12am</span>`;
      if (en <= st) { msg.textContent = 'The end time needs to be after the start.'; msg.dataset.tone = 'bad'; return; }
      const taken = day.booked.map((r) => `${A.fmtHour(r[0])}–${A.fmtHour(r[1])}`).join(', ');
      if (clash) { msg.textContent = `Already booked: ${taken}. Choose other hours, or save it as "Pending" to decide later.`; msg.dataset.tone = 'bad'; }
      else if (asked) { msg.textContent = 'Free, but a website request is waiting for part of these hours. Saving this as approved or confirmed will block that request.'; msg.dataset.tone = 'warn'; }
      else { msg.textContent = `Free${taken ? `. Other bookings that day: ${taken}` : ''}.`; msg.dataset.tone = 'ok'; }
    }
    ['date', 'start', 'end'].forEach((n) => F(n).addEventListener('change', check));
    F('email').addEventListener('input', notifyState);
    F('status').addEventListener('change', notifyState);
    price(); notifyState();

    formSubmit(form, 'Saving…', async (v) => {
      if (String(v.name || '').trim().length < 2) throw new Error("Enter the customer's name.");
      if (!v.phone && !v.email) throw new Error('Enter a phone number or an email, so you can reach the customer.');
      if (!v.date) throw new Error('Pick a date.');
      const body = { ...v, start: Number(v.start), end: Number(v.end), guests: Number(v.guests), notify: !F('notify').disabled && F('notify').checked };
      const r = await A.api('POST', '/api/admin/bookings', body);
      const emailed = r.emailed === 'sent' ? ' Email sent.' : r.emailed ? ` The email couldn't be sent: ${r.emailed}` : '';
      A.toast(`Saved ${r.booking.ref}.${emailed}`, r.emailed && r.emailed !== 'sent' ? 'error' : '');
      refreshCounts();
      openBooking(r.booking.id);
      form.reset(); amountTouched = false; lastMonth = ''; price(); notifyState(); check();
    });
  }

  // ---------- block time ----------

  function block() {
    const m = main();
    const today = new Date().toISOString().slice(0, 10);
    const hours = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    m.innerHTML = `<h1>Block time</h1><p class="sub">Hold hours for phone bookings, private use or maintenance. Customers will see them as booked.</p>
      <div class="panel" style="max-width:560px"><form class="form" novalidate>
        <label class="fld"><span>Date</span><input name="date" type="date" min="${today}" required></label>
        <div class="row2"><label class="fld"><span>From</span><select name="start">${hours(0, 23).map((h) => `<option value="${h}" ${h === settings.open_hour ? 'selected' : ''}>${A.fmtHour(h)}</option>`).join('')}</select></label>
        <label class="fld"><span>To</span><select name="end">${hours(1, 24).map((h) => `<option value="${h}" ${h === settings.close_hour ? 'selected' : ''}>${A.fmtHour(h)}</option>`).join('')}</select></label></div>
        <label class="fld"><span>Reason (only staff see this)</span><input name="reason" maxlength="200" placeholder="Phone booking: Hassan, 7xx xxxx"></label>
        <p class="form-err" role="alert"></p><div><button class="btn btn-primary" type="submit">Block these hours</button></div></form></div>`;
    const form = m.querySelector('form');
    formSubmit(form, 'Saving…', async (f) => {
      if (!f.date) throw new Error('Pick a date.');
      const r = await A.api('POST', '/api/admin/blocks', { date: f.date, start: +f.start, end: +f.end, reason: f.reason });
      A.toast(`Blocked ${A.fmtHour(r.booking.start)}–${A.fmtHour(r.booking.end)} on ${A.fmtDate(r.booking.date)}.`);
      form.reset();
    });
  }

  // ---------- admins (master) ----------

  async function admins() {
    const m = main();
    m.innerHTML = `<h1>Admin users</h1><p class="sub">Everyone who can sign in to this panel. Only you, the master admin, can change this list.</p>
      <div id="alist"><p class="muted">Loading…</p></div>
      <div class="panel" style="max-width:620px"><h2>Add an admin</h2><form class="form" novalidate id="addform" autocomplete="off">
        <div class="row2"><label class="fld"><span>Username</span><input name="username" required autocapitalize="none" autocomplete="off"></label>
        <label class="fld"><span>Name</span><input name="name" maxlength="80"></label></div>
        <label class="fld"><span>Email (optional)</span><input name="email" type="email" maxlength="190"></label>
        <label class="fld"><span>Temporary password</span><input name="pw" required autocomplete="off" value="${randomPassword()}"></label>
        <p class="hint">Share it privately. They must choose their own password the first time they sign in.</p>
        <p class="form-err" role="alert"></p><div><button class="btn btn-primary" type="submit">Add admin</button></div></form></div>`;
    async function load() {
      const { admins } = await A.api('GET', '/api/admin/admins');
      const box = document.getElementById('alist');
      box.innerHTML = `<table class="table" style="display:table;margin-bottom:22px"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
        ${admins.map((a) => `<tr style="cursor:default"><td><strong>${esc(a.username)}</strong><div class="muted">${esc(a.name)}${a.email ? ' · ' + esc(a.email) : ''}</div></td>
          <td>${a.isMaster ? 'Master admin' : 'Admin'}</td>
          <td>${a.active ? (a.mustChange ? A.chip('pending').replace('Waiting for approval', 'Temporary password') : '<span class="chip chip-good">Active</span>') : '<span class="chip chip-off">Disabled</span>'}</td>
          <td class="muted">${a.lastLoginAt ? esc(A.fmtWhen(a.lastLoginAt)) : 'Never'}</td>
          <td style="white-space:nowrap">${a.id === me.id ? '<span class="muted">You</span>' : `
            <button class="btn btn-ghost btn-sm" data-a="reset" data-id="${a.id}" data-u="${esc(a.username)}">Reset password</button>
            <button class="btn btn-ghost btn-sm" data-a="toggle" data-id="${a.id}" data-on="${a.active ? 1 : 0}">${a.active ? 'Disable' : 'Enable'}</button>
            ${a.active ? `<button class="btn btn-ghost btn-sm" data-a="master" data-id="${a.id}" data-u="${esc(a.username)}">Make master</button>` : ''}
            <button class="btn btn-danger btn-sm" data-a="delete" data-id="${a.id}" data-u="${esc(a.username)}">Remove</button>`}</td></tr>`).join('')}
        </tbody></table>`;
      box.querySelectorAll('[data-a]').forEach((btn) => btn.addEventListener('click', () => adminAction(btn, load)));
    }
    formSubmit(document.getElementById('addform'), 'Adding…', async (f) => {
      const username = f.username.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Username: 3–32 lowercase letters, numbers, dots, dashes or underscores.');
      const p = pwProblem(f.pw, username); if (p) throw new Error(p);
      await A.api('POST', '/api/admin/admins', { username, name: f.name, email: f.email, pw: await A.prehash('admin', username, f.pw) });
      showSecret(`${username} can now sign in`, `Give ${username} this temporary password privately. They must change it the first time they sign in. It won't be shown again.`, f.pw);
      admins();
    });
    load().catch((e) => { document.getElementById('alist').innerHTML = `<p class="form-err">${esc(e.message)}</p>`; });
  }

  function adminAction(btn, reload) {
    const id = btn.dataset.id, u = btn.dataset.u, act = btn.dataset.a;
    if (act === 'toggle') {
      return A.api('POST', `/api/admin/admins/${id}/update`, { active: btn.dataset.on !== '1' }).then(reload).catch((e) => A.toast(e.message, 'error'));
    }
    const forms = {
      reset: { title: `New temporary password for ${u}`, intro: 'They will be signed out and must choose their own password next time.', field: `<label class="fld"><span>Temporary password</span><input name="pw" value="${randomPassword()}" autocomplete="off"></label>`, cta: 'Reset password' },
      master: { title: `Make ${u} the master admin?`, intro: 'You will become a regular admin. Only the master admin can manage admins and settings.', field: '<label class="fld"><span>Your password, to confirm</span><input name="pw" type="password" autocomplete="current-password"></label>', cta: 'Hand over master role' },
      delete: { title: `Remove ${u}?`, intro: 'They lose access immediately. Their past actions stay in the activity log.', field: '', cta: 'Remove admin' },
    }[act];
    const m = A.modal(`<h2 class="dlg-title">${esc(forms.title)}</h2><p class="dlg-intro">${esc(forms.intro)}</p><form class="form" novalidate>${forms.field}<p class="form-err" role="alert"></p>
      <button class="btn ${act === 'reset' ? 'btn-primary' : 'btn-danger'} btn-block" type="submit">${esc(forms.cta)}</button></form>`, { label: forms.title });
    formSubmit(m.el.querySelector('form'), 'Saving…', async (f) => {
      if (act === 'reset') {
        const p = pwProblem(f.pw, u); if (p) throw new Error(p);
        await A.api('POST', `/api/admin/admins/${id}/reset-password`, { pw: await A.prehash('admin', u, f.pw) });
        m.close(); showSecret(`New password for ${u}`, `Give ${u} this temporary password privately. They must change it when they sign in. It won't be shown again.`, f.pw); reload(); return;
      } else if (act === 'master') {
        await A.api('POST', `/api/admin/admins/${id}/make-master`, { pw: await A.prehash('admin', me.username, f.pw || '') });
        m.close(); A.toast(`${u} is now the master admin.`); me.isMaster = false; start(); return;
      } else {
        await A.api('POST', `/api/admin/admins/${id}/delete`, {});
        A.toast(`${u} removed.`);
      }
      m.close(); reload();
    });
  }

  function showSecret(title, intro, secret) {
    const m = A.modal(`<h2 class="dlg-title">${esc(title)}</h2><p class="dlg-intro">${esc(intro)}</p><p class="secret">${esc(secret)}</p>
      <div class="row2"><button class="btn btn-ghost" type="button" data-copy>Copy password</button><button class="btn btn-primary" type="button" data-done>Done</button></div>`, { label: title });
    m.el.querySelector('[data-done]').addEventListener('click', m.close);
    const c = m.el.querySelector('[data-copy]');
    c.addEventListener('click', () => navigator.clipboard.writeText(secret).then(() => { c.textContent = 'Copied'; }).catch(() => { c.textContent = 'Select and copy it'; }));
  }

  // ---------- settings (master) ----------

  async function settingsView() {
    const m = main();
    const { settings: s, email } = await A.api('GET', '/api/admin/settings');
    const f = (k, label, type = 'text', extra = '') => `<label class="fld"><span>${esc(label)}</span><input name="${k}" type="${type}" value="${esc(s[k])}" ${extra}></label>`;
    m.innerHTML = `<h1>Settings</h1><p class="sub">Prices, opening hours and the bank details customers see after you approve them.</p>
      <form class="form" novalidate id="sform" style="max-width:760px">
        <div class="panel"><h2>Pricing and hours</h2><div class="grid2">
          ${f('hourly_rate', 'Price per hour', 'number', 'min="0" step="1"')}${f('currency', 'Currency', 'text', 'maxlength="6"')}
          ${f('open_hour', 'Opens at (0–23)', 'number', 'min="0" max="23"')}${f('close_hour', 'Closes at (1–24)', 'number', 'min="1" max="24"')}
          ${f('min_hours', 'Minimum hours per booking', 'number', 'min="1" max="24"')}${f('max_guests', 'Maximum guests', 'number', 'min="1"')}
          ${f('pay_within_hours', 'Hours to pay after approval (0 = no limit)', 'number', 'min="0"')}
          ${f('gap_hours', 'Gap between bookings, in hours, for set-up and cleaning (0 = back-to-back allowed)', 'number', 'min="0" max="12"')}
          ${f('admin_idle_minutes', 'Sign staff out after this many minutes without activity', 'number', 'min="5" max="480"')}
        </div></div>
        <div class="panel"><h2>Bank transfer details</h2><div class="grid2">
          ${f('bank_name', 'Bank')}${f('account_name', 'Account name')}${f('account_number', 'Account number')}
        </div><label class="fld" style="margin-top:14px"><span>Payment instructions</span><textarea name="payment_note" maxlength="400">${esc(s.payment_note)}</textarea></label></div>
        <div class="panel"><h2>Email</h2>
          <p style="margin:0 0 14px">${email.provider === 'gmail' ? `Sending through <strong>Gmail</strong> as ${esc(email.from)}.`
            : email.provider === 'resend' ? `Sending through <strong>Resend</strong> as ${esc(email.from)}.`
            : '<strong>Emails are not being sent.</strong> Add the GMAIL_USER and GMAIL_APP_PASSWORD secrets in Cloudflare (see the README).'}</p>
          ${f('notify_email', 'Email for new requests and uploaded slips', 'email')}
          <div class="toolbar" style="margin:14px 0 0;align-items:flex-end">
            <label class="fld" style="flex:1"><span>Send a test email to</span><input id="testTo" type="email" value="${esc(s.notify_email || me.email || '')}"></label>
            <button class="btn btn-ghost" type="button" id="testBtn">Send test email</button>
          </div></div>
        <p class="form-err" role="alert"></p><div><button class="btn btn-primary" type="submit">Save settings</button></div>
      </form>`;
    const tb = document.getElementById('testBtn');
    tb.addEventListener('click', () => A.busy(tb, 'Sending…', () => A.api('POST', '/api/admin/test-email', { to: document.getElementById('testTo').value }))
      .then((r) => A.toast(`Test email sent to ${r.to}. Check the inbox (and spam).`))
      .catch((e) => A.toast(e.message, 'error')));
    formSubmit(document.getElementById('sform'), 'Saving…', async (v) => {
      const r = await A.api('POST', '/api/admin/settings', v);
      settings = r.settings; A.toast('Settings saved.');
    });
  }

  // ---------- activity (master) ----------

  async function activity() {
    const m = main();
    m.innerHTML = '<h1>Activity log</h1><p class="sub">The last 200 admin actions, including failed sign-ins.</p><div id="log"><p class="muted">Loading…</p></div>';
    const { entries } = await A.api('GET', '/api/admin/audit');
    const labels = { login: 'Signed in', login_failed: 'Failed sign-in', approve: 'Approved', reject: 'Rejected', confirm: 'Confirmed payment', 'reject-slip': 'Rejected slip', cancel: 'Cancelled', block: 'Blocked time', settings: 'Changed settings', admin_added: 'Added admin', admin_disabled: 'Disabled admin', admin_updated: 'Updated admin', admin_password_reset: 'Reset admin password', admin_removed: 'Removed admin', master_transferred: 'Handed over master', password_changed: 'Changed own password', setup: 'Setup', resend_email: 'Resent email', test_email: 'Sent test email', manual_booking: 'Added a booking', slip_added: 'Attached a slip', reschedule: 'Changed the time', user_suspended: 'Suspended a customer', user_unsuspended: 'Restored a customer' };
    document.getElementById('log').innerHTML = entries.length ? `<table class="table" style="display:table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>IP</th></tr></thead><tbody>
      ${entries.map((e) => `<tr style="cursor:default"><td class="muted">${esc(A.fmtWhen(e.at))}</td><td>${esc(e.username || '–')}</td><td>${esc(labels[e.action] || e.action)}</td><td>${esc(e.detail)}</td><td class="muted">${esc(e.ip)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="panel">No activity yet.</div>';
  }

  function password() {
    const m = main();
    m.innerHTML = `<div class="panel" style="max-width:520px">${passwordForm('Change password', 'Use a long passphrase you don’t use anywhere else.')}</div>`;
    wirePasswordForm(m, () => { A.toast('Password changed. Other devices were signed out.'); m.querySelector('form').reset(); });
  }

  // ---------- start ----------

  async function start() {
    if (!me) {
      const st = await A.api('GET', '/api/admin/state').catch(() => null);
      if (!st) {
        const h = await A.api('GET', '/api/health').catch(() => null);
        const list = h && h.problems.length ? `<ul style="padding-left:18px;line-height:1.5">${h.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="sub">Check your connection and reload.</p>';
        gate(`<h1>Setup isn't finished</h1>${list}<p class="sub">Fix these, then reload this page.</p>`);
        return;
      }
      if (st.needsSetup) return setupScreen(st.setupEnabled);
      if (!st.admin) return loginScreen();
      me = st.admin;
      if (st.idleMinutes) idleMinutes = st.idleMinutes;
    }
    if (me.mustChange) return mustChangeScreen();
    shell();
    startIdle();
    await refreshCounts();
    route();
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshCounts, 60000);
  }
  window.addEventListener('hashchange', route);
  start();
})();
