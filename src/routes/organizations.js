const express = require('express');
const router = express.Router();
const organizationController = require('../controllers/organizationController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');

// All organization routes require authentication
router.use(authenticateToken);

// Only Admins can create organizations
router.post('/create',
  authorize([ROLES.ADMIN]),
  auditLog('ORGANIZATION_CREATE', 'Organization'),
  organizationController.create
);

// All authenticated users can get organizations (but only their own)
router.get('/',
  organizationController.getAll
);

router.get('/:id',
  organizationController.getById
);

module.exports = router;