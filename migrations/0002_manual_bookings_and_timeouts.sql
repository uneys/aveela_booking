-- Aveela Event Space: migration 0002
-- Adds manual bookings (requests taken by phone, WhatsApp, Instagram, walk-in…) and idle session timeouts.
--
-- On Cloudflare Pages: paste this whole file into Storage & databases → D1 → aveela → Console and run it ONCE.
-- On Workers with the GitHub workflow: applied automatically.

-- Where the request came from, and contact details for customers without a website account.
ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'website';
ALTER TABLE bookings ADD COLUMN customer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN customer_email TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;

-- Last activity time, for signing people out after a period without activity.
ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_idle_minutes', '30');
