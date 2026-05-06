const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 10000,
  ssl: false // Disable SSL for testing
});

console.log('Attempting to connect (NO SSL) to:', process.env.DB_HOST);

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Connection failed!');
    console.error('Error message:', err.message);
    process.exit(1);
  } else {
    console.log('✅ Connected successfully (NO SSL)!');
    release();
    process.exit(0);
  }
});
