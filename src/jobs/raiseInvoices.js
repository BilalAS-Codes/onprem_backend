const cron = require('node-cron');
const db = require('../config/database');

const ensureBillingTables = async () => {
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

const startRaiseInvoicesJob = () => {
  // 1st of every month at 00:05 UTC
  cron.schedule(
    '5 0 1 * *',
    async () => {
      console.log('[CRON] Running monthly invoice generation...');
      try {
        await ensureBillingTables();
        const result = await db.query(
          `
          WITH month_window AS (
            SELECT
              date_trunc('month', (now() at time zone 'UTC')) AS start_ts,
              date_trunc('month', (now() at time zone 'UTC')) + interval '1 month' AS end_ts
          ),
          scheduled_changes AS (
            SELECT DISTINCT ON (bpc.organization_id)
              bpc.organization_id,
              bpc.to_plan_id,
              bpc.transaction_id
            FROM billing_plan_changes bpc
            WHERE bpc.status = 'scheduled'
            ORDER BY bpc.organization_id, bpc.created_at DESC
          ),
          target_plans AS (
            SELECT
              o.id AS organization_id,
              COALESCE(sc.to_plan_id, o.plan_id) AS bill_plan_id,
              sc.transaction_id
            FROM organizations o
            LEFT JOIN billing_subscription_states bss
              ON bss.organization_id = o.id
            LEFT JOIN scheduled_changes sc
              ON sc.organization_id = o.id
            WHERE COALESCE(bss.auto_renew, true) = true
          )
          INSERT INTO billing_transactions (organization_id, plan_id, amount, status)
          SELECT tp.organization_id, p.id, p.price_monthly, 'pending'
          FROM target_plans tp
          JOIN plans p ON tp.bill_plan_id = p.id
          CROSS JOIN month_window mw
          WHERE p.price_monthly > 0
            AND NOT EXISTS (
              SELECT 1
              FROM billing_transactions prepaid
              WHERE prepaid.id = tp.transaction_id
                AND lower(prepaid.status) = 'paid'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM billing_transactions bt
              WHERE bt.organization_id = tp.organization_id
                AND bt.plan_id = p.id
                AND bt.created_at >= mw.start_ts
                AND bt.created_at < mw.end_ts
            )
          `
        );

        console.log(`[CRON] Invoices created: ${result.rowCount}`);
      } catch (error) {
        console.error('[CRON] Monthly invoice generation failed:', error);
      }
    },
    { timezone: 'UTC' }
  );

  console.log('[CRON] Monthly invoice job scheduled (1st of month, 00:05 UTC)');
};

module.exports = { startRaiseInvoicesJob };
