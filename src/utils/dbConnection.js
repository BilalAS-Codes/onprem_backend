const { Client } = require('pg');
const mysql = require('mysql2/promise');
const oracledb = require('oracledb');
const db = require('../config/database');
const dbDiscoverer = require('../helpers/dbDiscoverer');
const { ensureSchemaMetadataStorage } = require('../helpers/semanticMetadata');

const testConnection = async (config) => {
  const startTime = Date.now();
  const shouldRetryWithSsl =
    config.db_type === 'postgresql' &&
    !config.ssl_enabled;

  try {
    if (config.db_type === 'postgresql') {
      const client = new Client({
        host: config.host,
        port: config.port,
        database: config.database_name,
        user: config.username,
        password: config.password,
        ssl: config.ssl_enabled ? { rejectUnauthorized: false } : false
      });

      await client.connect();
      await client.query('SELECT 1');
      await client.end();

      const latency_ms = Date.now() - startTime;
      return { success: true, latency_ms };
    } else if (config.db_type === 'mysql') {
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database_name,
        user: config.username,
        password: config.password,
        ssl: config.ssl_enabled ? { rejectUnauthorized: false } : undefined
      });

      await connection.query('SELECT 1');
      await connection.end();

      const latency_ms = Date.now() - startTime;
      return { success: true, latency_ms };
    } else if (config.db_type === 'oracle') {
      const connection = await oracledb.getConnection({
        user: config.username,
        password: config.password,
        connectString: `${config.host}:${config.port}/${config.database_name}`
      });

      await connection.execute('SELECT 1 FROM dual');
      await connection.close();

      const latency_ms = Date.now() - startTime;
      return { success: true, latency_ms };
    } else {
      throw new Error(`Unsupported database type: ${config.db_type}`);
    }
  } catch (error) {
    const latency_ms = Date.now() - startTime;

    const msg = error && error.message ? error.message : '';
    const requiresSsl =
      /no encryption/i.test(msg) ||
      /ssl\/tls required/i.test(msg) ||
      /ssl is required/i.test(msg) ||
      /must use ssl/i.test(msg) ||
      /pg_hba\.conf.*ssl/i.test(msg);

    // If postgres rejects plaintext connections, retry once with SSL enabled.
    if (shouldRetryWithSsl && requiresSsl) {
      try {
        const client = new Client({
          host: config.host,
          port: config.port,
          database: config.database_name,
          user: config.username,
          password: config.password,
          ssl: { rejectUnauthorized: false }
        });

        await client.connect();
        await client.query('SELECT 1');
        await client.end();

        const retryLatency = Date.now() - startTime;
        console.warn('Connection succeeded after retrying with SSL');
        return { success: true, latency_ms: retryLatency, used_ssl: true };
      } catch (retryErr) {
        const combined = `${msg} | retry with SSL failed: ${retryErr.message}`;
        return { success: false, error: combined, latency_ms };
      }
    }

    return {
      success: false,
      error: error.message,
      latency_ms
    };
  }
};

