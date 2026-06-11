const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkCredits } = require('../middleware/creditCheck');
const creditService = require('../services/creditService');
const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/jwt');
const dbDiscoverer = require('../helpers/dbDiscoverer');
const { getAiBaseUrl, adjustPayload, areSuggestionsEnabled, getDisabledSuggestionsResponse, normalizeResponse, writeAsyncDebugLog } = require('../helpers/aiHelper');

// In-memory storage for Server-Sent Events clients keyed by conversation ID
const sseClients = {};
const taskPollers = new Map();

// Helper to authenticate token supplied via query param (for SSE)
// also accepts Authorization header if EventSource client can provide it.
function authenticateTokenForSSE(req, res, next) {
    console.log('\n═══════════════ SSE AUTH DEBUG ═══════════════');
    console.log('URL:', req.url);
    console.log('req.query:', JSON.stringify(req.query));
    console.log('req.query.token exists:', !!req.query.token);
    if (req.query.token) {
        console.log('Token found in query! Length:', req.query.token.length);
        console.log('Token preview:', req.query.token.substring(0, 50) + '...');
    }

    // Try multiple ways to get the token
    let token = null;

    // 1. Try query parameter first (Express should parse this automatically)
    if (req.query && req.query.token) {
        token = req.query.token;
        console.log('✅ Token found in req.query');
    }

    // 2. Manual URL parsing as backup
    if (!token && req.url.includes('?')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        token = urlParams.get('token');
        if (token) {
            console.log('✅ Token found via manual URL parsing');
        }
    }

    // 3. Try Authorization header
    if (!token && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts[0] === 'Bearer' && parts[1]) {
            token = parts[1];
            console.log('✅ Token found in Authorization header');
        }
    }

    console.log('Final token result:', token ? `${token.substring(0, 30)}...` : 'NOT FOUND');
    console.log('═════════════════════════════════════════════\n');

    // If still no token, return detailed error
    if (!token) {
        return res.status(401).json({
            error: 'Authentication token required',
            hint: 'Please provide token as query parameter: ?token=YOUR_TOKEN',
            received: {
                queryKeys: Object.keys(req.query || {}),
                hasAuthHeader: !!req.headers.authorization,
                url: req.url
            }
        });
    }

    // Validate token is a JWT (should have 3 parts separated by dots)
    if (token.split('.').length !== 3) {
        return res.status(400).json({
            error: 'Invalid token format',
            hint: 'Token should be a valid JWT',
            received: token.substring(0, 50) + '...'
        });
    }

    // Verify JWT signature
    jwt.verify(token, jwtConfig.secret, (err, user) => {
        if (err) {
            console.error('❌ JWT verification failed:', err.message);
            return res.status(403).json({
                error: 'Invalid or expired token',
                details: err.message
            });
        }

        console.log('✅ JWT verified for user:', user.email);
        // Token is valid, attach user to request
        req.user = user;
        next();
    });
}

// Utility to broadcast an event to all SSE clients for a conversation
function sendSse(conversationId, event, data) {
    const clients = sseClients[conversationId] || [];
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach((res) => {
        try {
            res.write(payload);
        } catch (e) {
            console.error('SSE write failed', e);
        }
    });
}

