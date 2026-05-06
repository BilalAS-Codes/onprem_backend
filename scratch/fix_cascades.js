const db = require('../src/config/database');

async function fixForeignKeys() {
  try {
    console.log('Fixing foreign key constraints for cascading deletes...');
    
    // 1. Get the constraint name for semantic_columns -> semantic_tables
    // Usually it's semantic_columns_semantic_table_id_fkey
    
    await db.query(`
      ALTER TABLE semantic_columns 
      DROP CONSTRAINT IF EXISTS semantic_columns_semantic_table_id_fkey;
    `);

    await db.query(`
      ALTER TABLE semantic_columns 
      ADD CONSTRAINT semantic_columns_semantic_table_id_fkey 
      FOREIGN KEY (semantic_table_id) 
      REFERENCES semantic_tables(id) 
      ON DELETE CASCADE;
    `);

    console.log('✅ Foreign key constraints updated to ON DELETE CASCADE');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to update constraints:', err);
    process.exit(1);
  }
}

fixForeignKeys();
