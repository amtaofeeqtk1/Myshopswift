-- Run this against your Neon/PostgreSQL database BEFORE deploying the new
-- server.js. All statements are idempotent (IF NOT EXISTS / safe to re-run).
-- Nothing here drops, truncates, or deletes existing data.
--
-- Adds secure single-admin authentication (email + bcrypt-hashed permanent
-- password, plus short-lived single-use temporary passwords for first-time
-- setup and forgot-password). No new environment variables are required —
-- this reuses the existing ADMIN_EMAIL, SMTP_*, and DATABASE_URL you
-- already have set.

-- ============================================================
-- 1. admin_auth — a single-row table (id is always 1) holding the one
--    authorized admin's credentials. password_hash starts NULL: the admin
--    has no permanent password until they complete first-time setup.
--    temp_hash/temp_expires_at/temp_used back the "Generate password" and
--    "Forgot password" flows — only a hash of the temporary password is
--    ever stored, same pattern as the existing password_resets table.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_auth (
  id INTEGER PRIMARY KEY DEFAULT 1,
  email TEXT NOT NULL,
  password_hash TEXT,
  temp_hash TEXT,
  temp_expires_at TIMESTAMPTZ,
  temp_used BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_auth_singleton CHECK (id = 1)
);

-- ============================================================
-- 2. admin_sessions — separate from the existing customer `sessions`
--    table on purpose: an admin session isn't tied to a row in `users`,
--    so it gets its own table rather than an awkward nullable FK on the
--    table customer auth already relies on.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
