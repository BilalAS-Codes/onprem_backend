// controllers/adminDashboard.controller.js
const db = require('../config/database');
const { testConnection } = require('../utils/dbConnection');

class AdminDashboardController {
  async getDashboard(req, res) {
    try {
      const { range = 'month' } = req.query;
      const organizationId = req.user.organization_id; // From auth middleware

      // Fetch all dashboard data in parallel
      const [
        organization,
        quotaSummary,
        databaseConnection,
        userMetrics,
        queryAnalytics,
        departmentPerformance,
        billingInfo,
        semanticLayer,
        recentActivities,
        performanceMetrics,
        alerts
      ] = await Promise.all([
        this.getOrganizationInfo(organizationId),
        this.getQuotaSummary(organizationId, range),
        this.getDatabaseConnection(organizationId),
        this.getUserMetrics(organizationId),
        this.getQueryAnalytics(organizationId, range),
        this.getDepartmentPerformance(organizationId),
        this.getBillingInfo(organizationId),
        this.getSemanticLayer(organizationId),
        this.getRecentActivities(organizationId),
        this.getPerformanceMetrics(organizationId, range),
        this.getAlerts(organizationId)
      ]);

      // Test database connection latency if connection exists
      if (databaseConnection) {
        const testResult = await testConnection({
          db_type: databaseConnection.db_type,
          host: databaseConnection.host,
          port: databaseConnection.port,
          database_name: databaseConnection.database_name,
          username: databaseConnection.username,
          password: databaseConnection.password,
          ssl_enabled: databaseConnection.ssl_enabled
        });
        
        if (testResult.success) {
          databaseConnection.latency_ms = testResult.latency_ms;
        }
      }

      res.json({
        organization,
        quota_summary: quotaSummary,
        database_connection: databaseConnection,
        user_metrics: userMetrics,
        query_analytics: queryAnalytics,
        department_performance: departmentPerformance,
        billing_info: billingInfo,
        semantic_layer: semanticLayer,
        recent_activities: recentActivities,
        performance_metrics: performanceMetrics,
        alerts
      });

    } catch (error) {
      console.error('Error in admin dashboard:', error);
      res.status(500).json({ 
        error: 'Failed to fetch dashboard data',
        details: error.message 
      });
    }
  }

  async getOrganizationInfo(organizationId) {
    const query = await db.query(
      `SELECT o.id, o.name, o.domain, p.name as plan_name, o.created_at, o.is_active
       FROM organizations o
       JOIN plans p ON o.plan_id = p.id
       WHERE o.id = $1`,
      [organizationId]
    );
    return query.rows[0];
  }

  async getQuotaSummary(organizationId, range) {
    const dateFilter = this.getDateFilter(range);
    
    const query = await db.query(
      `WITH current_quota AS (
         SELECT assigned_points_limit, assigned_queries_limit, 
                remaining_points, remaining_queries, expiration_date
         FROM organization_quota_assignments
         WHERE organization_id = $1 AND is_active = true
         ORDER BY effective_date DESC
         LIMIT 1
       ),
       usage_summary AS (
         SELECT 
           COALESCE(SUM(query_count), 0) as total_queries_used,
           COALESCE(SUM(total_points_used), 0) as total_points_used
         FROM usage_tracking
         WHERE organization_id = $1 ${dateFilter}
       )
       SELECT 
         cq.assigned_queries_limit as total_queries_limit,
         us.total_queries_used as queries_used,
         cq.remaining_queries,
         ROUND((us.total_queries_used::numeric / NULLIF(cq.assigned_queries_limit, 0) * 100), 1) as queries_usage_percentage,
         cq.assigned_points_limit as total_points_limit,
         us.total_points_used as points_used,
         cq.remaining_points,
         ROUND((us.total_points_used::numeric / NULLIF(cq.assigned_points_limit, 0) * 100), 1) as points_usage_percentage,
         cq.expiration_date as query_limit_reset_date,
         0 as overage_charges
       FROM current_quota cq, usage_summary us`,
      [organizationId]
    );
    
    return query.rows[0] || {
      total_queries_limit: 0,
      queries_used: 0,
      remaining_queries: 0,
      queries_usage_percentage: 0,
      total_points_limit: 0,
      points_used: 0,
      remaining_points: 0,
      points_usage_percentage: 0,
      query_limit_reset_date: null,
      overage_charges: 0
    };
  }

