const db = require('../config/database');
const dbDiscoverer = require('../helpers/dbDiscoverer');
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

    // Validate connectionId is a valid UUID format
    if (!connectionId || typeof connectionId !== 'string' || connectionId === 'null') {
      return res.status(400).json({ error: 'Invalid connection ID' });
    }

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
      `SELECT
          st.*,
          (
            SELECT COUNT(*)
            FROM semantic_columns sc
            WHERE sc.semantic_table_id = st.id
          ) AS column_count,
          (
            SELECT COUNT(*)
            FROM semantic_columns sc
            WHERE sc.semantic_table_id = st.id
              AND sc.is_enabled = true
          ) AS enabled_columns,
          (
            SELECT COUNT(*)
            FROM semantic_columns sc
            WHERE sc.semantic_table_id = st.id
              AND sc.enum_values IS NOT NULL
              AND jsonb_typeof(sc.enum_values) = 'array'
              AND jsonb_array_length(sc.enum_values) > 0
          ) AS enum_column_count,
          (
            SELECT COUNT(*)
            FROM semantic_relationships sr
            WHERE sr.connection_id = st.connection_id
              AND sr.source_table = st.table_name
          ) AS relationship_count
       FROM semantic_tables st
       WHERE st.connection_id = $1 AND st.is_enabled = true
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

    await ensureSchemaMetadataStorage(db);

    // Verify connection and fetch config
    const connectionResult = await db.query(
      'SELECT * FROM database_connections WHERE id = $1 AND organization_id = $2',
      [connectionId, organizationId]
    );

    if (!connectionResult.rows[0]) {
      return res.status(404).json({ error: 'Database connection not found' });
    }
    const dbConfig = connectionResult.rows[0];

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

    let liveEnumValueMap = new Map();
    if (result.rows.some((col) => !Array.isArray(col.enum_values) || col.enum_values.length === 0)) {
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

    let relationships = [];
    try {
      const relationshipResult = await db.query(
        `SELECT
            source_table,
            source_column,
            target_table,
            target_column,
            relation_type
         FROM semantic_relationships
         WHERE connection_id = $1
           AND (source_table = $2 OR target_table = $2)
         ORDER BY source_table, source_column, target_table, target_column`,
        [connectionId, tableName]
      );
      relationships = relationshipResult.rows;
    } catch (fkError) {
      console.warn('Stored relationship lookup failed:', fkError.message);
    }

    if (relationships.length === 0) {
      try {
        const pool = await dbDiscoverer.getConnectionPool(dbConfig);
        try {
          const foreignKeys = await dbDiscoverer.discoverForeignKeys(
            pool,
            dbConfig.db_type,
            tableName
          );
          relationships = foreignKeys.map((fk) => ({
            source_table: tableName,
            source_column: String(fk.column_name),
            target_table: fk.foreign_table,
            target_column: fk.foreign_column,
            relation_type: 'foreign_key'
          }));
        } finally {
          await pool.end();
        }
      } catch (fkError) {
        console.warn('Foreign key discovery failed:', fkError.message);
      }
    }

    const foreignKeyMap = new Map(
      relationships
        .filter((relationship) => relationship.source_table === tableName)
        .map((relationship) => [String(relationship.source_column), relationship])
    );

    const columns = result.rows.map((col) => {
      const fk = foreignKeyMap.get(col.column_name);
      const enumValues =
        Array.isArray(col.enum_values) && col.enum_values.length > 0
          ? col.enum_values
          : (liveEnumValueMap.get(String(col.column_name)) || []);
      return {
        ...col,
        enum_values: enumValues,
        foreign_table: fk ? fk.target_table : null,
        foreign_column: fk ? fk.target_column : null,
        relation_type: fk ? fk.relation_type : null
      };
    });

    res.json({
      success: true,
      columns,
      relationships
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

// async discoverAndSeedSchema(req, res) {
//   try {
//     const { connectionId } = req.params;
//     const organizationId = req.user.organization_id;
//     const { 
//       seed_tables = true, 
//       seed_columns = true,
//       override_existing = false 
//     } = req.body;

//     console.log(`Starting schema discovery for connection: ${connectionId}`);
//     await ensureSchemaMetadataStorage(db);

//     // Get database connection details
//     const connectionResult = await db.query(
//       `SELECT * FROM database_connections 
//        WHERE id = $1 AND organization_id = $2`,
//       [connectionId, organizationId]
//     );

