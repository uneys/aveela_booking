// Sign-in / create-account dialog used by the home page and the account page.
(function () {
  const A = window.Aveela;
  const { esc } = A;

  const googleIcon = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>';
  const appleIcon = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.8 1.3 10.3.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.2zM13.9 5c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3-1.5z"/></svg>';

  function providerButtons(cfg, next) {
    const n = encodeURIComponent(next || location.pathname + location.hash);
    let h = '';
    if (cfg.googleEnabled) h += `<a class="btn btn-provider" href="/auth/google?next=${n}">${googleIcon}<span>Continue with Google</span></a>`;
    if (cfg.appleEnabled) h += `<a class="btn btn-provider btn-apple" href="/auth/apple?next=${n}">${appleIcon}<span>Continue with Apple</span></a>`;
    return h ? `<div class="providers">${h}</div><p class="or"><span>or use your email</span></p>` : '';
  }

  // Renders the sign-in UI into `root`. Calls onDone(user) after a successful sign-in.
  function render(root, { next, onDone, title, intro } = {}) {
    let mode = 'signin';
    const cfg = A.config || {};
    function draw() {
      root.innerHTML = `
        <h2 class="dlg-title">${esc(mode === 'forgot' ? 'Reset your password' : title || 'Sign in to book')}</h2>
        ${mode === 'forgot' ? '<p class="dlg-intro">Enter your email and we\'ll send you a link to choose a new password.</p>' : intro ? `<p class="dlg-intro">${esc(intro)}</p>` : ''}
        ${mode !== 'forgot' ? providerButtons(cfg, next) : ''}
        ${mode !== 'forgot' ? `<div class="seg" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected="${mode === 'signin'}" data-m="signin">Sign in</button>
            <button type="button" role="tab" aria-selected="${mode === 'signup'}" data-m="signup">Create account</button></div>` : ''}
        <form class="form" novalidate>
          ${mode === 'signup' ? '<label class="fld"><span>Your name</span><input name="name" autocomplete="name" required maxlength="80"></label>' : ''}
          <label class="fld"><span>Email</span><input name="email" type="email" autocomplete="email" required maxlength="190"></label>
          ${mode === 'signup' ? '<label class="fld"><span>Phone (optional)</span><input name="phone" type="tel" autocomplete="tel" maxlength="24"></label>' : ''}
          ${mode !== 'forgot' ? `<label class="fld"><span>Password</span><input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required minlength="8" maxlength="200"></label>` : ''}
          ${mode === 'signup' ? '<p class="hint">At least 8 characters.</p>' : ''}
          <p class="form-err" role="alert"></p>
          <button class="btn btn-primary btn-block" type="submit">${mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</button>
        </form>
        ${mode === 'signin' ? '<button type="button" class="linkish" data-m="forgot">Forgot your password?</button>' : ''}
        ${mode === 'forgot' ? '<button type="button" class="linkish" data-m="signin">Back to sign in</button>' : ''}`;
      root.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.m; draw(); root.querySelector('input')?.focus(); }));
      const form = root.querySelector('form');
      const err = root.querySelector('.form-err');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        const f = Object.fromEntries(new FormData(form));
        const email = String(f.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
        if (mode === 'signup' && String(f.name || '').trim().length < 2) { err.textContent = 'Enter your name.'; return; }
        if (mode !== 'forgot' && String(f.password || '').length < 8) { err.textContent = 'Passwords are at least 8 characters.'; return; }
        const btn = form.querySelector('button[type=submit]');
        try {
          await A.busy(btn, mode === 'forgot' ? 'Sending…' : mode === 'signup' ? 'Creating account…' : 'Signing in…', async () => {
            if (mode === 'forgot') {
              await A.api('POST', '/api/auth/forgot', { email });
              root.innerHTML = `<h2 class="dlg-title">Check your email</h2><p class="dlg-intro">If an account exists for ${esc(email)}, a reset link is on its way. It works for 1 hour.</p>`;
              return;
            }
            const pw = await A.prehash('user', email, f.password);
            const path = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
            const body = mode === 'signup' ? { email, pw, name: f.name, phone: f.phone } : { email, pw };
            const { user } = await A.api('POST', path, body);
            A.me = user;
            if (onDone) onDone(user, mode);
          });
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    }
    draw();
  }

  A.auth = {
    render,
    open(opts = {}) {
      return A.loadConfig().catch(() => ({})).then(() => {
        const m = A.modal('<div class="auth-root"></div>', { label: 'Sign in' });
        render(m.el.querySelector('.auth-root'), {
          ...opts,
          onDone: (u, mode) => { m.close(); if (opts.onDone) opts.onDone(u, mode); },
        });
        return m;
      });
    },
  };
})();
