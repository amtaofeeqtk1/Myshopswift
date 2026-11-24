// MyShopSwift — SMS delivery (provider layer)
//
// Pure helpers + a thin Twilio client. Nothing in here touches the database
// (see order-sms.js for that) and nothing here is ever sent to the browser.
//
// Why Twilio: it has a plain HTTPS REST API (called with Node's built-in
// fetch, so no new npm dependency), supports UK mobile delivery, accepts an
// alphanumeric sender ID such as "MyShopSwift" for UK destinations without
// pre-registration, and posts signed delivery-status callbacks we can show
// in the admin dashboard.
//
// Credentials live only in environment variables:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//   TWILIO_FROM  (alphanumeric sender ID or E.164 number)   -- or --
//   TWILIO_MESSAGING_SERVICE_SID  ("MG" + 32 hex characters; if set it is the
//                                  only sender sent to Twilio and TWILIO_FROM is ignored)
//   SMS_ENABLED=false  (optional kill switch)
// If they are missing, SMS is simply switched off and everything else in the
// app behaves exactly as before.

const crypto = require("crypto");

// ---------- configuration ----------

const ALPHANUMERIC_SENDER = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{3,11}$/; // 3-11 chars, at least one letter
const E164 = /^\+[1-9]\d{7,14}$/;
// Twilio's documented formats. A Messaging Service SID that doesn't match
// ^MG[0-9a-fA-F]{32}$ is rejected by Twilio with error 21705.
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;

// Environment values often arrive with things that aren't part of the value:
// wrapping quotes ("MG…" pasted from a .env line), a BOM, zero-width or
// non-breaking spaces from copy-paste, stray newlines. Remove those — nothing else.
function cleanEnvValue(raw) {
  let v = String(raw == null ? "" : raw).replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  const pairs = { '"': '"', "'": "'", "`": "`", "\u201C": "\u201D", "\u2018": "\u2019" };
  if (v.length >= 2 && pairs[v[0]] === v[v.length - 1]) v = v.slice(1, -1).trim();
  return v;
}

// Says what a wrongly-pasted SID most likely is, by its Twilio prefix. Only the
// first two characters and the length are ever reported, never the whole value.
function describeBadServiceSid(value) {
  const prefix = value.slice(0, 2).toUpperCase();
  const kinds = {
    AC: "an Account SID",
    SK: "an API Key SID",
    PN: "a phone number SID",
    SM: "a message SID",
    MM: "a message SID",
    AI: "an alphanumeric Sender ID SID",
    QU: "a Messaging Service campaign/queue SID"
  };
  const what = kinds[prefix] ? ` It starts with "${prefix}", which looks like ${kinds[prefix]}.` : ` It starts with "${value.slice(0, 2)}".`;
  return `TWILIO_MESSAGING_SERVICE_SID is not a valid Messaging Service SID: it must be "MG" followed by 32 letters/digits (34 characters in total), but the value set is ${value.length} characters long.${what} Copy the SID from Twilio Console > Messaging > Services (the service itself, not its sender).`;
}

function loadConfig(env = process.env) {
  const accountSid = cleanEnvValue(env.TWILIO_ACCOUNT_SID);
  const authToken = cleanEnvValue(env.TWILIO_AUTH_TOKEN);
  const messagingServiceSid = cleanEnvValue(env.TWILIO_MESSAGING_SERVICE_SID);
  const from = cleanEnvValue(env.TWILIO_FROM);
  const enabled = String(env.SMS_ENABLED || "true").trim().toLowerCase() !== "false";
  const publicUrl = (env.PUBLIC_URL || "").trim().replace(/\/+$/, "");

  const problems = [];
  // A Messaging Service SID, when set, is the ONLY sender sent to Twilio
  // (see sendSms); TWILIO_FROM is not consulted, so it can't conflict.
  let senderOk;
  if (messagingServiceSid) {
    senderOk = MESSAGING_SERVICE_SID.test(messagingServiceSid);
    if (!senderOk) problems.push(describeBadServiceSid(messagingServiceSid));
  } else {
    const fromOk = !!from && (ALPHANUMERIC_SENDER.test(from) || E164.test(from));
    if (from && !fromOk) problems.push("TWILIO_FROM must be an alphanumeric sender ID (3-11 characters, e.g. MyShopSwift) or an E.164 number (e.g. +447700900123)");
    senderOk = fromOk;
  }
  const hasSender = senderOk;
  const hasCredentials = !!accountSid && !!authToken;

  // Twilio can only call us back on a public HTTPS URL.
  const statusCallbackUrl = /^https:\/\//i.test(publicUrl) ? `${publicUrl}/api/sms/twilio-status` : "";

  return {
    enabled,
    configured: enabled && hasCredentials && hasSender,
    accountSid,
    authToken,
    messagingServiceSid,
    from,
    statusCallbackUrl,
    problems
  };
}

// ---------- phone numbers ----------

// Turns whatever the customer typed at checkout into E.164, or null if it
// can't be a number we can text. UK-focused: national "07…" numbers become
// +447…, and UK numbers must be mobiles (07…). Other countries are accepted
// when given with a + / 00 prefix and a plausible length; the provider has
// the final say on whether it will deliver there.
function normalisePhone(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^[0-9+\-() ]{7,20}$/.test(s)) return null;

  let digits = s.replace(/[^\d+]/g, "");
  if (digits.indexOf("+") > 0) return null; // a "+" anywhere but the start is junk
  const hadPlus = digits.startsWith("+");
  if (hadPlus) digits = digits.slice(1);
  if (digits.includes("+")) return null;

  let intl;
  if (hadPlus) intl = digits;
  else if (digits.startsWith("00")) intl = digits.slice(2);
  else if (digits.startsWith("0")) intl = "44" + digits.slice(1); // UK national format
  else if (/^44\d{10}$/.test(digits)) intl = digits; // 447… typed without the +
  else return null;

  // "+44 (0)7…" — drop the redundant trunk zero.
  if (intl.startsWith("440")) intl = "44" + intl.slice(3);

  if (!/^[1-9]\d{7,14}$/.test(intl)) return null;
  if (intl.startsWith("44") && !/^447\d{9}$/.test(intl)) return null; // UK but not a mobile

  return "+" + intl;
}

