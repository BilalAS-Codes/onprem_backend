const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('../config/database');
const creditService = require('../services/creditService');
const whatsappService = require('../services/whatsappService');
const { getAiBaseUrl, adjustPayload, normalizeResponse } = require('../helpers/aiHelper');
const chartService = require('../services/chartService');

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
    } catch (e) { }

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
            const isPrivate = config.chat_type === 'private';
            let authorizedUserId = null;
            let authorizedUserEmail = null;
            let authorizedUserName = null;

            // Mapped role & department scopes (Default for Public, will be overridden for Private)
            const userContext = {
                role: integration.role_name || 'Admin',
                department_id: integration.target_department_id,
                department_ids: Array.isArray(integration.target_department_ids)
                    ? integration.target_department_ids
                    : (integration.target_department_id ? [integration.target_department_id] : [])
            };

            if (isPrivate) {
                const cleanSenderPhone = senderPhone.trim().replace(/[^\+0-9]/g, '');
                const authRes = await db.query(
                    `SELECT wan.user_id, u.email, u.full_name
                     FROM whatsapp_authorized_numbers wan
                     JOIN users u ON wan.user_id = u.id
                     WHERE wan.integration_id = $1 AND (wan.mobile_number = $2 OR REPLACE(wan.mobile_number, '+', '') = $3)`,
                    [integration.id, cleanSenderPhone, cleanSenderPhone.replace('+', '')]
                );

                if (authRes.rows.length === 0) {
                    console.log(`🚫 [WHATSAPP PRIVATE BLOCK] Unauthorized sender: ${senderPhone} trying to access bot ${integration.id}`);
                    const blockMsg = '⛔ *Access Denied.*\nYour phone number is not authorized to access this secure ZeroQueries chatbot. Please contact your administrator to authorize your phone number.';
                    await whatsappService.sendText(senderPhone, blockMsg, config);

                    // Log usage log for unauthorized try
                    await db.query(
                        `INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, error_message)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [integration.id, orgId, '/api/public/whatsapp/webhook', 'unauthorized', Date.now() - startedAt, JSON.stringify({ question }), 'Sender number unauthorized']
                    );
                    return;
                }

                authorizedUserId = authRes.rows[0].user_id;
                authorizedUserEmail = authRes.rows[0].email;
                authorizedUserName = authRes.rows[0].full_name;

                // Override user context using live permissions of the linked system user
                const liveUserRes = await db.query(
                    `SELECT u.*, r.name as role_name 
                     FROM users u
                     LEFT JOIN roles r ON u.role_id = r.id
                     WHERE u.id = $1`,
                    [authorizedUserId]
                );

                if (liveUserRes.rows.length > 0) {
                    const liveUser = liveUserRes.rows[0];
                    userContext.role = liveUser.role_name || 'Viewer';
                    userContext.department_id = liveUser.department_id;
                    userContext.department_ids = liveUser.department_id ? [liveUser.department_id] : [];
                }
            }

            // Helper to send OTP and display instructions
            const sendOtpAndPrompt = async (convId, isNew = true) => {
                const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
                const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

                if (isNew) {
                    await db.query(
                        `INSERT INTO whatsapp_conversations (integration_id, sender_phone, conversation_id, is_verified, otp_code, otp_expires_at, user_id, last_activity_at)
                         VALUES ($1, $2, $3, false, $4, $5, $6, NOW())`,
                        [integration.id, senderPhone, convId, otpCode, otpExpiresAt, authorizedUserId]
                    );
                } else {
                    await db.query(
                        `UPDATE whatsapp_conversations
                         SET is_verified = false, otp_code = $1, otp_expires_at = $2, last_activity_at = NOW()
                         WHERE integration_id = $3 AND sender_phone = $4`,
                        [otpCode, otpExpiresAt, integration.id, senderPhone]
                    );
                }

                const sendEmail = config.otp_email_enabled !== false; // default true
                const sendWhatsapp = config.otp_whatsapp_enabled === true; // default false

                const sentTo = [];
                if (sendWhatsapp) {
                    const text = `🔑 Your ZeroQueries verification code is: *${otpCode}*.\nIt is valid for 15 minutes.`;
                    await whatsappService.sendText(senderPhone, text, config);
                    sentTo.push('WhatsApp');
                }
                if (sendEmail && authorizedUserEmail) {
                    const emailService = require('../services/emailService');
                    await emailService.sendOtp({
                        to: authorizedUserEmail,
                        otpCode,
                        chatbotName: config.phone_number || 'WhatsApp Bot'
                    });
                    sentTo.push('Email');
                }

                const sentToStr = sentTo.length > 0 ? sentTo.join(' and ') : 'Email';

                const welcomeMsg = isNew
                    ? `👋 *Welcome to ZeroQueries!*\n\nTo secure your account, a 6-digit verification code has been sent to your *${sentToStr}*.\n\nPlease reply with the code to verify your identity.`
                    : `⚠️ *Session expired or verification required.*\n\nA verification code has been sent to your *${sentToStr}*.\n\nPlease reply with the code to verify.`;

                await whatsappService.sendText(senderPhone, welcomeMsg, config);
            };

            // 3. Resolve active WhatsApp session mapping
            const mappedRes = await db.query(
                'SELECT * FROM whatsapp_conversations WHERE integration_id = $1 AND sender_phone = $2 LIMIT 1',
                [integration.id, senderPhone]
            );

            if (isPrivate) {
                let session = mappedRes.rows[0];

                if (!session) {
                    // Start new conversation
                    const newConv = await db.query(
                        'INSERT INTO chat_conversations (organization_id, user_id, title) VALUES ($1, $2, $3) RETURNING id',
                        [orgId, authorizedUserId, `WhatsApp Private: ${senderPhone}`]
                    );
                    conversationId = newConv.rows[0].id;
                    await sendOtpAndPrompt(conversationId, true);
                    return;
                }

                conversationId = session.conversation_id;

                if (!session.is_verified) {
                    const cleanQuestion = question.trim();
                    if (session.otp_code && cleanQuestion === session.otp_code) {
                        const now = new Date();
                        if (new Date(session.otp_expires_at) > now) {
                            await db.query(
                                `UPDATE whatsapp_conversations
                                 SET is_verified = true, verified_at = NOW(), last_activity_at = NOW(), otp_code = NULL, otp_expires_at = NULL
                                 WHERE integration_id = $1 AND sender_phone = $2`,
                                [integration.id, senderPhone]
                            );
                            const successMsg = `✅ *Verification Successful!*\n\nWelcome back, *${authorizedUserName}*. Your secure session is now active.\n\nYou can ask me questions about your database now.\n\n_Tip: Type *logout* or *exit* at any time to end your session._`;
                            await whatsappService.sendText(senderPhone, successMsg, config);
                            return;
                        } else {
                            // Expired
                            await sendOtpAndPrompt(conversationId, false);
                            return;
                        }
                    } else {
                        // Check if user is asking for a new code or starting over
                        const cleanQuestionLower = cleanQuestion.toLowerCase();
                        if (['resend', 'hi', 'hello', 'hey', 'start'].includes(cleanQuestionLower) || isGreeting(cleanQuestion)) {
                            await sendOtpAndPrompt(conversationId, false);
                            return;
                        } else if (/^\d{6}$/.test(cleanQuestion)) {
                            await whatsappService.sendText(senderPhone, '❌ *Invalid verification code.* Please check the code and try again.\n\n_Tip: Type *resend* to get a new code._', config);
                            return;
                        } else {
                            const promptMsg = `⚠️ *Verification Required.*\n\nPlease enter the 6-digit code sent to your verified channels to access your data.\n\n_Tip: Type *resend* to get a new code._`;
                            await whatsappService.sendText(senderPhone, promptMsg, config);
                            return;
                        }
                    }
                }

                // Session is verified, check 24-hour inactivity timeout
                const now = new Date();
                const lastActivity = new Date(session.last_activity_at);
                const hoursDiff = (now - lastActivity) / (1000 * 60 * 60);

                if (hoursDiff >= 24) {
                    console.log(`⏳ [WHATSAPP SESSION EXPIRED] Sender ${senderPhone} session expired due to 24h inactivity.`);
                    await sendOtpAndPrompt(conversationId, false);
                    return;
                }

                // Check logout commands
                const cleanQuestionLower = question.trim().toLowerCase();
                if (['exit', 'logout', 'quit', 'end session'].includes(cleanQuestionLower)) {
                    await db.query(
                        'DELETE FROM whatsapp_conversations WHERE integration_id = $1 AND sender_phone = $2',
                        [integration.id, senderPhone]
                    );
                    const logoutMsg = '👋 *Secure session ended successfully.*\n\nYou have been logged out. Send any message to initiate a new verification process.';
                    await whatsappService.sendText(senderPhone, logoutMsg, config);
                    return;
                }

                // Update activity time
                await db.query(
                    'UPDATE whatsapp_conversations SET last_activity_at = NOW() WHERE integration_id = $1 AND sender_phone = $2',
                    [integration.id, senderPhone]
                );

            } else {
                // Public Bot session resolution (existing flow)
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
                include_visualizations: true
            };

            const adjustedPayload = adjustPayload(payload);

            const API_KEY = (process.env.EXTERNAL_AI_API_KEY || '').replace(/"/g, '').trim();

            // --- GREETING SHORTCUT ---
            // If the user sent a greeting, skip the expensive AI analysis.
            // Call the suggest API to get schema-aware query suggestions and return immediately.
            if (isGreeting(question)) {
                console.log(`👋 [WHATSAPP] Greeting detected: "${question}". Fetching suggestions...`);

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

                    console.log(`💡 [WHATSAPP] Greeting: fetched ${suggested_queries.length} schema-aware suggestions (no credit deducted)`);

                } catch (suggestErr) {
                    // Suggest API failed — use generic fallback
                    console.warn('⚠️ [WHATSAPP] Greeting suggest API failed, using free fallback:', suggestErr.message);
                    suggested_queries = [
                        'Show me the top 5 records',
                        'What is the total count of entries?',
                        'Summarize the latest data for me'
                    ];
                }

                // Format the WhatsApp message with suggestions
                let replyText = `👋 *Hello!* I'm your ZeroQueries assistant.\n\nHere are some questions you can ask me about your data:\n`;
                suggested_queries.forEach((q, index) => {
                    replyText += `\n${index + 1}. *${q}*`;
                });
                replyText += `\n\n_Just reply with any of these questions or type your own query!_`;

                // Save bot response to history
                const dbMessageContent = `👋 Hello! Here are some suggested queries:\n` + suggested_queries.map((q, i) => `${i + 1}. ${q}`).join('\n');
                await db.query(
                    'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
                    [conversationId, 'assistant', dbMessageContent]
                );

                // Deliver response to WhatsApp
                await whatsappService.sendText(senderPhone, replyText, config);

                // Log successful integration usage
                await db.query(
                    `INSERT INTO integration_logs (integration_id, organization_id, endpoint, status, duration_ms, request_payload, response_payload)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [integration.id, orgId, '/api/public/whatsapp/webhook', 'greeting', Date.now() - startedAt,
                    JSON.stringify({ question }), JSON.stringify({ suggested_queries })]
                );

                return; // Early return, skipping expensive AI processing and credit deduction!
            }

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

            console.log('📤 [WHATSAPP WEBHOOK] AI submit task response:', JSON.stringify(submitResponse.data, null, 2));

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

                const statusUrl = `${getAiBaseUrl()}/task/${taskId}/status`;
                const statusResponse = await axios.get(statusUrl, {
                    headers: { 'Authorization': `Bearer ${API_KEY}` }
                });

                const currentStatus = statusResponse.data.data?.status || 'UNKNOWN';

                if (currentStatus === 'COMPLETED') {
                    const resultUrl = `${getAiBaseUrl()}/task/${taskId}/result`;
                    const resultResponse = await axios.get(resultUrl, {
                        headers: { 'Authorization': `Bearer ${API_KEY}` }
                    });

                    result = resultResponse.data.data?.result || resultResponse.data.data || resultResponse.data;
                    console.log('📥 [WHATSAPP WEBHOOK] AI Result Payload received. Saving to zeroqueries-backend/whatsapp_payload.log for debugging...');
                    try {
                        fs.writeFileSync(
                            path.join(__dirname, '../../whatsapp_payload.log'),
                            JSON.stringify(result, null, 2)
                        );
                    } catch (fsErr) {
                        console.error('⚠️ Failed to write debug payload file:', fsErr.message);
                    }
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

            if (isPrivate) {
                replyText += `\n📱 _To end this secure session, simply reply with_ *logout* _or_ *exit*.\n`;
            }

            // 8. Deliver response — enforce WhatsApp's 4096 character hard limit
            const WA_MAX_CHARS = 4096;
            if (replyText.length > WA_MAX_CHARS) {
                const truncateNote = `\n\n_...Message truncated. Full data is in the attached Excel report._`;
                replyText = replyText.slice(0, WA_MAX_CHARS - truncateNote.length) + truncateNote;
            }
            await whatsappService.sendText(senderPhone, replyText, config);

            // --- CHART IMAGE DELIVERY ---
            const visualizations = result.ai_result?.visualizations || result.visualizations || [];
            if (visualizations.length > 0 && visualizations[0].plotly_json) {
                try {
                    const imageUrl = await chartService.generateChartImageUrl(visualizations[0].plotly_json);
                    if (imageUrl) {
                        await whatsappService.sendImage(senderPhone, imageUrl, config);
                    }
                } catch (chartErr) {
                    console.error('⚠️ [WHATSAPP WEBHOOK] Failed to send chart image:', chartErr.message);
                }
            }

            // --- EXCEL REPORT DELIVERY ---
            if (Array.isArray(queryData) && queryData.length > 0 && Array.isArray(columns) && columns.length > 0) {
                try {
                    const excelFilename = generateExcelReport(queryData, columns, orgId);

                    // Construct file URL
                    const hostUrl = process.env.BASE_URL || `http://${req.get('host')}`;
                    const fileUrl = `${hostUrl}/reports/${excelFilename}`;

                    console.log(`📊 [WHATSAPP WEBHOOK] Sending report excel sheet URL: ${fileUrl}`);

                    // Wait for file write and send attachment
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await whatsappService.sendDocument(senderPhone, fileUrl, 'Query_Result_Report.xlsx', config);
                } catch (excelErr) {
                    console.error('⚠️ [WHATSAPP WEBHOOK] Failed to generate/send Excel report:', excelErr.message);
                }
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
                try {
                    await whatsappService.sendText(senderPhone, '⚠️ I encountered an error processing your query. Please check your data or try rephrasing.', config);
                } catch (notifyErr) {
                    console.error('⚠️ Could not send error message to WhatsApp (API token may be invalid/expired):', notifyErr.message);
                }
            }
        }
    })().catch(err => {
        console.error('💥 Unhandled error in WhatsApp Webhook IIFE:', err.message);
    });
});

module.exports = router;
