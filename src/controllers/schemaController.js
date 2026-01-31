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

    // Get tables from YOUR semantic_tables table (which now has the actual schema)
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
    
    // Verify connection
    const connectionCheck = await db.query(
      'SELECT id FROM database_connections WHERE id = $1 AND organization_id = $2',
      [connectionId, organizationId]
    );

    if (!connectionCheck.rows[0]) {
      return res.status(404).json({ error: 'Database connection not found' });
    }

    // Get semantic_table_id first
    const tableResult = await db.query(
      `SELECT id FROM semantic_tables 
       WHERE connection_id = $1 AND TRIM(table_name) = TRIM($2)`,
      [connectionId, tableName]
    );

    if (tableResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Table not found',
        details: { connectionId, tableName }
      });
    }

    const semanticTableId = tableResult.rows[0].id;

    // Query columns directly using semantic_table_id
    const result = await db.query(
      `SELECT sc.*, st.table_name
       FROM semantic_columns sc
       JOIN semantic_tables st ON sc.semantic_table_id = st.id
       WHERE sc.semantic_table_id = $1
       ORDER BY sc.column_name`,
      [semanticTableId]
    );

    res.json({
      success: true,
      columns: result.rows
    });
  } catch (error) {
    console.error('Get columns error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch columns',
      details: error.message 
    });
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

