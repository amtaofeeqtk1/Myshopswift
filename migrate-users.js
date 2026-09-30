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

async function migrateUsers() {
  const filePath = path.join(__dirname, "data", "users.json");

  try {
    console.log("Reading users.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const users = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${users.length} users.`);

    for (const user of users) {
      await pool.query(
        `
        INSERT INTO users (
          id,
          name,
          email,
          password_hash,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          email = EXCLUDED.email,
          password_hash = EXCLUDED.password_hash,
          created_at = EXCLUDED.created_at;
        `,
        [
          user.id,
          user.name || "",
          user.email,
          user.passwordHash,
          user.createdAt
        ]
      );
    }

    console.log("Users migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateUsers();
