const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('../config/database');
const creditService = require('../services/creditService');
const whatsappService = require('../services/whatsappService');

// --- HELPER FUNCTIONS FOR CONTEXT BUILDING (Synced from publicChat.js) ---

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
    } catch (e) {}

    return { schemaInfo, allowedTables, disallowedTables, allowedColumns, restrictedColumns, relationships };
}

// Generate an Excel sheet from tabular query results
function generateExcelReport(dataRows, columns, orgId) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(dataRows, { header: columns });
    XLSX.utils.book_append_sheet(wb, ws, "Query Results");
    
    const reportsDir = path.join(__dirname, '..', '..', 'public', 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const filename = `Report_${orgId}_${Date.now()}.xlsx`;
    const filepath = path.join(reportsDir, filename);
    XLSX.writeFile(wb, filepath);
    
    return filename;
}

// --- WEBHOOK ENDPOINTS ---

/**
 * GET /api/public/whatsapp/webhook
 * Handles Meta/Facebook app verification handshake
 */
router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode && token) {
        const verifyToken = process.env.META_VERIFY_TOKEN || 'zeroqueries_meta_token';
        if (mode === 'subscribe' && token === verifyToken) {
            console.log('✅ Meta Webhook successfully verified.');
            return res.status(200).send(challenge);
        }
    }
    
    // Twilio Webhook setup verification or simple fallback
    return res.status(200).json({ status: 'active', message: 'ZeroQueries WhatsApp Webhook is ready.' });
});

/**
 * POST /api/public/whatsapp/webhook
 * Processes incoming WhatsApp text queries from Twilio or Meta and queries the AI engine
 */
