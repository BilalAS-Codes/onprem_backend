const User = require('../models/User');
const db = require('../config/database');
const crypto = require('crypto');
const emailService = require('../services/emailService');

const userController = {
  async inviteUser(req, res) {
    try {
      const { email, full_name, role_id, department_id } = req.body;
      const organizationId = req.user.organization_id;
      const invitedById = req.user.id;

      // Check if email already exists in organization
      const existingUser = await User.findByEmail(email);
      if (existingUser && existingUser.organization_id === organizationId) {
        return res.status(400).json({ error: 'User already exists in this organization' });
      }

      // Generate temporary password
      const tempPassword = crypto.randomBytes(8).toString('hex');

      // Create user
      const user = await User.create({
        organization_id: organizationId,
        full_name,
        email,
        password: tempPassword,
        role_id,
        department_id,
        status: 'invited'
      });

      const inviterUser = await User.findById(invitedById);
      const organizationResult = await db.query(
        'SELECT name FROM organizations WHERE id = $1 LIMIT 1',
        [organizationId]
      );
      const organizationName = (
        req.user.organization_name ||
        req.user.organisation_name ||
        req.user.organization ||
        inviterUser?.organization_name ||
        organizationResult.rows[0]?.name ||
        'your organization'
      );
      const invitedByName = (
        req.user.full_name ||
        inviterUser?.full_name ||
        req.user.email ||
        'your team'
      );

      // Send invitation email
      await emailService.sendInvitation({
        to: email,
        full_name,
        tempPassword,
        organization_name: organizationName,
        invited_by: invitedByName
      });

      // Remove sensitive data from response
      const { password_hash, ...userData } = user;

      res.status(201).json({
        success: true,
        message: 'User invited successfully',
        user: userData
      });
    } catch (error) {
      console.error('Invite user error:', error);
      res.status(500).json({ error: 'Failed to invite user' });
    }
  },

  async getAllUsers(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const { department_id, status, search } = req.query;

      const filters = {};
      if (department_id) filters.department_id = department_id;
      if (status) filters.status = status;

      let users = await User.findByOrganization(organizationId, filters);

      // Apply search filter if provided
      if (search) {
        const searchLower = search.toLowerCase();
        users = users.filter(user => 
          user.full_name.toLowerCase().includes(searchLower) ||
          user.email.toLowerCase().includes(searchLower)
        );
      }

      // If user is not admin, filter sensitive data
      if (req.user.role !== 'Admin') {
        users = users.map(user => {
          const { password_hash, email, ...safeUser } = user;
          return safeUser;
        });
      }

      res.json({
        success: true,
        users,
        total: users.length
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  },

  async updateUserRole(req, res) {
    try {
      const { id } = req.params;
      const { role_id } = req.body;
      const organizationId = req.user.organization_id;

      // Get user and verify they belong to the same organization
      const user = await User.findById(id);
      if (!user || user.organization_id !== organizationId) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Verify role exists
      const roleCheck = await db.query(
        'SELECT id FROM roles WHERE id = $1',
        [role_id]
      );
      if (!roleCheck.rows[0]) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      const updatedUser = await User.update(id, { role_id });

      res.json({
        success: true,
        message: 'User role updated successfully',
        user: updatedUser
      });
    } catch (error) {
      console.error('Update user role error:', error);
      res.status(500).json({ error: 'Failed to update user role' });
    }
  },

  async updateUserDepartment(req, res) {
    try {
      const { id } = req.params;
      const { department_id } = req.body;
      const organizationId = req.user.organization_id;

      // Get user and verify they belong to the same organization
      const user = await User.findById(id);
      if (!user || user.organization_id !== organizationId) {
        return res.status(404).json({ error: 'User not found' });
      }

      // If department_id is provided, verify it belongs to organization
      if (department_id) {
        const departmentCheck = await db.query(
          'SELECT id FROM departments WHERE id = $1 AND organization_id = $2',
          [department_id, organizationId]
        );
        if (!departmentCheck.rows[0]) {
          return res.status(400).json({ error: 'Invalid department' });
        }
      }

      const updatedUser = await User.update(id, { department_id });

      res.json({
        success: true,
        message: 'User department updated successfully',
        user: updatedUser
      });
    } catch (error) {
      console.error('Update user department error:', error);
      res.status(500).json({ error: 'Failed to update user department' });
    }
  },

  async updateUserStatus(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const organizationId = req.user.organization_id;

      // Validate status
      const validStatuses = ['active', 'inactive', 'suspended', 'invited'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // Get user and verify they belong to the same organization
      const user = await User.findById(id);
      if (!user || user.organization_id !== organizationId) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Cannot deactivate yourself
      if (id === req.user.id) {
        return res.status(400).json({ error: 'Cannot change your own status' });
      }

      const updatedUser = await User.update(id, { status });

      res.json({
        success: true,
        message: `User status updated to ${status}`,
        user: updatedUser
      });
    } catch (error) {
      console.error('Update user status error:', error);
      res.status(500).json({ error: 'Failed to update user status' });
    }
  }
};

module.exports = userController;
