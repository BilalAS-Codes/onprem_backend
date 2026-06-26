// controllers/adminDashboard.controller.js
const db = require('../config/database');

class AdminDashboardController {
  async getDashboard(req, res) {
    try {
      const { range = 'month' } = req.query;
      const organizationId = req.user.organization_id;

      const [
        organization,
        usageSummary,
        userMetrics,
        queryAnalytics,
        departmentPerformance,
        recentActivities,
        performanceMetrics
      ] = await Promise.all([
        this.getOrganizationInfo(organizationId),
        this.getUsageSummary(organizationId, range),
        this.getUserMetrics(organizationId),
        this.getQueryAnalytics(organizationId, range),
        this.getDepartmentPerformance(organizationId),
        this.getRecentActivities(organizationId),
        this.getPerformanceMetrics(organizationId, range)
      ]);

      res.json({
        organization,
        usage_summary: usageSummary,
        user_metrics: userMetrics,
        query_analytics: queryAnalytics,
        department_performance: departmentPerformance,
        recent_activities: recentActivities,
        performance_metrics: performanceMetrics
      });

    } catch (error) {
      console.error('Error in admin dashboard:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard data', details: error.message });
    }
  }

  async getOrganizationInfo(organizationId) {
    const query = await db.query(
      `SELECT id, name, domain, is_active, created_at
       FROM organizations
       WHERE id = $1`,
      [organizationId]
    );
    return query.rows[0] || null;
  }

  async getUsageSummary(organizationId, range) {
    const month = new Date().toISOString().slice(0, 7); // e.g. '2026-06'

    // Try to get from usage_summary table first
    const summary = await db.query(
      `SELECT query_count, successful_queries, rejected_queries,
              average_response_time, error_rate, month
       FROM usage_summary
       WHERE organization_id = $1 AND month = $2
       LIMIT 1`,
      [organizationId, month]
    );

    if (summary.rows.length > 0) {
      return summary.rows[0];
    }

    // Fallback: compute live from query_history
    const dateFilter = this.getDateFilter(range);
    const live = await db.query(
      `SELECT
         COUNT(*) as query_count,
         COUNT(CASE WHEN status = 'success' THEN 1 END) as successful_queries,
         COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_queries,
         ROUND(AVG(execution_time_ms)) as average_response_time,
         ROUND((COUNT(CASE WHEN status = 'failed' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100), 1) as error_rate
       FROM query_history
       WHERE organization_id = $1 ${dateFilter}`,
      [organizationId]
    );

    return live.rows[0] || {
      query_count: 0, successful_queries: 0, rejected_queries: 0,
      average_response_time: 0, error_rate: 0, month
    };
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
         COALESCE(activity.query_count, 0) as query_count,
         ROUND((COALESCE(activity.success_count, 0)::numeric / NULLIF(COALESCE(activity.query_count, 0), 0) * 100), 1) as success_rate,
         activity.last_active
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN (
         SELECT
           qh.user_id,
           COUNT(*) as query_count,
           COUNT(CASE WHEN qh.status = 'success' THEN 1 END) as success_count,
           MAX(qh.created_at) as last_active
         FROM query_history qh
         WHERE qh.organization_id = $1
         GROUP BY qh.user_id
       ) activity ON u.id = activity.user_id
       WHERE u.organization_id = $1
       ORDER BY COALESCE(activity.query_count, 0) DESC
       LIMIT 5`,
      [organizationId]
    );

    return {
      total_users:    parseInt(userStats.rows[0].total_users),
      active_users:   parseInt(userStats.rows[0].active_users),
      inactive_users: parseInt(userStats.rows[0].inactive_users),
      users_by_role:  usersByRole.rows,
      top_users:      topUsers.rows
    };
  }

  async getQueryAnalytics(organizationId, range) {
    const dateFilter = this.getDateFilter(range);

    const dailyQueries = await db.query(
      `SELECT
         DATE(created_at) as date,
         COUNT(*) as total,
         COUNT(CASE WHEN status = 'success' THEN 1 END) as successful,
         COUNT(CASE WHEN status = 'failed'  THEN 1 END) as failed,
         ROUND(AVG(execution_time_ms)) as avg_execution_time
       FROM query_history
       WHERE organization_id = $1 ${dateFilter}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT 14`,
      [organizationId]
    );

    const queriesByStatus = await db.query(
      `SELECT
         COUNT(CASE WHEN status = 'success'  THEN 1 END) as successful,
         COUNT(CASE WHEN status = 'failed'   THEN 1 END) as failed,
         COUNT(CASE WHEN status = 'pending'  THEN 1 END) as pending,
         COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected
       FROM query_history
       WHERE organization_id = $1 ${dateFilter}`,
      [organizationId]
    );

    const queriesByDepartment = await db.query(
      `SELECT
         d.name as department,
         COUNT(qh.id) as count,
         ROUND((COUNT(CASE WHEN qh.status = 'success' THEN 1 END)::numeric / NULLIF(COUNT(qh.id), 0) * 100), 1) as success_rate
       FROM departments d
       LEFT JOIN users u ON d.id = u.department_id
       LEFT JOIN query_history qh ON u.id = qh.user_id
         AND qh.created_at ${this.getDateFilterForJoin(range)}
       WHERE d.organization_id = $1
       GROUP BY d.id, d.name
       ORDER BY count DESC`,
      [organizationId]
    );

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
      daily_queries:         dailyQueries.rows,
      queries_by_status:     queriesByStatus.rows[0] || { successful: 0, failed: 0, pending: 0, rejected: 0 },
      queries_by_department: queriesByDepartment.rows,
      popular_questions:     popularQuestions.rows
    };
  }

  async getDepartmentPerformance(organizationId) {
    const query = await db.query(
      `SELECT
         d.id as department_id,
         d.name as department_name,
         COUNT(DISTINCT u.id) as user_count,
         COUNT(qh.id) as query_count,
         ROUND((COUNT(CASE WHEN qh.status = 'success' THEN 1 END)::numeric / NULLIF(COUNT(qh.id), 0) * 100), 1) as success_rate
       FROM departments d
       LEFT JOIN users u ON d.id = u.department_id
       LEFT JOIN query_history qh ON u.id = qh.user_id
       WHERE d.organization_id = $1
       GROUP BY d.id, d.name
       ORDER BY query_count DESC`,
      [organizationId]
    );
    return query.rows;
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
         LIMIT 5)
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
         COUNT(CASE WHEN execution_time_ms > 1000 THEN 1 END) as slow_queries
       FROM query_history
       WHERE organization_id = $1 ${dateFilter}`,
      [organizationId]
    );

    return {
      avg_response_time: parseInt(query.rows[0].avg_response_time)  || 0,
      p95_response_time: parseInt(query.rows[0].p95_response_time)  || 0,
      error_rate:        parseFloat(query.rows[0].error_rate)        || 0,
      slow_queries:      parseInt(query.rows[0].slow_queries)        || 0
    };
  }

  getDateFilter(range) {
    switch (range) {
      case 'week':    return `AND created_at >= NOW() - INTERVAL '7 days'`;
      case 'month':   return `AND created_at >= DATE_TRUNC('month', NOW())`;
      case 'quarter': return `AND created_at >= DATE_TRUNC('quarter', NOW())`;
      default:        return `AND created_at >= DATE_TRUNC('month', NOW())`;
    }
  }

  getDateFilterForJoin(range) {
    switch (range) {
      case 'week':    return `>= NOW() - INTERVAL '7 days'`;
      case 'month':   return `>= DATE_TRUNC('month', NOW())`;
      case 'quarter': return `>= DATE_TRUNC('quarter', NOW())`;
      default:        return `>= DATE_TRUNC('month', NOW())`;
    }
  }
}

module.exports = new AdminDashboardController();
