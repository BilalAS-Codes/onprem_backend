const db = require('./src/config/database');

async function createTable() {
  try {
    console.log('Creating file_sources table...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS file_sources (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        organization_id UUID NOT NULL REFERENCES organizations(id),
        source_type VARCHAR(50) NOT NULL,
        filename VARCHAR(255),
        s3_key VARCHAR(500),
        url VARCHAR(500),
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Table created successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Error creating table:', err);
    process.exit(1);
  }
}

createTable();
