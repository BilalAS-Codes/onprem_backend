const db = require('../src/config/database');

async function migrate() {
  try {
    console.log('Migrating semantic tables to support file sources...');
    
    // Add file_source_id to semantic_tables
    await db.query(`
      ALTER TABLE semantic_tables 
      ADD COLUMN IF NOT EXISTS file_source_id UUID REFERENCES file_sources(id) ON DELETE CASCADE;
    `);

    // Modify the unique constraint to allow either connection_id OR file_source_id
    // But first we need to handle the case where connection_id is NOT NULL
    // Let's check current constraints
    console.log('Updating constraints...');
    
    // In many cases connection_id might be NOT NULL. Let's make it nullable if we are using file sources.
    await db.query(`
      ALTER TABLE semantic_tables ALTER COLUMN connection_id DROP NOT NULL;
    `);

    // Add file_source_id to semantic_relationships
    await db.query(`
      ALTER TABLE semantic_relationships 
      ADD COLUMN IF NOT EXISTS file_source_id UUID REFERENCES file_sources(id) ON DELETE CASCADE;
    `);
    
    await db.query(`
      ALTER TABLE semantic_relationships ALTER COLUMN connection_id DROP NOT NULL;
    `);

    console.log('Migration completed successfully!');
    
    // Add file_source_id to chat_conversations
    await db.query(
      ALTER TABLE chat_conversations 
      ADD COLUMN IF NOT EXISTS file_source_id UUID REFERENCES file_sources(id) ON DELETE CASCADE;
    );
    
    await db.query(
      ALTER TABLE chat_conversations ALTER COLUMN connection_id DROP NOT NULL;
    );

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