  async getDatabaseConnection(organizationId) {
    const query = await db.query(
      `SELECT id, db_type, host, port, database_name, username, 
              ssl_enabled, status, latency_ms, last_synced_at,
              (SELECT COUNT(*) FROM semantic_tables WHERE connection_id = dc.id) as tables_count
       FROM database_connections dc
       WHERE organization_id = $1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId]
    );
    
    return query.rows[0] || null;
  }

  async getUserMetrics(organizationId) {
    const userStats = await db.query(
      `SELECT 
         COUNT(*) as total_users,
         COUNT(CASE WHEN status = 'active' THEN 1 END) as active_users,
         COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive_users
       FROM users
       WHERE organization_id = $1`,
      [organizationId]
    );

    const usersByRole = await db.query(
      `SELECT r.name as role, COUNT(u.id) as count
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.organization_id = $1
       GROUP BY r.name`,
      [organizationId]
    );

    const topUsers = await db.query(
      `SELECT 
         u.id as user_id,
         u.full_name as user_name,
         u.email,
         r.name as role,
         COUNT(qh.id) as query_count,
         ROUND((COUNT(CASE WHEN qh.status = 'success' THEN 1 END)::numeric / NULLIF(COUNT(qh.id), 0) * 100), 1) as success_rate,
         MAX(qh.created_at) as last_active
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN query_history qh ON u.id = qh.user_id
       WHERE u.organization_id = $1
       GROUP BY u.id, u.full_name, u.email, r.name
       ORDER BY query_count DESC
       LIMIT 5`,
      [organizationId]
    );

    return {
      total_users: parseInt(userStats.rows[0].total_users),
      active_users: parseInt(userStats.rows[0].active_users),
      inactive_users: parseInt(userStats.rows[0].inactive_users),
      users_by_role: usersByRole.rows,
      top_users: topUsers.rows
    };
  }

  async getQueryAnalytics(organizationId, range) {
    const dateFilter = this.getDateFilter(range);
    
    // Daily queries
    const dailyQueries = await db.query(
      `SELECT 
         DATE(created_at) as date,
         COUNT(*) as total,
         COUNT(CASE WHEN status = 'success' THEN 1 END) as successful,
         COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
         ROUND(AVG(execution_time_ms)) as avg_execution_time
       FROM query_history
       WHERE organization_id = $1 ${dateFilter}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT 14`,
      [organizationId]
    );

    // Queries by status
    const queriesByStatus = await db.query(
      `SELECT 
         COUNT(CASE WHEN status = 'success' THEN 1 END) as successful,
         COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
         COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
         COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected
       FROM query_history
       WHERE organization_id = $1 ${dateFilter}`,
      [organizationId]
    );

    // Queries by department
    const queriesByDepartment = await db.query(
      `SELECT 
         d.name as department,
         COUNT(qh.id) as count,
         ROUND((COUNT(CASE WHEN qh.status = 'success' THEN 1 END)::numeric / NULLIF(COUNT(qh.id), 0) * 100), 1) as success_rate
       FROM departments d
       LEFT JOIN users u ON d.id = u.department_id
       LEFT JOIN query_history qh ON u.id = qh.user_id AND qh.created_at ${this.getDateFilterForJoin(range)}
       WHERE d.organization_id = $1
       GROUP BY d.id, d.name
       ORDER BY count DESC`,
      [organizationId]
    );

    // Popular questions
    const popularQuestions = await db.query(
      `SELECT 
         question,
         COUNT(*) as frequency,
         ROUND(AVG(execution_time_ms)) as avg_execution_time,
         MAX(created_at) as last_executed
       FROM query_history
       WHERE organization_id = $1 AND status = 'success'
       GROUP BY question
       ORDER BY frequency DESC
       LIMIT 5`,
      [organizationId]
    );

    return {
      daily_queries: dailyQueries.rows,
      queries_by_status: queriesByStatus.rows[0] || { successful: 0, failed: 0, pending: 0, rejected: 0 },
      queries_by_department: queriesByDepartment.rows,
      popular_questions: popularQuestions.rows
    };
  }

  async getDepartmentPerformance(organizationId) {
    const query = await db.query(
      `SELECT 
         d.id as department_id,
         d.name as department_name,
         d.privacy_level,
         COUNT(DISTINCT u.id) as user_count,
         COUNT(qh.id) as query_count,
         ROUND((COUNT(CASE WHEN qh.status = 'success' THEN 1 END)::numeric / NULLIF(COUNT(qh.id), 0) * 100), 1) as success_rate,
         COALESCE(SUM(ut.total_points_used), 0) as points_used
       FROM departments d
       LEFT JOIN users u ON d.id = u.department_id
       LEFT JOIN query_history qh ON u.id = qh.user_id
       LEFT JOIN usage_tracking ut ON d.organization_id = ut.organization_id
       WHERE d.organization_id = $1
       GROUP BY d.id, d.name, d.privacy_level
       ORDER BY query_count DESC`,
      [organizationId]
    );

    return query.rows;
  }

  async getBillingInfo(organizationId) {
    // Get current plan
    const currentPlan = await db.query(
      `SELECT 
         p.name,
         p.price_monthly as price,
         'monthly' as billing_cycle,
         o.created_at + INTERVAL '1 month' as next_billing_date,
         p.features
       FROM organizations o
       JOIN plans p ON o.plan_id = p.id
       WHERE o.id = $1`,
      [organizationId]
    );

    // Get recent invoices
    const invoices = await db.query(
      `SELECT 
         id,
         'INV-' || EXTRACT(YEAR FROM created_at) || '-' || LPAD(CAST(EXTRACT(MONTH FROM created_at) AS TEXT), 2, '0') as invoice_number,
         amount,
         status,
         TO_CHAR(created_at, 'Mon YYYY') as period,
         created_at as issued_at,
         CASE WHEN status = 'completed' THEN created_at ELSE NULL END as paid_at,
         '/api/billing/invoices/' || id as download_url
       FROM billing_transactions
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [organizationId]
    );

    // Get payment method (you might have a separate table for this)
    const paymentMethod = await db.query(
      `SELECT 
         'card' as type,
         '4242' as last4,
         '05/25' as expiry_date,
         true as is_default
       FROM organizations
       WHERE id = $1`,
      [organizationId]
    );

    return {
      current_plan: currentPlan.rows[0] || null,
      invoices: invoices.rows,
      payment_method: paymentMethod.rows[0] || { type: 'card', last4: '****', expiry_date: null, is_default: true }
    };
  }

