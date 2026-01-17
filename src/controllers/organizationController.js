const Organization = require('../models/Organization');
const User = require('../models/User');
const db = require('../config/database'); // Add this line

const organizationController = {
  async create(req, res) {
    try {
      // Note: Main organization creation is in authController.register
      // This endpoint is for creating additional organizations (if needed)
      const { name, domain, plan_id } = req.body;
      const userId = req.user.id;

      // Get current user to get organization info
      const currentUser = await User.findById(userId);
      if (!currentUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if domain already exists
      const existingOrg = await Organization.findByDomain(domain);
      if (existingOrg) {
        return res.status(400).json({ error: 'Organization domain already registered' });
      }

      const organization = await Organization.create({
        name,
        domain,
        plan_id
      });

      res.status(201).json({
        success: true,
        organization
      });
    } catch (error) {
      console.error('Create organization error:', error);
      res.status(500).json({ error: 'Failed to create organization' });
    }
  },

  async getAll(req, res) {
    try {
      // Users can only see their own organization
      const organizationId = req.user.organization_id;
      const organization = await Organization.findById(organizationId);

      if (!organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      // If user is admin, include more details
      if (req.user.role === 'Admin') {
        // Get user count
        const userCount = await db.query( // Fixed: db is now defined
          'SELECT COUNT(*) FROM users WHERE organization_id = $1 AND status = $2',
          [organizationId, 'active']
        );

        // Get database connection count
        const dbCount = await db.query(
          'SELECT COUNT(*) FROM database_connections WHERE organization_id = $1',
          [organizationId]
        );

        // Get query count for current month
        const currentMonth = new Date().toISOString().slice(0, 7);
        const queryCount = await db.query(
          `SELECT COUNT(*) FROM query_history 
           WHERE organization_id = $1 
           AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
          [organizationId]
        );

        organization.stats = {
          user_count: parseInt(userCount.rows[0].count),
          db_count: parseInt(dbCount.rows[0].count),
          monthly_queries: parseInt(queryCount.rows[0].count)
        };
      }

      res.json({
        success: true,
        organization
      });
    } catch (error) {
      console.error('Get organization error:', error);
      res.status(500).json({ error: 'Failed to fetch organization' });
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      // Users can only access their own organization
      if (id !== organizationId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const organization = await Organization.findById(id);
      if (!organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      res.json({
        success: true,
        organization
      });
    } catch (error) {
      console.error('Get organization by ID error:', error);
      res.status(500).json({ error: 'Failed to fetch organization' });
    }
  }
};

module.exports = organizationController;