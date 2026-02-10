// const Organization = require('../models/Organization');
// const db = require('../config/database');
// const razorpay = require('../config/razorpay');
// const crypto = require('crypto');

// const billingController = {
//   async getCurrentPlan(req, res) {
//     try {
//       const organizationId = req.user.organization_id;

//       // 1️⃣ Get current plan + usage
//       const currentPlanResult = await db.query(
//         `SELECT
//           o.id            AS organization_id,
//           o.plan_id       AS current_plan_id,

//           p.id            AS plan_id,
//           p.name          AS plan_name,
//           p.price_monthly,
//           p.user_limit,
//           p.db_limit,
//           p.query_limit,
//           p.features,

//           (SELECT COUNT(*)
//            FROM users
//            WHERE organization_id = o.id
//              AND status = 'active') AS active_users,

//           (SELECT COUNT(*)
//            FROM database_connections
//            WHERE organization_id = o.id) AS db_connections,

//           (SELECT COUNT(*)
//            FROM query_history
//            WHERE organization_id = o.id
//              AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
//           ) AS queries_this_month

//         FROM organizations o
//         JOIN plans p ON o.plan_id = p.id
//         WHERE o.id = $1`,
//         [organizationId]
//       );

//       if (currentPlanResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Organization not found' });
//       }

//       const row = currentPlanResult.rows[0];

//       // 2️⃣ Usage calculation
//       const usage = {
//         users: {
//           current: Number(row.active_users),
//           limit: row.user_limit,
//           percentage: Math.min(100, (row.active_users / row.user_limit) * 100),
//         },
//         databases: {
//           current: Number(row.db_connections),
//           limit: row.db_limit,
//           percentage: Math.min(100, (row.db_connections / row.db_limit) * 100),
//         },
//         queries: {
//           current: Number(row.queries_this_month),
//           limit: row.query_limit,
//           percentage: Math.min(100, (row.queries_this_month / row.query_limit) * 100),
//         },
//       };

//       // 3️⃣ Get ALL plans
//       const allPlansResult = await db.query(
//         `SELECT
//            id,
//            name,
//            price_monthly,
//            user_limit,
//            db_limit,
//            query_limit,
//            features
//          FROM plans
//          ORDER BY price_monthly ASC`
//       );

//       // 4️⃣ Response: current plan + all plans
//       res.json({
//         success: true,

//         current_plan: {
//           id: row.plan_id,
//           name: row.plan_name,
//           price_monthly: row.price_monthly,
//           features: row.features,
//           usage,
//         },

//         plans: allPlansResult.rows.map((plan) => ({
//           id: plan.id,
//           name: plan.name,
//           price_monthly: plan.price_monthly,
//           features: plan.features,
//           limits: {
//             users: plan.user_limit,
//             databases: plan.db_limit,
//             queries: plan.query_limit,
//           },
//           is_current: plan.id === row.plan_id,
//         })),
//       });
//     } catch (error) {
//       console.error('Get current plan error:', error);
//       res.status(500).json({ error: 'Failed to fetch plan details' });
//     }
//   },

//  async createRazorpayOrder(req, res) {
//   try {
//     const { plan_id } = req.body;
//     const organizationId = req.user.organization_id;

//     const planResult = await db.query(
//       'SELECT * FROM plans WHERE id = $1',
//       [plan_id]
//     );

//     if (!planResult.rows.length) {
//       return res.status(400).json({ error: 'Invalid plan' });
//     }

//     const plan = planResult.rows[0];

//     const order = await razorpay.orders.create({
//       amount: Number(plan.price_monthly) * 100,
//       currency: 'INR',
//       receipt: `rcpt_${Date.now()}`, // ✅ FIX IS HERE
//     });

//     await db.query(
//       `INSERT INTO billing_transactions
//        (organization_id, plan_id, razorpay_order_id, amount, status)
//        VALUES ($1, $2, $3, $4, 'created')`,
//       [organizationId, plan_id, order.id, plan.price_monthly]
//     );

//     res.json({
//       order_id: order.id,
//       amount: order.amount,
//       currency: order.currency,
//       key: process.env.RAZORPAY_KEY_ID,
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Failed to create payment order' });
//   }
// }
// ,

//   async verifyRazorpayPayment(req, res) {
//     try {
//       const {
//         razorpay_order_id,
//         razorpay_payment_id,
//         razorpay_signature,
//       } = req.body;

//       const body = `${razorpay_order_id}|${razorpay_payment_id}`;

//       const expectedSignature = crypto
//         .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
//         .update(body)
//         .digest('hex');

//       if (expectedSignature !== razorpay_signature) {
//         return res.status(400).json({ error: 'Invalid payment signature' });
//       }

//       const txnResult = await db.query(
//         'SELECT * FROM billing_transactions WHERE razorpay_order_id = $1',
//         [razorpay_order_id]
//       );

//       if (!txnResult.rows.length) {
//         return res.status(404).json({ error: 'Transaction not found' });
//       }

//       const txn = txnResult.rows[0];

//       await db.query(
//         `UPDATE billing_transactions
//          SET status = 'paid', razorpay_payment_id = $1
//          WHERE razorpay_order_id = $2`,
//         [razorpay_payment_id, razorpay_order_id]
//       );

