const db = require('../src/config/database');

async function checkState() {
  try {
    console.log('--- File Sources ---');
    const sources = await db.query('SELECT id, filename, s3_key, created_at FROM file_sources ORDER BY created_at DESC LIMIT 5');
    console.table(sources.rows);

    if (sources.rows.length > 0) {
      const sourceId = sources.rows[0].id;
      console.log(`\n--- Semantic Tables for last source (${sourceId}) ---`);
      const tables = await db.query('SELECT id, table_name, is_enabled FROM semantic_tables WHERE file_source_id = $1', [sourceId]);
      console.table(tables.rows);

      if (tables.rows.length > 0) {
        const tableId = tables.rows[0].id;
        console.log(`\n--- Semantic Columns for first table (${tables.rows[0].table_name}) ---`);
        const columns = await db.query('SELECT column_name, data_type, is_enabled FROM semantic_columns WHERE semantic_table_id = $1', [tableId]);
        console.table(columns.rows);
      }
    }

    console.log('\n--- Active Source for Organizations ---');
    const orgs = await db.query('SELECT id, name, active_source_id, active_source_type FROM organizations');
    console.table(orgs.rows);

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

checkState();
