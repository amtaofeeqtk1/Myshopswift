"use strict";

// In-memory stand-in for the image-related PostgreSQL tables, understanding
// exactly the SQL that image-store.js, product-images.js, flyers.js and
// image-migration.js issue. It proves application logic only: the real SQL
// (ON CONFLICT, UPDATE ... FROM with a regex join) must be exercised against
// PostgreSQL — see the README staging checklist.

function newState() {
  return {
    productImages: new Map(),   // id -> { id, mime_type, size_bytes, image_data, created_at }
    flyers: new Map(),          // id -> { id, original_name, mime_type, image_data, image_url, cloudinary_public_id, display_order, created_at }
    products: [],               // { id, name, image }
    categories: [],             // { id, name, image }
    migrations: new Map(),      // "kind:id" -> row
    assets: new Map(),          // public_id -> row
    sqlLog: [],
    failQueries: null           // optional (sql) => Error | null, to simulate DB failures
  };
}

const norm = s => s.replace(/\s+/g, " ").trim();
const keyOf = (k, id) => `${k}:${id}`;

function makeDb(state, fallback) {
  async function query(sql, params = []) {
    const q = norm(sql);
    state.sqlLog.push(q);
    if (state.failQueries) { const e = state.failQueries(q); if (e) throw e; }

    if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (q.includes("CREATE TABLE IF NOT EXISTS image_assets")) return { rows: [], rowCount: 0 };

    // ---- image_assets ----
    if (q.startsWith("INSERT INTO image_assets")) {
      const migration = q.includes("'migration'");
      const [id, public_id, kind, secure_url, format, bytes, width, height, original_name] = params;
      const source = migration ? "migration" : params[9];
      if (!state.assets.has(public_id)) state.assets.set(public_id, { id, public_id, kind, secure_url, format, bytes, width, height, original_name, source });
      return { rows: [], rowCount: 1 };
    }

    // ---- old product_images ----
    if (q.startsWith("SELECT id, mime_type, size_bytes FROM product_images")) {
      return { rows: [...state.productImages.values()].sort((a, b) => a.created_at - b.created_at).map(r => ({ id: r.id, mime_type: r.mime_type, size_bytes: r.size_bytes })) };
    }
    if (q.startsWith("SELECT mime_type, image_data FROM product_images WHERE id = $1")) {
      const r = state.productImages.get(params[0]); return { rows: r ? [{ mime_type: r.mime_type, image_data: r.image_data }] : [] };
    }
    if (q.startsWith("SELECT image_data AS data FROM product_images WHERE id = $1")) {
      const r = state.productImages.get(params[0]); return { rows: r ? [{ data: r.image_data }] : [] };
    }

    // ---- flyers ----
    if (q.startsWith("SELECT id, mime_type, octet_length(image_data) AS size FROM flyers WHERE octet_length(image_data) > 0")) {
      return { rows: [...state.flyers.values()].filter(f => f.image_data && f.image_data.length > 0).sort((a, b) => a.display_order - b.display_order).map(f => ({ id: f.id, mime_type: f.mime_type, size: f.image_data.length })) };
    }
    if (q.startsWith("SELECT image_data AS data FROM flyers WHERE id = $1")) {
      const f = state.flyers.get(params[0]); return { rows: f ? [{ data: f.image_data }] : [] };
    }
    if (q.startsWith("SELECT id, display_order, image_url FROM flyers ORDER BY display_order")) {
      return { rows: [...state.flyers.values()].sort((a, b) => a.display_order - b.display_order).map(f => ({ id: f.id, display_order: f.display_order, image_url: f.image_url || null })) };
    }
    if (q.startsWith("SELECT id, original_name, mime_type, display_order, created_at, image_url FROM flyers ORDER BY display_order")) {
      return { rows: [...state.flyers.values()].sort((a, b) => a.display_order - b.display_order).map(f => ({ ...f, image_data: undefined })) };
    }
    if (q.startsWith("SELECT mime_type, image_data, image_url FROM flyers WHERE id = $1")) {
      const f = state.flyers.get(params[0]); return { rows: f ? [{ mime_type: f.mime_type, image_data: f.image_data, image_url: f.image_url || null }] : [] };
    }
    if (q.startsWith("SELECT id FROM flyers WHERE id = $1")) {
      return { rows: state.flyers.has(params[0]) ? [{ id: params[0] }] : [] };
    }
    if (q === "SELECT id FROM flyers") return { rows: [...state.flyers.keys()].map(id => ({ id })) };
    if (q.startsWith("SELECT COALESCE(MAX(display_order), -1) AS max_order FROM flyers")) {
      return { rows: [{ max_order: Math.max(-1, ...[...state.flyers.values()].map(f => f.display_order)) }] };
    }
    if (q.startsWith("INSERT INTO flyers")) {
      const [id, original_name, mime_type, image_data, image_url, cloudinary_public_id, display_order, created_at] = params;
      state.flyers.set(id, { id, original_name, mime_type, image_data, image_url, cloudinary_public_id, display_order, created_at });
      return { rows: [{ id, display_order, image_url }], rowCount: 1 };
    }
    if (q.startsWith("UPDATE flyers SET original_name = $1, mime_type = $2, image_url = $3")) {
      const [original_name, mime_type, image_url, cloudinary_public_id, created_at, id] = params;
      const f = state.flyers.get(id); if (!f) return { rows: [], rowCount: 0 };
      Object.assign(f, { original_name, mime_type, image_url, cloudinary_public_id, created_at }); // image_data untouched
      return { rows: [{ id, display_order: f.display_order, image_url }], rowCount: 1 };
    }
    if (q.startsWith("UPDATE flyers SET display_order = $1 WHERE id = $2")) { state.flyers.get(params[1]).display_order = params[0]; return { rows: [], rowCount: 1 }; }
    if (q.startsWith("DELETE FROM flyers WHERE id = $1")) { const had = state.flyers.delete(params[0]); return { rows: [], rowCount: had ? 1 : 0 }; }

    // ---- image_migrations ----
    if (q.startsWith("SELECT secure_url FROM image_migrations WHERE legacy_kind = 'product'")) {
      const m = state.migrations.get(keyOf("product", params[0]));
      return { rows: m && m.status === "migrated" && m.verified_at ? [{ secure_url: m.secure_url }] : [] };
    }
    if (q.startsWith("SELECT status, verified_at, secure_url FROM image_migrations")) {
      const m = state.migrations.get(keyOf(params[0], params[1])); return { rows: m ? [{ ...m }] : [] };
    }
    if (q.startsWith("INSERT INTO image_migrations")) {
      const [kind, id] = params; const k = keyOf(kind, id); const m = state.migrations.get(k);
      if (m) { m.status = "pending"; m.attempts += 1; }
      else state.migrations.set(k, { legacy_kind: kind, legacy_id: id, status: "pending", attempts: 1, last_error: null, verified_at: null, secure_url: null, public_id: null });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE image_migrations SET status = 'failed'")) {
      const m = state.migrations.get(keyOf(params[0], params[1])); m.status = "failed"; m.last_error = params[2]; return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE image_migrations SET status = 'migrated'")) {
      const [kind, id, public_id, secure_url, bytes, hash, warning] = params;
      Object.assign(state.migrations.get(keyOf(kind, id)), { status: "migrated", public_id, secure_url, bytes, source_sha256: hash, last_error: warning, verified_at: new Date() });
      return { rows: [], rowCount: 1 };
    }

    // ---- reference updates (products / categories / flyers) ----
    let m = /^UPDATE (products|categories) t SET image = m\.secure_url FROM image_migrations m/.exec(q);
    if (m) {
      const list = m[1] === "products" ? state.products : state.categories; let n = 0;
      for (const row of list) {
        for (const mig of state.migrations.values()) {
          if (mig.legacy_kind !== "product" || mig.status !== "migrated" || !mig.verified_at) continue;
          if (new RegExp(`^(https?://[^/]+)?/uploads/products/${mig.legacy_id}(\\.[A-Za-z0-9]+)?$`).test(row.image || "")) { row.image = mig.secure_url; n++; break; }
        }
      }
      return { rows: [], rowCount: n };
    }
    if (q.startsWith("UPDATE flyers f SET image_url = m.secure_url")) {
      let n = 0;
      for (const mig of state.migrations.values()) {
        const f = state.flyers.get(mig.legacy_id);
        if (mig.legacy_kind === "flyer" && mig.status === "migrated" && mig.verified_at && f && !f.image_url) { f.image_url = mig.secure_url; f.cloudinary_public_id = mig.public_id; n++; }
      }
      return { rows: [], rowCount: n };
    }
    m = /^SELECT COUNT\(\*\)::int AS n FROM (products|categories) WHERE image ~/.exec(q);
    if (m) { const list = m[1] === "products" ? state.products : state.categories; return { rows: [{ n: list.filter(r => /^(https?:\/\/[^/]+)?\/uploads\/products\//.test(r.image || "")).length }] }; }

    if (fallback) return fallback(sql, params);
    throw new Error("fake image db: unexpected SQL: " + q.slice(0, 110));
  }
  return { query, async connect() { return { query, release() {} }; }, state };
}

module.exports = { newState, makeDb };
