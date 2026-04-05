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

router.get('/payments',
  billingController.getPayments
);

router.get('/payment-methods',
  billingController.getPaymentMethods
);

router.get('/usage-history',
  billingController.getUsageHistory
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

router.post('/subscription/cancel',
  billingController.cancelSubscription
);

router.post('/subscription/reactivate',
  billingController.reactivateSubscription
);

router.post('/contact-sales',
  billingController.contactSales
);

module.exports = router;
