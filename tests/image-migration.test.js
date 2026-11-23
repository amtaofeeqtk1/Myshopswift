"use strict";

// Tests for image-migration.js (PostgreSQL -> Cloudinary). Fake DB + fake Cloudinary: no network.
// Run: node --test tests/image-migration.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cld = require("../cloudinary");
const createMigrator = require("../image-migration");
const { newState, makeDb } = require("./helpers/fake-image-db");

const CONFIG = cld.loadConfig({ CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "1", CLOUDINARY_API_SECRET: "s" });
const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const gif = () => Buffer.concat([Buffer.from("GIF89a"), crypto.randomBytes(30)]);
const id = () => crypto.randomUUID();

// Fake Cloudinary that honours overwrite=false the way the real one does.
function makeCloud({ failFor = new Set(), notVerifiable = new Set(), reportBytes = {} } = {}) {
  const assets = new Map(); const calls = [];
  return {
    assets, calls, failFor, notVerifiable,
    async uploadImage({ buffer, publicId }) {
      calls.push(publicId);
      if (failFor.has(publicId)) return { ok: false, code: "unavailable", message: "The image storage service is having problems. Please try again shortly." };
      const existing = assets.has(publicId);
      if (!existing) assets.set(publicId, { buffer, url: `https://res.cloudinary.com/demo-cloud/image/upload/v1/${publicId}.jpg` });
      const a = assets.get(publicId);
      return { ok: true, publicId, secureUrl: a.url, bytes: reportBytes[publicId] ?? a.buffer.length, format: "jpg", width: 10, height: 10, existing };
    },
    async verifyDelivery(url) { return notVerifiable.has(url) ? { ok: false, error: "Delivery check failed (HTTP 404)" } : { ok: true }; }
  };
}

function setup(opts = {}) {
  const state = newState(); const db = makeDb(state); const cloud = makeCloud(opts);
  const logger = { log() {}, warn() {}, error() {} };
  const mig = createMigrator({ db, config: CONFIG, uploadImage: cloud.uploadImage.bind(cloud), verifyDelivery: cloud.verifyDelivery.bind(cloud), logger });
  const addProduct = (bytes = jpeg(500), when = 1) => { const i = id(); state.productImages.set(i, { id: i, mime_type: "image/jpeg", size_bytes: bytes.length, image_data: bytes, created_at: when }); return i; };
  const addFlyer = (bytes = gif(), order = 0) => { const i = id(); state.flyers.set(i, { id: i, original_name: "f.gif", mime_type: "image/gif", image_data: bytes, image_url: null, display_order: order }); return i; };
  return { state, db, cloud, mig, addProduct, addFlyer };
}
const legacyId = (kind, i) => `myshopswift/legacy/${kind === "flyer" ? "flyers" : "products"}/${i}`;