function normalizeTaskUpdatePayload(payload, fallbackTaskId = null, fallbackConversationId = null) {
    const base = payload?.success && payload?.data ? payload.data : payload;
    const details = base?.details || payload?.details;
    const result = base?.result || details?.result || payload?.result || payload?.data?.result;

    return {
        ...payload,
        ...(base && base !== payload ? base : {}),
        task_id: base?.task_id || payload?.task_id || payload?.data?.task_id || fallbackTaskId,
        conversation_id: base?.conversation_id || payload?.conversation_id || fallbackConversationId,
        details: result && details ? { ...details, result } : details,
        result: result || undefined
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactPayloadForLog(payload) {
    if (!payload || typeof payload !== 'object') return payload;

    return {
        ...payload,
        db_config: payload.db_config
            ? {
                ...payload.db_config,
                connection_string: payload.db_config.connection_string ? '[REDACTED]' : payload.db_config.connection_string,
                password: payload.db_config.password ? '[REDACTED]' : payload.db_config.password
            }
            : payload.db_config
    };
}

function logExternalApiResponse(label, payload) {
    console.log(label);
    console.dir(payload, { depth: null, maxArrayLength: null });
}

async function getActiveSourceConfig(organizationId) {
    // 1. Fetch organization's pinned preference
    const orgResult = await db.query(
        'SELECT active_source_id, active_source_type FROM organizations WHERE id = $1',
        [organizationId]
    );
    const pref = orgResult.rows[0];

    let conn = null;
    let isFileSource = false;

    // Handle Excel as a multi-file source for the entire organization
    if (pref && pref.active_source_type === 'excel') {
        isFileSource = true;
        conn = {
            id: 'multi-file-source',
            organization_id: organizationId,
            source_type: 'excel'
        };
        return { conn, isFileSource };
    }

    if (pref && pref.active_source_id) {
        const dbResult = await db.query(
            'SELECT * FROM database_connections WHERE id = $1 AND organization_id = $2',
            [pref.active_source_id, organizationId]
        );
        if (dbResult.rows.length) {
            conn = dbResult.rows[0];
        }
    }

    // Fallback logic
    if (!conn) {
        const dbResult = await db.query(
            'SELECT * FROM database_connections WHERE organization_id = $1 AND status = $2 LIMIT 1',
            [organizationId, 'connected']
        );
        if (dbResult.rows.length) {
            conn = dbResult.rows[0];
        } else {
            const fileResult = await db.query(
                'SELECT * FROM file_sources WHERE organization_id = $1 AND status = $2 LIMIT 1',
                [organizationId, 'active']
            );
            if (fileResult.rows.length) {
                isFileSource = true;
                conn = {
                    id: 'multi-file-source',
                    organization_id: organizationId,
                    source_type: 'excel'
                };
            }
        }
    }

    return { conn, isFileSource };
}

async function buildExternalPayload({
    conn,
    isFileSource,
    organization_id,
    question,
    max_rows,
    role,
    locale = 'en',
    include_insights = true,
    include_visualizations = true,
    schemaContext
}) {
    const {
        schemaInfo,
        allowedTables,
        disallowedTables,
        allowedColumns,
        restrictedColumns,
        relationships
    } = schemaContext;

    if (isFileSource) {
        // Build Excel Payload
        const allFilesResult = await db.query(
            'SELECT s3_key FROM file_sources WHERE organization_id = $1 AND status = $2',
            [organization_id, 'active']
        );
        const awsPaths = allFilesResult.rows.map(f => `s3://${process.env.AWS_S3_BUCKET || 'zeroqueries'}/${f.s3_key}`);

        return {
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
            locale: locale,
            include_insights: include_insights,
            include_visualizations: include_visualizations
        };
    } else {
        // Build SQL Payload
        return {
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
            response_format: "general",
            max_rows: max_rows,
            locale: locale,
            include_insights: include_insights,
            include_visualizations: include_visualizations
        };
    }
}

async function logAnalysisApiCall({
    organizationId = null,
    userId = null,
    conversationId = null,
    endpoint,
    question = null,
    requestPayload = null,
    responsePayload = null,
    errorPayload = null,
    statusCode = null,
    durationMs = null,
    success = false
}) {
    try {
        const responseData = responsePayload && typeof responsePayload === 'object' ? responsePayload : null;
        const errorData = errorPayload && typeof errorPayload === 'object' ? errorPayload : null;

        await db.query(
            `INSERT INTO analysis_api_logs (
                organization_id,
                user_id,
                conversation_id,
                service_name,
                endpoint,
                method,
                question,
                request_id,
                task_id,
                status_code,
                success,
                duration_ms,
                request_payload,
                response_payload,
                error_payload
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
            )`,
            [
                organizationId,
                userId,
                conversationId,
                'external-ai',
                endpoint,
                'POST',
                question,
                responseData?.request_id || errorData?.request_id || null,
                responseData?.task_id || responseData?.id || errorData?.task_id || null,
                statusCode,
                success,
                durationMs,
                requestPayload ? JSON.stringify(redactPayloadForLog(requestPayload)) : null,
                responseData ? JSON.stringify(responseData) : null,
                errorData ? JSON.stringify(errorData) : null
            ]
        );
    } catch (logError) {
        console.error('[ANALYSIS API LOG] Failed to persist log:', logError.message);
    }
}

async function updateAnalysisApiLogByTaskId({
    taskId,
    responsePayload = null,
    errorPayload = null,
    success = false,
    conversationId = null
}) {
    if (!taskId) return;

    try {
        const responseData = responsePayload && typeof responsePayload === 'object' ? responsePayload : null;
        const errorData = errorPayload && typeof errorPayload === 'object' ? errorPayload : null;

        await db.query(
            `UPDATE analysis_api_logs
             SET conversation_id = COALESCE($1, conversation_id),
                 request_id = COALESCE($2, request_id),
                 response_payload = COALESCE($3, response_payload),
                 error_payload = COALESCE($4, error_payload),
                 success = $5,
                 status_code = COALESCE($6, status_code)
             WHERE id = (
                 SELECT id
                 FROM analysis_api_logs
                 WHERE task_id = $7
                 ORDER BY created_at DESC
                 LIMIT 1
             )`,
            [
                conversationId,
                responseData?.request_id || errorData?.request_id || null,
                responseData ? JSON.stringify(responseData) : null,
                errorData ? JSON.stringify(errorData) : null,
                success,
                responseData || errorData ? 200 : null,
                taskId
            ]
        );
    } catch (logError) {
        console.error('[ANALYSIS API LOG] Failed to update log:', logError.message);
    }
}


/**
 * Helper to construct a Postgres connection string
 */
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

function parseDepartmentAccess(rawValue) {
    if (rawValue == null) return { isAll: true, departmentIds: [] };

    const normalized = String(rawValue).trim();
    if (!normalized || normalized.toLowerCase() === 'all') {
        return { isAll: true, departmentIds: [] };
    }

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return {
                isAll: false,
                departmentIds: parsed.map((value) => String(value).trim()).filter(Boolean)
            };
        }
    } catch (error) {
        // Fall back to comma-separated legacy format.
    }

    return {
        isAll: false,
        departmentIds: normalized
            .split(',')
            .map((value) => String(value).trim())
            .filter(Boolean)
    };
}

