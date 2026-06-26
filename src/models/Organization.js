const db = require('../config/database');

const Organization = {
  async create(organizationData) {
    const { name, domain } = organizationData;

    const result = await db.query(
      'INSERT INTO organizations (name, domain, is_active) VALUES ($1, $2, true) RETURNING *',
      [name, domain]
    );

    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      'SELECT id, name, domain, is_active, created_at FROM organizations WHERE id = $1',
      [id]
    );
    return result.rows[0];
  },

  async findByDomain(domain) {
    const result = await db.query(
      'SELECT * FROM organizations WHERE domain = $1',
      [domain]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const { name, domain, is_active } = data;
    const result = await db.query(
      'UPDATE organizations SET name = COALESCE($1, name), domain = COALESCE($2, domain), is_active = COALESCE($3, is_active) WHERE id = $4 RETURNING *',
      [name, domain, is_active, id]
    );
    return result.rows[0];
  }
};

module.exports = Organization;