"use strict";

// End-to-end check of image uploads with Cloudinary storage.
//   node tests/e2e-product-images.js                  Cloudinary configured (fake Cloudinary)
//   node tests/e2e-product-images.js --no-cloudinary  Cloudinary NOT configured
//   node tests/e2e-product-images.js --serve          start the real server on the fakes and wait (for tests/browser/)
//
// Runs the REAL server.js against in-memory stand-ins for PostgreSQL and for
// Cloudinary's upload API (which verifies each request's signature), with the
// real .env blocked. Proves the application logic. It does NOT prove real
// Cloudinary or PostgreSQL behaviour — see the README staging checklist.

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const { newState, makeDb } = require("./helpers/fake-image-db");

const PORT = Number(process.env.E2E_PORT || 38124);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVE = process.argv.includes("--serve");
const NO_CLD = process.argv.includes("--no-cloudinary");
const SECRET = "test-api-secret-DO-NOT-LEAK";
process.env.NODE_ENV = "development";
Object.assign(process.env, { DATABASE_URL: "postgres://fake/fake", PORT: String(PORT), PUBLIC_URL: `http://127.0.0.1:${PORT}` });
for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_FOLDER"]) delete process.env[k];
if (!NO_CLD) Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: SECRET });

// ---------------- fixtures ----------------
const FX = process.env.FIXTURES || "/nonexistent";
const zlib = require("zlib");
function tinyPng() {
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}
const SYNTH = {
  "small.png": () => tinyPng(),
  "small.jpg": () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from("JFIF\0"), crypto.randomBytes(300), Buffer.from([0xff, 0xd9])]),
  "small.webp": () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), crypto.randomBytes(300)]),
  "small.gif": () => Buffer.concat([Buffer.from("GIF89a"), crypto.randomBytes(200)]),
  "fake.png": () => Buffer.from("<html><script>alert(1)</script></html>".repeat(50)),
  "notes.txt": () => Buffer.from("hello".repeat(100)),
  "pic.gif": () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(200)]),
  "vector.svg": () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  "huge.jpg": () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5 * 1024 * 1024 + 10)])
};
const synthCache = {};
const fixture = n => { const f = path.join(FX, n); return fs.existsSync(f) ? fs.readFileSync(f) : (synthCache[n] = synthCache[n] || SYNTH[n]()); };

