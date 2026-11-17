# Aveela Event Space: booking website

A complete venue booking site that runs on Cloudflare's **free** Workers plan.

- Visitors check which hours are free on any date, without an account.
- To send a request they sign in with **Google**, **Apple**, or **email and password**.
- Customers request a date and an hourly time range. The venue **approves or rejects** it.
- After approval the customer gets the amount and bank details, **pays by transfer and uploads the bank slip**.
- The venue checks the slip and **confirms**, and the customer gets a confirmation **email**.
- An **admin panel** for venue staff with a **master admin** who can add, disable and remove admins, reset their passwords and change settings.

It deploys from GitHub: every push to `main` is tested and published automatically. Everything lives in one Cloudflare Worker: the website, the API, a D1 database and a KV store for bank slips.

---

## What it costs

| Piece | Free allowance | Notes |
|---|---|---|
| Cloudflare Workers | 100,000 requests a day | Hosting for the site and API |
| Cloudflare D1 | Daily read/write allowance, 5 GB | Bookings, accounts, settings |
| Cloudflare KV | 1,000 writes a day | One write per bank slip upload |
| Resend (email) | 3,000 emails a month, 100 a day | Needs a domain you own |
| Google sign-in | Free | |
| Apple sign-in | **US$99 a year** | Apple Developer Program. Optional: the Apple button only appears once you add the keys |

Cloudflare's own email sending only reaches arbitrary customers on the paid Workers plan, which is why email goes through Resend.

---

## 1. Deploy from GitHub (about 20 minutes, all in the browser)

Every push to `main` is tested and then deployed automatically by GitHub Actions (`.github/workflows/deploy.yml`). Pull requests are tested but not deployed. If a test fails, nothing is deployed.

