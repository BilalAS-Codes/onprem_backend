const db = require('../config/database');

const QueryHistory = {
  async create(queryData) {
    const {
      organization_id,
      user_id,
      department_id,
      question,
      sql_query,
      status = 'pending',
      execution_time_ms = 0
    } = queryData;

    const result = await db.query(
      `INSERT INTO query_history (
        organization_id, user_id, department_id, question,
        sql_query, status, execution_time_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        organization_id, user_id, department_id, question,
        sql_query, status, execution_time_ms
      ]
    );

    return result.rows[0];
  },

  async update(id, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }

    values.push(id);
    const query = `UPDATE query_history SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    
    const result = await db.query(query, values);
    return result.rows[0];
  },

  async cacheResult(queryId, resultJson, ttlMinutes = 60) {
    const cacheKey = `query_result_${queryId}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const result = await db.query(
      `INSERT INTO query_results_cache (query_id, result_json, cache_key, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (query_id) 
       DO UPDATE SET 
         result_json = EXCLUDED.result_json,
         cache_key = EXCLUDED.cache_key,
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [queryId, resultJson, cacheKey, expiresAt]
    );

    return result.rows[0];
  },

  async getCachedResult(queryId) {
    const result = await db.query(
      'SELECT result_json FROM query_results_cache WHERE query_id = $1 AND expires_at > NOW()',
      [queryId]
    );
    return result.rows[0]?.result_json;
  }
};

module.exports = QueryHistory;