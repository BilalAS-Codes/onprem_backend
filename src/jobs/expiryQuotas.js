const cron = require('node-cron');
const creditService = require('../services/creditService');

const startQuotaExpiryJob = () => {
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running quota expiry job...');
    
    try {
      const result = await creditService.expireQuotas();
      console.log(`[CRON] Expired ${result.expired} quotas`);
    } catch (error) {
      console.error('[CRON] Quota expiry job failed:', error);
    }
  });

  console.log('[CRON] Quota expiry job scheduled (daily at midnight)');
};

module.exports = { startQuotaExpiryJob };