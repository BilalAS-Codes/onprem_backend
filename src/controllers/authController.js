const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/jwt');
const User = require('../models/User');
const Organization = require('../models/Organization');
const db = require('../config/database');
const { sendOTPEmail } = require('../services/2FAemailService');
const creditService = require('../services/creditService');

const OTP_RESEND_LIMIT = 3;
const OTP_RESEND_WINDOW_MS = 60 * 1000;
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const otpResendTracker = new Map();

async function sendLoginOtp(user) {
  const { generateOTP, hashOTP } = require('../utils/otp');
  const otp = generateOTP();
  const otpHash = await hashOTP(otp);

  console.log(`[2FA OTP] email=${user.email} userId=${user.id} otp=${otp}`);

  await User.setOTP(
    user.id,
    otpHash,
    new Date(Date.now() + OTP_EXPIRY_MS)
  );

  // Keep DB state aligned with the enforced backend behavior.
  if (user.two_factor_enabled !== true) {
    await User.update(user.id, {
      two_factor_enabled: true
    });
  }

  await sendOTPEmail({
    to: user.email,
    otp
  });

  return {
    success: true,
    requires2FA: true,
    userId: user.id
  };
}

const authController = {
  async login(req, res) {
    try {
      const { email, password } = req.body;

      const user = await User.findByEmail(email);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const isValidPassword = await User.verifyPassword(
        password,
        user.password_hash
      );
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.status !== 'active') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      // Never issue the JWT directly from login. OTP verification is required.
      return res.json(await sendLoginOtp(user));
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async toggleTwoFactor(req, res) {
    try {
      const { enabled } = req.body;
      const userId = req.user.id;

      await User.update(userId, {
        two_factor_enabled: enabled
      });

      return res.json({
        success: true,
        message: enabled
          ? 'Two-factor authentication enabled'
          : 'Two-factor authentication disabled'
      });
    } catch (error) {
      console.error('Toggle 2FA error:', error);
      return res.status(500).json({ error: 'Failed to update 2FA setting' });
    }
  },

  async verifyOtp(req, res) {
    try {
      const { userId, otp } = req.body;

      const user = await User.findById(userId);
      if (!user || !user.otp_hash || !user.otp_expires_at) {
        return res.status(400).json({ error: 'Invalid OTP request' });
      }

      if (new Date() > user.otp_expires_at) {
        return res.status(400).json({ error: 'OTP expired' });
      }

      const { verifyOTP } = require('../utils/otp');
      const isValid = await verifyOTP(otp, user.otp_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid OTP' });
      }

      await User.clearOTP(user.id);

      const organization = await Organization.findById(user.organization_id);
      const roleResult = await db.query(
        'SELECT name FROM roles WHERE id = $1',
        [user.role_id]
      );
      const roleName = roleResult.rows[0]?.name || 'Viewer';

      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: roleName,
          organization_id: user.organization_id,
          department_id: user.department_id
        },
        jwtConfig.secret,
        { expiresIn: jwtConfig.expiresIn }
      );

      const { password_hash, otp_hash, otp_expires_at, ...userData } = user;

      return res.json({
        success: true,
        token,
        user: {
          ...userData,
          role_name: roleName
        },
        organization
      });
    } catch (error) {
      console.error('Verify OTP error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async register(req, res) {
    try {
      const { organization_name, domain, full_name, email, password } = req.body;

      const existingOrg = await Organization.findByDomain(domain);
      if (existingOrg) {
        return res.status(400).json({ error: 'Organization domain already registered' });
      }

      const existingUser = await User.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      const organization = await Organization.create({
        name: organization_name,
        domain,
        plan_id: null
      });

      const roleResult = await db.query(
        'SELECT id FROM roles WHERE name = $1',
        ['Admin']
      );
      const adminRoleId = roleResult.rows[0]?.id;
      if (!adminRoleId) {
        return res.status(500).json({ error: 'Admin role not found' });
      }

      const user = await User.create({
        organization_id: organization.id,
        full_name,
        email,
        password,
        role_id: adminRoleId,
        department_id: null,
        two_factor_enabled: true
      });

      try {
        await creditService.grantFreeCredits(organization.id, { points: 10, queries: 10 });
      } catch (creditErr) {
        console.warn('Failed to grant free credits:', creditErr?.message || creditErr);
      }

      const otpResponse = await sendLoginOtp(user);

      return res.status(201).json({
        ...otpResponse,
        message: 'OTP sent for signup verification'
      });
    } catch (error) {
      console.error('Registration error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async resendOtp(req, res) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const now = Date.now();
      const entry = otpResendTracker.get(userId);
      if (!entry || now - entry.windowStart >= OTP_RESEND_WINDOW_MS) {
        otpResendTracker.set(userId, { windowStart: now, count: 1 });
      } else if (entry.count >= OTP_RESEND_LIMIT) {
        const retryAfterMs = OTP_RESEND_WINDOW_MS - (now - entry.windowStart);
        return res.status(429).json({
          error: 'Resend limit reached',
          retry_after_seconds: Math.ceil(retryAfterMs / 1000)
        });
      } else {
        otpResendTracker.set(userId, {
          windowStart: entry.windowStart,
          count: entry.count + 1
        });
      }

      await sendLoginOtp(user);

      return res.json({
        success: true,
        message: 'OTP resent'
      });
    } catch (error) {
      console.error('Resend OTP error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getProfile(req, res) {
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { password_hash, ...userData } = user;

      return res.json({
        success: true,
        user: userData
      });
    } catch (error) {
      console.error('Get profile error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword, current_password, new_password } = req.body;
      const actualCurrentPassword = currentPassword || current_password;
      const actualNewPassword = newPassword || new_password;
      const userId = req.user.id;

      if (!actualCurrentPassword || !actualNewPassword) {
        return res.status(400).json({ error: 'Current password and new password are required' });
      }

      const user = await User.findByEmail(req.user.email);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const isValidPassword = await User.verifyPassword(actualCurrentPassword, user.password_hash);
      if (!isValidPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      await User.update(userId, { password: actualNewPassword });

      return res.json({
        success: true,
        message: 'Password updated successfully'
      });
    } catch (error) {
      console.error('Change password error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};

module.exports = authController;
