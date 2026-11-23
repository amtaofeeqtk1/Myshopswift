// MyShopSwift — product / category photo uploads
//
// NEW uploads go to Cloudinary (see image-store.js / cloudinary.js): this file
// only parses the multipart upload, then hands the file over. PostgreSQL no
// longer receives any new image bytes.
//
// The OLD storage — the product_images table with images served from
// /uploads/products/<uuid>.<ext> — is kept strictly READ-ONLY, for two reasons:
//   * images that haven't been migrated yet must keep displaying, and
//   * the table is the backup until the migration has been verified.
// Once an old image has been migrated AND verified (image_migrations), its old
// URL answers with a redirect to the Cloudinary copy, so any place that still
// holds the old URL (a cached page, an old email) keeps working.
//
// Security of the upload step: admin-only (enforced in server.js), a type
// filter and 5MB cap here, then a real-bytes check in image-store.js.

const multer = require("multer");
const imageStore = require("./image-store");

const MAX_BYTES = 5 * 1024 * 1024; // 5MB per image
const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const FILE_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.(jpg|png|webp))?$/;

// A client-declared type that is clearly not one we accept is turned away
// early with a clear message; "application/octet-stream"/empty (some Android
// file managers) are let through to the byte check, which is the real gate.
function fileFilter(req, file, cb) {
  const declared = String(file.mimetype || "").toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== "image/jpg" && declared !== "image/pjpeg" && !ALLOWED[declared]) {
    return cb(Object.assign(new Error("Only JPG, PNG or WebP images are allowed"), { code: "BAD_TYPE" }));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(), // never touches the local filesystem
  fileFilter,
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5, parts: 8 }
}).single("image");

function uploadErrorMessage(err) {
  if (err && err.code === "LIMIT_FILE_SIZE") return "That image is larger than 5MB. Choose a smaller photo.";
  if (err && (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT")) return "Upload one image at a time";
  if (err && err.code === "BAD_TYPE") return err.message;
  return "The upload could not be read. Please try again.";
}

module.exports = function createProductImages(db, store, logger = console) {

  // Stores a new photo in Cloudinary. kind: "product" | "category".
  // Returns { url } or { error, status }.
  async function save(file, kind) {
    return store.save(file, kind);
  }

  // Old /uploads/products/<id>[.ext] URLs. Returns
  //   { redirectUrl }            – migrated and verified: send the browser to Cloudinary
  //   { mimeType, data }         – not migrated yet: serve the stored bytes (read-only)
  //   null                       – unknown id
  async function resolveLegacy(fileName) {
    const m = FILE_NAME_RE.exec(String(fileName || ""));
    if (!m) return null;
    const id = m[1];

    try {
      const migrated = await db.query(
        `SELECT secure_url FROM image_migrations
          WHERE legacy_kind = 'product' AND legacy_id = $1 AND status = 'migrated' AND verified_at IS NOT NULL`,
        [id]
      );
      if (migrated.rows.length) return { redirectUrl: migrated.rows[0].secure_url };
    } catch (error) {
      if (error.code !== "42P01") throw error; // table not created yet: nothing has been migrated
    }

    try {
      const result = await db.query(`SELECT mime_type, image_data FROM product_images WHERE id = $1`, [id]);
      if (!result.rows.length) return null;
      return { mimeType: result.rows[0].mime_type, data: result.rows[0].image_data };
    } catch (error) {
      if (error.code === "42P01") return null; // fresh install: the old table was never created
      throw error;
    }
  }

  return { upload, uploadErrorMessage, save, resolveLegacy };
};

module.exports.detectImageType = imageStore.detectImageType;
module.exports.MAX_BYTES = MAX_BYTES;