  async getSemanticLayer(organizationId) {
    const stats = await db.query(
      `SELECT 
         (SELECT COUNT(*) FROM semantic_tables st 
          JOIN database_connections dc ON st.connection_id = dc.id 
          WHERE dc.organization_id = $1) as total_tables,
         (SELECT COUNT(*) FROM semantic_columns sc 
          JOIN semantic_tables st ON sc.semantic_table_id = st.id
          JOIN database_connections dc ON st.connection_id = dc.id
          WHERE dc.organization_id = $1) as total_columns,
         (SELECT COUNT(*) FROM semantic_tables st 
          JOIN database_connections dc ON st.connection_id = dc.id 
          WHERE dc.organization_id = $1 AND st.is_enabled = true) as enabled_tables,
         (SELECT COUNT(*) FROM semantic_columns sc 
          JOIN semantic_tables st ON sc.semantic_table_id = st.id
          JOIN database_connections dc ON st.connection_id = dc.id
          WHERE dc.organization_id = $1 AND sc.is_enabled = true) as enabled_columns`,
      [organizationId]
    );

    const recentUpdates = await db.query(
      `(SELECT 
          'table' as type,
          st.id,
          st.table_name as name,
          st.business_name,
          st.updated_at
        FROM semantic_tables st
        JOIN database_connections dc ON st.connection_id = dc.id
        WHERE dc.organization_id = $1
        ORDER BY st.updated_at DESC
        LIMIT 3)
       UNION ALL
       (SELECT 
          'column' as type,
          sc.id,
          sc.column_name as name,
          sc.business_name,
          sc.updated_at
        FROM semantic_columns sc
        JOIN semantic_tables st ON sc.semantic_table_id = st.id
        JOIN database_connections dc ON st.connection_id = dc.id
        WHERE dc.organization_id = $1
        ORDER BY sc.updated_at DESC
        LIMIT 3)
       ORDER BY updated_at DESC
       LIMIT 5`,
      [organizationId]
    );

    return {
      total_tables: parseInt(stats.rows[0].total_tables) || 0,
      total_columns: parseInt(stats.rows[0].total_columns) || 0,
      enabled_tables: parseInt(stats.rows[0].enabled_tables) || 0,
      enabled_columns: parseInt(stats.rows[0].enabled_columns) || 0,
      recent_updates: recentUpdates.rows
    };
  }

  async getRecentActivities(organizationId) {
    const query = await db.query(
      `(SELECT 
          'query' as type,
          qh.id,
          u.full_name as user_name,
          'Query Executed' as action,
          qh.question as target,
          CASE WHEN qh.status = 'success' THEN 'success' ELSE 'error' END as status,
          qh.created_at
        FROM query_history qh
        JOIN users u ON qh.user_id = u.id
        WHERE qh.organization_id = $1
        ORDER BY qh.created_at DESC
        LIMIT 3)
       UNION ALL
       (SELECT 
          'audit' as type,
          al.id,
          u.full_name as user_name,
          al.action,
          al.target,
          'success' as status,
          al.created_at
        FROM audit_logs al
        JOIN users u ON al.user_id = u.id
        WHERE al.organization_id = $1
        ORDER BY al.created_at DESC
        LIMIT 3)
       UNION ALL
       (SELECT 
          'connection' as type,
          dc.id,
          'System' as user_name,
          'Database ' || dc.status as action,
          dc.database_name as target,
          CASE WHEN dc.status = 'active' THEN 'success' ELSE 'warning' END as status,
          dc.updated_at as created_at
        FROM database_connections dc
        WHERE dc.organization_id = $1 AND dc.updated_at > NOW() - INTERVAL '7 days'
        ORDER BY dc.updated_at DESC
        LIMIT 2)
       ORDER BY created_at DESC
       LIMIT 8`,
      [organizationId]
    );

    return query.rows;
  }

