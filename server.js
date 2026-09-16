// MyShopSwift — backend
//
// Adds to the original catalogue API:
//   - customer accounts (register/login) via httpOnly session cookies
//   - order placement, with server-side price recalculation
//   - Cash on Delivery, plus optional card payment via Stripe Checkout
//   - admin endpoints to manage orders and view customers
//
// Storage is three flat JSON files in data/ — fine for a small shop,
// not a real database. See README.md before scaling this up.

require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const email = require("./email");
const { Pool } = require("pg");

const db = new Pool({
 connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// notifications.js, rewards.js, and flyers.js are all Postgres-backed (see
// each file), so all three are required after `db` exists instead of
// alongside the other requires above.
const notifications = require("./notifications")(db);
const rewards = require("./rewards")(db);
const flyers = require("./flyers")(db);

db.query("SELECT NOW()")
  .then(() => console.log("PostgreSQL database connected"))
  .catch(err => console.error("PostgreSQL connection failed:", err.message));


const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// The app sits behind Render's reverse proxy — without this, req.ip and
// req.secure would reflect the proxy, not the real client, which would
// break the per-IP admin rate limiting below.
app.set("trust proxy", 1);

const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

// products.json, users.json, orders.json, password-resets.json, and
// contact-messages.json are no longer read or written anywhere in this
// file — every one of them is migrated to Postgres. Their constants are
// deliberately removed rather than left dangling, so nothing here
// misleadingly implies JSON is still authoritative for any of them.
const CONTACT_INBOX_EMAIL = process.env.CONTACT_INBOX_EMAIL || process.env.SMTP_USER || "";

if (!stripe) {
  console.warn("NOTE: STRIPE_SECRET_KEY not set — card payments are disabled, Cash on Delivery still works.");
}
if (!ADMIN_EMAIL) {
  console.warn("NOTE: ADMIN_EMAIL not set — new-order emails will be skipped (dashboard/browser notifications still work).");
}

// ---------- Stripe Webhook (must come BEFORE express.json) ----------
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send("Webhook not configured");
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;

    if (orderId && session.payment_status === "paid") {
      try {
        const order = await getOrderById(orderId);

        if (order && order.status === "awaiting_payment") {
          order.status = "pending";

          // Deduct points if used
          if (order.pointsUsed > 0 && !order.pointsDeducted) {
            const account = await rewards.getOrCreateAccount(order.userId);
            if (account.pointsBalance >= order.pointsUsed) {
              const tx = await rewards.awardPoints({
                userId: order.userId,
                type: "payment",
                points: -order.pointsUsed,
                reason: `Used as payment for order #${order.id.slice(0, 8)}`,
                orderId: order.id,
                refId: `payment:${order.id}`
              });
              if (tx && !tx.error) order.pointsDeducted = true;
            } else {
              // No points_issue column exists on the real orders table —
              // this can't be persisted the way the old JSON version did.
              // Logged here for manual admin follow-up instead.
              console.warn(`[orders] Order ${order.id}: insufficient points balance at payment confirmation`);
            }
          }

          await updateOrderAfterPaymentConfirmation(order.id, {
            status: order.status,
            pointsDeducted: order.pointsDeducted
          });
          console.log(`Order ${orderId} confirmed via webhook`);
          notifyNewOrder(order);
          sendPaymentConfirmedEmailOnce(order);
        }
      } catch (error) {
        console.error("[webhook] Failed to process checkout.session.completed:", error.message);
      }
    }
  }

  res.json({ received: true });
});

// Normal JSON body parser (must come AFTER the webhook route)
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Uploaded brand-flyer images live in Postgres now (see flyers.js), not on
// local disk, so they survive redeploys and Render free-plan spin-downs.
// Served publicly here — the files themselves aren't sensitive, only
// uploading/deleting them is.
app.get("/uploads/flyers/:id", async (req, res) => {
  try {
    const image = await flyers.getImage(req.params.id);
    if (!image) return res.status(404).end();
    res.set("Content-Type", image.mimeType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(image.imageData);
  } catch (error) {
    console.error("[flyers] Failed to load flyer image:", error.message);
    res.status(500).end();
  }
});

const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// Creates a session row in PostgreSQL and returns the raw token (not a
// Promise — callers must `await` this, which every caller below does).
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE);

  await db.query(
    `INSERT INTO sessions (token, user_id, expires_at, created_at)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, expiresAt, now]
  );

  return token;
}

// ---------- auth middleware ----------
async function attachUser(req, res, next) {
  // Web keeps using the httpOnly cookie exactly as before. Native apps have
  // no cookie jar shared with a browser, so they send the same session
  // token as a Bearer header instead — checked only when no cookie is
  // present, so nothing about existing web behaviour changes.
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const token = req.cookies.session || bearerToken;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const result = await db.query(
      `SELECT
        u.id,
        u.name,
        u.email,
        u.password_hash,
        u.phone,
        u.email_verified,
        u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1
         AND s.expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    if (result.rows.length === 0) {
      req.user = null;
      return next();
    }

    req.user = rowToUser(result.rows[0]);

    next();

  } catch (error) {
    console.error("[auth] Failed to load session:", error.message);
    req.user = null;
    next();
  }
}


app.use(attachUser);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please log in first" });
  next();
}

// ---------- Admin auth ----------
// Single authorized admin account (info@myshopswift.co.uk), stored as one
// row in `admin_auth` (id is always 1 — see add-admin-auth.sql). The
// permanent password lives only as a bcrypt hash in that row; temporary
// setup/reset credentials live only as a SHA-256 hash with an expiry and a
// single-use flag on the same row. Admin sessions are separate rows in
// `admin_sessions`, referenced by an httpOnly cookie — the old shared
// ADMIN_KEY header is gone; every admin route below now goes through
// requireAdmin, which is the server-side authority these checks can't be
// bypassed by anything sent from the client.

const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const ADMIN_TEMP_CRED_TTL_MS = 20 * 60 * 1000; // 20 minutes — within the requested 15-30 min window
const ADMIN_TEMP_CRED_BYTES = 12; // -> 24 hex chars, plenty of entropy for a one-time password

function hashAdminToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Lazily creates the singleton admin_auth row the first time it's needed
// (fresh deploys / first request after this migration), rather than
// requiring a separate seed script. No password is set on creation — the
// admin must go through "Generate password" first-time setup.
async function getAdminAuth() {
  const existing = await db.query(`SELECT * FROM admin_auth WHERE id = 1 LIMIT 1`);
  if (existing.rows.length) return existing.rows[0];

  await db.query(
    `INSERT INTO admin_auth (id, email, password_hash, temp_hash, temp_expires_at, temp_used, updated_at)
     VALUES (1, $1, NULL, NULL, NULL, true, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_EMAIL]
  );
  const created = await db.query(`SELECT * FROM admin_auth WHERE id = 1 LIMIT 1`);
  return created.rows[0];
}

async function createAdminSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_MAX_AGE_MS);
  await db.query(
    `INSERT INTO admin_sessions (token, expires_at, created_at) VALUES ($1, $2, $3)`,
    [token, expiresAt, now]
  );
  return token;
}

function setAdminSessionCookie(res, token) {
  res.cookie("admin_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    maxAge: ADMIN_SESSION_MAX_AGE_MS
  });
}

// Server-side authority for every protected admin route (and the SSE
// stream below — EventSource sends cookies automatically for same-origin
// requests, so the stream no longer needs a key in the URL). Never trusts
// anything the client claims about its own role.
async function requireAdmin(req, res, next) {
  const token = req.cookies.admin_session;
  if (!token) return res.status(401).json({ error: "Admin login required" });
  try {
    const result = await db.query(
      `SELECT token FROM admin_sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1`,
      [token]
    );
    if (!result.rows.length) return res.status(401).json({ error: "Admin login required" });
    next();
  } catch (error) {
    console.error("[admin-auth] Failed to verify admin session:", error.message);
    res.status(500).json({ error: "Could not verify admin session" });
  }
}

// ---------- Admin rate limiting ----------
// Simple in-memory sliding-window limiter — no new dependency needed, and
// this single-instance app doesn't need attempts to survive a restart.
// Applied to every admin auth endpoint (login, first-time setup request,
// forgot-password, and completing a setup/reset) to slow brute-forcing.
const adminRateLimitHits = new Map(); // ip -> { count, windowStart }
const ADMIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_RATE_LIMIT_MAX = 10;

function adminRateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const entry = adminRateLimitHits.get(ip);
  if (!entry || now - entry.windowStart > ADMIN_RATE_LIMIT_WINDOW_MS) {
    adminRateLimitHits.set(ip, { count: 1, windowStart: now });
    return next();
  }
  entry.count++;
  if (entry.count > ADMIN_RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many attempts — please try again later" });
  }
  next();
}

// Periodic sweep so the map doesn't grow forever on a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of adminRateLimitHits) {
    if (now - entry.windowStart > ADMIN_RATE_LIMIT_WINDOW_MS) adminRateLimitHits.delete(ip);
  }
}, ADMIN_RATE_LIMIT_WINDOW_MS).unref();

const PAYMENT_METHOD_LABELS = { cod: "Cash on Delivery", card: "Online Payment (Card)", points: "Points Payment" };
const fmtGBP = n => "£" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Single entry point for "an order just became real" — called from every
// place an order can be confirmed (COD/points-only at creation, card
// payment via the Stripe webhook, and card payment via the client-side
// confirm endpoint as a fallback if the webhook isn't configured). Those
// three paths can race or overlap for the same order; createIfNew()'s
// dedupeKey ensures only the first one to arrive actually creates a
// notification, broadcasts it, or sends an email — the rest are no-ops.
async function notifyNewOrder(order) {
  const firstName = (order.customerName || "A customer").split(" ")[0];
  const shortId = order.id.slice(0, 8);
  const paymentLabel = PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod;

  let notification, created;
  try {
    ({ notification, created } = await notifications.createIfNew({
      type: "new_order",
      title: `New Order — ${firstName} placed order #${shortId}`,
      message: `Total: ${fmtGBP(order.total)} • Payment: ${paymentLabel} • Status: ${order.status}`,
      orderId: order.id,
      customerId: order.userId,
      dedupeKey: `new_order:${order.id}`
    }));
  } catch (error) {
    // The order itself is already saved by the time this runs — a
    // notification failure must never be treated as an order failure.
    console.error("[notifications] Failed to record new-order notification:", error.message);
    return;
  }

  if (!created) return; // already notified for this order — nothing more to do

  notifications.broadcast("new-order", {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    orderId: order.id,
    createdAt: notification.createdAt,
    unreadCount: await notifications.unreadCount().catch(() => 0)
  });

  if (ADMIN_EMAIL) {
    // Fire-and-forget: email latency (or an SMTP outage) must never delay
    // or fail the customer's order — the order is already saved by the
    // time this function runs. email.sendMail() itself never throws (see
    // email.js), so this is a courtesy catch, not the safety net.
    email.sendMail({
      to: ADMIN_EMAIL,
      subject: `New MyShopSwift Order #${shortId}`,
      text: `New order received!\n\nCustomer: ${order.customerName}\nOrder ID: ${shortId}\nTotal: ${fmtGBP(order.total)}\nPayment method: ${paymentLabel}\nOrder status: ${order.status}\n\nView it in the admin dashboard: ${PUBLIC_URL}/admin.html`,
      html: `
        <p><strong>New order received!</strong></p>
        <p>
          Customer: ${order.customerName}<br>
          Order ID: ${shortId}<br>
          Total: ${fmtGBP(order.total)}<br>
          Payment method: ${paymentLabel}<br>
          Order status: ${order.status}
        </p>
        <p><a href="${PUBLIC_URL}/admin.html">View order in admin dashboard</a></p>
      `
    }).catch(e => console.error("[notifications] admin order email failed:", e.message));
  }
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// ---------- user lookups (Postgres — the "users" table is the source of
// truth since registration/login write there; users.json is not kept in
// sync and must not be read for anything post-migration) ----------
function rowToUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    phone: row.phone || "",
    emailVerified: !!row.email_verified,
    createdAt: row.created_at
  };
}

async function getAllUsers() {
  const result = await db.query(
    `SELECT id, name, email, password_hash, phone, email_verified, created_at FROM users`
  );
  return result.rows.map(rowToUser);
}

