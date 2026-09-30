// MyShopSwift — Brand Flyers / Featured Brands carousel
//
// Postgres-backed: both the metadata AND the actual image bytes live in a
// single "flyers" table (image_data is bytea). This exists specifically
// because Render's free plan has no persistent disk — its local filesystem
// is wiped on every redeploy and on every spin-down after inactivity, so
// storing uploaded images on disk (the previous design) meant they'd
// silently disappear. Images are served back out via a dedicated route in
// server.js (GET /uploads/flyers/:id) rather than express.static, since
// there's no longer a directory to serve from.
//
// Multer is configured with memoryStorage (not diskStorage) so an upload
// never touches the local filesystem at all — the file arrives as
// `file.buffer` and goes straight into the database.

const crypto = require("crypto");
const multer = require("multer");

module.exports = function (db) {

function sorted(list) { return list.slice().sort((a, b) => a.order - b.order); }

// ---------- upload config ----------
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB per flyer image
const MAX_FILES_PER_UPLOAD = 20;

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!EXT_BY_MIME[file.mimetype]) {
    return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed"));
  }
  cb(null, true);
}

const uploadMultiple = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD } })
  .array("flyers", MAX_FILES_PER_UPLOAD);
const uploadSingle = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES, files: 1 } })
  .single("flyer");

// ---------- row -> JS shape ----------
function rowToFlyer(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    order: row.display_order,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}
function publicFlyer(row) {
  return { id: row.id, url: `/uploads/flyers/${row.id}`, order: row.display_order };
}

// ---------- CRUD ----------
async function listPublic() {
  const result = await db.query(`SELECT id, display_order FROM flyers ORDER BY display_order`);
  return result.rows.map(publicFlyer);
}

async function listAdmin() {
  const result = await db.query(`SELECT id, original_name, mime_type, display_order, created_at FROM flyers ORDER BY display_order`);
  return result.rows.map(rowToFlyer);
}

// Returns { mimeType, imageData } for serving the raw bytes, or null.
async function getImage(id) {
  const result = await db.query(`SELECT mime_type, image_data FROM flyers WHERE id = $1`, [id]);
  if (!result.rows.length) return null;
  return { mimeType: result.rows[0].mime_type, imageData: result.rows[0].image_data };
}

async function addFlyers(files) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const maxResult = await client.query(`SELECT COALESCE(MAX(display_order), -1) AS max_order FROM flyers`);
    let nextOrder = maxResult.rows[0].max_order + 1;

    const created = [];
    for (const file of files) {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const inserted = await client.query(
        `INSERT INTO flyers (id, original_name, mime_type, image_data, display_order, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, display_order`,
        [id, file.originalname, file.mimetype, file.buffer, nextOrder++, createdAt]
      );
      created.push(publicFlyer(inserted.rows[0]));
    }

    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteFlyer(id) {
  const result = await db.query(`DELETE FROM flyers WHERE id = $1`, [id]);
  if (result.rowCount === 0) return { error: "Flyer not found" };
  return { ok: true };
}

async function replaceFlyer(id, file) {
  const result = await db.query(
    `UPDATE flyers SET original_name = $1, mime_type = $2, image_data = $3, created_at = $4
     WHERE id = $5 RETURNING id, display_order`,
    [file.originalname, file.mimetype, file.buffer, new Date().toISOString(), id]
  );
  if (!result.rows.length) return { error: "Flyer not found" };
  return { flyer: publicFlyer(result.rows[0]) };
}

async function reorderFlyers(orderedIds) {
  const existingResult = await db.query(`SELECT id FROM flyers`);
  const existingIds = new Set(existingResult.rows.map(r => r.id));

  if (!Array.isArray(orderedIds) || orderedIds.length !== existingIds.size) {
    return { error: "The reorder list must include every existing flyer exactly once" };
  }
  if (!orderedIds.every(id => existingIds.has(id)) || new Set(orderedIds).size !== orderedIds.length) {
    return { error: "The reorder list must include every existing flyer exactly once" };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE flyers SET display_order = $1 WHERE id = $2`, [i, orderedIds[i]]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { flyers: await listPublic() };
}

return {
  uploadMultiple, uploadSingle,
  listPublic, listAdmin, getImage,
  addFlyers, deleteFlyer, replaceFlyer, reorderFlyers
};

};