//     if (!connectionResult.rows[0]) {
//       return res.status(404).json({ error: 'Database connection not found' });
//     }

//     const dbConfig = connectionResult.rows[0];

//     // Connect to the external database (RDS)
//     const pool = await dbDiscoverer.getConnectionPool(dbConfig);

//     // Discover all tables from external database
//     const tables = await dbDiscoverer.discoverTables(pool, dbConfig.db_type);

//     console.log(`Discovered ${tables.length} tables`);

//     let seededTables = [];
//     let seededColumns = [];
//     let errors = [];

//     // First, let's clear existing data if override is true
//     if (override_existing) {
//       try {
//         await db.query(
//           `DELETE FROM semantic_relationships WHERE connection_id = $1`,
//           [connectionId]
//         );

//         await db.query(
//           `DELETE FROM semantic_columns WHERE semantic_table_id IN (
//             SELECT id FROM semantic_tables WHERE connection_id = $1
//           )`,
//           [connectionId]
//         );

//         await db.query(
//           `DELETE FROM semantic_tables WHERE connection_id = $1`,
//           [connectionId]
//         );

//         console.log(`Cleared existing data for connection: ${connectionId}`);
//       } catch (clearError) {
//         console.error('Error clearing existing data:', clearError.message);
//       }
//     }

//     // Seed tables into YOUR semantic_tables table
//     if (seed_tables) {
//       for (const table of tables) {
//         try {
//           // Ensure table_name is a string
//           const tableName = String(table.table_name || '').trim();

//           console.log(`Processing table: "${tableName}"`);

//           let result;

//           // Use explicit type casting in the query
//           if (override_existing) {
//             // Use DO NOTHING on conflict since we already cleared data
//             result = await db.query(
//               `INSERT INTO semantic_tables (
//                 connection_id, table_name, business_name, is_enabled
//               )
//               VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), true)
//               ON CONFLICT (connection_id, table_name) 
//               DO NOTHING
//               RETURNING *`,
//               [
//                 connectionId,
//                 tableName,
//                 tableName // business_name same as table_name initially
//               ]
//             );
//           } else {
//             // Insert only if not exists
//             result = await db.query(
//               `INSERT INTO semantic_tables (
//                 connection_id, table_name, business_name, is_enabled
//               )
//               SELECT $1::uuid, $2::varchar(255), $3::varchar(255), true
//               WHERE NOT EXISTS (
//                 SELECT 1 FROM semantic_tables 
//                 WHERE connection_id = $1::uuid AND table_name = $2::varchar(255)
//               )
//               RETURNING *`,
//               [
//                 connectionId,
//                 tableName,
//                 tableName
//               ]
//             );
//           }

//           const tableRecord =
//             result.rows[0] ||
//             (
//               await db.query(
//                 `SELECT *
//                  FROM semantic_tables
//                  WHERE connection_id = $1::uuid AND table_name = $2::varchar(255)
//                  LIMIT 1`,
//                 [connectionId, tableName]
//               )
//             ).rows[0];

//           if (!tableRecord) {
//             console.log(`Table ${tableName} already exists or not inserted`);
//             continue;
//           }

//           if (result.rows[0]) {
//             seededTables.push(tableRecord);
//           }

//           if (seed_columns) {
//             const tableId = tableRecord.id;
//             const columns = await dbDiscoverer.discoverColumns(
//               pool,
//               dbConfig.db_type,
//               tableName
//             );
//             const columnMetadata = await dbDiscoverer.discoverColumnMetadata(
//               pool,
//               dbConfig.db_type,
//               tableName
//             );
//             const columnMetadataMap = new Map(
//               columnMetadata.map((column) => [String(column.column_name), column])
//             );

//             console.log(`Discovered ${columns.length} columns for table: ${tableName}`);

//             for (const column of columns) {
//               try {
//                 const columnName = String(column.column_name || '').trim();
//                 const metadata = columnMetadataMap.get(columnName);
//                 const dataType = String(metadata?.data_type || column.data_type || '').trim();
//                 const isNullable = column.is_nullable === 'YES';
//                 const defaultValue =
//                   column.default_value !== null && column.default_value !== undefined
//                     ? String(column.default_value)
//                     : null;
//                 const enumValues = Array.isArray(metadata?.enum_values)
//                   ? metadata.enum_values.filter((value) => value != null)
//                   : [];

