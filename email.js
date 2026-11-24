// MyShopSwift — email delivery
//
// Small wrapper around nodemailer so the rest of the app doesn't need to
// know or care whether real SMTP credentials are configured. If they
// aren't (e.g. local development), sendMail() logs the message to the
// console and returns { delivered: false } instead of throwing — callers
// decide what to do with that (server.js uses it to offer a dev-only
// fallback for testing the password-reset flow without an inbox).
//
// Credentials live only in .env — never in frontend code, never returned
// by any API response.

let nodemailer;
try { nodemailer = require("nodemailer"); }
catch (e) { nodemailer = null; } // package not installed yet — dev fallback still works

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "MyShopSwift <no-reply@myshopswift.local>";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://myshopswift.co.uk").replace(/\/$/, "");
const CONTACT_EMAIL = process.env.CONTACT_INBOX_EMAIL || "info@myshopswift.co.uk";

const isConfigured = !!(nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

if (!isConfigured) {
  console.warn(
    "\nNOTE: Email isn't configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing, or " +
    "the 'nodemailer' package isn't installed) — password-reset emails will " +
    "be logged to this console instead of sent. Run `npm install` and set " +
    "SMTP_* in .env to send real emails.\n"
  );
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured) {
    console.log(`\n[dev email] To: ${to}\n[dev email] Subject: ${subject}\n[dev email] Body:\n${text || html}\n`);
    return { delivered: false };
  }
  try {
    await transporter.sendMail({ from: EMAIL_FROM, to, subject, html, text });
    return { delivered: true };
  } catch (e) {
    console.error("[email] send failed:", e.message);
    return { delivered: false, error: e.message };
  }
}

function passwordResetEmail(name, resetUrl) {
  const safeName = name || "there";
  return {
    subject: "Reset your MyShopSwift password",
    text: `Hi ${safeName},\n\nWe received a request to reset your MyShopSwift password. This link expires in 30 minutes and can only be used once:\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — your password won't change.\n\n— MyShopSwift`,
    html: `
      <p>Hi ${escapeHtml(safeName)},</p>
      <p>We received a request to reset your MyShopSwift password. This link expires in 30 minutes and can only be used once:</p>
      <p><a href="${resetUrl}" style="background:#0F2A6B;color:#F7F9FC;padding:12px 20px;text-decoration:none;display:inline-block;">Reset your password</a></p>
      <p style="font-size:13px;color:#666;">Or copy this link: ${resetUrl}</p>
      <p style="font-size:13px;color:#666;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
      <p>— MyShopSwift</p>
    `
  };
}

async function sendPasswordResetEmail(to, name, resetUrl) {
  const { subject, html, text } = passwordResetEmail(name, resetUrl);
  return sendMail({ to, subject, html, text });
}