function canAccessColumnByDepartment(row, userContext = {}) {
    const roleName = String(userContext.role || '').toLowerCase();
    const isAdmin = roleName === 'admin' || roleName === 'super admin';
    if (isAdmin) return true;

    const { isAll, departmentIds } = parseDepartmentAccess(row.department_access);
    if (isAll) return true;

    const userDepartmentId = userContext.department_id ? String(userContext.department_id).trim() : '';
    if (!userDepartmentId) return false;

    return departmentIds.includes(userDepartmentId);
}

async function buildSemanticContext(conn, userContext = {}) {
    const isMultiFile = conn.id === 'multi-file-source';

    const schemaQuery = isMultiFile
        ? `SELECT
            st.table_name,
            st.is_enabled as table_enabled,
            sc.column_name,
            sc.data_type,
            sc.enum_values,
            sc.is_enabled as column_enabled,
            sc.department_access,
            fs.filename as file_source_name
          FROM semantic_tables st
          JOIN semantic_columns sc ON st.id = sc.semantic_table_id
          JOIN file_sources fs ON st.file_source_id = fs.id
          WHERE fs.organization_id = $1 AND fs.status = 'active'`
        : `SELECT
            st.table_name,
            st.is_enabled as table_enabled,
            sc.column_name,
            sc.data_type,
            sc.enum_values,
            sc.is_enabled as column_enabled,
            sc.department_access,
            fs.filename as file_source_name
          FROM semantic_tables st
          JOIN semantic_columns sc ON st.id = sc.semantic_table_id
          LEFT JOIN file_sources fs ON st.file_source_id = fs.id
          WHERE st.connection_id = $1 OR st.file_source_id = $1`;

    const schemaResult = await db.query(schemaQuery, [isMultiFile ? conn.organization_id : conn.id]);

    const schemaInfo = {};
    const allowedTables = [];
    const disallowedTables = [];
    const allowedColumns = {};
    const restrictedColumns = {};
    const tableColumnTypes = {};

    schemaResult.rows.forEach((row) => {
        let tbl = row.table_name;
        // Handle collisions for file-based sources with generic sheet names
        const isGenericSheet = ["Sheet1", "CSV", "Worksheet", "Sheet 1", "Sheet"].includes(tbl);
        if (isMultiFile && isGenericSheet && row.file_source_name) {
            tbl = row.file_source_name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
        }

        const col = row.column_name;
        const dataType = row.data_type;

        if (row.table_enabled) {
            if (!schemaInfo[tbl]) schemaInfo[tbl] = [];
            if (!tableColumnTypes[tbl]) tableColumnTypes[tbl] = {};
            tableColumnTypes[tbl][col] = dataType;

            schemaInfo[tbl].push(
                formatSchemaInfoEntry(
                    col,
                    dataType,
                    Array.isArray(row.enum_values) ? row.enum_values : []
                )
            );

            if (!allowedTables.includes(tbl)) allowedTables.push(tbl);

            const hasDepartmentAccess = canAccessColumnByDepartment(row, userContext);

            if (row.column_enabled && hasDepartmentAccess) {
                if (!allowedColumns[tbl]) allowedColumns[tbl] = [];
                allowedColumns[tbl].push(col);
            } else {
                if (!restrictedColumns[tbl]) restrictedColumns[tbl] = [];
                restrictedColumns[tbl].push(col);
            }
        } else if (!disallowedTables.includes(tbl)) {
            disallowedTables.push(tbl);
        }
    });

    const relationships = [];

    try {
        const isMultiFile = conn.id === 'multi-file-source';
        const relQuery = isMultiFile
            ? `SELECT sr.source_table, sr.source_column, sr.target_table, sr.target_column, fs.filename as file_source_name 
               FROM semantic_relationships sr
               JOIN file_sources fs ON sr.file_source_id = fs.id
               WHERE fs.organization_id = $1 AND fs.status = 'active'`
            : (conn.source_type === 'excel'
                ? 'SELECT sr.source_table, sr.source_column, sr.target_table, sr.target_column, fs.filename as file_source_name FROM semantic_relationships sr JOIN file_sources fs ON sr.file_source_id = fs.id WHERE sr.file_source_id = $1'
                : 'SELECT source_table, source_column, target_table, target_column FROM semantic_relationships WHERE connection_id = $1');

        const storedRelationshipsResult = await db.query(relQuery, [isMultiFile ? conn.organization_id : conn.id]);

        storedRelationshipsResult.rows.forEach((relationship) => {
            if (!relationship?.source_table || !relationship?.source_column || !relationship?.target_table || !relationship?.target_column) {
                return;
            }

            let srcTbl = relationship.source_table;
            let tgtTbl = relationship.target_table;

            const isGenericSrc = ["Sheet1", "CSV", "Worksheet", "Sheet 1", "Sheet"].includes(srcTbl);
            const isGenericTgt = ["Sheet1", "CSV", "Worksheet", "Sheet 1", "Sheet"].includes(tgtTbl);

            if (isMultiFile && relationship.file_source_name) {
                if (isGenericSrc) {
                    srcTbl = relationship.file_source_name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
                }
                if (isGenericTgt) {
                    tgtTbl = relationship.file_source_name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
                }
            }

            relationships.push({
                from_field: `${srcTbl}.${relationship.source_column}`,
                to_field: `${tgtTbl}.${relationship.target_column}`
            });
        });
    } catch (storedRelationshipError) {
        console.warn('[ANALYSIS] Stored relationship lookup failed:', storedRelationshipError.message);
    }

    try {
        const pool = await dbDiscoverer.getConnectionPool(conn);
        try {
            for (const tableName of Object.keys(schemaInfo)) {
                const hasStoredEnumMetadata = schemaInfo[tableName]?.some((entry) => entry.includes('"enum_values"'));

                if (!hasStoredEnumMetadata) {
                    const columnMetadata = await dbDiscoverer.discoverColumnMetadata(
                        pool,
                        conn.db_type,
                        tableName
                    );

                    if (Array.isArray(columnMetadata) && columnMetadata.length > 0) {
                        schemaInfo[tableName] = columnMetadata.map((column) => {
                            const fallbackType = tableColumnTypes[tableName]?.[column.column_name];
                            return formatSchemaInfoEntry(
                                column.column_name,
                                column.data_type || fallbackType,
                                column.enum_values
                            );
                        });
                    }
                }
            }

            if (relationships.length === 0) {
                for (const tableName of allowedTables) {
                    const foreignKeys = await dbDiscoverer.discoverForeignKeys(
                        pool,
                        conn.db_type,
                        tableName
                    );

                    foreignKeys.forEach((fk) => {
                        if (!fk?.column_name || !fk?.foreign_table || !fk?.foreign_column) return;

                        relationships.push({
                            from_field: `${tableName}.${fk.column_name}`,
                            to_field: `${fk.foreign_table}.${fk.foreign_column}`
                        });
                    });
                }
            }
        } finally {
            await pool.end();
        }
    } catch (relationshipError) {
        console.warn('[ANALYSIS] Relationship discovery failed:', relationshipError.message);
    }

    return {
        schemaInfo,
        allowedTables,
        disallowedTables,
        allowedColumns,
        restrictedColumns,
        relationships
    };
}

