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
  try {
    const { photo, full_name, preferred_language } = req.body;

    if (!photo && !full_name && !preferred_language) {
      return res.status(400).json({ message: "No profile fields provided" });
    }

    if (preferred_language && !['en', 'ar'].includes(preferred_language)) {
      return res.status(400).json({ message: "Invalid preferred language" });
    }

    // Ensure preferred_language column exists (no-op if already present)
    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10)"
    );

    const fields = [];
    const values = [];
    let idx = 1;

    if (photo) {
      fields.push(`profile_photo_base64 = $${idx++}`);
      values.push(photo);
    }
    if (full_name) {
      fields.push(`full_name = $${idx++}`);
      values.push(full_name);
    }
    if (preferred_language) {
      fields.push(`preferred_language = $${idx++}`);
      values.push(preferred_language);
    }

    values.push(req.user.id);

    await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );

    res.json({
      success: true,
      message: "Profile updated",
      photo
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

router.post('/verify-otp', authController.verifyOtp);

router.patch(
  '/2fa',
  authenticateToken,
  auditLog('TOGGLE_2FA', 'Security'),
  authController.toggleTwoFactor
);


module.exports = router;
