const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const isSSLEnabled = process.env.DB_SSL === 'true' || isProduction;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: isSSLEnabled ? {
    rejectUnauthorized: false
  } : false
});

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('🔄 Starting database migration...');
    
    const sqlPath = path.join(__dirname, 'schema-dump.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migration SQL file not found at: ${sqlPath}`);
    }
    
    console.log(`Reading SQL schema dump from: ${sqlPath}`);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('Executing SQL commands...');
    await client.query(sql);
    
    console.log('✅ Database migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
