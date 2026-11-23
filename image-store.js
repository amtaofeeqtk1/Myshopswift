// MyShopSwift — image storage (Cloudinary + PostgreSQL metadata)
//
// One place that product/category photos and brand flyers go through:
//   1. validate the file's real type from its bytes (the client's word isn't trusted),
//   2. upload it to Cloudinary under a fresh random public_id (never overwrites),
//   3. record the reference + metadata in PostgreSQL (image_assets).
// PostgreSQL holds NO image bytes for anything uploaded through here.
//
// Nothing in this file deletes anything, in Cloudinary or in the database.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cloudinaryLib = require("./cloudinary");

// What each kind of image may be, and which Cloudinary folder it lives in.
const KINDS = {
  product: { folder: "products", formats: ["jpg", "png", "webp"], allowGif: false },
  category: { folder: "categories", formats: ["jpg", "png", "webp"], allowGif: false },
  flyer: { folder: "flyers", formats: ["jpg", "png", "webp", "gif"], allowGif: true }
};

// Works out the real image type from the first bytes. Returns a MIME type or null.
function detectImageType(buf, { allowGif = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (allowGif) { const head = buf.slice(0, 6).toString("latin1"); if (head === "GIF87a" || head === "GIF89a") return "image/gif"; }
  return null;
}

function cleanName(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || null;
}

module.exports = function createImageStore({
  db,
  config = cloudinaryLib.loadConfig(),
  uploadImage = cloudinaryLib.uploadImage,
  logger = console
}) {

  // Creates image_assets / image_migrations and the two nullable flyer columns
  // if they don't exist (same add-cloudinary-images.sql that can be run by
  // hand). Additive only. Never throws.
  async function ensureSchema() {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, "add-cloudinary-images.sql"), "utf8"));
    } catch (error) {
      logger.error("[images] Could not ensure Cloudinary tables:", error.message);
    }
  }

  function info() {
    return { configured: config.configured, problems: config.problems };
  }

  async function recordAsset(asset, kind, originalName, source) {
    try {
      await db.query(
        `INSERT INTO image_assets (id, public_id, kind, secure_url, format, bytes, width, height, original_name, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (public_id) DO NOTHING`,
        [crypto.randomUUID(), asset.publicId, kind, asset.secureUrl, asset.format, asset.bytes, asset.width, asset.height, originalName, source]
      );
      return true;
    } catch (error) {
      // The image is already safely in Cloudinary and its URL is what the
      // product stores, so a metadata hiccup must not fail the upload.
      logger.warn("[images] Uploaded, but could not record metadata:", error.message);
      return false;
    }
  }

  // Validates and stores one uploaded file (multer memory file).
  // Returns { url, publicId } or { error, status }.
  async function save(file, kind) {
    const spec = KINDS[kind];
    if (!spec) return { error: "Unknown image type", status: 400 };
    if (!file || !file.buffer || file.buffer.length === 0) return { error: "No image was uploaded", status: 400 };

    const mime = detectImageType(file.buffer, { allowGif: spec.allowGif });
    if (!mime) {
      return { error: spec.allowGif ? "That file isn't a valid JPG, PNG, WebP or GIF image" : "That file isn't a valid JPG, PNG or WebP image", status: 400 };
    }

    const publicId = `${config.folder}/${spec.folder}/${crypto.randomUUID()}`;
    const result = await uploadImage({ buffer: file.buffer, publicId, filename: cleanName(file.originalname), allowedFormats: spec.formats }, config);
    if (!result.ok) {
      logger.error(`[images] Cloudinary upload failed (${result.code}${result.status ? " HTTP " + result.status : ""})`);
      const status = result.code === "not_configured" ? 503 : result.code === "rejected" ? 400 : 502;
      return { error: result.message, status };
    }
    await recordAsset(result, kind, cleanName(file.originalname), "upload");
    return { url: result.secureUrl, publicId: result.publicId, mimeType: mime };
  }

  return { ensureSchema, info, save, config };
};

module.exports.detectImageType = detectImageType;
module.exports.KINDS = KINDS;
module.exports.cleanName = cleanName;
