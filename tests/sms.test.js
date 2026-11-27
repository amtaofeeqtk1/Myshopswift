"use strict";

// Dependency-free tests for sms.js. Run: node --test tests/sms.test.js
// No network access or real SMS credentials are needed — the provider is a fake.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const sms = require("../sms");

// A syntactically valid (made-up) Messaging Service SID: "MG" + 32 hex characters.
const SERVICE_SID = "MG" + "0123456789abcdef0123456789abcdef";
const ORDER_ID = "a1b2c3d4-0000-4000-8000-123456789abc";

test("normalisePhone: UK numbers in the formats customers actually type", () => {
  assert.equal(sms.normalisePhone("07739 320205"), "+447739320205");
  assert.equal(sms.normalisePhone("07739320205"), "+447739320205");
  assert.equal(sms.normalisePhone("+44 7739 320205"), "+447739320205");
  assert.equal(sms.normalisePhone("+44 (0)7739 320205"), "+447739320205");
  assert.equal(sms.normalisePhone("0044 7739 320205"), "+447739320205");
  assert.equal(sms.normalisePhone("447739320205"), "+447739320205");
  assert.equal(sms.normalisePhone("(07739) 320-205"), "+447739320205");
});

test("normalisePhone: rejects things we cannot text", () => {
  assert.equal(sms.normalisePhone(""), null);
  assert.equal(sms.normalisePhone(null), null);
  assert.equal(sms.normalisePhone(undefined), null);
  assert.equal(sms.normalisePhone(7739320205), null);
  assert.equal(sms.normalisePhone("abc"), null);
  assert.equal(sms.normalisePhone("0123456"), null);
  assert.equal(sms.normalisePhone("020 7946 0958"), null);      // UK landline
  assert.equal(sms.normalisePhone("+44 20 7946 0958"), null);   // UK landline, international
  assert.equal(sms.normalisePhone("07739 3202"), null);         // too short
  assert.equal(sms.normalisePhone("07739 3202055555"), null);   // too long
  assert.equal(sms.normalisePhone("077+39320205"), null);       // stray plus
});

test("normalisePhone: non-UK numbers need an international prefix", () => {
  assert.equal(sms.normalisePhone("+234 803 123 4567"), "+2348031234567");
  assert.equal(sms.normalisePhone("00234 803 123 4567"), "+2348031234567");
  assert.equal(sms.normalisePhone("803 123 4567"), null); // no country code: ambiguous, refuse
});

test("orderRef matches the reference already shown in emails and Track Order", () => {
  assert.equal(sms.orderRef(ORDER_ID), "a1b2c3d4");
});

test("templates: every event has one, uses the reference, stays one plain SMS segment", () => {
  for (const event of ["order_placed", "payment_confirmed", "processing", "shipped", "delivered", "cancelled"]) {
    const body = sms.buildMessage(event, ORDER_ID);
    assert.ok(body, `${event} has a template`);
    assert.ok(body.startsWith("MyShopSwift: "), `${event} is branded`);
    assert.ok(body.includes("a1b2c3d4"), `${event} contains the order reference`);
    assert.ok(!body.includes("#a1b2c3d4"), `${event} omits the hash prefix`);
    assert.ok(body.length <= 160, `${event} fits one segment (${body.length})`);
    assert.ok(/^[\x20-\x7E]+$/.test(body), `${event} is plain ASCII (GSM-7 safe)`);
  }
  assert.equal(sms.buildMessage("nonsense", ORDER_ID), null);
  assert.equal(sms.buildMessage("out_for_delivery", ORDER_ID), null, "no out-for-delivery status exists in this project");
});

test("STATUS_TO_EVENT only maps statuses that should text the customer", () => {
  assert.deepEqual(Object.keys(sms.STATUS_TO_EVENT).sort(), ["cancelled", "delivered", "processing", "shipped"]);
  assert.equal(sms.STATUS_TO_EVENT.pending, undefined);
  assert.equal(sms.STATUS_TO_EVENT.awaiting_payment, undefined);
});

test("loadConfig: not configured without credentials; configured with them", () => {
  assert.equal(sms.loadConfig({}).configured, false);
  assert.equal(sms.loadConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" }).configured, false, "needs a sender");
  assert.equal(sms.loadConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "MyShopSwift" }).configured, true);
  assert.equal(sms.loadConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID }).configured, true);
  assert.equal(sms.loadConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+447700900123" }).configured, true);
  const off = sms.loadConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "MyShopSwift", SMS_ENABLED: "false" });
  assert.equal(off.configured, false, "SMS_ENABLED=false is a kill switch");
});

test("loadConfig: rejects an invalid sender and explains why", () => {
  const cfg = sms.loadConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "My Shop Swift Ltd Store" });
  assert.equal(cfg.configured, false);
  assert.equal(cfg.problems.length, 1);
});