You need a free [GitHub account](https://github.com/signup) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up). No software to install.

### Step 1: Put the code on GitHub

1. On GitHub, click **New repository**. Name it e.g. `aveela-site` and make it **Private**. Don't add a README.
2. Upload the project:
   - **Easiest:** use [GitHub Desktop](https://desktop.github.com): *File → Add local repository* → choose the `aveela` folder → *Publish repository*.
   - **Or with git:**
     ```bash
     cd aveela
     git init -b main && git add . && git commit -m "Aveela booking site"
     git remote add origin https://github.com/YOUR-NAME/aveela-site.git
     git push -u origin main
     ```
   - Dragging files into GitHub's web page can skip the hidden `.github` folder, which holds the deploy workflow. If you upload that way, check that `.github/workflows/deploy.yml` appears in the repository.

The first run will stop at **Check setup** with a list of what's missing. That's expected; the next steps fill it in.

### Step 2: Create the database and slip storage in Cloudflare

In the [Cloudflare dashboard](https://dash.cloudflare.com):

1. **Storage & databases → D1 → Create database.** Name it exactly `aveela`. Copy its **Database ID**.
2. **Storage & databases → Workers KV → Create namespace.** Name it `aveela-slips`. Copy its **ID**.
3. **Workers & Pages → Overview.** Note your **workers.dev subdomain** (e.g. `yourname.workers.dev`) and your **Account ID** (right-hand side).

### Step 3: Edit `wrangler.jsonc` on GitHub

Open `wrangler.jsonc` in your repository and click the pencil icon:

- Replace the first `REPLACE_ME` with the D1 **Database ID**.
- Replace the second `REPLACE_ME` with the KV namespace **ID**.
- Set `APP_URL` to `https://aveela.YOUR-SUBDOMAIN.workers.dev` (use your subdomain from step 2, no trailing slash).
- Set `MAIL_FROM` to the address emails should come from (see section 2).

Don't commit yet if you haven't done step 4. Committing starts a deploy, which would stop at Check setup again. That's harmless, though.

These ids aren't secret, so they're safe in the repository. Passwords and keys never go in the repository.

### Step 4: Let GitHub deploy to Cloudflare

1. In Cloudflare, go to **My Profile → API Tokens → Create Token** → use the **Edit Cloudflare Workers** template.
2. Under *Permissions*, click **Add more** and add **Account → D1 → Edit**. The template doesn't include D1, and without it the database step fails.
3. Under *Account Resources*, pick your account. Create the token and copy it (it's shown once).
4. In GitHub, open your repository → **Settings → Secrets and variables → Actions → New repository secret**, and add:
   - `CLOUDFLARE_API_TOKEN`: the token you just made
   - `CLOUDFLARE_ACCOUNT_ID`: your Account ID from step 2

Now commit the `wrangler.jsonc` change (or go to **Actions → Test and deploy → Run workflow**). Watch the run in the **Actions** tab. When it's green, the site is live at your `APP_URL`.

### Step 5: Add the app's secrets in Cloudflare

These stay in Cloudflare, not GitHub. Deploys keep them; you set them once.

In Cloudflare: **Workers & Pages → aveela → Settings → Variables and Secrets → Add**, choose type **Secret**, and add:

| Name | Value |
|---|---|
| `PEPPER` | A long random string. **Never change or lose it** |
| `SETUP_TOKEN` | Another long random string, used once to create the master admin |

To make random values, use a password manager's generator (64 characters, letters and numbers) or run
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

> ⚠️ Save the PEPPER in a password manager. If it changes or is lost, every password stops working and everyone has to reset theirs.

### Step 6: Create the master admin

Open `https://YOUR-ADDRESS/admin`, enter the SETUP_TOKEN, choose a username and a long password. Then delete the `SETUP_TOKEN` secret in Cloudflare (same page as step 5) so setup can't run again.

Then fill in **Settings** in the admin panel: price per hour, opening hours, minimum hours, how long customers have to pay, bank details, and the email address that should get new-request alerts.

### Making changes later

Edit any file on GitHub (or push from your computer) and commit to `main`. The workflow tests it, updates the database if you added a migration, and deploys. To change the database structure, add a new numbered file like `migrations/0002_add_something.sql`. Never edit a migration that has already run.

To use your own domain: **Workers & Pages → aveela → Settings → Domains & Routes → Add custom domain**, then change `APP_URL` in `wrangler.jsonc` (and the Google/Apple redirect URLs) to the new domain and commit.

<details><summary>Prefer the command line instead?</summary>

```bash
npm install && npx wrangler login
npx wrangler d1 create aveela                 # paste the id into wrangler.jsonc
npx wrangler kv namespace create SLIPS        # paste the id into wrangler.jsonc
npx wrangler secret put PEPPER
npx wrangler secret put SETUP_TOKEN
npm run deploy                                # applies migrations, then deploys
```
</details>

---

## If something isn't working

**First, open `https://YOUR-ADDRESS/api/health`.** It lists anything that's not set up, in plain words (it never shows secret values). The GitHub workflow also prints these as warnings at the end of each deploy.

**GitHub Actions run is red:** open the **Actions** tab → the failed run → the red step, and match the error:

| Step / error | Fix |
|---|---|
| **Check setup** fails | It lists what's missing: the two GitHub secrets, the `REPLACE_ME` ids or `APP_URL` in `wrangler.jsonc`. |
| **Run tests** fails | A code change broke something. The log names the failing check. Nothing was deployed. |
| `Authentication error [code: 10000]` | The API token lacks a permission. Edit it and make sure it has **Workers Scripts: Edit** *and* **D1: Edit**, for the right account. Update the `CLOUDFLARE_API_TOKEN` secret if you made a new token. |
| `Couldn't find a D1 DB with the name or binding 'aveela'` | The database must be named exactly `aveela`, and its id must be in `wrangler.jsonc`. |
| `KV namespace ... is not valid` / `not found` | The KV id in `wrangler.jsonc` is wrong. Copy it again from Storage & databases → Workers KV. |
| `You need to register a workers.dev subdomain` | Open **Workers & Pages** in the Cloudflare dashboard once and pick a subdomain, then re-run the workflow. |
| `account ID ... does not match` / `could not route to /accounts/...` | `CLOUDFLARE_ACCOUNT_ID` is wrong. Copy it again from Workers & Pages → Overview. |

To re-run after fixing: **Actions → Test and deploy → Run workflow**.

**The site loads but booking or the admin panel shows an error:**

| Message | Fix |
|---|---|
| *Server setup is incomplete: add the PEPPER secret* | Add `PEPPER` (at least 32 characters) in Cloudflare → aveela → Settings → Variables and Secrets. Choose type **Secret**, not Text. |
| *Database tables are missing* | The migrations step didn't run on this database. Re-run the workflow. |
| *Setup is turned off. Set the SETUP_TOKEN secret first* | Add the `SETUP_TOKEN` secret (step 5), then reload /admin. |
| *Online booking isn't available right now* on the home page | Open `/api/health` to see which setting is missing. |
| Google/Apple sign-in fails, or email links point to the wrong site | `APP_URL` must exactly match your site address, and the redirect URL in Google/Apple must use the same address. |
| No emails arrive | Add `RESEND_API_KEY` and set `MAIL_FROM` to an address on the domain you verified in Resend. Check Resend's dashboard → Logs. |

Live error logs: Cloudflare → Workers & Pages → aveela → **Logs**.

---

## 2. Email (Resend)

Without this the site still works, but no emails go out (they are written to the Worker logs instead).

1. Sign up at [resend.com](https://resend.com), add your domain and add the DNS records it shows you.
2. Create an API key and add it as the secret `RESEND_API_KEY` (Cloudflare → aveela → Settings → Variables and Secrets).
3. In `wrangler.jsonc` set `MAIL_FROM`, e.g. `"Aveela Event Space <bookings@aveela.mv>"` (must be on the domain you verified), and commit.

Emails sent: confirm your email, password reset, request received, approved with payment details, declined, slip rejected, booking confirmed, cancelled by venue, plus alerts to the venue for new requests and uploaded slips.

---

## 3. Google sign-in

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → OAuth consent screen**: set it up as *External*, add your app name and email, and publish it.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   - Authorized redirect URI: `https://YOUR-ADDRESS/auth/google/callback`
4. Add the client ID and client secret as the Cloudflare secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The Google button appears automatically; no redeploy needed.

## 4. Apple sign-in (optional, needs Apple Developer Program)

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list):
   - Create an **App ID** with *Sign in with Apple* enabled.
   - Create a **Services ID** (e.g. `mv.aveela.web`). Enable *Sign in with Apple* → Configure → pick the App ID, add your domain and the return URL `https://YOUR-ADDRESS/auth/apple/callback`.
   - Create a **Key** with *Sign in with Apple*, download the `.p8` file and note its Key ID.
2. Add these Cloudflare secrets:
   - `APPLE_CLIENT_ID`: the Services ID, e.g. `mv.aveela.web`
   - `APPLE_TEAM_ID`: shown top right on the Apple developer site
   - `APPLE_KEY_ID`: the key's ID
   - `APPLE_PRIVATE_KEY`: open the `.p8` file in a text editor and paste everything, including the BEGIN/END lines
3. Customers may hide their email behind an `@privaterelay.appleid.com` address. To reach them, register your sending domain under **Services → Sign in with Apple for Email Communication**.

---

## How the booking flow works

```
customer: check hours ─► sign in ─► request (pending)
venue:    approve (set amount) ─────────────► approved ── email with bank details
          reject ───────────────────────────► rejected ── email
customer: pay + upload slip ────────────────► slip_uploaded ── alert to venue
venue:    confirm payment ──────────────────► confirmed ── confirmation email
          slip doesn't match ───────────────► approved again ── email asking for a new slip
not paid in time ───────────────────────────► expired (hours released)
```

- **Pending** requests don't hold the hours, so several people can ask for the same time and the venue picks. Once one is approved, overlapping requests can't be approved.
- **Approved, slip uploaded, confirmed and blocked** bookings hold the hours. Visitors see them as booked.
- **Block time** in the admin panel holds hours for phone bookings or maintenance.
- Customers can cancel while a booking is pending or awaiting payment. After that they contact the venue.

---

## Security

**Passwords** (customers and admins) use a split, peppered slow hash:

1. In the browser: PBKDF2-SHA256 with **600,000 rounds**, salted with the email/username. Only this result is sent; the plain password never leaves the device.
2. On the server: HMAC-SHA256 with the secret **PEPPER** (kept in Cloudflare secrets, never in the database), then PBKDF2-SHA256 with a random per-user salt and `SERVER_HASH_ITERATIONS` rounds (default 20,000).

The free plan gives a Worker 10 ms of CPU per request, and Workers caps PBKDF2 at 100,000 rounds (about 25 ms). Splitting the work keeps sign-in inside the limit, while someone who steals the database still has to pay for all 620,000 rounds for every guess, and can't even start without the pepper. If you move to Workers Paid, raise `SERVER_HASH_ITERATIONS` to `100000`. Existing hashes upgrade automatically the next time each person signs in.

**Admin panel**
- Separate admin session cookie: `__Host-` prefixed, HttpOnly, Secure, SameSite=Strict, 8-hour expiry.
- Sign-in locks for 15 minutes after 5 wrong passwords for an account, or 20 from one network.
- New admins and reset passwords are temporary: the admin must choose their own password before doing anything.
- Changing your password signs out your other devices. Disabling an admin ends their sessions immediately.
- Only the master admin can manage admins, change settings or read the activity log. Handing over the master role needs the master's password. There is always exactly one master.
- Every admin action and failed sign-in is recorded in the activity log, with IP.
- The admin page is marked `noindex` and is not linked from the public site.

**Everywhere**
- Session tokens are random 256-bit values, stored only as SHA-256 hashes.
- State-changing API calls require a custom header and a same-origin check (CSRF protection).
- Strict Content Security Policy (no inline scripts), `X-Frame-Options: DENY`, HSTS, nosniff.
- Google and Apple sign-in use state and nonce checks (and PKCE for Google).
- Bank slips are checked by file signature (JPG, PNG, WebP, PDF only, 5 MB max), stored privately and served only to the customer and admins, inside a sandbox.
- Email verification is required before a customer can send a request. Password reset links last 1 hour and work once.
- An hourly scheduled job expires unpaid approvals and cleans up old sessions, tokens and rate-limit counters.

---

## Make changes

| What | Where |
|---|---|
| Prices, hours, bank details, alert email | Admin panel → Settings |
| Event types in the request form | `EVENT_TYPES` in `src/routes/bookings.js` |
| Contact details on the site | `VENUE` near the middle of `public/assets/site.js` |
| Page text, photos | `public/index.html`, `public/img/` |
| Email wording | `src/lib/email.js` |
| Time zone | `VENUE_TZ` in `wrangler.jsonc` |

After editing, commit to `main` and GitHub deploys it.

## Run it on your computer

```bash
npm install
cp .dev.vars.example .dev.vars     # fill in PEPPER and SETUP_TOKEN
npm run db:migrate:local
npm run dev                         # http://localhost:8787
```

There is also a no-setup preview (`npm run preview`) and an end-to-end test (`npm test`, Node 22.5+) that runs the real Worker code through sign-up, booking, approval, slip upload, confirmation, admin roles, lockouts, password reset and Google/Apple sign-in.

## Files

```
src/index.js            Worker entry: routing, security headers, hourly cleanup
src/routes/auth.js      Customer accounts, Google, Apple, verification, reset
src/routes/bookings.js  Availability, requests, slip upload
src/routes/admin.js     Admin panel API, admins, settings, audit log
src/lib/                Hashing, sessions, rate limits, email
public/                 Website, account page (/account), admin panel (/admin)
migrations/              Database tables and default settings (D1 migrations)
.github/workflows/      Test and deploy on every push to main
wrangler.jsonc          Cloudflare configuration
```
