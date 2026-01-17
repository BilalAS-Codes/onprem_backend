const db = require('../config/database');

const auditController = {
  async getAuditLogs(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const { 
        limit = 100, 
        offset = 0, 
        action, 
        user_id, 
        start_date, 
        end_date,
        target 
      } = req.query;

      let query = `
        SELECT al.*, u.full_name as user_name, u.email as user_email
        FROM audit_logs al
        LEFT JOIN users u ON al.user_id = u.id
        WHERE al.organization_id = $1
      `;
      const params = [organizationId];
      let paramCount = 2;

      // Apply filters
      if (action) {
        query += ` AND al.action = $${paramCount}`;
        params.push(action);
        paramCount++;
      }

      if (user_id) {
        query += ` AND al.user_id = $${paramCount}`;
        params.push(user_id);
        paramCount++;
      }

      if (target) {
        query += ` AND al.target = $${paramCount}`;
        params.push(target);
        paramCount++;
      }

      if (start_date) {
        query += ` AND al.created_at >= $${paramCount}`;
        params.push(start_date);
        paramCount++;
      }

      if (end_date) {
        query += ` AND al.created_at <= $${paramCount}`;
        params.push(end_date);
        paramCount++;
      }

      // Get total count
      const countQuery = query.replace(
        'SELECT al.*, u.full_name as user_name, u.email as user_email',
        'SELECT COUNT(*)'
      );
      const countResult = await db.query(countQuery, params);
      const total = parseInt(countResult.rows[0].count);

      // Add ordering and pagination
      query += ` ORDER BY al.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params.push(parseInt(limit), parseInt(offset));

      const result = await db.query(query, params);

      // Clean up metadata for response
      const logs = result.rows.map(log => {
        const metadata = log.metadata || {};
        // Remove sensitive data from metadata if present
        if (metadata.requestBody && metadata.requestBody.password) {
          delete metadata.requestBody.password;
        }
        if (metadata.requestBody && metadata.requestBody.password_hash) {
          delete metadata.requestBody.password_hash;
        }

        return {
          ...log,
          metadata
        };
      });

      res.json({
        success: true,
        logs,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + parseInt(limit)) < total
        }
      });
    } catch (error) {
      console.error('Get audit logs error:', error);
      res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  }
};

module.exports = auditController;