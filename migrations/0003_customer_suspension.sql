-- Aveela Event Space: migration 0003
-- Adds account suspension for customers, and the last sign-in time shown in the admin customer list.
--
-- On Cloudflare Pages: paste this whole file into Storage & databases → D1 → aveela → Console and run it ONCE
-- (after 0001 and 0002). On Workers with the GitHub workflow: applied automatically.

ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN suspended_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
ALTER TABLE users ADD COLUMN suspended_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
