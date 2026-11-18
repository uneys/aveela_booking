-- Aveela Event Space: migration 0004
-- Records how a booking was paid (bank transfer, cash, other) and when it was marked paid.
--
-- On Cloudflare Pages: paste this whole file into Storage & databases → D1 → aveela → Console and run it ONCE
-- (after 0001–0003). On Workers with the GitHub workflow: applied automatically.

ALTER TABLE bookings ADD COLUMN payment_method TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN paid_at INTEGER;
