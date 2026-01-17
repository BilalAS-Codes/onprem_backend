const express = require('express');
const router = express.Router();
const departmentController = require('../controllers/departmentController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');

// All department routes require authentication
router.use(authenticateToken);

// Department management - Admin only
router.post('/create',
  authorize([ROLES.ADMIN]),
  auditLog('DEPARTMENT_CREATE', 'Department'),
  departmentController.create
);

// Get departments - accessible by all roles
router.get('/',
  departmentController.getAll
);

router.patch('/:id',
  authorize([ROLES.ADMIN]),
  auditLog('DEPARTMENT_UPDATE', 'Department'),
  departmentController.update
);

router.delete('/:id',
  authorize([ROLES.ADMIN]),
  auditLog('DEPARTMENT_DELETE', 'Department'),
  departmentController.delete
);

// Department permissions - Admin only
router.post('/:id/permissions',
  authorize([ROLES.ADMIN]),
  auditLog('DEPARTMENT_PERMISSIONS_UPDATE', 'Department'),
  departmentController.setPermissions
);

router.get('/:id/permissions',
  authorize([ROLES.ADMIN]),
  departmentController.getPermissions
);

module.exports = router;