const db = require('../config/database');

const insightController = {
  async getSharedInsight(req, res) {
    try {
      const { token } = req.params;

      // Get shared insight with query details
      const result = await db.query(
        `SELECT si.*, qh.*, u.full_name as user_name, 
                o.name as organization_name
         FROM shared_insights si
         JOIN query_history qh ON si.query_id = qh.id
         JOIN users u ON qh.user_id = u.id
         JOIN organizations o ON qh.organization_id = o.id
         WHERE si.share_token = $1`,
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Shared insight not found or expired' });
      }

      const insight = result.rows[0];

      // Get cached result if available
      const cacheResult = await db.query(
        'SELECT result_json FROM query_results_cache WHERE query_id = $1 AND expires_at > NOW()',
        [insight.query_id]
      );

      const response = {
        success: true,
        insight: {
          id: insight.id,
          question: insight.question,
          created_at: insight.created_at,
          user_name: insight.user_name,
          organization_name: insight.organization_name
        }
      };

      // Add cached result if available
      if (cacheResult.rows.length > 0) {
        response.insight.result = cacheResult.rows[0].result_json;
      } else {
        response.insight.result = 'Result not cached or cache expired';
      }

      // Remove SQL query for security
      delete insight.sql_query;

      res.json(response);
    } catch (error) {
      console.error('Get shared insight error:', error);
      res.status(500).json({ error: 'Failed to fetch shared insight' });
    }
  }
};

module.exports = insightController;