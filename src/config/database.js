const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const isSSLEnabled = process.env.DB_SSL === 'true' || isProduction;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'zeroqueries',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 60000,
  ssl: isSSLEnabled ? {
    rejectUnauthorized: false
  } : false
  // ssl: {
  //   rejectUnauthorized: false
  // }
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err);
    console.error('Error Code:', err.code);
    console.error('Error Stack:', err.stack);
    console.error('Please check your database credentials in .env file');
    console.error('Host:', process.env.DB_HOST);
    console.error('Database:', process.env.DB_NAME);
    console.error('User:', process.env.DB_USER);
  } else {
    console.log('✅ Successfully connected to PostgreSQL database');
    console.log('📊 Database:', process.env.DB_NAME);
    console.log('🌐 Host:', process.env.DB_HOST);
    release();
  }
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  getClient: () => pool.connect(),
};