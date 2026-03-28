const db = require('../config/database');

const DatabaseConnection = {
  async create(connectionData) {
    const {
      organization_id,
      db_type,
      host,
      port,
      database_name,
      username,
      password,
      ssl_enabled = false,
      latency_ms,
      status = 'connected'
    } = connectionData;

    const result = await db.query(
      `INSERT INTO database_connections (
        organization_id, db_type, host, port, database_name,
        username, password, ssl_enabled, latency_ms, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        organization_id, db_type, host, port, database_name,
        username, password, ssl_enabled, latency_ms, status
      ]
    );

    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      'SELECT * FROM database_connections WHERE id = $1',
      [id]
    );
    return result.rows[0];
  },
  async findByIdWithPassword(id) {
  const result = await db.query(
    'SELECT * FROM database_connections WHERE id = $1',
    [id]
  );
  return result.rows[0];
},

  async findByOrganization(organizationId) {
    const result = await db.query(
      `SELECT id, db_type, host, port, database_name, 
              ssl_enabled, latency_ms, last_synced_at, 
              status, created_at
       FROM database_connections 
       WHERE organization_id = $1 
       ORDER BY created_at DESC`,
      [organizationId]
    );
    return result.rows;
  },

  async update(id, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id') {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const query = `UPDATE database_connections 
                   SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
                   WHERE id = $${paramCount} RETURNING *`;
    
    const result = await db.query(query, values);
    return result.rows[0];
  },

  async delete(id, organizationId) {
    const result = await db.query(
      'DELETE FROM database_connections WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, organizationId]
    );
    return result.rows[0];
  },

  async updateStatus(id, status) {
    const result = await db.query(
      'UPDATE database_connections SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows[0];
  }
};

module.exports = DatabaseConnection;