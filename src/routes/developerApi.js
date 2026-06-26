const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const creditService = require('../services/creditService');
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const { getAiBaseUrl, adjustPayload, normalizeResponse } = require('../helpers/aiHelper');

// --- HELPER FUNCTIONS (Borrowed from publicChat.js) ---

function constructConnectionString(conn) {
    const user = encodeURIComponent(conn.username);
    const pass = encodeURIComponent(conn.password);
    if (conn.db_type === 'postgresql') {
        return `postgresql://${user}:${pass}@${conn.host}:${conn.port}/${conn.database_name}`;
    } else if (conn.db_type === 'mysql') {
        return `mysql://${user}:${pass}@${conn.host}:${conn.port}/${conn.database_name}`;
    } else if (conn.db_type === 'oracle') {
        return `oracle://${user}:${pass}@${conn.host}:${conn.port}/${conn.database_name}`;
    }
    return `${conn.db_type}://${user}:${pass}@${conn.host}:${conn.port}/${conn.database_name}`;
}

function formatSchemaInfoEntry(columnName, dataType, enumValues = []) {
    const safeColumnName = String(columnName || '').trim();
    const rawDataType = String(dataType || 'text').trim();
    const safeDataType = Array.isArray(enumValues) && enumValues.length > 0 && rawDataType.toLowerCase() === 'user-defined'
        ? 'varchar'
        : rawDataType;
    let entry = `${safeColumnName}(${safeDataType})`;
    if (Array.isArray(enumValues) && enumValues.length > 0) {
        entry += `:${JSON.stringify({ enum_values: enumValues })}`;
    }
    return entry;
}

async function getActiveSourceConfig(organizationId) {
    const orgResult = await db.query(
        'SELECT active_source_id, active_source_type FROM organizations WHERE id = $1',
        [organizationId]
    );
    const pref = orgResult.rows[0];
    let conn = null;
    let isFileSource = false;

    if (pref && pref.active_source_type === 'excel') {
        isFileSource = true;
        conn = { id: 'multi-file-source', organization_id: organizationId, source_type: 'excel' };
    } else if (pref && pref.active_source_id) {
        const dbResult = await db.query(
            'SELECT * FROM database_connections WHERE id = $1 AND organization_id = $2',
            [pref.active_source_id, organizationId]
        );
        if (dbResult.rows.length) conn = dbResult.rows[0];
    }
    return { conn, isFileSource };
}

function parseDepartmentAccess(rawAccess) {
    const normalized = String(rawAccess || '').trim();
    if (!normalized || normalized.toLowerCase() === 'all') {
        return { isAll: true, departmentIds: [] };
    }
    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) return { isAll: false, departmentIds: parsed.map(v => String(v).trim()).filter(Boolean) };
    } catch (e) { }
    return { isAll: false, departmentIds: normalized.split(',').map(v => String(v).trim()).filter(Boolean) };
}

function canAccessColumnByDepartment(row, userContext = {}) {
    const roleName = String(userContext.role || '').toLowerCase();
    if (roleName === 'admin' || roleName === 'super admin') return true;
    const { isAll, departmentIds } = parseDepartmentAccess(row.department_access);
    if (isAll) return true;
    const userDeptId = userContext.department_id ? String(userContext.department_id).trim() : '';
    const userDeptIds = Array.isArray(userContext.department_ids) ? userContext.department_ids.map(id => String(id).trim()) : [];
    if (userDeptId && departmentIds.includes(userDeptId)) return true;
    if (userDeptIds.some(id => departmentIds.includes(id))) return true;
    return false;
}

