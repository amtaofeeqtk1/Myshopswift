"use strict";

// Unit tests for cloudinary.js. No network, no real credentials: Cloudinary is a fake fetch.
// Run: node --test tests/cloudinary.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const cld = require("../cloudinary");

const CONFIG = cld.loadConfig({ CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "s3cr3t-value" });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);

test("signParams matches Cloudinary's published example", () => {
  // From Cloudinary's "Authentication signatures" docs: secret "abcd", timestamp 1315060510.
  const sig = cld.signParams({ eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: "1315060510" }, "abcd");
  assert.equal(sig, "bfd09f95f331f558cbd1320e67aa8d488770583e");
});

test("signParams sorts by name and ignores empty values", () => {
  assert.equal(cld.signParams({ b: "2", a: "1", c: "" }, "k"), cld.signParams({ a: "1", b: "2" }, "k"));
});

test("loadConfig: configured only with all three values; secret never in problems", () => {
  assert.equal(cld.loadConfig({}).configured, false);
  assert.equal(cld.loadConfig({ CLOUDINARY_CLOUD_NAME: "x", CLOUDINARY_API_KEY: "1" }).configured, false);
  assert.equal(CONFIG.configured, true);
  assert.equal(CONFIG.folder, "myshopswift");
  assert.equal(cld.loadConfig({ CLOUDINARY_CLOUD_NAME: "x", CLOUDINARY_API_KEY: "1", CLOUDINARY_API_SECRET: "y", CLOUDINARY_FOLDER: "/staging/" }).folder, "staging");
  const bad = cld.loadConfig({ CLOUDINARY_CLOUD_NAME: "bad name!", CLOUDINARY_API_KEY: "abc", CLOUDINARY_API_SECRET: "topsecret" });
  assert.equal(bad.configured, false);
  assert.equal(bad.problems.length, 2);
  assert.ok(!JSON.stringify(bad.problems).includes("topsecret"));
});

function okFetch(capture, extra = {}) {
  return async (url, init) => {
    capture.url = url; capture.init = init;
    capture.fields = {}; for (const [k, v] of init.body.entries()) capture.fields[k] = v;
    return { ok: true, status: 200, json: async () => ({ public_id: "myshopswift/products/abc", secure_url: "https://res.cloudinary.com/demo-cloud/image/upload/v1/myshopswift/products/abc.jpg", bytes: 44, format: "jpg", width: 10, height: 10, ...extra }) };
  };
}

test("uploadImage: sends a correctly signed, overwrite-safe request; secret stays off the wire", async () => {
  const cap = {};
  const r = await cld.uploadImage({ buffer: JPEG, publicId: "myshopswift/products/abc", filename: "a.jpg", allowedFormats: ["jpg", "png", "webp"] }, CONFIG, { fetchImpl: okFetch(cap) });
  assert.equal(r.ok, true);
  assert.equal(r.secureUrl.startsWith("https://res.cloudinary.com/demo-cloud/"), true);
  assert.equal(r.existing, false);
  assert.equal(cap.url, "https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
  assert.equal(cap.init.method, "POST");
  const f = cap.fields;
  assert.equal(f.api_key, "123456789012345");
  assert.equal(f.public_id, "myshopswift/products/abc");
  assert.equal(f.overwrite, "false");
  assert.equal(f.allowed_formats, "jpg,png,webp");
  assert.ok(f.file && f.file.size === JPEG.length, "file attached");
  // signature covers every sent parameter except file/api_key
  const expected = cld.signParams({ allowed_formats: f.allowed_formats, overwrite: f.overwrite, public_id: f.public_id, timestamp: f.timestamp }, "s3cr3t-value");
  assert.equal(f.signature, expected);
  assert.ok(!Object.values(f).some(v => typeof v === "string" && v.includes("s3cr3t-value")), "api secret must never be sent");
});

test("uploadImage: reports an asset Cloudinary already had (existing:true) instead of duplicating", async () => {
  const r = await cld.uploadImage({ buffer: JPEG, publicId: "x/y" }, CONFIG, { fetchImpl: okFetch({}, { existing: true }) });
  assert.equal(r.ok, true);
  assert.equal(r.existing, true);
});

test("uploadImage: failures become safe codes + messages and never throw or leak provider text", async () => {
  const mk = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });
  const cases = [
    [401, "Invalid Signature abc. String to sign - 'public_id=x&timestamp=1'", "auth"],
    [403, "forbidden", "auth"],
    [420, "Rate limit exceeded", "rate_limited"],
    [429, "slow down", "rate_limited"],
    [400, "Invalid image file", "rejected"],
    [400, "Format gif not allowed", "rejected"],
    [500, "oops", "unavailable"],
    [503, "oops", "unavailable"],
    [404, "weird", "failed"]
  ];
  for (const [status, message, code] of cases) {
    const r = await cld.uploadImage({ buffer: JPEG, publicId: "a/b" }, CONFIG, { fetchImpl: mk(status, message) });
    assert.equal(r.ok, false, String(status));
    assert.equal(r.code, code, `${status} ${message}`);
    assert.ok(!/String to sign|public_id=|timestamp/.test(r.message), "no provider internals in the message");
  }
  const net = await cld.uploadImage({ buffer: JPEG, publicId: "a/b" }, CONFIG, { fetchImpl: async () => { throw new Error("ECONNRESET api.cloudinary.com 1.2.3.4"); } });
  assert.deepEqual([net.ok, net.code], [false, "network"]);
  assert.ok(!/1\.2\.3\.4|ECONNRESET/.test(net.message));
  const slow = (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))));
  const t = await cld.uploadImage({ buffer: JPEG, publicId: "a/b" }, CONFIG, { fetchImpl: slow, timeoutMs: 20 });
  assert.deepEqual([t.ok, t.code], [false, "timeout"]);
  const nb = await cld.uploadImage({ buffer: JPEG, publicId: "a/b" }, CONFIG, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) });
  assert.equal(nb.ok, false, "a 200 without a usable body is not success");
});

