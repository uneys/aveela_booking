// Vendor admin panel.
(function () {
  const A = window.Aveela;
  const { esc } = A;
  const root = document.getElementById('root');
  const MIN_ADMIN_PW = 12;
  let me = null, settings = null, counts = {}, pollTimer = null;

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

  function loginScreen() {
    const c = gate(`<h1>Sign in</h1><p class="sub">Venue staff only.</p>
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

  // ---------- shell ----------

  const VIEWS = [
    { id: 'requests', label: 'Requests', count: 'pending' },
    { id: 'payments', label: 'Payments to check', count: 'slip_uploaded' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'all', label: 'All bookings' },
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
      clearInterval(pollTimer); me = null; loginScreen();
    });
    const side = document.getElementById('side'), menuBtn = document.getElementById('menuBtn');
    menuBtn.addEventListener('click', () => { const on = side.classList.toggle('on'); menuBtn.setAttribute('aria-expanded', on); });
    side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('on'); });
    document.getElementById('shade').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  }

  async function refreshCounts() {
    try {
      const r = await A.api('GET', '/api/admin/overview');
      counts = r.counts; settings = r.settings;
      document.querySelectorAll('[data-count]').forEach((el) => {
        const n = counts[el.dataset.count] || 0;
        el.textContent = n; el.hidden = !n;
      });
    } catch (e) { if (e.status === 401) { clearInterval(pollTimer); loginScreen(); } }
  }

  function route() {
    if (!me) return;
    let id = location.hash.slice(1) || 'requests';
    const v = VIEWS.find((x) => x.id === id && (!x.master || me.isMaster));
    if (!v) id = 'requests';
    document.querySelectorAll('[data-view]').forEach((a) => a.setAttribute('aria-current', a.dataset.view === id ? 'page' : 'false'));
    closeDrawer();
    ({ requests, payments, upcoming, all, block, admins, settings: settingsView, activity, password }[id])();
  }

  const main = () => document.getElementById('main');

  // ---------- booking lists ----------

  function rowHtml(b) {
    const cust = b.customer ? `${esc(b.customer.name)}<div class="muted">${esc(b.customer.email)}</div>` : '<span class="muted">Blocked by venue</span>';
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
      actions = `<div class="actbox">
        <label class="fld"><span>Amount to charge (${esc(cur)})</span><input id="amount" type="number" min="0" step="1" value="${b.amount}"></label>
        <p class="hint" style="margin-top:-6px">${hrs} hours × ${esc(A.fmtMoney(cur, settings.hourly_rate))} = ${esc(A.fmtMoney(cur, hrs * settings.hourly_rate))}. Change it for discounts or extras.</p>
        <label class="fld"><span>Message to the customer (optional for approval, recommended when rejecting)</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div class="row2"><button class="btn btn-danger" type="button" data-act="reject">Reject</button><button class="btn btn-primary" type="button" data-act="approve" ${holding.length ? 'disabled' : ''}>Approve and request payment</button></div></div>`;
    } else if (b.status === 'slip_uploaded') {
      actions = `<div class="actbox">
        <label class="fld"><span>Message to the customer (included in the email)</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div class="row2"><button class="btn btn-danger" type="button" data-act="reject-slip">Slip doesn't match</button><button class="btn btn-primary" type="button" data-act="confirm">Payment received, confirm</button></div></div>`;
    } else if (['approved', 'confirmed', 'blocked'].includes(b.status)) {
      actions = `<div class="actbox">
        <label class="fld"><span>Reason (sent to the customer)</span><textarea id="note" maxlength="600"></textarea></label>
        <p class="form-err" role="alert"></p>
        <div><button class="btn btn-danger" type="button" data-act="cancel">${b.status === 'blocked' ? 'Remove block' : 'Cancel booking'}</button></div></div>`;
    }
    d.innerHTML = `<button class="modal-x" type="button" aria-label="Close">×</button>
      <h2>${esc(b.eventType)}</h2>${A.chip(b.status)}
      <dl class="kv">
        <dt>Reference</dt><dd>${esc(b.ref)}</dd>
        <dt>Date</dt><dd>${esc(A.fmtDate(b.date, { weekday: 'long', month: 'long' }))}</dd>
        <dt>Time</dt><dd>${A.fmtHour(b.start)} to ${A.fmtHour(b.end)} (${hrs} h)</dd>
        <dt>Guests</dt><dd>${b.guests || '–'}</dd>
        <dt>Amount</dt><dd>${b.amount ? esc(A.fmtMoney(cur, b.amount)) : '–'}</dd>
        ${b.customer ? `<dt>Customer</dt><dd>${esc(b.customer.name)}<br><a href="mailto:${esc(b.customer.email)}">${esc(b.customer.email)}</a>${b.customer.phone ? `<br>${esc(b.customer.phone)}` : ''}</dd>` : ''}
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
      ${actions}`;
    d.querySelector('.modal-x').addEventListener('click', closeDrawer);
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
      if (act === 'approve') body.amount = d.querySelector('#amount').value === '' ? undefined : Number(d.querySelector('#amount').value);
      try {
        await A.busy(btn, 'Saving…', () => A.api('POST', `/api/admin/bookings/${b.id}/${act}`, body));
        const msg = { approve: 'Approved. Payment details emailed.', reject: 'Rejected. Customer emailed.', confirm: 'Confirmed. Confirmation emailed.', 'reject-slip': 'Customer asked for a new slip.', cancel: 'Cancelled.' }[act];
        A.toast(msg); closeDrawer(); refreshCounts(); if (onChange) onChange();
      } catch (ex) { err.textContent = ex.message; }
    }));
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
    const { settings: s } = await A.api('GET', '/api/admin/settings');
    const f = (k, label, type = 'text', extra = '') => `<label class="fld"><span>${esc(label)}</span><input name="${k}" type="${type}" value="${esc(s[k])}" ${extra}></label>`;
    m.innerHTML = `<h1>Settings</h1><p class="sub">Prices, opening hours and the bank details customers see after you approve them.</p>
      <form class="form" novalidate id="sform" style="max-width:760px">
        <div class="panel"><h2>Pricing and hours</h2><div class="grid2">
          ${f('hourly_rate', 'Price per hour', 'number', 'min="0" step="1"')}${f('currency', 'Currency', 'text', 'maxlength="6"')}
          ${f('open_hour', 'Opens at (0–23)', 'number', 'min="0" max="23"')}${f('close_hour', 'Closes at (1–24)', 'number', 'min="1" max="24"')}
          ${f('min_hours', 'Minimum hours per booking', 'number', 'min="1" max="24"')}${f('max_guests', 'Maximum guests', 'number', 'min="1"')}
          ${f('pay_within_hours', 'Hours to pay after approval (0 = no limit)', 'number', 'min="0"')}
        </div></div>
        <div class="panel"><h2>Bank transfer details</h2><div class="grid2">
          ${f('bank_name', 'Bank')}${f('account_name', 'Account name')}${f('account_number', 'Account number')}
        </div><label class="fld" style="margin-top:14px"><span>Payment instructions</span><textarea name="payment_note" maxlength="400">${esc(s.payment_note)}</textarea></label></div>
        <div class="panel"><h2>Notifications</h2>${f('notify_email', 'Email for new requests and uploaded slips', 'email')}</div>
        <p class="form-err" role="alert"></p><div><button class="btn btn-primary" type="submit">Save settings</button></div>
      </form>`;
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
    const labels = { login: 'Signed in', login_failed: 'Failed sign-in', approve: 'Approved', reject: 'Rejected', confirm: 'Confirmed payment', 'reject-slip': 'Rejected slip', cancel: 'Cancelled', block: 'Blocked time', settings: 'Changed settings', admin_added: 'Added admin', admin_disabled: 'Disabled admin', admin_updated: 'Updated admin', admin_password_reset: 'Reset admin password', admin_removed: 'Removed admin', master_transferred: 'Handed over master', password_changed: 'Changed own password', setup: 'Setup' };
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
      if (!st) { gate('<h1>Can’t reach the server</h1><p class="sub">Check your connection and reload.</p>'); return; }
      if (st.needsSetup) return setupScreen(st.setupEnabled);
      if (!st.admin) return loginScreen();
      me = st.admin;
    }
    if (me.mustChange) return mustChangeScreen();
    shell();
    await refreshCounts();
    route();
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshCounts, 60000);
  }
  window.addEventListener('hashchange', route);
  start();
})();