// ---------- message templates ----------

// The reference customers already see everywhere else (emails, Track Order
// page) is the first 8 characters of the order id. SMS and WhatsApp use the
// same one so it always matches the database record.
function orderRef(orderId) {
  return "#" + String(orderId).slice(0, 8);
}

// Plain GSM-7 characters only (no £, curly quotes or dashes) so each message
// stays a single 160-character SMS segment.
const SMS_TEMPLATES = {
  order_placed: ref => `MyShopSwift: Your order ${ref} has been successfully received. Thank you for shopping with us!`,
  payment_confirmed: ref => `MyShopSwift: Payment for order ${ref} has been confirmed.`,
  processing: ref => `MyShopSwift: Your order ${ref} is now being processed.`,
  shipped: ref => `MyShopSwift: Your order ${ref} has been dispatched and is on its way!`,
  delivered: ref => `MyShopSwift: Your order ${ref} has been successfully delivered. Thank you for shopping with MyShopSwift!`,
  cancelled: ref => `MyShopSwift: Your order ${ref} has been cancelled. Please contact our support team if you need assistance.`
};
// There is no "out for delivery" order status in this project (see
// ORDER_STATUSES in server.js), so there is deliberately no template or
// trigger for it.

// Order statuses that have an SMS. Anything else (pending, awaiting_payment)
// sends nothing — same as the existing "genuine status change" rule.
const STATUS_TO_EVENT = { processing: "processing", shipped: "shipped", delivered: "delivered", cancelled: "cancelled" };

function buildMessage(event, orderId) {
  const tpl = SMS_TEMPLATES[event];
  return tpl ? tpl(orderRef(orderId)) : null;
}

// ---------- provider status mapping ----------

// Our own small vocabulary, stored in the database:
//   sending      request to the provider is in flight
//   queued       provider accepted it
//   sent         handed to the carrier
//   delivered    carrier confirmed delivery to the handset
//   undelivered  carrier could not deliver it
//   failed       provider rejected it / could not be sent
//   skipped      never sent (e.g. no usable phone number)
function mapProviderStatus(s) {
  switch (String(s || "").toLowerCase()) {
    case "accepted": case "scheduled": case "queued": case "sending": return "queued";
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "undelivered": return "undelivered";
    case "failed": case "canceled": return "failed";
    default: return null;
  }
}

const STATUS_RANK = { sending: 0, queued: 1, sent: 2, delivered: 3, undelivered: 3, failed: 3 };

// Provider error text can echo the phone number back — never store or log it.
function redact(text) {
  return String(text == null ? "" : text).replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]").slice(0, 200);
}

// Twilio's own wording is terse. For errors that mean "the server's Twilio
// settings are wrong", say which setting to check. Other errors are unchanged.
function friendlyProviderMessage(code, message) {
  if (String(code) === "21705") return "Twilio rejected the Messaging Service SID (error 21705). Check TWILIO_MESSAGING_SERVICE_SID: it must be the MG… SID from Twilio Console > Messaging > Services.";
  if (String(code) === "20003") return "Twilio rejected the Account SID / Auth Token (error 20003). Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.";
  return message;
}

// ---------- sending ----------

async function sendSms({ to, body, config, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (!config || !config.configured) return { ok: false, errorCode: "not_configured", errorMessage: "SMS provider is not configured" };
  if (typeof fetchImpl !== "function") return { ok: false, errorCode: "no_fetch", errorMessage: "fetch is not available (Node 18+ required)" };

  const params = new URLSearchParams();
  params.set("To", to);
  params.set("Body", body);
  if (config.messagingServiceSid) params.set("MessagingServiceSid", config.messagingServiceSid);
  else params.set("From", config.from);
  if (config.statusCallbackUrl) params.set("StatusCallback", config.statusCallbackUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString(),
        signal: controller.signal
      }
    );
    let json = {};
    try { json = await res.json(); } catch (e) { /* non-JSON error body */ }
    if (res.ok && json.sid) {
      return { ok: true, providerMessageId: json.sid, status: mapProviderStatus(json.status) || "queued" };
    }
    return {
      ok: false,
      errorCode: String(json.code || res.status),
      errorMessage: friendlyProviderMessage(json.code, redact(json.message || `Provider returned HTTP ${res.status}`))
    };
  } catch (e) {
    if (e && e.name === "AbortError") {
      // We don't know whether the provider got it before we gave up.
      return {
        ok: false,
        errorCode: "timeout",
        errorMessage: "No response from the provider in time. It may still have been sent: check the provider console before retrying."
      };
    }
    return { ok: false, errorCode: "network", errorMessage: redact(e && e.message) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- delivery-status callback verification ----------

// Twilio signs each callback: base64(HMAC-SHA1(authToken, url + each POST
// param name+value, sorted by name)) in the X-Twilio-Signature header.
function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !url || !signature || typeof signature !== "string") return false;
  const data = url + Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], "");
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  loadConfig,
  cleanEnvValue,
  friendlyProviderMessage,
  normalisePhone,
  orderRef,
  buildMessage,
  SMS_TEMPLATES,
  STATUS_TO_EVENT,
  mapProviderStatus,
  STATUS_RANK,
  redact,
  sendSms,
  validateTwilioSignature
};
