const { Pool } = require('pg');

const exportPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,                 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

const getClient = () => exportPool.connect();

module.exports = {
  getClient
};
