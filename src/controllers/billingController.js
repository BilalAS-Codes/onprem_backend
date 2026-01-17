const Organization = require('../models/Organization');
const db = require('../config/database');

const billingController = {
  async getCurrentPlan(req, res) {
    try {
      const organizationId = req.user.organization_id;

      const result = await db.query(
        `SELECT o.*, p.*,
                (SELECT COUNT(*) FROM users 
                 WHERE organization_id = $1 AND status = 'active') as active_users,
                (SELECT COUNT(*) FROM database_connections 
                 WHERE organization_id = $1) as db_connections,
                (SELECT COUNT(*) FROM query_history 
                 WHERE organization_id = $1 
                 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) as queries_this_month
         FROM organizations o
         JOIN plans p ON o.plan_id = p.id
         WHERE o.id = $1`,
        [organizationId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      const planData = result.rows[0];

      // Calculate usage percentages
      const usage = {
        users: {
          current: parseInt(planData.active_users),
          limit: planData.user_limit,
          percentage: Math.min(100, (parseInt(planData.active_users) / planData.user_limit) * 100)
        },
        databases: {
          current: parseInt(planData.db_connections),
          limit: planData.db_limit,
          percentage: Math.min(100, (parseInt(planData.db_connections) / planData.db_limit) * 100)
        },
        queries: {
          current: parseInt(planData.queries_this_month),
          limit: planData.query_limit,
          percentage: Math.min(100, (parseInt(planData.queries_this_month) / planData.query_limit) * 100)
        }
      };

      res.json({
        success: true,
        plan: {
          name: planData.name,
          price_monthly: planData.price_monthly,
          features: planData.features,
          usage
        }
      });
    } catch (error) {
      console.error('Get current plan error:', error);
      res.status(500).json({ error: 'Failed to fetch plan details' });
    }
  },

  async upgradePlan(req, res) {
    try {
      const { plan_id } = req.body;
      const organizationId = req.user.organization_id;

      // Verify plan exists
      const planCheck = await db.query(
        'SELECT * FROM plans WHERE id = $1',
        [plan_id]
      );

      if (planCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid plan' });
      }

      const newPlan = planCheck.rows[0];

      // Check if organization already has this plan
      const currentOrg = await Organization.findById(organizationId);
      if (currentOrg.plan_id === plan_id) {
        return res.status(400).json({ error: 'Organization is already on this plan' });
      }

      // Check if downgrading (admin approval might be needed)
      const currentPlan = await db.query(
        'SELECT price_monthly FROM plans WHERE id = $1',
        [currentOrg.plan_id]
      );

      const isDowngrade = currentPlan.rows[0]?.price_monthly > newPlan.price_monthly;

      if (isDowngrade) {
        // For downgrades, check if current usage exceeds new plan limits
        const usageCheck = await db.query(
          `SELECT 
            (SELECT COUNT(*) FROM users WHERE organization_id = $1 AND status = 'active') as user_count,
            (SELECT COUNT(*) FROM database_connections WHERE organization_id = $1) as db_count,
            (SELECT COUNT(*) FROM query_history 
             WHERE organization_id = $1 
             AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) as query_count`,
          [organizationId]
        );

        const usage = usageCheck.rows[0];

        if (usage.user_count > newPlan.user_limit) {
          return res.status(400).json({ 
            error: `Cannot downgrade: You have ${usage.user_count} active users, but new plan only allows ${newPlan.user_limit}` 
          });
        }

        if (usage.db_count > newPlan.db_limit) {
          return res.status(400).json({ 
            error: `Cannot downgrade: You have ${usage.db_count} database connections, but new plan only allows ${newPlan.db_limit}` 
          });
        }
      }

      // Update organization plan
      const updatedOrg = await Organization.updatePlan(organizationId, plan_id);

      // In a real implementation, you would:
      // 1. Integrate with payment gateway (Stripe, PayPal, etc.)
      // 2. Create subscription record
      // 3. Send confirmation email
      // 4. Update billing period

      res.json({
        success: true,
        message: `Plan upgraded to ${newPlan.name} successfully`,
        new_plan: newPlan,
        organization: updatedOrg,
        next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days from now
      });
    } catch (error) {
      console.error('Upgrade plan error:', error);
      res.status(500).json({ error: 'Failed to upgrade plan' });
    }
  }
};

module.exports = billingController;