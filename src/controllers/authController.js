const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtConfig } = require('../config/jwt');
const User = require('../models/User');
const Organization = require('../models/Organization');
const db = require('../config/database');  
const { sendOTPEmail } = require('../services/2FAemailService');
const creditService = require('../services/creditService');


const authController = {
async login(req, res) {
  try {
    const { email, password } = req.body;

    // 1. Find user
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 2. Verify password
    const isValidPassword = await User.verifyPassword(
      password,
      user.password_hash
    );
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 3. Check status
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    // 🔐 4. IF 2FA IS ENABLED → STOP LOGIN HERE
    if (user.two_factor_enabled) {
      const { generateOTP, hashOTP } = require('../utils/otp');
      const emailService = require('../services/emailService');

      const otp = generateOTP();
      const otpHash = await hashOTP(otp);

      console.log("Your otp is :",otp)
      await User.setOTP(
        user.id,
        otpHash,
        new Date(Date.now() + 5 * 60 * 1000)
      );

      await sendOTPEmail({
        to: user.email,
        otp
      });

      return res.json({
        success: true,
        requires2FA: true,
        userId: user.id
      });
    }

    // 5. Get organization
    const organization = await Organization.findById(user.organization_id);

    // 6. Get role name
    const roleResult = await db.query(
      'SELECT name FROM roles WHERE id = $1',
      [user.role_id]
    );
    const roleName = roleResult.rows[0]?.name || 'Viewer';


    
    // 7. Generate JWT (ONLY HERE)
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

    
    // Remove sensitive data
    const { password_hash, ...userData } = user;

    res.json({
      success: true,
      token,
      user: {
        ...userData,
        role_name: roleName
      },
      organization
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
},
async toggleTwoFactor(req, res) {
  try {
    const { enabled } = req.body;
    const userId = req.user.id;

    await User.update(userId, {
      two_factor_enabled: enabled
    });

    res.json({
      success: true,
      message: enabled
        ? 'Two-factor authentication enabled'
        : 'Two-factor authentication disabled'
    });
  } catch (error) {
    console.error('Toggle 2FA error:', error);
    res.status(500).json({ error: 'Failed to update 2FA setting' });
  }
}
,

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

    // Clear OTP after success
    await User.clearOTP(user.id);

    // Get organization
    const organization = await Organization.findById(user.organization_id);

    // Get role
    const roleResult = await db.query(
      'SELECT name FROM roles WHERE id = $1',
      [user.role_id]
    );
    const roleName = roleResult.rows[0]?.name || 'Viewer';

    // Issue JWT NOW
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

    res.json({
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
    res.status(500).json({ error: 'Internal server error' });
  }
},



  async register(req, res) {
    try {
      const { organization_name, domain, full_name, email, password } = req.body;

      // Check if organization domain already exists
      const existingOrg = await Organization.findByDomain(domain);
      if (existingOrg) {
        return res.status(400).json({ error: 'Organization domain already registered' });
      }

      // Check if email already exists
      const existingUser = await User.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      // Do not auto-assign a paid plan on signup.
      const planId = null;

      // Create organization
      const organization = await Organization.create({
        name: organization_name,
        domain,
        plan_id: planId
      });

      // Create admin user
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
        department_id: null
      });

      // Grant free trial credits (best-effort)
      try {
        await creditService.grantFreeCredits(organization.id, { points: 10, queries: 10 });
      } catch (creditErr) {
        console.warn('Failed to grant free credits:', creditErr?.message || creditErr);
      }

      // Generate token
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: 'Admin',
          organization_id: organization.id
        },
        jwtConfig.secret,
        { expiresIn: jwtConfig.expiresIn }
      );

      // Remove sensitive data
      const { password_hash, ...userData } = user;

      res.status(201).json({
        success: true,
        message: 'Organization and admin user created successfully',
        token,
        user: {
          ...userData,
          role: 'Admin'
        },
        organization
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getProfile(req, res) {
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Remove sensitive data
      const { password_hash, ...userData } = user;

      res.json({
        success: true,
        user: userData
      });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword } = req.body;
      const userId = req.user.id;

      // Get user with password hash
      const user = await User.findByEmail(req.user.email);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Verify current password
      const isValidPassword = await User.verifyPassword(currentPassword, user.password_hash);
      if (!isValidPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      // Update password
      await User.update(userId, { password: newPassword });

      res.json({
        success: true,
        message: 'Password updated successfully'
      });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

module.exports = authController;
