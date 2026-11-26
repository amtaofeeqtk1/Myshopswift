-- MyShopSwift admin OTP and saved delivery addresses. Apply before deploying.
CREATE TABLE IF NOT EXISTS admin_otp_challenges (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  challenge_hash TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  resends INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN NOT NULL DEFAULT false;
-- Existing sessions get otp_verified=false from the new column default and must reauthenticate.
CREATE TABLE IF NOT EXISTS customer_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  county TEXT,
  postcode TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_user ON customer_addresses(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_addresses_one_default ON customer_addresses(user_id) WHERE is_default = true;