async function getUserById(id) {
  const result = await db.query(
    `SELECT id, name, email, password_hash, phone, email_verified, created_at FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

async function getUserByEmail(email) {
  const result = await db.query(
    `SELECT id, name, email, password_hash, phone, email_verified, created_at FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

// Updates a user's saved phone number — called after an order is placed so
// future checkouts can prefill it. Never overwrites with an empty value.
async function saveUserPhoneIfMissing(userId, phone) {
  if (!phone) return;
  await db.query(
    `UPDATE users SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = '')`,
    [phone, userId]
  );
}

// ---------- order storage (Postgres — matches the verified "orders" table
// schema: items/address are jsonb columns, so pg hands them back already
// parsed; numeric columns come back as strings from pg and are normalized
// to JS numbers here so the rest of the app can keep doing plain arithmetic
// on them exactly as it did with the JSON file) ----------
function rowToOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    phone: row.phone || "",
    items: row.items,
    subtotal: row.subtotal !== null && row.subtotal !== undefined ? Number(row.subtotal) : Number(row.total),
    deliveryFee: row.delivery_fee !== null && row.delivery_fee !== undefined ? Number(row.delivery_fee) : 0,
    deliveryFreeReason: row.delivery_free_reason || null,
    total: Number(row.total),
    pointsUsed: row.points_used !== null ? Number(row.points_used) : 0,
    pointsValue: row.points_value !== null ? Number(row.points_value) : 0,
    amountDue: row.amount_due !== null ? Number(row.amount_due) : 0,
    pointsDeducted: !!row.points_deducted,
    paymentMethod: row.payment_method,
    address: row.address,
    orderNote: row.order_note || "",
    status: row.status,
    placedEmailSent: !!row.placed_email_sent,
    paymentEmailSent: !!row.payment_email_sent,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function insertOrder(order) {
  await db.query(
    `INSERT INTO orders (
      id, user_id, customer_name, customer_email, phone, items, subtotal,
      delivery_fee, delivery_free_reason, total,
      points_used, points_value, amount_due, points_deducted,
      payment_method, address, order_note, status, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      order.id, order.userId, order.customerName, order.customerEmail, order.phone || "",
      JSON.stringify(order.items), order.subtotal, order.deliveryFee, order.deliveryFreeReason,
      order.total, order.pointsUsed, order.pointsValue,
      order.amountDue, order.pointsDeducted, order.paymentMethod,
      JSON.stringify(order.address), order.orderNote, order.status, order.createdAt
    ]
  );
}

// Atomically "claims" the right to send a one-off order email — the UPDATE
// only succeeds (and returns a row) the first time, so concurrent callers
// (the Stripe webhook and the client-side confirm fallback can both fire
// for the same payment) never send the same email twice.
const EMAIL_CLAIM_COLUMNS = new Set(["placed_email_sent", "payment_email_sent"]);
async function claimOrderEmail(orderId, column) {
  if (!EMAIL_CLAIM_COLUMNS.has(column)) throw new Error(`Unknown email-claim column: ${column}`);
  const result = await db.query(
    `UPDATE orders SET ${column} = true WHERE id = $1 AND ${column} = false RETURNING id`,
    [orderId]
  );
  return result.rows.length > 0;
}

// Fire-and-forget: an email failure must never affect the order itself,
// which is always already saved by the time these run.
async function sendOrderPlacedEmailOnce(order) {
  try {
    if (!(await claimOrderEmail(order.id, "placed_email_sent"))) return;
    const result = await email.sendOrderPlacedEmail(order);
    if (!result.delivered && result.error) {
      console.error(`[email] order-placed email failed for order ${order.id}:`, result.error);
    }
  } catch (error) {
    console.error(`[email] order-placed email failed for order ${order.id}:`, error.message);
  }
}

async function sendPaymentConfirmedEmailOnce(order) {
  try {
    if (!(await claimOrderEmail(order.id, "payment_email_sent"))) return;
    const result = await email.sendPaymentConfirmedEmail(order);
    if (!result.delivered && result.error) {
      console.error(`[email] payment-confirmed email failed for order ${order.id}:`, result.error);
    }
  } catch (error) {
    console.error(`[email] payment-confirmed email failed for order ${order.id}:`, error.message);
  }
}

async function sendOrderStatusEmail(order) {
  try {
    const result = await email.sendOrderStatusEmail(order);
    if (!result.delivered && result.error) {
      console.error(`[email] order-status email failed for order ${order.id}:`, result.error);
    }
  } catch (error) {
    console.error(`[email] order-status email failed for order ${order.id}:`, error.message);
  }
}

async function getOrderById(id) {
  const result = await db.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [id]);
  return result.rows.length ? rowToOrder(result.rows[0]) : null;
}

async function getOrdersByUser(userId) {
  const result = await db.query(`SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map(rowToOrder);
}

async function getAllOrders() {
  const result = await db.query(`SELECT * FROM orders ORDER BY created_at DESC`);
  return result.rows.map(rowToOrder);
}

// Used after order creation to persist points deduction that happened in
// the same request (COD/points orders confirm immediately).
async function markOrderPointsDeducted(id) {
  await db.query(`UPDATE orders SET points_deducted = true WHERE id = $1`, [id]);
}

// Used by the Stripe webhook and the client-side confirm fallback — both
// possibly racing for the same order, so this just re-applies the same
// final values each time (safe to call more than once).
async function updateOrderAfterPaymentConfirmation(id, { status, pointsDeducted }) {
  await db.query(
    `UPDATE orders SET status = $1, points_deducted = $2 WHERE id = $3`,
    [status, pointsDeducted, id]
  );
}

async function setOrderStatus(id, status) {
  await db.query(`UPDATE orders SET status = $1 WHERE id = $2`, [status, id]);
}

// ---------- catalogue storage (Postgres — matches the verified
// migrate-products.js schema: categories.id/products.id are the primary
// keys, brands is jsonb, price/old_price are numeric) ----------
function rowToCategory(row) {
  return { id: row.id, name: row.name, icon: row.icon || "", image: row.image || "" };
}
function rowToProduct(row) {
  const out = {
    id: row.id,
    name: row.name,
    cat: row.category,
    price: Number(row.price),
    icon: row.icon || "",
    tag: row.tag || "",
    image: row.image || "",
    description: row.description || "",
    brands: Array.isArray(row.brands) ? row.brands : []
  };
  if (row.old_price !== null && row.old_price !== undefined) out.old = Number(row.old_price);
  return out;
}

async function getCatalogue() {
  const [catResult, prodResult] = await Promise.all([
    db.query(`SELECT * FROM categories ORDER BY name`),
    db.query(`SELECT * FROM products ORDER BY id`)
  ]);
  return {
    categories: catResult.rows.map(rowToCategory),
    products: prodResult.rows.map(rowToProduct)
  };
}

async function getProducts() {
  const result = await db.query(`SELECT * FROM products`);
  return result.rows.map(rowToProduct);
}

// The admin catalogue editor saves the whole categories+products payload
// in one go, same as the old JSON version did by overwriting the whole
// file — so a full save here means "the submitted set is now the complete
// set": anything not included gets deleted, everything included is upserted.
// Wrapped in a transaction so a save can never leave the catalogue half
// written if it fails partway through.
async function replaceCatalogue(data) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const categoryIds = data.categories.map(c => c.id);
    const productIds = data.products.map(p => p.id);

    if (categoryIds.length) {
      await client.query(`DELETE FROM categories WHERE id != ALL($1::text[])`, [categoryIds]);
    } else {
      await client.query(`DELETE FROM categories`);
    }
    if (productIds.length) {
      await client.query(`DELETE FROM products WHERE id != ALL($1::int[])`, [productIds]);
    } else {
      await client.query(`DELETE FROM products`);
    }

    for (const c of data.categories) {
      await client.query(
        `INSERT INTO categories (id, name, icon, image) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, image = EXCLUDED.image`,
        [c.id, c.name || "", c.icon || "", c.image || ""]
      );
    }
    for (const p of data.products) {
      await client.query(
        `INSERT INTO products (id, name, category, price, old_price, icon, tag, image, description, brands)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price,
           old_price = EXCLUDED.old_price, icon = EXCLUDED.icon, tag = EXCLUDED.tag,
           image = EXCLUDED.image, description = EXCLUDED.description, brands = EXCLUDED.brands`,
        [
          p.id, p.name || "", p.cat || "", p.price ?? 0, p.old ?? null,
          p.icon || "", p.tag || "", p.image || "", p.description || "",
          JSON.stringify(p.brands || [])
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


// ==================== CATALOGUE ====================

app.get("/api/products", async (req, res) => {
  try { res.json(await getCatalogue()); }
  catch (e) { console.error("[catalogue] Failed to load:", e.message); res.status(500).json({ error: "Could not read catalogue" }); }
});

function validateCatalogue(data) {
  if (!data || typeof data !== "object") return "Payload must be an object";
  if (!Array.isArray(data.categories)) return "Missing categories array";
  if (!Array.isArray(data.products)) return "Missing products array";
  for (const c of data.categories) if (!c.id || !c.name) return "Every category needs an id and a name";
  for (const p of data.products) {
    if (!p.id || !p.name || !p.cat) return "Every product needs an id, name, and category";
    if (typeof p.price !== "number" || p.price < 0) return `Invalid price on "${p.name}"`;
  }
  return null;
}

app.put("/api/products", requireAdmin, async (req, res) => {
  const err = validateCatalogue(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    await replaceCatalogue(req.body);
    res.json({ ok: true, categories: req.body.categories.length, products: req.body.products.length });
  } catch (e) { console.error("[catalogue] Failed to save:", e.message); res.status(500).json({ error: "Could not save catalogue" }); }
});

app.post("/api/admin/verify", requireAdmin, (req, res) => res.json({ ok: true }));

// ---------- Admin authentication ----------
// A generic response used by every one of these endpoints whenever the
// submitted email doesn't match ADMIN_EMAIL, or a lookup/DB error occurs —
// so the response is never a way to probe whether info@myshopswift.co.uk
// is "the" admin email, or the current internal setup/reset state.
const ADMIN_GENERIC_AUTH_ERROR = "Incorrect email or password";
const ADMIN_GENERIC_REQUEST_MESSAGE = "If this is the authorized admin account, a temporary password has been sent to it.";

function isAuthorizedAdminEmail(email) {
  return !!ADMIN_EMAIL && typeof email === "string" && email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

app.post("/api/admin/login", adminRateLimit, async (req, res) => {
  const { email: rawEmail, password } = req.body || {};
  if (!rawEmail || !password) {
    return res.status(400).json({ error: ADMIN_GENERIC_AUTH_ERROR });
  }
  if (!isAuthorizedAdminEmail(rawEmail)) {
    return res.status(401).json({ error: ADMIN_GENERIC_AUTH_ERROR });
  }

  try {
    const admin = await getAdminAuth();
    if (!admin.password_hash) {
      // No permanent password set yet — same generic error rather than a
      // distinct "no password set" message, so this endpoint can't be used
      // to probe setup state. The admin's own "Generate password" link on
      // the login screen is how first-time setup is actually discovered.
      return res.status(401).json({ error: ADMIN_GENERIC_AUTH_ERROR });
    }

    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: ADMIN_GENERIC_AUTH_ERROR });
    }

    const token = await createAdminSession();
    setAdminSessionCookie(res, token);
    res.json({ ok: true });
  } catch (error) {
    console.error("[admin-auth] Login failed:", error.message);
    res.status(500).json({ error: "Could not log in — please try again" });
  }
});

app.post("/api/admin/logout", async (req, res) => {
  const token = req.cookies.admin_session;
  if (token) {
    try {
      await db.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
    } catch (error) {
      console.error("[admin-auth] Failed to delete admin session on logout:", error.message);
    }
  }
  res.clearCookie("admin_session");
  res.json({ ok: true });
});

// Issues a fresh single-use, short-lived temporary password and emails it
// to ADMIN_EMAIL. Shared by both "first-time setup" and "forgot password" —
// the only difference between those two entry points is which button the
// admin clicked; the credential lifecycle is identical, and both funnel
// into the same /api/admin/complete-setup below.
async function issueAdminTempCredential() {
  const tempPassword = crypto.randomBytes(ADMIN_TEMP_CRED_BYTES).toString("hex");
  const tempHash = hashAdminToken(tempPassword);
  const expiresAt = new Date(Date.now() + ADMIN_TEMP_CRED_TTL_MS);

  await db.query(
    `UPDATE admin_auth
     SET temp_hash = $1, temp_expires_at = $2, temp_used = false, updated_at = NOW()
     WHERE id = 1`,
    [tempHash, expiresAt]
  );

  await email.sendMail({
    to: ADMIN_EMAIL,
    subject: "Your MyShopSwift admin temporary password",
    text: `Temporary admin password: ${tempPassword}\n\nThis expires in 20 minutes and can only be used once, to set a new permanent password. If you didn't request this, you can ignore this email — your existing password (if any) still works.\n\n— MyShopSwift`,
    html: `
      <p>Temporary admin password:</p>
      <p style="font-family:monospace;font-size:18px;background:#EBF0F8;padding:10px 14px;display:inline-block;">${tempPassword}</p>
      <p style="font-size:13px;color:#666;">This expires in 20 minutes and can only be used once, to set a new permanent password. If you didn't request this, you can ignore this email — your existing password (if any) still works.</p>
      <p>— MyShopSwift</p>
    `
  });
}

// First-time setup: only issues a credential when no permanent password
// exists yet. Always responds with the same generic message either way.
app.post("/api/admin/generate-password", adminRateLimit, async (req, res) => {
  const { email: rawEmail } = req.body || {};

  if (isAuthorizedAdminEmail(rawEmail)) {
    try {
      const admin = await getAdminAuth();
      if (!admin.password_hash) {
        await issueAdminTempCredential();
      }
    } catch (error) {
      console.error("[admin-auth] generate-password failed:", error.message);
      // Fall through to the same generic response below.
    }
  }

  res.json({ message: ADMIN_GENERIC_REQUEST_MESSAGE });
});

// Forgot password: only issues a credential when a permanent password
// already exists (first-time setup uses generate-password above instead).
// Always responds with the same generic message either way.
app.post("/api/admin/forgot-password", adminRateLimit, async (req, res) => {
  const { email: rawEmail } = req.body || {};

  if (isAuthorizedAdminEmail(rawEmail)) {
    try {
      const admin = await getAdminAuth();
      if (admin.password_hash) {
        await issueAdminTempCredential();
      }
    } catch (error) {
      console.error("[admin-auth] forgot-password failed:", error.message);
      // Fall through to the same generic response below.
    }
  }

  res.json({ message: ADMIN_GENERIC_REQUEST_MESSAGE });
});

// Completes either flow above: verifies the temporary password against the
// stored hash (unexpired, unused), then sets the new permanent password.
// Never auto-logs the admin in — they log in normally afterward with the
// password they just chose.
app.post("/api/admin/complete-setup", adminRateLimit, async (req, res) => {
  const { email: rawEmail, tempPassword, password, confirmPassword } = req.body || {};

  if (!isAuthorizedAdminEmail(rawEmail) || !tempPassword) {
    return res.status(400).json({ error: "This temporary password is invalid or has expired" });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: "Passwords don't match" });
  }

  try {
    const admin = await getAdminAuth();
    const tempHash = hashAdminToken(tempPassword);

    if (
      !admin.temp_hash ||
      admin.temp_used ||
      admin.temp_hash !== tempHash ||
      !admin.temp_expires_at ||
      new Date(admin.temp_expires_at).getTime() < Date.now()
    ) {
      return res.status(400).json({ error: "This temporary password is invalid or has expired" });
    }

    const newPasswordHash = await bcrypt.hash(password, 10);
    await db.query(
      `UPDATE admin_auth
       SET password_hash = $1, temp_used = true, updated_at = NOW()
       WHERE id = 1`,
      [newPasswordHash]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("[admin-auth] complete-setup failed:", error.message);
    res.status(500).json({ error: "Could not set your password — please try again" });
  }
});

// ==================== ACCOUNTS ====================

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, referralCode } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({
      error: "Name, email, and password are required"
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      error: "Password must be at least 8 characters"
    });
  }

  try {
    const existing = await db.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "An account with that email already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const result = await db.query(
      `INSERT INTO users (id, name, email, password_hash, email_verified, created_at)
       VALUES ($1, $2, $3, $4, false, $5)
       RETURNING id, name, email, password_hash, phone, email_verified, created_at`,
      [id, name, email, passwordHash, createdAt]
    );

    const user = rowToUser(result.rows[0]);

    try {
      await rewards.awardSignupBonus(
        user.id,
        typeof referralCode === "string" ? referralCode : ""
      );
    } catch (e) {
      console.error("[rewards] signup bonus failed:", e.message);
    }

    // Best-effort: a verification-email failure must never block account
    // creation — the customer can always use "resend verification" later.
    sendVerificationTokenToUser(user).catch(e =>
      console.error("[auth] Failed to send verification email:", e.message)
    );

    const token = await createSession(user.id);

    res.cookie("session", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.status(201).json({
      user: publicUser(user),
      // Native apps have no shared browser cookie jar, so the token is also
      // returned here for them to store in secure storage and send back as
      // an Authorization header (see attachUser below). Web keeps using the
      // httpOnly cookie above exactly as before — nothing changes for it.
      token
    });

  } catch (error) {
    console.error("[auth] Registration failed:", error.message);
    res.status(500).json({
      error: "Could not create account"
    });
  }
});


