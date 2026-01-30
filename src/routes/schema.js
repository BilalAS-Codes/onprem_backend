const express = require('express');
const router = express.Router();
const schemaController = require('../controllers/schemaController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');

// All schema routes require authentication
router.use(authenticateToken);

// Schema viewing available to all roles
router.get('/:connectionId/tables',
  schemaController.getTables
);

router.get('/:connectionId/columns/:tableName',
  schemaController.getColumns
);

router.post('/:connectionId/debug-insert',
  authorize([ROLES.ADMIN]),
  schemaController.debugTableInsert
);
// NEW: Discover and seed schema endpoint (Admin only)
router.post('/:connectionId/discover-seed',
  authorize([ROLES.ADMIN]),
  schemaController.discoverAndSeedSchema
);

// Mapping endpoints require Admin role
router.post('/mapping/table',
  authorize([ROLES.ADMIN]),
  schemaController.createTableMapping
);

router.post('/mapping/column',
  authorize([ROLES.ADMIN]),
  schemaController.createColumnMapping
);

router.get('/mapping/tables',
  schemaController.getMappedTables
);

router.get('/mapping/columns',
  schemaController.getMappedColumns
);

module.exports = router;