/**
 * POST /api/v1/analyze
 * Proxies the request to the external AI Analysis service with full context
 */
/**
 * @openapi
 * /v1/analyze:
 *   post:
 *     summary: Ask a natural language question about your data
 *     tags: [Analysis]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - question
 *             properties:
 *               question:
 *                 type: string
 *                 example: "What are the total sales this month?"
 *               max_rows:
 *                 type: integer
 *                 default: 100
 *     responses:
 *       200:
 *         description: AI analysis result
 *       400:
 *         description: Bad request
 */
router.post('/analyze', authenticateToken, async (req, res) => {

    const { question, max_rows = 100 } = req.body;
    const { organization_id, role, id: user_id } = req.user;
    const startedAt = Date.now();

    console.log('📨 [ANALYZE] Received request for question:', question);

    if (!question) {
        return res.status(400).json({ success: false, error: 'Question is required' });
    }

    try {
        const { conn, isFileSource } = await getActiveSourceConfig(organization_id);
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No active source found.' });
        }

        const schemaContext = await buildSemanticContext(conn, req.user);

        // 3. Construct Payload for External API
        const externalPayload = await buildExternalPayload({
            conn,
            isFileSource,
            organization_id,
            question,
            max_rows,
            role,
            schemaContext
        });

        const adjustedPayload = adjustPayload(externalPayload);

        console.log('🔍 [ANALYZE] Forwarding request to External Analysis API...');

        const EXTERNAL_API_URL = `${getAiBaseUrl()}/analyze`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        const response = await axios.post(EXTERNAL_API_URL, adjustedPayload, {

            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000 // 45s timeout for AI analysis
        });

        const finalResult = normalizeResponse(response.data);

        console.log('=== DEBUG ANALYZE RESPONSE ===');
        console.log('AI insights toggle enabled:', process.env.AI_INSIGHTS_ENABLED);
        console.log('Raw response insights:', response.data?.insights || response.data?.ai_result?.insights);
        console.log('Final normalized response insights:', finalResult?.insights || finalResult?.ai_result?.insights);
        console.log('==============================');

        // 5. Return the result from the external API to our frontend
        console.log('✅ [ANALYZE] Returning analysis results to frontend');
        logExternalApiResponse('📥 [ANALYZE] External Analysis API response:', finalResult);

        await logAnalysisApiCall({
            organizationId: organization_id,
            userId: user_id,
            endpoint: '/api/v1/analyze',
            question,
            requestPayload: adjustedPayload,
            responsePayload: finalResult,
            statusCode: response.status,
            durationMs: Date.now() - startedAt,
            success: true
        });

        res.json(finalResult);

    } catch (error) {
        console.error('❌ [ANALYZE] Analysis Proxy Error:', error.response?.data || error.message);

        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External analysis service failed' };

        await logAnalysisApiCall({
            organizationId: organization_id,
            userId: user_id,
            endpoint: '/api/v1/analyze',
            question,
            requestPayload: req.body,
            errorPayload: errorData,
            statusCode,
            durationMs: Date.now() - startedAt,
            success: false
        });

        res.status(statusCode).json({
            success: false,
            message: 'External Analysis API Error',
            details: errorData
        });
    }
});