test("loadConfig: delivery-report callback only on a public https PUBLIC_URL", () => {
  const base = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "MyShopSwift" };
  assert.equal(sms.loadConfig({ ...base, PUBLIC_URL: "http://localhost:3000" }).statusCallbackUrl, "");
  assert.equal(sms.loadConfig({ ...base, PUBLIC_URL: "https://shop.example.com/" }).statusCallbackUrl, "https://shop.example.com/api/sms/twilio-status");
});

test("validateTwilioSignature: accepts a correct signature, rejects tampering", () => {
  const token = "secret-token";
  const url = "https://shop.example.com/api/sms/twilio-status";
  const params = { MessageSid: "SM123", MessageStatus: "delivered", To: "+447739320205" };
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  const good = crypto.createHmac("sha1", token).update(data).digest("base64");

  assert.equal(sms.validateTwilioSignature(token, url, params, good), true);
  assert.equal(sms.validateTwilioSignature(token, url, { ...params, MessageStatus: "failed" }, good), false);
  assert.equal(sms.validateTwilioSignature("other-token", url, params, good), false);
  assert.equal(sms.validateTwilioSignature(token, url + "x", params, good), false);
  assert.equal(sms.validateTwilioSignature(token, url, params, ""), false);
  assert.equal(sms.validateTwilioSignature(token, url, params, undefined), false);
  assert.equal(sms.validateTwilioSignature(token, url, params, "short"), false);
});

test("mapProviderStatus", () => {
  assert.equal(sms.mapProviderStatus("queued"), "queued");
  assert.equal(sms.mapProviderStatus("accepted"), "queued");
  assert.equal(sms.mapProviderStatus("sending"), "queued");
  assert.equal(sms.mapProviderStatus("sent"), "sent");
  assert.equal(sms.mapProviderStatus("delivered"), "delivered");
  assert.equal(sms.mapProviderStatus("undelivered"), "undelivered");
  assert.equal(sms.mapProviderStatus("failed"), "failed");
  assert.equal(sms.mapProviderStatus("something-new"), null);
});

test("redact strips phone numbers from provider text", () => {
  assert.equal(sms.redact("The 'To' number +447739320205 is not valid"), "The 'To' number [number] is not valid");
  assert.equal(sms.redact("Invalid number 07739 320205."), "Invalid number [number].");
});

// ---- sendSms with a fake provider ----

const CONFIG = sms.loadConfig({
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "MyShopSwift",
  PUBLIC_URL: "https://shop.example.com"
});

test("sendSms: posts the right request and reports success", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 201, json: async () => ({ sid: "SM999", status: "queued" }) };
  };
  const r = await sms.sendSms({ to: "+447739320205", body: "hi", config: CONFIG, fetchImpl });
  assert.deepEqual(r, { ok: true, providerMessageId: "SM999", status: "queued" });
  assert.equal(seen.url, "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Basic " + Buffer.from("ACtest:tok").toString("base64"));
  const sent = new URLSearchParams(seen.init.body);
  assert.equal(sent.get("To"), "+447739320205");
  assert.equal(sent.get("From"), "MyShopSwift");
  assert.equal(sent.get("Body"), "hi");
  assert.equal(sent.get("StatusCallback"), "https://shop.example.com/api/sms/twilio-status");
});

test("sendSms: provider error is returned (and redacted), not thrown", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ code: 21211, message: "The 'To' number +447739320205 is not a valid phone number." }) });
  const r = await sms.sendSms({ to: "+447739320205", body: "hi", config: CONFIG, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "21211");
  assert.ok(!r.errorMessage.includes("7739"), "phone number must not survive in the stored error");
});

test("sendSms: network failure and timeout are returned, not thrown", async () => {
  const r1 = await sms.sendSms({ to: "+447739320205", body: "hi", config: CONFIG, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(r1.ok, false);
  assert.equal(r1.errorCode, "network");

  const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r2 = await sms.sendSms({ to: "+447739320205", body: "hi", config: CONFIG, fetchImpl: slow, timeoutMs: 20 });
  assert.equal(r2.ok, false);
  assert.equal(r2.errorCode, "timeout");
  assert.match(r2.errorMessage, /check the provider console before retrying/);
});

test("sendSms: refuses to call the provider when SMS isn't configured", async () => {
  let called = false;
  const r = await sms.sendSms({ to: "+447739320205", body: "hi", config: sms.loadConfig({}), fetchImpl: async () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});


// ---- TWILIO_MESSAGING_SERVICE_SID handling (Twilio error 21705) ----

const BASE_ENV = { TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32), TWILIO_AUTH_TOKEN: "tok" };

test("Messaging Service SID: a valid MG SID is read from TWILIO_MESSAGING_SERVICE_SID and used as the only sender", () => {
  const cfg = sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID, SMS_ENABLED: "true" });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.messagingServiceSid, SERVICE_SID);
  assert.deepEqual(cfg.problems, []);
});

