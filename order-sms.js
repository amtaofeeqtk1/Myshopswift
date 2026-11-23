// MyShopSwift — customer order SMS notifications
//
// Sits next to the existing email notifications and follows the same rules:
//   * It is only ever called AFTER the order change it reports has been
//     saved, and it never throws — an SMS problem can never fail, delay or
//     roll back an order, payment or status update.
//   * Each (order, event) can be sent at most once. The row in
//     sms_notifications is "claimed" with an atomic INSERT ... ON CONFLICT DO
//     NOTHING, so a retried Stripe webhook, the card-return fallback and a
//     double-clicked admin dropdown can all report the same event safely.
//   * Email and SMS are independent: neither waits for the other.
//   * Logs contain the order reference, event and status only — never the
//     phone number or message text.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const smsLib = require("./sms");

const RETRYABLE_STATUSES = ["failed", "undelivered"];
// A row left on "sending" (server crashed between asking the provider and
// recording the answer) is retryable once it is clearly stale. The admin is
// warned in the UI that it may already have been sent.
const STALE_SENDING_MS = 10 * 60 * 1000;
function isStaleSending(row) {
  return row.status === "sending" && row.updated_at && Date.now() - new Date(row.updated_at).getTime() > STALE_SENDING_MS;
}

// Status-rank SQL, so a late "sent" callback can never overwrite "delivered".
const RANK_SQL = `CASE status
  WHEN 'sending' THEN 0 WHEN 'queued' THEN 1 WHEN 'sent' THEN 2
  WHEN 'delivered' THEN 3 WHEN 'undelivered' THEN 3 WHEN 'failed' THEN 3
  ELSE 9 END`;