/**
 * POST /api/v1/suggest-queries
 * Proxies the request to the external AI service to get query suggestions
 */
router.post('/suggest-queries', authenticateToken, async (req, res) => {
    if (!areSuggestionsEnabled()) {
        return res.json(getDisabledSuggestionsResponse());
    }

    const { original_question, num_suggestions = 3, locale = 'en' } = req.body;
    const { organization_id, role } = req.user;

    console.log('📨 [SUGGEST] Received request for question:', original_question);

    if (!original_question) {
        return res.status(400).json({ success: false, error: 'Original question is required' });
    }

    try {
        // 1. Fetch active source (Respecting pinned preference)
        const { conn, isFileSource } = await getActiveSourceConfig(organization_id);
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No active source found.' });
        }

        const schemaContext = await buildSemanticContext(conn, req.user);

        // 3. Construct Payload for External API (Special case for suggest-queries)
        const basePayload = await buildExternalPayload({
            conn,
            isFileSource,
            organization_id,
            question: original_question,
            max_rows: 100,
            role,
            locale,
            schemaContext
        });

        const externalPayload = {
            ...basePayload,
            original_question: original_question,
            num_suggestions: num_suggestions,
            context: req.body.context || {}
        };
        delete externalPayload.question;
        delete externalPayload.response_format;
        delete externalPayload.max_rows;
        delete externalPayload.include_insights;
        delete externalPayload.include_visualizations;

        console.log('🎯 [SUGGEST] Forwarding suggest-queries request to External API...');
        console.dir(redactPayloadForLog(externalPayload), { depth: null, maxArrayLength: null });

        // 4. Call External Digital Ocean API for suggestions
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/suggest-queries`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        const response = await axios.post(EXTERNAL_API_URL, externalPayload, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30s timeout for suggestions
        });

        // 5. Return the result from the external API to our frontend
        res.json(response.data);

    } catch (error) {
        console.error('❌ [SUGGEST] Suggest Queries Proxy Error:', error.response?.data || error.message);

        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External suggestion service failed' };

        res.status(statusCode).json({
            success: false,
            message: 'External Suggestion API Error',
            details: errorData
        });
    }
});


// ----------------------------------------------------------
// Async analysis helpers (analyze-async, task result, webhook)
// ----------------------------------------------------------

/**
 * Open an SSE stream for a chat conversation.  Clients may include an
 * auth token as a query parameter since the EventSource API doesn’t
 * support custom headers.
 */

// Apply authentication, then establish SSE connection
router.get('/stream/:conversationId', authenticateTokenForSSE, (req, res) => {
    const { conversationId } = req.params;
    const user = req.user;

    console.log(`\n✅ SSE Client connected: user=${user.email}, conversation=${conversationId}`);

    // Set up SSE headers to establish persistent connection
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'  // Disable nginx buffering if behind proxy
    });

    // Send initial comment to keep connection alive
    res.write(': SSE connection established\n\n');

    // Initialize SSE clients for this conversation if needed
    if (!sseClients[conversationId]) {
        sseClients[conversationId] = [];
    }

    // Add this client to the list
    sseClients[conversationId].push(res);
    console.log(`📊 SSE clients for ${conversationId}: ${sseClients[conversationId].length}`);

    // Handle client disconnect
    req.on('close', () => {
        sseClients[conversationId] = sseClients[conversationId].filter(client => client !== res);
        console.log(`❌ SSE Client disconnected: conversation=${conversationId}, remaining=${sseClients[conversationId].length}`);
    });

    req.on('error', (err) => {
        console.error(`⚠️  SSE Error for ${conversationId}:`, err.message);
        sseClients[conversationId] = sseClients[conversationId].filter(client => client !== res);
    });
});

/**
 * Webhook endpoint that the external async service will call when a task
 * updates. We simply broadcast the payload to any SSE subscribers and also
 * optionally persist a brief chat message for history.
 */
router.post('/webhook', async (req, res) => {
    const update = req.body;
    // conversation_id may be provided in body or query param
    const convId = update.conversation_id || req.query.conversation_id;
    const normalizedUpdate = normalizeTaskUpdatePayload(
        update,
        update.task_id || update.data?.task_id,
        convId || update.conversation_id
    );

    console.log('🔔 [WEBHOOK] Received update for conversation', convId, update);
    const normalizedStatus = String(normalizedUpdate.status || '').toUpperCase();
    if (
        normalizedUpdate.task_id &&
        (normalizedStatus === 'COMPLETED' || normalizedStatus === 'FAILED') &&
        taskPollers.has(normalizedUpdate.task_id)
    ) {
        clearInterval(taskPollers.get(normalizedUpdate.task_id));
        taskPollers.delete(normalizedUpdate.task_id);
    }
    const finalUpdate = normalizeResponse(normalizedUpdate);
    writeAsyncDebugLog('WEBHOOK_PAYLOAD', finalUpdate);
    await updateAnalysisApiLogByTaskId({
        taskId: finalUpdate.task_id || finalUpdate.result?.request_id || finalUpdate.details?.result?.request_id,
        responsePayload: finalUpdate,
        errorPayload: normalizedStatus === 'FAILED' ? finalUpdate : null,
        success: normalizedStatus === 'COMPLETED',
        conversationId: convId || null
    });
    // broadcast event
    if (convId) {
        sendSse(convId, 'task_update', finalUpdate);
        // persist small status message if provided
        try {
            if (normalizedUpdate.message) {
                await db.query(
                    `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
                    [convId, 'assistant', `[${normalizedUpdate.status}] ${normalizedUpdate.message}`]
                );
            }
        } catch (e) {
            console.error('❌ Failed to store webhook message', e.message);
        }
    }
    res.json({ received: true });
});

