const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');

// All user routes require authentication
router.use(authenticateToken);

// User invitation - Admin only
router.post('/invite',
  authorize([ROLES.ADMIN]),
  auditLog('USER_INVITE', 'User'),
  userController.inviteUser
);

// Get users - Admin sees all, others see filtered
router.get('/',
  userController.getAllUsers
);

// Update user role - Admin only
router.patch('/:id/role',
  authorize([ROLES.ADMIN]),
  auditLog('USER_ROLE_UPDATE', 'User'),
  userController.updateUserRole
);

// Update user department - Admin only
router.patch('/:id/department',
  authorize([ROLES.ADMIN]),
  auditLog('USER_DEPARTMENT_UPDATE', 'User'),
  userController.updateUserDepartment
);

// Update user status - Admin only
router.patch('/:id/status',
  authorize([ROLES.ADMIN]),
  auditLog('USER_STATUS_UPDATE', 'User'),
  userController.updateUserStatus
);

module.exports = router;