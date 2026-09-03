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
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

// products.json, users.json, orders.json, password-resets.json, and
// contact-messages.json are no longer read or written anywhere in this
// file — every one of them is migrated to Postgres. Their constants are
// deliberately removed rather than left dangling, so nothing here
// misleadingly implies JSON is still authoritative for any of them.
const CONTACT_INBOX_EMAIL = process.env.CONTACT_INBOX_EMAIL || process.env.SMTP_USER || "";

if (ADMIN_KEY === "change-this-admin-key") {
  console.warn("\nWARNING: ADMIN_KEY is still the default — set a real one before deploying.\n");
}
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
  const token = req.cookies.session;

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

    const u = result.rows[0];

    req.user = {
      id: u.id,
      name: u.name,
      email: u.email,
      passwordHash: u.password_hash,
      createdAt: u.created_at
    };

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

function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key");
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Missing or incorrect admin key" });
  }
  next();
}

// SSE connections (EventSource) can't send custom headers, only a URL —
// so the one-time stream-open request is authenticated via a query param
// instead of the x-admin-key header every other admin route uses. This is
// the standard workaround for authenticating SSE with a native EventSource
// client; it's used nowhere else in the app.
function requireAdminForStream(req, res, next) {
  const key = req.query.key;
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Missing or incorrect admin key" });
  }
  next();
}

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
    createdAt: row.created_at
  };
}

async function getAllUsers() {
  const result = await db.query(
    `SELECT id, name, email, password_hash, created_at FROM users`
  );
  return result.rows.map(rowToUser);
}

async function getUserById(id) {
  const result = await db.query(
    `SELECT id, name, email, password_hash, created_at FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

async function getUserByEmail(email) {
  const result = await db.query(
    `SELECT id, name, email, password_hash, created_at FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows.length ? rowToUser(result.rows[0]) : null;
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
    items: row.items,
    total: Number(row.total),
    pointsUsed: row.points_used !== null ? Number(row.points_used) : 0,
    pointsValue: row.points_value !== null ? Number(row.points_value) : 0,
    amountDue: row.amount_due !== null ? Number(row.amount_due) : 0,
    pointsDeducted: !!row.points_deducted,
    paymentMethod: row.payment_method,
    address: row.address,
    orderNote: row.order_note || "",
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function insertOrder(order) {
  await db.query(
    `INSERT INTO orders (
      id, user_id, customer_name, customer_email, items, total,
      points_used, points_value, amount_due, points_deducted,
      payment_method, address, order_note, status, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      order.id, order.userId, order.customerName, order.customerEmail,
      JSON.stringify(order.items), order.total, order.pointsUsed, order.pointsValue,
      order.amountDue, order.pointsDeducted, order.paymentMethod,
      JSON.stringify(order.address), order.orderNote, order.status, order.createdAt
    ]
  );
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
      `INSERT INTO users (id, name, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, password_hash, created_at`,
      [id, name, email, passwordHash, createdAt]
    );

    const row = result.rows[0];

    const user = {
      id: row.id,
      name: row.name,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    };

    try {
      await rewards.awardSignupBonus(
        user.id,
        typeof referralCode === "string" ? referralCode : ""
      );
    } catch (e) {
      console.error("[rewards] signup bonus failed:", e.message);
    }

    const token = await createSession(user.id);

    res.cookie("session", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.status(201).json({
      user: publicUser(user)
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
      `SELECT id, name, email, password_hash, created_at
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

    const user = {
      id: row.id,
      name: row.name,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    };

    const token = await createSession(user.id);

    res.cookie("session", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({
      user: publicUser(user)
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
  const token = req.cookies.session;
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

// ==================== ORDERS ====================

const REPLACEMENT_OPTIONS = new Set(["", "similar", "contact", "refund"]);
const PAYMENT_METHODS = new Set(["cod", "card", "points"]);

app.post("/api/orders", requireAuth, async (req, res) => {
  const { items, paymentMethod, address, orderNote, pointsToUse } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Your basket is empty" });
  if (!PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: "Choose a payment method" });
  if (!address || !address.line1 || !address.city || !address.postcode) {
    return res.status(400).json({ error: "A delivery address is required" });
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
  let total = 0;
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
    total += p.price * qty;
  }
  total = Math.round(total * 100) / 100;

  // Order-level note (e.g. "deliver after 5pm") — separate from each item's
  // own special instruction above.
  const cleanOrderNote = typeof orderNote === "string" ? orderNote.trim().slice(0, 300) : "";

  // ---- Points as payment ----
  // Reuses the same points-per-pound rate already established for voucher
  // redemption (settings.voucherPointsPerPound), so "1 point" means the same
  // thing everywhere in the app — no second conversion rate invented here.
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
    const maxUsefulPoints = Math.ceil(total * rewardsSettings.voucherPointsPerPound);
    if (pointsUsed > maxUsefulPoints) pointsUsed = maxUsefulPoints;
    pointsValue = Math.round((pointsUsed / rewardsSettings.voucherPointsPerPound) * 100) / 100;
    if (pointsValue > total) pointsValue = total;
  }

  let amountDue = Math.round((total - pointsValue) * 100) / 100;
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
    items: lineItems,
    total,
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

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: stripeLineItems,
      success_url: `${PUBLIC_URL}/?order=${order.id}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/?order=${order.id}&paid=0`,
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
    try {
      if (status === "delivered" && previousStatus !== "delivered") {
        await rewards.processQualifyingPurchase(order);
      } else if (previousStatus === "delivered" && status !== "delivered") {
        await rewards.reverseQualifyingPurchase(order);
      }
    } catch (e) { console.error("[rewards] order status reward handling failed:", e.message); }

    res.json({ order });
  } catch (error) {
    console.error("[orders] Failed to update order status:", error.message);
    res.status(500).json({ error: "Could not update order status" });
  }
});

// ==================== ADMIN NOTIFICATIONS ====================

// Real-time stream. Auth via ?key= (see requireAdminForStream) since
// EventSource can't set the x-admin-key header every other admin route uses.
app.get("/api/admin/notifications/stream", requireAdminForStream, async (req, res) => {
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

