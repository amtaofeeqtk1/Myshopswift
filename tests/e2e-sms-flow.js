"use strict";

// End-to-end flow check for the SMS / WhatsApp / security changes.
//   Run:  node tests/e2e-sms-flow.js            (production-like: NODE_ENV=production)
//         NODE_ENV=development node tests/e2e-sms-flow.js
//
// It starts the REAL server.js, but with in-memory stand-ins for everything
// external: PostgreSQL (a pattern-matching fake), Stripe, rewards, and
// Twilio (fetch to api.twilio.com is intercepted). No network, no credentials.
//
// What this does NOT prove: that the real SQL is accepted by PostgreSQL, that
// real Twilio/Stripe accept the requests, or that a real phone gets a text.
// See the README "staging checklist" for those.

const assert = require("node:assert/strict");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");
const bcrypt = require("bcryptjs");
const { handleSmsQuery } = require("./helpers/fake-sms-db");

const PORT = 38123;
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC_URL = "https://shop.example.com";
const PRODUCTION = (process.env.NODE_ENV || "production") === "production";
// Variants: (default) TWILIO_FROM sender | --messaging-service: TWILIO_MESSAGING_SERVICE_SID (with TWILIO_FROM also set,
// to prove they don't conflict) | --bad-sid: a malformed Messaging Service SID (SMS must switch itself off, orders unaffected).
const VARIANT = process.argv.includes("--messaging-service") ? "service" : process.argv.includes("--bad-sid") ? "badsid" : "from";
const SERVICE_SID = "MG" + "0123456789abcdef0123456789abcdef";
const VARIANT_ENV = VARIANT === "service" ? { TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID }
  : VARIANT === "badsid" ? { TWILIO_MESSAGING_SERVICE_SID: "AC" + "0123456789abcdef0123456789abcdef" } : {};
process.env.NODE_ENV = PRODUCTION ? "production" : "development";

Object.assign(process.env, {
  DATABASE_URL: "postgres://fake/fake", PORT: String(PORT), PUBLIC_URL,
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "twilio-test-token", TWILIO_FROM: "MyShopSwift", ...VARIANT_ENV,
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  ADMIN_EMAIL: "admin@example.com"
});
for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "OPENAI_API_KEY", "CONTACT_INBOX_EMAIL"]) delete process.env[k];

// ---------------- fakes ----------------
const store = { orders: new Map(), smsRows: [], notifications: new Map(), schemaEnsured: false, breakOrderReads: false, productAvailable: true, sellOutAtLock: false };
const USER = { id: "u1", name: "Test Customer", email: "c@example.com", password_hash: bcrypt.hashSync("password123", 4), phone: "", email_verified: true, created_at: new Date() };
const OTHER = { id: "u2", name: "Other Person", email: "o@example.com", password_hash: "x", phone: "", email_verified: true, created_at: new Date() };
const SESSIONS = { usertoken: USER, othertoken: OTHER };

const norm = sql => sql.replace(/\s+/g, " ").trim();

