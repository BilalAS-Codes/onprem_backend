const db = require('../config/database');

const Department = {
  async create(departmentData) {
    const { organization_id, name } = departmentData;

    const result = await db.query(
      'INSERT INTO departments (organization_id, name) VALUES ($1, $2) RETURNING *',
      [organization_id, name]
    );

    return result.rows[0];
  },

  async findById(id, organizationId = null) {
    let query = 'SELECT * FROM departments WHERE id = $1';
    const params = [id];

    if (organizationId) {
      query += ' AND organization_id = $2';
      params.push(organizationId);
    }

    const result = await db.query(query, params);
    return result.rows[0];
  },

  async findByOrganization(organizationId) {
    const result = await db.query(
      `SELECT d.*,
              COUNT(DISTINCT u.id) as user_count
       FROM departments d
       LEFT JOIN users u ON d.id = u.department_id AND u.status = 'active'
       WHERE d.organization_id = $1
       GROUP BY d.id
       ORDER BY d.created_at DESC`,
      [organizationId]
    );
    return result.rows;
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
    const query = `UPDATE departments SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await db.query(query, values);
    return result.rows[0];
  },

  async delete(id, organizationId) {
    const result = await db.query(
      'DELETE FROM departments WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, organizationId]
    );
    return result.rows[0];
  }
};

module.exports = Department;
