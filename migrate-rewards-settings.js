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

async function migrateRewardsSettings() {
  const filePath = path.join(
    __dirname,
    "data",
    "rewards-settings.json"
  );

  try {
    console.log("Reading rewards-settings.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const settings = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    await pool.query(
      `
      INSERT INTO rewards_settings (
        id,
        account_creation,
        purchase_amount_per_point,
        referral,
        review,
        repeat_purchase_bonus,
        voucher_points_per_pound,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id)
      DO UPDATE SET
        account_creation = EXCLUDED.account_creation,
        purchase_amount_per_point = EXCLUDED.purchase_amount_per_point,
        referral = EXCLUDED.referral,
        review = EXCLUDED.review,
        repeat_purchase_bonus = EXCLUDED.repeat_purchase_bonus,
        voucher_points_per_pound = EXCLUDED.voucher_points_per_pound,
        updated_at = EXCLUDED.updated_at;
      `,
      [
        1,
        settings.accountCreation ?? 0,
        settings.purchaseAmountPerPoint ?? 0,
        settings.referral ?? 0,
        settings.review ?? 0,
        settings.repeatPurchaseBonus ?? 0,
        settings.voucherPointsPerPound ?? 0,
        settings.updatedAt
      ]
    );

    console.log("Rewards settings migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateRewardsSettings();
