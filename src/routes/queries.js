const express = require('express');
const router = express.Router();
const queryController = require('../controllers/queryController');
const { authenticateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// All query routes require authentication
router.use(authenticateToken);

router.get('/history',
  queryController.getQueryHistory
);

router.get('/:id',
  queryController.getQueryById
);

router.delete('/:id',
  auditLog('QUERY_DELETE', 'QueryHistory'),
  queryController.deleteQuery
);

router.post('/:id/share',
  auditLog('QUERY_SHARE', 'QueryHistory'),
  queryController.shareQuery
);

module.exports = router;