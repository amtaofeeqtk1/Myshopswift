require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrateProducts() {
  const filePath = path.join(__dirname, "data", "products.json");

  try {
    console.log("Reading products.json...");

    const data = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    const categories = data.categories || [];
    const products = data.products || [];

    console.log(`Found ${categories.length} categories.`);
    console.log(`Found ${products.length} products.`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '',
        image TEXT DEFAULT ''
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        price NUMERIC(10,2) NOT NULL,
        old_price NUMERIC(10,2),
        icon TEXT DEFAULT '',
        tag TEXT DEFAULT '',
        image TEXT DEFAULT '',
        description TEXT DEFAULT '',
        brands JSONB DEFAULT '[]'::jsonb
      );
    `);
    // Table may already exist from before "brands" was added — this is a
    // no-op if the column is already there.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '[]'::jsonb;`);

    for (const category of categories) {
      await pool.query(
        `
        INSERT INTO categories (id, name, icon, image)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          icon = EXCLUDED.icon,
          image = EXCLUDED.image;
        `,
        [
          category.id,
          category.name || "",
          category.icon || "",
          category.image || ""
        ]
      );
    }

    console.log("Categories migrated.");

    for (const product of products) {
      await pool.query(
        `
        INSERT INTO products (
          id,
          name,
          category,
          price,
          old_price,
          icon,
          tag,
          image,
          description,
          brands
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          category = EXCLUDED.category,
          price = EXCLUDED.price,
          old_price = EXCLUDED.old_price,
          icon = EXCLUDED.icon,
          tag = EXCLUDED.tag,
          image = EXCLUDED.image,
          description = EXCLUDED.description,
          brands = EXCLUDED.brands;
        `,
        [
          product.id,
          product.name || "",
          product.cat || "",
          product.price ?? 0,
          product.old ?? null,
          product.icon || "",
          product.tag || "",
          product.image || "",
          product.description || "",
          JSON.stringify(product.brands || [])
        ]
      );
    }

    console.log("Products migrated.");
    console.log("Migration completed successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateProducts();
