const Organization = require('../models/Organization');
const db = require('../config/database');
const razorpay = require('../config/razorpay');
const crypto = require('crypto');
const creditService = require('../services/creditService');
const emailService = require('../services/emailService');
const { enrichPlanRecord, resolvePlanPrice } = require('../utils/planCatalog');
const BILLING_CURRENCY = (process.env.BILLING_CURRENCY || 'USD').toUpperCase();

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

const ensureSubscriptionStateTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS billing_subscription_states (
      organization_id UUID PRIMARY KEY,
      auto_renew BOOLEAN NOT NULL DEFAULT true,
      cancelled_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`
  );
};

const ensurePlanLocalizationColumns = async () => {
  await db.query(
    `ALTER TABLE plans
      ADD COLUMN IF NOT EXISTS name_ar TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS description_ar TEXT,
      ADD COLUMN IF NOT EXISTS features_ar JSONB`
  );

  await db.query(
    `UPDATE plans
     SET name_ar = CASE
       WHEN lower(name) = 'starter' THEN 'المبتدئ'
       WHEN lower(name) = 'growth' THEN 'النمو'
       WHEN lower(name) = 'enterprise' THEN 'المؤسسات'
       ELSE name_ar
     END
     WHERE name_ar IS NULL OR TRIM(name_ar) = ''`
  );
};

const escapePdfText = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)');

const buildInvoicePdfBuffer = (invoice) => {
  const lines = [
    'ZeroQueries Invoice',
    `Invoice ID: ${invoice.id}`,
    `Plan: ${invoice.plan_name || 'N/A'}`,
    `Amount: ${invoice.amount || 0}`,
    `Status: ${invoice.status || 'unknown'}`,
    `Order ID: ${invoice.razorpay_order_id || 'N/A'}`,
    `Payment ID: ${invoice.razorpay_payment_id || 'N/A'}`,
    `Created At: ${invoice.created_at ? new Date(invoice.created_at).toISOString() : 'N/A'}`
  ];

  const contentStream = [
    'BT',
    '/F1 16 Tf',
    '50 780 Td',
    ...lines.flatMap((line, index) => {
      const escaped = escapePdfText(line);
      return index === 0
        ? [`(${escaped}) Tj`]
        : ['0 -24 Td', `(${escaped}) Tj`];
    }),
    'ET'
  ].join('\n');

  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(contentStream, 'utf8')} >> stream\n${contentStream}\nendstream endobj`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';

  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
};

const getSubscriptionState = async (organizationId) => {
  await ensureSubscriptionStateTable();
  const result = await db.query(
    `INSERT INTO billing_subscription_states (organization_id)
     VALUES ($1)
     ON CONFLICT (organization_id) DO UPDATE SET organization_id = EXCLUDED.organization_id
     RETURNING *`,
    [organizationId]
  );
  return result.rows[0];
};

const getPendingPlanChange = async (organizationId) => {
  await ensurePlanChangeTable();
  await ensurePlanLocalizationColumns();
  const res = await db.query(
    `SELECT bpc.*, p.name AS to_plan_name, p.name_ar AS to_plan_name_ar
     FROM billing_plan_changes bpc
     LEFT JOIN plans p ON bpc.to_plan_id = p.id
     WHERE bpc.organization_id = $1 AND bpc.status = 'scheduled'
     ORDER BY bpc.created_at DESC
     LIMIT 1`,
    [organizationId]
  );
  return res.rows[0] || null;
};

