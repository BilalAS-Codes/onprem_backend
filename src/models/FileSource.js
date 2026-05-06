const db = require('../config/database');

const FileSource = {
  async create(sourceData) {
    const {
      organization_id,
      source_type,
      filename,
      s3_key,
      url,
      status = 'active'
    } = sourceData;

    const result = await db.query(
      `INSERT INTO file_sources (
        organization_id, source_type, filename, s3_key, url, status
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [organization_id, source_type, filename, s3_key, url, status]
    );

    return result.rows[0];
  },

  async findByOrganization(organizationId) {
    const result = await db.query(
      `SELECT * FROM file_sources 
       WHERE organization_id = $1 
       ORDER BY created_at DESC`,
      [organizationId]
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      'SELECT * FROM file_sources WHERE id = $1',
      [id]
    );
    return result.rows[0];
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

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    const query = `UPDATE file_sources 
                   SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
                   WHERE id = $${paramCount} RETURNING *`;
    
    const result = await db.query(query, values);
    return result.rows[0];
  },

  async delete(id, organizationId) {
    const result = await db.query(
      'DELETE FROM file_sources WHERE id = $1 AND organization_id = $2 RETURNING *',
      [id, organizationId]
    );
    return result.rows[0];
  }
};

module.exports = FileSource;
