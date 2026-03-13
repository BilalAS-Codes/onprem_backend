const Organization = require('../models/Organization');
const db = require('../config/database');
const razorpay = require('../config/razorpay');
const crypto = require('crypto');
const creditService = require('../services/creditService');
const emailService = require('../services/emailService');

const ensurePlanChangeTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS billing_plan_changes (
      id SERIAL PRIMARY KEY,
      organization_id UUID NOT NULL,
      from_plan_id UUID NOT NULL,
      to_plan_id UUID NOT NULL,
      effective_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
      transaction_id INTEGER NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`
  );
};

const getPendingPlanChange = async (organizationId) => {
  await ensurePlanChangeTable();
  const res = await db.query(
    `SELECT bpc.*, p.name AS to_plan_name
     FROM billing_plan_changes bpc
     LEFT JOIN plans p ON bpc.to_plan_id = p.id
     WHERE bpc.organization_id = $1 AND bpc.status = 'scheduled'
     ORDER BY bpc.created_at DESC
     LIMIT 1`,
    [organizationId]
  );
  return res.rows[0] || null;
};

const applyDuePlanChanges = async (organizationId) => {
  await ensurePlanChangeTable();
  const dueRes = await db.query(
    `SELECT * FROM billing_plan_changes
     WHERE organization_id = $1 AND status = 'scheduled' AND effective_date <= CURRENT_DATE
     ORDER BY effective_date ASC`,
    [organizationId]
  );

  for (const change of dueRes.rows) {
    try {
      await Organization.updatePlan(change.organization_id, change.to_plan_id);
      try {
        await creditService.allocateCredits(
          change.organization_id,
          change.to_plan_id,
          change.transaction_id || null
        );
      } catch (allocErr) {
        console.error('allocateCredits failed during scheduled change:', allocErr);
      }
      await db.query(
        `UPDATE billing_plan_changes
         SET status = 'applied', updated_at = NOW()
         WHERE id = $1`,
        [change.id]
      );
    } catch (err) {
      console.error('Failed to apply scheduled plan change:', err);
    }
  }
};

const billingController = {
  async getCurrentPlan(req, res) {
    try {
      const organizationId = req.user.organization_id;

      // Apply any due scheduled changes before returning plan
      await applyDuePlanChanges(organizationId);

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
         LEFT JOIN plans p ON o.plan_id = p.id
         WHERE o.id = $1`,
        [organizationId]
      );

      if (currentPlanResult.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      const row = currentPlanResult.rows[0];

      // Get credit balance
      const creditBalance = await creditService.getBalance(organizationId);

      const safePercent = (current, limit) => {
        if (!limit || Number(limit) <= 0) return 0;
        return Math.min(100, (Number(current) / Number(limit)) * 100);
      };

      // Get all plans
      const allPlansResult = await db.query(
        `SELECT id, name, price_monthly, user_limit, db_limit, query_limit, features
         FROM plans
         ORDER BY price_monthly ASC`
      );

      const pendingChange = await getPendingPlanChange(organizationId);

      const currentPlan = row.plan_id
        ? {
          id: row.plan_id,
          name: row.plan_name,
          price_monthly: row.price_monthly,
          features: row.features,
          usage: {
            users: {
              current: Number(row.active_users),
              limit: row.user_limit,
              percentage: safePercent(row.active_users, row.user_limit),
            },
            databases: {
              current: Number(row.db_connections),
              limit: row.db_limit,
              percentage: safePercent(row.db_connections, row.db_limit),
            },
            queries: {
              current: Number(row.queries_this_month),
              limit: row.query_limit,
              percentage: safePercent(row.queries_this_month, row.query_limit),
            },
            credits: creditBalance // ADD CREDIT INFO
          },
          pending_change: pendingChange
            ? {
              to_plan_id: pendingChange.to_plan_id,
              to_plan_name: pendingChange.to_plan_name,
              effective_date: pendingChange.effective_date
            }
            : null
        }
        : null;

      res.json({
        success: true,
        current_plan: currentPlan,
        credits: creditBalance,
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
          is_current: row.plan_id ? plan.id === row.plan_id : false,
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

      // Insert transaction. Some DBs may not have the `receipt` column, so try with receipt first
      try {
        await db.query(
          `INSERT INTO billing_transactions (organization_id, plan_id, razorpay_order_id, amount, status, receipt)
           VALUES ($1, $2, $3, $4, 'created', $5) RETURNING id`,
          [organizationId, plan_id, order.id, plan.price_monthly, order.receipt || '']
        );
      } catch (insertErr) {
        // If column doesn't exist (Postgres 42703), retry without receipt
        if (insertErr && insertErr.code === '42703') {
          await db.query(
            `INSERT INTO billing_transactions (organization_id, plan_id, razorpay_order_id, amount, status)
             VALUES ($1, $2, $3, $4, 'created') RETURNING id`,
            [organizationId, plan_id, order.id, plan.price_monthly]
          );
        } else {
          throw insertErr;
        }
      }

      // Return order details + txn id (helpful for frontend to correlate)
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

      console.info('verifyRazorpayPayment called with body:', { razorpay_order_id, razorpay_payment_id, razorpay_signature });

      const body = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

      console.info('Computed signature:', expectedSignature);
      if (expectedSignature !== razorpay_signature) {
        console.warn('Signature mismatch', { expectedSignature, received: razorpay_signature });
      }

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid payment signature' });
      }

      const txnResult = await db.query(
        'SELECT * FROM billing_transactions WHERE razorpay_order_id = $1',
        [razorpay_order_id]
      );

      console.info('billing_transactions lookup count:', txnResult.rows.length);

      if (!txnResult.rows.length) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const txn = txnResult.rows[0];

      // Update transaction status and payment id (avoid assuming `updated_at` column exists)
      await db.query(
        `UPDATE billing_transactions
         SET status = 'paid', razorpay_payment_id = $1
         WHERE razorpay_order_id = $2`,
        [razorpay_payment_id, razorpay_order_id]
      );

      // Ensure plan exists on transaction before proceeding
      if (!txn.plan_id) {
        console.error('Transaction has no plan_id:', txn.id);
        return res.status(400).json({ error: 'Transaction missing plan information' });
      }

      // Decide if upgrade or downgrade based on price
      const currentPlanRes = await db.query(
        `SELECT p.id, p.price_monthly
         FROM organizations o
         JOIN plans p ON o.plan_id = p.id
         WHERE o.id = $1`,
        [txn.organization_id]
      );
      const newPlanRes = await db.query(
        `SELECT id, price_monthly, name FROM plans WHERE id = $1`,
        [txn.plan_id]
      );
      const currentPrice = Number(currentPlanRes.rows[0]?.price_monthly || 0);
      const newPrice = Number(newPlanRes.rows[0]?.price_monthly || 0);
      const isDowngrade = newPrice < currentPrice;

      if (isDowngrade) {
        // Schedule downgrade at end of current period
        const quota = await creditService.getActiveQuota(txn.organization_id);
        const effectiveDate = quota?.expiration_date || new Date();

        await ensurePlanChangeTable();
        const existing = await db.query(
          `SELECT id FROM billing_plan_changes
           WHERE organization_id = $1 AND status = 'scheduled'
           ORDER BY created_at DESC LIMIT 1`,
          [txn.organization_id]
        );

        if (existing.rows.length) {
          await db.query(
            `UPDATE billing_plan_changes
             SET to_plan_id = $1,
                 effective_date = $2,
                 transaction_id = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [txn.plan_id, effectiveDate, txn.id, existing.rows[0].id]
          );
        } else {
          await db.query(
            `INSERT INTO billing_plan_changes (organization_id, from_plan_id, to_plan_id, effective_date, status, transaction_id)
             VALUES ($1, $2, $3, $4, 'scheduled', $5)`,
            [txn.organization_id, currentPlanRes.rows[0]?.id, txn.plan_id, effectiveDate, txn.id]
          );
        }

        // Send plan change email (scheduled)
        try {
          const plan = newPlanRes.rows[0] || {};
          await emailService.sendPlanChange({
            to: req.user?.email,
            plan_name: plan.name || 'Unknown Plan',
            price_monthly: plan.price_monthly,
            payment_id: razorpay_payment_id,
            effective_date: effectiveDate,
            scheduled: true
          });
        } catch (emailErr) {
          console.warn('Failed to send plan change email:', emailErr?.message || emailErr);
        }

        return res.json({ success: true, scheduled: true, effective_date: effectiveDate });
      }

      // Upgrade: apply immediately
      await Organization.updatePlan(txn.organization_id, txn.plan_id);

      // Resolve quota_plans.id for this plan (if exists) to pass explicitly
      let quotaPlanId = null;
      try {
        const qres = await db.query(
          `SELECT qp.id FROM quota_plans qp
           JOIN plans p ON qp.plan_name = p.name
           WHERE p.id = $1 LIMIT 1`,
          [txn.plan_id]
        );
        if (qres.rows.length) quotaPlanId = qres.rows[0].id;
      } catch (e) {
        console.warn('Failed to resolve quota_plan mapping:', e.message);
      }

      // Allocate credits (if any) for the purchased plan. Prefer explicit quotaPlanId when available.
      try {
        await creditService.allocateCredits(
          txn.organization_id,
          quotaPlanId || txn.plan_id,
          razorpay_payment_id
        );
      } catch (allocErr) {
        console.error('allocateCredits failed:', allocErr);
        // Return success for payment but include a warning so frontend can surface it.
        return res.status(200).json({ success: true, warning: 'Payment processed but credit allocation failed' });
      }

      // Send plan change email (best-effort)
      try {
        const plan = newPlanRes.rows[0] || {};
        await emailService.sendPlanChange({
          to: req.user?.email,
          plan_name: plan.name || 'Unknown Plan',
          price_monthly: plan.price_monthly,
          payment_id: razorpay_payment_id,
          scheduled: false
        });
      } catch (emailErr) {
        console.warn('Failed to send plan change email:', emailErr?.message || emailErr);
      }

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Payment verification failed' });
    }
  },

  /**
   * Get invoices (billing transactions) for org
   */
  async getInvoices(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size, 10) || 10));
      const search = (req.query.search || '').toString().trim();
      const status = (req.query.status || 'all').toString().trim().toLowerCase();

      const params = [organizationId];
      let whereClause = 'bt.organization_id = $1';

      if (status && status !== 'all') {
        params.push(status);
        whereClause += ` AND lower(bt.status) = $${params.length}`;
      }

      if (search) {
        params.push(`%${search}%`);
        whereClause += ` AND (
          p.name ILIKE $${params.length}
          OR bt.razorpay_order_id ILIKE $${params.length}
          OR bt.razorpay_payment_id ILIKE $${params.length}
          OR bt.status ILIKE $${params.length}
        )`;
      }

      const baseFrom = `FROM billing_transactions bt
                        LEFT JOIN plans p ON bt.plan_id = p.id`;

      const countRes = await db.query(
        `SELECT COUNT(*) ${baseFrom} WHERE ${whereClause}`,
        params
      );

      const offset = (page - 1) * pageSize;
      const dataRes = await db.query(
        `SELECT bt.*, p.name AS plan_name
         ${baseFrom}
         WHERE ${whereClause}
         ORDER BY bt.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      );

      res.json({
        success: true,
        items: dataRes.rows || [],
        pagination: {
          page,
          page_size: pageSize,
          total: Number(countRes.rows[0]?.count || 0)
        }
      });
    } catch (error) {
      console.error('Get invoices error:', error);
      res.status(500).json({ error: 'Failed to fetch invoices' });
    }
  },

  /**
   * Pay pending invoice (reuse existing Razorpay order if present)
   */
  async payInvoice(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const invoiceId = req.params.id;

      const txnRes = await db.query(
        `SELECT bt.*, p.price_monthly
         FROM billing_transactions bt
         LEFT JOIN plans p ON bt.plan_id = p.id
         WHERE bt.id = $1 AND bt.organization_id = $2`,
        [invoiceId, organizationId]
      );

      if (!txnRes.rows.length) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      const txn = txnRes.rows[0];
      const status = String(txn.status || '').toLowerCase();

      if (status === 'paid') {
        return res.status(400).json({ error: 'Invoice already paid' });
      }

      if (txn.razorpay_order_id) {
        return res.json({
          order_id: txn.razorpay_order_id,
          amount: Number(txn.amount || txn.price_monthly || 0) * 100,
          currency: 'INR',
          key: process.env.RAZORPAY_KEY_ID
        });
      }

      const amount = Number(txn.amount || txn.price_monthly || 0);
      if (!amount) {
        return res.status(400).json({ error: 'Invoice amount not found' });
      }

      const order = await razorpay.orders.create({
        amount: amount * 100,
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`
      });

      // Update transaction with new order id (avoid assuming receipt column exists)
      try {
        await db.query(
          `UPDATE billing_transactions
           SET razorpay_order_id = $1, status = 'created', receipt = $2
           WHERE id = $3`,
          [order.id, order.receipt || '', invoiceId]
        );
      } catch (updateErr) {
        if (updateErr && updateErr.code === '42703') {
          await db.query(
            `UPDATE billing_transactions
             SET razorpay_order_id = $1, status = 'created'
             WHERE id = $2`,
            [order.id, invoiceId]
          );
        } else {
          throw updateErr;
        }
      }

      res.json({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key: process.env.RAZORPAY_KEY_ID
      });
    } catch (error) {
      console.error('Pay invoice error:', error);
      res.status(500).json({ error: 'Failed to initiate payment' });
    }
  },

  /**
   * Download invoice (JSON attachment for now)
   */
  async downloadInvoice(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const invoiceId = req.params.id;

      const txnRes = await db.query(
        `SELECT bt.*, p.name AS plan_name
         FROM billing_transactions bt
         LEFT JOIN plans p ON bt.plan_id = p.id
         WHERE bt.id = $1 AND bt.organization_id = $2`,
        [invoiceId, organizationId]
      );

      if (!txnRes.rows.length) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      const invoice = txnRes.rows[0];
      const filename = `invoice-${invoice.id}.json`;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(JSON.stringify(invoice, null, 2));
    } catch (error) {
      console.error('Download invoice error:', error);
      res.status(500).json({ error: 'Failed to download invoice' });
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
module.exports= billingController;