// ---------------- fake PostgreSQL ----------------
const state = newState();
const LEGACY_PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_FLYER_ID = "22222222-2222-4222-8222-222222222222";
const legacyBytes = fixture("small.jpg"), legacyFlyerBytes = fixture("small.gif");
state.productImages.set(LEGACY_PRODUCT_ID, { id: LEGACY_PRODUCT_ID, mime_type: "image/jpeg", size_bytes: legacyBytes.length, image_data: legacyBytes, created_at: 1 });
state.flyers.set(LEGACY_FLYER_ID, { id: LEGACY_FLYER_ID, original_name: "old.gif", mime_type: "image/gif", image_data: legacyFlyerBytes, image_url: null, display_order: 0, created_at: new Date().toISOString() });
const store = {
  categories: [{ id: "gadgets", name: "Gadgets", icon: "", image: "assets/categories/gadgets.jpeg" }],
  products: [
    { id: 1, name: "Rice", category: "Gadgets", price: "10.00", old_price: null, icon: "", tag: "", image: "assets/products/legacy-rice.jpg", description: "", brands: [] },
    { id: 2, name: "Beans", category: "Gadgets", price: "4.00", old_price: null, icon: "", tag: "", image: `/uploads/products/${LEGACY_PRODUCT_ID}.jpg`, description: "", brands: [] }
  ]
};
const norm = s => s.replace(/\s+/g, " ").trim();
async function otherQuery(sql, params = []) {
  const q = norm(sql);
  if (q.startsWith("SELECT NOW()")) return { rows: [{}] };
  if (q.includes("CREATE TABLE IF NOT EXISTS")) return { rows: [] };
  if (q.startsWith("SELECT * FROM categories")) return { rows: store.categories.map(c => ({ ...c })) };
  if (q.startsWith("SELECT * FROM products")) return { rows: store.products.map(p => ({ ...p })) };
  if (q.startsWith("SELECT token FROM admin_sessions")) return { rows: params[0] === "admintoken" ? [{ token: "admintoken" }] : [] };
  if (q.includes("FROM sessions s JOIN users u")) return { rows: params[0] === "usertoken" ? [{ id: "u1", name: "Cust", email: "c@x.com", phone: "", email_verified: true, created_at: new Date() }] : [] };
  if (q.startsWith("DELETE FROM categories WHERE id != ALL")) { store.categories = store.categories.filter(c => params[0].includes(c.id)); return { rows: [] }; }
  if (q.startsWith("DELETE FROM products WHERE id != ALL")) { store.products = store.products.filter(p => params[0].includes(p.id)); return { rows: [] }; }
  if (q.startsWith("INSERT INTO categories")) {
    const [id, name, icon, image] = params; const i = store.categories.findIndex(c => c.id === id);
    const row = { id, name, icon, image }; if (i >= 0) store.categories[i] = row; else store.categories.push(row); return { rows: [] };
  }
  if (q.startsWith("INSERT INTO products")) {
    const [id, name, category, price, old_price, icon, tag, image, description, brands] = params;
    const row = { id, name, category, price: String(price), old_price, icon, tag, image, description, brands: JSON.parse(brands) };
    const i = store.products.findIndex(p => p.id === id); if (i >= 0) store.products[i] = row; else store.products.push(row); return { rows: [] };
  }
  throw new Error("fake db: unmocked SQL: " + q.slice(0, 100));
}
const fakeDb = makeDb(state, otherQuery);
class FakePool { query(...a) { return fakeDb.query(...a); } connect() { return fakeDb.connect(); } }

// ---------------- fake Cloudinary ----------------
// Written independently of cloudinary.js (so a bug there can't fool the test):
// Cloudinary's documented rule — sort params, join name=value with &, append the secret, SHA-1.
function independentSignature(params) {
  const str = Object.keys(params).sort().map(k => k + "=" + params[k]).join("&");
  return crypto.createHash("sha1").update(str + SECRET).digest("hex");
}
const cloud = { assets: new Map(), uploads: [], other: [], mode: "ok", n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.cloudinary.com/")) {
    if (!u.endsWith("/image/upload")) { cloud.other.push(u); return { ok: false, status: 404, json: async () => ({}) }; }
    const fields = {}; for (const [k, v] of init.body.entries()) fields[k] = v;
    cloud.uploads.push(fields);
    if (cloud.mode === "down") return { ok: false, status: 503, json: async () => ({ error: { message: "service unavailable" } }) };
    if (cloud.mode === "auth") return { ok: false, status: 401, json: async () => ({ error: { message: "Invalid Signature deadbeef. String to sign - 'public_id=x'" } }) };
    const { signature, api_key, file, ...signed } = fields;
    if (!u.includes("/demo-cloud/") || api_key !== "123456789012345" || signature !== independentSignature(signed)) {
      return { ok: false, status: 401, json: async () => ({ error: { message: "Invalid Signature" } }) };
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const existing = cloud.assets.has(signed.public_id);
    if (!existing) {
      const ext = signed.allowed_formats.includes("gif") && buf.slice(0, 3).toString() === "GIF" ? "gif" : buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpg" : "webp";
      cloud.assets.set(signed.public_id, { buf, url: `https://res.cloudinary.com/demo-cloud/image/upload/v${1700000000 + (++cloud.n)}/${signed.public_id}.${ext}` });
    }
    const a = cloud.assets.get(signed.public_id);
    return { ok: true, status: 200, json: async () => ({ public_id: signed.public_id, secure_url: a.url, bytes: a.buf.length, format: "jpg", width: 800, height: 600, existing }) };
  }
  return realFetch(url, init);
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === "dotenv") return { config() { return {}; } };
  if (request === "pg") return { Pool: FakePool };
  return origLoad.apply(this, arguments);
};