test("migrates every old product image and flyer, verifies them, and records each one", async () => {
  const t = setup(); const a = t.addProduct(), b = t.addProduct(), f = t.addFlyer();
  const s = await t.mig.run({});
  assert.equal(s.totalLegacy, 3); assert.equal(s.migratedNow, 3); assert.equal(s.failed, 0);
  for (const [kind, i] of [["product", a], ["product", b], ["flyer", f]]) {
    const m = t.state.migrations.get(`${kind}:${i}`);
    assert.equal(m.status, "migrated"); assert.ok(m.verified_at); assert.equal(m.public_id, legacyId(kind, i));
    assert.match(m.secure_url, /^https:\/\/res\.cloudinary\.com\/demo-cloud\//);
  }
  assert.equal(t.state.assets.size, 3, "metadata recorded in image_assets");
});

test("migration alone changes nothing the shop displays (no reference updates)", async () => {
  const t = setup(); const a = t.addProduct();
  t.state.products.push({ id: 1, name: "Rice", image: `/uploads/products/${a}.jpg` });
  const f = t.addFlyer();
  await t.mig.run({});
  assert.equal(t.state.products[0].image, `/uploads/products/${a}.jpg`);
  assert.equal(t.state.flyers.get(f).image_url, null);
  assert.equal(t.state.sqlLog.filter(q => /^UPDATE (products|categories|flyers) /.test(q)).length, 0);
});

test("never deletes, truncates, drops or empties anything — originals stay byte-for-byte", async () => {
  const t = setup(); const bytes = jpeg(800); const a = t.addProduct(bytes); const f = t.addFlyer(gif()); const flyerBytes = t.state.flyers.get(f).image_data;
  t.state.products.push({ id: 1, name: "Rice", image: `/uploads/products/${a}.jpg` });
  await t.mig.run({ applyRefs: true });
  const forbidden = t.state.sqlLog.filter(q => /^(DELETE|TRUNCATE|DROP|ALTER)\b/i.test(q) || /SET image_data\b/i.test(q) || /UPDATE product_images/i.test(q));
  assert.deepEqual(forbidden, []);
  assert.ok(t.state.productImages.get(a).image_data.equals(bytes));
  assert.ok(t.state.flyers.get(f).image_data.equals(flyerBytes), "flyer bytes kept as the backup");
});

test("re-running is safe: finished images are skipped, nothing is uploaded twice", async () => {
  const t = setup(); t.addProduct(); t.addProduct(); t.addFlyer();
  await t.mig.run({});
  const uploads = t.cloud.calls.length;
  const again = await t.mig.run({});
  assert.equal(again.alreadyMigrated, 3); assert.equal(again.migratedNow, 0);
  assert.equal(t.cloud.calls.length, uploads);
  assert.equal(t.cloud.assets.size, 3);
});

test("failed images are recorded, don't stop the rest, and succeed on retry without duplicates", async () => {
  const t = setup(); const a = t.addProduct(), b = t.addProduct(), c = t.addProduct();
  t.cloud.failFor.add(legacyId("product", b));
  const s1 = await t.mig.run({});
  assert.equal(s1.migratedNow, 2); assert.equal(s1.failed, 1);
  assert.equal(s1.failures[0].id, b);
  const bad = t.state.migrations.get(`product:${b}`);
  assert.equal(bad.status, "failed"); assert.match(bad.last_error, /unavailable/); assert.ok(!bad.verified_at);

  t.cloud.failFor.clear();
  const s2 = await t.mig.run({});
  assert.equal(s2.alreadyMigrated, 2); assert.equal(s2.migratedNow, 1); assert.equal(s2.failed, 0);
  assert.equal(t.state.migrations.get(`product:${b}`).attempts, 2);
  assert.equal(t.cloud.assets.size, 3, "exactly one Cloudinary asset per old image");
  void a; void c;
});

test("an upload that succeeded earlier but wasn't recorded is reused, not duplicated", async () => {
  const t = setup(); const a = t.addProduct(); const bytes = t.state.productImages.get(a).image_data;
  t.cloud.assets.set(legacyId("product", a), { buffer: bytes, url: `https://res.cloudinary.com/demo-cloud/image/upload/v1/${legacyId("product", a)}.jpg` });
  const s = await t.mig.run({});
  assert.equal(s.migratedNow, 1); assert.equal(s.reusedExistingAsset, 1);
  assert.equal(t.cloud.assets.size, 1);
});

test("an existing asset with a DIFFERENT size is a collision: failed, never overwritten", async () => {
  const t = setup(); const a = t.addProduct(jpeg(500));
  t.cloud.assets.set(legacyId("product", a), { buffer: jpeg(10), url: "https://res.cloudinary.com/demo-cloud/image/upload/v1/other.jpg" });
  const s = await t.mig.run({});
  assert.equal(s.failed, 1); assert.match(s.failures[0].error, /already exists.*differs/);
});

test("not marked migrated unless the Cloudinary URL can actually be fetched", async () => {
  const t = setup(); const a = t.addProduct();
  t.cloud.notVerifiable.add(`https://res.cloudinary.com/demo-cloud/image/upload/v1/${legacyId("product", a)}.jpg`);
  const s = await t.mig.run({});
  assert.equal(s.failed, 1);
  const m = t.state.migrations.get(`product:${a}`);
  assert.equal(m.status, "failed"); assert.ok(!m.verified_at);
  assert.match(m.last_error, /could not be verified/);
  assert.equal(t.state.assets.size, 0, "unverified image is not recorded as a usable asset");
});

test("corrupt or empty old data fails cleanly without calling Cloudinary", async () => {
  const t = setup(); const bad = t.addProduct(Buffer.from("this is not an image at all, sorry"));
  const empty = t.addProduct(Buffer.alloc(0));
  const s = await t.mig.run({});
  assert.equal(s.migratedNow, 0);
  assert.ok(s.failed >= 1);
  assert.equal(t.cloud.calls.length, 0);
  assert.match(t.state.migrations.get(`product:${bad}`).last_error, /not a valid/);
  void empty;
});

test("applyReferences: only old /uploads/ URLs of verified images are repointed; everything else is untouched", async () => {
  const t = setup(); const a = t.addProduct(), unmigrated = t.addProduct();
  t.cloud.failFor.add(legacyId("product", unmigrated));
  t.state.products.push(
    { id: 1, name: "A", image: `/uploads/products/${a}.jpg` },
    { id: 2, name: "B", image: `https://myshopswift.example.com/uploads/products/${a}.jpg` },
    { id: 3, name: "C (not migrated)", image: `/uploads/products/${unmigrated}.jpg` },
    { id: 4, name: "D legacy asset path", image: "assets/products/rice.jpg" },
    { id: 5, name: "E no image", image: "" },
    { id: 6, name: "F already cloudinary", image: "https://res.cloudinary.com/demo-cloud/image/upload/v1/x.jpg" }
  );
  t.state.categories.push({ id: "c1", name: "Cat", image: `/uploads/products/${a}.jpg` });
  const f = t.addFlyer();
  const s = await t.mig.run({ applyRefs: true });
  const url = t.state.migrations.get(`product:${a}`).secure_url;
  assert.deepEqual(t.state.products.map(p => p.image), [url, url, `/uploads/products/${unmigrated}.jpg`, "assets/products/rice.jpg", "", "https://res.cloudinary.com/demo-cloud/image/upload/v1/x.jpg"]);
  assert.equal(t.state.categories[0].image, url);
  assert.equal(t.state.flyers.get(f).image_url, t.state.migrations.get(`flyer:${f}`).secure_url);
  assert.deepEqual(s.referencesUpdated, { products: 2, categories: 1, flyers: 1 });
  assert.equal(s.referencesStillOldStyle.products, 1, "the failed one is still on its old URL and still works");
});

test("dry run reads only: no writes, no uploads", async () => {
  const t = setup(); t.addProduct(); t.addFlyer();
  const s = await t.mig.run({ dryRun: true, applyRefs: true });
  assert.equal(s.dryRun, true); assert.equal(s.totalLegacy, 2); assert.equal(s.notAttempted, 2); assert.equal(s.migratedNow, 0);
  assert.equal(t.cloud.calls.length, 0);
  assert.equal(t.state.sqlLog.filter(q => /^(INSERT|UPDATE|DELETE|CREATE|ALTER)/i.test(q)).length, 0);
});

test("--limit tries only a small batch first", async () => {
  const t = setup(); t.addProduct(); t.addProduct(); t.addProduct();
  const s = await t.mig.run({ limit: 2 });
  assert.equal(s.migratedNow, 2); assert.equal(s.notAttempted, 1);
});

test("refuses to run for real when Cloudinary isn't configured", async () => {
  const state = newState();
  const mig = createMigrator({ db: makeDb(state), config: cld.loadConfig({}), logger: console });
  await assert.rejects(() => mig.run({}), /isn't configured/);
});

test("a database failure mid-run is reported, not thrown away silently", async () => {
  const t = setup(); t.addProduct(); const b = t.addProduct();
  t.state.failQueries = q => (q.startsWith("UPDATE image_migrations SET status = 'migrated'") ? Object.assign(new Error("connection lost"), { code: "08006" }) : null);
  const s = await t.mig.run({});
  assert.ok(s.failed >= 1, "failure surfaced in the summary");
  void b;
});

test("backup writes every original image plus a SHA-256 manifest", async () => {
  const t = setup(); const bytes = jpeg(700); const a = t.addProduct(bytes); const f = t.addFlyer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgbackup-"));
  const r = await t.mig.backup(dir);
  assert.equal(r.files, 2); assert.equal(r.problems, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const item = manifest.items.find(i => i.id === a);
  assert.equal(item.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.ok(fs.readFileSync(path.join(dir, item.file)).equals(bytes));
  assert.ok(manifest.items.find(i => i.id === f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a flyer already pointed at Cloudinary (or replaced since) still has its original bytes migrated, and its current URL is never overwritten", async () => {
  const t = setup(); const f = t.addFlyer();
  t.state.flyers.get(f).image_url = "https://res.cloudinary.com/demo-cloud/image/upload/v9/myshopswift/flyers/newer.jpg";
  const s = await t.mig.run({ applyRefs: true });
  assert.equal(s.totalLegacy, 1); assert.equal(s.migratedNow, 1);
  assert.equal(t.state.flyers.get(f).image_url, "https://res.cloudinary.com/demo-cloud/image/upload/v9/myshopswift/flyers/newer.jpg", "the flyer keeps the image it currently shows");
  assert.equal(s.referencesUpdated.flyers, 0);
  const again = await t.mig.run({});
  assert.equal(again.totalLegacy, 1); assert.equal(again.alreadyMigrated, 1, "counts stay stable between runs");
});

test("new Cloudinary-only flyers (empty bytes) are not listed as legacy", async () => {
  const t = setup(); const f = t.addFlyer(Buffer.alloc(0));
  t.state.flyers.get(f).image_url = "https://res.cloudinary.com/demo-cloud/image/upload/v9/x.jpg";
  assert.equal((await t.mig.run({ dryRun: true })).totalLegacy, 0);
});
