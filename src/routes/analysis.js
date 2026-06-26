const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/jwt');
const { getAiBaseUrl, normalizeResponse, writeAsyncDebugLog } = require('../helpers/aiHelper');

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

    const resolvedTaskId         = base.task_id || payload.task_id || payload.data?.task_id || base.request_id || fallbackTaskId;
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
async function logAnalysisApiCall({ organizationId = null, userId = null, conversationId = null, endpoint, question = null, requestPayload = null, responsePayload = null, errorPayload = null, statusCode = null, durationMs = null, success = false }) {
    try {
        await db.query(
            `INSERT INTO analysis_api_logs
             (organization_id, user_id, conversation_id, endpoint, question,
              status_code, success, duration_ms, request_payload, response_payload, error_payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
                organizationId, userId, conversationId, endpoint, question,
                statusCode, success, durationMs,
                requestPayload  ? JSON.stringify(requestPayload)  : null,
                responsePayload ? JSON.stringify(responsePayload) : null,
                errorPayload    ? JSON.stringify(errorPayload)    : null
            ]
        );
    } catch (logError) {
        console.error('[ANALYSIS API LOG] Failed to persist log:', logError.message);
    }
}

async function updateAnalysisApiLogByTaskId({ taskId, responsePayload = null, errorPayload = null, success = false, conversationId = null }) {
    if (!taskId) return;
    try {
        await db.query(
            `UPDATE analysis_api_logs
             SET conversation_id   = COALESCE($1, conversation_id),
                 response_payload  = COALESCE($2, response_payload),
                 error_payload     = COALESCE($3, error_payload),
                 success           = $4
             WHERE id = (SELECT id FROM analysis_api_logs WHERE endpoint LIKE '%async%' ORDER BY created_at DESC LIMIT 1)`,
            [
                conversationId,
                responsePayload ? JSON.stringify(responsePayload) : null,
                errorPayload    ? JSON.stringify(errorPayload)    : null,
                success
            ]
        );
    } catch (logError) {
        console.error('[ANALYSIS API LOG] Failed to update log:', logError.message);
    }
}

// ─── Build the simplified AI payload ─────────────────────────────────────────
// No db_config, no schema_info, no access_policy, no relationships
function buildPayload(question, options = {}) {
    return {
        question,
        locale: 'en',
        include_insights: false,
        include_visualizations: options.include_visualizations !== false
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/analyze
// Synchronous: ask a question, get answer immediately
// ═══════════════════════════════════════════════════════════════════════════
router.post('/analyze', authenticateToken, async (req, res) => {
    const { question, include_visualizations = true } = req.body;
    const { organization_id, id: user_id } = req.user;
    const startedAt = Date.now();

    if (!question) return res.status(400).json({ success: false, error: 'Question is required' });

    const payload = buildPayload(question, { include_visualizations });

    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/analyze`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        console.log('📨 [ANALYZE] Sending question to AI:', question);

        const response = await axios.post(EXTERNAL_API_URL, payload, {
            headers: { 'accept': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 45000
        });

        const finalResult = normalizeResponse(response.data);

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id,
            endpoint: '/api/v1/analyze', question,
            requestPayload: payload, responsePayload: finalResult,
            statusCode: response.status, durationMs: Date.now() - startedAt, success: true
        });

        console.log('✅ [ANALYZE] Returning result to frontend');
        res.json(finalResult);

    } catch (error) {
        console.error('❌ [ANALYZE] Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData  = error.response?.data  || { error: 'External analysis service failed' };

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id,
            endpoint: '/api/v1/analyze', question,
            requestPayload: payload, errorPayload: errorData,
            statusCode, durationMs: Date.now() - startedAt, success: false
        });

        res.status(statusCode).json({ success: false, message: 'Analysis failed', details: errorData });
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
    const convId = update.conversation_id || req.query.conversation_id;
    const normalizedUpdate = normalizeTaskUpdatePayload(update, update.task_id || update.data?.task_id, convId);

    console.log('🔔 [WEBHOOK] Task update for conversation', convId);
    const normalizedStatus = String(normalizedUpdate.status || '').toUpperCase();

    if (normalizedUpdate.task_id && (normalizedStatus === 'COMPLETED' || normalizedStatus === 'FAILED') && taskPollers.has(normalizedUpdate.task_id)) {
        clearInterval(taskPollers.get(normalizedUpdate.task_id));
        taskPollers.delete(normalizedUpdate.task_id);
    }

    const finalUpdate = normalizeResponse(normalizedUpdate);
    writeAsyncDebugLog('WEBHOOK_PAYLOAD', finalUpdate);

    await updateAnalysisApiLogByTaskId({
        taskId: finalUpdate.task_id,
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
// POST /api/v1/analyze-async
// Async: sends question to AI, returns task_id immediately,
// result delivered via webhook → SSE
// ═══════════════════════════════════════════════════════════════════════════
router.post('/analyze-async', authenticateToken, async (req, res) => {
    const { question, include_visualizations = true } = req.body;
    const { organization_id, id: user_id } = req.user;
    const conversation_id = req.query.conversation_id;
    const startedAt = Date.now();

    if (!question)         return res.status(400).json({ success: false, error: 'Question is required' });
    if (!conversation_id) return res.status(400).json({ success: false, error: 'conversation_id query parameter is required' });

    const payload = buildPayload(question, { include_visualizations });
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/v1/webhook?conversation_id=${encodeURIComponent(conversation_id)}`;

    console.log('📨 [ASYNC ANALYZE] question:', question, 'conversation:', conversation_id);

    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/analyze-async`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';

        const response = await axios.post(`${EXTERNAL_API_URL}?webhook_url=${encodeURIComponent(webhookUrl)}`, payload, {
            headers: { 'accept': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 45000
        });

        writeAsyncDebugLog('ANALYZE_ASYNC_SUBMIT_RESPONSE', response.data);

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id, conversationId: conversation_id,
            endpoint: '/api/v1/analyze-async', question,
            requestPayload: payload, responsePayload: response.data,
            statusCode: response.status, durationMs: Date.now() - startedAt, success: true
        });

        console.log('✅ [ASYNC ANALYZE] Task created');
        res.json(response.data);

        // Background poll in case webhook doesn't arrive
        const returnedTaskId = response.data.task_id || response.data.id;
        if (returnedTaskId && conversation_id) pollTaskStatus(returnedTaskId, conversation_id);

    } catch (error) {
        console.error('❌ [ASYNC ANALYZE] Error:', error.response?.data || error.message);
        const statusCode = error.response?.status || 500;
        const errorData  = error.response?.data  || { error: 'External analysis service failed' };

        await logAnalysisApiCall({
            organizationId: organization_id, userId: user_id, conversationId: conversation_id,
            endpoint: '/api/v1/analyze-async', question,
            requestPayload: payload, errorPayload: errorData,
            statusCode, durationMs: Date.now() - startedAt, success: false
        });

        res.status(statusCode).json({ success: false, message: 'Async analysis failed', details: errorData });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/v1/task/:taskId/status
// ═══════════════════════════════════════════════════════════════════════════
router.get('/task/:taskId/status', authenticateToken, async (req, res) => {
    const { taskId } = req.params;
    try {
        const EXTERNAL_API_URL = `${getAiBaseUrl()}/task/${taskId}/status`;
        const API_KEY = process.env.EXTERNAL_AI_API_KEY || '';
        const response = await axios.get(EXTERNAL_API_URL, {
            headers: { 'accept': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'x-api-key': API_KEY }
        });
        res.json(normalizeResponse(response.data));
    } catch (error) {
        const statusCode = error.response?.status || 500;
        res.status(statusCode).json({ success: false, message: 'Task status fetch failed', details: error.response?.data || error.message });
    }
});

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
    const API_KEY  = process.env.EXTERNAL_AI_API_KEY || '';
    const statusUrl = `${getAiBaseUrl()}/task/${taskId}/status`;

    if (taskPollers.has(taskId)) { clearInterval(taskPollers.get(taskId)); taskPollers.delete(taskId); }

    const interval = setInterval(async () => {
        try {
            const resp = await axios.get(statusUrl, {
                headers: { accept: 'application/json', Authorization: `Bearer ${API_KEY}`, 'x-api-key': API_KEY }
            });
            const taskUpdate = normalizeResponse(normalizeTaskUpdatePayload(resp.data, taskId, conversationId));
            const status     = String(taskUpdate.status || '').toUpperCase();

            writeAsyncDebugLog('POLL_TASK_UPDATE', taskUpdate);
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
