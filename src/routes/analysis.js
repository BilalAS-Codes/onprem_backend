const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * Helper to construct a Postgres connection string
 */
function constructConnectionString(conn) {
    const user = encodeURIComponent(conn.username);
    const pass = encodeURIComponent(conn.password);
    return `postgresql://${user}:${pass}@${conn.host}:${conn.port}/${conn.database_name}`;
}

/**
 * POST /api/v1/analyze
 * Proxies the request to the external AI Analysis service with full context
 */
router.post('/analyze', authenticateToken, async (req, res) => {
    const { question, max_rows = 100 } = req.body;
    const { organization_id, role } = req.user;

    if (!question) {
        return res.status(400).json({ success: false, error: 'Question is required' });
    }

    try {
        // 1. Fetch active database connection
        const connectionResult = await db.query(
            'SELECT * FROM database_connections WHERE organization_id = $1 AND status = $2 LIMIT 1',
            [organization_id, 'connected']
        );

        if (!connectionResult.rows.length) {
            return res.status(404).json({ success: false, error: 'No active database connection found for your organization.' });
        }

        const conn = connectionResult.rows[0];

        // 2. Fetch schema info (Tables & Columns)
        const schemaResult = await db.query(
            `SELECT st.table_name, st.is_enabled as table_enabled, sc.column_name, sc.is_enabled as column_enabled
             FROM semantic_tables st
             JOIN semantic_columns sc ON st.id = sc.semantic_table_id
             WHERE st.connection_id = $1`,
            [conn.id]
        );

        const schemaInfo = {};
        const allowedTables = [];
        const disallowedTables = [];
        const allowedColumns = {};
        const restrictedColumns = {};

        schemaResult.rows.forEach(row => {
            const tbl = row.table_name;
            const col = row.column_name;

            // Build schema_info map
            if (!schemaInfo[tbl]) schemaInfo[tbl] = [];
            schemaInfo[tbl].push(col);

            // Access Policy logic
            if (row.table_enabled) {
                if (!allowedTables.includes(tbl)) allowedTables.push(tbl);

                if (row.column_enabled) {
                    if (!allowedColumns[tbl]) allowedColumns[tbl] = [];
                    allowedColumns[tbl].push(col);
                } else {
                    if (!restrictedColumns[tbl]) restrictedColumns[tbl] = [];
                    restrictedColumns[tbl].push(col);
                }
            } else {
                if (!disallowedTables.includes(tbl)) disallowedTables.push(tbl);
            }
        });

        // 3. Construct Payload for External API
        const externalPayload = {
            db_config: {
                type: conn.db_type === 'postgresql' ? 'postgres' : conn.db_type,
                connection_string: constructConnectionString(conn),
                host: conn.host,
                port: parseInt(conn.port),
                database: conn.database_name,
                username: conn.username,
                password: conn.password,
                schema_info: schemaInfo
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
            response_format: "general",
            max_rows: max_rows,
            include_insights: true,
            include_visualizations: true
        };

        console.log('Forwarding request to External Analysis API...', externalPayload);

        // 4. Call External Digital Ocean API
        // Authorization header as provided in the user's example
        const EXTERNAL_API_URL = 'https://zeroqueries-9b4b6.ondigitalocean.app/api/v1/analyze';
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || 'ak_EX6ye1WXey55tjHLnI_c3hXGNpTJRy5F0DbOkw2otTA';

        const response = await axios.post(EXTERNAL_API_URL, externalPayload, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000 // 45s timeout for AI analysis
        });

        // 5. Return the result from the external API to our frontend
        res.json(response.data);

    } catch (error) {
        console.error('Analysis Proxy Error:', error.response?.data || error.message);

        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External analysis service failed' };

        res.status(statusCode).json({
            success: false,
            message: 'External Analysis API Error',
            details: errorData
        });
    }
});

module.exports = router;
