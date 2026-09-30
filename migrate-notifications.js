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

async function migrateNotifications() {
  const filePath = path.join(
    __dirname,
    "data",
    "notifications.json"
  );

  try {
    console.log("Reading notifications.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const notifications = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${notifications.length} notifications.`);

    for (const notification of notifications) {
      await pool.query(
        `
        INSERT INTO notifications (
          id,
          type,
          title,
          message,
          order_id,
          customer_id,
          dedupe_key,
          read,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id)
        DO UPDATE SET
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          message = EXCLUDED.message,
          order_id = EXCLUDED.order_id,
          customer_id = EXCLUDED.customer_id,
          dedupe_key = EXCLUDED.dedupe_key,
          read = EXCLUDED.read,
          created_at = EXCLUDED.created_at;
        `,
        [
          notification.id,
          notification.type || "",
          notification.title || "",
          notification.message || "",
          notification.orderId || null,
          notification.customerId || null,
          notification.dedupeKey || null,
          notification.read ?? false,
          notification.createdAt
        ]
      );
    }

    console.log("Notifications migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateNotifications();
