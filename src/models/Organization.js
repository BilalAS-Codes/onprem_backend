const db = require('../config/database');

const Organization = {
  async create(organizationData) {
    const { name, domain, plan_id } = organizationData;
    
    const result = await db.query(
      'INSERT INTO organizations (name, domain, plan_id) VALUES ($1, $2, $3) RETURNING *',
      [name, domain, plan_id]
    );
    
    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      'SELECT o.*, p.name as plan_name, p.query_limit, p.user_limit, p.db_limit ' +
      'FROM organizations o ' +
      'LEFT JOIN plans p ON o.plan_id = p.id ' +
      'WHERE o.id = $1',
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

  async updatePlan(organizationId, planId) {
    const result = await db.query(
      'UPDATE organizations SET plan_id = $1 WHERE id = $2 RETURNING *',
      [planId, organizationId]
    );
    return result.rows[0];
  }
};

module.exports = Organization;