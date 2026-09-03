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
      <p>Hi ${safeName},</p>
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

module.exports = { isConfigured, sendMail, sendPasswordResetEmail };
