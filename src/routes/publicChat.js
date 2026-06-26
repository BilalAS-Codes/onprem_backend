const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const creditService = require('../services/creditService');
const { getAiBaseUrl, adjustPayload, areSuggestionsEnabled, normalizeResponse } = require('../helpers/aiHelper');

// --- HELPER FUNCTIONS (Synced from analysis.js) ---

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

    const userDeptId = userContext.department_id ? String(userContext.department_id).trim() : '';
    const userDeptIds = Array.isArray(userContext.department_ids) ? userContext.department_ids.map(id => String(id).trim()) : [];

    // Check if ANY of the user's departments are in the allowed list
    if (userDeptId && departmentIds.includes(userDeptId)) return true;
    if (userDeptIds.some(id => departmentIds.includes(id))) return true;

    return false;
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
            const hasDepartmentAccess = canAccessColumnByDepartment(row, userContext);

            if (row.column_enabled && hasDepartmentAccess) {
                if (!schemaInfo[tbl]) schemaInfo[tbl] = [];
                schemaInfo[tbl].push(formatSchemaInfoEntry(col, dataType, Array.isArray(row.enum_values) ? row.enum_values : []));
                if (!allowedTables.includes(tbl)) allowedTables.push(tbl);
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
        const relQuery = isMultiFile
            ? `SELECT sr.source_table, sr.source_column, sr.target_table, sr.target_column, fs.filename as file_source_name FROM semantic_relationships sr JOIN file_sources fs ON sr.file_source_id = fs.id WHERE fs.organization_id = $1 AND fs.status = 'active'`
            : `SELECT source_table, source_column, target_table, target_column FROM semantic_relationships WHERE connection_id = $1`;
        const relResult = await db.query(relQuery, [isMultiFile ? conn.organization_id : conn.id]);
        relResult.rows.forEach(r => {
            relationships.push({ from_field: `${r.source_table}.${r.source_column}`, to_field: `${r.target_table}.${r.target_column}` });
        });
    } catch (e) { }

    return { schemaInfo, allowedTables, disallowedTables, allowedColumns, restrictedColumns, relationships };
}

// --- GREETING DETECTION ---

/**
 * Returns true if the user's message is a greeting and not a real query.
 * Strips punctuation and checks against a list of common greetings.
 */
function isGreeting(text) {
    const cleaned = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // strip punctuation
        .replace(/\s+/g, ' ');

    const GREETINGS = [
        'hi', 'hello', 'hey', 'hii', 'hiii', 'hola',
        'hi there', 'hello there', 'hey there',
        'good morning', 'good afternoon', 'good evening', 'good night',
        'greetings', 'howdy', 'whats up', 'what up', 'sup',
        'yo', 'hi bot', 'hello bot', 'hey bot',
        'start', 'begin', 'help'
    ];

    return GREETINGS.includes(cleaned);
}

// --- PUBLIC CHAT ROUTE ---

/**
 * GET /api/public/config/:api_key
 * Fetch chatbot configuration (color, name, etc.)
 */
