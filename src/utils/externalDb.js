const { Client } = require('pg');

async function connectToExternalDB(connection) {
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
  return client;
}

module.exports = { connectToExternalDB };
