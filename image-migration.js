// MyShopSwift — migrate existing PostgreSQL images to Cloudinary
//
// Used by migrate-images-to-cloudinary.js (run by hand; never runs by itself).
//
// Safety rules this implements:
//   * READ-ONLY on the old data. product_images rows, flyers.image_data and
//     the products/categories tables are never deleted, truncated or emptied.
//   * Repeatable. Each old image gets a deterministic Cloudinary public_id
//     (myshopswift/legacy/<kind>/<old id>) and is uploaded with overwrite=false,
//     so re-running never creates a duplicate: Cloudinary hands back the asset
//     that's already there.
//   * Verified. An image only counts as "migrated" after its Cloudinary URL has
//     been fetched successfully (HTTP 200, image content-type).
//   * Recorded. Every old image has a row in image_migrations (status, URL,
//     public id, attempts, last error, SHA-256 of the original bytes).
//   * Two separate steps. Uploading + verifying changes nothing the shop
//     displays. Pointing products/categories/flyers at the new URLs only happens
//     with the explicit applyReferences option.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cloudinaryLib = require("./cloudinary");
const { detectImageType, KINDS } = require("./image-store");

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function shortError(e) { return String(e && e.message ? e.message : e).slice(0, 300); }

module.exports = function createMigrator({
  db,
  config = cloudinaryLib.loadConfig(),
  uploadImage = cloudinaryLib.uploadImage,
  verifyDelivery = cloudinaryLib.verifyDelivery,
  logger = console
}) {

  const folderFor = (kind, id) => `${config.folder}/legacy/${kind === "flyer" ? "flyers" : "products"}/${id}`;

  async function ensureSchema() {
    await db.query(fs.readFileSync(path.join(__dirname, "add-cloudinary-images.sql"), "utf8"));
  }

  // ---- what exists in the old storage ----
  async function listLegacy({ kinds, dryRun }) {
    const items = [];
    if (kinds.includes("product")) {
      try {
        const r = await db.query(`SELECT id, mime_type, size_bytes FROM product_images ORDER BY created_at, id`);
        for (const row of r.rows) items.push({ kind: "product", id: row.id, mime: row.mime_type, size: Number(row.size_bytes) });
      } catch (e) { if (e.code !== "42P01") throw e; /* no old table: nothing to migrate */ }
    }
    if (kinds.includes("flyer")) {
      // Every flyer that still has stored bytes — including ones already pointed at
      // Cloudinary or replaced since — so the original is preserved and the counts
      // stay the same from one run to the next. New Cloudinary-only flyers have empty bytes.
      try {
        const r = await db.query(`SELECT id, mime_type, octet_length(image_data) AS size FROM flyers WHERE octet_length(image_data) > 0 ORDER BY display_order, id`);
        for (const row of r.rows) items.push({ kind: "flyer", id: row.id, mime: row.mime_type, size: Number(row.size) });
      } catch (e) { if (e.code !== "42P01" && e.code !== "42703") throw e; }
    }
    return items;
  }

  async function loadBytes(item) {
    const sql = item.kind === "flyer"
      ? `SELECT image_data AS data FROM flyers WHERE id = $1`
      : `SELECT image_data AS data FROM product_images WHERE id = $1`;
    const r = await db.query(sql, [item.id]);
    return r.rows.length ? r.rows[0].data : null;
  }

  async function getState(item) {
    try {
      const r = await db.query(`SELECT status, verified_at, secure_url FROM image_migrations WHERE legacy_kind = $1 AND legacy_id = $2`, [item.kind, item.id]);
      return r.rows[0] || null;
    } catch (e) { if (e.code === "42P01") return null; throw e; }
  }

  // ---- one image ----
  async function migrateOne(item) {
    await db.query(
      `INSERT INTO image_migrations (legacy_kind, legacy_id, status, attempts, created_at, updated_at)
       VALUES ($1,$2,'pending',1,NOW(),NOW())
       ON CONFLICT (legacy_kind, legacy_id)
       DO UPDATE SET status = 'pending', attempts = image_migrations.attempts + 1, updated_at = NOW()`,
      [item.kind, item.id]
    );

    const fail = async (message) => {
      await db.query(
        `UPDATE image_migrations SET status = 'failed', last_error = $3, updated_at = NOW() WHERE legacy_kind = $1 AND legacy_id = $2`,
        [item.kind, item.id, message]
      );
      return { ok: false, error: message };
    };

    try {
      const data = await loadBytes(item);
      if (!data || data.length === 0) return await fail("The old image has no stored bytes");
      const mime = detectImageType(data, { allowGif: item.kind === "flyer" });
      if (!mime) return await fail("The old image bytes are not a valid JPG, PNG, WebP or GIF file");

      const hash = sha256(data);
      const spec = KINDS[item.kind === "flyer" ? "flyer" : "product"];
      const up = await uploadImage({
        buffer: data, publicId: folderFor(item.kind, item.id), filename: `${item.id}.${EXT[mime]}`, allowedFormats: spec.formats
      }, config);
      if (!up.ok) return await fail(`Cloudinary upload failed: ${up.code} — ${up.message}`);

      // The asset we got back must really be this image: if "existing" came back
      // with a different size, something else already owns that public_id.
      let warning = null;
      if (up.bytes != null && up.bytes !== data.length) {
        if (up.existing) return await fail(`An asset with this public_id already exists in Cloudinary but its size differs (${up.bytes} vs ${data.length} bytes) — not overwritten`);
        warning = `warning: Cloudinary reports ${up.bytes} bytes for an original of ${data.length}`;
      }

      const check = await verifyDelivery(up.secureUrl);
      if (!check.ok) return await fail(`Uploaded, but the Cloudinary URL could not be verified: ${check.error}`);

      await db.query(
        `INSERT INTO image_assets (id, public_id, kind, secure_url, format, bytes, width, height, original_name, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'migration',NOW())
         ON CONFLICT (public_id) DO NOTHING`,
        [crypto.randomUUID(), up.publicId, item.kind === "flyer" ? "legacy_flyer" : "legacy_product", up.secureUrl, up.format, up.bytes, up.width, up.height, `${item.id}.${EXT[mime]}`]
      );
      await db.query(
        `UPDATE image_migrations
            SET status = 'migrated', public_id = $3, secure_url = $4, bytes = $5, source_sha256 = $6,
                last_error = $7, verified_at = NOW(), updated_at = NOW()
          WHERE legacy_kind = $1 AND legacy_id = $2`,
        [item.kind, item.id, up.publicId, up.secureUrl, up.bytes, hash, warning]
      );
      return { ok: true, url: up.secureUrl, existing: !!up.existing, warning };
    } catch (error) {
      try { return await fail("Unexpected error: " + shortError(error)); }
      catch (e2) { return { ok: false, error: "Unexpected error and could not record it: " + shortError(e2) }; }
    }
  }

  // ---- pointing the shop at the new URLs (separate, explicit step) ----
  // Only rows whose image is an old /uploads/... URL of a migrated + verified
  // image are touched; everything else (including relative assets/... paths) is left alone.
  async function applyReferences() {
    const counts = { products: 0, categories: 0, flyers: 0 };
    const oldUrl = `'^(https?://[^/]+)?/uploads/products/' || m.legacy_id || '(\\.[A-Za-z0-9]+)?$'`;
    for (const [key, table] of [["products", "products"], ["categories", "categories"]]) {
      const r = await db.query(
        `UPDATE ${table} t SET image = m.secure_url
           FROM image_migrations m
          WHERE m.legacy_kind = 'product' AND m.status = 'migrated' AND m.verified_at IS NOT NULL
            AND t.image ~ (${oldUrl})`
      );
      counts[key] = r.rowCount || 0;
    }
    try {
      const r = await db.query(
        `UPDATE flyers f SET image_url = m.secure_url, cloudinary_public_id = m.public_id
           FROM image_migrations m
          WHERE m.legacy_kind = 'flyer' AND m.legacy_id = f.id AND m.status = 'migrated' AND m.verified_at IS NOT NULL
            AND f.image_url IS NULL`
      );
      counts.flyers = r.rowCount || 0;
    } catch (e) { if (e.code !== "42P01" && e.code !== "42703") throw e; }
    return counts;
  }

  // How many references still point at old URLs (for the report).
  async function countPendingReferences() {
    const out = { products: 0, categories: 0 };
    for (const t of ["products", "categories"]) {
      try {
        const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE image ~ '^(https?://[^/]+)?/uploads/products/'`);
        out[t] = r.rows[0].n;
      } catch (e) { if (e.code !== "42P01") throw e; }
    }
    return out;
  }

  // ---- full backup of the original bytes to a local folder ----
  async function backup(dir, { kinds = ["product", "flyer"] } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const items = await listLegacy({ kinds, dryRun: true });
    const manifest = [];
    for (const item of items) {
      const data = await loadBytes(item);
      if (!data || !data.length) { manifest.push({ kind: item.kind, id: item.id, error: "no bytes" }); continue; }
      const mime = detectImageType(data, { allowGif: true });
      const file = `${item.kind}-${item.id}.${EXT[mime] || "bin"}`;
      fs.writeFileSync(path.join(dir, file), data);
      manifest.push({ kind: item.kind, id: item.id, file, bytes: data.length, sha256: sha256(data), mime: mime || item.mime });
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), count: manifest.length, items: manifest }, null, 2));
    return { dir, files: manifest.filter(m => !m.error).length, problems: manifest.filter(m => m.error).length };
  }

  // ---- the whole run ----
  async function run({ dryRun = false, applyRefs = false, limit = Infinity, kinds = ["product", "flyer"], onProgress = () => {} } = {}) {
    if (!dryRun && !config.configured) {
      throw new Error("Cloudinary isn't configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET");
    }
    if (!dryRun) await ensureSchema();

    const items = await listLegacy({ kinds, dryRun });
    const summary = {
      dryRun, totalLegacy: items.length, alreadyMigrated: 0, migratedNow: 0, reusedExistingAsset: 0,
      failed: 0, notAttempted: 0, warnings: [], failures: [], referencesUpdated: null
    };

    let attempted = 0;
    for (const item of items) {
      const state = await getState(item);
      if (state && state.status === "migrated" && state.verified_at) { summary.alreadyMigrated++; continue; }
      if (dryRun || attempted >= limit) { summary.notAttempted++; continue; }
      attempted++;
      const r = await migrateOne(item);
      if (r.ok) {
        summary.migratedNow++;
        if (r.existing) summary.reusedExistingAsset++;
        if (r.warning) summary.warnings.push({ kind: item.kind, id: item.id, warning: r.warning });
      } else {
        summary.failed++;
        summary.failures.push({ kind: item.kind, id: item.id, error: r.error });
      }
      onProgress({ item, result: r, done: attempted });
    }

    if (applyRefs && !dryRun) summary.referencesUpdated = await applyReferences();
    try { summary.referencesStillOldStyle = await countPendingReferences(); } catch (e) { summary.referencesStillOldStyle = null; }
    return summary;
  }

  return { run, backup, applyReferences, ensureSchema, listLegacy };
};
