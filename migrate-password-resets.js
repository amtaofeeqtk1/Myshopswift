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

async function migratePasswordResets() {
  const filePath = path.join(
    __dirname,
    "data",
    "password-resets.json"
  );

  try {
    console.log("Reading password-reset.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const resets = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${resets.length} password reset records.`);

    for (const reset of resets) {
      await pool.query(
        `
        INSERT INTO password_resets (
          id,
          user_id,
          token_hash,
          expires_at,
          used,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          token_hash = EXCLUDED.token_hash,
          expires_at = EXCLUDED.expires_at,
          used = EXCLUDED.used,
          created_at = EXCLUDED.created_at;
        `,
        [
          reset.id,
          reset.userId,
          reset.tokenHash,
          reset.expiresAt,
          reset.used ?? false,
          reset.createdAt
        ]
      );
    }

    console.log("Password reset records migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migratePasswordResets();