  async getPerformanceMetrics(organizationId, range) {
    const dateFilter = this.getDateFilter(range);
    
    const query = await db.query(
      `SELECT 
         ROUND(AVG(execution_time_ms)) as avg_response_time,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time_ms) as p95_response_time,
         ROUND((COUNT(CASE WHEN status = 'failed' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100), 1) as error_rate,
         COUNT(CASE WHEN execution_time_ms > 1000 THEN 1 END) as slow_queries,
         ROUND(AVG(CASE WHEN qrc.id IS NOT NULL THEN 100 ELSE 0 END), 1) as cache_hit_rate
       FROM query_history qh
       LEFT JOIN query_results_cache qrc ON qh.id = qrc.query_id
       WHERE qh.organization_id = $1 ${dateFilter}`,
      [organizationId]
    );

    return {
      avg_response_time: parseInt(query.rows[0].avg_response_time) || 0,
      p95_response_time: parseInt(query.rows[0].p95_response_time) || 0,
      error_rate: parseFloat(query.rows[0].error_rate) || 0,
      slow_queries: parseInt(query.rows[0].slow_queries) || 0,
      cache_hit_rate: parseFloat(query.rows[0].cache_hit_rate) || 0
    };
  }

  async getAlerts(organizationId) {
    const alerts = [];

    // Check quota usage
    const quotaAlert = await db.query(
      `SELECT 
         remaining_queries,
         assigned_queries_limit
       FROM organization_quota_assignments
       WHERE organization_id = $1 AND is_active = true
       ORDER BY effective_date DESC
       LIMIT 1`,
      [organizationId]
    );

    if (quotaAlert.rows.length > 0) {
      const remaining = quotaAlert.rows[0].remaining_queries;
      const total = quotaAlert.rows[0].assigned_queries_limit;
      const used = total - remaining;
      const percentage = (used / total) * 100;
      
      if (percentage > 90) {
        alerts.push({
          id: 'quota_critical',
          type: 'error',
          title: 'Critical: Query Limit Almost Reached',
          description: `You have used ${percentage.toFixed(1)}% of your monthly query quota`,
          timestamp: new Date().toISOString(),
          actionable: true
        });
      } else if (percentage > 75) {
        alerts.push({
          id: 'quota_warning',
          type: 'warning',
          title: 'Query Limit Approaching',
          description: `You have used ${percentage.toFixed(1)}% of your monthly query quota`,
          timestamp: new Date().toISOString(),
          actionable: true
        });
      }
    }

    // Check for failed database connections
    const failedConnections = await db.query(
      `SELECT COUNT(*) as count
       FROM database_connections
       WHERE organization_id = $1 AND status = 'error'`,
      [organizationId]
    );

    if (parseInt(failedConnections.rows[0].count) > 0) {
      alerts.push({
        id: 'db_error',
        type: 'error',
        title: 'Database Connection Issues',
        description: `${failedConnections.rows[0].count} database connection(s) are in error state`,
        timestamp: new Date().toISOString(),
        actionable: true
      });
    }

    // Check for recent failed queries
    const failedQueries = await db.query(
      `SELECT COUNT(*) as count
       FROM query_history
       WHERE organization_id = $1 
         AND status = 'failed' 
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [organizationId]
    );

    if (parseInt(failedQueries.rows[0].count) > 10) {
      alerts.push({
        id: 'high_failure_rate',
        type: 'warning',
        title: 'High Query Failure Rate',
        description: `${failedQueries.rows[0].count} queries failed in the last hour`,
        timestamp: new Date().toISOString(),
        actionable: true
      });
    }

    return alerts;
  }

  getDateFilter(range) {
    switch(range) {
      case 'week':
        return `AND created_at >= NOW() - INTERVAL '7 days'`;
      case 'month':
        return `AND created_at >= DATE_TRUNC('month', NOW())`;
      case 'quarter':
        return `AND created_at >= DATE_TRUNC('quarter', NOW())`;
      default:
        return `AND created_at >= DATE_TRUNC('month', NOW())`;
    }
  }

  getDateFilterForJoin(range) {
    switch(range) {
      case 'week':
        return `>= NOW() - INTERVAL '7 days'`;
      case 'month':
        return `>= DATE_TRUNC('month', NOW())`;
      case 'quarter':
        return `>= DATE_TRUNC('quarter', NOW())`;
      default:
        return `>= DATE_TRUNC('month', NOW())`;
    }
  }
}

module.exports = new AdminDashboardController();