// ---------- shared helpers for the templates below ----------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fmtGBP(n) {
  return "£" + Number(n || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const PAYMENT_METHOD_LABELS = { cod: "Legacy payment", card: "Pay by Card", points: "Pay by Point" };
const STATUS_INFO = {
  pending: { label: "Pending", next: "We're getting your order ready." },
  awaiting_payment: { label: "Awaiting payment", next: "This order is held until your card payment completes." },
  processing: { label: "Processing", next: "Your order is being packed." },
  shipped: { label: "Shipped", next: "Your order is on its way." },
  delivered: { label: "Delivered", next: "Enjoy! Let us know if anything was missing or damaged." },
  cancelled: { label: "Cancelled", next: "This order has been cancelled. Contact us if you have any questions." }
};

function orderItemsRowsHtml(items) {
  return (items || []).map(i => `
      <tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;">${i.qty}× ${escapeHtml(i.name)}${i.brand ? ` (${escapeHtml(i.brand)})` : ""}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">${fmtGBP(i.price * i.qty)}</td>
      </tr>`).join("");
}

function orderItemsLinesText(items) {
  return (items || []).map(i => `  ${i.qty} x ${i.name}${i.brand ? ` (${i.brand})` : ""} — ${fmtGBP(i.price * i.qty)}`).join("\n");
}

// order is the app's internal order object (camelCase fields), the same
// shape server.js already builds elsewhere — not a raw DB row.
function orderSummaryHtml(order) {
  const statusInfo = STATUS_INFO[order.status] || { label: order.status, next: "" };
  const paymentLabel = PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod;
  const deliveryLine = order.deliveryFee > 0
    ? fmtGBP(order.deliveryFee)
    : `FREE${order.deliveryFreeReason ? ` (${escapeHtml(order.deliveryFreeReason)})` : ""}`;
  return `
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:14px 0;">
      ${orderItemsRowsHtml(order.items)}
      <tr><td style="padding:8px;padding-top:12px;">Subtotal</td><td style="padding:8px;padding-top:12px;text-align:right;">${fmtGBP(order.subtotal)}</td></tr>
      <tr><td style="padding:4px 8px;">Delivery</td><td style="padding:4px 8px;text-align:right;">${deliveryLine}</td></tr>
      ${order.pointsUsed > 0 ? `<tr><td style="padding:4px 8px;">Points applied</td><td style="padding:4px 8px;text-align:right;">-${fmtGBP(order.pointsValue)}</td></tr>` : ""}
      <tr><td style="padding:8px;font-weight:700;border-top:1.5px solid #0F2A6B;">Total</td><td style="padding:8px;font-weight:700;border-top:1.5px solid #0F2A6B;text-align:right;">${fmtGBP(order.total)}</td></tr>
    </table>
    <p style="font-size:13.5px;color:#444;margin:0 0 4px;">
      Payment method: ${paymentLabel}<br>
      Order status: <strong>${statusInfo.label}</strong>
    </p>
    <p style="font-size:13px;color:#666;">${statusInfo.next}</p>
  `;
}

function orderSummaryText(order) {
  const statusInfo = STATUS_INFO[order.status] || { label: order.status, next: "" };
  const paymentLabel = PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod;
  const deliveryLine = order.deliveryFee > 0
    ? fmtGBP(order.deliveryFee)
    : `FREE${order.deliveryFreeReason ? ` (${order.deliveryFreeReason})` : ""}`;
  const lines = [
    orderItemsLinesText(order.items),
    `Subtotal: ${fmtGBP(order.subtotal)}`,
    `Delivery: ${deliveryLine}`
  ];
  if (order.pointsUsed > 0) lines.push(`Points applied: -${fmtGBP(order.pointsValue)}`);
  lines.push(`Total: ${fmtGBP(order.total)}`);
  lines.push("");
  lines.push(`Payment method: ${paymentLabel}`);
  lines.push(`Order status: ${statusInfo.label}`);
  if (statusInfo.next) lines.push(statusInfo.next);
  return lines.join("\n");
}

function orderHeaderHtml(order) {
  return `
    <p>Hi ${escapeHtml((order.customerName || "there").split(" ")[0])},</p>
    <p style="font-size:13.5px;color:#666;">
      Order reference: <strong>#${order.id.slice(0, 8)}</strong><br>
      Order date: ${new Date(order.createdAt).toLocaleString("en-GB")}
    </p>
  `;
}

function orderProfileUrl(order) {
  return `${PUBLIC_URL}/index.html?account=orders&order=${encodeURIComponent(order.id)}#top`;
}

function brandedOrderEmail(order, intro) {
  const profileUrl = orderProfileUrl(order);
  const websiteUrl = `${PUBLIC_URL}/`;
  return `
    <div style="margin:0;background:#f2f4f8;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#14264f;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e3e7ef;border-radius:14px;overflow:hidden;box-shadow:0 8px 28px rgba(15,42,107,.08);">
        <div style="background:#ffffff;padding:22px 30px 16px;text-align:center;border-bottom:3px solid #e97824;">
          <a href="${websiteUrl}" style="display:inline-block;text-decoration:none;">
            <img src="${PUBLIC_URL}/assets/logo-cropped.jpg" alt="MyShopSwift" width="190" style="display:block;width:190px;max-width:100%;height:auto;border:0;margin:0 auto;">
          </a>
          <div style="margin-top:8px;color:#0F2A6B;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Shop easy. Order fast. Delivered swift.</div>
        </div>
        <div style="padding:30px;">
          ${orderHeaderHtml(order)}
          <h1 style="font-size:23px;line-height:1.3;margin:20px 0 10px;color:#0F2A6B;">${intro}</h1>
          <p style="font-size:14px;line-height:1.7;color:#4c5870;margin:0 0 18px;">Your order details are below. You can return to your account any time to review this order and follow its status.</p>
          <div style="background:#f7f8fb;border:1px solid #e5e9f1;border-radius:10px;padding:14px 16px;">
            ${orderSummaryHtml(order)}
          </div>
          <p style="text-align:center;margin:26px 0 8px;">
            <a href="${profileUrl}" style="background:#0F2A6B;color:#ffffff;padding:13px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-size:14px;font-weight:700;">View this order in your account</a>
          </p>
          <p style="font-size:12px;line-height:1.7;color:#68738a;text-align:center;margin:14px 0 0;">If you’re not signed in, we’ll ask you to sign in before showing your orders.</p>
        </div>
        <div style="background:#f7f8fb;border-top:1px solid #e5e9f1;padding:20px 28px;text-align:center;color:#68738a;font-size:12px;line-height:1.8;">
          <a href="${websiteUrl}" style="color:#0F2A6B;font-weight:700;text-decoration:none;">myshopswift.co.uk</a>
          &nbsp; · &nbsp; <a href="mailto:${CONTACT_EMAIL}" style="color:#0F2A6B;text-decoration:none;">${CONTACT_EMAIL}</a>
          <div style="margin-top:6px;">Thank you for shopping with MyShopSwift.</div>
        </div>
      </div>
    </div>`;
}

// ---------- Email verification ----------

function verificationEmail(name, verifyUrl) {
  const safeName = name || "there";
  return {
    subject: "Verify your email — MyShopSwift",
    text: `Hi ${safeName},\n\nWelcome to MyShopSwift! Please verify your email address by clicking the link below. This link expires in 24 hours and can only be used once:\n\n${verifyUrl}\n\nIf you didn't create this account, you can safely ignore this email.\n\n— MyShopSwift`,
    html: `
      <p>Hi ${escapeHtml(safeName)},</p>
      <p>Welcome to MyShopSwift! Please verify your email address to finish setting up your account. This link expires in 24 hours and can only be used once:</p>
      <p><a href="${verifyUrl}" style="background:#0F2A6B;color:#F7F9FC;padding:12px 20px;text-decoration:none;display:inline-block;">Verify your email</a></p>
      <p style="font-size:13px;color:#666;">Or copy this link: ${verifyUrl}</p>
      <p style="font-size:13px;color:#666;">If you didn't create this account, you can safely ignore this email.</p>
      <p>— MyShopSwift</p>
    `
  };
}

async function sendVerificationEmail(to, name, verifyUrl) {
  const { subject, html, text } = verificationEmail(name, verifyUrl);
  return sendMail({ to, subject, html, text });
}

// ---------- Order emails ----------

function orderPlacedEmail(order) {
  return {
    subject: `Order received — #${order.id.slice(0, 8)} — MyShopSwift`,
    html: brandedOrderEmail(order, "Thanks for your order"),
    text: `Hi ${(order.customerName || "there").split(" ")[0]},\n\nThanks for your order! Order reference #${order.id.slice(0, 8)}, placed ${new Date(order.createdAt).toLocaleString("en-GB")}.\n\n${orderSummaryText(order)}\n\nView this order in your account: ${orderProfileUrl(order)}\nShop: ${PUBLIC_URL}\nContact: ${CONTACT_EMAIL}\n\n— MyShopSwift`
  };
}

function paymentConfirmedEmail(order) {
  return {
    subject: `Payment confirmed — #${order.id.slice(0, 8)} — MyShopSwift`,
    html: brandedOrderEmail(order, "Payment confirmed"),
    text: `Hi ${(order.customerName || "there").split(" ")[0]},\n\nYour payment for order #${order.id.slice(0, 8)} has been confirmed.\n\n${orderSummaryText(order)}\n\nView this order in your account: ${orderProfileUrl(order)}\nShop: ${PUBLIC_URL}\nContact: ${CONTACT_EMAIL}\n\n— MyShopSwift`
  };
}

function orderStatusEmail(order) {
  const statusInfo = STATUS_INFO[order.status] || { label: order.status, next: "" };
  return {
    subject: `Order #${order.id.slice(0, 8)} update: ${statusInfo.label} — MyShopSwift`,
    html: brandedOrderEmail(order, `Your order is ${escapeHtml(statusInfo.label.toLowerCase())}`),
    text: `Hi ${(order.customerName || "there").split(" ")[0]},\n\nYour order #${order.id.slice(0, 8)} status has changed to: ${statusInfo.label}\n\n${orderSummaryText(order)}\n\nView this order in your account: ${orderProfileUrl(order)}\nShop: ${PUBLIC_URL}\nContact: ${CONTACT_EMAIL}\n\n— MyShopSwift`
  };
}

async function sendOrderPlacedEmail(order) {
  const { subject, html, text } = orderPlacedEmail(order);
  return sendMail({ to: order.customerEmail, subject, html, text });
}

async function sendPaymentConfirmedEmail(order) {
  const { subject, html, text } = paymentConfirmedEmail(order);
  return sendMail({ to: order.customerEmail, subject, html, text });
}

async function sendOrderStatusEmail(order) {
  const { subject, html, text } = orderStatusEmail(order);
  return sendMail({ to: order.customerEmail, subject, html, text });
}

module.exports = {
  isConfigured,
  escapeHtml,
  orderPlacedEmail,
  paymentConfirmedEmail,
  orderStatusEmail,
  sendMail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendOrderPlacedEmail,
  sendPaymentConfirmedEmail,
  sendOrderStatusEmail
};