const logs = [];
if (!SERVE) for (const k of ["log", "warn", "error"]) console[k] = (...a) => logs.push(a.join(" "));
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

// ---------------- helpers ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const admin = { Cookie: "admin_session=admintoken" };
const customer = { Cookie: "session=usertoken" };
async function postImage(buf, filename, type, { headers = admin, field = "image", query = "" } = {}) {
  const fd = new FormData(); fd.append(field, new Blob([buf], { type }), filename);
  const res = await fetch(BASE + "/api/admin/product-images" + query, { method: "POST", headers, body: fd });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* */ }
  return { status: res.status, json, text };
}
async function flyerReq(method, url, files, field, headers = admin) {
  const fd = new FormData(); for (const [buf, name, type] of files) fd.append(field, new Blob([buf], { type }), name);
  const res = await fetch(BASE + url, { method, headers, body: fd }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* */ }
  return { status: res.status, json, text };
}
const put = (body, headers = admin) => fetch(BASE + "/api/products", { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getJson = async p => (await fetch(BASE + p)).json();
const CLOUD_URL = /^https:\/\/res\.cloudinary\.com\/demo-cloud\/image\/upload\/v\d+\/myshopswift\/(products|categories|flyers)\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; out("  ok  -", name); } catch (e) { failed++; out("  FAIL-", name, "\n       ", String(e && e.message || e).split("\n").slice(0, 6).join("\n        ")); }
}

