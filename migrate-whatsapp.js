const db = require('./src/config/database');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    const sqlPath = path.join(__dirname, 'scripts', 'create-whatsapp-tables.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('Running WhatsApp schema migration...');
    await db.query(sql);
    console.log('WhatsApp migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('WhatsApp migration failed:', err);
    process.exit(1);
  }
}

runMigration();
