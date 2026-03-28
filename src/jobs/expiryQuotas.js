const cron = require('node-cron');
const creditService = require('../services/creditService');
const Organization = require('../models/Organization');
const db = require('../config/database');

const applyDuePlanChanges = async () => {
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

  const dueRes = await db.query(
    `SELECT *
     FROM billing_plan_changes
     WHERE status = 'scheduled' AND effective_date <= CURRENT_DATE
     ORDER BY effective_date ASC`
  );

  for (const change of dueRes.rows) {
    try {
      await Organization.updatePlan(change.organization_id, change.to_plan_id);
      await creditService.allocateCredits(
        change.organization_id,
        change.to_plan_id,
        change.transaction_id || null
      );
      await db.query(
        `UPDATE billing_plan_changes
         SET status = 'applied', updated_at = NOW()
         WHERE id = $1`,
        [change.id]
      );
    } catch (error) {
      console.error('[CRON] Failed to apply scheduled plan change:', error);
    }
  }

  return dueRes.rows.length;
};

const startQuotaExpiryJob = () => {
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running quota expiry job...');
    
    try {
      const result = await creditService.expireQuotas();
      const appliedChanges = await applyDuePlanChanges();
      console.log(`[CRON] Expired ${result.expired} quotas`);
      console.log(`[CRON] Applied ${appliedChanges} scheduled plan changes`);
    } catch (error) {
      console.error('[CRON] Quota expiry job failed:', error);
    }
  });

  console.log('[CRON] Quota expiry job scheduled (daily at midnight)');
};

module.exports = { startQuotaExpiryJob };
