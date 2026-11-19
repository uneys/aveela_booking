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
| Gmail (email) | 500 recipients a day (Workspace: 2,000) | Needs an App Password. Or use Resend: 3,000 emails a month, needs your own domain |
| Google sign-in | Free | |
| Apple sign-in | **US$99 a year** | Apple Developer Program. Optional: the Apple button only appears once you add the keys |

Cloudflare's own email sending only reaches arbitrary customers on the paid Workers plan, which is why email goes through Gmail (or Resend).

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

## Hosting on Cloudflare Pages instead

If you connected the repository under **Workers & Pages → Pages → Connect to Git** (your address ends in `.pages.dev`), it works too. The `functions/` folder runs the booking code on Pages. Pages deploys every push by itself, and the GitHub workflow then only runs the tests.

1. **Build settings** (Pages project → Settings → Build): Framework preset *None*, Build command *empty*, Build output directory `public`. Root directory: empty if `functions/` is at the top of your repository, otherwise the folder that contains it.
2. **Create storage** if you haven't: Storage & databases → D1 → create `aveela`; Workers KV → create `aveela-slips`.
3. **Bindings** (Pages project → Settings → Bindings → Add):
   - *D1 database*: variable name `DB` → `aveela`
   - *KV namespace*: variable name `SLIPS` → `aveela-slips`
4. **Variables and Secrets** (Pages project → Settings → Variables and Secrets → Add), for *Production*:
   - `APP_URL` (Text): `https://aveela.pages.dev`, your exact address with no trailing slash
   - `MAIL_FROM` (Text): e.g. `Aveela Event Space <bookings@your-domain.com>`
   - `PEPPER` (**Secret**): at least 32 random characters. Never change or lose it
   - `SETUP_TOKEN` (**Secret**): a long random string
   - Later, as needed: `GMAIL_USER` + `GMAIL_APP_PASSWORD` (section 2), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and the `APPLE_…` secrets (all **Secret**)
5. **Create the tables**: Storage & databases → D1 → `aveela` → **Console**. Paste the whole of `migrations/0001_initial.sql` and run it, then do the same with `migrations/0002_manual_bookings_and_timeouts.sql`, `migrations/0003_customer_suspension.sql` and `migrations/0004_payment_method.sql`. Run each file once, in number order. When an update adds a new file, paste just that one.
6. **Redeploy**: bindings and variables only apply to new deployments. Go to Deployments → the latest one → ⋯ → **Retry deployment**.
7. Open `https://aveela.pages.dev/api/health`. When it shows `"ok":true`, go to `/admin` to create the master admin, then delete `SETUP_TOKEN`.

On Pages there are no scheduled jobs. Unpaid approvals still expire on time, because that's checked whenever bookings are read, and old sessions are tidied up during normal traffic.

---

## Updating a site that's already live

When an update adds a file to `migrations/`, the database needs it once:

- **Cloudflare Pages:** D1 → `aveela` → Console → paste the new file (e.g. `0002_manual_bookings_and_timeouts.sql`) → run. Do this before or right after uploading the new code. Until then, sign-in keeps working, but the parts that need the update show a message telling you to run it, and `/api/health` lists it.
- **Workers with the GitHub workflow:** applied automatically on the next push.

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
| No emails arrive | Admin → Settings → Email → **Send test email**. It shows the exact problem. *Gmail rejected the sign-in* means use an App Password and check `GMAIL_USER`. Also check the customer's spam folder, then use **Resend … email** on the booking. |
| *Gmail daily sending limit reached* | Free Gmail allows 500 recipients a day. It resets within 24 hours. |

Live error logs: Cloudflare → Workers & Pages → aveela → **Logs**.

---

## 2. Email (Gmail, or Resend)

Without this the site still works, but no emails go out. They're written to the logs instead, and `/api/health` will say so.

### Option A: send from a Gmail account (easiest)

