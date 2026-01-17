const db = require('../config/database');
const bcrypt = require('bcryptjs');

const User = {
  async findByEmail(email) {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      'SELECT u.*, r.name as role_name, d.name as department_name ' +
      'FROM users u ' +
      'LEFT JOIN roles r ON u.role_id = r.id ' +
      'LEFT JOIN departments d ON u.department_id = d.id ' +
      'WHERE u.id = $1',
      [id]
    );
    return result.rows[0];
  },

  async create(userData) {
    const { organization_id, full_name, email, password, role_id, department_id } = userData;
    const passwordHash = await bcrypt.hash(password, 10);
    
    const result = await db.query(
      'INSERT INTO users (organization_id, full_name, email, password_hash, role_id, department_id) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [organization_id, full_name, email, passwordHash, role_id, department_id]
    );
    
    return result.rows[0];
  },

  async update(id, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'password') {
        const passwordHash = await bcrypt.hash(value, 10);
        fields.push(`password_hash = $${paramCount}`);
        values.push(passwordHash);
      } else if (key !== 'password_hash') {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
      }
      paramCount++;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    
    const result = await db.query(query, values);
    return result.rows[0];
  },

  async findByOrganization(organizationId, filters = {}) {
    let query = 'SELECT u.*, r.name as role_name, d.name as department_name FROM users u ' +
                'LEFT JOIN roles r ON u.role_id = r.id ' +
                'LEFT JOIN departments d ON u.department_id = d.id ' +
                'WHERE u.organization_id = $1';
    const params = [organizationId];
    let paramCount = 2;

    if (filters.department_id) {
      query += ` AND u.department_id = $${paramCount}`;
      params.push(filters.department_id);
      paramCount++;
    }

    if (filters.status) {
      query += ` AND u.status = $${paramCount}`;
      params.push(filters.status);
      paramCount++;
    }

    query += ' ORDER BY u.created_at DESC';
    
    const result = await db.query(query, params);
    return result.rows;
  },

  async verifyPassword(password, passwordHash) {
    return await bcrypt.compare(password, passwordHash);
  }
};

module.exports = User;