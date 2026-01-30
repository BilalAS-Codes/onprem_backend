const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const dbDiscoverer = {
  async getConnectionPool(connectionConfig) {
  const { db_type, host, port, database_name, username, password, ssl = true } = connectionConfig;
  
  switch (db_type.toLowerCase()) {
    case 'postgresql':
    case 'postgres':
      return new Pool({
        host,
        port: parseInt(port),
        database: database_name,
        user: username,
        password,
        ssl: ssl ? {
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