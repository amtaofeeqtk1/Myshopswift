"use strict";

// Dependency-free tests for order-sms.js. Run: node --test tests/order-sms.test.js
// The database is a small in-memory fake that understands exactly the SQL
// order-sms.js issues, and the SMS provider is a fake — no network, no credentials.
//
// NOTE: this proves the application logic. The SQL itself (ON CONFLICT, the
// status-rank CASE) has to be exercised against a real PostgreSQL — see the
// "staging checklist" in the README.

const test = require("node:test");
const assert = require("node:assert/strict");
const sms = require("../sms");
const createOrderSms = require("../order-sms");
const { handleSmsQuery } = require("./helpers/fake-sms-db");

const ORDER_ID = "a1b2c3d4-0000-4000-8000-123456789abc";
const PHONE_RAW = "07739 320205";

const CONFIG = sms.loadConfig({
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "MyShopSwift",
  PUBLIC_URL: "https://shop.example.com"
});

function makeFakeDb() {
  const rows = [];
  const db = {
    rows,
    failNext: false,
    async query(sql, params = []) {
      if (db.failNext) throw new Error("database is down");
      const result = handleSmsQuery(rows, sql, params);
      if (result === undefined) throw new Error("fake db: unexpected SQL: " + sql.replace(/\s+/g, " ").trim().slice(0, 80));
      return result;
    }
  };
  return db;
}

function setup({ config = CONFIG, providerResult, order } = {}) {
  const db = makeFakeDb();
  const calls = [];
  let sidCounter = 0;
  const sendSms = async args => {
    calls.push(args);
    if (typeof providerResult === "function") return providerResult(args, calls.length);
    return providerResult || { ok: true, providerMessageId: "SM" + (++sidCounter), status: "queued" };
  };
  const logs = [];
  const logger = {
    log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" "))
  };
  const currentOrder = { id: ORDER_ID, phone: PHONE_RAW, status: "pending", ...order };
  const svc = createOrderSms({ db, getOrderById: async id => (id === currentOrder.id ? { ...currentOrder } : null), config, sendSms, logger });
  return { svc, db, calls, logs, order: currentOrder };
}

test("not configured: nothing is recorded or sent, and nothing throws", async () => {
  const { svc, db, calls } = setup({ config: sms.loadConfig({}) });
  const r = await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  assert.equal(r.sent, false);
  assert.equal(r.reason, "not_configured");
  assert.equal(calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test("sends once to the normalised checkout number with the right text", async () => {
  const { svc, db, calls } = setup();
  const r = await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "+447739320205");
  assert.equal(calls[0].body, "MyShopSwift: Your order a1b2c3d4 has been successfully received. Thank you for shopping with us!");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "queued");
  assert.equal(db.rows[0].provider_message_id, "SM1");
  assert.equal(db.rows[0].attempts, 1);
});

test("duplicate event (webhook retry, refresh, double click) never sends twice", async () => {
  const { svc, db, calls } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "payment_confirmed");
  const again = await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "payment_confirmed");
  assert.equal(again.reason, "duplicate");
  assert.equal(calls.length, 1);
  assert.equal(db.rows.length, 1);
});

test("racing callers for the same event: exactly one send", async () => {
  const { svc, calls } = setup();
  await Promise.all(Array.from({ length: 8 }, () => svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "shipped")));
  assert.equal(calls.length, 1);
});

test("different events for the same order are independent", async () => {
  const { svc, calls } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "payment_confirmed");
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "shipped");
  assert.equal(calls.length, 3);
});

test("no usable phone number: recorded as skipped, never sent, not retryable", async () => {
  const { svc, db, calls } = setup();
  const r = await svc.notify({ id: ORDER_ID, phone: "020 7946 0958" }, "order_placed");
  assert.equal(r.reason, "invalid_phone");
  assert.equal(calls.length, 0);
  assert.equal(db.rows[0].status, "skipped");
  const listed = await svc.list();
  assert.equal(listed[0].retryable, false);
});

test("provider failure is recorded and does not throw", async () => {
  const { svc, db } = setup({ providerResult: { ok: false, errorCode: "21608", errorMessage: "Unverified number" } });
  const r = await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  assert.equal(r.sent, false);
  assert.equal(db.rows[0].status, "failed");
  assert.equal(db.rows[0].error_code, "21608");
  assert.equal((await svc.list())[0].retryable, true);
});

test("a throwing provider never escapes notify()", async () => {
  const { svc } = setup({ providerResult: () => { throw new Error("boom"); } });
  await assert.doesNotReject(() => svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed"));
});

test("a broken database never escapes notify() (order flow is unaffected)", async () => {
  const { svc, db, calls } = setup();
  db.failNext = true;
  const r = await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  assert.equal(r.sent, false);
  assert.equal(r.reason, "error");
  assert.equal(calls.length, 0, "must not send an SMS it could not record");
});

test("unknown events and missing order are ignored safely", async () => {
  const { svc, calls } = setup();
  assert.equal((await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "pending")).reason, "unknown_event");
  assert.equal((await svc.notify(null, "shipped")).reason, "unknown_event");
  assert.equal(calls.length, 0);
});

test("logs never contain the phone number or message text", async () => {
  const { svc, logs } = setup({ providerResult: { ok: false, errorCode: "21211", errorMessage: sms.redact("bad number +447739320205") } });
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  await svc.notify({ id: "ffffffff-0000-4000-8000-000000000000", phone: "020 7946 0958" }, "order_placed");
  const all = logs.join("\n");
  assert.ok(logs.length > 0);
  assert.ok(!/7739|320205|7946|0958/.test(all), "no phone digits in logs");
  assert.ok(!all.includes("Thank you for shopping"), "no message text in logs");
  assert.ok(all.includes("a1b2c3d4"), "order reference is logged");
});