class FakePool {
  async connect() { return { query: (...a) => this.query(...a), release() {} }; }
  async query(sql, params = []) {
    const q = norm(sql);
    if (q.startsWith("SELECT NOW()")) return { rows: [{}] };
    if (q.includes("CREATE TABLE IF NOT EXISTS sms_notifications")) { store.schemaEnsured = true; return { rows: [] }; }
    const sms = handleSmsQuery(store.smsRows, sql, params);
    if (sms !== undefined) return sms;

    if (q.includes("FROM sessions s JOIN users u")) { const u = SESSIONS[params[0]]; return { rows: u ? [u] : [] }; }
    if (q.startsWith("SELECT token FROM admin_sessions")) return { rows: params[0] === "admintoken" ? [{ token: "admintoken" }] : [] };
    if (q.startsWith("INSERT INTO sessions")) return { rows: [] };
    if (q.includes("FROM users WHERE LOWER(email) = LOWER($1)")) return { rows: String(params[0]).toLowerCase() === USER.email ? [USER] : [] };
    if (q.startsWith("UPDATE password_resets") || q.startsWith("INSERT INTO password_resets")) return { rows: [] };
    if (q.startsWith("DELETE FROM sessions WHERE user_id")) { store.sessionsClearedFor = params[0]; return { rows: [] }; }
    if (q.startsWith("UPDATE users SET phone")) return { rows: [] };
    if (q.startsWith("SELECT * FROM categories")) return { rows: [{ id:"grocery", name:"grocery", icon:"", image:"" }] };

    if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
    if (q.startsWith("SELECT id, name, available FROM products WHERE id = ANY")) {
      if(store.sellOutAtLock){store.productAvailable=false;store.sellOutAtLock=false;}
      return params[0].includes(1) ? { rows: [{id:1,name:"Rice",available:store.productAvailable}] } : { rows: [] };
    }
    if (q.startsWith("UPDATE products SET available = $1 WHERE id = $2 RETURNING id, available")) {
      if(params[1]!==1)return {rows:[]};store.productAvailable=params[0];return {rows:[{id:1,available:store.productAvailable}]};
    }
    if (q.startsWith("SELECT * FROM products")) {
      return { rows: [{ id: 1, name: "Rice", category: "grocery", price: "10.00", old_price: null, icon: "", tag: "", image: "", description: "", brands: [], available:store.productAvailable }] };
    }
    if (q.startsWith("SELECT COUNT(*)::int AS n FROM orders")) return { rows: [{ n: 2 }] };

    if (q.startsWith("INSERT INTO orders")) {
      const [id, user_id, customer_name, customer_email, phone, items, subtotal, delivery_fee, delivery_free_reason, total,
        points_used, points_value, amount_due, points_deducted, payment_method, address, order_note, status, created_at] = params;
      store.orders.set(id, {
        id, user_id, customer_name, customer_email, phone, items: JSON.parse(items), subtotal, delivery_fee, delivery_free_reason, total,
        points_used, points_value, amount_due, points_deducted, payment_method, address: JSON.parse(address), order_note, status, created_at,
        placed_email_sent: false, payment_email_sent: false
      });
      return { rows: [] };
    }
    let m = q.match(/^UPDATE orders SET (\w+_email_sent) = true WHERE id = \$1 AND \1 = false RETURNING id/);
    if (m) { const o = store.orders.get(params[0]); if (!o || o[m[1]]) return { rows: [] }; o[m[1]] = true; return { rows: [{ id: o.id }] }; }
    if (q.startsWith("SELECT * FROM orders WHERE id = $1")) {
      if (store.breakOrderReads) throw new Error("simulated database outage");
      const o = store.orders.get(params[0]); return { rows: o ? [{ ...o }] : [] };
    }
    if (q.startsWith("SELECT * FROM orders WHERE user_id = $1")) return { rows: [...store.orders.values()].filter(o => o.user_id === params[0]) };
    if (q.startsWith("UPDATE orders SET status = $1, points_deducted = $2 WHERE id = $3")) {
      Object.assign(store.orders.get(params[2]), { status: params[0], points_deducted: params[1] }); return { rows: [] };
    }
    if (q.startsWith("UPDATE orders SET status = $1 WHERE id = $2")) { store.orders.get(params[1]).status = params[0]; return { rows: [] }; }

    if (q.startsWith("SELECT * FROM notifications WHERE dedupe_key")) { const n = store.notifications.get(params[0]); return { rows: n ? [n] : [] }; }
    if (q.startsWith("INSERT INTO notifications")) {
      const [id, type, title, message, order_id, customer_id, dedupe_key, created_at] = params;
      const n = { id, type, title, message, order_id, customer_id, dedupe_key, read: false, created_at };
      store.notifications.set(dedupe_key, n); return { rows: [n] };
    }
    if (q.includes("COUNT(*)::int AS count FROM notifications")) return { rows: [{ count: store.notifications.size }] };

    throw new Error("e2e fake db: unmocked SQL: " + q.slice(0, 110));
  }
}

