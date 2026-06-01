const { Client } = require('pg');
const mysql = require('mysql2/promise');
const oracledb = require('oracledb');

async function connectToExternalDB(connection) {
  if (connection.db_type === 'postgresql') {
    const client = new Client({
      host: connection.host,
      port: connection.port,
      database: connection.database_name,
      user: connection.username,
      password: connection.password,
      ssl: {
        rejectUnauthorized: false
      }
    });

    await client.connect();
    return {
      query: (sql, params) => client.query(sql, params),
      end: () => client.end()
    };
  } else if (connection.db_type === 'mysql') {
    const conn = await mysql.createConnection({
      host: connection.host,
      port: connection.port,
      database: connection.database_name,
      user: connection.username,
      password: connection.password,
      ssl: connection.ssl_enabled ? { rejectUnauthorized: false } : undefined
    });
    return {
      query: async (sql, params) => {
        let convertedSql = sql;
        if (sql.includes('$1') || sql.includes('$2')) {
          convertedSql = sql.replace('$1', '?').replace('$2', '?');
        }
        const [rows] = await conn.query(convertedSql, params);
        return { rows };
      },
      end: () => conn.end()
    };
  } else if (connection.db_type === 'oracle') {
    const conn = await oracledb.getConnection({
      user: connection.username,
      password: connection.password,
      connectString: `${connection.host}:${connection.port}/${connection.database_name}`
    });
    return {
      query: async (sql, params) => {
        let convertedSql = sql;
        let bindParams = params || [];
        if (sql.includes('$1') || sql.includes('$2')) {
          convertedSql = sql.replace(/LIMIT\s+\$\d+/i, '').replace(/OFFSET\s+\$\d+/i, '');
          convertedSql += ` OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`;
          bindParams = { limit: params[0], offset: params[1] };
        }
        const result = await conn.execute(convertedSql, bindParams, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return { rows: result.rows };
      },
      end: () => conn.close()
    };
  } else {
    throw new Error(`Unsupported external database type: ${connection.db_type}`);
  }
}

module.exports = { connectToExternalDB };