// ---- retry ----

test("retry: re-sends a failed message once, and only once", async () => {
  let n = 0;
  const { svc, db, calls } = setup({ providerResult: () => (++n === 1 ? { ok: false, errorCode: "30008", errorMessage: "Unknown error" } : { ok: true, providerMessageId: "SMretry", status: "queued" }) });
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  const id = db.rows[0].id;

  const r1 = await svc.retry(id);
  assert.equal(r1.status, 200);
  assert.equal(r1.notification.status, "queued");
  assert.equal(r1.notification.attempts, 2);
  assert.equal(calls.length, 2);

  const r2 = await svc.retry(id); // already queued/sent: must NOT send again
  assert.equal(r2.status, 409);
  assert.equal(calls.length, 2);
});

test("retry: simultaneous clicks cannot both send", async () => {
  let n = 0;
  const { svc, db, calls } = setup({ providerResult: () => (++n === 1 ? { ok: false, errorCode: "30008", errorMessage: "x" } : { ok: true, providerMessageId: "SMr" + n, status: "queued" }) });
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  const id = db.rows[0].id;
  const results = await Promise.all([svc.retry(id), svc.retry(id), svc.retry(id)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(calls.length, 2, "original attempt + exactly one retry");
});

test("retry: refuses delivered / sent / in-flight messages", async () => {
  const { svc, db, calls } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  const id = db.rows[0].id;
  for (const status of ["sending", "queued", "sent", "delivered", "skipped"]) {
    db.rows[0].status = status;
    const r = await svc.retry(id);
    assert.equal(r.status, 409, status);
  }
  assert.equal(calls.length, 1);
});

test("retry: a stale status message is not sent after the order moved on", async () => {
  const { svc, db, calls, order } = setup({ providerResult: { ok: false, errorCode: "30008", errorMessage: "x" }, order: { status: "shipped" } });
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "shipped");
  order.status = "delivered"; // order progressed after the failed "dispatched" text
  const r = await svc.retry(db.rows[0].id);
  assert.equal(r.status, 409);
  assert.match(r.error, /no longer relevant/);
  assert.equal(calls.length, 1);
});

test("retry: unknown id, missing order and unconfigured SMS", async () => {
  const { svc, db } = setup({ providerResult: { ok: false, errorCode: "x", errorMessage: "x" } });
  assert.equal((await svc.retry("nope")).status, 404);
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  db.rows[0].order_id = "deleted-order";
  assert.equal((await svc.retry(db.rows[0].id)).status, 404);

  const off = setup({ config: sms.loadConfig({}) });
  assert.equal((await off.svc.retry("x")).status, 400);
});

// ---- delivery reports ----

test("delivery reports move a message forward and never backwards", async () => {
  const { svc, db } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  const sid = db.rows[0].provider_message_id;

  assert.equal(await svc.handleStatusCallback({ MessageSid: sid, MessageStatus: "sent" }), 1);
  assert.equal(db.rows[0].status, "sent");
  assert.equal(await svc.handleStatusCallback({ MessageSid: sid, MessageStatus: "delivered" }), 1);
  assert.equal(db.rows[0].status, "delivered");
  assert.equal(await svc.handleStatusCallback({ MessageSid: sid, MessageStatus: "sent" }), 0, "late 'sent' must not overwrite 'delivered'");
  assert.equal(db.rows[0].status, "delivered");
});

test("undelivered report is flagged, retryable, and carries the error code", async () => {
  const { svc, db } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "shipped");
  await svc.handleStatusCallback({ MessageSid: db.rows[0].provider_message_id, MessageStatus: "undelivered", ErrorCode: "30003" });
  const [row] = await svc.list();
  assert.equal(row.status, "undelivered");
  assert.equal(row.errorCode, "30003");
  assert.equal(row.retryable, true);
});

test("delivery reports for unknown ids or statuses are ignored", async () => {
  const { svc } = setup();
  assert.equal(await svc.handleStatusCallback({ MessageSid: "SMunknown", MessageStatus: "delivered" }), 0);
  assert.equal(await svc.handleStatusCallback({ MessageSid: "SM1", MessageStatus: "weird" }), 0);
  assert.equal(await svc.handleStatusCallback({}), 0);
});

test("admin list never exposes provider ids or phone numbers", async () => {
  const { svc } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  const json = JSON.stringify(await svc.list());
  assert.ok(!json.includes("SM1"));
  assert.ok(!/7739|320205/.test(json));
});

test("info() reports configuration state without any secret", () => {
  const { svc } = setup();
  const info = svc.info();
  assert.equal(info.configured, true);
  assert.equal(info.deliveryReports, true);
  assert.ok(!JSON.stringify(info).includes("tok"));
});

test("a message stuck on 'sending' becomes retryable only once it is stale", async () => {
  const { svc, db, calls } = setup();
  await svc.notify({ id: ORDER_ID, phone: PHONE_RAW }, "order_placed");
  const row = db.rows[0];
  row.status = "sending"; row.updated_at = new Date();
  assert.equal((await svc.list())[0].retryable, false);
  assert.equal((await svc.retry(row.id)).status, 409);
  row.updated_at = new Date(Date.now() - 11 * 60 * 1000);
  assert.equal((await svc.list())[0].retryable, true);
  assert.equal((await svc.retry(row.id)).status, 200);
  assert.equal(calls.length, 2);
});