app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      error: "Email and password are required"
    });
  }

  try {
    const result = await db.query(
      `SELECT id, name, email, password_hash, phone, email_verified, created_at
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Incorrect email or password"
      });
    }

    const row = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      row.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: "Incorrect email or password"
      });
    }

    const user = rowToUser(row);

    const token = await createSession(user.id);

    res.cookie("session", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({
      user: publicUser(user),
      token
    });

  } catch (error) {
    console.error("[auth] Login failed:", error.message);
    res.status(500).json({
      error: "Could not log in"
    });
  }
});

app.get("/api/auth/me", (req, res) => res.json({ user: publicUser(req.user) }));

app.post("/api/auth/logout", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const token = req.cookies.session || bearerToken;
  if (token) {
    try {
      await db.query(`DELETE FROM sessions WHERE token = $1`, [token]);
    } catch (error) {
      console.error("[auth] Failed to delete session on logout:", error.message);
      // Still clear the cookie below even if the DB delete failed — the
      // browser should never keep sending a token the user asked to drop.
    }
  }
  res.clearCookie("session");
  res.json({ ok: true });
});

// ---------- Forgot / reset password ----------
// Reset tokens: a random 32-byte token is put in the emailed link; only its
// SHA-256 hash is ever stored (fast + fine here, since the token itself is
// high-entropy and single-use — no need for bcrypt's slow hashing on it,
// that's reserved for the actual account password below).
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email: rawEmail } = req.body || {};
  const email_ = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const genericMessage = "If an account exists for this email, a password reset link has been sent.";

  // Always the same response whether or not the account exists — this is
  // what prevents the endpoint being used to enumerate registered emails.
  if (!email_) return res.json({ message: genericMessage });

  let user;
  try {
    user = await getUserByEmail(email_);
  } catch (error) {
    console.error("[auth] forgot-password lookup failed:", error.message);
    // Same generic response even on a DB error — never leak whether the
    // account exists, and never let a transient DB hiccup crash the process.
    return res.json({ message: genericMessage });
  }
  if (!user) return res.json({ message: genericMessage });

  // Invalidate any earlier unused tokens for this user, so only the most
  // recent reset link is ever valid — a true single-use link per request.
  const token = crypto.randomBytes(32).toString("hex");
  try {
    await db.query(`UPDATE password_resets SET used = true WHERE user_id = $1 AND used = false`, [user.id]);
    await db.query(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used, created_at)
       VALUES ($1,$2,$3,$4,false,$5)`,
      [
        crypto.randomUUID(),
        user.id,
        hashResetToken(token),
        new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
        new Date().toISOString()
      ]
    );
  } catch (error) {
    console.error("[auth] Failed to store password reset token:", error.message);
    // Same generic response even on a DB error — never leak whether the
    // account exists, and never let a transient DB hiccup crash the process.
    return res.json({ message: genericMessage });
  }

  const resetUrl = `${PUBLIC_URL}/reset-password.html?token=${token}`;
  const result = await email.sendPasswordResetEmail(user.email, user.name, resetUrl).catch(() => ({ delivered: false }));

  const response = { message: genericMessage };
  // Dev-only convenience, per spec: if email isn't actually configured,
  // hand back the link directly so the flow can still be tested without an
  // inbox. Never happens once SMTP_* is set, and never leaks whether the
  // account existed (this branch already returned early above if it didn't).
  if (!email.isConfigured) response.devResetUrl = resetUrl;

  res.json(response);
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: "Passwords don't match" });
  }

  let record;
  try {
    const tokenHash = hashResetToken(token);
    const result = await db.query(
      `SELECT * FROM password_resets WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    record = result.rows.length ? {
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      used: result.rows[0].used,
      expiresAt: result.rows[0].expires_at instanceof Date
        ? result.rows[0].expires_at.toISOString()
        : result.rows[0].expires_at
    } : null;
  } catch (error) {
    console.error("[auth] Failed to look up reset token:", error.message);
    return res.status(500).json({ error: "Could not reset your password — please try again" });
  }

  if (!record || record.used || new Date(record.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  try {
    const user = await getUserById(record.userId);
    if (!user) {
      return res.status(400).json({ error: "This reset link is invalid or has expired" });
    }

    const newPasswordHash = await bcrypt.hash(password, 10);
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newPasswordHash, user.id]);

    // Single-use: mark this token (and any other still-unused ones for the
    // same user) used immediately so it can never be replayed.
    await db.query(`UPDATE password_resets SET used = true WHERE user_id = $1`, [user.id]);

    // Existing sessions are intentionally left alone — this app doesn't
    // currently track sessions per-device in a way that would let us tell
    // "this customer's other browser" from "an attacker's session", so
    // force-logging-out everywhere isn't clearly safer, just more disruptive.
    res.json({ ok: true });
  } catch (error) {
    console.error("[auth] reset-password failed:", error.message);
    res.status(500).json({ error: "Could not reset your password — please try again" });
  }
});

// ---------- Email verification ----------
// Same pattern as password_resets above: a random token goes in the emailed
// link, only its SHA-256 hash is ever stored, and it's single-use + TTL'd.
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between resends

function hashVerificationToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Generates + stores a new verification token for this user and emails it.
// Used at registration and by the resend endpoint. Never throws into the
// caller's request/response flow — callers that need the account to still
// be created even if this fails already .catch() it themselves.
async function sendVerificationTokenToUser(user) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO email_verifications (id, user_id, token_hash, expires_at, used, created_at)
     VALUES ($1,$2,$3,$4,false,$5)`,
    [
      crypto.randomUUID(),
      user.id,
      hashVerificationToken(token),
      new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString(),
      new Date().toISOString()
    ]
  );
  const verifyUrl = `${PUBLIC_URL}/verify-email.html?token=${token}`;
  await email.sendVerificationEmail(user.email, user.name, verifyUrl);
}

