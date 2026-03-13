const cron = require('node-cron');
const db = require('../config/database');

const startRaiseInvoicesJob = () => {
  // 1st of every month at 00:05 UTC
  cron.schedule(
    '5 0 1 * *',
    async () => {
      console.log('[CRON] Running monthly invoice generation...');
      try {
        const result = await db.query(
          `
          WITH month_window AS (
            SELECT
              date_trunc('month', (now() at time zone 'UTC')) AS start_ts,
              date_trunc('month', (now() at time zone 'UTC')) + interval '1 month' AS end_ts
          )
          INSERT INTO billing_transactions (organization_id, plan_id, amount, status)
          SELECT o.id, p.id, p.price_monthly, 'pending'
          FROM organizations o
          JOIN plans p ON o.plan_id = p.id
          CROSS JOIN month_window mw
          WHERE p.price_monthly > 0
            AND NOT EXISTS (
              SELECT 1
              FROM billing_transactions bt
              WHERE bt.organization_id = o.id
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
