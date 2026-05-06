const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 60000,
  ssl: false
});

console.log('Attempting to connect to:', process.env.DB_HOST);

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Connection failed!');
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    console.error('Error code:', err.code);
    console.error('Stack:', err.stack);
    process.exit(1);
  } else {
    console.log('✅ Connected successfully!');
    client.query('SELECT NOW()', (err, res) => {
      release();
      if (err) {
        console.error('Query error:', err);
      } else {
        console.log('Current Time from DB:', res.rows[0].now);
      }
      process.exit(0);
    });
  }
});
