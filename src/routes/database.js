const express = require('express');
const router = express.Router();
const databaseController = require('../controllers/databaseController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');

// All database routes require Admin role
router.use(authenticateToken, authorize([ROLES.ADMIN]));

router.post('/connect',
  auditLog('DB_CONNECT', 'DatabaseConnection'),
  databaseController.connect
);

router.get('/connections',
  databaseController.getConnections
);

router.patch('/:id',
  auditLog('DB_UPDATE', 'DatabaseConnection'),
  databaseController.updateConnection
);

router.post('/:id/test',
  auditLog('DB_TEST', 'DatabaseConnection'),
  databaseController.testConnection
);

module.exports = router;