const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtConfig } = require('../config/jwt');
const User = require('../models/User');
const Organization = require('../models/Organization');
const db = require('../config/database');  // Add this import

const authController = {
  async login(req, res) {
    try {
      const { email, password } = req.body;

      // Find user
      const user = await User.findByEmail(email);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Verify password
      const isValidPassword = await User.verifyPassword(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check user status
      if (user.status !== 'active') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      // Get organization
      const organization = await Organization.findById(user.organization_id);

      // Get role name
      const roleResult = await db.query(
        'SELECT name FROM roles WHERE id = $1',
        [user.role_id]
      );
      const roleName = roleResult.rows[0]?.name || 'Viewer';

      // Generate tokens
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

      // Get default plan (Starter)
      const planResult = await db.query(
        'SELECT id FROM plans WHERE name = $1',
        ['Starter']
      );
      const planId = planResult.rows[0]?.id;

      if (!planId) {
        return res.status(500).json({ error: 'Default plan not found' });
      }

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