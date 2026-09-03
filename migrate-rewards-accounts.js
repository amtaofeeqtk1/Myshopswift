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

async function migrateRewardsAccounts() {
  const filePath = path.join(
    __dirname,
    "data",
    "rewards-accounts.json"
  );

  try {
    console.log("Reading rewards-accounts.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const accounts = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${accounts.length} reward accounts.`);

    for (const account of accounts) {
      await pool.query(
        `
        INSERT INTO rewards_accounts (
          user_id,
          points_balance,
          referral_code,
          referred_by,
          signup_bonus_awarded,
          qualifying_purchase_count,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id)
        DO UPDATE SET
          points_balance = EXCLUDED.points_balance,
          referral_code = EXCLUDED.referral_code,
          referred_by = EXCLUDED.referred_by,
          signup_bonus_awarded = EXCLUDED.signup_bonus_awarded,
          qualifying_purchase_count = EXCLUDED.qualifying_purchase_count,
          created_at = EXCLUDED.created_at;
        `,
        [
          account.userId,
          account.pointsBalance ?? 0,
          account.referralCode || null,
          account.referredBy || null,
          account.signupBonusAwarded ?? false,
          account.qualifyingPurchaseCount ?? 0,
          account.createdAt
        ]
      );
    }

    console.log("Rewards accounts migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateRewardsAccounts();