const getSchema = async (connectionId, config) => {
  let metadataPool = null;
  try {
    await ensureSchemaMetadataStorage(db);

    let tables = [];
    const columns = [];

    if (config.db_type === 'postgresql') {
      const client = new Client({
        host: config.host,
        port: config.port,
        database: config.database_name,
        user: config.username,
        password: config.password,
        ssl: config.ssl_enabled ? { rejectUnauthorized: false } : false
      });

      await client.connect();

      const tablesResult = await client.query(`
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      tables = tablesResult.rows;

      for (const table of tables) {
        const columnsResult = await client.query(`
          SELECT 
            column_name,
            data_type,
            is_nullable,
            column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [table.table_name]);

        columns.push({ table_name: table.table_name, columns: columnsResult.rows });
      }

      await client.end();
    } else if (config.db_type === 'mysql') {
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database_name,
        user: config.username,
        password: config.password,
        ssl: config.ssl_enabled ? { rejectUnauthorized: false } : undefined
      });

      const [tablesResult] = await connection.query(`
        SELECT TABLE_NAME as table_name, TABLE_TYPE as table_type
        FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY TABLE_NAME
      `, [config.database_name]);

      tables = tablesResult;

      for (const table of tables) {
        const [columnsResult] = await connection.query(`
          SELECT 
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            IS_NULLABLE as is_nullable,
            COLUMN_DEFAULT as column_default
          FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ?
          ORDER BY ORDINAL_POSITION
        `, [config.database_name, table.table_name]);

        columns.push({ table_name: table.table_name, columns: columnsResult });
      }

      await connection.end();
    } else if (config.db_type === 'oracle') {
      const connection = await oracledb.getConnection({
        user: config.username,
        password: config.password,
        connectString: `${config.host}:${config.port}/${config.database_name}`
      });

      const tablesResult = await connection.execute(`
        SELECT table_name AS "table_name", 'TABLE' AS "table_type"
        FROM all_tables
        WHERE owner = USER
        ORDER BY table_name
      `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      tables = tablesResult.rows;

      for (const table of tables) {
        const columnsResult = await connection.execute(`
          SELECT 
            column_name AS "column_name",
            data_type AS "data_type",
            CASE WHEN nullable = 'Y' THEN 'YES' ELSE 'NO' END AS "is_nullable",
            data_default AS "column_default"
          FROM all_tab_columns
          WHERE table_name = :tbl AND owner = USER
          ORDER BY column_id
        `, [table.table_name], { outFormat: oracledb.OUT_FORMAT_OBJECT });

        columns.push({ table_name: table.table_name, columns: columnsResult.rows });
      }

      await connection.close();
    }

    metadataPool = await dbDiscoverer.getConnectionPool(config);

    // Store schema in local database if semantic tables exist
    for (const table of tables) {
      try {
        const tableResult = await db.query(
          `INSERT INTO semantic_tables (connection_id, table_name, business_name, is_enabled)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (connection_id, table_name)
           DO UPDATE SET updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          [connectionId, table.table_name, table.table_name]
        );

        const tableId = tableResult.rows[0].id;

        const tableColumns = columns.find(c => c.table_name === table.table_name)?.columns || [];
        const columnMetadata = await dbDiscoverer.discoverColumnMetadata(
          metadataPool,
          config.db_type,
          table.table_name
        );
        const columnMetadataMap = new Map(
          columnMetadata.map((column) => [String(column.column_name), column])
        );

        for (const column of tableColumns) {
          await db.query(
            `INSERT INTO semantic_columns (
              semantic_table_id, column_name, business_name, data_type,
              is_nullable, default_value, enum_values, is_enabled
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true)
            ON CONFLICT (semantic_table_id, column_name)
            DO UPDATE SET
              data_type = $4,
              is_nullable = $5,
              default_value = $6,
              enum_values = $7::jsonb,
              updated_at = CURRENT_TIMESTAMP`,
            [
              tableId,
              column.column_name,
              column.column_name,
              column.data_type,
              column.is_nullable === 'YES',
              column.column_default,
              JSON.stringify(
                Array.isArray(columnMetadataMap.get(String(column.column_name))?.enum_values)
                  ? columnMetadataMap.get(String(column.column_name)).enum_values
                  : []
              )
            ]
          );
        }

        const foreignKeys = await dbDiscoverer.discoverForeignKeys(
          metadataPool,
          config.db_type,
          table.table_name
        );

        for (const foreignKey of foreignKeys) {
          await db.query(
            `INSERT INTO semantic_relationships (
              connection_id, source_table, source_column, target_table, target_column, relation_type
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (connection_id, source_table, source_column, target_table, target_column, relation_type)
            DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
            [
              connectionId,
              table.table_name,
              String(foreignKey.column_name || '').trim(),
              String(foreignKey.foreign_table || '').trim(),
              String(foreignKey.foreign_column || '').trim(),
              'foreign_key'
            ]
          );
        }
      } catch (innerErr) {
        // If semantic tables don't exist, skip storing but continue returning schema
        console.warn('Skipping storing schema for table', table.table_name, innerErr.message);
      }
    }
    try {
      await db.query('UPDATE database_connections SET last_synced_at = CURRENT_TIMESTAMP WHERE id = $1', [connectionId]);
    } catch (e) {
      // ignore if table doesn't exist
    }

    return { success: true, tables, columns };
  } catch (error) {
    console.error('Get schema error:', error);
    return { success: false, error: error.message };
  } finally {
    if (metadataPool) {
      await metadataPool.end().catch(() => {});
    }
  }
};

module.exports = { testConnection, getSchema };  
