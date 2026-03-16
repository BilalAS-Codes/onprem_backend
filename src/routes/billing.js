const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authenticateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// All billing routes require authentication
router.use(authenticateToken);

router.get('/plan',
  billingController.getCurrentPlan
);

router.get('/invoices',
  billingController.getInvoices
);

router.post('/invoices/:id/pay',
  billingController.payInvoice
);

router.get('/invoices/:id/download',
  billingController.downloadInvoice
);

router.post(
  '/create-order',
  authenticateToken,
  billingController.createRazorpayOrder
);

router.post(
  '/verify-payment',
  billingController.verifyRazorpayPayment
);

module.exports = router;