const resolvePendingChangeType = async (organizationId, pendingChange) => {
  if (!pendingChange?.to_plan_id) return 'downgrade';

  try {
    const result = await db.query(
      `SELECT
         current_plan.name AS current_plan_name,
         current_plan.price_monthly AS current_price,
         target_plan.name AS target_plan_name,
         target_plan.price_monthly AS target_price
       FROM organizations o
       LEFT JOIN plans current_plan ON o.plan_id = current_plan.id
       LEFT JOIN plans target_plan ON target_plan.id = $2
       WHERE o.id = $1`,
      [organizationId, pendingChange.to_plan_id]
    );

    const row = result.rows[0] || {};
    const currentPrice = resolvePlanPrice({ name: row.current_plan_name, price_monthly: row.current_price });
    const targetPrice = resolvePlanPrice({ name: row.target_plan_name, price_monthly: row.target_price });

    return targetPrice >= currentPrice ? 'upgrade' : 'downgrade';
  } catch (error) {
    console.warn('Failed to resolve pending change type:', error.message);
    return 'downgrade';
  }
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
      await ensurePlanLocalizationColumns();

      // Apply any due scheduled changes before returning plan
      await applyDuePlanChanges(organizationId);

      // Get current plan + usage
      const currentPlanResult = await db.query(
        `SELECT o.id AS organization_id,
                o.created_at,
                o.plan_id AS current_plan_id,
                p.*,
                p.id AS plan_id,
                p.name AS plan_name,
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
      const enrichedCurrentPlanRow = enrichPlanRecord({
        ...row,
        name: row.plan_name || row.name
      });

      // Get credit balance
      const creditBalance = await creditService.getBalance(organizationId);
      const subscriptionState = await getSubscriptionState(organizationId);
      const effectivePlanName = enrichedCurrentPlanRow.plan_name || enrichedCurrentPlanRow.name || 'Free Trial';
      const effectivePlanPrice = resolvePlanPrice(enrichedCurrentPlanRow);
      const effectiveUserLimit = enrichedCurrentPlanRow.user_limit == null ? null : Number(enrichedCurrentPlanRow.user_limit || 0);
      const effectiveQueryLimit = enrichedCurrentPlanRow.query_limit == null ? null : Number(enrichedCurrentPlanRow.query_limit || 0);
      const nextBillingDate =
        creditBalance?.expiration_date ||
        (row.created_at ? new Date(new Date(row.created_at).getTime() + 30 * 24 * 60 * 60 * 1000) : null);

      const safePercent = (current, limit) => {
        if (!limit || Number(limit) <= 0) return 0;
        return Math.min(100, (Number(current) / Number(limit)) * 100);
      };

      // Get all plans
      const allPlansResult = await db.query(
        `SELECT *
         FROM plans
         ORDER BY price_monthly ASC`
      );

      const pendingChange = await getPendingPlanChange(organizationId);
      const pendingChangeType = await resolvePendingChangeType(organizationId, pendingChange);

      const currentPlan = row.plan_id
        ? {
          id: row.plan_id,
          name: effectivePlanName,
          name_ar: enrichedCurrentPlanRow.name_ar || null,
          description: enrichedCurrentPlanRow.description || null,
          description_ar: enrichedCurrentPlanRow.description_ar || null,
          features_ar: enrichedCurrentPlanRow.features_ar || null,
          feature_list: enrichedCurrentPlanRow.feature_list || [],
          feature_list_ar: enrichedCurrentPlanRow.feature_list_ar || [],
          price_monthly: effectivePlanPrice,
          price_yearly: effectivePlanPrice > 0 ? effectivePlanPrice * 12 : 0,
          price_label: enrichedCurrentPlanRow.price_label || null,
          price_label_ar: enrichedCurrentPlanRow.price_label_ar || null,
          billing_cycle: 'monthly',
          features: enrichedCurrentPlanRow.features || {},
          limits: {
            users: effectiveUserLimit,
            databases: Number(row.db_limit || 0),
            queries: effectiveQueryLimit,
            points: Number(creditBalance?.assigned_points_limit || 0),
          },
          usage: {
            users: {
              current: Number(row.active_users),
              limit: effectiveUserLimit,
              percentage: effectiveUserLimit == null ? 0 : safePercent(row.active_users, effectiveUserLimit),
            },
            databases: {
              current: Number(row.db_connections),
              limit: Number(row.db_limit || 0),
              percentage: safePercent(row.db_connections, row.db_limit),
            },
            queries: {
              current: Number(row.queries_this_month),
              limit: effectiveQueryLimit,
              percentage: effectiveQueryLimit == null ? 0 : safePercent(row.queries_this_month, effectiveQueryLimit),
            },
            points: {
              current: Number(creditBalance?.assigned_points_limit || 0) - Number(creditBalance?.remaining_points || 0),
              limit: Number(creditBalance?.assigned_points_limit || 0),
              percentage: safePercent(
                Number(creditBalance?.assigned_points_limit || 0) - Number(creditBalance?.remaining_points || 0),
                Number(creditBalance?.assigned_points_limit || 0)
              ),
            },
            credits: creditBalance // ADD CREDIT INFO
          },
          next_billing_date: nextBillingDate,
          auto_renew: subscriptionState?.auto_renew !== false,
          trial_ends_at: null,
          cancelled_at: subscriptionState?.cancelled_at || null,
          pending_change: pendingChange
            ? {
              to_plan_id: pendingChange.to_plan_id,
              to_plan_name: pendingChange.to_plan_name,
              to_plan_name_ar: pendingChange.to_plan_name_ar || null,
              effective_date: pendingChange.effective_date,
              type: pendingChangeType
            }
            : null
        }
        : {
          id: 'trial',
          name: effectivePlanName,
          name_ar: enrichedCurrentPlanRow.name_ar || null,
          description: enrichedCurrentPlanRow.description || null,
          description_ar: enrichedCurrentPlanRow.description_ar || null,
          features_ar: enrichedCurrentPlanRow.features_ar || null,
          feature_list: enrichedCurrentPlanRow.feature_list || [],
          feature_list_ar: enrichedCurrentPlanRow.feature_list_ar || [],
          price_monthly: 0,
          price_yearly: 0,
          price_label: null,
          price_label_ar: null,
          billing_cycle: 'monthly',
          features: enrichedCurrentPlanRow.features || {},
          limits: {
            users: 0,
            databases: 0,
            queries: 0,
            points: Number(creditBalance?.assigned_points_limit || 0),
          },
          usage: {
            users: { current: Number(row.active_users || 0), limit: 0, percentage: 0 },
            databases: { current: Number(row.db_connections || 0), limit: 0, percentage: 0 },
            queries: { current: Number(row.queries_this_month || 0), limit: 0, percentage: 0 },
            points: {
              current: Number(creditBalance?.assigned_points_limit || 0) - Number(creditBalance?.remaining_points || 0),
              limit: Number(creditBalance?.assigned_points_limit || 0),
              percentage: safePercent(
                Number(creditBalance?.assigned_points_limit || 0) - Number(creditBalance?.remaining_points || 0),
                Number(creditBalance?.assigned_points_limit || 0)
              ),
            },
            credits: creditBalance
          },
          next_billing_date: nextBillingDate,
          auto_renew: subscriptionState?.auto_renew !== false,
          trial_ends_at: null,
          cancelled_at: subscriptionState?.cancelled_at || null,
          pending_change: pendingChange
            ? {
              to_plan_id: pendingChange.to_plan_id,
              to_plan_name: pendingChange.to_plan_name,
              to_plan_name_ar: pendingChange.to_plan_name_ar || null,
              effective_date: pendingChange.effective_date,
              type: pendingChangeType
            }
            : null
        };

      res.json({
        success: true,
        current_plan: currentPlan,
        credits: creditBalance,
        plans: allPlansResult.rows.map((plan) => {
          const enrichedPlan = enrichPlanRecord(plan);
          const resolvedPlanPrice = resolvePlanPrice(enrichedPlan);
          return {
            id: plan.id,
            name: enrichedPlan.name,
            name_ar: enrichedPlan.name_ar || null,
            description: enrichedPlan.description || null,
            description_ar: enrichedPlan.description_ar || null,
            price_monthly: resolvedPlanPrice,
            price_yearly: resolvedPlanPrice > 0 ? resolvedPlanPrice * 12 : 0,
            price_label: enrichedPlan.price_label || null,
            price_label_ar: enrichedPlan.price_label_ar || null,
            features: enrichedPlan.features || {},
            features_ar: enrichedPlan.features_ar || null,
            feature_list: enrichedPlan.feature_list || [],
            feature_list_ar: enrichedPlan.feature_list_ar || [],
            limits: {
              users: enrichedPlan.user_limit,
              databases: plan.db_limit,
              queries: enrichedPlan.query_limit,
              points: Number(enrichedPlan.query_limit || 0),
            },
            is_current: row.plan_id ? plan.id === row.plan_id : false,
            popular: Boolean(enrichedPlan.popular),
          };
        }),
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

      const plan = enrichPlanRecord(planResult.rows[0]);
      const planPrice = resolvePlanPrice(plan);

      if (!planPrice) {
        return res.status(400).json({ error: 'This plan requires custom pricing. Please contact sales.' });
      }

      const existingOpenOrder = await db.query(
        `SELECT id, razorpay_order_id, amount
         FROM billing_transactions
         WHERE organization_id = $1
           AND plan_id = $2
           AND lower(status) = 'created'
           AND razorpay_payment_id IS NULL
           AND razorpay_order_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [organizationId, plan_id]
      );

      const order = await razorpay.orders.create({
        amount: planPrice * 100,
        currency: BILLING_CURRENCY,
        receipt: `rcpt_${Date.now()}`,
      });

      if (existingOpenOrder.rows.length) {
        const existing = existingOpenOrder.rows[0];
        try {
          await db.query(
            `UPDATE billing_transactions
             SET razorpay_order_id = $1, amount = $2, status = 'created', receipt = $3
             WHERE id = $4`,
            [order.id, planPrice, order.receipt || '', existing.id]
          );
        } catch (updateErr) {
          if (updateErr && updateErr.code === '42703') {
            await db.query(
              `UPDATE billing_transactions
               SET razorpay_order_id = $1, amount = $2, status = 'created'
               WHERE id = $3`,
               [order.id, planPrice, existing.id]
            );
          } else {
            throw updateErr;
          }
        }
      } else {
        // Insert transaction. Some DBs may not have the `receipt` column, so try with receipt first
        try {
          await db.query(
            `INSERT INTO billing_transactions (organization_id, plan_id, razorpay_order_id, amount, status, receipt)
             VALUES ($1, $2, $3, $4, 'created', $5) RETURNING id`,
            [organizationId, plan_id, order.id, planPrice, order.receipt || '']
          );
        } catch (insertErr) {
          // If column doesn't exist (Postgres 42703), retry without receipt
          if (insertErr && insertErr.code === '42703') {
            await db.query(
              `INSERT INTO billing_transactions (organization_id, plan_id, razorpay_order_id, amount, status)
               VALUES ($1, $2, $3, $4, 'created') RETURNING id`,
               [organizationId, plan_id, order.id, planPrice]
            );
          } else {
            throw insertErr;
          }
        }
      }

      // Return order details + txn id (helpful for frontend to correlate)
      const orderPayload = {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        key: process.env.RAZORPAY_KEY_ID,
      };

      res.json({
        success: true,
        order: orderPayload,
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

      const currentPlanRes = await db.query(
        `SELECT p.id, p.price_monthly
         FROM organizations o
         LEFT JOIN plans p ON o.plan_id = p.id
         WHERE o.id = $1`,
        [txn.organization_id]
      );
      const newPlanRes = await db.query(
        `SELECT id, price_monthly, name FROM plans WHERE id = $1`,
        [txn.plan_id]
      );
      const currentPrice = resolvePlanPrice(currentPlanRes.rows[0] || {});
      const newPrice = resolvePlanPrice(newPlanRes.rows[0] || {});
      const isDowngrade = currentPlanRes.rows[0]?.id && newPrice < currentPrice;
      const quota = await creditService.getActiveQuota(txn.organization_id);

      if (isDowngrade) {
        const effectiveDate = quota?.expiration_date ? new Date(quota.expiration_date) : new Date();
        if (quota?.expiration_date) {
          effectiveDate.setDate(effectiveDate.getDate() + 1);
        }
        await ensurePlanChangeTable();
        const existing = await db.query(
          `SELECT id FROM billing_plan_changes
           WHERE organization_id = $1 AND status = 'scheduled'
           ORDER BY created_at DESC LIMIT 1`,
          [txn.organization_id]
        );

        const fromPlanId = currentPlanRes.rows[0]?.id || txn.plan_id;

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
            [txn.organization_id, fromPlanId, txn.plan_id, effectiveDate, txn.id]
          );
        }

        // Send plan change email (scheduled)
        try {
          const plan = enrichPlanRecord(newPlanRes.rows[0] || {});
          await emailService.sendPlanChange({
            to: req.user?.email,
            plan_name: plan.name || 'Unknown Plan',
            price_monthly: resolvePlanPrice(plan),
            payment_id: razorpay_payment_id,
            effective_date: effectiveDate,
            scheduled: true
          });
        } catch (emailErr) {
          console.warn('Failed to send plan change email:', emailErr?.message || emailErr);
        }

        return res.json({ success: true, scheduled: true, effective_date: effectiveDate });
      }

      // No usable quota left: apply immediately.
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
          razorpay_payment_id,
          { carryover_unused: true }
        );
      } catch (allocErr) {
        console.error('allocateCredits failed:', allocErr);
        // Return success for payment but include a warning so frontend can surface it.
        return res.status(200).json({ success: true, warning: 'Payment processed but credit allocation failed' });
      }

      // Send plan change email (best-effort)
      try {
        const plan = enrichPlanRecord(newPlanRes.rows[0] || {});
        await emailService.sendPlanChange({
          to: req.user?.email,
          plan_name: plan.name || 'Unknown Plan',
          price_monthly: resolvePlanPrice(plan),
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
      } else {
        // "created" rows are checkout attempts, not user-facing invoices.
        whereClause += ` AND lower(bt.status) <> 'created'`;
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

      const amount = Number(txn.amount || txn.price_monthly || 0);
      if (!amount) {
        return res.status(400).json({ error: 'Invoice amount not found' });
      }

      const order = await razorpay.orders.create({
        amount: amount * 100,
        currency: BILLING_CURRENCY,
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
        success: true,
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          key: process.env.RAZORPAY_KEY_ID
        },
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
   * Download invoice as a simple PDF
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
      const filename = `invoice-${invoice.id}.pdf`;
      const pdfBuffer = buildInvoicePdfBuffer(invoice);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error) {
      console.error('Download invoice error:', error);
      res.status(500).json({ error: 'Failed to download invoice' });
    }
  },

  async getPayments(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size, 10) || 10));
      const search = (req.query.search || '').toString().trim();
      const params = [organizationId];
      let whereClause = `bt.organization_id = $1 AND bt.razorpay_payment_id IS NOT NULL`;

      if (search) {
        params.push(`%${search}%`);
        whereClause += ` AND (
          p.name ILIKE $${params.length}
          OR bt.razorpay_order_id ILIKE $${params.length}
          OR bt.razorpay_payment_id ILIKE $${params.length}
        )`;
      }

      const baseFrom = `FROM billing_transactions bt
                        LEFT JOIN plans p ON bt.plan_id = p.id`;
      const countRes = await db.query(`SELECT COUNT(*) ${baseFrom} WHERE ${whereClause}`, params);
      const offset = (page - 1) * pageSize;
      const dataRes = await db.query(
        `SELECT
           bt.id,
           bt.razorpay_payment_id as transaction_id,
           bt.id as invoice_id,
           ('INV-' || bt.id) as invoice_number,
           COALESCE(p.name, 'Plan') as plan_name,
           bt.amount,
           CASE WHEN lower(bt.status) IN ('paid', 'completed') THEN 'completed' ELSE lower(bt.status) END as status,
           'card' as payment_method,
           bt.razorpay_order_id,
           bt.razorpay_payment_id,
           bt.created_at,
           NULL::text as refund_status,
           NULL::numeric as refund_amount
         ${baseFrom}
         WHERE ${whereClause}
         ORDER BY bt.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      );

      res.json({
        success: true,
        payments: dataRes.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: Number(countRes.rows[0]?.count || 0)
        }
      });
    } catch (error) {
      console.error('Get payments error:', error);
      res.status(500).json({ error: 'Failed to fetch payments' });
    }
  },

  async getPaymentMethods(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const latestPaid = await db.query(
        `SELECT razorpay_payment_id, razorpay_order_id, created_at
         FROM billing_transactions
         WHERE organization_id = $1
           AND razorpay_payment_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [organizationId]
      );

      const methods = latestPaid.rows.length
        ? [{
            id: latestPaid.rows[0].razorpay_payment_id,
            type: 'card',
            is_default: true,
            last4: '****',
            card_brand: 'Card',
            created_at: latestPaid.rows[0].created_at
          }]
        : [];

      res.json({ success: true, methods });
    } catch (error) {
      console.error('Get payment methods error:', error);
      res.status(500).json({ error: 'Failed to fetch payment methods' });
    }
  },

  async getUsageHistory(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const regclassRes = await db.query(
        `SELECT to_regclass('public.usage_tracking') AS usage_tracking,
                to_regclass('public.usage_tracker') AS usage_tracker,
                to_regclass('public.usage_traking') AS usage_traking`
      );
      const row = regclassRes.rows[0] || {};
      let history = [];

      if (row.usage_tracking) {
        const result = await db.query(
          `SELECT month, query_count AS queries, total_points_used AS points
           FROM usage_tracking
           WHERE organization_id = $1
           ORDER BY month DESC
           LIMIT 12`,
          [organizationId]
        );
        history = result.rows;
      } else if (row.usage_tracker) {
        const result = await db.query(
          `SELECT month, query_count AS queries, 0::numeric AS points
           FROM usage_tracker
           WHERE organization_id = $1
           ORDER BY month DESC
           LIMIT 12`,
          [organizationId]
        );
        history = result.rows;
      } else if (row.usage_traking) {
        const result = await db.query(
          `SELECT month, query_count AS queries, total_points_used AS points
           FROM usage_traking
           WHERE organization_id = $1
           ORDER BY month DESC
           LIMIT 12`,
          [organizationId]
        );
        history = result.rows;
      }

      res.json({
        success: true,
        history: history.map((item) => ({
          month: item.month,
          queries: Number(item.queries || 0),
          points: Number(item.points || 0),
          cost: 0
        }))
      });
    } catch (error) {
      console.error('Get usage history error:', error);
      res.status(500).json({ error: 'Failed to fetch usage history' });
    }
  },

  async cancelSubscription(req, res) {
    try {
      const organizationId = req.user.organization_id;
      await ensureSubscriptionStateTable();
      await db.query(
        `INSERT INTO billing_subscription_states (organization_id, auto_renew, cancelled_at)
         VALUES ($1, false, NOW())
         ON CONFLICT (organization_id)
         DO UPDATE SET auto_renew = false, cancelled_at = NOW(), updated_at = NOW()`,
        [organizationId]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Cancel subscription error:', error);
      res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  },

  async reactivateSubscription(req, res) {
    try {
      const organizationId = req.user.organization_id;
      await ensureSubscriptionStateTable();
      await db.query(
        `INSERT INTO billing_subscription_states (organization_id, auto_renew, cancelled_at)
         VALUES ($1, true, NULL)
         ON CONFLICT (organization_id)
         DO UPDATE SET auto_renew = true, cancelled_at = NULL, updated_at = NOW()`,
        [organizationId]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Reactivate subscription error:', error);
      res.status(500).json({ error: 'Failed to reactivate subscription' });
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