//                 const columnResult = await db.query(
//                   `INSERT INTO semantic_columns (
//                     semantic_table_id, column_name, business_name,
//                     data_type, is_nullable, default_value, enum_values, is_enabled
//                   )
//                   VALUES (
//                     $1::uuid, $2::varchar(255), $3::varchar(255),
//                     $4::varchar(100), $5::boolean, $6::text, $7::jsonb, true
//                   )
//                   ON CONFLICT (semantic_table_id, column_name)
//                   DO UPDATE SET
//                     data_type = EXCLUDED.data_type,
//                     is_nullable = EXCLUDED.is_nullable,
//                     default_value = EXCLUDED.default_value,
//                     enum_values = EXCLUDED.enum_values,
//                     updated_at = CURRENT_TIMESTAMP
//                   RETURNING *`,
//                   [
//                     tableId,
//                     columnName,
//                     columnName,
//                     dataType,
//                     isNullable,
//                     defaultValue,
//                     JSON.stringify(enumValues)
//                   ]
//                 );

//                 if (columnResult.rows[0] && result.rows[0]) {
//                   seededColumns.push(columnResult.rows[0]);
//                 }
//               } catch (columnError) {
//                 const errorMsg = `Error seeding column ${column.column_name}: ${columnError.message}`;
//                 console.error(errorMsg);
//                 errors.push(errorMsg);
//               }
//             }

//             try {
//               const foreignKeys = await dbDiscoverer.discoverForeignKeys(
//                 pool,
//                 dbConfig.db_type,
//                 tableName
//               );

//               for (const foreignKey of foreignKeys) {
//                 await db.query(
//                   `INSERT INTO semantic_relationships (
//                     connection_id, source_table, source_column, target_table, target_column, relation_type
//                   )
//                   VALUES ($1::uuid, $2::varchar(255), $3::varchar(255), $4::varchar(255), $5::varchar(255), $6::varchar(50))
//                   ON CONFLICT (connection_id, source_table, source_column, target_table, target_column, relation_type)
//                   DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
//                   [
//                     connectionId,
//                     tableName,
//                     String(foreignKey.column_name || '').trim(),
//                     String(foreignKey.foreign_table || '').trim(),
//                     String(foreignKey.foreign_column || '').trim(),
//                     'foreign_key'
//                   ]
//                 );
//               }
//             } catch (relationshipError) {
//               const errorMsg = `Error seeding relationships for ${tableName}: ${relationshipError.message}`;
//               console.error(errorMsg);
//               errors.push(errorMsg);
//             }
//           }
//         } catch (tableError) {
//           const errorMsg = `Error seeding table ${table.table_name}: ${tableError.message}`;
//           console.error(errorMsg);
//           errors.push(errorMsg);
//           // Continue with other tables
//         }
//       }
//     }

//     // Release the connection pool to external database
//     await pool.end();

//     const relationshipCountResult = await db.query(
//       `SELECT COUNT(*)::int AS count
//        FROM semantic_relationships
//        WHERE connection_id = $1`,
//       [connectionId]
//     );

//     res.status(200).json({
//       success: true,
//       message: 'Schema discovery and seeding completed',
//       summary: {
//         total_tables_discovered: tables.length,
//         tables_seeded: seededTables.length,
//         columns_seeded: seededColumns.length,
//         relationships_seeded: relationshipCountResult.rows[0]?.count || 0,
//         connection: {
//           id: dbConfig.id,
//           database_name: dbConfig.database_name,
//           db_type: dbConfig.db_type,
//           host: dbConfig.host
//         }
//       },
//       errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // Show only first 10 errors
//       tables: seededTables,
//       columns: seededColumns
//     });

//   } catch (error) {
//     console.error('Discover and seed schema error:', error);
//     res.status(500).json({ 
//       error: 'Failed to discover and seed schema',
//       details: error.message,
//       stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
//     });
//   }
// },


// In schemaController.js - discoverAndSeedSchema method

async discoverAndSeedSchema(req, res) {
  try {
    const { connectionId } = req.params;
    const organizationId = req.user.organization_id;
    const { 
      seed_tables = true, 
      seed_columns = true,
      override_existing = true  // Change default to true
    } = req.body;

    console.log(`Starting schema discovery for connection: ${connectionId}`);
    await ensureSchemaMetadataStorage(db);

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
       JOIN database_connections dc ON st.connection_id = dc.id
       WHERE st.id = $1 AND dc.organization_id = $2`,
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
