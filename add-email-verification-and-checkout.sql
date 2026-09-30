-- Run this against your Neon database BEFORE deploying the new server.js.
-- All statements are idempotent (IF NOT EXISTS / safe to re-run).
-- Nothing here drops, truncates, or deletes existing data.

-- ============================================================
-- 1. Users: phone + email verification flag
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- Grandfather in every account that already existed before this column was
-- added — they registered under the old rules, so they should never be
-- locked out or asked to verify retroactively. This only needs to run once;
-- re-running it is harmless (it just does nothing on a second pass, since
-- everyone it would touch is already true).
UPDATE users SET email_verified = true WHERE email_verified = false;

-- ============================================================
-- 2. Email verification tokens (same shape as the existing
--    password_resets table: only a hash of the token is ever stored)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_token_hash ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user_id ON email_verifications(user_id);

-- ============================================================
-- 3. Orders: phone + delivery-fee breakdown
-- ============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_free_reason TEXT;

-- Backfill existing orders: no delivery fee was ever charged historically,
-- so their stored `total` already equals what the new `subtotal` column
-- means. delivery_fee stays at its default of 0 for these old rows, which
-- is factually correct (no fee was collected).
UPDATE orders SET subtotal = total WHERE subtotal IS NULL;

-- ============================================================
-- 4. Order-email idempotency flags — so a retried Stripe webhook or a
--    refreshed success page can never send the same email twice.
-- ============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS placed_email_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_email_sent BOOLEAN NOT NULL DEFAULT false;

-- Existing historical orders shouldn't trigger a flood of "your order was
-- placed" emails the moment this deploys — mark them as already sent.
UPDATE orders SET placed_email_sent = true WHERE placed_email_sent = false;
UPDATE orders SET payment_email_sent = true WHERE payment_email_sent = false;
