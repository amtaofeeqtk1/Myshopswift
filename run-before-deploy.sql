-- Run this against your Neon database BEFORE deploying the new server.js.
-- All statements are idempotent (IF NOT EXISTS / safe to re-run).

-- 1. Products: brands column (for the Maggi Seasoning Cubes brand picker)
ALTER TABLE products ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '[]'::jsonb;

-- 2. Rewards: referrals table (none existed before)
CREATE TABLE IF NOT EXISTS rewards_referrals (
  id TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  referral_code_used TEXT,
  status TEXT NOT NULL,
  qualifying_order_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  rewarded_at TIMESTAMPTZ
);

-- 3. Contact form submissions (previously contact-messages.json)
CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  subject TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

-- 4. Brand flyers — metadata AND image bytes together (previously
-- flyers.json + data/flyers/ on disk). image_data holds the raw file.
CREATE TABLE IF NOT EXISTS flyers (
  id TEXT PRIMARY KEY,
  original_name TEXT,
  mime_type TEXT NOT NULL,
  image_data BYTEA NOT NULL,
  display_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

-- If products/categories tables don't exist in Postgres yet at all,
-- also run: node migrate-products.js

-- 5. Emoji cleanup: the live products/categories tables were migrated from
-- the same source data that had emoji in the "icon" column (e.g. the fish
-- emoji for Meat & Seafood). The static HTML/JS files have already been
-- cleaned of all emoji, but this column is separate — run this to clean
-- the actual live data too, or admin-created products will keep showing
-- their old emoji icons until edited.
--
-- Every icon value in this dataset was ALWAYS a bare emoji (never plain
-- text) — so instead of a fragile Unicode-codepoint regex, this simply
-- blanks any icon value that isn't plain ASCII letters/digits/spaces/basic
-- punctuation. Safe for this dataset; review first if you've since added
-- icons with real words in them.
UPDATE products SET icon = '' WHERE icon !~ '^[A-Za-z0-9 ,.-]*$';
UPDATE categories SET icon = '' WHERE icon !~ '^[A-Za-z0-9 ,.-]*$';