app.post("/api/auth/verify-email", async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "This verification link is invalid or has expired" });
  }

  try {
    const tokenHash = hashVerificationToken(token);
    const result = await db.query(
      `SELECT * FROM email_verifications WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "This verification link is invalid or has expired" });
    }
    const record = result.rows[0];
    const expiresAt = record.expires_at instanceof Date ? record.expires_at.getTime() : new Date(record.expires_at).getTime();

    if (record.used || expiresAt < Date.now()) {
      return res.status(400).json({ error: "This verification link is invalid or has expired" });
    }

    await db.query(`UPDATE users SET email_verified = true WHERE id = $1`, [record.user_id]);
    // Single-use: invalidate this token (and any other still-unused ones
    // for the same user) so it can never be replayed.
    await db.query(`UPDATE email_verifications SET used = true WHERE user_id = $1`, [record.user_id]);

    res.json({ ok: true });
  } catch (error) {
    console.error("[auth] verify-email failed:", error.message);
    res.status(500).json({ error: "Could not verify your email — please try again" });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  const { email: rawEmail } = req.body || {};
  const email_ = typeof rawEmail === "string" ? rawEmail.trim() : "";
  // Same generic response regardless of what's true, to avoid this endpoint
  // being used to enumerate registered emails — mirrors forgot-password.
  const genericMessage = "If an account exists for this email and isn't verified yet, a new verification link has been sent.";

  if (!email_) return res.json({ message: genericMessage });

  try {
    const user = await getUserByEmail(email_);
    if (!user || user.emailVerified) return res.json({ message: genericMessage });

    // Cooldown: skip sending (but still return the same generic message)
    // if a token was already issued too recently for this user.
    const recent = await db.query(
      `SELECT created_at FROM email_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (recent.rows.length > 0) {
      const lastSent = recent.rows[0].created_at instanceof Date
        ? recent.rows[0].created_at.getTime()
        : new Date(recent.rows[0].created_at).getTime();
      if (Date.now() - lastSent < VERIFICATION_RESEND_COOLDOWN_MS) {
        return res.json({ message: genericMessage });
      }
    }

    await sendVerificationTokenToUser(user);
  } catch (error) {
    console.error("[auth] resend-verification failed:", error.message);
    // Same generic response even on error — never leak account existence,
    // never let a transient hiccup surface as a scary error to the customer.
  }

  res.json({ message: genericMessage });
});

// ==================== ORDERS ====================

const REPLACEMENT_OPTIONS = new Set(["", "similar", "contact", "refund"]);
const PAYMENT_METHODS = new Set(["cod", "card", "points"]);
const STANDARD_DELIVERY_FEE = 5.99;
const FREE_DELIVERY_SUBTOTAL_THRESHOLD = 100; // strictly greater than this is free