const rewardsCalls = [];
let testPointsBalance = 0;
let testPointDebitFailure = false;
const fakeRewards = {
  readSettings: async () => ({ voucherPointsPerPound: 10 }),
  getOrCreateAccount: async () => ({ pointsBalance: testPointsBalance }),
  awardPoints: async tx => {
    if (tx.points < 0 && testPointDebitFailure) return { error: "insufficient_points" };
    testPointsBalance += tx.points;
    return { error: null };
  },
  awardSignupBonus: async () => null,
  processQualifyingPurchase: async o => { rewardsCalls.push(["award", o.id]); },
  reverseQualifyingPurchase: async o => { rewardsCalls.push(["reverse", o.id]); }
};

const realStripe = require("stripe")("sk_test_fake");
const stripeSessions = new Map(); // sessionId -> orderId
function fakeStripeFactory() {
  return {
    webhooks: realStripe.webhooks,
    checkout: { sessions: {
      create: async opts => { const id = "cs_" + crypto.randomBytes(4).toString("hex"); stripeSessions.set(id, opts.metadata.orderId); return { id, url: "https://checkout.stripe.test/" + id }; },
      retrieve: async id => ({ id, payment_status: "paid", metadata: { orderId: stripeSessions.get(id) } })
    } }
  };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") return { config() { return {}; } }; // never load the real .env (real SMTP/DB/Stripe secrets)
  if (request === "pg") return { Pool: FakePool };
  if (request === "stripe") return fakeStripeFactory;
  if (request === "./rewards" && parent && path.basename(parent.filename) === "server.js") return () => fakeRewards;
  return origLoad.apply(this, arguments);
};

const realFetch = globalThis.fetch;
const twilio = { calls: [], mode: "ok", n: 0 };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.twilio.com/")) {
    twilio.calls.push({ url: String(url), params: new URLSearchParams(init.body), auth: init.headers.Authorization });
    if (twilio.mode === "fail") return { ok: false, status: 400, json: async () => ({ code: 21211, message: "The 'To' number +447739320205 is not valid" }) };
    return { ok: true, status: 201, json: async () => ({ sid: "SM" + (++twilio.n).toString().padStart(4, "0"), status: "queued" }) };
  }
  return realFetch(url, init);
};

const serverLogs = [];
for (const k of ["log", "warn", "error"]) { console[k] = (...a) => { serverLogs.push(a.join(" ")); }; }
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

// ---------------- helpers ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function http(method, url, { body, cookie, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await realFetch(BASE + url, { method, headers: h, body: payload, redirect: "manual" });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const user = { cookie: "session=usertoken" };
const other = { cookie: "session=othertoken" };
const admin = { cookie: "admin_session=admintoken" };
const GOOD_ADDRESS = { line1: "1 High Street", city: "London", postcode: "E1 6AN" };
const placeOrder = (over = {}, who = user) => http("POST", "/api/orders", { ...who, body: { items: [{ productId: 1, qty: 1 }], paymentMethod: "card", address: GOOD_ADDRESS, phone: "07739 320205", ...over } });
const twilioBodiesFor = orderId => twilio.calls.filter(c => c.params.get("Body").includes(orderId.slice(0, 8))).map(c => c.params.get("Body"));
const smsFor = (orderId, event) => store.smsRows.filter(r => r.order_id === orderId && (!event || r.event === event));
const twilioSig = (url, params) => crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(url + Object.keys(params).sort().map(k => k + params[k]).join("")).digest("base64");

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; out("  ok  -", name); }
  catch (e) { failed++; out("  FAIL-", name, "\n       ", (e && e.message || e).toString().split("\n").slice(0, 6).join("\n        ")); }
}

