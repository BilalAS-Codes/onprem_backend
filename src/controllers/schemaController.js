const db = require('../config/database');

const schemaController = {
  async getTables(req, res) {
    try {
      const { connectionId } = req.params;
      const organizationId = req.user.organization_id;

      // Verify connection belongs to organization
      const connectionCheck = await db.query(
        'SELECT id FROM database_connections WHERE id = $1 AND organization_id = $2',
        [connectionId, organizationId]
      );

      if (!connectionCheck.rows[0]) {
        return res.status(404).json({ error: 'Database connection not found' });
      }

      const result = await db.query(
        `SELECT st.*, 
                COUNT(sc.id) as column_count,
                SUM(CASE WHEN sc.is_enabled = true THEN 1 ELSE 0 END) as enabled_columns
         FROM semantic_tables st
         LEFT JOIN semantic_columns sc ON st.id = sc.semantic_table_id
         WHERE st.connection_id = $1 AND st.is_enabled = true
         GROUP BY st.id
         ORDER BY st.table_name`,
        [connectionId]
      );

      res.json({
        success: true,
        tables: result.rows
      });
    } catch (error) {
      console.error('Get tables error:', error);
      res.status(500).json({ error: 'Failed to fetch tables' });
    }
  },

  async getColumns(req, res) {
    try {
      const { connectionId, tableName } = req.params;
      const organizationId = req.user.organization_id;

      // Verify connection belongs to organization
      const connectionCheck = await db.query(
        'SELECT id FROM database_connections WHERE id = $1 AND organization_id = $2',
        [connectionId, organizationId]
      );

      if (!connectionCheck.rows[0]) {
        return res.status(404).json({ error: 'Database connection not found' });
      }

      const result = await db.query(
        `SELECT sc.*, st.table_name
         FROM semantic_columns sc
         JOIN semantic_tables st ON sc.semantic_table_id = st.id
         WHERE st.connection_id = $1 AND st.table_name = $2
         ORDER BY sc.column_name`,
        [connectionId, tableName]
      );

      res.json({
        success: true,
        columns: result.rows
      });
    } catch (error) {
      console.error('Get columns error:', error);
      res.status(500).json({ error: 'Failed to fetch columns' });
    }
  },

  async createTableMapping(req, res) {
    try {
      const { connection_id, table_name, business_name, is_enabled = true } = req.body;
      const organizationId = req.user.organization_id;

      // Verify connection belongs to organization
      const connectionCheck = await db.query(
        'SELECT id FROM database_connections WHERE id = $1 AND organization_id = $2',
        [connection_id, organizationId]
      );

      if (!connectionCheck.rows[0]) {
        return res.status(404).json({ error: 'Database connection not found' });
      }

      const result = await db.query(
        `INSERT INTO semantic_tables (connection_id, table_name, business_name, is_enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (connection_id, table_name) 
         DO UPDATE SET 
           business_name = EXCLUDED.business_name,
           is_enabled = EXCLUDED.is_enabled,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [connection_id, table_name, business_name, is_enabled]
      );

      res.status(201).json({
        success: true,
        table: result.rows[0]
      });
    } catch (error) {
      console.error('Create table mapping error:', error);
      res.status(500).json({ error: 'Failed to create table mapping' });
    }
  },

  async createColumnMapping(req, res) {
    try {
      const {
        semantic_table_id,
        column_name,
        business_name,
        data_type,
        is_nullable,
        default_value,
        department_access = 'all',
        is_enabled = true
      } = req.body;

      const organizationId = req.user.organization_id;

      // Verify table belongs to organization
      const tableCheck = await db.query(
        `SELECT st.id 
         FROM semantic_tables st
         JOIN database_connections dc ON st.connection_id = dc.id
         WHERE st.id = $1 AND dc.organization_id = $2`,
        [semantic_table_id, organizationId]
      );

      if (!tableCheck.rows[0]) {
        return res.status(404).json({ error: 'Table not found' });
      }

      const result = await db.query(
        `INSERT INTO semantic_columns (
          semantic_table_id, column_name, business_name, data_type,
          is_nullable, default_value, department_access, is_enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (semantic_table_id, column_name) 
        DO UPDATE SET 
          business_name = EXCLUDED.business_name,
          department_access = EXCLUDED.department_access,
          is_enabled = EXCLUDED.is_enabled,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [
          semantic_table_id, column_name, business_name, data_type,
          is_nullable, default_value, department_access, is_enabled
        ]
      );

      res.status(201).json({
        success: true,
        column: result.rows[0]
      });
    } catch (error) {
      console.error('Create column mapping error:', error);
      res.status(500).json({ error: 'Failed to create column mapping' });
    }
  },

  async getMappedTables(req, res) {
    try {
      const organizationId = req.user.organization_id;

      const result = await db.query(
        `SELECT st.*, dc.database_name, dc.db_type
         FROM semantic_tables st
         JOIN database_connections dc ON st.connection_id = dc.id
         WHERE dc.organization_id = $1
         ORDER BY dc.database_name, st.table_name`,
        [organizationId]
      );

      res.json({
        success: true,
        tables: result.rows
      });
    } catch (error) {
      console.error('Get mapped tables error:', error);
      res.status(500).json({ error: 'Failed to fetch mapped tables' });
    }
  },

  async getMappedColumns(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const { table_id } = req.query;

      let query = `
        SELECT sc.*, st.table_name, st.business_name as table_business_name,
               dc.database_name, dc.db_type
        FROM semantic_columns sc
        JOIN semantic_tables st ON sc.semantic_table_id = st.id
        JOIN database_connections dc ON st.connection_id = dc.id
        WHERE dc.organization_id = $1
      `;
      const params = [organizationId];

      if (table_id) {
        query += ' AND sc.semantic_table_id = $2';
        params.push(table_id);
      }

      query += ' ORDER BY st.table_name, sc.column_name';

      const result = await db.query(query, params);

      res.json({
        success: true,
        columns: result.rows
      });
    } catch (error) {
      console.error('Get mapped columns error:', error);
      res.status(500).json({ error: 'Failed to fetch mapped columns' });
    }
  }
};

module.exports = schemaController;