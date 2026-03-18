const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// Use the middleware properly by calling it to get the middleware function
router.post('/login', 
  auditLog('USER_LOGIN', 'Authentication'),  // This now returns a proper middleware function
  authController.login
);

router.post('/register',
  auditLog('USER_REGISTER', 'Authentication'),
  authController.register
);

router.get('/profile',
  authenticateToken,
  authController.getProfile
);


router.post('/verify-otp',
  auditLog('VERIFY_OTP', 'Authentication'),
  authController.verifyOtp
);
router.post('/resend-otp',
  auditLog('RESEND_OTP', 'Authentication'),
  authController.resendOtp
);
router.patch('/change-password',
  authenticateToken,
  auditLog('CHANGE_PASSWORD', 'User'),
  authController.changePassword
);

module.exports = router;