(async () => {
  require("../server.js");
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* */ } await sleep(100); }
  if (SERVE) { out(`SERVING on ${BASE} (admin cookie: admin_session=admintoken)`); return; }
  out(`\nImage uploads — end to end (${NO_CLD ? "Cloudinary NOT configured" : "Cloudinary configured"})\n`);

  // ---------------- shared by both modes ----------------
  await step("legacy product image (not migrated yet) is still served from the old table, read-only", async () => {
    for (const name of [`${LEGACY_PRODUCT_ID}.jpg`, LEGACY_PRODUCT_ID]) {
      const res = await fetch(`${BASE}/uploads/products/${name}`);
      assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "image/jpeg");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(legacyBytes));
    }
    assert.equal((await fetch(`${BASE}/uploads/products/00000000-0000-4000-8000-000000000000.jpg`)).status, 404);
    assert.equal((await fetch(`${BASE}/uploads/products/..%2f..%2fserver.js`)).status, 404);
  });

  await step("legacy brand flyer (not migrated yet) is still served from Postgres; storefront flyer list works", async () => {
    const res = await fetch(`${BASE}/uploads/flyers/${LEGACY_FLYER_ID}`);
    assert.equal(res.status, 200); assert.ok(Buffer.from(await res.arrayBuffer()).equals(legacyFlyerBytes));
    const list = await getJson("/api/flyers");
    assert.equal(list.flyers[0].url, `/uploads/flyers/${LEGACY_FLYER_ID}`);
  });

  await step("uploads are admin-only (anonymous and customers refused, nothing sent to Cloudinary)", async () => {
    assert.equal((await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg", { headers: {} })).status, 401);
    assert.equal((await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg", { headers: customer })).status, 401);
    assert.equal((await flyerReq("POST", "/api/admin/flyers", [[fixture("small.jpg"), "a.jpg", "image/jpeg"]], "flyers", {})).status, 401);
    assert.equal((await flyerReq("POST", "/api/admin/flyers", [[fixture("small.jpg"), "a.jpg", "image/jpeg"]], "flyers", customer)).status, 401);
    assert.equal(cloud.uploads.length, 0);
  });

  if (NO_CLD) {
    await step("with Cloudinary not configured: uploads are refused clearly (503); nothing is written to PostgreSQL", async () => {
      const r = await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg");
      assert.equal(r.status, 503); assert.match(r.json.error, /isn't configured/);
      const f = await flyerReq("POST", "/api/admin/flyers", [[fixture("small.jpg"), "a.jpg", "image/jpeg"]], "flyers");
      assert.equal(f.status, 503); assert.match(f.json.error, /isn't configured/);
      assert.equal(state.productImages.size, 1, "no image bytes added to product_images");
      assert.equal(state.flyers.size, 1, "no flyer added");
      assert.equal(cloud.uploads.length, 0);
    });
    await step("the shop itself keeps working: catalogue loads and saves, flyers list, health", async () => {
      const cat = await getJson("/api/products");
      assert.equal(cat.products.length, 2);
      assert.equal((await put({ categories: cat.categories, products: cat.products })).status, 200);
      assert.equal((await fetch(BASE + "/api/flyers")).status, 200);
      assert.equal((await fetch(BASE + "/api/health")).status, 200);
    });
    await step("startup warns that Cloudinary isn't configured", async () => {
      assert.ok(logs.some(l => l.includes("Cloudinary isn't configured")));
    });
    out(`\n${passed} passed, ${failed} failed\n`); process.exit(failed ? 1 : 0);
  }

  // ---------------- Cloudinary configured ----------------
  let jpgUrl, pngUrl, webpUrl;
  await step("admin uploads JPG, PNG and WebP: stored in Cloudinary (not PostgreSQL), signed request, unique public ids", async () => {
    const j = await postImage(fixture("small.jpg"), "My Phone Photo (1).JPG", "image/jpeg");
    const p = await postImage(fixture("small.png"), "cutout.png", "image/png");
    const w = await postImage(fixture("small.webp"), "shot.webp", "image/webp");
    for (const r of [j, p, w]) assert.equal(r.status, 201, r.text);
    [jpgUrl, pngUrl, webpUrl] = [j.json.url, p.json.url, w.json.url];
    for (const u of [jpgUrl, pngUrl, webpUrl]) assert.match(u, CLOUD_URL);
    assert.equal(new Set([jpgUrl, pngUrl, webpUrl]).size, 3);
    assert.equal(cloud.uploads.length, 3);
    for (const f of cloud.uploads) {
      assert.match(f.public_id, /^myshopswift\/products\/[0-9a-f-]{36}$/);
      assert.equal(f.overwrite, "false");
      assert.equal(f.allowed_formats, "jpg,png,webp");
      assert.ok(!Object.values(f).some(v => typeof v === "string" && v.includes(SECRET)), "secret never sent");
    }
    assert.equal(state.productImages.size, 1, "no new bytes in product_images");
    assert.equal(state.assets.size, 3, "metadata recorded in image_assets");
    assert.ok([...state.assets.values()].every(a => a.source === "upload" && a.secure_url.startsWith("https://res.cloudinary.com/")));
    const again = await postImage(fixture("small.jpg"), "My Phone Photo (1).JPG", "image/jpeg");
    assert.notEqual(again.json.url, jpgUrl, "same file twice never overwrites");
  });

  await step("category photos go to the categories folder", async () => {
    const r = await postImage(fixture("small.png"), "cat.png", "image/png", { query: "?kind=category" });
    assert.equal(r.status, 201);
    assert.match(cloud.uploads.at(-1).public_id, /^myshopswift\/categories\//);
  });

  await step("invalid files are rejected on the server before reaching Cloudinary, with clear messages", async () => {
    const before = cloud.uploads.length;
    const cases = [
      [fixture("fake.png"), "evil.png", "image/png", /isn't a valid JPG, PNG or WebP/],
      [fixture("notes.txt"), "notes.txt", "text/plain", /Only JPG, PNG or WebP/],
      [fixture("pic.gif"), "pic.gif", "image/gif", /Only JPG, PNG or WebP/],
      [fixture("vector.svg"), "v.svg", "image/svg+xml", /Only JPG, PNG or WebP/],
      [fixture("vector.svg"), "v.png", "application/octet-stream", /isn't a valid JPG, PNG or WebP/],
      [fixture("pic.gif"), "g.png", "application/octet-stream", /isn't a valid JPG, PNG or WebP/],
      [Buffer.alloc(0), "empty.jpg", "image/jpeg", /./]
    ];
    for (const [buf, name, type, msg] of cases) { const r = await postImage(buf, name, type); assert.equal(r.status, 400, name + r.text); assert.match(r.json.error, msg, name); }
    const huge = await postImage(fixture("huge.jpg"), "huge.jpg", "image/jpeg");
    assert.equal(huge.status, 400); assert.match(huge.json.error, /larger than 5MB/);
    assert.equal((await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg", { field: "wrongfield" })).status, 400);
    assert.equal(cloud.uploads.length, before, "no invalid file was forwarded to Cloudinary");
  });

  await step("Cloudinary outage: clear 502, nothing stored, server stays healthy; recovers afterwards", async () => {
    cloud.mode = "down";
    const before = state.assets.size;
    const r = await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg");
    assert.equal(r.status, 502); assert.match(r.json.error, /having problems/);
    assert.equal(state.assets.size, before);
    cloud.mode = "ok";
    assert.equal((await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg")).status, 201);
  });

  await step("Cloudinary rejects our credentials: admin gets a helpful message with no secrets or provider internals", async () => {
    cloud.mode = "auth";
    const r = await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg");
    assert.equal(r.status, 502); assert.match(r.json.error, /Cloudinary settings/);
    assert.ok(!/String to sign|deadbeef|public_id=|test-api-secret/.test(r.text));
    cloud.mode = "ok";
  });

  await step("database trouble after a successful upload does not lose the upload (URL still returned)", async () => {
    state.failQueries = q => (q.startsWith("INSERT INTO image_assets") ? new Error("db hiccup") : null);
    const r = await postImage(fixture("small.jpg"), "a.jpg", "image/jpeg");
    state.failQueries = null;
    assert.equal(r.status, 201); assert.match(r.json.url, CLOUD_URL);
  });

  await step("add / replace / remove a product photo through the catalogue; existing paths and old images untouched", async () => {
    const cat = await getJson("/api/products");
    const withNew = cat.products.concat([{ id: 3, name: "New Item", cat: "Gadgets", price: 5, image: jpgUrl }]);
    assert.equal((await put({ categories: cat.categories, products: withNew })).status, 200);
    let now = await getJson("/api/products");
    assert.equal(now.products.find(p => p.id === 3).image, jpgUrl);
    assert.equal(now.products.find(p => p.id === 1).image, "assets/products/legacy-rice.jpg", "legacy relative path preserved");
    assert.equal(now.products.find(p => p.id === 2).image, `/uploads/products/${LEGACY_PRODUCT_ID}.jpg`, "old-style URL preserved until migrated");

    assert.equal((await put({ categories: cat.categories, products: now.products.map(p => p.id === 3 ? { ...p, image: pngUrl } : p) })).status, 200);
    now = await getJson("/api/products");
    assert.equal(now.products.find(p => p.id === 3).image, pngUrl);
    assert.ok([...cloud.assets.values()].some(a => a.url === jpgUrl), "replaced image still stored in Cloudinary");

    assert.equal((await put({ categories: cat.categories, products: now.products.map(p => { if (p.id !== 3) return p; const { image, ...rest } = p; return rest; }) })).status, 200);
    now = await getJson("/api/products");
    assert.equal(now.products.find(p => p.id === 3).image, "", "image removed");
    assert.ok(now.products.find(p => p.id === 3), "product itself still exists");
    assert.equal(now.products.length, 3);
    assert.ok([...cloud.assets.values()].some(a => a.url === pngUrl), "removed image still stored in Cloudinary");
    assert.equal(state.productImages.size, 1, "old product_images rows untouched");
  });

  await step("category photo saved through the catalogue", async () => {
    const cat = await getJson("/api/products");
    assert.equal((await put({ categories: cat.categories.map(c => ({ ...c, image: webpUrl })), products: cat.products })).status, 200);
    assert.equal((await getJson("/api/products")).categories[0].image, webpUrl);
  });

  await step("catalogue save rejects dangerous image values and still requires admin", async () => {
    const cat = await getJson("/api/products");
    for (const bad of ['x" onerror="alert(1)', "javascript:alert(1)", "<script>", { a: 1 }, "x".repeat(501)]) {
      const r = await put({ categories: cat.categories, products: [{ id: 9, name: "Bad", cat: "Gadgets", price: 1, image: bad }] });
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.equal((await put({ categories: cat.categories, products: cat.products }, {})).status, 401);
  });

  await step("migrated + verified legacy image: old URL redirects to Cloudinary; unverified one keeps serving bytes", async () => {
    const target = "https://res.cloudinary.com/demo-cloud/image/upload/v1/myshopswift/legacy/products/" + LEGACY_PRODUCT_ID + ".jpg";
    state.migrations.set(`product:${LEGACY_PRODUCT_ID}`, { status: "migrated", verified_at: null, secure_url: target });
    let res = await fetch(`${BASE}/uploads/products/${LEGACY_PRODUCT_ID}.jpg`, { redirect: "manual" });
    assert.equal(res.status, 200, "migrated but NOT verified -> still served from the backup bytes");
    state.migrations.get(`product:${LEGACY_PRODUCT_ID}`).verified_at = new Date();
    res = await fetch(`${BASE}/uploads/products/${LEGACY_PRODUCT_ID}.jpg`, { redirect: "manual" });
    assert.equal(res.status, 302); assert.equal(res.headers.get("location"), target);
    assert.equal(state.productImages.size, 1, "the old bytes are still there");
  });

  // ---- flyers ----
  let flyerIds;
  await step("flyers: upload several (incl. GIF) -> Cloudinary; storefront and admin lists show the Cloudinary URLs", async () => {
    const r = await flyerReq("POST", "/api/admin/flyers", [[fixture("small.jpg"), "a.jpg", "image/jpeg"], [fixture("small.gif"), "b.gif", "image/gif"]], "flyers");
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.flyers.length, 2);
    for (const f of r.json.flyers) assert.match(f.url, CLOUD_URL);
    assert.ok(r.json.flyers[1].url.endsWith(".gif"));
    assert.match(cloud.uploads.at(-1).public_id, /^myshopswift\/flyers\//);
    assert.equal(cloud.uploads.at(-1).allowed_formats, "jpg,png,webp,gif");
    const pub = await getJson("/api/flyers");
    assert.deepEqual(pub.flyers.map(f => f.order), [0, 1, 2]);
    assert.equal(pub.flyers[0].url, `/uploads/flyers/${LEGACY_FLYER_ID}`, "un-migrated flyer unchanged");
    const adm = await (await fetch(BASE + "/api/admin/flyers", { headers: admin })).json();
    assert.ok(adm.flyers.every(f => typeof f.url === "string" && f.url.length > 0), "admin grid gets a preview URL for every flyer");
    flyerIds = r.json.flyers.map(f => f.id);
    const row = state.flyers.get(flyerIds[0]);
    assert.equal(row.image_data.length, 0, "no image bytes stored in PostgreSQL for new flyers");
  });

  await step("flyers: a bad file in the batch adds nothing; Cloudinary outage adds nothing", async () => {
    const count = state.flyers.size;
    const bad = await flyerReq("POST", "/api/admin/flyers", [[fixture("small.jpg"), "ok.jpg", "image/jpeg"], [fixture("fake.png"), "evil.png", "image/png"]], "flyers");
    assert.equal(bad.status, 400); assert.match(bad.json.error, /isn't a valid/);
    cloud.mode = "down";
    const down = await flyerReq("POST", "/api/admin/flyers", [[fixture("small.jpg"), "ok.jpg", "image/jpeg"]], "flyers");
    cloud.mode = "ok";
    assert.equal(down.status, 502);
    assert.equal(state.flyers.size, count, "no half-added flyers");
  });

  await step("flyers: replace changes the reference only; the legacy bytes and old Cloudinary asset are kept", async () => {
    const oldUrl = state.flyers.get(flyerIds[0]).image_url;
    const r = await flyerReq("PUT", `/api/admin/flyers/${flyerIds[0]}/replace`, [[fixture("small.png"), "new.png", "image/png"]], "flyer");
    assert.equal(r.status, 200); assert.match(r.json.flyer.url, CLOUD_URL); assert.notEqual(r.json.flyer.url, oldUrl);
    assert.ok([...cloud.assets.values()].some(a => a.url === oldUrl), "previous Cloudinary image still stored");
    const legacy = await flyerReq("PUT", `/api/admin/flyers/${LEGACY_FLYER_ID}/replace`, [[fixture("small.png"), "n.png", "image/png"]], "flyer");
    assert.equal(legacy.status, 200);
    assert.ok(state.flyers.get(LEGACY_FLYER_ID).image_data.equals(legacyFlyerBytes), "original bytes of a replaced legacy flyer are preserved");
    assert.equal((await flyerReq("PUT", "/api/admin/flyers/nope/replace", [[fixture("small.png"), "n.png", "image/png"]], "flyer")).status, 404);
  });

  await step("flyers: once a flyer is in Cloudinary its old /uploads URL redirects there", async () => {
    const res = await fetch(`${BASE}/uploads/flyers/${LEGACY_FLYER_ID}`, { redirect: "manual" });
    assert.equal(res.status, 302); assert.equal(res.headers.get("location"), state.flyers.get(LEGACY_FLYER_ID).image_url);
  });

  await step("flyers: reorder and delete work; deleting removes the row but never anything in Cloudinary", async () => {
    const ids = (await getJson("/api/flyers")).flyers.map(f => f.id);
    const rev = ids.slice().reverse();
    const re = await fetch(BASE + "/api/admin/flyers/reorder", { method: "PUT", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ order: rev }) });
    assert.equal(re.status, 200);
    assert.deepEqual((await getJson("/api/flyers")).flyers.map(f => f.id), rev);
    const assetsBefore = cloud.assets.size;
    const del = await fetch(`${BASE}/api/admin/flyers/${flyerIds[1]}`, { method: "DELETE", headers: admin });
    assert.equal(del.status, 200);
    assert.equal(state.flyers.has(flyerIds[1]), false);
    assert.equal(cloud.assets.size, assetsBefore, "Cloudinary asset kept");
  });

  await step("nothing in the app ever calls a Cloudinary delete/destroy/rename endpoint", async () => {
    assert.deepEqual(cloud.other, []);
    const bad = state.sqlLog.filter(q => /^(DELETE FROM (product_images|image_assets|image_migrations)|TRUNCATE|DROP)/i.test(q));
    assert.deepEqual(bad, []);
  });

  await step("upload endpoint is rate limited", async () => {
    let last; for (let i = 0; i < 70; i++) last = await postImage(fixture("small.png"), "r.png", "image/png");
    assert.equal(last.status, 429);
  });

  await step("logs contain no API secret and no image bytes", async () => {
    const all = logs.join("\n");
    assert.ok(!all.includes(SECRET));
    assert.ok(!/\u0089PNG|IHDR|JFIF|RIFF|GIF89a/.test(all), "no raw image bytes in logs");
  });

  out(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { out("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
