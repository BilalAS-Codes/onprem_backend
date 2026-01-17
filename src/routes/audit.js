const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');

// Audit logs require Admin role
router.use(authenticateToken, authorize([ROLES.ADMIN]));

router.get('/logs',
  auditController.getAuditLogs
);

module.exports = router;