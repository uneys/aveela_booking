// Shared helpers for every page: API calls, password pre-hashing, formatting, toasts.
(function () {
  const A = (window.Aveela = window.Aveela || {});

  A.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // opts.bg: a background refresh, which the server doesn't count as activity for sign-out timeouts.
  A.api = async function (method, path, body, { bg = false } = {}) {
    const opts = { method, headers: { 'x-aveela': '1' }, credentials: 'same-origin' };
    if (bg) opts.headers['x-aveela-bg'] = '1';
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(path, opts); } catch { throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 }); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status, code: data.code });
    return data;
  };

  // The slow part of password hashing runs here, in the browser (600,000 PBKDF2 rounds).
  // Only the result is sent; the server adds its secret pepper and its own hash on top.
  A.prehash = async function (realm, identifier, password) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`aveela:${realm}:${String(identifier).trim().toLowerCase()}`), iterations: 600000 },
      key, 256);
    let s = '';
    new Uint8Array(bits).forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  };

  A.fmtHour = (h) => (h === 0 || h === 24 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`);
  A.fmtDate = (d, opts) => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts });
  A.fmtMoney = (cur, n) => `${cur} ${Number(n || 0).toLocaleString('en-US')}`;
  A.fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  A.STATUS = {
    pending: { label: 'Waiting for approval', tone: 'wait' },
    approved: { label: 'Approved, payment due', tone: 'act' },
    slip_uploaded: { label: 'Checking payment', tone: 'wait' },
    confirmed: { label: 'Confirmed', tone: 'good' },
    rejected: { label: 'Declined', tone: 'off' },
    cancelled: { label: 'Cancelled', tone: 'off' },
    expired: { label: 'Payment deadline passed', tone: 'off' },
    blocked: { label: 'Blocked', tone: 'off' },
  };
  A.chip = (status) => {
    const s = A.STATUS[status] || { label: status, tone: 'off' };
    return `<span class="chip chip-${s.tone}">${A.esc(s.label)}</span>`;
  };

  let toastTimer;
  A.toast = function (msg, tone) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.dataset.tone = tone || '';
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 4200);
  };

  // Disable a button while an async action runs; shows a label like "Signing in…".
  A.busy = async function (btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };

  A.config = null;
  A.loadConfig = async () => (A.config ||= await A.api('GET', '/api/config'));
  A.me = undefined;
  A.loadMe = async () => { A.me = (await A.api('GET', '/api/me')).user; return A.me; };

  // Simple modal manager with focus trap and Esc to close.
  A.modal = function (html, { label = 'Dialog', onClose } = {}) {
    const last = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${A.esc(label)}"><button class="modal-x" type="button" aria-label="Close">×</button>${html}</div>`;
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => wrap.classList.add('on'));
    const card = wrap.firstElementChild;
    const close = () => {
      wrap.classList.remove('on');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
      setTimeout(() => wrap.remove(), 250);
      if (last && last.focus) last.focus();
      if (onClose) onClose();
    };
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const f = [...card.querySelectorAll('button,input,select,textarea,a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    card.querySelector('.modal-x').addEventListener('click', close);
    setTimeout(() => { const f = card.querySelector('input,select,textarea,button:not(.modal-x)'); if (f) f.focus(); }, 60);
    return { el: card, close };
  };
})();