function rowToSms(row) {
  const iso = v => (v instanceof Date ? v.toISOString() : v || null);
  return {
    id: row.id,
    orderId: row.order_id,
    event: row.event,
    status: row.status,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    attempts: Number(row.attempts) || 0,
    retryable: RETRYABLE_STATUSES.includes(row.status) || isStaleSending(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastAttemptAt: iso(row.last_attempt_at)
  };
}

module.exports = function createOrderSms({
  db,
  getOrderById,
  config = smsLib.loadConfig(),
  sendSms = smsLib.sendSms,
  logger = console
}) {

  // Creates the sms_notifications table if it doesn't exist yet, from the
  // same add-sms-notifications.sql file that can be run by hand. Best-effort:
  // if it fails, SMS attempts will fail and be logged, and orders carry on.
  async function ensureSchema() {
    try {
      const sql = fs.readFileSync(path.join(__dirname, "add-sms-notifications.sql"), "utf8");
      await db.query(sql);
    } catch (error) {
      logger.error("[sms] Could not ensure sms_notifications table:", smsLib.redact(error.message));
    }
  }

  function info() {
    return {
      configured: config.configured,
      deliveryReports: config.configured && !!config.statusCallbackUrl,
      problems: config.problems
    };
  }

  // Atomically records "this event is being handled". Returns the new row,
  // or null if the event was already recorded (a duplicate).
  async function claim(orderId, event, status, errorCode, errorMessage) {
    const result = await db.query(
      `INSERT INTO sms_notifications
         (id, order_id, event, dedupe_key, status, attempts, error_code, error_message, created_at, updated_at, last_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),$9)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [
        crypto.randomUUID(), orderId, event, `${orderId}:${event}`, status,
        status === "sending" ? 1 : 0, errorCode || null, errorMessage || null,
        status === "sending" ? new Date().toISOString() : null
      ]
    );
    return result.rows.length ? result.rows[0] : null;
  }

  // Sends one claimed message and records the outcome. Never throws.
  async function deliver(rowId, orderId, event, to, body) {
    const ref = smsLib.orderRef(orderId);
    const result = await sendSms({ to, body, config });
    try {
      if (result.ok) {
        await db.query(
          `UPDATE sms_notifications
              SET provider_message_id = $2, status = $3, error_code = NULL, error_message = NULL, updated_at = NOW()
            WHERE id = $1`,
          [rowId, result.providerMessageId, result.status]
        );
        logger.log(`[sms] ${event} for order ${ref}: ${result.status}`);
      } else {
        await db.query(
          `UPDATE sms_notifications
              SET status = 'failed', error_code = $2, error_message = $3, updated_at = NOW()
            WHERE id = $1`,
          [rowId, result.errorCode, result.errorMessage]
        );
        logger.error(`[sms] ${event} for order ${ref} failed (code ${result.errorCode})`);
      }
    } catch (error) {
      logger.error(`[sms] Could not record outcome of ${event} for order ${ref}:`, smsLib.redact(error.message));
    }
    return result;
  }

  // The one entry point server.js calls. Safe to call any number of times
  // for the same (order, event) and safe to call without awaiting.
  async function notify(order, event) {
    const ref = order && order.id ? smsLib.orderRef(order.id) : "(unknown)";
    try {
      if (!config.configured) return { sent: false, reason: "not_configured" };
      const body = order && order.id ? smsLib.buildMessage(event, order.id) : null;
      if (!body) return { sent: false, reason: "unknown_event" };

      const to = smsLib.normalisePhone(order.phone);
      if (!to) {
        const row = await claim(order.id, event, "skipped", "invalid_phone", "No usable UK mobile number on this order");
        if (row) logger.warn(`[sms] ${event} for order ${ref} skipped: no usable mobile number`);
        return { sent: false, reason: row ? "invalid_phone" : "duplicate" };
      }

      const row = await claim(order.id, event, "sending");
      if (!row) return { sent: false, reason: "duplicate" };

      const result = await deliver(row.id, order.id, event, to, body);
      return { sent: !!result.ok, reason: result.ok ? undefined : result.errorCode };
    } catch (error) {
      logger.error(`[sms] ${event} for order ${ref} could not be processed:`, smsLib.redact(error.message));
      return { sent: false, reason: "error" };
    }
  }

  // Provider delivery report. Only moves a message forward (queued -> sent ->
  // delivered/undelivered/failed), so out-of-order callbacks are harmless.
  async function handleStatusCallback({ MessageSid, MessageStatus, ErrorCode }) {
    const status = smsLib.mapProviderStatus(MessageStatus);
    if (!MessageSid || !status) return 0;
    const isProblem = status === "failed" || status === "undelivered";
    const result = await db.query(
      `UPDATE sms_notifications
          SET status = $2, error_code = $3, error_message = $4, updated_at = NOW()
        WHERE provider_message_id = $1 AND (${RANK_SQL}) < $5
        RETURNING id`,
      [
        MessageSid, status,
        isProblem ? String(ErrorCode || "").slice(0, 20) || null : null,
        isProblem ? `Carrier/provider reported a delivery problem${ErrorCode ? ` (code ${String(ErrorCode).slice(0, 20)})` : ""}` : null,
        smsLib.STATUS_RANK[status]
      ]
    );
    return result.rowCount != null ? result.rowCount : result.rows.length;
  }

  async function list({ limit = 2000 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 2000, 1), 5000);
    const result = await db.query(`SELECT * FROM sms_notifications ORDER BY created_at DESC LIMIT $1`, [n]);
    return result.rows.map(rowToSms);
  }

  // Admin "Retry". Only failed/undelivered messages can be retried, and the
  // claim is a single atomic UPDATE, so two clicks (or two admins) can never
  // both send. A message that was sent, is in flight, or was delivered is
  // never re-sent.
  async function retry(id) {
    if (!config.configured) return { status: 400, error: "SMS isn't configured on the server" };

    const found = await db.query(`SELECT * FROM sms_notifications WHERE id = $1 LIMIT 1`, [id]);
    if (!found.rows.length) return { status: 404, error: "Notification not found" };
    const row = found.rows[0];
    if (!RETRYABLE_STATUSES.includes(row.status) && !isStaleSending(row)) {
      return { status: 409, error: "Only failed or undelivered messages can be retried" };
    }

    const order = await getOrderById(row.order_id);
    if (!order) return { status: 404, error: "The order for this message no longer exists" };

    // Don't send a stale message: e.g. "dispatched" after the order has
    // already moved on to delivered or cancelled.
    if (Object.values(smsLib.STATUS_TO_EVENT).includes(row.event) && order.status !== row.event) {
      return { status: 409, error: "The order status has changed since this message — it is no longer relevant" };
    }

    const to = smsLib.normalisePhone(order.phone);
    if (!to) return { status: 400, error: "This order has no usable UK mobile number" };
    const body = smsLib.buildMessage(row.event, order.id);
    if (!body) return { status: 400, error: "Unknown message type" };

    const claimed = await db.query(
      `UPDATE sms_notifications
          SET status = 'sending', attempts = attempts + 1, provider_message_id = NULL,
              error_code = NULL, error_message = NULL, last_attempt_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND (status IN ('failed','undelivered')
                           OR (status = 'sending' AND updated_at < NOW() - INTERVAL '10 minutes'))
        RETURNING *`,
      [id]
    );
    if (!claimed.rows.length) return { status: 409, error: "This message is already being retried" };

    await deliver(id, order.id, row.event, to, body);
    const after = await db.query(`SELECT * FROM sms_notifications WHERE id = $1 LIMIT 1`, [id]);
    return { status: 200, notification: rowToSms(after.rows[0]) };
  }

  return { ensureSchema, info, notify, handleStatusCallback, list, retry, config };
};

module.exports.rowToSms = rowToSms;