/**
 * POST /api/v1/analyze-async
 * forwards to external API, returns the task id to caller.
 */
router.post('/analyze-async', authenticateToken, checkCredits, async (req, res) => {
    const { question, max_rows = 25, locale = 'en', include_insights = true, include_visualizations = true } = req.body;
    const { organization_id, role, id: user_id } = req.user;
    const startedAt = Date.now();

    // conversation_id will be carried via webhook URL query parameter
    const conversation_id = req.query.conversation_id;

    console.log('📨 [ASYNC ANALYZE] Received request for question:', question, 'conversation:', conversation_id);

    if (!question) {
        return res.status(400).json({ success: false, error: 'Question is required' });
    }
    if (!conversation_id) {
        return res.status(400).json({ success: false, error: 'conversation_id query parameter is required for webhook updates' });
    }

    try {
        // 1. Fetch active source (Respecting pinned preference)
        const { conn, isFileSource } = await getActiveSourceConfig(organization_id);
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No active source found.' });
        }

        const schemaContext = await buildSemanticContext(conn, req.user);

        const externalPayload = await buildExternalPayload({
            conn,
            isFileSource,
            organization_id,
            question,
            max_rows,
            role,
            locale,
            include_insights,
            include_visualizations,
            schemaContext
        });

        const adjustedPayload = adjustPayload(externalPayload);

        // build webhook URL with conversation_id query param
        const webhookUrl = `${req.protocol}://${req.get('host')}/api/v1/webhook?conversation_id=${encodeURIComponent(conversation_id)}`;

        console.log('🔍 [ASYNC ANALYZE] Forwarding request to External Analysis API...', 'webhookUrl=', webhookUrl);
        console.dir(redactPayloadForLog(adjustedPayload), { depth: null, maxArrayLength: null });
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/analyze-async`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY;

        console.log(API_KEY, 'api key')
        console.log(EXTERNAL_API_URL, 'EXTRERNAL API')

        const fs = require('fs');
        const path = require('path');
        const debugFilePath = path.join(__dirname, '../../analyze_async_debug.txt');
        try {
            fs.appendFileSync(
                debugFilePath,
                JSON.stringify(adjustedPayload, null, 2) + '\n--------------------------------------------\n',
                'utf8'
            );
        } catch (logErr) {
            console.error('Failed to log request payload to analyze_async_debug.txt:', logErr.message);
        }

        const response = await axios.post(`${EXTERNAL_API_URL}?webhook_url=${encodeURIComponent(webhookUrl)}`, adjustedPayload, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'x-api-key': API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        console.log(response, 'external api response')
        logExternalApiResponse('📥 [ASYNC ANALYZE] External Analysis API response:', response.data);

        try {
            fs.appendFileSync(
                debugFilePath,
                JSON.stringify(response.data, null, 2) + '\n\n',
                'utf8'
            );
        } catch (logErr) {
            console.error('Failed to log response to analyze_async_debug.txt:', logErr.message);
        }

        writeAsyncDebugLog('ANALYZE_ASYNC_SUBMIT_RESPONSE', response.data);

        await logAnalysisApiCall({
            organizationId: organization_id,
            userId: user_id,
            conversationId: conversation_id,
            endpoint: '/api/v1/analyze-async',
            question,
            requestPayload: adjustedPayload,
            responsePayload: response.data,
            statusCode: response.status,
            durationMs: Date.now() - startedAt,
            success: true
        });

        console.log('✅ [ASYNC ANALYZE] Received task creation response');

        // Deduct credits after successful task creation
        try {
            await creditService.deductCredits(organization_id, 1, {
                reference_type: 'query',
                reference_id: `async_${response.data.task_id || response.data.id}`,
                query_type: 'async_analysis',
                question: question,
                conversation_id: conversation_id
            });
            console.log('✅ Credits deducted for async analysis task');
        } catch (creditError) {
            console.error('⚠️ Failed to deduct credits:', creditError.message);
            // Don't fail the request if credit deduction fails, just log it
        }

        res.json(response.data);

        // kick off background polling in case webhook never arrives (e.g. local dev)
        const returnedTaskId = response.data.task_id || response.data.id;
        if (returnedTaskId && conversation_id) {
            pollTaskStatus(returnedTaskId, conversation_id);
        }
    } catch (error) {
        console.log(error.response, 'error')
        console.log(error.message, 'error message')
        console.error(' [ASYNC ANALYZE] Proxy Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External analysis service failed' };

        try {
            const fs = require('fs');
            const path = require('path');
            const debugFilePath = path.join(__dirname, '../../analyze_async_debug.txt');
            fs.appendFileSync(
                debugFilePath,
                JSON.stringify(errorData, null, 2) + '\n\n',
                'utf8'
            );
        } catch (logErr) {
            console.error('Failed to log error response to analyze_async_debug.txt:', logErr.message);
        }

        await logAnalysisApiCall({
            organizationId: organization_id,
            userId: user_id,
            conversationId: conversation_id,
            endpoint: '/api/v1/analyze-async',
            question,
            requestPayload: req.body,
            errorPayload: errorData,
            statusCode,
            durationMs: Date.now() - startedAt,
            success: false
        });

        res.status(statusCode).json({
            success: false,
            message: 'External Async Analysis API Error',
            details: errorData
        });
    }
});

/**
 * POST /api/v1/export-async
 * Proxies export request to external API with webhook updates.
 */
router.post('/export-async', authenticateToken, checkCredits, async (req, res) => {
    const { sql_query, export_format = 'csv', filename, compress = false } = req.body;
    const { organization_id, role } = req.user;
    const conversation_id = req.query.conversation_id;

    if (!sql_query) {
        return res.status(400).json({ success: false, error: 'sql_query is required' });
    }
    if (!conversation_id) {
        return res.status(400).json({ success: false, error: 'conversation_id query parameter is required for webhook updates' });
    }

    try {
        const connectionResult = await db.query(
            'SELECT * FROM database_connections WHERE organization_id = $1 AND status = $2 LIMIT 1',
            [organization_id, 'connected']
        );



        let conn = null;
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
        }

        const schemaResult = await db.query(
            `SELECT st.table_name, st.is_enabled as table_enabled, sc.column_name, sc.is_enabled as column_enabled
             FROM semantic_tables st
             JOIN semantic_columns sc ON st.id = sc.semantic_table_id
             WHERE st.connection_id = $1 OR st.file_source_id = $1`,
            [conn.id]
        );

        const schemaInfo = {};
        schemaResult.rows.forEach(row => {
            const tbl = row.table_name;
            const col = row.column_name;
            if (!schemaInfo[tbl]) schemaInfo[tbl] = [];
            schemaInfo[tbl].push(col);
        });

        const webhookUrl = `${req.protocol}://${req.get('host')}/api/v1/export-webhook?conversation_id=${encodeURIComponent(conversation_id)}`;

        const externalPayload = {
            db_config: {
                type: conn.db_type === 'postgresql' ? 'postgres' : conn.db_type,
                connection_string: constructConnectionString(conn),
                host: conn.host,
                port: parseInt(conn.port),
                database: conn.database_name,
                username: conn.username,
                password: conn.password,
                // schema_info: schemaInfo
            },
            sql_query,
            export_format,
            filename: filename || `export_${Date.now()}.csv`,
            compress,
            max_rows: 100000,
            webhook_url: webhookUrl
        };

        console.log('[EXPORT ASYNC] Payload to external API:', {
            ...externalPayload,
            db_config: {
                ...externalPayload.db_config,
                password: externalPayload.db_config?.password ? '***' : undefined
            }
        });

        const EXTERNAL_API_URL = `${getAiBaseUrl()}/export`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        const response = await axios.post(EXTERNAL_API_URL, externalPayload, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        // Deduct credits after successful task creation
        try {
            await creditService.deductCredits(organization_id, 1, {
                reference_type: 'query',
                reference_id: `export_${response.data.task_id || response.data.id}`,
                query_type: 'export',
                question: sql_query,
                conversation_id
            });
        } catch (creditError) {
            console.error('Failed to deduct credits for export:', creditError.message);
        }

        res.json(response.data);
    } catch (error) {
        console.error('[EXPORT ASYNC] Proxy Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External export service failed' };
        res.status(statusCode).json({
            success: false,
            message: 'External Export API Error',
            details: errorData
        });
    }
});

