"use strict";

// In-memory stand-in for the sms_notifications table. It understands exactly
// the SQL order-sms.js issues. It proves application logic only: the real SQL
// (ON CONFLICT, the status-rank CASE) must be exercised against PostgreSQL.

const RANK = { sending: 0, queued: 1, sent: 2, delivered: 3, undelivered: 3, failed: 3 };

// Returns a query result if `sql` is an sms_notifications statement, else undefined.
function handleSmsQuery(rows, sql, params = []) {
  const q = sql.replace(/\s+/g, " ").trim();

  if (q.startsWith("INSERT INTO sms_notifications")) {
    const [id, order_id, event, dedupe_key, status, attempts, error_code, error_message, last_attempt_at] = params;
    if (rows.some(r => r.dedupe_key === dedupe_key)) return { rows: [], rowCount: 0 };
    const row = {
      id, order_id, event, dedupe_key, status, attempts, error_code, error_message,
      provider_message_id: null, created_at: new Date(), updated_at: new Date(), last_attempt_at
    };
    rows.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (q.startsWith("UPDATE sms_notifications SET provider_message_id = $2, status = $3")) {
    const row = rows.find(r => r.id === params[0]);
    Object.assign(row, { provider_message_id: params[1], status: params[2], error_code: null, error_message: null });
    return { rows: [], rowCount: 1 };
  }
  if (q.startsWith("UPDATE sms_notifications SET status = 'failed'")) {
    const row = rows.find(r => r.id === params[0]);
    Object.assign(row, { status: "failed", error_code: params[1], error_message: params[2] });
    return { rows: [], rowCount: 1 };
  }
  if (q.startsWith("UPDATE sms_notifications SET status = $2, error_code = $3")) {
    const [sid, status, code, message, newRank] = params;
    const hit = rows.filter(r => r.provider_message_id === sid && RANK[r.status] !== undefined && RANK[r.status] < newRank);
    hit.forEach(r => Object.assign(r, { status, error_code: code, error_message: message }));
    return { rows: hit.map(r => ({ id: r.id })), rowCount: hit.length };
  }
  if (q.startsWith("UPDATE sms_notifications SET status = 'sending', attempts = attempts + 1")) {
    const stale = r => r.status === "sending" && Date.now() - new Date(r.updated_at).getTime() > 10 * 60 * 1000;
    const row = rows.find(r => r.id === params[0] && (["failed", "undelivered"].includes(r.status) || stale(r)));
    if (!row) return { rows: [], rowCount: 0 };
    Object.assign(row, { status: "sending", attempts: row.attempts + 1, provider_message_id: null, error_code: null, error_message: null });
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (q.startsWith("SELECT * FROM sms_notifications WHERE id = $1")) {
    const row = rows.find(r => r.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (q.startsWith("SELECT * FROM sms_notifications ORDER BY created_at DESC")) {
    return { rows: rows.slice().reverse().slice(0, params[0]).map(r => ({ ...r })) };
  }
  return undefined;
}

module.exports = { handleSmsQuery };