//       await Organization.updatePlan(txn.organization_id, txn.plan_id);

//       res.json({ success: true });
//     } catch (err) {
//       console.error(err);
//       res.status(500).json({ error: 'Payment verification failed' });
//     }
//   },
// };

// module.exports = billingController;





const Organization = require('../models/Organization');
const db = require('../config/database');
const razorpay = require('../config/razorpay');
const crypto = require('crypto');
const creditService = require('../services/creditService');

const billingController = {
  async getCurrentPlan(req, res) {
    try {
      const organizationId = req.user.organization_id;

      // Get current plan + usage
      const currentPlanResult = await db.query(
        `SELECT o.id AS organization_id,
                o.plan_id AS current_plan_id,
                p.id AS plan_id,
                p.name AS plan_name,
                p.price_monthly,
                p.user_limit,
                p.db_limit,
                p.query_limit,
                p.features,
                (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND status = 'active') AS active_users,
                (SELECT COUNT(*) FROM database_connections WHERE organization_id = o.id) AS db_connections,
                (SELECT COUNT(*) FROM query_history WHERE organization_id = o.id AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) AS queries_this_month
         FROM organizations o
         JOIN plans p ON o.plan_id = p.id
         WHERE o.id = $1`,
        [organizationId]
      );

      if (currentPlanResult.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      const row = currentPlanResult.rows[0];

      // Get credit balance
      const creditBalance = await creditService.getBalance(organizationId);

      const usage = {
        users: {
          current: Number(row.active_users),
          limit: row.user_limit,
          percentage: Math.min(100, (row.active_users / row.user_limit) * 100),
        },
        databases: {
          current: Number(row.db_connections),
          limit: row.db_limit,
          percentage: Math.min(100, (row.db_connections / row.db_limit) * 100),
        },
        queries: {
          current: Number(row.queries_this_month),
          limit: row.query_limit,
          percentage: Math.min(100, (row.queries_this_month / row.query_limit) * 100),
        },
        credits: creditBalance // ADD CREDIT INFO
      };

      // Get all plans
      const allPlansResult = await db.query(
        `SELECT id, name, price_monthly, user_limit, db_limit, query_limit, features
         FROM plans
         ORDER BY price_monthly ASC`
      );

      res.json({
        success: true,
        current_plan: {
          id: row.plan_id,
          name: row.plan_name,
          price_monthly: row.price_monthly,
          features: row.features,
          usage,
        },
        plans: allPlansResult.rows.map((plan) => ({
          id: plan.id,
          name: plan.name,
          price_monthly: plan.price_monthly,
          features: plan.features,
          limits: {
            users: plan.user_limit,
            databases: plan.db_limit,
            queries: plan.query_limit,
          },
          is_current: plan.id === row.plan_id,
        })),
      });
    } catch (error) {
      console.error('Get current plan error:', error);
      res.status(500).json({ error: 'Failed to fetch plan details' });
    }
  },

  async createRazorpayOrder(req, res) {
    try {
      const { plan_id } = req.body;
      const organizationId = req.user.organization_id;

      const planResult = await db.query(
        'SELECT * FROM plans WHERE id = $1',
        [plan_id]
      );

      if (!planResult.rows.length) {
        return res.status(400).json({ error: 'Invalid plan' });
      }

      const plan = planResult.rows[0];

      const order = await razorpay.orders.create({
        amount: Number(plan.price_monthly) * 100,
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`,
      });

      await db.query(
        `INSERT INTO billing_transactions (organization_id, plan_id, razorpay_order_id, amount, status)
         VALUES ($1, $2, $3, $4, 'created')`,
        [organizationId, plan_id, order.id, plan.price_monthly]
      );

      res.json({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key: process.env.RAZORPAY_KEY_ID,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create payment order' });
    }
  },

  async verifyRazorpayPayment(req, res) {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = req.body;

      const body = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid payment signature' });
      }

      const txnResult = await db.query(
        'SELECT * FROM billing_transactions WHERE razorpay_order_id = $1',
        [razorpay_order_id]
      );

      if (!txnResult.rows.length) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const txn = txnResult.rows[0];

      // Update transaction status
      await db.query(
        `UPDATE billing_transactions
         SET status = 'paid', razorpay_payment_id = $1
         WHERE razorpay_order_id = $2`,
        [razorpay_payment_id, razorpay_order_id]
      );

      // Update organization plan
      await Organization.updatePlan(txn.organization_id, txn.plan_id);

      // ✅ ALLOCATE CREDITS (ChatGPT model - reset on renewal)
      await creditService.allocateCredits(
        txn.organization_id,
        txn.plan_id,
        razorpay_payment_id
      );

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Payment verification failed' });
    }
  },

  /**
   * Get credit ledger (transaction history)
   */
  async getCreditHistory(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const { limit = 50, offset = 0 } = req.query;

      const result = await db.query(
        `SELECT * FROM credit_ledger
         WHERE organization_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [organizationId, limit, offset]
      );

      res.json({
        success: true,
        transactions: result.rows
      });
    } catch (error) {
      console.error('Get credit history error:', error);
      res.status(500).json({ error: 'Failed to fetch credit history' });
    }
  }
};

module.exports = billingController;