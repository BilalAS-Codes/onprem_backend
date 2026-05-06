const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authenticateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// All billing routes require authentication
router.use(authenticateToken);

/**
 * @openapi
 * /billing/plan:
 *   get:
 *     summary: Get current subscription plan
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current plan details
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @openapi
 * /billing/create-order:
 *   post:
 *     summary: Create a Razorpay order for plan purchase
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plan_id
 *             properties:
 *               plan_id:
 *                 type: string
 *                 example: "premium_monthly"
 *     responses:
 *       200:
 *         description: Razorpay order created
 *       400:
 *         description: Invalid plan
 */
router.post(
  '/create-order',
  authenticateToken,
  billingController.createRazorpayOrder
);

/**
 * @openapi
 * /billing/verify-payment:
 *   post:
 *     summary: Verify Razorpay payment and activate plan
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - razorpay_payment_id
 *               - razorpay_order_id
 *               - razorpay_signature
 *             properties:
 *               razorpay_payment_id:
 *                 type: string
 *               razorpay_order_id:
 *                 type: string
 *               razorpay_signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified and plan activated
 *       400:
 *         description: Verification failed
 */
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
