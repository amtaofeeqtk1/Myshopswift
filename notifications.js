// MyShopSwift — admin notifications
//
// Backs the admin dashboard's notification bell. Three responsibilities:
//   1. Persistent storage — the real "notifications" Postgres table
//      (verified schema via migrate-notifications.js: id, type, title,
//      message, order_id, customer_id, dedupe_key, read, created_at).
//   2. Idempotent creation, so the same real-world event (e.g. one order
//      being confirmed) can never produce more than one notification
//      record, no matter how many code paths report it (order creation,
//      Stripe webhook, manual payment confirmation, retries).
//   3. Real-time delivery to connected admin dashboards via Server-Sent
//      Events — no new dependency, and nothing else in this app needs
//      WebSockets, so SSE is the simpler fit.

const crypto = require("crypto");

module.exports = function (db) {

function rowToNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    orderId: row.order_id,
    customerId: row.customer_id,
    dedupeKey: row.dedupe_key,
    read: !!row.read,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

// ---------- Server-Sent Events ----------
// Each connected admin dashboard holds one open response stream here.
// Removed on disconnect so this can never leak memory from dead
// connections (see unsubscribe() and the req "close" handler in server.js).
const clients = new Set();

function subscribe(res) {
  clients.add(res);
}
function unsubscribe(res) {
  clients.delete(res);
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); }
    catch (e) { clients.delete(res); }
  }
}

// ---------- CRUD ----------
async function list({ unreadOnly = false } = {}) {
  const result = unreadOnly
    ? await db.query(`SELECT * FROM notifications WHERE read = false ORDER BY created_at DESC`)
    : await db.query(`SELECT * FROM notifications ORDER BY created_at DESC`);
  return result.rows.map(rowToNotification);
}
async function unreadCount() {
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE read = false`);
  return result.rows[0].count;
}
async function markRead(id) {
  const result = await db.query(
    `UPDATE notifications SET read = true WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows.length ? rowToNotification(result.rows[0]) : null;
}
async function markAllRead() {
  const result = await db.query(`UPDATE notifications SET read = true WHERE read = false`);
  return result.rowCount;
}
async function remove(id) {
  const result = await db.query(`DELETE FROM notifications WHERE id = $1`, [id]);
  return result.rowCount > 0;
}
async function clearAll() {
  await db.query(`DELETE FROM notifications`);
}

// The idempotency guarantee: `dedupeKey` (e.g. "new_order:<orderId>")
// means a given event can only ever exist once. Callers pass the same key
// every time they report the same event; only the first call actually
// creates a record (created: true) — later calls return the existing one
// untouched (created: false), so callers know whether to also fire the
// side effects (SSE broadcast, email) or skip them.
async function createIfNew({ type, title, message, orderId, customerId, dedupeKey }) {
  if (dedupeKey) {
    const existing = await db.query(
      `SELECT * FROM notifications WHERE dedupe_key = $1 LIMIT 1`,
      [dedupeKey]
    );
    if (existing.rows.length) {
      return { notification: rowToNotification(existing.rows[0]), created: false };
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    const result = await db.query(
      `INSERT INTO notifications (id, type, title, message, order_id, customer_id, dedupe_key, read, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)
       RETURNING *`,
      [id, type, title, message, orderId || null, customerId || null, dedupeKey || null, createdAt]
    );
    return { notification: rowToNotification(result.rows[0]), created: true };
  } catch (error) {
    // Two requests racing on the same dedupeKey (e.g. webhook + client-side
    // confirm firing near-simultaneously) can both pass the SELECT above
    // before either INSERT lands — the second INSERT then hits the unique
    // constraint. Treat that exactly like "already existed".
    if (dedupeKey && error.code === "23505") {
      const existing = await db.query(
        `SELECT * FROM notifications WHERE dedupe_key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (existing.rows.length) {
        return { notification: rowToNotification(existing.rows[0]), created: false };
      }
    }
    throw error;
  }
}

return {
  subscribe, unsubscribe, broadcast,
  list, unreadCount, markRead, markAllRead, remove, clearAll,
  createIfNew
};

};