// ---------------- run ----------------
(async () => {
  out(`\nE2E flow check (NODE_ENV=${process.env.NODE_ENV})\n`);
  require("../server.js");
  for (let i = 0; i < 50; i++) { try { if ((await realFetch(BASE + "/api/health")).ok) break; } catch (e) { /* not up yet */ } await sleep(100); }
  await sleep(100);

  await step("server boots, health OK, sms_notifications table ensured at startup", async () => {
    assert.equal((await http("GET", "/api/health")).status, 200);
    assert.equal(store.schemaEnsured, true);
  });

  if (VARIANT === "badsid") {
    await step("malformed Messaging Service SID: SMS switches itself off with a clear reason; orders still succeed; nothing sent to Twilio", async () => {
      assert.ok(serverLogs.some(l => l.includes("SMS is OFF because of a configuration problem")));
      assert.ok(serverLogs.some(l => l.includes("TWILIO_MESSAGING_SERVICE_SID is not a valid Messaging Service SID") && l.includes("Account SID")));
      assert.ok(!serverLogs.join("\n").includes("0123456789abcdef0123456789abcdef"), "the SID value is never logged");
      const r = await placeOrder();
      assert.equal(r.status, 201, "checkout is unaffected");
      await sleep(100);
      assert.equal(twilio.calls.length, 0);
      assert.equal(store.smsRows.length, 0, "no failed rows are created for every order");
      const adminInfo = await http("GET", "/api/admin/sms-notifications", admin);
      assert.equal(adminInfo.json.configured, false);
      assert.match(adminInfo.json.problems[0], /not a valid Messaging Service SID/);
    });
    out(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }

  await step("admin SMS endpoints and delivery callback reject anonymous callers", async () => {
    assert.equal((await http("GET", "/api/admin/sms-notifications")).status, 401);
    assert.equal((await http("POST", "/api/admin/sms-notifications/x/retry")).status, 401);
    assert.equal((await http("GET", "/api/admin/sms-notifications", other)).status, 401, "a logged-in customer is not an admin");
    const form = "MessageSid=SM0001&MessageStatus=delivered";
    const noSig = await http("POST", "/api/sms/twilio-status", { raw: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const badSig = await http("POST", "/api/sms/twilio-status", { raw: form, headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "AAAA" } });
    assert.equal(noSig.status, 403);
    assert.equal(badSig.status, 403);
  });

  let order1;
  await step("card order: created as awaiting payment and 'order received' SMS goes to the checkout number", async () => {
    const r = await placeOrder();
    assert.equal(r.status, 201);
    order1 = r.json.order;
    await sleep(100);
    assert.equal(twilio.calls.length, 1);
    const c = twilio.calls[0];
    assert.equal(c.params.get("To"), "+447739320205");
    if (VARIANT === "service") {
      assert.equal(c.params.get("MessagingServiceSid"), SERVICE_SID);
      assert.equal(c.params.has("From"), false, "From must not accompany MessagingServiceSid");
    } else {
      assert.equal(c.params.get("From"), "MyShopSwift");
      assert.equal(c.params.has("MessagingServiceSid"), false);
    }
    assert.equal(c.params.get("Body"), `MyShopSwift: Your order ${order1.id.slice(0, 8)} has been successfully received. Thank you for shopping with us!`);
    assert.equal(c.params.get("StatusCallback"), PUBLIC_URL + "/api/sms/twilio-status");
    assert.ok(c.auth.startsWith("Basic "));
    assert.equal(smsFor(order1.id, "order_placed")[0].status, "queued");
    assert.equal(store.orders.get(order1.id).id, order1.id, "reference matches the stored record");
  });

  await step("legacy cash-on-delivery API request is rejected without creating an order", async () => {
    const before = store.orders.size;
    const r = await placeOrder({ paymentMethod: "cod" });
    assert.equal(r.status, 400);
    assert.equal(store.orders.size, before);
  });

  await step("checkout lists card before points and has no legacy payment choice", async () => {
    const html = require("fs").readFileSync(require("path").join(__dirname, "../public/index.html"), "utf8");
    const options = [...html.matchAll(/name="payMethod" value="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(options, ["card", "points"]);
  });

  await step("points-only order is confirmed only after points are deducted", async () => {
    testPointsBalance = 1000;
    const r = await placeOrder({ paymentMethod: "points", pointsToUse: 1000 });
    assert.equal(r.status, 201);
    assert.equal(r.json.order.paymentMethod, "points");
    assert.equal(r.json.order.status, "pending");
    assert.equal(r.json.order.amountDue, 0);
    assert.equal(r.json.order.pointsDeducted, true);
  });

  await step("points debit failure does not create a confirmed order", async () => {
    testPointsBalance = 1000;
    testPointDebitFailure = true;
    const before = store.orders.size;
    const r = await placeOrder({ paymentMethod: "points", pointsToUse: 1000 });
    assert.equal(r.status, 409);
    assert.equal(store.orders.size, before);
    testPointDebitFailure = false;
  });

  await step("customer with no usable mobile number: order still succeeds, SMS recorded as skipped", async () => {
    const before = twilio.calls.length;
    const r = await placeOrder({ phone: "0207 946 0958" });
    assert.equal(r.status, 201);
    await sleep(80);
    assert.equal(twilio.calls.length, before);
    assert.equal(smsFor(r.json.order.id, "order_placed")[0].status, "skipped");
  });

  let failedOrder, failedRow;
  await step("provider outage: order still created (201); failure recorded; admin sees it", async () => {
    twilio.mode = "fail";
    const r = await placeOrder();
    assert.equal(r.status, 201, "SMS failure must never fail the order");
    failedOrder = r.json.order;
    await sleep(80);
    failedRow = smsFor(failedOrder.id, "order_placed")[0];
    assert.equal(failedRow.status, "failed");
    assert.ok(!/7739|320205/.test(failedRow.error_message), "no phone number stored in the error");
    twilio.mode = "ok";
    const list = await http("GET", "/api/admin/sms-notifications", admin);
    assert.equal(list.status, 200);
    assert.equal(list.json.configured, true);
    const entry = list.json.notifications.find(n => n.id === failedRow.id);
    assert.equal(entry.status, "failed");
    assert.equal(entry.retryable, true);
    assert.ok(!/7739|320205|api\.twilio|twilio-test-token/.test(list.text), "admin API leaks no phone number or secret");
  });

  await step("admin retry: sends once; a second retry cannot send a duplicate", async () => {
    const before = twilio.calls.length;
    const r1 = await http("POST", `/api/admin/sms-notifications/${failedRow.id}/retry`, admin);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.notification.status, "queued");
    assert.equal(r1.json.notification.attempts, 2);
    const r2 = await http("POST", `/api/admin/sms-notifications/${failedRow.id}/retry`, admin);
    assert.equal(r2.status, 409);
    assert.equal(twilio.calls.length, before + 1);
  });

  await step("admin status changes send SMS only for genuine changes to processing/shipped/delivered/cancelled", async () => {
    const setStatus = s => http("PUT", `/api/orders/${order1.id}/status`, { ...admin, body: { status: s } });
    const base = twilio.calls.length;
    assert.equal((await setStatus("bogus")).status, 400);
    assert.equal((await setStatus("processing")).status, 200); await sleep(80);
    assert.equal(twilio.calls.length, base + 1);
    assert.match(twilio.calls.at(-1).params.get("Body"), /is now being processed/);
    assert.equal((await setStatus("processing")).status, 200); await sleep(80);   // same status again
    assert.equal(twilio.calls.length, base + 1, "re-saving the same status sends nothing");
    assert.equal((await setStatus("shipped")).status, 200); await sleep(80);
    assert.match(twilio.calls.at(-1).params.get("Body"), /is on the way/);
    assert.equal((await setStatus("pending")).status, 200); await sleep(80);
    assert.equal(twilio.calls.length, base + 2, "'pending' has no SMS");
    assert.equal((await setStatus("shipped")).status, 200); await sleep(80);
    assert.equal(twilio.calls.length, base + 2, "same event is never re-sent for the same order");
    assert.equal((await setStatus("delivered")).status, 200); await sleep(80);
    assert.match(twilio.calls.at(-1).params.get("Body"), /successfully delivered/);
    assert.deepEqual(rewardsCalls.at(-1), ["award", order1.id], "existing rewards-on-delivery behaviour untouched");
    assert.equal(twilio.calls.length, base + 3);
    assert.equal(twilioBodiesFor(order1.id).length, 4, "received, processing, dispatched, delivered");
  });

  await step("cancelled order: customer is told", async () => {
    const base = twilio.calls.length;
    assert.equal((await http("PUT", `/api/orders/${failedOrder.id}/status`, { ...admin, body: { status: "cancelled" } })).status, 200);
    await sleep(80);
    assert.equal(twilio.calls.length, base + 1);
    assert.match(twilio.calls.at(-1).params.get("Body"), /has been cancelled\. Please contact our support team/);
  });

  await step("delivery reports: valid signature updates status; bad signature rejected; late 'sent' cannot overwrite 'delivered'", async () => {
    const row = smsFor(order1.id, "order_placed")[0];
    const url = PUBLIC_URL + "/api/sms/twilio-status";
    const post = (params, sig) => http("POST", "/api/sms/twilio-status", { raw: new URLSearchParams(params).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig } });
    const delivered = { MessageSid: row.provider_message_id, MessageStatus: "delivered", To: "+447739320205" };
    assert.equal((await post(delivered, "forged")).status, 403);
    assert.equal(row.status, "queued");
    assert.equal((await post(delivered, twilioSig(url, delivered))).status, 204);
    assert.equal(row.status, "delivered");
    const late = { ...delivered, MessageStatus: "sent" };
    assert.equal((await post(late, twilioSig(url, late))).status, 204);
    assert.equal(row.status, "delivered");
  });

  let cardOrder;
  await step("card order: 'received' SMS now; payment SMS only after Stripe-verified payment; webhook + return-page overlap sends it once", async () => {
    const base = twilio.calls.length;
    const r = await placeOrder({ paymentMethod: "card" });
    assert.equal(r.status, 201);
    assert.ok(r.json.checkoutUrl);
    cardOrder = r.json.order;
    await sleep(80);
    assert.equal(store.orders.get(cardOrder.id).status, "awaiting_payment");
    assert.equal(twilio.calls.length, base + 1);
    assert.match(twilio.calls.at(-1).params.get("Body"), /successfully received/);
    assert.equal(smsFor(cardOrder.id, "payment_confirmed").length, 0, "no payment SMS from a mere redirect");

    const sessionId = [...stripeSessions.entries()].find(([, oid]) => oid === cardOrder.id)[0];
    const confirm = (who) => http("POST", `/api/orders/${cardOrder.id}/confirm-card-payment`, { ...who, body: { sessionId } });
    assert.equal((await confirm(other)).status, 403, "another customer cannot confirm/see this order");
    assert.equal((await confirm(user)).status, 200); await sleep(80);
    assert.equal(store.orders.get(cardOrder.id).status, "pending");
    assert.equal(smsFor(cardOrder.id, "payment_confirmed").length, 1);

    // Stripe's webhook for the same payment arrives afterwards (and is retried)
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: sessionId, object: "checkout.session", payment_status: "paid", metadata: { orderId: cardOrder.id } } } });
    const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const hook = h => http("POST", "/api/stripe-webhook", { raw: payload, headers: { "Content-Type": "application/json", "Stripe-Signature": h } });
    assert.equal((await hook(header)).status, 200);
    assert.equal((await hook(header)).status, 200); await sleep(80);
    assert.equal(smsFor(cardOrder.id, "payment_confirmed").length, 1);
    assert.equal(twilioBodiesFor(cardOrder.id).filter(b => /Payment for order/.test(b)).length, 1, "customer got exactly one payment text");
    assert.equal((await confirm(user)).status, 200); await sleep(80);
    assert.equal(twilioBodiesFor(cardOrder.id).filter(b => /Payment for order/.test(b)).length, 1, "refreshing the success page resends nothing");
  });

  await step("Stripe webhook: forged signature rejected (400); database outage answers 5xx so Stripe retries", async () => {
    const order = store.orders.get(cardOrder.id);
    order.status = "awaiting_payment";
    const payload = JSON.stringify({ id: "evt_2", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_x", object: "checkout.session", payment_status: "paid", metadata: { orderId: cardOrder.id } } } });
    const good = realStripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const send = h => http("POST", "/api/stripe-webhook", { raw: payload, headers: { "Content-Type": "application/json", "Stripe-Signature": h } });
    assert.equal((await send("t=1,v1=deadbeef")).status, 400);
    store.breakOrderReads = true;
    assert.equal((await send(good)).status, 500);
    store.breakOrderReads = false;
    assert.equal(order.status, "awaiting_payment", "nothing half-applied");
    order.status = "pending";
  });

  await step("paid-but-cancelled order: customer is not told 'payment confirmed', nothing is sent, admin is warned in logs", async () => {
    const r = await placeOrder({ paymentMethod: "card" });
    const id = r.json.order.id;
    await sleep(80);
    store.orders.get(id).status = "cancelled";
    const sessionId = [...stripeSessions.entries()].find(([, oid]) => oid === id)[0];
    const base = twilio.calls.length;
    const c = await http("POST", `/api/orders/${id}/confirm-card-payment`, { ...user, body: { sessionId } });
    assert.equal(c.status, 409);
    await sleep(80);
    assert.equal(twilio.calls.length, base);
    assert.equal(store.orders.get(id).status, "cancelled");
    assert.ok(serverLogs.some(l => l.includes("CRITICAL") && l.includes("CANCELLED")));
  });

  await step("order privacy: customers only ever list their own orders", async () => {
    const mine = await http("GET", "/api/orders/mine", user);
    const theirs = await http("GET", "/api/orders/mine", other);
    assert.ok(mine.json.orders.length >= 3);
    assert.equal(theirs.json.orders.length, 0);
    assert.equal((await http("GET", "/api/orders", user)).status, 401, "customers cannot use the admin order list");
    assert.equal((await http("PUT", `/api/orders/${order1.id}/status`, { ...user, body: { status: "cancelled" } })).status, 401);
  });

  await step("customer order details are account-scoped and reflect the current saved status", async () => {
    const own = await http("GET", `/api/orders/${order1.id}`, user);
    assert.equal(own.status, 200);
    assert.equal(own.json.order.id, order1.id);
    assert.equal(own.json.order.status, store.orders.get(order1.id).status);
    assert.equal(own.json.order.items[0].name, store.orders.get(order1.id).items[0].name);
    assert.equal((await http("GET", `/api/orders/${order1.id}`, other)).status, 404);
    assert.equal((await http("GET", `/api/orders/${order1.id}`)).status, 401);
  });

  await step("input hardening: address is sanitised, quantity capped, bad bodies rejected", async () => {
    const r = await placeOrder({
      items: [{ productId: 1, qty: 5000 }],
      address: { line1: "  " + "x".repeat(500) + "  ", city: "London", postcode: "E1 6AN", evil: { $gt: "" }, __proto__: { polluted: true }, line2: 42 }
    });
    assert.equal(r.status, 201);
    const stored = store.orders.get(r.json.order.id);
    assert.deepEqual(Object.keys(stored.address).sort(), ["city", "line1", "postcode"]);
    assert.equal(stored.address.line1.length, 200);
    assert.equal(r.json.order.subtotal, 990, "qty capped at 99");
    assert.equal((await placeOrder({ address: { line1: "x", city: 5, postcode: "y" } })).status, 400);
    assert.equal((await placeOrder({ items: Array.from({ length: 101 }, () => ({ productId: 1, qty: 1 })) })).status, 400);
    assert.equal((await http("POST", "/api/auth/login", { body: { email: { $ne: "" }, password: { $ne: "" } } })).status, 400);
    assert.equal((await http("POST", "/api/auth/register", { body: { name: "A", email: "not-an-email", password: "longenough1" } })).status, 400);
  });

  await step("sold-out products are blocked at the catalogue, checkout and transaction lock, then restored", async () => {
    const historical = [...store.orders.values()][0];
    const before = store.orders.size;
    const sold = await http("PATCH", "/api/admin/products/1/availability", { ...admin, body:{available:false} });
    assert.equal(sold.status, 200); assert.equal(sold.json.available,false);
    assert.equal((await http("PATCH", "/api/admin/products/1/availability", { ...user, body:{available:true} })).status,401);
    const catalog = await http("GET", "/api/products"); assert.equal(catalog.status,200); assert.equal(catalog.json.products[0].available,false);
    const refused = await placeOrder(); assert.equal(refused.status,409); assert.match(refused.json.error,/Rice is sold out/); assert.equal(store.orders.size,before);
    store.productAvailable=true; store.sellOutAtLock=true;
    const raced = await placeOrder(); assert.equal(raced.status,409); assert.equal(store.orders.size,before,"a status change before the locked insert prevents the order");
    const restored = await http("PATCH", "/api/admin/products/1/availability", { ...admin, body:{available:true} });
    assert.equal(restored.status,200); assert.equal((await http("GET", "/api/products")).json.products[0].available,true);
    const purchased = await placeOrder(); assert.equal(purchased.status,201); assert.equal(store.orders.size,before+1);
    assert.equal(store.orders.get(historical.id).id,historical.id,"historical orders stay intact");
  });

  await step(`customer session cookie is ${PRODUCTION ? "Secure + HttpOnly" : "HttpOnly"} (NODE_ENV=${process.env.NODE_ENV})`, async () => {
    const r = await http("POST", "/api/auth/login", { body: { email: "c@example.com", password: "password123" } });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.equal(/;\s*Secure/i.test(cookie), PRODUCTION);
  });

  await step(`forgot-password ${PRODUCTION ? "never returns a reset link in production" : "keeps the dev-only link outside production"}`, async () => {
    const r = await http("POST", "/api/auth/forgot-password", { body: { email: "c@example.com" } });
    assert.equal(r.status, 200);
    assert.equal(!!r.json.devResetUrl, !PRODUCTION);
  });

  await step("rate limiting: repeated bad logins are throttled (429); contact form too", async () => {
    let last;
    for (let i = 0; i < 35; i++) last = await http("POST", "/api/auth/login", { body: { email: "c@example.com", password: "wrong-password" } });
    assert.equal(last.status, 429);
    let c;
    for (let i = 0; i < 10; i++) c = await http("POST", "/api/contact", { body: { name: "A", email: "bad", subject: "s", message: "m" } });
    assert.equal(c.status, 429);
  });

  await step("server logs never contain a customer phone number or SMS text", async () => {
    const all = serverLogs.join("\n");
    assert.ok(!/7739320205|07739|7739 320205|0207 946|7946 0958/.test(all), "phone number found in server logs");
    assert.ok(!all.includes("Thank you for shopping with us!"), "SMS text found in server logs");
    assert.ok(!all.includes("twilio-test-token"), "secret found in server logs");
  });

  out(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { out("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