/**
 * Webhook endpoint for export task updates.
 */
router.post('/export-webhook', async (req, res) => {
    const update = req.body;
    const convId = update.conversation_id || req.query.conversation_id;

    if (convId) {
        sendSse(convId, 'export_update', { ...update, task_type: 'export' });
    }
    res.json({ received: true });
});

/**
 * GET /api/v1/export/:exportId/status
 * Proxy export status endpoint
 */
router.get('/export/:exportId/status', authenticateToken, async (req, res) => {
    const { exportId } = req.params;
    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/export/${exportId}/status`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
        const response = await axios.get(EXTERNAL_API_URL, {
            headers: {
                accept: 'application/json',
                Authorization: `Bearer ${API_KEY}`,
                'x-api-key': API_KEY
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('[EXPORT STATUS] Proxy Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'Failed to fetch export status' };
        res.status(statusCode).json({
            success: false,
            message: 'Export Status Fetch Error',
            details: errorData
        });
    }
});

/**
 * GET /api/v1/export/:exportId/download
 * Proxy export download endpoint (streams file)
 */
router.get('/export/:exportId/download', authenticateToken, async (req, res) => {
    const { exportId } = req.params;
    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/export/${exportId}/download`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
        const response = await axios.get(EXTERNAL_API_URL, {
            headers: {
                accept: 'application/octet-stream',
                Authorization: `Bearer ${API_KEY}`,
                'x-api-key': API_KEY
            },
            responseType: 'stream'
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        if (response.headers['content-disposition']) {
            res.setHeader('Content-Disposition', response.headers['content-disposition']);
        }
        response.data.pipe(res);
    } catch (error) {
        console.error('[EXPORT DOWNLOAD] Proxy Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'Failed to download export' };
        res.status(statusCode).json({
            success: false,
            message: 'Export Download Error',
            details: errorData
        });
    }
});

/**
 * GET /api/v1/task/:taskId/result
 * Proxy to external task result endpoint
 */
router.get('/task/:taskId/status', authenticateToken, async (req, res) => {
    const { taskId } = req.params;
    console.log('📨 [TASK STATUS] Fetching status for', taskId);

    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/task/${taskId}/status`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        const response = await axios.get(EXTERNAL_API_URL, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'x-api-key': API_KEY
            }
        });

        logExternalApiResponse(`📥 [TASK STATUS] External API response for ${taskId}:`, response.data);
        res.json(normalizeResponse(response.data));
    } catch (error) {
        console.error(' [TASK STATUS] Proxy Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'Failed to fetch task status' };
        res.status(statusCode).json({
            success: false,
            message: 'Task Status Fetch Error',
            details: errorData
        });
    }
});

router.get('/task/:taskId/result', authenticateToken, async (req, res) => {
    const { taskId } = req.params;
    console.log('📨 [TASK RESULT] Fetching result for', taskId);

    try {
        await delay(1);
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/task/${taskId}/result`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
        //                    'x-api-key': API_KEY

        const response = await axios.get(EXTERNAL_API_URL, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'x-api-key': API_KEY
            }
        });

        logExternalApiResponse(`📥 [TASK RESULT] External API response for ${taskId}:`, response.data);
        res.json(normalizeResponse(response.data));
    } catch (error) {
        console.error('[TASK RESULT] Proxy Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'Failed to fetch task result' };
        res.status(statusCode).json({
            success: false,
            message: 'Task Result Fetch Error',
            details: errorData
        });
    }
});


