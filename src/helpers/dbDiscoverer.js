const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const normalizeEnumValues = (values) => {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalizedValues = [];
  const seen = new Set();

  for (const rawValue of values) {
    if (rawValue == null) {
      continue;
    }

    let value = String(rawValue).trim();

    if (!value) {
      continue;
    }

    value = value
      .replace(/::[\w\s.\[\]\"]+$/g, '')
      .replace(/^'+|'+$/g, '')
      .trim();

    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalizedValues.push(value);
  }

  return normalizedValues;
};

const dbDiscoverer = {
  async getConnectionPool(connectionConfig) {
  const {
    db_type,
    host,
    port,
    database_name,
    username,
    password,
    ssl,
    ssl_enabled
  } = connectionConfig;
  const useSsl = ssl_enabled ?? ssl ?? true;
  
  switch (db_type.toLowerCase()) {
    case 'postgresql':
    case 'postgres':
      return new Pool({
        host,
        port: parseInt(port),
        database: database_name,
        user: username,
        password,
        ssl: useSsl ? {
          rejectUnauthorized: false // For self-signed certificates
        } : false,
        max: 5,
        idleTimeoutMillis: 30000
      });
        
      case 'mysql':
        return mysql.createPool({
          host,
          port: parseInt(port),
          database: database_name,
          user: username,
          password,
          connectionLimit: 5
        });
        
      default:
        throw new Error(`Unsupported database type: ${db_type}`);
    }
  },

  // In dbDiscoverer.js, update discoverTables method:
async discoverTables(pool, dbType) {
  try {
    if (dbType.toLowerCase() === 'postgresql') {
      const result = await pool.query(`
        SELECT 
          table_name::text,
          table_schema::text as schema_name,
          table_type::text
        FROM information_schema.tables 
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
      `);
      
      // Debug: Check what we're getting
      if (result.rows.length > 0) {
        console.log('Sample table data:', JSON.stringify(result.rows[0]));
        console.log('Table name type:', typeof result.rows[0].table_name);
      }
      
      return result.rows;
    } else if (dbType.toLowerCase() === 'mysql') {
      const [rows] = await pool.query(`
        SELECT 
          TABLE_NAME as table_name,
          TABLE_SCHEMA as schema_name,
          TABLE_TYPE as table_type
        FROM information_schema.tables 
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY table_name
      `);
      
      if (rows.length > 0) {
        console.log('Sample table data:', JSON.stringify(rows[0]));
      }
      
      return rows;
    }
  } catch (error) {
    throw new Error(`Failed to discover tables: ${error.message}`);
  }
},

  async discoverColumns(pool, dbType, tableName) {
    try {
      if (dbType.toLowerCase() === 'postgresql') {
        const result = await pool.query(`
          SELECT 
            column_name,
            data_type,
            is_nullable,
            column_default as default_value,
            ordinal_position
          FROM information_schema.columns 
          WHERE table_name = $1
          ORDER BY ordinal_position
        `, [tableName]);
        return result.rows;
      } else if (dbType.toLowerCase() === 'mysql') {
        const [rows] = await pool.query(`
          SELECT 
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            IS_NULLABLE as is_nullable,
            COLUMN_DEFAULT as default_value,
            ORDINAL_POSITION as ordinal_position
          FROM information_schema.columns 
          WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()
          ORDER BY ordinal_position
        `, [tableName]);
        return rows;
      }
    } catch (error) {
      throw new Error(`Failed to discover columns for table ${tableName}: ${error.message}`);
    }
  },

  async discoverColumnMetadata(pool, dbType, tableName) {
    try {
      if (dbType.toLowerCase() === 'postgresql' || dbType.toLowerCase() === 'postgres') {
        const result = await pool.query(`
          WITH column_base AS (
            SELECT
              c.table_schema,
              c.table_name,
              c.column_name,
              c.data_type,
              c.udt_schema,
              c.udt_name,
              c.ordinal_position,
              attr.attnum
            FROM information_schema.columns c
            JOIN pg_namespace table_ns
              ON table_ns.nspname = c.table_schema
            JOIN pg_class cls
              ON cls.relname = c.table_name
             AND cls.relnamespace = table_ns.oid
            JOIN pg_attribute attr
              ON attr.attrelid = cls.oid
             AND attr.attname = c.column_name
             AND attr.attnum > 0
             AND NOT attr.attisdropped
            WHERE c.table_name = $1
              AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
          )
          SELECT
            cb.column_name,
            cb.data_type,
            cb.udt_name,
            CASE
              WHEN COALESCE(array_length(enum_values.values, 1), 0) > 0
                OR COALESCE(array_length(check_values.values, 1), 0) > 0
              THEN COALESCE(enum_values.values, ARRAY[]::text[]) || COALESCE(check_values.values, ARRAY[]::text[])
              ELSE ARRAY[]::text[]
            END AS enum_values
          FROM column_base cb
          LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(e.enumlabel ORDER BY e.enumsortorder) AS values
            FROM pg_namespace type_ns
            JOIN pg_type t
              ON t.typnamespace = type_ns.oid
            JOIN pg_enum e
              ON e.enumtypid = t.oid
            WHERE type_ns.nspname = cb.udt_schema
              AND t.typname = cb.udt_name
              AND t.typtype = 'e'
          ) enum_values ON TRUE
          LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(extracted.cleaned_value ORDER BY extracted.ord) AS values
            FROM (
              SELECT
                ord,
                NULLIF(
                  BTRIM(
                    REGEXP_REPLACE(TRIM(val), '::[A-Za-z0-9_ ."\\[\\]]+$', ''),
                    '''" '
                  ),
                  ''
                ) AS cleaned_value
              FROM pg_constraint con
              CROSS JOIN LATERAL UNNEST(
                REGEXP_SPLIT_TO_ARRAY(
                  CASE
                    WHEN pg_get_constraintdef(con.oid) ~ 'ARRAY\\['
                      THEN REGEXP_REPLACE(pg_get_constraintdef(con.oid), '.*ARRAY\\[(.*)\\].*', '\\1')
                    WHEN pg_get_constraintdef(con.oid) ~ 'IN \\('
                      THEN REGEXP_REPLACE(pg_get_constraintdef(con.oid), '.*IN \\((.*)\\).*', '\\1')
                    ELSE ''
                  END,
                  ','
                )
              ) WITH ORDINALITY AS extracted_values(val, ord)
              WHERE con.conrelid = (
                SELECT cls.oid
                FROM pg_class cls
                JOIN pg_namespace ns
                  ON ns.oid = cls.relnamespace
                WHERE cls.relname = cb.table_name
                  AND ns.nspname = cb.table_schema
                LIMIT 1
              )
                AND con.contype = 'c'
                AND cb.attnum = ANY(con.conkey)
                AND (
                  pg_get_constraintdef(con.oid) LIKE '%ARRAY[%'
                  OR pg_get_constraintdef(con.oid) LIKE '%IN (%'
                )
            ) extracted
            WHERE extracted.cleaned_value IS NOT NULL
          ) check_values ON TRUE
          ORDER BY cb.ordinal_position
        `, [tableName]);

        return result.rows.map((row) => ({
          column_name: row.column_name,
          data_type: row.data_type,
          enum_values: normalizeEnumValues(row.enum_values)
        }));
      } else if (dbType.toLowerCase() === 'mysql') {
        const [rows] = await pool.query(`
          SELECT
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            COLUMN_TYPE as column_type
          FROM information_schema.columns
          WHERE TABLE_NAME = ?
            AND TABLE_SCHEMA = DATABASE()
          ORDER BY ORDINAL_POSITION
        `, [tableName]);

        return rows.map((row) => {
          const enumMatch = typeof row.column_type === 'string'
            ? row.column_type.match(/^enum\((.*)\)$/i)
            : null;

          let enumValues = [];
          if (enumMatch && enumMatch[1]) {
            enumValues = enumMatch[1]
              .split(/','/)
              .map((value) => value.replace(/^'/, '').replace(/'$/, ''))
              .filter(Boolean);
          }

          return {
            column_name: row.column_name,
            data_type: row.data_type,
            enum_values: normalizeEnumValues(enumValues)
          };
        });
      }

      return [];
    } catch (error) {
      throw new Error(`Failed to discover column metadata for table ${tableName}: ${error.message}`);
    }
  },

  async discoverForeignKeys(pool, dbType, tableName) {
    try {
      if (dbType.toLowerCase() === 'postgresql') {
        const result = await pool.query(`
          SELECT
            kcu.column_name,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
            AND tc.table_name = $1
        `, [tableName]);
        return result.rows;
      } else if (dbType.toLowerCase() === 'mysql') {
        const [rows] = await pool.query(`
          SELECT
            COLUMN_NAME as column_name,
            REFERENCED_TABLE_NAME as foreign_table,
            REFERENCED_COLUMN_NAME as foreign_column
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND REFERENCED_TABLE_NAME IS NOT NULL
        `, [tableName]);
        return rows;
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to discover foreign keys for table ${tableName}: ${error.message}`);
    }
  },

  async testConnection(connectionConfig) {
    try {
      const pool = await this.getConnectionPool(connectionConfig);
      
      if (connectionConfig.db_type.toLowerCase() === 'postgresql') {
        await pool.query('SELECT 1');
      } else {
        const [rows] = await pool.query('SELECT 1');
      }
      
      await pool.end();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};

module.exports = dbDiscoverer;
