-- Cloudinary image storage: references + metadata, NOT image bytes.
-- Idempotent and additive: nothing here alters existing data or drops/changes
-- any existing column. The server also runs this file once at startup
-- (ensureSchema() in image-store.js); running it by hand first is optional.
--
-- Existing tables are left alone:
--   * product_images  keeps its rows and bytes untouched (read-only from now on;
--                     it is the backup until the migration has been verified).
--   * products / categories keep their "image" text column; it will simply hold
--                     a Cloudinary https URL instead of "/uploads/products/<id>.jpg".
--   * flyers          gains two NULLABLE columns (image_url, cloudinary_public_id).
--                     Its image_data column is not changed or emptied.

-- One row per image uploaded to / migrated into Cloudinary.
CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,             -- Cloudinary public_id
  kind TEXT NOT NULL,                  -- product | category | flyer | legacy_product | legacy_flyer
  secure_url TEXT NOT NULL,            -- https delivery URL, as stored on the product/category/flyer
  format TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  original_name TEXT,                  -- sanitised, for the admin's reference only
  source TEXT NOT NULL DEFAULT 'upload', -- upload | migration
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_image_assets_public_id ON image_assets(public_id);

-- Progress/audit log of moving the old PostgreSQL images into Cloudinary.
-- One row per old image; safe to re-run, failed rows are retried.
CREATE TABLE IF NOT EXISTS image_migrations (
  legacy_kind TEXT NOT NULL,           -- product (product_images) | flyer (flyers)
  legacy_id TEXT NOT NULL,             -- the old image's id
  status TEXT NOT NULL DEFAULT 'pending', -- pending | migrated | failed
  public_id TEXT,
  secure_url TEXT,
  bytes INTEGER,
  source_sha256 TEXT,                  -- SHA-256 of the original bytes, for the backup manifest
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  verified_at TIMESTAMPTZ,             -- set only after the Cloudinary URL was fetched successfully
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (legacy_kind, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_image_migrations_status ON image_migrations(status);

-- Flyers: reference to the Cloudinary copy (NULL = still served from image_data).
DO $$
BEGIN
  IF to_regclass('flyers') IS NOT NULL THEN
    ALTER TABLE flyers ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE flyers ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
  END IF;
END $$;