router.post('/webhook', express.urlencoded({ extended: true }), async (req, res) => {
    const startedAt = Date.now();
    let senderPhone = '';
    let receiverPhone = '';
    let question = '';
    let provider = '';
    let metaPhoneId = '';

    // 1. Detect and parse the provider
    if (req.body.From && req.body.To && req.body.Body) {
        // Twilio payload structure
        provider = 'twilio';
        senderPhone = req.body.From.replace('whatsapp:', '').trim();
        receiverPhone = req.body.To.replace('whatsapp:', '').trim();
        question = req.body.Body.trim();
    } else if (req.body.object === 'whatsapp_business_account') {
        // Meta Cloud API payload structure
        provider = 'meta';
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const message = value?.messages?.[0];

        // Meta triggers callbacks for status read, delivery, etc. We only process messages containing text.
        if (!message || message.type !== 'text') {
            return res.sendStatus(200);
        }

        senderPhone = `+${message.from}`;
        metaPhoneId = value.metadata?.phone_number_id || '';
        receiverPhone = value.metadata?.display_phone_number || '';
        question = message.text?.body?.trim();
    } else {
        // Unknown payload/status update, ignore but acknowledge
        return res.sendStatus(200);
    }

    // Acknowledge Meta/Twilio immediately to prevent timeouts and retries
    if (provider === 'twilio') {
        res.type('text/xml').send('<Response></Response>');
    } else {
        res.sendStatus(200);
    }

    // 2. Asynchronous background query processing
    (async () => {
        let conversationId = null;
        let integration = null;
        let config = null;
        
        try {
            console.log(`📥 [WHATSAPP WEBHOOK] Received message from ${senderPhone} (Receiver: ${receiverPhone}, Provider: ${provider})`);

            // Fetch WhatsApp integration configurations from database
            const intResult = await db.query(
                `SELECT i.*, r.name as role_name 
                 FROM integrations i 
                 LEFT JOIN roles r ON i.target_role_id = r.id
                 WHERE i.integration_type = 'whatsapp_bot' AND i.is_enabled = true`
            );

            // Find integration by clean phone number or Meta ID match
            integration = intResult.rows.find(row => {
                const config = row.config || {};
                const cleanConfigPhone = String(config.phone_number || '').replace(/[^0-9]/g, '');
                const cleanReceiverPhone = receiverPhone.replace(/[^0-9]/g, '');
                
                return (
                    cleanConfigPhone === cleanReceiverPhone ||
                    String(config.meta_phone_id) === String(metaPhoneId)
                );
            });

            if (!integration) {
                console.error(`❌ [WHATSAPP WEBHOOK] No active integration found matching phone ${receiverPhone} / phone_id ${metaPhoneId}`);
                return;
            }

            const orgId = integration.target_organization_id || integration.organization_id;
            config = integration.config || {};

            // Mapped role & department scopes
            const userContext = {
                role: integration.role_name || 'Admin',
                department_id: integration.target_department_id,
                department_ids: Array.isArray(integration.target_department_ids) 
                    ? integration.target_department_ids 
                    : (integration.target_department_id ? [integration.target_department_id] : [])
            };

            // 3. Resolve active WhatsApp session mapping
            const mappedRes = await db.query(
                'SELECT conversation_id FROM whatsapp_conversations WHERE integration_id = $1 AND sender_phone = $2 LIMIT 1',
                [integration.id, senderPhone]
            );

            if (mappedRes.rows.length > 0) {
                conversationId = mappedRes.rows[0].conversation_id;
            } else {
                // Fallback to finding Organization Admin user id to tie the conversation context
                const adminRes = await db.query(
                    `SELECT u.id FROM users u 
                     JOIN roles r ON u.role_id = r.id 
                     WHERE u.organization_id = $1 AND r.name = 'Admin' 
                     ORDER BY u.created_at ASC LIMIT 1`,
                    [orgId]
                );
                const targetUserId = adminRes.rows.length > 0 ? adminRes.rows[0].id : null;
                
                const newConv = await db.query(
                    'INSERT INTO chat_conversations (organization_id, user_id, title) VALUES ($1, $2, $3) RETURNING id',
                    [orgId, targetUserId, `WhatsApp: ${senderPhone}`]
                );
                conversationId = newConv.rows[0].id;
                
                await db.query(
                    'INSERT INTO whatsapp_conversations (integration_id, sender_phone, conversation_id) VALUES ($1, $2, $3)',
                    [integration.id, senderPhone, conversationId]
                );
            }

            // Save user incoming query to history
            await db.query(
                'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                [conversationId, 'user', question]
            );

            // 4. Verify Credit quota
            const creditCheck = await creditService.hasCredits(orgId, 1);
            if (!creditCheck.allowed) {
                const errorMsg = '⚠️ Your organization has insufficient analysis credits. Please contact your administrator.';
                await db.query(
                    'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                    [conversationId, 'assistant', errorMsg]
                );
                await whatsappService.sendText(senderPhone, errorMsg, config);
                return;
            }

            // 5. Query Active source database connection
            const { conn, isFileSource } = await getActiveSourceConfig(orgId);
            if (!conn) {
                const errorMsg = '⚠️ No active database connection or Excel source configured for this organization.';
                await whatsappService.sendText(senderPhone, errorMsg, config);
                return;
            }

            const ctx = await buildSemanticContext(conn, userContext);
            const payload = {
                db_config: isFileSource ? {
                    type: 'sheets',
                    aws_paths: (await db.query('SELECT s3_key FROM file_sources WHERE organization_id = $1 AND status = $2', [orgId, 'active'])).rows.map(f => `s3://${process.env.AWS_S3_BUCKET || 'zeroqueries'}/${f.s3_key}`),
                    load_all_sheets: true, schema_info: ctx.schemaInfo, relationships: ctx.relationships
                } : {
                    type: conn.db_type === 'postgresql' ? 'postgres' : conn.db_type,
                    connection_string: constructConnectionString(conn),
                    host: conn.host, port: parseInt(conn.port), database: conn.database_name, username: conn.username, password: conn.password,
                    schema_info: ctx.schemaInfo, relationships: ctx.relationships
                },
                access_policy: { 
                    role: userContext.role.toLowerCase(), 
                    allowed_tables: ctx.allowedTables, 
                    disallowed_tables: ctx.disallowedTables, 
                    allowed_columns: ctx.allowedColumns, 
                    restricted_columns: ctx.restrictedColumns || {}, 
                    row_level_filters: {},
                    max_rows: 1000, 
                    query_timeout_seconds: 30 
                },
                question: question,
                response_format: 'general', 
                max_rows: 100, 
                locale: 'en',
                include_insights: true,
                include_visualizations: false
            };

            const API_KEY = (process.env.EXTERNAL_AI_API_KEY || '').replace(/"/g, '').trim();
            const ASYNC_API_URL = 'https://zeroqueries-9b4b6.ondigitalocean.app/api/v1/analyze-async';

            // Submit async parsing task to AI engine
            const submitResponse = await axios.post(ASYNC_API_URL, payload, {
                headers: { 
                    'accept': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`, 
                    'Content-Type': 'application/json' 
                },
                timeout: 45000
            });

            const taskId = submitResponse.data.task_id;
            if (!taskId) {
                throw new Error('No task_id returned from AI service');
            }

            // 6. Polling loop
            let result = null;
            let attempts = 0;
            const MAX_ATTEMPTS = 30; // 60 seconds total

            while (attempts < MAX_ATTEMPTS) {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 2000));

                const statusUrl = `https://zeroqueries-9b4b6.ondigitalocean.app/api/v1/task/${taskId}/status`;
                const statusResponse = await axios.get(statusUrl, {
                    headers: { 'Authorization': `Bearer ${API_KEY}` }
                });

                const currentStatus = statusResponse.data.data?.status || 'UNKNOWN';

                if (currentStatus === 'COMPLETED') {
                    const resultUrl = `https://zeroqueries-9b4b6.ondigitalocean.app/api/v1/task/${taskId}/result`;
                    const resultResponse = await axios.get(resultUrl, {
                        headers: { 'Authorization': `Bearer ${API_KEY}` }
                    });
                    
                    result = resultResponse.data.data?.result || resultResponse.data.data || resultResponse.data;
                    break;
                } else if (currentStatus === 'FAILED' || currentStatus === 'CANCELLED') {
                    throw new Error(`AI Task failed with status: ${currentStatus}`);
                }
            }

            if (!result) {
                throw new Error('AI analysis timed out');
            }

            // Deduct credits on success
            await creditService.deductCredits(orgId, 1, { reference_type: 'whatsapp_bot', integration_id: integration.id });

            // 7. Format outbound response with WhatsApp markdown (*bold*)
            const answerText = result.execution_metadata?.ai_summary || result.answer || 'I could not compute a direct text answer.';
            let replyText = `✨ *ZeroQueries Intelligent Analysis*\n\n`;
            replyText += `📊 *Answer:*\n${answerText}\n`;

            // Executed SQL Query
            const sqlQuery = result.data?.query;
            if (sqlQuery) {
                replyText += `\n💻 *Executed SQL:*\n\`\`\`sql\n${sqlQuery}\n\`\`\`\n`;
            }

            // KPIs
            const kpis = result.kpis || [];
            if (kpis.length > 0) {
                replyText += `\n📈 *Key Performance Indicators (KPIs):*\n`;
                kpis.forEach(kpi => {
                    const val = kpi.format === 'currency' ? `$${Number(kpi.value).toLocaleString()}` : kpi.value;
                    replyText += `• *${kpi.name}*: ${val} (${kpi.description})\n`;
                });
            }

            // Insights
            const insights = result.insights || result.ai_result?.insights || [];
            if (insights.length > 0) {
                replyText += `\n💡 *Insights:*\n`;
                insights.forEach((ins) => {
                    replyText += `• *${ins.title || 'Insight'}*: ${ins.description}\n`;
                });
            }

            // Preview Table Data (up to 5 rows)
            const queryData = result.data?.data;
            const columns = result.data?.columns;
            if (Array.isArray(queryData) && queryData.length > 0 && Array.isArray(columns) && columns.length > 0) {
                replyText += `\n📋 *Data Preview (First 5 Rows):*\n`;
                const previewRows = queryData.slice(0, 5);
                previewRows.forEach((row, i) => {
                    const rowVals = columns.map(col => {
                        let val = row[col];
                        if (val instanceof Date || (typeof val === 'string' && val.includes('T00:00:00'))) {
                            val = new Date(val).toLocaleDateString();
                        }
                        return `${col}: *${val}*`;
                    }).join(' | ');
                    replyText += `${i + 1}. ${rowVals}\n`;
                });
                if (queryData.length > 5) {
                    replyText += `_...and ${queryData.length - 5} more rows inside the attached Excel sheet._\n`;
                }
            }

            // Save bot response to history
            await db.query(
                'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                [conversationId, 'assistant', answerText]
            );

            // 8. Deliver response
            await whatsappService.sendText(senderPhone, replyText, config);

            // 9. Generate and deliver Excel spreadsheet report if results contain rows/data
            if (Array.isArray(queryData) && queryData.length > 0 && Array.isArray(columns) && columns.length > 0) {
                const excelFilename = generateExcelReport(queryData, columns, orgId);
                
                // Construct file URL
                const hostUrl = process.env.BASE_URL || `http://${req.get('host')}`;
                const fileUrl = `${hostUrl}/reports/${excelFilename}`;
                
                console.log(`📊 [WHATSAPP WEBHOOK] Sending report excel sheet URL: ${fileUrl}`);
                
                // Wait for file write and send attachment
                await new Promise(resolve => setTimeout(resolve, 1000));
                await whatsappService.sendDocument(senderPhone, fileUrl, 'Query_Result_Report.xlsx', config);
            }

            // Log successful integration usage
            await db.query(
                `INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, response_payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [integration.id, orgId, '/api/public/whatsapp/webhook', 'success', Date.now() - startedAt, JSON.stringify({ question }), JSON.stringify({ status: 'completed' })]
            );

        } catch (err) {
            const errorMsg = err.response?.data || err.message;
            console.error('❌ [WHATSAPP WEBHOOK ERROR]:', errorMsg);
            
            try {
                fs.appendFileSync(
                    path.join(__dirname, '../../whatsapp_error.log'),
                    `[${new Date().toISOString()}] ERROR: ${JSON.stringify(errorMsg)}\nSTACK: ${err.stack}\n\n`
                );
            } catch (fsErr) {
                console.error('Failed to write local error log:', fsErr);
            }
            
            // Log usage failure
            if (integration) {
                const orgId = integration.target_organization_id || integration.organization_id;
                await db.query(
                    `INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, error_message)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [integration.id, orgId, '/api/public/whatsapp/webhook', 'failed', Date.now() - startedAt, JSON.stringify({ question }), String(errorMsg)]
                );
            }

            // Notify user of exception
            if (config) {
                await whatsappService.sendText(senderPhone, '⚠️ I encountered an error processing your query. Please check your data or try rephrasing.', config);
            }
        }
    })();
});

module.exports = router;