// Server-side delivery fee calculation — the only place this is ever
// decided. Never trust a delivery fee from the browser. Used identically
// for Cash on Delivery, points, and card orders (Stripe is charged whatever
// this returns).
async function calculateDeliveryFee(userId, subtotal) {
  if (subtotal > FREE_DELIVERY_SUBTOTAL_THRESHOLD) {
    return { fee: 0, reason: "Order over £100" };
  }
  // "First order" = no prior order from this customer that wasn't an
  // abandoned/unpaid card checkout — an abandoned card attempt shouldn't
  // burn the customer's one-time free-delivery offer.
  const result = await db.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1 AND status != 'awaiting_payment'`,
    [userId]
  );
  if (result.rows[0].n === 0) {
    return { fee: 0, reason: "First order" };
  }
  return { fee: STANDARD_DELIVERY_FEE, reason: null };
}

// Basic phone validation: not empty, and a plausible international number
// (digits, spaces, +, -, (, ) only, 7–20 chars) — deliberately loose so
// legitimate international numbers aren't rejected.
function isValidPhone(phone) {
  return typeof phone === "string" && /^[0-9+\-() ]{7,20}$/.test(phone.trim());
}

// Read-only estimate the checkout UI calls live as the basket changes, so
// the customer sees the correct delivery fee and free-delivery reason
// *before* placing the order. Reuses calculateDeliveryFee exactly — the
// real order-creation route below is still what authoritatively decides
// (and re-checks) the fee actually charged; this is display-only.
app.get("/api/checkout/delivery-estimate", requireAuth, async (req, res) => {
  const subtotal = Math.max(0, Math.round((parseFloat(req.query.subtotal) || 0) * 100) / 100);
  try {
    const { fee, reason } = await calculateDeliveryFee(req.user.id, subtotal);
    res.json({ deliveryFee: fee, deliveryFreeReason: reason });
  } catch (error) {
    console.error("[orders] delivery estimate failed:", error.message);
    res.status(500).json({ error: "Could not estimate delivery fee" });
  }
});

app.post("/api/orders", requireAuth, async (req, res) => {
  const { items, paymentMethod, address, orderNote, pointsToUse, phone, platform } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Your basket is empty" });
  if (!PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: "Choose a payment method" });
  if (!address || !address.line1 || !address.city || !address.postcode) {
    return res.status(400).json({ error: "A delivery address is required" });
  }
  const cleanPhone = typeof phone === "string" ? phone.trim() : "";
  if (!isValidPhone(cleanPhone)) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }
  if (paymentMethod === "card" && !stripe) {
    return res.status(400).json({ error: "Card payment isn't configured on this server yet — choose Cash on Delivery" });
  }

  // Never trust client-supplied prices — recompute from the live catalogue.
  let products;
  try {
    products = await getProducts();
  } catch (error) {
    console.error("[orders] Failed to load catalogue for order validation:", error.message);
    return res.status(500).json({ error: "Could not verify product prices — please try again" });
  }
  const lineItems = [];
  let subtotal = 0;
  for (const item of items) {
    const p = products.find(x => x.id === item.productId);
    if (!p) return res.status(400).json({ error: `Product ${item.productId} no longer exists` });
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);

    // Per-item replacement preference and special instruction, captured in
    // the product-options step before the item ever reaches the basket.
    const replacement = REPLACEMENT_OPTIONS.has(item.replacement) ? item.replacement : "";
    const note = typeof item.note === "string" ? item.note.trim().slice(0, 300) : "";
    const availableBrands = Array.isArray(p.brands) ? p.brands.map(b => String(b).trim()).filter(Boolean) : [];
    const brand = typeof item.brand === "string" ? item.brand.trim() : "";

    if(availableBrands.length){
      if(!brand) return res.status(400).json({ error: `Please select a brand for "${p.name}"` });
      if(!availableBrands.includes(brand)) return res.status(400).json({ error: `Invalid brand selected for "${p.name}"` });
    }

    lineItems.push({ productId: p.id, name: p.name, price: p.price, qty, brand, replacement, note });
    subtotal += p.price * qty;
  }
  subtotal = Math.round(subtotal * 100) / 100;

  // ---- Delivery fee (server-side, authoritative — see calculateDeliveryFee) ----
  let deliveryFee, deliveryFreeReason;
  try {
    ({ fee: deliveryFee, reason: deliveryFreeReason } = await calculateDeliveryFee(req.user.id, subtotal));
  } catch (error) {
    console.error("[orders] Failed to calculate delivery fee:", error.message);
    return res.status(500).json({ error: "Could not process your order — please try again" });
  }
  const grandTotal = Math.round((subtotal + deliveryFee) * 100) / 100;

  // Order-level note (e.g. "deliver after 5pm") — separate from each item's
  // own special instruction above.
  const cleanOrderNote = typeof orderNote === "string" ? orderNote.trim().slice(0, 300) : "";

  // ---- Points as payment ----
  // Reuses the same points-per-pound rate already established for voucher
  // redemption (settings.voucherPointsPerPound), so "1 point" means the same
  // thing everywhere in the app — no second conversion rate invented here.
  // Points are applied against the grand total (subtotal + delivery), so a
  // customer with enough points can cover the delivery fee too.
  let rewardsSettings, rewardsAccount;
  try {
    rewardsSettings = await rewards.readSettings();
    rewardsAccount = await rewards.getOrCreateAccount(req.user.id);
  } catch (error) {
    console.error("[orders] Failed to load rewards data:", error.message);
    return res.status(500).json({ error: "Could not process your order — please try again" });
  }
  let pointsUsed = 0;
  let pointsValue = 0;
  if (pointsToUse !== undefined && pointsToUse !== null && pointsToUse !== 0) {
    pointsUsed = parseInt(pointsToUse, 10);
    if (!Number.isInteger(pointsUsed) || pointsUsed < 0) {
      return res.status(400).json({ error: "Invalid points amount" });
    }
    if (pointsUsed > rewardsAccount.pointsBalance) {
      return res.status(400).json({ error: "You don't have enough points for that" });
    }
    // Never let requested points exceed what's actually needed for this order.
    const maxUsefulPoints = Math.ceil(grandTotal * rewardsSettings.voucherPointsPerPound);
    if (pointsUsed > maxUsefulPoints) pointsUsed = maxUsefulPoints;
    pointsValue = Math.round((pointsUsed / rewardsSettings.voucherPointsPerPound) * 100) / 100;
    if (pointsValue > grandTotal) pointsValue = grandTotal;
  }

  let amountDue = Math.round((grandTotal - pointsValue) * 100) / 100;
  if (amountDue < 0) amountDue = 0;

  if (paymentMethod === "points" && amountDue > 0) {
    return res.status(400).json({ error: "Your points don't cover the full order — choose Cash on Delivery or card for the rest" });
  }

  const fullyCoveredByPoints = amountDue <= 0 && pointsUsed > 0;
  const effectivePaymentMethod = fullyCoveredByPoints ? "points" : paymentMethod;
  // COD and points-only orders are trusted immediately, same as this app
  // already trusted COD orders before points existed. Card orders stay
  // "awaiting_payment" until confirmed below.
  const confirmedNow = effectivePaymentMethod === "cod" || effectivePaymentMethod === "points";

  const order = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    customerName: req.user.name,
    customerEmail: req.user.email,
    phone: cleanPhone,
    items: lineItems,
    subtotal,
    deliveryFee,
    deliveryFreeReason,
    total: grandTotal,
    pointsUsed,
    pointsValue,
    amountDue,
    pointsDeducted: false,
    paymentMethod: effectivePaymentMethod,
    address,
    orderNote: cleanOrderNote,
    status: confirmedNow ? "pending" : "awaiting_payment",
    createdAt: new Date().toISOString()
  };

  // Deduct points only once the order is actually confirmed. For COD/points
  // orders that's right now; for card orders it happens later in
  // /api/orders/:id/confirm-card-payment, after Stripe confirms payment.
  // awardPoints() is idempotent per refId, so this can never double-deduct
  // even if this route or the confirm endpoint somehow runs twice.
  if (confirmedNow && pointsUsed > 0) {
    try {
      const tx = await rewards.awardPoints({
        userId: req.user.id, type: "payment", points: -pointsUsed,
        reason: `Used as payment for order #${order.id.slice(0, 8)}`,
        orderId: order.id, refId: `payment:${order.id}`
      });
      if (tx && !tx.error) order.pointsDeducted = true;
    } catch (error) {
      console.error("[orders] Failed to deduct points for order:", error.message);
      return res.status(500).json({ error: "Could not process your order — please try again" });
    }
  }

  try {
    await insertOrder(order);
  } catch (error) {
    console.error("[orders] Failed to save order:", error.message);
    return res.status(500).json({ error: "Could not save your order — please try again" });
  }

  // Best-effort: save the phone number on the account so future checkouts
  // can prefill it. Never blocks the order response.
  saveUserPhoneIfMissing(req.user.id, cleanPhone).catch(e =>
    console.error("[orders] Failed to save phone on user record:", e.message)
  );

  // "Order successfully placed" email — sent for every payment method,
  // right away (including card orders still awaiting payment, so the
  // customer has a record their order was received).
  sendOrderPlacedEmailOnce(order);

  if (confirmedNow) {
    notifyNewOrder(order);
    return res.status(201).json({ order });
  }

  // Card payment for the remaining balance. If points cover part of the
  // order, Stripe is only ever charged the discounted amountDue — as a
  // single consolidated line item, since Stripe Checkout has no concept of
  // a negative "points discount" line.
  const stripeLineItems = pointsUsed > 0
    ? [{
        price_data: {
          currency: "gbp",
          product_data: { name: `MyShopSwift order (£${pointsValue.toFixed(2)} paid with points)` },
          unit_amount: Math.round(amountDue * 100)
        },
        quantity: 1
      }]
    : lineItems.map(li => ({
        price_data: {
          currency: "gbp",
          product_data: { name: li.brand ? `${li.name} — ${li.brand}` : li.name },
          unit_amount: Math.round(li.price * 100)
        },
        quantity: li.qty
      }));

  // Delivery fee must be included in what Stripe actually charges — added
  // as its own line item whenever it isn't already folded into the
  // points-consolidated line above.
  if (pointsUsed === 0 && deliveryFee > 0) {
    stripeLineItems.push({
      price_data: {
        currency: "gbp",
        product_data: { name: "Delivery" },
        unit_amount: Math.round(deliveryFee * 100)
      },
      quantity: 1
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: stripeLineItems,
      // The mobile app has no PUBLIC_URL web page to land on — it opens this
      // checkout in an in-app browser session and needs Stripe to redirect
      // back to a custom URL scheme so control returns to the app. Web
      // behaviour (the default) is completely unchanged.
      success_url: platform === "mobile"
        ? `myshopswift://payment-result?order=${order.id}&paid=1&session_id={CHECKOUT_SESSION_ID}`
        : `${PUBLIC_URL}/?order=${order.id}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: platform === "mobile"
        ? `myshopswift://payment-result?order=${order.id}&paid=0`
        : `${PUBLIC_URL}/?order=${order.id}&paid=0`,
      metadata: { orderId: order.id, pointsUsed: String(pointsUsed) }
    });
    res.status(201).json({ order, checkoutUrl: session.url });
  } catch (error) {
    console.error("[orders] Stripe checkout session creation failed:", error.message);
    res.status(500).json({ error: "Could not start card checkout" });
  }
});

// Confirms a card order really was paid before treating it as confirmed —
// this is what points deduction and order status both wait on for card
// orders, since Stripe's success_url redirect alone isn't proof of payment
// (a customer could navigate there without paying). Idempotent: safe to
// call more than once for the same order (e.g. the customer refreshing the
// success page) — awardPoints()'s refId check prevents a double deduction,
// and the status is simply re-set to the same value.
app.post("/api/orders/:id/confirm-card-payment", requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!stripe) return res.status(400).json({ error: "Card payment isn't configured on this server" });
  if (!sessionId) return res.status(400).json({ error: "Missing session id" });

  let order;
  try {
    order = await getOrderById(req.params.id);
  } catch (error) {
    console.error("[orders] Failed to load order for confirmation:", error.message);
    return res.status(500).json({ error: "Could not verify this order" });
  }
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.userId !== req.user.id) return res.status(403).json({ error: "That's not your order" });

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    return res.status(400).json({ error: "Could not verify payment with Stripe" });
  }
  if (!session || !session.metadata || session.metadata.orderId !== order.id) {
    return res.status(400).json({ error: "This payment session doesn't match this order" });
  }
  if (session.payment_status !== "paid") {
    return res.status(400).json({ error: "Payment hasn't completed yet" });
  }

  if (order.status === "awaiting_payment") {
    order.status = "pending";
  }

  if (order.pointsUsed > 0 && !order.pointsDeducted) {
    try {
      const account = await rewards.getOrCreateAccount(order.userId);
      if (account.pointsBalance < order.pointsUsed) {
        // Balance changed since the order was placed (e.g. spent elsewhere) —
        // never deduct into negative. No points_issue column exists on the
        // real orders table, so this is logged for manual admin follow-up
        // rather than persisted on the order the way the old JSON version did.
        console.warn(`[orders] Order ${order.id}: insufficient points balance at payment confirmation`);
      } else {
        const tx = await rewards.awardPoints({
          userId: order.userId, type: "payment", points: -order.pointsUsed,
          reason: `Used as payment for order #${order.id.slice(0, 8)}`,
          orderId: order.id, refId: `payment:${order.id}`
        });
        if (tx && !tx.error) order.pointsDeducted = true;
      }
    } catch (error) {
      console.error("[orders] Failed to deduct points at payment confirmation:", error.message);
      return res.status(500).json({ error: "Payment verified but could not finalize points — contact support" });
    }
  }

  try {
    await updateOrderAfterPaymentConfirmation(order.id, {
      status: order.status,
      pointsDeducted: order.pointsDeducted
    });
  } catch (error) {
    console.error("[orders] Failed to save order after confirmation:", error.message);
    return res.status(500).json({ error: "Payment verified but could not update the order — contact support" });
  }

  notifyNewOrder(order);
  sendPaymentConfirmedEmailOnce(order);
  res.json({ order });
});