async function buildSemanticContext(conn, userContext = {}) {
    const isMultiFile = conn.id === 'multi-file-source';
    const schemaQuery = isMultiFile
        ? `SELECT st.table_name, st.is_enabled as table_enabled, sc.column_name, sc.data_type, sc.enum_values, sc.is_enabled as column_enabled, sc.department_access, fs.filename as file_source_name
           FROM semantic_tables st JOIN semantic_columns sc ON st.id = sc.semantic_table_id JOIN file_sources fs ON st.file_source_id = fs.id
           WHERE fs.organization_id = $1 AND fs.status = 'active'`
        : `SELECT st.table_name, st.is_enabled as table_enabled, sc.column_name, sc.data_type, sc.enum_values, sc.is_enabled as column_enabled, sc.department_access, fs.filename as file_source_name
           FROM semantic_tables st JOIN semantic_columns sc ON st.id = sc.semantic_table_id LEFT JOIN file_sources fs ON st.file_source_id = fs.id
           WHERE st.connection_id = $1 OR st.file_source_id = $1`;

    const schemaResult = await db.query(schemaQuery, [isMultiFile ? conn.organization_id : conn.id]);
    const schemaInfo = {};
    const allowedTables = [];
    const disallowedTables = [];
    const allowedColumns = {};
    const restrictedColumns = {};

    schemaResult.rows.forEach((row) => {
        let tbl = row.table_name;
        if (isMultiFile && ["Sheet1", "CSV", "Worksheet", "Sheet 1", "Sheet"].includes(tbl) && row.file_source_name) {
            tbl = row.file_source_name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
        }
        if (row.table_enabled) {
            if (row.column_enabled && canAccessColumnByDepartment(row, userContext)) {
                if (!schemaInfo[tbl]) schemaInfo[tbl] = [];
                schemaInfo[tbl].push(formatSchemaInfoEntry(row.column_name, row.data_type, Array.isArray(row.enum_values) ? row.enum_values : []));
                if (!allowedTables.includes(tbl)) allowedTables.push(tbl);
                if (!allowedColumns[tbl]) allowedColumns[tbl] = [];
                allowedColumns[tbl].push(row.column_name);
            } else {
                if (!restrictedColumns[tbl]) restrictedColumns[tbl] = [];
                restrictedColumns[tbl].push(row.column_name);
            }
        } else if (!disallowedTables.includes(tbl)) disallowedTables.push(tbl);
    });

    const relationships = [];
    try {
        const relQuery = isMultiFile
            ? `SELECT sr.source_table, sr.source_column, sr.target_table, sr.target_column FROM semantic_relationships sr JOIN file_sources fs ON sr.file_source_id = fs.id WHERE fs.organization_id = $1 AND fs.status = 'active'`
            : `SELECT source_table, source_column, target_table, target_column FROM semantic_relationships WHERE connection_id = $1`;
        const relResult = await db.query(relQuery, [isMultiFile ? conn.organization_id : conn.id]);
        relResult.rows.forEach(r => relationships.push({ from_field: `${r.source_table}.${r.source_column}`, to_field: `${r.target_table}.${r.target_column}` }));
    } catch (e) { }

    return { schemaInfo, allowedTables, disallowedTables, allowedColumns, restrictedColumns, relationships };
}

// --- API ENDPOINTS ---

/**
 * POST /api/v1/chat
 * Main entry point for the Developer API.
 */
router.post('/chat', authenticateApiKey, async (req, res) => {
    const { message } = req.body;
    const { organization_id, role, department_id, department_ids } = req.user;
    const startedAt = Date.now();

    if (!message) {
        return res.status(400).json({ error: 'message is required' });
    }

    try {
        // 1. Credit Check
        const creditCheck = await creditService.hasCredits(organization_id, 1);
        if (!creditCheck.allowed) {
            return res.status(403).json({ error: 'Insufficient credits' });
        }

        // 2. Get Data Source
        const { conn, isFileSource } = await getActiveSourceConfig(organization_id);
        if (!conn) return res.status(404).json({ error: 'No active data source found' });

        // 3. Build Context
        const ctx = await buildSemanticContext(conn, req.user);

        // 4. Construct AI Payload
        const access_policy = {
            role: role.toLowerCase(),
            allowed_tables: ctx.allowedTables,
            disallowed_tables: ctx.disallowedTables,
            allowed_columns: ctx.allowedColumns,
            restricted_columns: ctx.restrictedColumns || {},
            row_level_filters: {},
            max_rows: 1000,
            query_timeout_seconds: 30
        };

        const payload = {
            question: message,
            max_rows: 100,
            include_insights: true,
            include_visualizations: false,
            access_policy,
            locale: 'en',
            strict_joins: true
        };
        const adjustedPayload = adjustPayload(payload);

        const AI_API_KEY = (process.env.EXTERNAL_AI_API_KEY || '').replace(/"/g, '').trim();
        const QUERY_API_URL = `${getAiBaseUrl()}/query`;

        const queryResponse = await axios.post(QUERY_API_URL, adjustedPayload, {
            headers: { 'Authorization': `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 60000
        });

        const result = normalizeResponse(queryResponse.data);

        // 5. Finalize
        await creditService.deductCredits(organization_id, 1, { reference_type: 'developer_api', integration_id: req.integration.id });
        await db.query(`INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, response_payload) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.integration.id, organization_id, '/api/v1/chat', 'success', Date.now() - startedAt, JSON.stringify({ question: message }), JSON.stringify(result)]);

        res.json({
            answer: result.execution_metadata?.ai_summary || result.answer,
            data: result.data || [],
            ai_result: result,
            metadata: {
                duration_ms: Date.now() - startedAt
            }
        });

    } catch (err) {
        console.error('Developer API Error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
