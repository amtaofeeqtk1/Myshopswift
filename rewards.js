// MyShopSwift — Rewards / Loyalty system
//
// Postgres-backed (matches the verified schema for rewards_accounts,
// rewards_settings, rewards_transactions, rewards_vouchers, and the new
// rewards_referrals table). Every operation that changes a points balance
// runs inside a real transaction with `SELECT ... FOR UPDATE` on the
// account row, so concurrent requests for the same user can never race on
// the balance the way they could once this moved off the old JSON file's
// accidental single-threaded safety. Nothing in this file trusts a point
// value, voucher value, or reward amount coming from the client — only
// user IDs, order IDs, and small user-entered strings (a reason, a
// referral code) are ever accepted from a request body.

const crypto = require("crypto");

module.exports = function (db) {

const DEFAULT_SETTINGS = {
  accountCreation: 10,        // points awarded once, on registration
  purchaseAmountPerPoint: 10, // £ spent per 1 point (e.g. 10 => £10 = 1pt)
  referral: 10,                // points awarded to the referrer
  review: 10,                  // points awarded for a qualifying product review
  repeatPurchaseBonus: 10,     // bonus points on a qualifying repeat order
  voucherPointsPerPound: 10    // points required per £1 of voucher value
};

// ---------- row -> JS shape (matches the camelCase shape the rest of the
// app already expects, since it used to come straight out of JSON) ----------
function rowToAccount(row) {
  return {
    userId: row.user_id,
    pointsBalance: Number(row.points_balance),
    referralCode: row.referral_code,
    referredBy: row.referred_by,
    signupBonusAwarded: !!row.signup_bonus_awarded,
    qualifyingPurchaseCount: row.qualifying_purchase_count || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}
function rowToSettings(row) {
  return {
    accountCreation: Number(row.account_creation),
    purchaseAmountPerPoint: Number(row.purchase_amount_per_point),
    referral: Number(row.referral),
    review: Number(row.review),
    repeatPurchaseBonus: Number(row.repeat_purchase_bonus),
    voucherPointsPerPound: Number(row.voucher_points_per_pound),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}
function rowToTransaction(row) {
  return {
    id: row.id,
    userId: row.user_id,
    points: Number(row.points),
    type: row.type,
    reason: row.reason || "",
    orderId: row.order_id,
    referralId: row.referral_id,
    refId: row.ref_id,
    balanceAfter: Number(row.balance_after),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}
function rowToVoucher(row) {
  return {
    code: row.code,
    userId: row.user_id,
    pointsUsed: Number(row.points_used),
    value: Number(row.value),
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    redeemedAt: row.redeemed_at ? (row.redeemed_at instanceof Date ? row.redeemed_at.toISOString() : row.redeemed_at) : null
  };
}
function rowToReferral(row) {
  return {
    id: row.id,
    referrerUserId: row.referrer_user_id,
    referredUserId: row.referred_user_id,
    referralCodeUsed: row.referral_code_used,
    status: row.status,
    qualifyingOrderId: row.qualifying_order_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    rewardedAt: row.rewarded_at ? (row.rewarded_at instanceof Date ? row.rewarded_at.toISOString() : row.rewarded_at) : null
  };
}

async function withTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (e) { /* connection already broken */ }
    throw error;
  } finally {
    client.release();
  }
}

// ---------- settings (singleton row, id = 1) ----------
async function readSettings() {
  const result = await db.query(`SELECT * FROM rewards_settings WHERE id = 1`);
  if (result.rows.length) return rowToSettings(result.rows[0]);

  // First-ever read: seed the singleton row with defaults.
  const now = new Date().toISOString();
  const inserted = await db.query(
    `INSERT INTO rewards_settings (id, account_creation, purchase_amount_per_point, referral, review, repeat_purchase_bonus, voucher_points_per_pound, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [
      DEFAULT_SETTINGS.accountCreation, DEFAULT_SETTINGS.purchaseAmountPerPoint, DEFAULT_SETTINGS.referral,
      DEFAULT_SETTINGS.review, DEFAULT_SETTINGS.repeatPurchaseBonus, DEFAULT_SETTINGS.voucherPointsPerPound, now
    ]
  );
  return rowToSettings(inserted.rows[0]);
}

const SETTINGS_FIELDS = [
  "accountCreation", "purchaseAmountPerPoint", "referral",
  "review", "repeatPurchaseBonus", "voucherPointsPerPound"
];
const SETTINGS_FIELD_TO_COLUMN = {
  accountCreation: "account_creation",
  purchaseAmountPerPoint: "purchase_amount_per_point",
  referral: "referral",
  review: "review",
  repeatPurchaseBonus: "repeat_purchase_bonus",
  voucherPointsPerPound: "voucher_points_per_pound"
};

function validateSettingsPayload(body) {
  if (!body || typeof body !== "object") return "Payload must be an object";
  for (const field of SETTINGS_FIELDS) {
    const v = body[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `"${field}" must be a positive number`;
    }
  }
  return null;
}

async function updateSettings(body) {
  await readSettings(); // ensure the singleton row exists first
  const now = new Date().toISOString();
  const result = await db.query(
    `UPDATE rewards_settings SET
       account_creation = $1, purchase_amount_per_point = $2, referral = $3,
       review = $4, repeat_purchase_bonus = $5, voucher_points_per_pound = $6,
       updated_at = $7
     WHERE id = 1 RETURNING *`,
    [
      body.accountCreation, body.purchaseAmountPerPoint, body.referral,
      body.review, body.repeatPurchaseBonus, body.voucherPointsPerPound, now
    ]
  );
  return rowToSettings(result.rows[0]);
}

// ---------- referral / voucher code generation (uniqueness checked live
// against the table, same approach as the old in-memory check) ----------
async function generateUniqueReferralCode(client) {
  let code, exists = true;
  while (exists) {
    const suffix = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
    code = `MSWIFT-${suffix}`;
    const check = await client.query(`SELECT 1 FROM rewards_accounts WHERE referral_code = $1 LIMIT 1`, [code]);
    exists = check.rows.length > 0;
  }
  return code;
}
async function generateUniqueVoucherCode(client) {
  let code, exists = true;
  while (exists) {
    const suffix = crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
    code = `MSWIFT-${suffix}`;
    const check = await client.query(`SELECT 1 FROM rewards_vouchers WHERE code = $1 LIMIT 1`, [code]);
    exists = check.rows.length > 0;
  }
  return code;
}

// ---------- accounts ----------
async function getAccount(userId) {
  const result = await db.query(`SELECT * FROM rewards_accounts WHERE user_id = $1`, [userId]);
  return result.rows.length ? rowToAccount(result.rows[0]) : null;
}

// Creates (and persists) a rewards account for a user if one doesn't exist
// yet. Safe to call repeatedly/concurrently — a unique-violation race on
// the insert just falls back to reading the row the other caller created.
// `referredBy` is only ever set at creation time and is never changed
// afterwards by any other function in this file.
async function getOrCreateAccount(userId, referredBy = null) {
  return withTransaction(async client => {
    const existing = await client.query(`SELECT * FROM rewards_accounts WHERE user_id = $1`, [userId]);
    if (existing.rows.length) return rowToAccount(existing.rows[0]);

    try {
      const code = await generateUniqueReferralCode(client);
      const inserted = await client.query(
        `INSERT INTO rewards_accounts (user_id, points_balance, referral_code, referred_by, signup_bonus_awarded, qualifying_purchase_count, created_at)
         VALUES ($1, 0, $2, $3, false, 0, $4) RETURNING *`,
        [userId, code, referredBy || null, new Date().toISOString()]
      );
      return rowToAccount(inserted.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        const retry = await client.query(`SELECT * FROM rewards_accounts WHERE user_id = $1`, [userId]);
        if (retry.rows.length) return rowToAccount(retry.rows[0]);
      }
      throw error;
    }
  });
}

// ---------- the ledger (source of truth) ----------
async function hasTransaction(client, type, refId) {
  if (!refId) return false;
  const result = await client.query(
    `SELECT 1 FROM rewards_transactions WHERE type = $1 AND ref_id = $2 LIMIT 1`,
    [type, refId]
  );
  return result.rows.length > 0;
}

// Awards (or deducts, for negative `points`) points for a user and records a
// transaction. Idempotent when `refId` is provided: if a transaction with
// the same type+refId already exists, this is a no-op and returns null —
// callers use that to detect "already awarded" and avoid double-counting.
// Returns the created transaction, {error} if rejected, or null if skipped.
// The account row is locked (SELECT ... FOR UPDATE) for the duration of
// this transaction, so two concurrent calls for the same user can never
// both read the same starting balance.
async function awardPoints({ userId, type, points, reason, orderId = null, referralId = null, refId = null, allowNegativeBalance = false }) {
  if (!userId || !type || !Number.isFinite(points) || points === 0) return null;

  return withTransaction(async client => {
    if (refId && await hasTransaction(client, type, refId)) return null; // already processed

    let account;
    const locked = await client.query(`SELECT * FROM rewards_accounts WHERE user_id = $1 FOR UPDATE`, [userId]);
    if (locked.rows.length) {
      account = rowToAccount(locked.rows[0]);
    } else {
      try {
        const code = await generateUniqueReferralCode(client);
        const inserted = await client.query(
          `INSERT INTO rewards_accounts (user_id, points_balance, referral_code, referred_by, signup_bonus_awarded, qualifying_purchase_count, created_at)
           VALUES ($1, 0, $2, NULL, false, 0, $3) RETURNING *`,
          [userId, code, new Date().toISOString()]
        );
        account = rowToAccount(inserted.rows[0]);
      } catch (error) {
        if (error.code !== "23505") throw error;
        const retry = await client.query(`SELECT * FROM rewards_accounts WHERE user_id = $1 FOR UPDATE`, [userId]);
        account = rowToAccount(retry.rows[0]);
      }
    }

    const newBalance = Math.round((account.pointsBalance + points) * 100) / 100;
    if (newBalance < 0 && !allowNegativeBalance) return { error: "insufficient_points" };

    const txId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const txResult = await client.query(
      `INSERT INTO rewards_transactions (id, user_id, points, type, reason, order_id, referral_id, ref_id, balance_after, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [txId, userId, points, type, reason || "", orderId, referralId, refId, newBalance, createdAt]
    );
    await client.query(`UPDATE rewards_accounts SET points_balance = $1 WHERE user_id = $2`, [newBalance, userId]);

    return rowToTransaction(txResult.rows[0]);
  });
}

// ---------- signup ----------
async function awardSignupBonus(userId, referredByCode) {
  const settings = await readSettings();

  let referrerUserId = null;
  if (referredByCode && typeof referredByCode === "string") {
    const codeUpper = referredByCode.trim().toUpperCase();
    const referrerResult = await db.query(`SELECT user_id FROM rewards_accounts WHERE referral_code = $1`, [codeUpper]);
    if (referrerResult.rows.length && referrerResult.rows[0].user_id !== userId) {
      referrerUserId = referrerResult.rows[0].user_id;
    }
  }

  const account = await getOrCreateAccount(userId, referrerUserId);

  if (referrerUserId) {
    const already = await db.query(`SELECT 1 FROM rewards_referrals WHERE referred_user_id = $1 LIMIT 1`, [userId]);
    if (!already.rows.length) {
      await db.query(
        `INSERT INTO rewards_referrals (id, referrer_user_id, referred_user_id, referral_code_used, status, qualifying_order_id, created_at, rewarded_at)
         VALUES ($1,$2,$3,$4,'pending',NULL,$5,NULL)`,
        [crypto.randomUUID(), referrerUserId, userId, referredByCode.trim().toUpperCase(), new Date().toISOString()]
      );
    }
  }

  if (!account.signupBonusAwarded) {
    const tx = await awardPoints({
      userId, type: "signup", points: settings.accountCreation,
      reason: "Account registration", refId: `signup:${userId}`
    });
    if (tx && !tx.error) {
      await db.query(`UPDATE rewards_accounts SET signup_bonus_awarded = true WHERE user_id = $1`, [userId]);
    }
  }

  return account;
}

// ---------- purchases ----------
// Called when an order transitions INTO the qualifying "delivered" status.
// Idempotent per order (safe to call more than once for the same order) —
// awardPoints's refId dedup (type="purchase", refId=order.id) does the
// actual guarding; the check here just avoids doing unnecessary work.
async function processQualifyingPurchase(order, settings) {
  settings = settings || await readSettings();

  const already = await db.query(
    `SELECT 1 FROM rewards_transactions WHERE type = 'purchase' AND ref_id = $1 LIMIT 1`,
    [order.id]
  );
  if (already.rows.length) return; // already processed

  const points = Math.floor(order.total / settings.purchaseAmountPerPoint);
  const account = (await getAccount(order.userId)) || (await getOrCreateAccount(order.userId));
  const isRepeat = account.qualifyingPurchaseCount > 0;

  if (points > 0) {
    await awardPoints({
      userId: order.userId, type: "purchase", points,
      reason: `Order #${order.id.slice(0, 8)}`, orderId: order.id, refId: order.id
    });
  }

  if (isRepeat) {
    await awardPoints({
      userId: order.userId, type: "repeat_bonus", points: settings.repeatPurchaseBonus,
      reason: "Repeat purchase bonus", orderId: order.id, refId: order.id
    });
  }

  // Referral payout: only on this customer's FIRST qualifying purchase.
  if (!isRepeat && account.referredBy) {
    const referralResult = await db.query(
      `SELECT * FROM rewards_referrals WHERE referred_user_id = $1 AND referrer_user_id = $2 AND status = 'pending' LIMIT 1`,
      [order.userId, account.referredBy]
    );
    if (referralResult.rows.length) {
      const referral = rowToReferral(referralResult.rows[0]);
      const tx = await awardPoints({
        userId: referral.referrerUserId, type: "referral", points: settings.referral,
        reason: "Successful referral", orderId: order.id, referralId: referral.id, refId: referral.id
      });
      if (tx && !tx.error) {
        await db.query(
          `UPDATE rewards_referrals SET status = 'rewarded', qualifying_order_id = $1, rewarded_at = $2 WHERE id = $3`,
          [order.id, new Date().toISOString(), referral.id]
        );
      }
    }
  }

  // Bump the qualifying-purchase counter last, once, for this order.
  await db.query(
    `UPDATE rewards_accounts SET qualifying_purchase_count = COALESCE(qualifying_purchase_count, 0) + 1 WHERE user_id = $1`,
    [order.userId]
  );
}

// Called when an order moves AWAY from "delivered" (e.g. cancelled after the
// fact). Reverses any purchase/repeat-bonus/referral points already awarded
// for that order via new negative transactions — never a silent balance edit.
async function reverseQualifyingPurchase(order) {
  const result = await db.query(
    `SELECT * FROM rewards_transactions WHERE order_id = $1 AND type = ANY($2::text[])`,
    [order.id, ["purchase", "repeat_bonus", "referral"]]
  );
  const toReverse = result.rows.map(rowToTransaction);

  for (const tx of toReverse) {
    const reversalRefId = `reversal:${tx.id}`;
    const already = await db.query(
      `SELECT 1 FROM rewards_transactions WHERE type = 'reversal' AND ref_id = $1 LIMIT 1`,
      [reversalRefId]
    );
    if (already.rows.length) continue;

    await awardPoints({
      userId: tx.userId, type: "reversal", points: -tx.points,
      reason: `Reversal: ${tx.reason}`, orderId: order.id, referralId: tx.referralId,
      refId: reversalRefId, allowNegativeBalance: true
    });

    if (tx.type === "referral" && tx.referralId) {
      await db.query(
        `UPDATE rewards_referrals SET status = 'reversed' WHERE id = $1 AND status = 'rewarded'`,
        [tx.referralId]
      );
    }
  }
}

// ---------- product reviews ----------
// No review system exists in MyShopSwift yet. This function is the prepared
// hook for one: call it with a stable, unique reviewId once a review is
// created/approved, and it will award points exactly once per reviewId. It
// is intentionally NOT wired to any HTTP route — a customer-facing endpoint
// that awarded points for an arbitrary reviewId with nothing to validate it
// against would let customers self-award points. Wire this into the real
// review-creation code path when that feature is built.
async function awardReviewPoints(userId, reviewId) {
  const settings = await readSettings();
  return awardPoints({
    userId, type: "review", points: settings.review,
    reason: "Product review", refId: `review:${reviewId}`
  });
}

// ---------- redemption ----------
// The points deduction (awardPoints) and voucher creation are two separate
// statements rather than one DB transaction, so if voucher creation fails
// after points were already deducted, the deduction is explicitly reversed
// (refunded) rather than leaving the customer's points gone with no
// voucher to show for it.
async function redeemPoints(userId, points) {
  const settings = await readSettings();
  if (!Number.isInteger(points) || points <= 0) return { error: "Enter a whole number of points to redeem" };
  if (points % settings.voucherPointsPerPound !== 0) {
    return { error: `Points must be redeemed in multiples of ${settings.voucherPointsPerPound}` };
  }
  const account = await getAccount(userId);
  if (!account || account.pointsBalance < points) return { error: "You don't have enough points for this voucher" };

  const value = Math.round((points / settings.voucherPointsPerPound) * 100) / 100;
  const redemptionRefId = crypto.randomUUID();

  const tx = await awardPoints({
    userId, type: "redemption", points: -points,
    reason: `Redeemed £${value} voucher`, refId: redemptionRefId
  });
  if (!tx || tx.error) return { error: "Could not redeem points" };

  try {
    const code = await generateUniqueVoucherCode(db);
    const inserted = await db.query(
      `INSERT INTO rewards_vouchers (code, user_id, points_used, value, status, created_at, redeemed_at)
       VALUES ($1,$2,$3,$4,'active',$5,NULL) RETURNING *`,
      [code, userId, points, value, new Date().toISOString()]
    );
    return { voucher: rowToVoucher(inserted.rows[0]), transaction: tx };
  } catch (error) {
    console.error("[rewards] Voucher creation failed after points were deducted — refunding:", error.message);
    await awardPoints({
      userId, type: "redemption_reversal", points,
      reason: "Refund: voucher could not be created", refId: `redemption-reversal:${redemptionRefId}`,
      allowNegativeBalance: true
    }).catch(e => console.error("[rewards] CRITICAL: failed to refund after failed voucher creation:", e.message));
    return { error: "Could not redeem points" };
  }
}

// ---------- admin manual adjustment ----------
async function adjustPointsByAdmin(userId, points, reason) {
  if (!Number.isInteger(points) || points === 0) return { error: "Enter a non-zero whole number of points" };
  if (!reason || typeof reason !== "string" || !reason.trim()) return { error: "A reason is required" };

  const account = (await getAccount(userId)) || (await getOrCreateAccount(userId));
  if (account.pointsBalance + points < 0) return { error: "This adjustment would take the customer below zero points" };

  const tx = await awardPoints({ userId, type: "admin_adjustment", points, reason: reason.trim() });
  if (!tx || tx.error) return { error: tx && tx.error === "insufficient_points" ? "This adjustment would take the customer below zero points" : "Could not apply adjustment" };
  return { transaction: tx };
}

// ---------- admin read models ----------
async function readAccounts() {
  const result = await db.query(`SELECT * FROM rewards_accounts ORDER BY created_at DESC`);
  return result.rows.map(rowToAccount);
}
async function readTransactions() {
  const result = await db.query(`SELECT * FROM rewards_transactions ORDER BY created_at DESC`);
  return result.rows.map(rowToTransaction);
}
async function readVouchers() {
  const result = await db.query(`SELECT * FROM rewards_vouchers ORDER BY created_at DESC`);
  return result.rows.map(rowToVoucher);
}
async function readReferrals() {
  const result = await db.query(`SELECT * FROM rewards_referrals ORDER BY created_at DESC`);
  return result.rows.map(rowToReferral);
}

async function overview() {
  const [issuedResult, redeemedResult, memberResult, referralResult, voucherResult] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(points), 0) AS total FROM rewards_transactions WHERE points > 0`),
    db.query(`SELECT COALESCE(SUM(ABS(points)), 0) AS total FROM rewards_transactions WHERE type = 'redemption'`),
    db.query(`SELECT COUNT(*)::int AS count FROM rewards_accounts`),
    db.query(`SELECT COUNT(*)::int AS count FROM rewards_referrals WHERE status = 'rewarded'`),
    db.query(`SELECT COUNT(*)::int AS count FROM rewards_vouchers`)
  ]);
  return {
    totalPointsIssued: Number(issuedResult.rows[0].total),
    totalPointsRedeemed: Number(redeemedResult.rows[0].total),
    memberCount: memberResult.rows[0].count,
    successfulReferrals: referralResult.rows[0].count,
    vouchersGenerated: voucherResult.rows[0].count
  };
}

return {
  readSettings, updateSettings, validateSettingsPayload,
  readAccounts, getAccount, getOrCreateAccount,
  readTransactions,
  readReferrals,
  readVouchers,
  awardPoints, awardSignupBonus,
  processQualifyingPurchase, reverseQualifyingPurchase,
  awardReviewPoints,
  redeemPoints, adjustPointsByAdmin,
  overview
};

};
