-- Customer SMS notification log.
-- Idempotent (IF NOT EXISTS) and additive: nothing here alters, drops or
-- deletes existing data. The server also runs this file once at startup
-- (see ensureSchema() in order-sms.js), so running it by hand beforehand is
-- optional but recommended.
--
-- One row per (order, event). The UNIQUE dedupe_key is what stops the same
-- SMS ever being sent twice, however many times an order event is processed
-- (Stripe webhook retries, the card-return fallback, double-clicks in the
-- admin dashboard, ...).
--
-- The customer's phone number is deliberately NOT copied into this table:
-- it is read from the order when needed.

CREATE TABLE IF NOT EXISTS sms_notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event TEXT NOT NULL,              -- order_placed | payment_confirmed | processing | shipped | delivered | cancelled
  dedupe_key TEXT NOT NULL,         -- "<order_id>:<event>"
  status TEXT NOT NULL,             -- sending | queued | sent | delivered | undelivered | failed | skipped
  provider_message_id TEXT,         -- provider's message id (e.g. Twilio SID), used to match delivery callbacks
  error_code TEXT,
  error_message TEXT,               -- redacted: never contains a phone number
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_notifications_dedupe ON sms_notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_sms_notifications_order_id ON sms_notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_sms_notifications_provider_id ON sms_notifications(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_sms_notifications_status ON sms_notifications(status);
