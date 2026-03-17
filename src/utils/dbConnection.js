const { Client } = require('pg');
const mysql = require('mysql2/promise');
const db = require('../config/database');

const testConnection = async (config) => {
  const startTime = Date.now();
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
    } else {
      throw new Error(`Unsupported database type: ${config.db_type}`);
    }
  } catch (error) {
    const latency_ms = Date.now() - startTime;

    // If postgres rejects plaintext connections (common on RDS: "no encryption"),
    // and caller didn't explicitly enable SSL, try once more with SSL enabled.
    const msg = error && error.message ? error.message : '';
    if (config.db_type === 'postgresql' && !config.ssl_enabled && /no encryption/i.test(msg)) {
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
  try {
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
    }

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

        for (const column of tableColumns) {
          await db.query(
            `INSERT INTO semantic_columns (
              semantic_table_id, column_name, business_name, data_type,
              is_nullable, default_value, is_enabled
            )
            VALUES ($1, $2, $3, $4, $5, $6, true)
            ON CONFLICT (semantic_table_id, column_name)
            DO UPDATE SET
              data_type = $4,
              is_nullable = $5,
              default_value = $6,
              updated_at = CURRENT_TIMESTAMP`,
            [
              tableId,
              column.column_name,
              column.column_name,
              column.data_type,
              column.is_nullable === 'YES',
              column.column_default
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
  }
};

module.exports = { testConnection, getSchema };  