test("uploadImage: not configured -> refuses without calling the network", async () => {
  let called = false;
  const r = await cld.uploadImage({ buffer: JPEG, publicId: "a/b" }, cld.loadConfig({}), { fetchImpl: async () => { called = true; } });
  assert.deepEqual([r.ok, r.code], [false, "not_configured"]);
  assert.equal(called, false);
});

test("module exposes no way to delete or rename Cloudinary assets", () => {
  assert.deepEqual(Object.keys(cld).sort(), ["classifyFailure", "loadConfig", "signParams", "uploadImage", "verifyDelivery", "withTransformation"]);
  assert.ok(!/destroy|rename|delete/i.test(require("fs").readFileSync(require.resolve("../cloudinary"), "utf8").replace(/\/\/.*$/gm, "")), "no destroy/rename/delete call in the client code");
});

test("withTransformation only rewrites plain Cloudinary upload URLs", () => {
  const u = "https://res.cloudinary.com/demo-cloud/image/upload/v1700000000/myshopswift/products/abc.jpg";
  assert.equal(cld.withTransformation(u, "f_auto,q_auto,w_640"), "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,w_640/v1700000000/myshopswift/products/abc.jpg");
  const already = "https://res.cloudinary.com/demo-cloud/image/upload/w_100/v1/x.jpg";
  assert.equal(cld.withTransformation(already, "w_640"), already);
  for (const other of ["assets/products/rice.jpg", "/uploads/products/x.jpg", "blob:abc", "", null, undefined]) assert.equal(cld.withTransformation(other, "w_640"), other);
});

test("verifyDelivery: ok for 200 image; HEAD 405 falls back to GET; rejects 404 / non-image / network", async () => {
  const resp = (status, type) => ({ status, headers: { get: () => type }, body: null });
  assert.equal((await cld.verifyDelivery("https://x/y.jpg", { fetchImpl: async () => resp(200, "image/jpeg") })).ok, true);
  const methods = [];
  const r = await cld.verifyDelivery("https://x/y.jpg", { fetchImpl: async (u, init) => { methods.push(init.method); return init.method === "HEAD" ? resp(405, "") : resp(200, "image/webp"); } });
  assert.equal(r.ok, true);
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.equal((await cld.verifyDelivery("https://x/y.jpg", { fetchImpl: async () => resp(404, "text/html") })).ok, false);
  assert.equal((await cld.verifyDelivery("https://x/y.jpg", { fetchImpl: async () => resp(200, "text/html") })).ok, false);
  assert.equal((await cld.verifyDelivery("https://x/y.jpg", { fetchImpl: async () => { throw new Error("down"); } })).ok, false);
});
