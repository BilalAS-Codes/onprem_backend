const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authenticateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// All billing routes require authentication
router.use(authenticateToken);

router.get('/billing/plan',
  billingController.getCurrentPlan
);

router.post('/billing/upgrade',
  auditLog('PLAN_UPGRADE', 'Billing'),
  billingController.upgradePlan
);

module.exports = router;