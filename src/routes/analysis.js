const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/jwt');
const { getAiBaseUrl, normalizeResponse, writeAsyncDebugLog, generatePayloadSignature } = require('../helpers/aiHelper');

// ─── In-memory SSE clients & task pollers ───────────────────────────────────
const sseClients = {};
const taskPollers = new Map();

// ─── SSE Auth helper (token via query param for EventSource) ─────────────────
function authenticateTokenForSSE(req, res, next) {
    let token = null;

    if (req.query && req.query.token) {
        token = req.query.token;
    }
    if (!token && req.url.includes('?')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        token = urlParams.get('token');
    }
    if (!token && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts[0] === 'Bearer' && parts[1]) token = parts[1];
    }

    if (!token) {
        return res.status(401).json({ error: 'Authentication token required' });
    }
    if (token.split('.').length !== 3) {
        return res.status(400).json({ error: 'Invalid token format' });
    }

    jwt.verify(token, jwtConfig.secret, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token', details: err.message });
        req.user = user;
        next();
    });
}

// ─── SSE broadcast helper ────────────────────────────────────────────────────
function sendSse(conversationId, event, data) {
    const clients = sseClients[conversationId] || [];
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach((res) => {
        try { res.write(payload); } catch (e) { console.error('SSE write failed', e); }
    });
}

