const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');
const authController = require('../controllers/authController');
const db = require('../config/database');

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

router.patch("/profile-photo", authenticateToken, async (req, res) => {
  const { photo } = req.body;
  if (!photo) {
    return res.status(400).json({ message: "Photo is required" });
  }

  // Save base64 directly
  await db.query(
    "UPDATE users SET profile_photo_base64 = $1 WHERE id = $2",
    [photo, req.user.id]
  );

  res.json({
    success: true,
    message: "Profile photo updated",
    photo
  });
});

router.post('/verify-otp', authController.verifyOtp);

router.patch(
  '/2fa',
  authenticateToken,
  auditLog('TOGGLE_2FA', 'Security'),
  authController.toggleTwoFactor
);


module.exports = router;