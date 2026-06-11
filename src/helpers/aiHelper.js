const axios = require('axios');

// Safe boolean helper to trim whitespaces and quotes from env variables
function getBoolEnv(envName, defaultValue = true) {
    if (process.env[envName] === undefined) return defaultValue;
    const val = String(process.env[envName]).trim().replace(/['"]/g, '').toLowerCase();
    return val === 'true';
}

// Resolve the active base URL for AI operations (strictly resolved from env without hardcoded fallbacks)
function getAiBaseUrl() {
    return process.env.AI_BASE_URL;
}

// Adjust include_insights payload flags based on the environment toggle
function adjustPayload(payload) {
    const insightsEnabled = getBoolEnv('AI_INSIGHTS_ENABLED', true);
    if (!insightsEnabled) {
        payload.include_insights = false;
    }
    return payload;
}

// Check if suggestions are enabled
function areSuggestionsEnabled() {
    return getBoolEnv('SUGGESTED_QUERIES_ENABLED', true);
}

// Normalize suggestions responses when Suggestions are disabled
function getDisabledSuggestionsResponse() {
    return {
        success: true,
        suggestions: [],
        suggested_queries: [],
        suggested_questions: [],
        data: {
            suggestions: [],
            suggested_queries: [],
            suggested_questions: []
        }
    };
}

// Clean and normalize the response payload returned to the frontend to ensure structural integrity
function normalizeResponse(response) {
    if (!response || typeof response !== 'object') return response;

    const insightsEnabled = getBoolEnv('AI_INSIGHTS_ENABLED', true);
    if (!insightsEnabled) {
        // Recursive helper to safely blank out insights, kpis, answers, and summaries
        const cleanNode = (node) => {
            if (!node || typeof node !== 'object') return;

            // Clear direct fields if they exist
            if (node.insights !== undefined) node.insights = [];
            if (node.answer !== undefined) node.answer = "";
            if (node.explanation !== undefined) node.explanation = "";
            if (node.ai_summary !== undefined) node.ai_summary = "";

            // Recursively process standard wrapper/result containers
            const containers = ['data', 'result', 'details', 'ai_result', 'execution_metadata'];
            for (const key of containers) {
                if (node[key] && typeof node[key] === 'object') {
                    cleanNode(node[key]);
                }
            }
        };

        cleanNode(response);
    }
    return response;
}

// Write payload/response objects to a local debug txt file for better visibility
function writeAsyncDebugLog(label, data) {
    try {
        const fs = require('fs');
        const path = require('path');
        const logPath = path.join(__dirname, '../../analyze_async_debug.txt');
        const timestamp = new Date().toISOString();
        const divider = '='.repeat(50);
        const logMessage = `\n[${timestamp}] ${divider}\nLABEL: ${label}\n${divider}\n${JSON.stringify(data, null, 2)}\n`;
        fs.appendFileSync(logPath, logMessage, 'utf8');
        console.log(`📝 [DEBUG LOG] Appended debug info to ${logPath}`);
    } catch (err) {
        console.error('⚠️ [DEBUG LOG] Failed to write to debug file:', err.message);
    }
}

module.exports = {
    getAiBaseUrl,
    adjustPayload,
    areSuggestionsEnabled,
    getDisabledSuggestionsResponse,
    normalizeResponse,
    writeAsyncDebugLog
};