router.get('/config/:api_key', async (req, res) => {
    try {
        const result = await db.query('SELECT config FROM integrations WHERE api_key = $1 AND is_enabled = true', [req.params.api_key]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Config not found' });
        }
        res.json(result.rows[0].config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/chat', async (req, res) => {
    const { api_key, question } = req.body;
    const origin = req.headers.origin;
    const startedAt = Date.now();

    if (!api_key || !question) {
        return res.status(400).json({ error: 'api_key and question are required' });
    }

    try {
        // 1. Validate API Key & Integration
        const intResult = await db.query(
            `SELECT i.*, r.name as role_name 
             FROM integrations i 
             LEFT JOIN roles r ON i.target_role_id = r.id
             WHERE i.api_key = $1 AND i.is_enabled = true`, 
            [api_key]
        );
        if (intResult.rows.length === 0) {
            return res.status(404).json({ error: 'Invalid or disabled API key' });
        }
        const integration = intResult.rows[0];
        
        // Use target_organization_id if set, fallback to owner organization
        const orgId = integration.target_organization_id || integration.organization_id;
        
        // Construct user context for buildSemanticContext
        const userContext = {
            role: integration.role_name || 'Admin',
            department_id: integration.target_department_id,
            department_ids: Array.isArray(integration.target_department_ids) ? integration.target_department_ids : (integration.target_department_id ? [integration.target_department_id] : [])
        };
        
        // Store for logging in catch block
        req._integrationId = integration.id;
        req._orgId = orgId;

        // 1. Domain Security Check
        if (integration.allowed_domains && integration.allowed_domains.length > 0) {
            const allowed = integration.allowed_domains.some(domain => {
                if (!origin) return false;
                return origin.includes(domain.trim());
            });
            if (!allowed) {
                console.warn(`🛡️ [PUBLIC CHAT] Blocked request from unauthorized origin: ${origin}`);
                return res.status(403).json({ error: 'Domain not authorized' });
            }
        }

        // 2. Credit Check
        const creditCheck = await creditService.hasCredits(orgId, 1);
        if (!creditCheck.allowed) {
            return res.status(403).json({ error: 'Organization has insufficient credits' });
        }

        const { conn, isFileSource } = await getActiveSourceConfig(orgId);
        if (!conn) return res.status(404).json({ error: 'No active source' });

        const ctx = await buildSemanticContext(conn, userContext);

        const access_policy = {
            role: userContext.role.toLowerCase(),
            allowed_tables: ctx.allowedTables,
            disallowed_tables: ctx.disallowedTables,
            allowed_columns: ctx.allowedColumns,
            restricted_columns: ctx.restrictedColumns || {},
            row_level_filters: {},
            max_rows: 1000,
            query_timeout_seconds: 30
        };

        const payload = {
            question: question,
            max_rows: 100,
            include_insights: true,
            include_visualizations: true,
            access_policy,
            locale: 'en',
            strict_joins: true
        };
       
        const adjustedPayload = adjustPayload(payload);

        // 3. TARGET THE ASYNC ENDPOINT

        const API_KEY = (process.env.EXTERNAL_AI_API_KEY || '').replace(/"/g, '').trim();

        // --- GREETING SHORTCUT ---
        // If the user sent a greeting, skip the expensive AI analysis.
        // Call the suggest API to get schema-aware query suggestions and return immediately.
        if (isGreeting(question)) {
            console.log(`👋 [PUBLIC CHAT] Greeting detected: "${question}". Fetching suggestions...`);

            // Greetings are always FREE — no credit deducted regardless of suggest API outcome
            let suggested_queries = [];

            try {
                const SUGGEST_API_URL = 'https://zeroqueries-9b4b6.ondigitalocean.app/api/v1/suggest-queries';
                const suggestPayload = {
                    ...payload,
                    original_question: 'What can I ask?',
                    num_suggestions: 3
                };
                delete suggestPayload.question;
                delete suggestPayload.response_format;
                delete suggestPayload.max_rows;
                delete suggestPayload.include_insights;
                delete suggestPayload.include_visualizations;

                const suggestResponse = await axios.post(SUGGEST_API_URL, suggestPayload, {
                    headers: { 'Authorization': `Bearer ${API_KEY}` },
                    timeout: 10000
                });

                const respData = suggestResponse.data.data || suggestResponse.data;
                const rawSuggestions = respData.suggestions || respData.suggested_queries || respData.suggested_questions || [];

                if (Array.isArray(rawSuggestions)) {
                    suggested_queries = rawSuggestions.map(s => {
                        if (typeof s === 'string') return s;
                        if (typeof s === 'object') return s.question || s.text || s.query || '';
                        return '';
                    }).filter(s => s.length > 0);
                }

                console.log(`💡 [PUBLIC CHAT] Greeting: fetched ${suggested_queries.length} schema-aware suggestions (no credit deducted)`);

            } catch (suggestErr) {
                // Suggest API failed — use generic fallback (still no credit deducted)
                console.warn('⚠️ [PUBLIC CHAT] Greeting suggest API failed, using free fallback:', suggestErr.message);
                suggested_queries = [
                    'Show me the top 5 records',
                    'What is the total count of entries?',
                    'Summarize the latest data for me'
                ];
            }

            const greetingResult = {
                execution_metadata: {
                    ai_summary: `👋 Hello! I'm your data assistant. Here are some questions you can ask me about your data:`
                },
                suggested_queries,
                suggested_questions: suggested_queries
            };

            // Log the integration activity
            await db.query(
                `INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, response_payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [integration.id, orgId, '/api/public/chat', 'greeting', Date.now() - startedAt,
                 JSON.stringify({ question }), JSON.stringify(greetingResult)]
            );

            // Sync to dashboard history
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                try {
                    const jwt = require('jsonwebtoken');
                    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
                    const userId = decoded.id;
                    let convResult = await db.query(
                        'SELECT id FROM chat_conversations WHERE user_id = $1 AND title = $2 LIMIT 1',
                        [userId, 'Public Chatbot']
                    );
                    let conversationId;
                    if (convResult.rows.length === 0) {
                        const newConv = await db.query(
                            'INSERT INTO chat_conversations (organization_id, user_id, title) VALUES ($1, $2, $3) RETURNING id',
                            [orgId, userId, 'Public Chatbot']
                        );
                        conversationId = newConv.rows[0].id;
                    } else {
                        conversationId = convResult.rows[0].id;
                    }
                    await db.query('INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)', [conversationId, 'user', question]);
                    await db.query('INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)', [conversationId, 'assistant', greetingResult.execution_metadata.ai_summary]);
                    await db.query('UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP WHERE id = $1', [conversationId]);
                } catch (authErr) {
                    console.warn('⚠️ [PUBLIC CHAT] Greeting dashboard sync failed:', authErr.message);
                }
            }

            return res.json(greetingResult);
        }
        // --- END GREETING SHORTCUT ---

        // 3. CALL THE NEW AI MODEL /query ENDPOINT
        const QUERY_API_URL = `${getAiBaseUrl()}/query`;

        console.log(`🚀 [PUBLIC CHAT] Sending request to: ${QUERY_API_URL}`);
        console.log('📦 [PUBLIC CHAT] Payload:', JSON.stringify(adjustedPayload, null, 2));

        const queryResponse = await axios.post(QUERY_API_URL, adjustedPayload, {
            headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });

        const result = normalizeResponse(queryResponse.data);

        // 4. Finalize and Log
        await creditService.deductCredits(orgId, 1, { reference_type: 'public_chatbot', integration_id: integration.id });
        await db.query(`INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, response_payload) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [integration.id, orgId, '/api/public/chat', 'success', Date.now() - startedAt, JSON.stringify({ question }), JSON.stringify(result)]);

        // 6. DASHBOARD SYNC (If user is logged in)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
                const userId = decoded.id;

                // Find or Create "Public Chatbot" Conversation
                let convResult = await db.query(
                    'SELECT id FROM chat_conversations WHERE user_id = $1 AND title = $2 LIMIT 1',
                    [userId, 'Public Chatbot']
                );

                let conversationId;
                if (convResult.rows.length === 0) {
                    const newConv = await db.query(
                        'INSERT INTO chat_conversations (organization_id, user_id, title) VALUES ($1, $2, $3) RETURNING id',
                        [orgId, userId, 'Public Chatbot']
                    );
                    conversationId = newConv.rows[0].id;
                } else {
                    conversationId = convResult.rows[0].id;
                }

                // Save User Message
                await db.query(
                    'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                    [conversationId, 'user', question]
                );

                // Save Bot Response
                await db.query(
                    'INSERT INTO chat_messages (conversation_id, role, content, analysis_data) VALUES ($1, $2, $3, $4)',
                    [conversationId, 'assistant', result.execution_metadata?.ai_summary || result.answer || 'Response generated', JSON.stringify(result)]
                );

                // Update Conversation Timestamp
                await db.query(
                    'UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP WHERE id = $1',
                    [conversationId]
                );

                console.log(`✅ [PUBLIC CHAT] Synced with Dashboard Conversation: ${conversationId}`);
            } catch (authErr) {
                console.error('⚠️ [PUBLIC CHAT] Failed to sync with dashboard:', authErr.message);
            }
        } else {
            // 7. ANONYMOUS HISTORY SYNC (Save to Admin's "Public Inquiries" conversation)
            try {
                // Find organization owner (Primary Admin)
                const ownerResult = await db.query(
                    'SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.organization_id = $1 AND r.name = \'Admin\' ORDER BY u.created_at ASC LIMIT 1',
                    [orgId]
                );

                if (ownerResult.rows.length > 0) {
                    const adminUserId = ownerResult.rows[0].id;
                    const title = 'Public Inquiries';

                    // Find or Create "Public Inquiries" Conversation for Admin
                    let convResult = await db.query(
                        'SELECT id FROM chat_conversations WHERE user_id = $1 AND title = $2 LIMIT 1',
                        [adminUserId, title]
                    );

                    let conversationId;
                    if (convResult.rows.length === 0) {
                        const newConv = await db.query(
                            'INSERT INTO chat_conversations (organization_id, user_id, title) VALUES ($1, $2, $3) RETURNING id',
                            [orgId, adminUserId, title]
                        );
                        conversationId = newConv.rows[0].id;
                    } else {
                        conversationId = convResult.rows[0].id;
                    }

                    // Save User Message
                    await db.query(
                        'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                        [conversationId, 'user', question]
                    );

                    // Save Bot Response
                    await db.query(
                        'INSERT INTO chat_messages (conversation_id, role, content, analysis_data) VALUES ($1, $2, $3, $4)',
                        [conversationId, 'assistant', result.execution_metadata?.ai_summary || result.answer || 'Response generated', JSON.stringify(result)]
                    );

                    // Update Conversation Timestamp
                    await db.query(
                        'UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP WHERE id = $1',
                        [conversationId]
                    );

                    console.log(`✅ [PUBLIC CHAT] Synced anonymous query to Admin's "Public Inquiries"`);
                }
            } catch (syncErr) {
                console.error('⚠️ [PUBLIC CHAT] Anonymous sync failed:', syncErr.message);
            }
        }

        res.json(result);

    } catch (err) {
        const errorMsg = err.response?.data || err.message;
        console.error('❌ [PUBLIC CHAT] AI Error:', errorMsg);

        // NEW: Sync the Error to Dashboard History so Admin/User knows it failed
        if (req._orgId) {
            try {
                const orgId = req._orgId;
                const authHeader = req.headers.authorization;
                let userId = null;

                if (authHeader && authHeader.startsWith('Bearer ')) {
                    const token = authHeader.split(' ')[1];
                    const jwt = require('jsonwebtoken');
                    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
                    userId = decoded.id;
                }

                let targetUserId = userId;
                let title = 'Public Chatbot';

                if (!targetUserId) {
                    // Fallback to Admin for anonymous error tracking
                    const adminRes = await db.query(
                        'SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.organization_id = $1 AND r.name = \'Admin\' ORDER BY u.created_at ASC LIMIT 1',
                        [orgId]
                    );
                    if (adminRes.rows.length > 0) {
                        targetUserId = adminRes.rows[0].id;
                        title = 'Public Inquiries';
                    }
                }

                if (targetUserId) {
                    // Find or Create Conversation
                    let convResult = await db.query(
                        'SELECT id FROM chat_conversations WHERE user_id = $1 AND title = $2 LIMIT 1',
                        [targetUserId, title]
                    );

                    let conversationId;
                    if (convResult.rows.length === 0) {
                        const newConv = await db.query(
                            'INSERT INTO chat_conversations (organization_id, user_id, title) VALUES ($1, $2, $3) RETURNING id',
                            [orgId, targetUserId, title]
                        );
                        conversationId = newConv.rows[0].id;
                    } else {
                        conversationId = convResult.rows[0].id;
                    }

                    // Save User Question
                    await db.query(
                        'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                        [conversationId, 'user', question]
                    );

                    // Save Bot Error
                    const friendlyError = 'I encountered an issue processing your request. Please try again in a moment or rephrase your question.';
                    await db.query(
                        'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                        [conversationId, 'assistant', `⚠️ Error: ${friendlyError}`]
                    );
                }
            } catch (syncErr) {
                console.error('⚠️ [PUBLIC CHAT] Error sync failed:', syncErr.message);
            }
        }

        res.status(err.response?.status || 500).json({
            error: 'I encountered an issue processing your request. Please try again in a moment or rephrase your question.'
        });
    }
});

module.exports = router;