app.get("/api/orders/mine", requireAuth, async (req, res) => {
  try {
    const orders = await getOrdersByUser(req.user.id);
    res.json({ orders });
  } catch (error) {
    console.error("[orders] Failed to load customer orders:", error.message);
    res.status(500).json({ error: "Could not load your orders" });
  }
});

app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await getAllOrders();
    res.json({ orders });
  } catch (error) {
    console.error("[orders] Failed to load admin order list:", error.message);
    res.status(500).json({ error: "Could not load orders" });
  }
});

const ORDER_STATUSES = ["pending", "awaiting_payment", "processing", "shipped", "delivered", "cancelled"];
app.put("/api/orders/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });

  let order;
  try {
    order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const previousStatus = order.status;
    order.status = status;
    await setOrderStatus(order.id, status);

    // Rewards: "delivered" is the qualifying/completed status for this
    // project's order lifecycle. Award on entry, reverse on exit — both
    // idempotent, so re-saving the same status twice is always safe.
    // Points are earned on the merchandise subtotal only, not the delivery
    // fee — pass a total override for this call so the earn rate keeps
    // meaning what it always meant, before delivery fees existed.
    try {
      if (status === "delivered" && previousStatus !== "delivered") {
        await rewards.processQualifyingPurchase({ ...order, total: order.subtotal });
      } else if (previousStatus === "delivered" && status !== "delivered") {
        await rewards.reverseQualifyingPurchase({ ...order, total: order.subtotal });
      }
    } catch (e) { console.error("[rewards] order status reward handling failed:", e.message); }

    // Customer-facing status email — only when the status actually changed,
    // so re-saving the same value in the dropdown never resends it.
    if (status !== previousStatus) {
      sendOrderStatusEmail(order);
    }

    res.json({ order });
  } catch (error) {
    console.error("[orders] Failed to update order status:", error.message);
    res.status(500).json({ error: "Could not update order status" });
  }
});

// ==================== ADMIN NOTIFICATIONS ====================

// Real-time stream. EventSource sends cookies automatically for a
// same-origin URL, so the normal cookie-based requireAdmin works here too —
// no key-in-the-URL workaround needed anymore.
app.get("/api/admin/notifications/stream", requireAdmin, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no" // disable proxy buffering (e.g. nginx) so events arrive immediately
  });
  const initialUnreadCount = await notifications.unreadCount().catch(() => 0);
  res.write(`event: connected\ndata: ${JSON.stringify({ unreadCount: initialUnreadCount })}\n\n`);

  notifications.subscribe(res);

  // Keep the connection alive through proxies/load balancers that close
  // idle connections; a comment line is invisible to EventSource listeners.
  const heartbeat = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch (e) { /* connection already gone */ }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    notifications.unsubscribe(res);
  });
});

app.get("/api/admin/notifications", requireAdmin, async (req, res) => {
  try {
    const unreadOnly = req.query.filter === "unread";
    const [list, unreadCount] = await Promise.all([
      notifications.list({ unreadOnly }),
      notifications.unreadCount()
    ]);
    res.json({ notifications: list, unreadCount });
  } catch (error) {
    console.error("[notifications] Failed to load notifications:", error.message);
    res.status(500).json({ error: "Could not load notifications" });
  }
});

app.post("/api/admin/notifications/:id/read", requireAdmin, async (req, res) => {
  try {
    const n = await notifications.markRead(req.params.id);
    if (!n) return res.status(404).json({ error: "Notification not found" });
    res.json({ notification: n, unreadCount: await notifications.unreadCount() });
  } catch (error) {
    console.error("[notifications] Failed to mark notification read:", error.message);
    res.status(500).json({ error: "Could not update notification" });
  }
});

app.post("/api/admin/notifications/read-all", requireAdmin, async (req, res) => {
  try {
    await notifications.markAllRead();
    res.json({ ok: true, unreadCount: await notifications.unreadCount() });
  } catch (error) {
    console.error("[notifications] Failed to mark all notifications read:", error.message);
    res.status(500).json({ error: "Could not update notifications" });
  }
});

app.delete("/api/admin/notifications/:id", requireAdmin, async (req, res) => {
  try {
    const removed = await notifications.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: "Notification not found" });
    res.json({ ok: true, unreadCount: await notifications.unreadCount() });
  } catch (error) {
    console.error("[notifications] Failed to delete notification:", error.message);
    res.status(500).json({ error: "Could not delete notification" });
  }
});

// ==================== CUSTOMERS (admin) ====================

app.get("/api/customers", requireAdmin, async (req, res) => {
  try {
    const users = (await getAllUsers()).map(publicUser);
    const orders = await getAllOrders();
    const withStats = users.map(u => ({
      ...u,
      orderCount: orders.filter(o => o.userId === u.id).length,
      totalSpent: Math.round(orders.filter(o => o.userId === u.id).reduce((s, o) => s + o.total, 0) * 100) / 100
    }));
    res.json({ customers: withStats });
  } catch (error) {
    console.error("[customers] Failed to load customers:", error.message);
    res.status(500).json({ error: "Could not load customers" });
  }
});

// ==================== REWARDS / LOYALTY ====================

function referralLinkFor(code) {
  return `${PUBLIC_URL}/?ref=${encodeURIComponent(code)}`;
}

// ---- customer-facing ----

app.get("/api/rewards/me", requireAuth, async (req, res) => {
  try {
    const [settings, account, transactions, vouchers, referrals] = await Promise.all([
      rewards.readSettings(),
      rewards.getOrCreateAccount(req.user.id),
      rewards.readTransactions(),
      rewards.readVouchers(),
      rewards.readReferrals()
    ]);
    const myTransactions = transactions.filter(t => t.userId === req.user.id);
    const myVouchers = vouchers.filter(v => v.userId === req.user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const myReferrals = referrals.filter(r => r.referrerUserId === req.user.id);

    res.json({
      balance: account.pointsBalance,
      referralCode: account.referralCode,
      referralLink: referralLinkFor(account.referralCode),
      referredBy: account.referredBy ? true : false,
      referrals: {
        total: myReferrals.length,
        rewarded: myReferrals.filter(r => r.status === "rewarded").length,
        pending: myReferrals.filter(r => r.status === "pending").length
      },
      transactions: myTransactions.slice(0, 50),
      vouchers: myVouchers,
      howToEarn: {
        accountCreation: settings.accountCreation,
        purchaseAmountPerPoint: settings.purchaseAmountPerPoint,
        referral: settings.referral,
        review: settings.review,
        repeatPurchaseBonus: settings.repeatPurchaseBonus,
        voucherPointsPerPound: settings.voucherPointsPerPound
      }
    });
  } catch (error) {
    console.error("[rewards] Failed to load rewards/me:", error.message);
    res.status(500).json({ error: "Could not load your rewards" });
  }
});

app.post("/api/rewards/redeem", requireAuth, async (req, res) => {
  try {
    const points = parseInt((req.body || {}).points, 10);
    const result = await rewards.redeemPoints(req.user.id, points);
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
  } catch (error) {
    console.error("[rewards] Redemption failed:", error.message);
    res.status(500).json({ error: "Could not redeem points" });
  }
});

// ---- admin ----

app.get("/api/rewards/admin/overview", requireAdmin, async (req, res) => {
  try {
    res.json(await rewards.overview());
  } catch (error) {
    console.error("[rewards] Failed to load admin overview:", error.message);
    res.status(500).json({ error: "Could not load rewards overview" });
  }
});

app.get("/api/rewards/admin/settings", requireAdmin, async (req, res) => {
  try {
    res.json({ settings: await rewards.readSettings() });
  } catch (error) {
    console.error("[rewards] Failed to load settings:", error.message);
    res.status(500).json({ error: "Could not load settings" });
  }
});

app.put("/api/rewards/admin/settings", requireAdmin, async (req, res) => {
  const err = rewards.validateSettingsPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const settings = await rewards.updateSettings(req.body);
    res.json({ settings });
  } catch (error) {
    console.error("[rewards] Failed to update settings:", error.message);
    res.status(500).json({ error: "Could not update settings" });
  }
});

