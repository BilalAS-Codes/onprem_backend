const db = require('../config/database');

const Department = {
  async create(departmentData) {
    const { organization_id, name, privacy_level = 'private' } = departmentData;
    
    const result = await db.query(
      'INSERT INTO departments (organization_id, name, privacy_level) VALUES ($1, $2, $3) RETURNING *',
      [organization_id, name, privacy_level]
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
              COUNT(DISTINCT u.id) as user_count,
              COUNT(DISTINCT CASE
                WHEN st.is_enabled = true
                  AND sc.is_enabled = true
                  AND (
                    COALESCE(sc.department_access, 'all') = 'all'
                    OR (
                      LEFT(TRIM(COALESCE(sc.department_access, '')), 1) = '['
                      AND EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(sc.department_access::jsonb) AS dept_access(value)
                        WHERE dept_access.value = d.id::text
                      )
                    )
                  )
                THEN st.table_name
              END) as tables_count,
              STRING_AGG(DISTINCT CASE
                WHEN st.is_enabled = true
                  AND sc.is_enabled = true
                  AND (
                    COALESCE(sc.department_access, 'all') = 'all'
                    OR (
                      LEFT(TRIM(COALESCE(sc.department_access, '')), 1) = '['
                      AND EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(sc.department_access::jsonb) AS dept_access(value)
                        WHERE dept_access.value = d.id::text
                      )
                    )
                  )
                THEN st.table_name
              END, ', ') as accessible_tables
       FROM departments d
       LEFT JOIN users u ON d.id = u.department_id AND u.status = 'active'
       LEFT JOIN database_connections dc ON dc.organization_id = d.organization_id
       LEFT JOIN semantic_tables st ON st.connection_id = dc.id
       LEFT JOIN semantic_columns sc ON sc.semantic_table_id = st.id
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
  },

  async setPermissions(departmentId, permissions) {
    // Delete existing permissions
    await db.query(
      'DELETE FROM department_permissions WHERE department_id = $1',
      [departmentId]
    );

    // Insert new permissions
    for (const permission of permissions) {
      await db.query(
        'INSERT INTO department_permissions (department_id, table_name, access_level) VALUES ($1, $2, $3)',
        [departmentId, permission.table_name, permission.access_level]
      );
    }

    return this.getPermissions(departmentId);
  },

  async getPermissions(departmentId) {
    const result = await db.query(
      'SELECT * FROM department_permissions WHERE department_id = $1 ORDER BY table_name',
      [departmentId]
    );
    return result.rows;
  }
};

module.exports = Department;
