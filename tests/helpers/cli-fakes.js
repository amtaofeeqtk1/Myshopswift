"use strict";
// Preloaded with `node -r` so the REAL migrate-images-to-cloudinary.js CLI runs against
// fakes: a file-backed fake database (FAKE_STATE) and a fake Cloudinary (signature-checked).
// FAKE_CLOUD_FAIL=<text>: uploads whose public_id contains <text> fail with a 503.
const Module = require("module");
const crypto = require("crypto");
const stateIo = require("./state-io");
const { makeDb } = require("./fake-image-db");

const FILE = process.env.FAKE_STATE;
const state = stateIo.load(FILE);
state.cloudAssets = state.cloudAssets || new Map();
const db = makeDb(state);
process.on("exit", () => stateIo.save(state, FILE));

class FakePool { query(...a) { return db.query(...a); } connect() { return db.connect(); } async end() {} }
const orig = Module._load;
Module._load = function (request) {
  if (request === "dotenv") return { config() { return {}; } };
  if (request === "pg") return { Pool: FakePool };
  return orig.apply(this, arguments);
};

const SECRET = process.env.CLOUDINARY_API_SECRET;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.cloudinary.com/")) {
    const f = {}; for (const [k, v] of init.body.entries()) f[k] = v;
    const { signature, api_key, file, ...signed } = f;
    const expect = crypto.createHash("sha1").update(Object.keys(signed).sort().map(k => k + "=" + signed[k]).join("&") + SECRET).digest("hex");
    if (signature !== expect) return { ok: false, status: 401, json: async () => ({ error: { message: "Invalid Signature" } }) };
    if (process.env.FAKE_CLOUD_FAIL && signed.public_id.includes(process.env.FAKE_CLOUD_FAIL)) return { ok: false, status: 503, json: async () => ({ error: { message: "down" } }) };
    const buf = Buffer.from(await file.arrayBuffer());
    const existing = state.cloudAssets.has(signed.public_id);
    if (!existing) state.cloudAssets.set(signed.public_id, { size: buf.length, url: `https://res.cloudinary.com/demo-cloud/image/upload/v1/${signed.public_id}.jpg` });
    const a = state.cloudAssets.get(signed.public_id);
    return { ok: true, status: 200, json: async () => ({ public_id: signed.public_id, secure_url: a.url, bytes: a.size, format: "jpg", width: 10, height: 10, existing }) };
  }
  if (u.startsWith("https://res.cloudinary.com/")) return { status: 200, headers: { get: () => "image/jpeg" }, body: null };
  throw new Error("unexpected fetch in CLI test: " + u);
};
