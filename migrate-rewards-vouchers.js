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

async function migrateRewardsVouchers() {
  const filePath = path.join(
    __dirname,
    "data",
    "rewards-vouchers.json"
  );

  try {
    console.log("Reading rewards-vouchers.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const vouchers = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${vouchers.length} vouchers.`);

    for (const voucher of vouchers) {
      await pool.query(
        `
        INSERT INTO rewards_vouchers (
          code,
          user_id,
          points_used,
          value,
          status,
          created_at,
          redeemed_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (code)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          points_used = EXCLUDED.points_used,
          value = EXCLUDED.value,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          redeemed_at = EXCLUDED.redeemed_at;
        `,
        [
          voucher.code,
          voucher.userId,
          voucher.pointsUsed ?? 0,
          voucher.value ?? 0,
          voucher.status || "",
          voucher.createdAt,
          voucher.redeemedAt || null
        ]
      );
    }

    console.log("Rewards vouchers migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateRewardsVouchers();