async discoverAndSeedSchema(req, res) {
  try {
    const { connectionId } = req.params;
    const organizationId = req.user.organization_id;
    const { 
      seed_tables = true, 
      seed_columns = true,
      override_existing = false 
    } = req.body;

    console.log(`Starting schema discovery for connection: ${connectionId}`);

    // Get database connection details
    const connectionResult = await db.query(
      `SELECT * FROM database_connections 
       WHERE id = $1 AND organization_id = $2`,
      [connectionId, organizationId]
    );

    if (!connectionResult.rows[0]) {
      return res.status(404).json({ error: 'Database connection not found' });
    }

    const dbConfig = connectionResult.rows[0];
    
    // Import the discoverer
    const dbDiscoverer = require('../helpers/dbDiscoverer');
    
    // Connect to the external database (RDS)
    const pool = await dbDiscoverer.getConnectionPool(dbConfig);
    
    // Discover all tables from external database
    const tables = await dbDiscoverer.discoverTables(pool, dbConfig.db_type);
    
    console.log(`Discovered ${tables.length} tables`);
    
    let seededTables = [];
    let seededColumns = [];
    let errors = [];
    
    // First, let's clear existing data if override is true
    if (override_existing) {
      try {
        await db.query(
          `DELETE FROM semantic_columns WHERE semantic_table_id IN (
            SELECT id FROM semantic_tables WHERE connection_id = $1
          )`,
          [connectionId]
        );
        
        await db.query(
          `DELETE FROM semantic_tables WHERE connection_id = $1`,
          [connectionId]
        );
        
        console.log(`Cleared existing data for connection: ${connectionId}`);
      } catch (clearError) {
        console.error('Error clearing existing data:', clearError.message);
      }
    }
    
    // Seed tables into YOUR semantic_tables table
    if (seed_tables) {
      for (const table of tables) {
        try {
          // Ensure table_name is a string
          const tableName = String(table.table_name || '').trim();
          
          console.log(`Processing table: "${tableName}"`);
          
          let result;
          
          // Use explicit type casting in the query
          if (override_existing) {
            // Use DO NOTHING on conflict since we already cleared data
            result = await db.query(
              `INSERT INTO semantic_tables (
                connection_id, table_name, business_name, is_enabled
              )
              VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), true)
              ON CONFLICT (connection_id, table_name) 
              DO NOTHING
              RETURNING *`,
              [
                connectionId,
                tableName,
                tableName // business_name same as table_name initially
              ]
            );
          } else {
            // Insert only if not exists
            result = await db.query(
              `INSERT INTO semantic_tables (
                connection_id, table_name, business_name, is_enabled
              )
              SELECT $1::uuid, $2::varchar(255), $3::varchar(255), true
              WHERE NOT EXISTS (
                SELECT 1 FROM semantic_tables 
                WHERE connection_id = $1::uuid AND table_name = $2::varchar(255)
              )
              RETURNING *`,
              [
                connectionId,
                tableName,
                tableName
              ]
            );
          }
          
          if (result.rows[0]) {
            const tableRecord = result.rows[0];
            seededTables.push(tableRecord);
            
            // Discover and seed columns for this table if requested
            if (seed_columns) {
              const tableId = tableRecord.id;
              const columns = await dbDiscoverer.discoverColumns(
                pool, 
                dbConfig.db_type, 
                tableName
              );
              
              console.log(`Discovered ${columns.length} columns for table: ${tableName}`);
              
              for (const column of columns) {
                try {
                  // Ensure column values are properly typed
                  const columnName = String(column.column_name || '').trim();
                  const dataType = String(column.data_type || '').trim();
                  const isNullable = column.is_nullable === 'YES';
                  const defaultValue = column.default_value !== null && 
                                      column.default_value !== undefined ? 
                    String(column.default_value) : null;
                  
                  let columnResult;
                  
                  if (override_existing) {
                    // Upsert column
                    columnResult = await db.query(
                      `INSERT INTO semantic_columns (
                        semantic_table_id, column_name, business_name,
                        data_type, is_nullable, default_value, is_enabled
                      )
                      VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), 
                              $4::varchar(100), $5::boolean, $6::text, true)
                      ON CONFLICT (semantic_table_id, column_name) 
                      DO UPDATE SET 
                        data_type = EXCLUDED.data_type,
                        is_nullable = EXCLUDED.is_nullable,
                        default_value = EXCLUDED.default_value,
                        updated_at = CURRENT_TIMESTAMP
                      RETURNING *`,
                      [
                        tableId,
                        columnName,
                        columnName, // business_name same as column_name initially
                        dataType,
                        isNullable,
                        defaultValue
                      ]
                    );
                  } else {
                    // Insert only if not exists
                    columnResult = await db.query(
                      `INSERT INTO semantic_columns (
                        semantic_table_id, column_name, business_name,
                        data_type, is_nullable, default_value, is_enabled
                      )
                      SELECT $1::uuid, $2::varchar(255), $3::varchar(255), 
                             $4::varchar(100), $5::boolean, $6::text, true
                      WHERE NOT EXISTS (
                        SELECT 1 FROM semantic_columns 
                        WHERE semantic_table_id = $1::uuid AND column_name = $2::varchar(255)
                      )
                      RETURNING *`,
                      [
                        tableId,
                        columnName,
                        columnName,
                        dataType,
                        isNullable,
                        defaultValue
                      ]
                    );
                  }
                  
                  if (columnResult.rows[0]) {
                    seededColumns.push(columnResult.rows[0]);
                  }
                } catch (columnError) {
                  const errorMsg = `Error seeding column ${column.column_name}: ${columnError.message}`;
                  console.error(errorMsg);
                  errors.push(errorMsg);
                  // Continue with other columns
                }
              }
            }
          } else {
            console.log(`Table ${tableName} already exists or not inserted`);
          }
        } catch (tableError) {
          const errorMsg = `Error seeding table ${table.table_name}: ${tableError.message}`;
          console.error(errorMsg);
          errors.push(errorMsg);
          // Continue with other tables
        }
      }
    }
    
    // Release the connection pool to external database
    await pool.end();
    
    res.status(200).json({
      success: true,
      message: 'Schema discovery and seeding completed',
      summary: {
        total_tables_discovered: tables.length,
        tables_seeded: seededTables.length,
        columns_seeded: seededColumns.length,
        connection: {
          id: dbConfig.id,
          database_name: dbConfig.database_name,
          db_type: dbConfig.db_type,
          host: dbConfig.host
        }
      },
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // Show only first 10 errors
      tables: seededTables,
      columns: seededColumns
    });
    
  } catch (error) {
    console.error('Discover and seed schema error:', error);
    res.status(500).json({ 
      error: 'Failed to discover and seed schema',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
},

async debugTableInsert(req, res) {
  try {
    const { connectionId } = req.params;
    const organizationId = req.user.organization_id;
    const { table_name = 'users' } = req.body;

    console.log(`Debug insert for table: ${table_name}`);

    // Get database connection details
    const connectionResult = await db.query(
      `SELECT * FROM database_connections 
       WHERE id = $1 AND organization_id = $2`,
      [connectionId, organizationId]
    );

    if (!connectionResult.rows[0]) {
      return res.status(404).json({ error: 'Database connection not found' });
    }

    const dbConfig = connectionResult.rows[0];
    
    // Test 1: Try simple insert without ON CONFLICT
    const test1 = await db.query(
      `INSERT INTO semantic_tables (connection_id, table_name, business_name, is_enabled)
       VALUES ($1, $2, $3, true)
       RETURNING *`,
      [connectionId, table_name, table_name]
    ).catch(err => ({ error: err.message }));
    
    // Test 2: Try with explicit type casting
    const test2 = await db.query(
      `INSERT INTO semantic_tables (connection_id, table_name, business_name, is_enabled)
       VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), true)
       RETURNING *`,
      [connectionId, table_name, table_name]
    ).catch(err => ({ error: err.message }));
    
    // Test 3: Check if table already exists
    const existingCheck = await db.query(
      `SELECT id, table_name, pg_typeof(table_name) as table_name_type 
       FROM semantic_tables 
       WHERE connection_id = $1 AND table_name = $2`,
      [connectionId, table_name]
    );
    
    // Test 4: Try with different table name
    const testTableName = 'test_table_' + Date.now();
    const test4 = await db.query(
      `INSERT INTO semantic_tables (connection_id, table_name, business_name, is_enabled)
       VALUES ($1, $2, $3, true)
       RETURNING *`,
      [connectionId, testTableName, testTableName]
    ).catch(err => ({ error: err.message }));

    res.json({
      success: true,
      tests: {
        test1,
        test2,
        test3: {
          exists: existingCheck.rows.length > 0,
          data: existingCheck.rows[0]
        },
        test4
      },
      parameters: {
        connectionId,
        table_name,
        table_name_type: typeof table_name
      }
    });
    
  } catch (error) {
    console.error('Debug table insert error:', error);
    res.status(500).json({ 
      error: 'Debug failed',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
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