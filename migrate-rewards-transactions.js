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

async function migrateRewardsTransactions() {
  const filePath = path.join(
    __dirname,
    "data",
    "rewards-transactions.json"
  );

  try {
    console.log("Reading rewards-transactions.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const transactions = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${transactions.length} transactions.`);

    for (const transaction of transactions) {
      await pool.query(
        `
        INSERT INTO rewards_transactions (
          id,
          user_id,
          points,
          type,
          reason,
          order_id,
          referral_id,
          ref_id,
          balance_after,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          points = EXCLUDED.points,
          type = EXCLUDED.type,
          reason = EXCLUDED.reason,
          order_id = EXCLUDED.order_id,
          referral_id = EXCLUDED.referral_id,
          ref_id = EXCLUDED.ref_id,
          balance_after = EXCLUDED.balance_after,
          created_at = EXCLUDED.created_at;
        `,
        [
          transaction.id,
          transaction.userId,
          transaction.points ?? 0,
          transaction.type || "",
          transaction.reason || "",
          transaction.orderId || null,
          transaction.referralId || null,
          transaction.refId || null,
          transaction.balanceAfter ?? 0,
          transaction.createdAt
        ]
      );
    }

    console.log("Rewards transactions migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateRewardsTransactions();
