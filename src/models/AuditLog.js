const db = require('../config/database');

const AuditLog = {
  async create(logData) {
    const {
      organization_id,
      user_id,
      action,
      target,
      metadata = {}
    } = logData;

    const result = await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, target, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [organization_id, user_id, action, target, metadata]
    );

    return result.rows[0];
  },

  async findByOrganization(organizationId, filters = {}) {
    let query = `
      SELECT al.*, u.full_name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.organization_id = $1
    `;
    const params = [organizationId];
    let paramCount = 2;

    if (filters.user_id) {
      query += ` AND al.user_id = $${paramCount}`;
      params.push(filters.user_id);
      paramCount++;
    }

    if (filters.action) {
      query += ` AND al.action = $${paramCount}`;
      params.push(filters.action);
      paramCount++;
    }

    if (filters.start_date) {
      query += ` AND al.created_at >= $${paramCount}`;
      params.push(filters.start_date);
      paramCount++;
    }

    if (filters.end_date) {
      query += ` AND al.created_at <= $${paramCount}`;
      params.push(filters.end_date);
      paramCount++;
    }

    query += ' ORDER BY al.created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramCount}`;
      params.push(filters.limit);
    }

    const result = await db.query(query, params);
    return result.rows;
  },

  async cleanupOldLogs(days = 90) {
    const result = await db.query(
      `DELETE FROM audit_logs 
       WHERE created_at < NOW() - INTERVAL '${days} days'
       RETURNING COUNT(*) as deleted_count`
    );
    return parseInt(result.rows[0].deleted_count);
  }
};

module.exports = AuditLog;