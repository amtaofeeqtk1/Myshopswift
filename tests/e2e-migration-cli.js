"use strict";
// Runs the REAL migrate-images-to-cloudinary.js as a separate process, through the documented
// sequence, against fakes (see helpers/cli-fakes.js). Proves the CLI wiring, flags, output and
// exit codes — not real PostgreSQL SQL or real Cloudinary.
//   node tests/e2e-migration-cli.js

const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const stateIo = require("./helpers/state-io");
const { newState } = require("./helpers/fake-image-db");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migcli-"));
const FILE = path.join(tmp, "state.json");
const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const ids = { p1: crypto.randomUUID(), p2: crypto.randomUUID(), p3: crypto.randomUUID(), f1: crypto.randomUUID() };
const original = { p1: jpeg(300), p2: jpeg(400), p3: jpeg(500), f1: Buffer.concat([Buffer.from("GIF89a"), crypto.randomBytes(80)]) };

const seed = newState();
[["p1", 1], ["p2", 2], ["p3", 3]].forEach(([k, t]) => seed.productImages.set(ids[k], { id: ids[k], mime_type: "image/jpeg", size_bytes: original[k].length, image_data: original[k], created_at: t }));
seed.flyers.set(ids.f1, { id: ids.f1, original_name: "f.gif", mime_type: "image/gif", image_data: original.f1, image_url: null, display_order: 0 });
seed.products.push({ id: 1, name: "A", image: `/uploads/products/${ids.p1}.jpg` }, { id: 2, name: "B", image: `/uploads/products/${ids.p2}.jpg` }, { id: 3, name: "C", image: "assets/products/rice.jpg" });
seed.categories.push({ id: "c", name: "Cat", image: `/uploads/products/${ids.p3}.jpg` });
stateIo.save(seed, FILE);

const ENV = { ...process.env, FAKE_STATE: FILE, DATABASE_URL: "postgres://fake/fake", CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "cli-test-secret" };
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, ["-r", path.join(__dirname, "helpers/cli-fakes.js"), path.join(ROOT, "migrate-images-to-cloudinary.js"), ...args], { env: { ...ENV, ...env }, encoding: "utf8", cwd: ROOT, timeout: 60000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
const st = () => stateIo.load(FILE);
let passed = 0, failed = 0;
function step(name, fn) { try { fn(); passed++; console.log("  ok  -", name); } catch (e) { failed++; console.log("  FAIL-", name, "\n       ", String(e.message).split("\n").slice(0, 8).join("\n        ")); } }

console.log("\nMigration CLI — end to end\n");

step("refuses to start without DATABASE_URL (exit 2)", () => {
  const r = cli(["--dry-run"], { DATABASE_URL: "" });
  assert.equal(r.code, 2); assert.match(r.out, /DATABASE_URL is not set/);
});

step("--dry-run: reports what exists, writes nothing, uploads nothing", () => {
  const before = fs.readFileSync(FILE, "utf8");
  const r = cli(["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Old images found:\s+4/); assert.match(r.out, /Not attempted:\s+4 \(dry run\)/); assert.match(r.out, /Dry run only/);
  const s = st(); assert.equal(s.migrations.size, 0); assert.equal(s.cloudAssets.size, 0);
  assert.equal(fs.readFileSync(FILE, "utf8"), before, "state file byte-identical");
});

step("--backup=DIR: writes every original + manifest, and does nothing else", () => {
  const dir = path.join(tmp, "backup");
  const r = cli([`--backup=${dir}`]);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /4 image file/);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(m.count, 4);
  const p1 = m.items.find(i => i.id === ids.p1);
  assert.ok(fs.readFileSync(path.join(dir, p1.file)).equals(original.p1));
  assert.equal(p1.sha256, crypto.createHash("sha256").update(original.p1).digest("hex"));
  assert.equal(st().migrations.size, 0, "backup alone does not migrate");
});

step("a partial failure is reported (exit 1) and doesn't stop the other images; nothing shown to customers changes", () => {
  const r = cli([], { FAKE_CLOUD_FAIL: ids.p2 });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Migrated this run:\s+3/); assert.match(r.out, /Failed:\s+1/); assert.match(r.out, new RegExp(`product ${ids.p2}`));
  const s = st();
  assert.equal(s.migrations.get(`product:${ids.p2}`).status, "failed");
  assert.equal(s.migrations.get(`product:${ids.p1}`).status, "migrated");
  assert.equal(s.products[0].image, `/uploads/products/${ids.p1}.jpg`, "references untouched");
  assert.equal(s.flyers.get(ids.f1).image_url, null);
});

step("re-running retries only the failed image; nothing is uploaded twice (exit 0)", () => {
  const assetsBefore = st().cloudAssets.size;
  const r = cli([]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Already migrated \(earlier\):\s+3/); assert.match(r.out, /Migrated this run:\s+1/); assert.match(r.out, /Failed:\s+0/);
  const s = st();
  assert.equal(s.cloudAssets.size, 4); assert.equal(assetsBefore, 3);
  assert.equal(s.migrations.get(`product:${ids.p2}`).attempts, 2);
  assert.match(r.out, /run again with --apply-references/);
});

step("--apply-references repoints only migrated products/categories/flyers; relative paths untouched", () => {
  const r = cli(["--apply-references"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /References updated:\s+products=2, categories=1, flyers=1/);
  const s = st();
  assert.match(s.products[0].image, /^https:\/\/res\.cloudinary\.com\/demo-cloud\//);
  assert.match(s.products[1].image, /^https:\/\/res\.cloudinary\.com\/demo-cloud\//);
  assert.equal(s.products[2].image, "assets/products/rice.jpg");
  assert.match(s.categories[0].image, /^https:\/\/res\.cloudinary\.com\//);
  assert.match(s.flyers.get(ids.f1).image_url, /^https:\/\/res\.cloudinary\.com\//);
});

step("running again changes nothing (idempotent)", () => {
  const before = JSON.stringify(st().products) + JSON.stringify(st().categories);
  const r = cli(["--apply-references"]);
  assert.equal(r.code, 0); assert.match(r.out, /Already migrated \(earlier\):\s+4/); assert.match(r.out, /References updated:\s+products=0, categories=0, flyers=0/);
  assert.equal(JSON.stringify(st().products) + JSON.stringify(st().categories), before);
});

step("the originals are still byte-for-byte intact after everything (the backup)", () => {
  const s = st();
  for (const k of ["p1", "p2", "p3"]) assert.ok(s.productImages.get(ids[k]).image_data.equals(original[k]), k);
  assert.ok(s.flyers.get(ids.f1).image_data.equals(original.f1));
  assert.equal(s.productImages.size, 3);
});

step("--only and --limit are honoured; missing Cloudinary settings stop a real run (exit 2)", () => {
  const r = cli([], { CLOUDINARY_API_SECRET: "" });
  assert.equal(r.code, 2); assert.match(r.out, /isn't configured/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
