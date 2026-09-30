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

async function migrateOrders() {
  const filePath = path.join(__dirname, "data", "orders.json");

  try {
    console.log("Reading orders.json...");

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const orders = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    console.log(`Found ${orders.length} orders.`);

    for (const order of orders) {
      await pool.query(
        `
        INSERT INTO orders (
          id,
          user_id,
          customer_name,
          customer_email,
          items,
          total,
          points_used,
          points_value,
          amount_due,
          points_deducted,
          payment_method,
          address,
          order_note,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15
        )
        ON CONFLICT (id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          customer_name = EXCLUDED.customer_name,
          customer_email = EXCLUDED.customer_email,
          items = EXCLUDED.items,
          total = EXCLUDED.total,
          points_used = EXCLUDED.points_used,
          points_value = EXCLUDED.points_value,
          amount_due = EXCLUDED.amount_due,
          points_deducted = EXCLUDED.points_deducted,
          payment_method = EXCLUDED.payment_method,
          address = EXCLUDED.address,
          order_note = EXCLUDED.order_note,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at;
        `,
        [
          order.id,
          order.userId || null,
          order.customerName || "",
          order.customerEmail || "",
          JSON.stringify(order.items || []),
          order.total ?? 0,
          order.pointsUsed ?? 0,
          order.pointsValue ?? 0,
          order.amountDue ?? order.total ?? 0,
          order.pointsDeducted ?? false,
          order.paymentMethod || "",
          JSON.stringify(order.address || {}),
          order.orderNote || "",
          order.status || "",
          order.createdAt
        ]
      );
    }

    console.log("Orders migrated successfully.");

  } catch (error) {
    console.error("Migration failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateOrders();