app.get("/api/rewards/admin/customers", requireAdmin, async (req, res) => {
  try {
    const search = (req.query.search || "").toLowerCase().trim();
    const users = await getAllUsers();
    const accounts = await rewards.readAccounts();
    let rows = accounts.map(a => {
      const u = users.find(x => x.id === a.userId);
      return {
        userId: a.userId,
        name: u ? u.name : "(deleted account)",
        email: u ? u.email : "",
        pointsBalance: a.pointsBalance,
        referralCode: a.referralCode,
        referredBy: a.referredBy,
        qualifyingPurchaseCount: a.qualifyingPurchaseCount,
        createdAt: a.createdAt
      };
    });
    if (search) {
      rows = rows.filter(r => r.name.toLowerCase().includes(search) || r.email.toLowerCase().includes(search));
    }
    res.json({ customers: rows });
  } catch (error) {
    console.error("[rewards] Failed to load admin customers:", error.message);
    res.status(500).json({ error: "Could not load customers" });
  }
});

app.get("/api/rewards/admin/transactions", requireAdmin, async (req, res) => {
  try {
    let txs = await rewards.readTransactions();
    if (req.query.userId) txs = txs.filter(t => t.userId === req.query.userId);
    if (req.query.type) txs = txs.filter(t => t.type === req.query.type);
    res.json({ transactions: txs.slice(0, 500) });
  } catch (error) {
    console.error("[rewards] Failed to load admin transactions:", error.message);
    res.status(500).json({ error: "Could not load transactions" });
  }
});

app.get("/api/rewards/admin/referrals", requireAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    const nameOf = id => { const u = users.find(x => x.id === id); return u ? u.name : "(deleted account)"; };
    const referrals = (await rewards.readReferrals())
      .map(r => ({ ...r, referrerName: nameOf(r.referrerUserId), referredName: nameOf(r.referredUserId) }));
    res.json({ referrals });
  } catch (error) {
    console.error("[rewards] Failed to load admin referrals:", error.message);
    res.status(500).json({ error: "Could not load referrals" });
  }
});

app.get("/api/rewards/admin/vouchers", requireAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    const nameOf = id => { const u = users.find(x => x.id === id); return u ? u.name : "(deleted account)"; };
    const vouchers = (await rewards.readVouchers())
      .map(v => ({ ...v, customerName: nameOf(v.userId) }));
    res.json({ vouchers });
  } catch (error) {
    console.error("[rewards] Failed to load admin vouchers:", error.message);
    res.status(500).json({ error: "Could not load vouchers" });
  }
});

app.post("/api/rewards/admin/adjust", requireAdmin, async (req, res) => {
  try {
    const { userId, points, reason } = req.body || {};
    const user = await getUserById(userId);
    if (!user) return res.status(400).json({ error: "Unknown customer" });
    const result = await rewards.adjustPointsByAdmin(userId, parseInt(points, 10), reason);
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
  } catch (error) {
    console.error("[rewards] Admin adjust failed:", error.message);
    res.status(500).json({ error: "Could not adjust points" });
  }
});

// ==================== BRAND FLYERS ====================

// Public: the customer-facing carousel fetches its images from here.
app.get("/api/flyers", async (req, res) => {
  try { res.json({ flyers: await flyers.listPublic() }); }
  catch (e) { console.error("[flyers] Failed to load public flyers:", e.message); res.status(500).json({ error: "Could not load flyers" }); }
});

// Admin: upload one or more flyer images in a single request.
app.post("/api/admin/flyers", requireAdmin, (req, res) => {
  flyers.uploadMultiple(req, res, async (err) => {
    if (err) return res.status(400).json({ error: flyerUploadErrorMessage(err) });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No flyer images were uploaded" });
    try {
      const created = await flyers.addFlyers(req.files);
      res.status(201).json({ flyers: created });
    } catch (e) { console.error("[flyers] Failed to save uploaded flyers:", e.message); res.status(500).json({ error: "Could not save uploaded flyers" }); }
  });
});

// Admin: list every flyer (including ones the public feed also shows).
app.get("/api/admin/flyers", requireAdmin, async (req, res) => {
  try { res.json({ flyers: await flyers.listAdmin() }); }
  catch (e) { console.error("[flyers] Failed to load admin flyers:", e.message); res.status(500).json({ error: "Could not load flyers" }); }
});

// Admin: replace the image for one existing flyer, keeping its id/position.
app.put("/api/admin/flyers/:id/replace", requireAdmin, (req, res) => {
  flyers.uploadSingle(req, res, async (err) => {
    if (err) return res.status(400).json({ error: flyerUploadErrorMessage(err) });
    if (!req.file) return res.status(400).json({ error: "No replacement image was uploaded" });
    try {
      const result = await flyers.replaceFlyer(req.params.id, req.file);
      if (result.error) return res.status(404).json({ error: result.error });
      res.json(result);
    } catch (e) { console.error("[flyers] Failed to replace flyer:", e.message); res.status(500).json({ error: "Could not replace flyer" }); }
  });
});

// Admin: delete a flyer (removes both the metadata row and the image bytes).
app.delete("/api/admin/flyers/:id", requireAdmin, async (req, res) => {
  try {
    const result = await flyers.deleteFlyer(req.params.id);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json(result);
  } catch (e) { console.error("[flyers] Failed to delete flyer:", e.message); res.status(500).json({ error: "Could not delete flyer" }); }
});

// Admin: reorder flyers — body is the full list of flyer ids in the new order.
app.put("/api/admin/flyers/reorder", requireAdmin, async (req, res) => {
  try {
    const result = await flyers.reorderFlyers((req.body || {}).order);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) { console.error("[flyers] Failed to reorder flyers:", e.message); res.status(500).json({ error: "Could not reorder flyers" }); }
});

function flyerUploadErrorMessage(err) {
  if (err && err.code === "LIMIT_FILE_SIZE") return "Each flyer image must be 5MB or smaller";
  if (err && err.code === "LIMIT_FILE_COUNT") return "Upload up to 20 flyer images at a time";
  return (err && err.message) || "Upload failed";
}

// The old JSON-file backup mechanism (backup.js) has been removed: every
// data file it covered (users, orders, products, rewards, notifications,
// password resets, contact messages, flyers) is in Postgres now, and
// Render's free plan has no persistent disk for it to write backups to
// anyway. Back up Postgres itself instead — Neon point-in-time recovery,
// or a scheduled `pg_dump`.

// ==================== CONTACT ====================
// Public — no login required, matching a normal storefront contact form.
// Stored in Postgres (contact_messages table) rather than JSON — Render's
// free plan has no persistent disk, so a JSON file here would lose every
// submission on the next redeploy or spin-down.
app.post("/api/contact", async (req, res) => {
  const { name, email: fromEmail, subject, message } = req.body || {};
  const clean = {
    name: typeof name === "string" ? name.trim().slice(0, 120) : "",
    email: typeof fromEmail === "string" ? fromEmail.trim().slice(0, 200) : "",
    subject: typeof subject === "string" ? subject.trim().slice(0, 200) : "",
    message: typeof message === "string" ? message.trim().slice(0, 2000) : ""
  };
  if (!clean.name || !clean.email || !clean.subject || !clean.message) {
    return res.status(400).json({ error: "Please fill in every field" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }

  const entry = { id: crypto.randomUUID(), ...clean, createdAt: new Date().toISOString() };
  try {
    await db.query(
      `INSERT INTO contact_messages (id, name, email, subject, message, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.id, entry.name, entry.email, entry.subject, entry.message, entry.createdAt]
    );
  } catch (error) {
    console.error("[contact] Failed to save message:", error.message);
    return res.status(500).json({ error: "Could not send your message — please try again" });
  }

  if (CONTACT_INBOX_EMAIL) {
    email.sendMail({
      to: CONTACT_INBOX_EMAIL,
      subject: `[MyShopSwift contact] ${clean.subject}`,
      text: `From: ${clean.name} <${clean.email}>\n\n${clean.message}`,
      html: `<p><strong>From:</strong> ${clean.name} &lt;${clean.email}&gt;</p><p>${clean.message.replace(/\n/g, "<br>")}</p>`
    }).catch(() => { /* message is already saved either way — admin can still see it */ });
  }

  res.status(201).json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`MyShopSwift running at ${PUBLIC_URL}`);
  console.log(`Admin panel at        ${PUBLIC_URL}/admin.html`);
});

