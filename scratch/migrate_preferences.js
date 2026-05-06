const db = require('../src/config/database');

async function migratePreferences() {
  try {
    console.log('Adding active source preferences to organizations...');
    
    await db.query(`
      ALTER TABLE organizations 
      ADD COLUMN IF NOT EXISTS active_source_id UUID,
      ADD COLUMN IF NOT EXISTS active_source_type VARCHAR(50) DEFAULT 'postgresql';
    `);

    console.log('✅ Organization preferences table updated');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migratePreferences();