test("Messaging Service SID: sent as MessagingServiceSid and never together with From, even if TWILIO_FROM is also set", async () => {
  const cfg = sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID, TWILIO_FROM: "MyShopSwift" });
  let sent;
  await sms.sendSms({ to: "+447739320205", body: "hi", config: cfg, fetchImpl: async (u, init) => { sent = new URLSearchParams(init.body); return { ok: true, status: 201, json: async () => ({ sid: "SM1", status: "queued" }) }; } });
  assert.equal(sent.get("MessagingServiceSid"), SERVICE_SID);
  assert.equal(sent.has("From"), false, "From must not be sent alongside MessagingServiceSid");
  assert.equal(sent.get("To"), "+447739320205");
});

test("Messaging Service SID: wrapping quotes, whitespace, newlines, BOM and zero-width characters pasted into the env var are removed", () => {
  const variants = [`"${SERVICE_SID}"`, `'${SERVICE_SID}'`, `  ${SERVICE_SID}  `, `${SERVICE_SID}\n`, `\uFEFF${SERVICE_SID}`, `${SERVICE_SID}\u200B`, `\u00A0${SERVICE_SID}\u00A0`, `\u201C${SERVICE_SID}\u201D`, ` "${SERVICE_SID}" `];
  for (const v of variants) {
    const cfg = sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: v });
    assert.equal(cfg.messagingServiceSid, SERVICE_SID, JSON.stringify(v));
    assert.equal(cfg.configured, true, JSON.stringify(v));
  }
});

test("Messaging Service SID: anything that is not MG + 32 hex turns SMS off with a precise reason (instead of failing every send with 21705)", () => {
  const bad = [
    "MG" + "0123456789abcdef0123456789abcde",        // one character short
    "MG" + "0123456789abcdef0123456789abcdef0",      // one too long
    "MG" + "0123456789abcdef0123456789abcdeg",       // non-hex character
    "mg" + "0123456789abcdef0123456789abcdef",       // lower-case prefix is not a valid SID
    "AC" + "0123456789abcdef0123456789abcdef",       // an Account SID
    "AI" + "0123456789abcdef0123456789abcdef",       // a sender-ID SID
    "MyShopSwift",                                   // the sender ID text or service name
    "MG 0123456789abcdef0123456789abcdef"            // internal space
  ];
  for (const v of bad) {
    const cfg = sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: v });
    assert.equal(cfg.configured, false, v);
    assert.equal(cfg.problems.length, 1, v);
    assert.match(cfg.problems[0], /TWILIO_MESSAGING_SERVICE_SID is not a valid Messaging Service SID/);
    assert.ok(cfg.problems[0].includes(`${v.length} characters`), "reports the length");
    assert.ok(!cfg.problems[0].includes(v.slice(2)), "never prints the value itself");
  }
  assert.match(sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: "AC" + "0".repeat(32) }).problems[0], /looks like an Account SID/);
  assert.match(sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: "AI" + "0".repeat(32) }).problems[0], /Sender ID SID/);
});

test("Messaging Service SID: an invalid SID is NOT silently replaced by TWILIO_FROM (no surprise sender)", async () => {
  const cfg = sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: "not-a-sid", TWILIO_FROM: "MyShopSwift" });
  assert.equal(cfg.configured, false);
  let called = false;
  const r = await sms.sendSms({ to: "+447739320205", body: "hi", config: cfg, fetchImpl: async () => { called = true; } });
  assert.equal(r.ok, false); assert.equal(called, false, "nothing is sent to Twilio with a bad SID");
});

test("Without a Messaging Service SID, TWILIO_FROM still works exactly as before", () => {
  assert.equal(sms.loadConfig({ ...BASE_ENV, TWILIO_FROM: "MyShopSwift" }).configured, true);
  assert.equal(sms.loadConfig({ ...BASE_ENV, TWILIO_FROM: "+447700900123" }).configured, true);
});

test("Twilio error 21705 / 20003 get a message that names the setting to fix; other errors are untouched", async () => {
  const cfg = sms.loadConfig({ ...BASE_ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID });
  const fail = (code, message) => async () => ({ ok: false, status: 400, json: async () => ({ code, message }) });
  const a = await sms.sendSms({ to: "+447739320205", body: "hi", config: cfg, fetchImpl: fail(21705, "The Messaging Service is invalid") });
  assert.equal(a.errorCode, "21705"); assert.match(a.errorMessage, /TWILIO_MESSAGING_SERVICE_SID/); assert.match(a.errorMessage, /MG/);
  const b = await sms.sendSms({ to: "+447739320205", body: "hi", config: cfg, fetchImpl: fail(20003, "Authenticate") });
  assert.match(b.errorMessage, /TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
  const c = await sms.sendSms({ to: "+447739320205", body: "hi", config: cfg, fetchImpl: fail(21211, "Invalid 'To' number +447739320205") });
  assert.ok(!c.errorMessage.includes("7739"), "phone numbers are still redacted");
  assert.match(c.errorMessage, /Invalid 'To' number/);
});