// ─── Task-update payload normaliser ─────────────────────────────────────────
function normalizeTaskUpdatePayload(payload, fallbackTaskId = null, fallbackConversationId = null) {
    if (!payload) return payload;
    const base = payload.success && payload.data ? payload.data : payload;
    const isRawResult = !!(base.request_id && base.data);
    let status = base.status || payload.status;
    if (!status && isRawResult) status = 'COMPLETED';
    else if (status) status = String(status).toUpperCase();

    const resolvedTaskId = base.task_id || payload.task_id || payload.data?.task_id || base.request_id || fallbackTaskId;
    const resolvedConversationId = base.conversation_id || payload.conversation_id || fallbackConversationId;

    let result = base.result || base.details?.result || payload.result || payload.data?.result;
    if (!result && isRawResult) result = base;

    let details = base.details || payload.details;
    if (result) details = { ...(details || {}), result };

    const normalized = { ...payload, ...(base !== payload ? base : {}), status, task_id: resolvedTaskId, conversation_id: resolvedConversationId, details, result };
    if (isRawResult) { normalized.percentage = 100; normalized.message = normalized.message || 'Analysis completed successfully!'; }
    return normalized;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ─── Analysis API logger ─────────────────────────────────────────────────────
async function logAnalysisApiCall({ organizationId = null, userId = null, conversationId = null, endpoint, question = null, requestPayload = null, responsePayload = null, errorPayload = null, statusCode = null, durationMs = null, success = false, taskId = null, requestId = null }) {
    try {
        await db.query(
            `INSERT INTO analysis_api_logs
             (organization_id, user_id, conversation_id, endpoint, question,
              status_code, success, duration_ms, request_payload, response_payload, error_payload, task_id, request_id, service_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
                organizationId, userId, conversationId, endpoint, question,
                statusCode, success, durationMs,
                requestPayload ? JSON.stringify(requestPayload) : null,
                responsePayload ? JSON.stringify(responsePayload) : null,
                errorPayload ? JSON.stringify(errorPayload) : null,
                taskId,
                requestId,
                'ai_analysis'
            ]
        );
    } catch (logError) {
        console.error('[ANALYSIS API LOG] Failed to persist log:', logError.message);
    }
}

async function updateAnalysisApiLogByTaskId({ taskId, responsePayload = null, errorPayload = null, success = false, conversationId = null }) {
    if (!taskId) return;
    try {
        const updateResult = await db.query(
            `UPDATE analysis_api_logs
             SET conversation_id   = COALESCE($1, conversation_id),
                 response_payload  = COALESCE($2, response_payload),
                 error_payload     = COALESCE($3, error_payload),
                 success           = $4
             WHERE task_id = $5`,
            [
                conversationId,
                responsePayload ? JSON.stringify(responsePayload) : null,
                errorPayload ? JSON.stringify(errorPayload) : null,
                success,
                taskId
            ]
        );

        if (updateResult.rowCount === 0) {
            await db.query(
                `UPDATE analysis_api_logs
                 SET conversation_id   = COALESCE($1, conversation_id),
                     response_payload  = COALESCE($2, response_payload),
                     error_payload     = COALESCE($3, error_payload),
                     success           = $4,
                     task_id           = $5
                 WHERE id = (SELECT id FROM analysis_api_logs WHERE (endpoint LIKE '%async%' OR endpoint LIKE '%query%') ORDER BY created_at DESC LIMIT 1)`,
                [
                    conversationId,
                    responsePayload ? JSON.stringify(responsePayload) : null,
                    errorPayload ? JSON.stringify(errorPayload) : null,
                    success,
                    taskId
                ]
            );
        }
    } catch (logError) {
        console.error('[ANALYSIS API LOG] Failed to update log:', logError.message);
    }
}

// ─── Build the simplified AI payload ─────────────────────────────────────────
// No db_config, no schema_info, no access_policy, no relationships
function buildPayload(question, options = {}) {
    const payload = {
        question,
        max_rows: options.max_rows !== undefined ? options.max_rows : 100,
        include_insights: options.include_insights !== false,
        include_visualizations: options.include_visualizations !== false,
        locale: options.locale || 'en',
        strict_joins: options.strict_joins !== false
    };

    // Add access_policy if provided (for RBAC)
    if (options.access_policy) {
        payload.access_policy = options.access_policy;
    }

    if (options.webhook_url) {
        payload.webhook_url = options.webhook_url;
    }

    return payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/query
// Synchronous: ask a question, get answer immediately
// ═══════════════════════════════════════════════════════════════════════════
router.post('/analyze', authenticateToken, async (req, res) => {
    const { question, include_visualizations = true } = req.body;
    const { organization_id, id: user_id } = req.user;
    const startedAt = Date.now();

    if (!question) return res.status(400).json({ success: false, error: 'Question is required' });

    // Build access_policy from request body or default from user role
    const resolvedAccessPolicy = access_policy || {
        role: (req.user.role || 'Viewer').toLowerCase(),
        allowed_tables: [],
        disallowed_tables: [],
        allowed_columns: {},
        restricted_columns: {},
        row_level_filters: {},
        max_rows: 1000,
        query_timeout_seconds: 30
    };

    const payload = buildPayload(question, { include_visualizations, access_policy: resolvedAccessPolicy });

    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/query`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        console.log('📨 [QUERY] Sending question to AI:', question);

        const signingSecret = process.env.HMAC_SECRET;
        const headers = { 'accept': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
        if (signingSecret) {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const clientId = process.env.HMAC_CLIENT_ID || 'nfc';
            const sig = generatePayloadSignature(payload, signingSecret, clientId, timestamp, 'POST', '/query');

            headers['X-Client-Id'] = clientId;
            headers['X-Timestamp'] = timestamp;
            if (sig) headers['X-Signature'] = sig;
        }

        writeAsyncDebugLog('QUERY_SYNC_OUTBOUND_PAYLOAD', { url: EXTERNAL_API_URL, headers, payload });

        const response = await axios.post(EXTERNAL_API_URL, payload, {
            headers,
            timeout: 60000
        });

        const finalResult = normalizeResponse(response.data);

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id,
            endpoint: '/api/v1/query', question,
            requestPayload: payload, responsePayload: finalResult,
            statusCode: response.status, durationMs: Date.now() - startedAt, success: true
        });

        console.log('✅ [QUERY] Returning result to frontend');
        res.json(finalResult);

    } catch (error) {
        console.error('❌ [QUERY] Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External analysis service failed' };

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id,
            endpoint: '/api/v1/query', question,
            requestPayload: payload, errorPayload: errorData,
            statusCode, durationMs: Date.now() - startedAt, success: false
        });

        res.status(statusCode).json({ success: false, message: 'Query failed', details: errorData });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/v1/stream/:conversationId
// SSE stream — frontend subscribes to receive async task updates
// ═══════════════════════════════════════════════════════════════════════════
router.get('/stream/:conversationId', authenticateTokenForSSE, (req, res) => {
    const { conversationId } = req.params;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(': SSE connection established\n\n');

    if (!sseClients[conversationId]) sseClients[conversationId] = [];
    sseClients[conversationId].push(res);
    console.log(`✅ SSE connected: conversation=${conversationId}`);

    req.on('close', () => {
        sseClients[conversationId] = sseClients[conversationId].filter(c => c !== res);
        console.log(`❌ SSE disconnected: conversation=${conversationId}`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/webhook
// External AI service calls this when an async task completes
// ═══════════════════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
    const update = req.body;
    let convId = update.conversation_id || req.query.conversation_id;
    const taskId = update.task_id || update.data?.task_id || update.request_id || (update.details?.result?.request_id);

    if (!convId && taskId) {
        try {
            const logResult = await db.query(
                `SELECT conversation_id FROM analysis_api_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [taskId]
            );
            if (logResult.rowCount > 0 && logResult.rows[0].conversation_id) {
                convId = logResult.rows[0].conversation_id;
                console.log(`🔍 [WEBHOOK] Found conversationId ${convId} from database for taskId ${taskId}`);
            }
        } catch (dbErr) {
            console.error('❌ Failed to look up conversation_id by task_id in webhook:', dbErr.message);
        }
    }

    const normalizedUpdate = normalizeTaskUpdatePayload(update, taskId, convId);

    console.log('🔔 [WEBHOOK] Task update for conversation:', convId, 'taskId:', taskId);
    const normalizedStatus = String(normalizedUpdate.status || '').toUpperCase();

    const finalUpdate = normalizeResponse(normalizedUpdate);

    await updateAnalysisApiLogByTaskId({
        taskId: finalUpdate.task_id || taskId,
        responsePayload: finalUpdate,
        errorPayload: normalizedStatus === 'FAILED' ? finalUpdate : null,
        success: normalizedStatus === 'COMPLETED',
        conversationId: convId || null
    });

    if (convId) {
        sendSse(convId, 'task_update', finalUpdate);
        try {
            if (normalizedUpdate.message) {
                await db.query(`INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,$2,$3)`,
                    [convId, 'assistant', `[${normalizedUpdate.status}] ${normalizedUpdate.message}`]);
            }
        } catch (e) { console.error('❌ Webhook message store failed', e.message); }
    }

    res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/query
// Submit Query: submits a natural language query for processing.
// ═══════════════════════════════════════════════════════════════════════════
const handleQueryRequest = async (req, res) => {
    const {
        question,
        max_rows = 100,
        include_insights = true,
        include_visualizations = true,
        access_policy,
        locale = 'en',
        strict_joins = true,
        webhook_url
    } = req.body;

    const { organization_id, id: user_id } = req.user;
    const conversation_id = req.query.conversation_id;
    const startedAt = Date.now();

    if (!question) return res.status(400).json({ success: false, error: 'Question is required' });

    // Build access_policy from request body or default from user role
    const resolvedAccessPolicy = access_policy || {
        role: (req.user.role || 'Viewer').toLowerCase(),
        allowed_tables: [],
        disallowed_tables: [],
        allowed_columns: {},
        restricted_columns: {},
        row_level_filters: {},
        max_rows: 1000,
        query_timeout_seconds: 30
    };

    // Calculate webhook url: prioritize configured WEBHOOK_BASE_URL over client-sent origin
    const baseUrl = process.env.WEBHOOK_BASE_URL || `${req.protocol}://${req.get('host')}`;
    let computedWebhookUrl = conversation_id
        ? `${baseUrl}/api/v1/webhook?conversation_id=${encodeURIComponent(conversation_id)}`
        : (webhook_url || `${baseUrl}/api/v1/webhook`);

    // If a webhook URL was passed but it contains localhost, override its base with our configured WEBHOOK_BASE_URL
    if (computedWebhookUrl && computedWebhookUrl.includes('localhost') && process.env.WEBHOOK_BASE_URL) {
        try {
            const urlObj = new URL(computedWebhookUrl);
            computedWebhookUrl = `${process.env.WEBHOOK_BASE_URL}${urlObj.pathname}${urlObj.search}`;
        } catch (e) {
            // Fallback to computed if URL parsing fails
        }
    }

    const payload = buildPayload(question, {
        max_rows,
        include_insights,
        include_visualizations,
        access_policy: resolvedAccessPolicy,
        locale,
        strict_joins,
        webhook_url: computedWebhookUrl
    });

    console.log('📨 [QUERY ASYNC] question:', question, 'conversation:', conversation_id);

    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/query`;
        console.log(payload, 'paylod')
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        const signingSecret = process.env.HMAC_SECRET;
        const headers = { 'accept': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
        if (signingSecret) {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const clientId = process.env.HMAC_CLIENT_ID || 'zeroqueries_onprem';
            const sig = generatePayloadSignature(payload, signingSecret, clientId, timestamp, 'POST', '/query');

            headers['X-Client-Id'] = clientId;
            headers['X-Timestamp'] = timestamp;
            if (sig) headers['X-Signature'] = sig;
        }

        writeAsyncDebugLog('QUERY_ASYNC_OUTBOUND_PAYLOAD', { url: EXTERNAL_API_URL, headers, payload });

        const response = await axios.post(EXTERNAL_API_URL, payload, {
            headers,
            timeout: 45000
        });

        const returnedTaskId = response.data.task_id || response.data.id;
        const returnedRequestId = response.data.request_id || (response.data.details && response.data.details.result && response.data.details.result.request_id);

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id, conversationId: conversation_id || null,
            endpoint: '/api/v1/query', question,
            requestPayload: payload, responsePayload: response.data,
            statusCode: response.status, durationMs: Date.now() - startedAt, success: true,
            taskId: returnedTaskId,
            requestId: returnedRequestId
        });

        console.log('✅ [QUERY ASYNC] Task created:', returnedTaskId);
        res.json(response.data);

    } catch (error) {
        console.log(error);
        console.error('❌ [QUERY ASYNC] Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { error: 'External analysis service failed' };

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id, conversationId: conversation_id || null,
            endpoint: '/api/v1/query', question,
            requestPayload: payload, errorPayload: errorData,
            statusCode, durationMs: Date.now() - startedAt, success: false
        });

        res.status(statusCode).json({ success: false, message: 'Async query submission failed', details: errorData });
    }
};

router.post('/query', authenticateToken, handleQueryRequest);
router.post('/analyze-async', authenticateToken, handleQueryRequest); // Backward compatibility

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/v1/task/:taskId
// Get Task Status
// ═══════════════════════════════════════════════════════════════════════════
const handleGetTaskStatus = async (req, res) => {
    const { taskId } = req.params;
    try {
        const dbResult = await db.query(
            `SELECT response_payload, success, error_payload FROM analysis_api_logs 
             WHERE task_id = $1 
             ORDER BY created_at DESC LIMIT 1`,
            [taskId]
        );

        if (dbResult.rowCount > 0) {
            const row = dbResult.rows[0];
            if (row.response_payload) {
                const normalized = normalizeTaskUpdatePayload(row.response_payload, taskId);
                return res.json(normalizeResponse(normalized));
            }
        }

        // Return a default PENDING response if the webhook hasn't updated the log yet
        res.json({
            task_id: taskId,
            status: 'PENDING',
            percentage: 0,
            message: 'Accepted',
            timestamp: new Date().toISOString(),
            details: {}
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Task status fetch failed', details: error.message });
    }
};

router.get('/task/:taskId', authenticateToken, handleGetTaskStatus);
router.get('/task/:taskId/status', authenticateToken, handleGetTaskStatus); // Backward compatibility

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/v1/task/:taskId/result
// ═══════════════════════════════════════════════════════════════════════════
router.get('/task/:taskId/result', authenticateToken, async (req, res) => {
    const { taskId } = req.params;
    try {
        await delay(1);
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/task/${taskId}/result`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
        const response = await axios.get(EXTERNAL_API_URL, {
            headers: { 'accept': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'x-api-key': API_KEY }
        });
        res.json(normalizeResponse(response.data));
    } catch (error) {
        const statusCode = error.response?.status || 500;
        res.status(statusCode).json({ success: false, message: 'Task result fetch failed', details: error.response?.data || error.message });
    }
});

// ─── Background poller (fallback when webhook doesn't arrive) ────────────────
async function pollTaskStatus(taskId, conversationId) {
    console.log('🔁 Starting poll for task', taskId);
    const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
    const statusUrl = `${getAiBaseUrl()}/task/${taskId}/status`;

    if (taskPollers.has(taskId)) { clearInterval(taskPollers.get(taskId)); taskPollers.delete(taskId); }

    const interval = setInterval(async () => {
        try {
            const resp = await axios.get(statusUrl, {
                headers: { accept: 'application/json', Authorization: `Bearer ${API_KEY}`, 'x-api-key': API_KEY }
            });
            const taskUpdate = normalizeResponse(normalizeTaskUpdatePayload(resp.data, taskId, conversationId));
            const status = String(taskUpdate.status || '').toUpperCase();

            await updateAnalysisApiLogByTaskId({ taskId, responsePayload: taskUpdate, errorPayload: status === 'FAILED' ? taskUpdate : null, success: status === 'COMPLETED', conversationId });
            sendSse(conversationId, 'task_update', taskUpdate);

            if (status === 'COMPLETED' || status === 'FAILED') {
                clearInterval(interval);
                taskPollers.delete(taskId);
            }
        } catch (e) { console.error('🔁 Poll error', e.message); }
    }, 5000);

    taskPollers.set(taskId, interval);
}

module.exports = router;
