async function ensureSchemaMetadataStorage(db) {
  await db.query(`
    ALTER TABLE semantic_columns
    ADD COLUMN IF NOT EXISTS enum_values JSONB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS semantic_relationships (
      id BIGSERIAL PRIMARY KEY,
      connection_id UUID NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
      source_table VARCHAR(255) NOT NULL,
      source_column VARCHAR(255) NOT NULL,
      target_table VARCHAR(255) NOT NULL,
      target_column VARCHAR(255) NOT NULL,
      relation_type VARCHAR(50) NOT NULL DEFAULT 'foreign_key',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (connection_id, source_table, source_column, target_table, target_column, relation_type)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_semantic_relationships_connection_id
    ON semantic_relationships(connection_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_semantic_relationships_source
    ON semantic_relationships(connection_id, source_table, source_column)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_semantic_relationships_target
    ON semantic_relationships(connection_id, target_table, target_column)
  `);
}

module.exports = {
  ensureSchemaMetadataStorage,
};
