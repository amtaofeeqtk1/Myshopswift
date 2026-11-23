// MyShopSwift — Brand Flyers / Featured Brands carousel
//
// Flyer metadata (order, name, …) lives in the Postgres "flyers" table.
// NEW and replacement flyer images are uploaded to Cloudinary (image-store.js)
// and the row just stores the Cloudinary URL (image_url) + public id; no image
// bytes are written to PostgreSQL any more (image_data is left as an empty
// value for those rows).
//
// Flyers uploaded BEFORE the Cloudinary migration still have their bytes in
// image_data and keep being served from GET /uploads/flyers/:id (server.js)
// until migrate-images-to-cloudinary.js has copied them over and verified the
// copy. image_data is never cleared or deleted by this code, so it remains the
// backup. Likewise nothing here ever deletes a Cloudinary asset: deleting or
// replacing a flyer only changes/removes the database row's reference.
//
// Multer uses memoryStorage, so an upload never touches the local
// filesystem — the file arrives as `file.buffer`.

const crypto = require("crypto");
const multer = require("multer");

module.exports = function (db, store) {

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
    url: flyerUrl(row), // the admin grid shows this as the preview
    originalName: row.original_name,
    mimeType: row.mime_type,
    order: row.display_order,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}
// Cloudinary URL once the flyer is in Cloudinary; the old served-from-Postgres
// URL until then.
function flyerUrl(row) {
  return row.image_url || `/uploads/flyers/${row.id}`;
}
function publicFlyer(row) {
  return { id: row.id, url: flyerUrl(row), order: row.display_order };
}

// The image_url column is added by add-cloudinary-images.sql (run at startup).
// If a request lands before that has happened, fall back to the old query
// instead of breaking the storefront's flyer carousel.
async function queryWithFallback(sql, legacySql, params = []) {
  try { return await db.query(sql, params); }
  catch (error) {
    if (error.code === "42703") return db.query(legacySql, params); // undefined_column
    throw error;
  }
}

// ---------- CRUD ----------
async function listPublic() {
  const result = await queryWithFallback(
    `SELECT id, display_order, image_url FROM flyers ORDER BY display_order`,
    `SELECT id, display_order FROM flyers ORDER BY display_order`
  );
  return result.rows.map(publicFlyer);
}

async function listAdmin() {
  const result = await queryWithFallback(
    `SELECT id, original_name, mime_type, display_order, created_at, image_url FROM flyers ORDER BY display_order`,
    `SELECT id, original_name, mime_type, display_order, created_at FROM flyers ORDER BY display_order`
  );
  return result.rows.map(rowToFlyer);
}

// For GET /uploads/flyers/:id. Returns
//   { redirectUrl }          – the flyer is in Cloudinary: send the browser there
//   { mimeType, imageData }  – not migrated yet: serve the stored bytes
//   null                     – unknown flyer
async function getImage(id) {
  const result = await queryWithFallback(
    `SELECT mime_type, image_data, image_url FROM flyers WHERE id = $1`,
    `SELECT mime_type, image_data FROM flyers WHERE id = $1`,
    [id]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  if (row.image_url) return { redirectUrl: row.image_url };
  if (!row.image_data || row.image_data.length === 0) return null;
  return { mimeType: row.mime_type, imageData: row.image_data };
}

// Upload failures carry the HTTP status/message the route should answer with.
function uploadError(file, result) {
  const name = file && file.originalname ? ` (${String(file.originalname).slice(0, 60)})` : "";
  return Object.assign(new Error(result.error + name), { status: result.status, publicMessage: result.error + name });
}

async function addFlyers(files) {
  // Upload everything to Cloudinary FIRST, so the database transaction below
  // never waits on the network and a failed upload adds nothing at all.
  const stored = [];
  for (const file of files) {
    const result = await store.save(file, "flyer");
    if (result.error) throw uploadError(file, result);
    stored.push({ file, ...result });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const maxResult = await client.query(`SELECT COALESCE(MAX(display_order), -1) AS max_order FROM flyers`);
    let nextOrder = maxResult.rows[0].max_order + 1;

    const created = [];
    for (const item of stored) {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      // image_data stays NOT NULL in the existing table, so new rows get an
      // empty value: the picture itself is only in Cloudinary.
      const inserted = await client.query(
        `INSERT INTO flyers (id, original_name, mime_type, image_data, image_url, cloudinary_public_id, display_order, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, display_order, image_url`,
        [id, item.file.originalname, item.mimeType, Buffer.alloc(0), item.url, item.publicId, nextOrder++, createdAt]
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
  const exists = await db.query(`SELECT id FROM flyers WHERE id = $1`, [id]);
  if (!exists.rows.length) return { error: "Flyer not found" };

  const stored = await store.save(file, "flyer");
  if (stored.error) throw uploadError(file, stored);

  // Only the reference changes. The previous image (Cloudinary asset, or the
  // original bytes in image_data) is deliberately left where it is.
  const result = await db.query(
    `UPDATE flyers SET original_name = $1, mime_type = $2, image_url = $3, cloudinary_public_id = $4, created_at = $5
     WHERE id = $6 RETURNING id, display_order, image_url`,
    [file.originalname, stored.mimeType, stored.url, stored.publicId, new Date().toISOString(), id]
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
