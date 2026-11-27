"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PUBLIC_URL = "https://myshopswift.co.uk";
process.env.CONTACT_INBOX_EMAIL = "info@myshopswift.co.uk";
const email = require("../email");

const order = {
  id: "a1b2c3d4-0000-4000-8000-123456789abc",
  customerName: "Amina Example",
  customerEmail: "amina@example.com",
  createdAt: "2026-11-24T10:00:00.000Z",
  status: "awaiting_payment",
  paymentMethod: "card",
  items: [{ name: "Fresh tomatoes", qty: 2, price: 2.79 }],
  subtotal: 5.58,
  deliveryFee: 0,
  deliveryFreeReason: "First order",
  total: 5.58,
  pointsUsed: 0,
  pointsValue: 0
};

test("order received email is branded and links directly to the matching account order", () => {
  const message = email.orderPlacedEmail(order);
  const profile = "https://myshopswift.co.uk/index.html?account=orders&order=a1b2c3d4-0000-4000-8000-123456789abc#top";
  assert.match(message.subject, /Order received/);
  assert.match(message.html, /https:\/\/myshopswift\.co\.uk\/assets\/logo-cropped\.jpg/);
  assert.match(message.html, /myshopswift\.co\.uk/);
  assert.match(message.html, /info@myshopswift\.co\.uk/);
  assert.ok(message.html.includes(`href="${profile}"`));
  assert.ok(message.text.includes(profile));
  assert.match(message.html, /border-radius:14px/);
  assert.match(message.html, /Fresh tomatoes/);
});

test("payment and status emails include the branded customer order link", () => {
  for (const message of [email.paymentConfirmedEmail(order), email.orderStatusEmail({ ...order, status: "processing" })]) {
    assert.match(message.html, /View this order in your account/);
    assert.match(message.html, /assets\/logo-cropped\.jpg/);
    assert.match(message.text, /account=orders&order=/);
  }
});

test("shipped order status is presented as Your order is on the way", () => {
  const message = email.orderStatusEmail({ ...order, status: "shipped" });
  assert.match(message.html, /Your order is on the way/);
  assert.match(message.text, /Your order is on the way/);
});
