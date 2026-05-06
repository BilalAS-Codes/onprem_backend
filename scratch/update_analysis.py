import os

path = 'src/routes/analysis.js'
if not os.path.exists(path):
    print(f"File not found: {path}")
    exit(1)

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update buildSemanticContext SQL
# We'll use a more flexible replacement that doesn't care about exact whitespace
import re

# Replace the WHERE clause in the first query
content = re.sub(
    r'WHERE st\.connection_id = \$1',
    'WHERE st.connection_id = $1 OR st.file_source_id = $1',
    content
)

# Replace relationship query block
old_rel = """        const storedRelationshipsResult = await db.query(
            `SELECT source_table, source_column, target_table, target_column
             FROM semantic_relationships
             WHERE connection_id = $1
             ORDER BY source_table, source_column, target_table, target_column`,
            [conn.id]
        );"""

# I'll use a more robust replacement for the relationship block
rel_pattern = r'const storedRelationshipsResult = await db\.query\(\s+`SELECT source_table, source_column, target_table, target_column\s+FROM semantic_relationships\s+WHERE connection_id = \$1\s+ORDER BY source_table, source_column, target_table, target_column`,\s+\[conn\.id\]\s+\);'

new_rel = """        const relQuery = conn.source_type === 'excel'
            ? 'SELECT source_table, source_column, target_table, target_column FROM semantic_relationships WHERE file_source_id = $1'
            : 'SELECT source_table, source_column, target_table, target_column FROM semantic_relationships WHERE connection_id = $1';
        const storedRelationshipsResult = await db.query(relQuery, [conn.id]);"""

content = re.sub(rel_pattern, new_rel, content)

# Update /analyze block
# Instead of replacing the whole block, I'll replace key parts
content = content.replace(
    "const conn = connectionResult.rows[0];",
    """let conn = null;
        let isFileSource = false;
        if (connectionResult.rows.length) {
            conn = connectionResult.rows[0];
        } else {
            const fileResult = await db.query(
                'SELECT * FROM file_sources WHERE organization_id = $1 AND status = $2 LIMIT 1',
                [organization_id, 'active']
            );
            if (fileResult.rows.length) {
                conn = fileResult.rows[0];
                isFileSource = true;
                conn.source_type = 'excel';
            }
        }
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No active source found.' });
        }"""
)

# Remove the redundant error check that was there before
content = content.replace(
    """if (!connectionResult.rows.length) {
            return res.status(404).json({ success: false, error: 'No active database connection found for your organization.' });
        }""",
    ""
)

# Finally, update the payload
# This is tricky due to the complex object. I'll just replace the whole externalPayload definition.
payload_pattern = r'const externalPayload = \{.*?include_visualizations: true\s+\};'
new_payload = """        let externalPayload;
        if (isFileSource) {
            const allFilesResult = await db.query('SELECT s3_key FROM file_sources WHERE organization_id = $1 AND status = $2', [organization_id, 'active']);
            const awsPaths = allFilesResult.rows.map(f => `s3://${process.env.AWS_S3_BUCKET || 'invertiotaxdocs'}/${f.s3_key}`);
            externalPayload = {
                db_config: {
                    type: 'sheets',
                    aws_paths: awsPaths,
                    load_all_sheets: true,
                    schema_info: schemaInfo,
                    relationships
                },
                access_policy: {
                    role: role.toLowerCase(),
                    allowed_tables: allowedTables,
                    disallowed_tables: disallowedTables,
                    allowed_columns: allowedColumns,
                    restricted_columns: restrictedColumns,
                    max_rows: 1000,
                    query_timeout_seconds: 30
                },
                question: question,
                response_format: 'general',
                max_rows: max_rows,
                include_insights: true,
                include_visualizations: true
            };
        } else {
            externalPayload = {
                db_config: {
                    type: conn.db_type === 'postgresql' ? 'postgres' : conn.db_type,
                    connection_string: constructConnectionString(conn),
                    host: conn.host,
                    port: parseInt(conn.port),
                    database: conn.database_name,
                    username: conn.username,
                    password: conn.password,
                    schema_info: schemaInfo,
                    relationships
                },
                access_policy: {
                    role: role.toLowerCase(),
                    allowed_tables: allowedTables,
                    disallowed_tables: disallowedTables,
                    allowed_columns: allowedColumns,
                    restricted_columns: restrictedColumns,
                    row_level_filters: {},
                    max_rows: 1000,
                    query_timeout_seconds: 30
                },
                question: question,
                response_format: 'general',
                max_rows: max_rows,
                include_insights: true,
                include_visualizations: true
            };
        }"""

content = re.sub(payload_pattern, new_payload, content, flags=re.DOTALL)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Update successful")
