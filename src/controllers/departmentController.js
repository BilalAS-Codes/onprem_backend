const Department = require('../models/Department');

const departmentController = {
  async create(req, res) {
    try {
      const { name, privacy_level } = req.body;
      const organizationId = req.user.organization_id;

      const department = await Department.create({
        organization_id: organizationId,
        name,
        privacy_level
      });

      res.status(201).json({
        success: true,
        department
      });
    } catch (error) {
      console.error('Create department error:', error);
      res.status(500).json({ error: 'Failed to create department' });
    }
  },

  async getAll(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const departments = await Department.findByOrganization(organizationId);

      res.json({
        success: true,
        departments
      });
    } catch (error) {
      console.error('Get departments error:', error);
      res.status(500).json({ error: 'Failed to fetch departments' });
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;
      const organizationId = req.user.organization_id;

      // Verify department belongs to organization
      const department = await Department.findById(id, organizationId);
      if (!department) {
        return res.status(404).json({ error: 'Department not found' });
      }

      const updatedDepartment = await Department.update(id, updates);

      res.json({
        success: true,
        department: updatedDepartment
      });
    } catch (error) {
      console.error('Update department error:', error);
      res.status(500).json({ error: 'Failed to update department' });
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      const result = await Department.delete(id, organizationId);
      if (!result) {
        return res.status(404).json({ error: 'Department not found' });
      }

      res.json({
        success: true,
        message: 'Department deleted successfully'
      });
    } catch (error) {
      console.error('Delete department error:', error);
      res.status(500).json({ error: 'Failed to delete department' });
    }
  },

  async setPermissions(req, res) {
    try {
      const { id } = req.params;
      const { permissions } = req.body;
      const organizationId = req.user.organization_id;

      // Verify department belongs to organization
      const department = await Department.findById(id, organizationId);
      if (!department) {
        return res.status(404).json({ error: 'Department not found' });
      }

      // Validate permissions structure
      if (!Array.isArray(permissions)) {
        return res.status(400).json({ error: 'Permissions must be an array' });
      }

      const updatedPermissions = await Department.setPermissions(id, permissions);

      res.json({
        success: true,
        permissions: updatedPermissions
      });
    } catch (error) {
      console.error('Set permissions error:', error);
      res.status(500).json({ error: 'Failed to set permissions' });
    }
  },

  async getPermissions(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      // Verify department belongs to organization
      const department = await Department.findById(id, organizationId);
      if (!department) {
        return res.status(404).json({ error: 'Department not found' });
      }

      const permissions = await Department.getPermissions(id);

      res.json({
        success: true,
        permissions
      });
    } catch (error) {
      console.error('Get permissions error:', error);
      res.status(500).json({ error: 'Failed to fetch permissions' });
    }
  }
};

module.exports = departmentController;