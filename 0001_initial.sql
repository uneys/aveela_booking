-- Aveela Event Space: initial database schema (D1 migration 0001).
-- Applied automatically by the GitHub workflow, or by hand with:
--   npx wrangler d1 migrations apply aveela --remote

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,                       -- null for Google/Apple-only accounts
  google_sub      TEXT UNIQUE,
  apple_sub       TEXT UNIQUE,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  password_hash   TEXT NOT NULL,
  is_master       INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  must_change     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

-- Session tokens are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('user','admin')),
  subject_id  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  ip          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(kind, subject_id);

-- One-time tokens: email verification and password reset (stored hashed).
CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- Statuses:
--   pending        customer requested, waiting for the vendor
--   approved       vendor approved, waiting for payment + bank slip
--   slip_uploaded  customer uploaded a slip, waiting for the vendor to check it
--   confirmed      payment checked, confirmation emailed
--   rejected       vendor declined the request
--   cancelled      cancelled by the customer or the vendor
--   expired        approved but not paid before the deadline
--   blocked        time blocked by the vendor (phone booking, maintenance)
CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT NOT NULL UNIQUE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,
  date          TEXT NOT NULL,              -- YYYY-MM-DD, venue local time
  start_hour    INTEGER NOT NULL,           -- 0-23
  end_hour      INTEGER NOT NULL,           -- 1-24, exclusive
  guests        INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  amount        INTEGER NOT NULL DEFAULT 0, -- whole currency units
  vendor_note   TEXT NOT NULL DEFAULT '',
  pay_by        INTEGER,                    -- unix ms deadline for the slip
  slip_key      TEXT,
  slip_type     TEXT,
  slip_at       INTEGER,
  decided_by    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id  INTEGER,
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  ip        TEXT NOT NULL DEFAULT '',
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- Sliding-window counters for login and signup rate limits.
CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('hourly_rate', '2500'),
  ('currency', 'MVR'),
  ('open_hour', '8'),
  ('close_hour', '24'),
  ('min_hours', '2'),
  ('max_guests', '250'),
  ('pay_within_hours', '48'),
  ('bank_name', ''),
  ('account_name', ''),
  ('account_number', ''),
  ('payment_note', 'Please use your booking reference as the transfer remark.'),
  ('notify_email', '');