1. Use the Gmail (or Google Workspace) account the venue should send from, e.g. `aveela.venue@gmail.com`.
2. Turn on **2-Step Verification**: [myaccount.google.com/security](https://myaccount.google.com/security).
3. Create an **App Password**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Name it "Aveela website" and copy the 16-letter password. You can't use your normal Gmail password.
4. Add these in Cloudflare (Pages or Worker → Settings → Variables and Secrets):
   - `GMAIL_USER` (Text): the Gmail address
   - `GMAIL_APP_PASSWORD` (**Secret**): the 16-letter app password (spaces are fine)
   - `MAIL_FROM` (Text, optional): sets the name customers see, e.g. `Aveela Event Space <aveela.venue@gmail.com>`
5. **Redeploy** (Pages: Deployments → latest → ⋯ → Retry deployment).
6. In the admin panel, open **Settings → Email**. It should say *Sending through Gmail*. Click **Send test email**.

A free Gmail account can send to 500 recipients a day (Workspace: 2,000). Emails come from the Gmail address, and customers' replies go to it. If you change the Google password, Google cancels app passwords, so make a new one and update the secret.

### Option B: Resend (needs your own domain)

1. Sign up at [resend.com](https://resend.com), add your domain and add the DNS records it shows you.
2. Create an API key and add it as the secret `RESEND_API_KEY`.
3. Set `MAIL_FROM`, e.g. `Aveela Event Space <bookings@aveela.mv>` (on the domain you verified), and redeploy.

If both are set, Gmail is used. Add the variable `EMAIL_PROVIDER` = `resend` to force Resend.

### Which emails are sent

Confirm your email, password reset, request received, approved with payment details, declined, new slip needed, booking confirmed and cancelled by venue. The venue's alert email also gets new requests and uploaded slips.

### Resending emails

- **Admin panel:** open any booking and click **Resend … email**. It resends the email that matches the booking's status (request received, payment details, confirmation, declined or cancellation) and tells you right away whether it was delivered to the mail server or what went wrong.
- **Customers:** on *My bookings*, **Email me this again** resends their latest email for a pending, approved or confirmed booking (up to 3 times per 15 minutes). The *Send the link again* button resends the email-confirmation link.
- Every admin resend and test email is recorded in the activity log.

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

## Manual bookings (phone, WhatsApp, Instagram, walk-in)

Admin panel → **New booking** records a request that didn't come through the website. It collects the same details as the website form:

- **Customer:** name, phone and/or email, and where the request came from (phone call, WhatsApp, Viber, Instagram, Facebook, email, walk-in, other)
- **Event:** event type, guests, date, start and end hour, and the customer's notes. The form shows that day's booked and requested hours as you pick times.
- **Status:** *Approved, waiting for payment* (holds the hours and starts the payment deadline), *Confirmed, already paid*, or *Pending, decide later*. Pending may overlap other requests; the other two can't overlap a held booking.
- **Amount:** filled in as hours × price per hour, and you can change it. You can also add a message to the customer.
- **Email the customer:** with an email address, the booking can send the matching email (request received, payment details or confirmation). Without one, no automatic emails go out, so contact them yourself.

**Paid without a slip (cash and so on):** when you confirm an approved booking that has no uploaded slip, choose **How did they pay?**: *Cash*, *Bank transfer* or *Other*. It's saved on the booking, shown in the lists and booking details, recorded in the activity log, and the confirmation email says *Payment received in cash* with a *Paid by* line. The customer's *My bookings* shows *Paid in cash*. Bookings with an uploaded slip are recorded as bank transfer automatically. A manual booking saved as *Confirmed, already paid* asks the same question (cash by default).

Manual bookings then work exactly like website bookings: they appear in the lists with "via WhatsApp" and so on, hold the hours on the public calendar, and can be approved, confirmed or cancelled. For any approved booking, staff can **attach a slip or receipt** themselves and press **Payment received, confirm**, e.g. for cash or a slip sent on WhatsApp.

If you enter the customer's email, the booking is linked to it. When that person later signs up on the website with the same email, they're emailed a link to set a password, and the booking appears on their *My bookings* page.

## Schedule (month view)

Admin panel → **Schedule** (third in the menu, after Requests and Customers) shows a month at a glance:

- **Each day** has a strip covering the opening hours, with every booking drawn in its color: green confirmed, blue checking payment, amber awaiting payment, striped requests, grey blocked. The first two bookings are listed by start time and event, and days are tinted darker the fuller they are, with the percentage of opening hours taken. Today is outlined, past days are faded, and Fridays and Saturdays are shaded as the weekend.
- **Month summary:** number of bookings, hours booked, share of opening hours held, confirmed income plus income still awaiting payment, requests waiting, and the busiest day.
- **Click a day** to open an hour-by-hour timeline with each booking as a block (overlapping requests side by side). Click a block to open the booking. From there, **New booking on this day** and **Block time** open those forms with the date filled in.
- Move between months with ‹ › or jump back with **This month**.

## Customers and suspending accounts

Admin panel → **Customers** lists everyone with an account, plus customers you added to manual bookings with an email. For each one it shows email, phone, how they sign in (email, Google, Apple, or not signed up yet), when they joined, last sign-in, number of bookings and status. Search by name, email or phone, or filter: *Suspended*, *Not confirmed* (email not confirmed yet) or *Added by staff*. Click a customer to see their details and every booking they've made. Bookings also have a **View customer** link.

**Suspend account** (any admin, with a reason only staff see):
- They're signed out at once, everywhere.
- They can't sign in with a password, Google or Apple, request bookings, change requests, or get a password-reset email. Signing up again with the same email doesn't work either.
- Tick **Also cancel their pending requests** to clear requests still waiting. Approved and confirmed bookings stay as they are, so cancel those yourself if needed.
- **Restore account** undoes it. Suspensions and restores are recorded in the activity log, with who did it.

## Gap between bookings

Settings → **Gap between bookings** keeps that many hours free before and after every approved, paid or blocked booking, for set-up and cleaning. With 1 hour, a booking from 2pm to 6pm makes 1pm–7pm unavailable, and the website calendar shows it that way. 0 (the default) allows back-to-back bookings.

Overlap checks and saving happen in one step, so even two staff approving clashing requests at the same moment can't both succeed.

## Sign-out after inactivity

- **Admin panel:** staff are signed out after **30 minutes** without activity (mouse, keyboard or touch). Two minutes before, a *Still there?* message counts down with **Stay signed in**. The master admin can change the time in **Settings** (5 to 480 minutes). Activity in any open tab counts. The panel's once-a-minute refresh doesn't, so a screen left open still times out. Admin sessions also end after 8 hours regardless.
- **Customers:** signed out after 14 days without visiting, and after 30 days regardless.
- Timeouts are enforced by the server too, not just the page.

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

- **Changing the time before approval:** in the admin panel, a pending request's date, hours and guests can be edited in its details. **Save new time without approving** saves it, optionally emailing the customer the suggested time. **Approve** uses the edited time straight away, and the approval email says it was adjusted. Customers can also **Change date or time** on *My bookings* while their request is still waiting. The venue gets an email, and the same rules apply (opening hours, minimum hours, no overlap with held bookings). The price follows the new hours unless staff set an amount. After approval, changes go through the venue.
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
- Signed out after 30 minutes without activity (adjustable), with a warning first. Sessions last at most 8 hours.
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
- Bank slips are shrunk in the browser before upload (photos resized to 1600 px and re-encoded to fit 500 KB, which also strips hidden GPS and camera data). The server only checks the result: real JPG, PNG, WebP or PDF by file signature, 500 KB max. Slips are stored privately in KV and served only to the customer and admins, inside a sandbox.
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
src/lib/                Hashing, sessions, rate limits, email (Gmail SMTP and Resend)
public/                 Website, account page (/account), admin panel (/admin)
functions/              Runs the same API on Cloudflare Pages
migrations/              Database tables and default settings (D1 migrations)
.github/workflows/      Test and deploy on every push to main
wrangler.jsonc          Cloudflare configuration
```
