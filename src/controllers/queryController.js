const db = require('../config/database');
const crypto = require('crypto');

const queryController = {
  async getQueryHistory(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const userId = req.user.id;
      const { limit = 50, offset = 0, department_id, status, search } = req.query;

      let query = `
        SELECT qh.*, u.full_name as user_name, d.name as department_name
        FROM query_history qh
        LEFT JOIN users u ON qh.user_id = u.id
        LEFT JOIN departments d ON qh.department_id = d.id
        WHERE qh.organization_id = $1
      `;
      const params = [organizationId];
      let paramCount = 2;

      // Apply RBAC: Non-admins can only see their own queries
      if (req.user.role !== 'Admin') {
        query += ` AND qh.user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      }

      // Apply department filter
      if (department_id) {
        query += ` AND qh.department_id = $${paramCount}`;
        params.push(department_id);
        paramCount++;
      }

      // Apply status filter
      if (status) {
        query += ` AND qh.status = $${paramCount}`;
        params.push(status);
        paramCount++;
      }

      // Apply search filter
      if (search) {
        query += ` AND (qh.question ILIKE $${paramCount} OR qh.sql_query ILIKE $${paramCount})`;
        params.push(`%${search}%`);
        paramCount++;
      }

      // Get total count for pagination
      const countQuery = query.replace(
        'SELECT qh.*, u.full_name as user_name, d.name as department_name',
        'SELECT COUNT(*)'
      );
      // const countResult = await db.query(countQuery, params.slice(0, -2)); 
 const countParams = [...params];

// Remove limit & offset ONLY if they exist
if (countParams.length >= 2) {
  countParams.splice(-2, 2);
}

const countResult = await db.query(countQuery, countParams);
// Remove limit/offset params
      const total = parseInt(countResult.rows[0].count);

      // Add ordering and pagination
      query += ` ORDER BY qh.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params.push(parseInt(limit), parseInt(offset));

      const result = await db.query(query, params);

      res.json({
        success: true,
        queries: result.rows,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + parseInt(limit)) < total
        }
      });
    } catch (error) {
      console.error('Get query history error:', error);
      res.status(500).json({ error: 'Failed to fetch query history' });
    }
  },

  async getQueryById(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;
      const userId = req.user.id;

      let query = `
        SELECT qh.*, u.full_name as user_name, d.name as department_name,
               qrc.result_json as cached_result
        FROM query_history qh
        LEFT JOIN users u ON qh.user_id = u.id
        LEFT JOIN departments d ON qh.department_id = d.id
        LEFT JOIN query_results_cache qrc ON qh.id = qrc.query_id
        WHERE qh.id = $1 AND qh.organization_id = $2
      `;
      const params = [id, organizationId];

      // Apply RBAC: Non-admins can only see their own queries
      if (req.user.role !== 'Admin') {
        query += ` AND qh.user_id = $3`;
        params.push(userId);
      }

      const result = await db.query(query, params);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Query not found' });
      }

      const queryData = result.rows[0];

      // Remove sensitive SQL if user doesn't have permission
      if (req.user.role === 'Viewer') {
        queryData.sql_query = '[REDACTED - Viewer role cannot see SQL]';
      }

      res.json({
        success: true,
        query: queryData
      });
    } catch (error) {
      console.error('Get query by ID error:', error);
      res.status(500).json({ error: 'Failed to fetch query' });
    }
  },

  async deleteQuery(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;
      const userId = req.user.id;

      // Verify query exists and belongs to organization
      const queryCheck = await db.query(
        'SELECT id, user_id FROM query_history WHERE id = $1 AND organization_id = $2',
        [id, organizationId]
      );

      if (queryCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Query not found' });
      }

      // Apply RBAC: Non-admins can only delete their own queries
      if (req.user.role !== 'Admin' && queryCheck.rows[0].user_id !== userId) {
        return res.status(403).json({ error: 'Cannot delete queries from other users' });
      }

      // Delete query
      await db.query(
        'DELETE FROM query_history WHERE id = $1',
        [id]
      );

      // Also delete associated cache and shared insights
      await db.query(
        'DELETE FROM query_results_cache WHERE query_id = $1',
        [id]
      );

      await db.query(
        'DELETE FROM shared_insights WHERE query_id = $1',
        [id]
      );

      res.json({
        success: true,
        message: 'Query deleted successfully'
      });
    } catch (error) {
      console.error('Delete query error:', error);
      res.status(500).json({ error: 'Failed to delete query' });
    }
  },

  async shareQuery(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;
      const userId = req.user.id;

      // Verify query exists and belongs to organization/user
      let queryCheck = `
        SELECT id FROM query_history 
        WHERE id = $1 AND organization_id = $2
      `;
      const params = [id, organizationId];

      if (req.user.role !== 'Admin') {
        queryCheck += ` AND user_id = $3`;
        params.push(userId);
      }

      const result = await db.query(queryCheck, params);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Query not found' });
      }

      // Generate unique share token
      const shareToken = crypto.randomBytes(32).toString('hex');

      // Create shared insight
      await db.query(
        'INSERT INTO shared_insights (query_id, share_token) VALUES ($1, $2)',
        [id, shareToken]
      );

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const shareUrl = `${frontendUrl}/insights/shared/${shareToken}`;

      res.json({
        success: true,
        share_token: shareToken,
        share_url: shareUrl,
        message: 'Query shared successfully'
      });
    } catch (error) {
      console.error('Share query error:', error);
      res.status(500).json({ error: 'Failed to share query' });
    }
  }
};

module.exports = queryController;