const db = require('../config/database');
const dbDiscoverer = require('../helpers/dbDiscoverer');
const fileDiscoverer = require('../helpers/fileDiscoverer');
const { ensureSchemaMetadataStorage } = require('../helpers/semanticMetadata');

const normalizeDepartmentAccessValue = (departmentAccess) => {
  if (departmentAccess == null) return 'all';

  const normalized = String(departmentAccess).trim();
  if (!normalized || normalized.toLowerCase() === 'all') {
    return 'all';
  }

  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw new Error('department_access must be "all" or a valid JSON array of department ids');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('department_access must be "all" or a valid JSON array of department ids');
  }

  return JSON.stringify(
    parsed
      .map((value) => String(value).trim())
      .filter(Boolean)
  );
};

const schemaController = {
  async getTables(req, res) {
  try {
    const { connectionId } = req.params;
    const organizationId = req.user.organization_id;

    await ensureSchemaMetadataStorage(db);

    const isMultiFile = connectionId === 'multi-file-source';

    if (!isMultiFile && (!connectionId || typeof connectionId !== 'string' || connectionId === 'null')) {
      return res.status(400).json({ error: 'Invalid connection ID' });
    }

    let tablesQuery;
    let queryParams;

    if (isMultiFile) {
      tablesQuery = `
        SELECT
            st.*,
            fs.filename as source_filename,
            (SELECT COUNT(*) FROM semantic_columns sc WHERE sc.semantic_table_id = st.id) AS column_count,
            (SELECT COUNT(*) FROM semantic_columns sc WHERE sc.semantic_table_id = st.id AND sc.is_enabled = true) AS enabled_columns,
            (SELECT COUNT(*) FROM semantic_columns sc WHERE sc.semantic_table_id = st.id AND sc.enum_values IS NOT NULL AND jsonb_typeof(sc.enum_values) = 'array' AND jsonb_array_length(sc.enum_values) > 0) AS enum_column_count,
            (SELECT COUNT(*) FROM semantic_relationships sr WHERE sr.file_source_id = st.file_source_id AND sr.source_table = st.table_name) AS relationship_count
        FROM semantic_tables st
        JOIN file_sources fs ON st.file_source_id = fs.id
        WHERE fs.organization_id = $1 AND fs.status = 'active' AND st.is_enabled = true
        ORDER BY fs.filename, st.table_name`;
      queryParams = [organizationId];
    } else {
      tablesQuery = `
        SELECT
            st.*,
            (SELECT COUNT(*) FROM semantic_columns sc WHERE sc.semantic_table_id = st.id) AS column_count,
            (SELECT COUNT(*) FROM semantic_columns sc WHERE sc.semantic_table_id = st.id AND sc.is_enabled = true) AS enabled_columns,
            (SELECT COUNT(*) FROM semantic_columns sc WHERE sc.semantic_table_id = st.id AND sc.enum_values IS NOT NULL AND jsonb_typeof(sc.enum_values) = 'array' AND jsonb_array_length(sc.enum_values) > 0) AS enum_column_count,
            (SELECT COUNT(*) FROM semantic_relationships sr WHERE (sr.connection_id = st.connection_id OR sr.file_source_id = st.file_source_id) AND sr.source_table = st.table_name) AS relationship_count
        FROM semantic_tables st
        WHERE (st.connection_id = $1 OR st.file_source_id = $1) AND st.is_enabled = true
        ORDER BY st.table_name`;
      queryParams = [connectionId];
      
      const sourceCheck = await db.query(
        `SELECT id FROM database_connections WHERE id = $1 AND organization_id = $2
         UNION ALL
         SELECT id FROM file_sources WHERE id = $1 AND organization_id = $2`,
        [connectionId, organizationId]
      );
      if (sourceCheck.rows.length === 0) return res.status(404).json({ error: 'Data source not found' });
    }

    const result = await db.query(tablesQuery, queryParams);

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

    await ensureSchemaMetadataStorage(db);

    const isMultiFile = connectionId === 'multi-file-source';

    let tableQuery;
    let queryParams;

    if (isMultiFile) {
      tableQuery = `
        SELECT st.id FROM semantic_tables st
        JOIN file_sources fs ON st.file_source_id = fs.id
        WHERE fs.organization_id = $1 AND fs.status = 'active' AND TRIM(st.table_name) = TRIM($2)
        LIMIT 1`;
      queryParams = [organizationId, tableName];
    } else {
      tableQuery = `
        SELECT id FROM semantic_tables 
        WHERE (connection_id = $1 OR file_source_id = $1) AND TRIM(table_name) = TRIM($2)`;
      queryParams = [connectionId, tableName];

      const sourceCheck = await db.query(
        `SELECT id FROM database_connections WHERE id = $1 AND organization_id = $2
         UNION ALL
         SELECT id FROM file_sources WHERE id = $1 AND organization_id = $2`,
        [connectionId, organizationId]
      );
      if (sourceCheck.rows.length === 0) return res.status(404).json({ error: 'Data source not found' });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableName);
    let tableResult;

    if (isUuid) {
      tableResult = await db.query(
        'SELECT id FROM semantic_tables WHERE id = $1',
        [tableName]
      );
    } else {
      tableResult = await db.query(tableQuery, queryParams);
    }

    if (tableResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Table not found',
        details: { connectionId, tableName }
      });
    }

    const semanticTableId = tableResult.rows[0].id;

    const result = await db.query(
      `SELECT 
        sc.*, 
        st.table_name,
        sr.target_table as foreign_table,
        sr.target_column as foreign_column
       FROM semantic_columns sc
       JOIN semantic_tables st ON sc.semantic_table_id = st.id
       LEFT JOIN semantic_relationships sr ON 
         sr.source_table = st.table_name AND 
         sr.source_column = sc.column_name AND
         sr.connection_id IS NOT DISTINCT FROM st.connection_id AND 
         sr.file_source_id IS NOT DISTINCT FROM st.file_source_id
       WHERE sc.semantic_table_id = $1
       ORDER BY sc.column_name`,
      [semanticTableId]
    );

    // For database connections, fetch config for live enum discovery
    let dbConfig = null;
    if (!isMultiFile) {
        const dbRes = await db.query('SELECT * FROM database_connections WHERE id = $1 AND organization_id = $2', [connectionId, organizationId]);
        if (dbRes.rows.length > 0) {
            dbConfig = dbRes.rows[0];
        }
    }

    let liveEnumValueMap = new Map();
    if (dbConfig && result.rows.some((col) => !Array.isArray(col.enum_values) || col.enum_values.length === 0)) {
      try {
        const pool = await dbDiscoverer.getConnectionPool(dbConfig);
        try {
          const columnMetadata = await dbDiscoverer.discoverColumnMetadata(
            pool,
            dbConfig.db_type,
            tableName
          );
          liveEnumValueMap = new Map(
            columnMetadata.map((column) => [
              String(column.column_name),
              Array.isArray(column.enum_values) ? column.enum_values : []
            ])
          );
        } finally {
          await pool.end();
        }
      } catch (enumError) {
        console.warn('Live enum metadata discovery failed:', enumError.message);
      }
    }


    return res.json({ 
      success: true,
      columns: result.rows,
      liveEnumValues: liveEnumValueMap.size > 0 ? Object.fromEntries(liveEnumValueMap) : null
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
      await ensureSchemaMetadataStorage(db);

      const {
        semantic_table_id,
        column_name,
        business_name,
        data_type,
        is_nullable,
        default_value,
        enum_values = [],
        department_access = 'all',
        is_enabled = true
      } = req.body;

      const organizationId = req.user.organization_id;

      const tableCheck = await db.query(
        `SELECT st.id 
         FROM semantic_tables st
         LEFT JOIN database_connections dc ON st.connection_id = dc.id
         LEFT JOIN file_sources fs ON st.file_source_id = fs.id
         WHERE st.id = $1 AND (dc.organization_id = $2 OR fs.organization_id = $2)`,
        [semantic_table_id, organizationId]
      );

      if (!tableCheck.rows[0]) {
        return res.status(404).json({ error: 'Table not found' });
      }

      const result = await db.query(
        `INSERT INTO semantic_columns (
          semantic_table_id, column_name, business_name, data_type,
          is_nullable, default_value, enum_values, department_access, is_enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
        ON CONFLICT (semantic_table_id, column_name) 
        DO UPDATE SET 
          business_name = EXCLUDED.business_name,
          data_type = COALESCE(EXCLUDED.data_type, semantic_columns.data_type),
          is_nullable = COALESCE(EXCLUDED.is_nullable, semantic_columns.is_nullable),
          default_value = COALESCE(EXCLUDED.default_value, semantic_columns.default_value),
          enum_values = COALESCE(EXCLUDED.enum_values, semantic_columns.enum_values),
          department_access = EXCLUDED.department_access,
          is_enabled = EXCLUDED.is_enabled,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [
          semantic_table_id, column_name, business_name, data_type,
          is_nullable, default_value, JSON.stringify(enum_values), department_access, is_enabled
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

  async deleteConnection(req, res) {
  try {
    const { connectionId } = req.params;
    const organizationId = req.user.organization_id;

    // Delete connection (will cascade to semantic_tables and semantic_columns)
    const result = await db.query(
      `DELETE FROM database_connections 
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [connectionId, organizationId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Connection deleted successfully'
    });

  } catch (error) {
    console.error('Delete connection error:', error);
    res.status(500).json({ 
      error: 'Failed to delete connection',
      details: error.message
    });
  }
},


async discoverAndSeedSchema(req, res) {
  try {
    const { connectionId } = req.params;
    const organizationId = req.user.organization_id;

    // 1. Check if this is actually a file source
    const fileSourceCheck = await db.query(
      'SELECT id FROM file_sources WHERE id = $1 AND organization_id = $2',
      [connectionId, organizationId]
    );

    if (fileSourceCheck.rows.length > 0) {
      console.log('🔄 Redirecting to file discovery for:', connectionId);
      return this.discoverFileSchema(req, res);
    }

    const { 
      seed_tables = true, 
      seed_columns = true,
      override_existing = true 
    } = req.body;

    console.log(`Starting schema discovery for connection: ${connectionId}`);
    await ensureSchemaMetadataStorage(db);

    // 2. Standard SQL Discovery
    const connectionResult = await db.query(
      `SELECT * FROM database_connections 
       WHERE id = $1 AND organization_id = $2`,
      [connectionId, organizationId]
    );

    if (!connectionResult.rows[0]) {
      return res.status(404).json({ error: 'Database connection not found' });
    }

    const dbConfig = connectionResult.rows[0];

    // Connect to the external database (RDS)
    const pool = await dbDiscoverer.getConnectionPool(dbConfig);

    try {
      // Discover all tables from external database
      const tables = await dbDiscoverer.discoverTables(pool, dbConfig.db_type);
      console.log(`Discovered ${tables.length} tables`);

      let seededTables = [];
      let seededColumns = [];
      let errors = [];

      // ✅ First, delete ALL existing schema data for this connection
      if (override_existing) {
        console.log(`Clearing existing schema data for connection: ${connectionId}`);
        try {
          // Delete relationships
          await db.query(
            `DELETE FROM semantic_relationships WHERE connection_id = $1`,
            [connectionId]
          );

          // Delete columns (will cascade if you have foreign keys, but explicit is safer)
          await db.query(
            `DELETE FROM semantic_columns WHERE semantic_table_id IN (
              SELECT id FROM semantic_tables WHERE connection_id = $1
            )`,
            [connectionId]
          );

          // Delete tables
          await db.query(
            `DELETE FROM semantic_tables WHERE connection_id = $1`,
            [connectionId]
          );

          console.log(`Successfully cleared existing data for connection: ${connectionId}`);
        } catch (clearError) {
          console.error('Error clearing existing data:', clearError.message);
          // Continue anyway - we'll try to insert new data
        }
      }

      // Seed tables into YOUR semantic_tables table
      if (seed_tables) {
        for (const table of tables) {
          try {
            const tableName = String(table.table_name || '').trim();
            console.log(`Processing table: "${tableName}"`);

            const result = await db.query(
              `INSERT INTO semantic_tables (
                connection_id, table_name, business_name, is_enabled
              )
              VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), true)
              ON CONFLICT (connection_id, table_name) 
              DO UPDATE SET 
                business_name = EXCLUDED.business_name,
                updated_at = CURRENT_TIMESTAMP
              RETURNING *`,
              [
                connectionId,
                tableName,
                tableName // business_name same as table_name initially
              ]
            );

            if (result.rows[0]) {
              seededTables.push(result.rows[0]);
              const tableRecord = result.rows[0];

              if (seed_columns) {
                // Get columns and their metadata
                const columns = await dbDiscoverer.discoverColumns(
                  pool,
                  dbConfig.db_type,
                  tableName
                );
                
                const columnMetadata = await dbDiscoverer.discoverColumnMetadata(
                  pool,
                  dbConfig.db_type,
                  tableName
                );
                
                const columnMetadataMap = new Map(
                  columnMetadata.map((column) => [String(column.column_name), column])
                );

                console.log(`Discovered ${columns.length} columns for table: ${tableName}`);

                for (const column of columns) {
                  try {
                    const columnName = String(column.column_name || '').trim();
                    const metadata = columnMetadataMap.get(columnName);
                    const dataType = String(metadata?.data_type || column.data_type || '').trim();
                    const isNullable = column.is_nullable === 'YES';
                    const defaultValue =
                      column.default_value !== null && column.default_value !== undefined
                        ? String(column.default_value)
                        : null;
                    const enumValues = Array.isArray(metadata?.enum_values)
                      ? metadata.enum_values.filter((value) => value != null)
                      : [];

                    const columnResult = await db.query(
                      `INSERT INTO semantic_columns (
                        semantic_table_id, column_name, business_name,
                        data_type, is_nullable, default_value, enum_values, is_enabled
                      )
                      VALUES (
                        $1::uuid, $2::varchar(255), $3::varchar(255),
                        $4::varchar(100), $5::boolean, $6::text, $7::jsonb, true
                      )
                      ON CONFLICT (semantic_table_id, column_name)
                      DO UPDATE SET
                        data_type = EXCLUDED.data_type,
                        is_nullable = EXCLUDED.is_nullable,
                        default_value = EXCLUDED.default_value,
                        enum_values = EXCLUDED.enum_values,
                        updated_at = CURRENT_TIMESTAMP
                      RETURNING *`,
                      [
                        tableRecord.id,
                        columnName,
                        columnName,
                        dataType,
                        isNullable,
                        defaultValue,
                        JSON.stringify(enumValues)
                      ]
                    );

                    if (columnResult.rows[0]) {
                      seededColumns.push(columnResult.rows[0]);
                    }
                  } catch (columnError) {
                    const errorMsg = `Error seeding column ${column.column_name}: ${columnError.message}`;
                    console.error(errorMsg);
                    errors.push(errorMsg);
                  }
                }

                // Discover and seed relationships (foreign keys)
                try {
                  const foreignKeys = await dbDiscoverer.discoverForeignKeys(
                    pool,
                    dbConfig.db_type,
                    tableName
                  );

                  for (const foreignKey of foreignKeys) {
                    await db.query(
                      `INSERT INTO semantic_relationships (
                        connection_id, source_table, source_column, target_table, target_column, relation_type
                      )
                      VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), $4::varchar(255), $5::varchar(255), $6::varchar(50))
                      ON CONFLICT (connection_id, source_table, source_column, target_table, target_column, relation_type)
                      DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
                      [
                        connectionId,
                        tableName,
                        String(foreignKey.column_name || '').trim(),
                        String(foreignKey.foreign_table || '').trim(),
                        String(foreignKey.foreign_column || '').trim(),
                        'foreign_key'
                      ]
                    );
                  }
                } catch (relationshipError) {
                  const errorMsg = `Error seeding relationships for ${tableName}: ${relationshipError.message}`;
                  console.error(errorMsg);
                  errors.push(errorMsg);
                }
              }
            }
          } catch (tableError) {
            const errorMsg = `Error seeding table ${table.table_name}: ${tableError.message}`;
            console.error(errorMsg);
            errors.push(errorMsg);
            // Continue with other tables
          }
        }
      }

      await db.query(
        `UPDATE database_connections
         SET last_synced_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [connectionId]
      );

      const relationshipCountResult = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM semantic_relationships
         WHERE connection_id = $1`,
        [connectionId]
      );

      // Send response
      if (res && res.json) {
        res.status(200).json({
          success: true,
          message: 'Schema discovery and seeding completed',
          summary: {
            total_tables_discovered: tables.length,
            tables_seeded: seededTables.length,
            columns_seeded: seededColumns.length,
            relationships_seeded: relationshipCountResult.rows[0]?.count || 0,
            connection: {
              id: dbConfig.id,
              database_name: dbConfig.database_name,
              db_type: dbConfig.db_type,
              host: dbConfig.host
            }
          },
          errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
          tables: seededTables,
          columns: seededColumns
        });
      } else {
        // Called from updateConnection (no res object)
        console.log('Schema discovery completed (internal call)');
        return {
          success: true,
          summary: {
            tables_seeded: seededTables.length,
            columns_seeded: seededColumns.length
          }
        };
      }

    } finally {
      // Release the connection pool to external database
      await pool.end();
    }

  } catch (error) {
    console.error('Discover and seed schema error:', error);
    if (res && res.json) {
      res.status(500).json({ 
        error: 'Failed to discover and seed schema',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    } else {
      throw error;
    }
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

async bulkUpdateColumnMappings(req, res) {
  try {
    await ensureSchemaMetadataStorage(db);

    const { semantic_table_id, columns } = req.body;
    const organizationId = req.user.organization_id;

    // Validate request body
    if (!semantic_table_id || !Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ 
        error: 'semantic_table_id and columns array are required' 
      });
    }

    // Verify table belongs to organization
    const tableCheck = await db.query(
      `SELECT st.id 
       FROM semantic_tables st
       LEFT JOIN database_connections dc ON st.connection_id = dc.id
       LEFT JOIN file_sources fs ON st.file_source_id = fs.id
       WHERE st.id = $1 AND (dc.organization_id = $2 OR fs.organization_id = $2)`,
      [semantic_table_id, organizationId]
    );

    if (!tableCheck.rows[0]) {
      return res.status(404).json({ error: 'Table not found or unauthorized' });
    }

    const results = [];
    const errors = [];

    // Process each column update
    for (const column of columns) {
      try {
        const {
          column_name,
          business_name,
          data_type,
          is_nullable,
          default_value,
          enum_values = [],
          department_access = 'all',
          is_enabled = true
        } = column;

        // Validate required fields
        if (!column_name) {
          errors.push({ 
            column: column, 
            error: 'column_name is required' 
          });
          continue;
        }

        const normalizedDepartmentAccess = normalizeDepartmentAccessValue(department_access);

        const result = await db.query(
          `INSERT INTO semantic_columns (
            semantic_table_id, column_name, business_name, data_type,
            is_nullable, default_value, enum_values, department_access, is_enabled
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
          ON CONFLICT (semantic_table_id, column_name) 
          DO UPDATE SET 
            business_name = COALESCE(EXCLUDED.business_name, semantic_columns.business_name),
            data_type = COALESCE(EXCLUDED.data_type, semantic_columns.data_type),
            is_nullable = COALESCE(EXCLUDED.is_nullable, semantic_columns.is_nullable),
            default_value = COALESCE(EXCLUDED.default_value, semantic_columns.default_value),
            enum_values = COALESCE(EXCLUDED.enum_values, semantic_columns.enum_values),
            department_access = COALESCE(EXCLUDED.department_access, semantic_columns.department_access),
            is_enabled = COALESCE(EXCLUDED.is_enabled, semantic_columns.is_enabled),
            updated_at = CURRENT_TIMESTAMP
          RETURNING *`,
          [
            semantic_table_id, 
            column_name, 
            business_name || column_name,
            data_type || 'varchar',
            is_nullable !== undefined ? is_nullable : true,
            default_value,
            JSON.stringify(Array.isArray(enum_values) ? enum_values : []),
            normalizedDepartmentAccess,
            is_enabled
          ]
        );

        results.push(result.rows[0]);
      } catch (columnError) {
        errors.push({ 
          column: column, 
          error: columnError.message 
        });
        console.error(`Error updating column ${column.column_name}:`, columnError);
      }
    }

    res.status(200).json({
      success: true,
      message: `Updated ${results.length} columns successfully`,
      updated: results.length,
      failed: errors.length,
      columns: results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Bulk update column mappings error:', error);
    res.status(500).json({ 
      error: 'Failed to bulk update column mappings',
      details: error.message 
    });
  }
},
  async getMappedColumns(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const { table_id } = req.query;

      let query = `
        SELECT sc.*, st.table_name, st.business_name as table_business_name,
               dc.database_name, dc.db_type, fs.filename as file_source_name
        FROM semantic_columns sc
        JOIN semantic_tables st ON sc.semantic_table_id = st.id
        LEFT JOIN database_connections dc ON st.connection_id = dc.id
        LEFT JOIN file_sources fs ON st.file_source_id = fs.id
        WHERE (dc.organization_id = $1 OR fs.organization_id = $1)
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
  },

  async discoverFileSchema(req, res) {
    const isInternal = !res || typeof res.json !== 'function';
    try {
      const fileSourceId = req.params?.fileSourceId || req.fileSourceId;
      const organizationId = req.user?.organization_id || req.organizationId;
      
      if (!fileSourceId || !organizationId) {
        if (isInternal) throw new Error('Missing fileSourceId or organizationId');
        return res.status(400).json({ error: 'Missing required IDs' });
      }

      const sourceResult = await db.query('SELECT * FROM file_sources WHERE id = $1 AND organization_id = $2', [fileSourceId, organizationId]);
      if (sourceResult.rows.length === 0) {
        if (isInternal) throw new Error('File source not found');
        return res.status(404).json({ error: 'File source not found' });
      }

      const source = sourceResult.rows[0];
      if (!source.s3_key) {
        if (isInternal) throw new Error('Source has no file associated');
        return res.status(400).json({ error: 'Source has no file associated' });
      }

      const schema = await fileDiscoverer.discoverSchema(source.s3_key);
      
      // Clean wipe: Delete existing schema metadata for this file source
      await db.query('DELETE FROM semantic_relationships WHERE file_source_id = $1', [fileSourceId]);
      await db.query('DELETE FROM semantic_columns WHERE semantic_table_id IN (SELECT id FROM semantic_tables WHERE file_source_id = $1)', [fileSourceId]);
      await db.query('DELETE FROM semantic_tables WHERE file_source_id = $1', [fileSourceId]);

      const seededTables = [];
      let totalColumns = 0;
      
      const filenameBase = source.filename
        ? source.filename.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()
        : "file_data";

      const sheetEntries = Object.entries(schema);
      
      for (const [sheetName, columns] of sheetEntries) {
        totalColumns += columns.length;
        
        // Always use filename as base for better uniqueness across the organization
        const isGenericSheet = ["Sheet1", "CSV", "Worksheet", "Sheet 1", "Sheet"].includes(sheetName);
        
        let tableName = filenameBase;
        
        // If there are multiple sheets, always include the sheet name to avoid collisions
        // If there's only one sheet but it has a meaningful name (not "Sheet1"), also include it
        if (sheetEntries.length > 1 || !isGenericSheet) {
          const sanitizedSheetName = sheetName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
          
          // If it's a generic name and we have other sheets, still append it to be explicit
          tableName = `${filenameBase}_${sanitizedSheetName}`;
        }

        const businessName = sheetEntries.length > 1 || !isGenericSheet
          ? `${source.filename.replace(/\.[^/.]+$/, "")} (${sheetName})`
          : source.filename.replace(/\.[^/.]+$/, "");

        const tableResult = await db.query(
          `INSERT INTO semantic_tables (file_source_id, table_name, business_name, is_enabled) 
           VALUES ($1, $2, $3, true) RETURNING *`, 
          [fileSourceId, tableName, businessName]
        );
        const table = tableResult.rows[0];
        seededTables.push(table);
        for (const colName of columns) {
          await db.query(
            `INSERT INTO semantic_columns (semantic_table_id, column_name, business_name, data_type, is_enabled) 
             VALUES ($1, $2, $3, 'text', true)`, 
            [table.id, colName, colName]
          );
        }
      }

      const resultData = { 
        success: true, 
        message: 'File schema discovered successfully', 
        summary: {
          tables_discovered: seededTables.length,
          columns_discovered: totalColumns
        },
        tables: seededTables 
      };

      if (isInternal) return resultData;
      res.json(resultData);
    } catch (error) {
      console.error('[SCHEMA] File discovery error:', error);
      if (isInternal) throw error;
      res.status(500).json({ error: 'Failed to discover file schema', details: error.message });
    }
  }
};
module.exports = schemaController;
