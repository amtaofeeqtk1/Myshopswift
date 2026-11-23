-- LEGACY (kept for reference): the old PostgreSQL image store for product/category photos.
--
-- Photos are now stored in Cloudinary (see add-cloudinary-images.sql). This file
-- is NO LONGER run by the server and nothing writes to product_images any more.
-- The table, if you have it, must be KEPT: it holds the original bytes of every
-- photo uploaded before the move, serves any not-yet-migrated image read-only,
-- and is the backup until migrate-images-to-cloudinary.js has migrated and you
-- have verified everything. Do not drop it.
--
CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,                 -- random UUID; also the public file name
  original_name TEXT,                  -- sanitised, for the admin's reference only
  mime_type TEXT NOT NULL,             -- detected from the file's bytes, never trusted from the client
  size_bytes INTEGER NOT NULL,
  image_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