// background poller to keep frontends informed when webhook may not reach us
async function pollTaskStatus(taskId, conversationId) {
    console.log('🔁 Starting poll for task', taskId);
    const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
    const statusUrl = `${getAiBaseUrl()}/task/${taskId}/status`;
    console.log(statusUrl, 'statusUrl')
    if (taskPollers.has(taskId)) {
        clearInterval(taskPollers.get(taskId));
        taskPollers.delete(taskId);
    }
    const interval = setInterval(async () => {
        try {
            //                    'x-api-key': API_KEY
            const resp = await axios.get(statusUrl, {
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${API_KEY}`,
                    'x-api-key': API_KEY
                }
            });
            const data = resp.data;
            console.log('🔁 poll response', data);
            // some versions wrap under { success,data: {...} }
            const status = data.status ?? data.data?.status;
            const normalizedStatus = String(status || '').toUpperCase();
            console.log('🔁 poll status', status);
            const taskUpdate = normalizeResponse(normalizeTaskUpdatePayload(data, taskId, conversationId));
            writeAsyncDebugLog('POLL_TASK_UPDATE', taskUpdate);
            await updateAnalysisApiLogByTaskId({
                taskId,
                responsePayload: taskUpdate,
                errorPayload: normalizedStatus === 'FAILED' ? taskUpdate : null,
                success: normalizedStatus === 'COMPLETED',
                conversationId
            });
            // broadcast update via SSE, send entire response so frontend can inspect
            sendSse(
                conversationId,
                'task_update',
                taskUpdate
            );
            if (normalizedStatus === 'COMPLETED' || normalizedStatus === 'FAILED') {
                clearInterval(interval);
                taskPollers.delete(taskId);
                // frontend will fetch final result when it sees completed via SSE
            }
        } catch (e) {
            console.error('🔁 poll error', e.message);
        }
    }, 5000);
    taskPollers.set(taskId, interval);
}



module.exports = router;


