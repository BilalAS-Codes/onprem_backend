const db = require('../src/config/database');

async function migrate() {
  try {
    console.log('Running final migrations for file source support...');
    
    // 1. Semantic Tables
    await db.query(`
      ALTER TABLE semantic_tables 
      ADD COLUMN IF NOT EXISTS file_source_id UUID REFERENCES file_sources(id) ON DELETE CASCADE;
    `);
    await db.query(`ALTER TABLE semantic_tables ALTER COLUMN connection_id DROP NOT NULL;`);

    // 2. Semantic Relationships
    await db.query(`
      ALTER TABLE semantic_relationships 
      ADD COLUMN IF NOT EXISTS file_source_id UUID REFERENCES file_sources(id) ON DELETE CASCADE;
    `);
    await db.query(`ALTER TABLE semantic_relationships ALTER COLUMN connection_id DROP NOT NULL;`);

    // 3. Chat Conversations
    await db.query(`
      ALTER TABLE chat_conversations 
      ADD COLUMN IF NOT EXISTS file_source_id UUID REFERENCES file_sources(id) ON DELETE CASCADE;
    `);
    await db.query(`ALTER TABLE chat_conversations ALTER COLUMN connection_id DROP NOT NULL;`);

    console.log('✅ All migrations completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
