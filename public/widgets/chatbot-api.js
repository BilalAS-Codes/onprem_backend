
/**
 * Chatbot API & History Module
 */
const ChatbotAPI = (() => {
    const HISTORY_KEY = 'zq_chatbot_history';

    const saveToHistory = (message) => {
        const history = getHistory();
        history.push(message);
        // Keep last 50 messages
        if (history.length > 50) history.shift();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    };

    const getHistory = () => {
        try {
            const saved = localStorage.getItem(HISTORY_KEY);
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            return [];
        }
    };

    const clearHistory = () => {
        localStorage.removeItem(HISTORY_KEY);
    };

    const pollTaskStatus = async (baseUrl, taskId, apiKey, onStatusUpdate) => {
        const MAX_ATTEMPTS = 60;
        let attempts = 0;

        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            await new Promise(r => setTimeout(r, 2000));

            try {
                const response = await fetch(`${baseUrl}/api/v1/task/${taskId}/status`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                const data = await response.json();
                const status = data.data?.status || 'UNKNOWN';

                if (onStatusUpdate) onStatusUpdate(status, data.data?.message);

                if (status === 'COMPLETED') {
                    const resultResponse = await fetch(`${baseUrl}/api/v1/task/${taskId}/result`, {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    const resultData = await resultResponse.json();
                    return resultData.data?.result || resultData.data;
                } else if (status === 'FAILED' || status === 'CANCELLED') {
                    throw new Error(`Task ${status}`);
                }
            } catch (err) {
                console.error('Polling error:', err);
                if (attempts >= MAX_ATTEMPTS) throw err;
            }
        }
        throw new Error('Task timed out');
    };

    const sendMessage = async (baseUrl, apiKey, question) => {
        const headers = { 'Content-Type': 'application/json' };
        
        // Try to get token from localStorage for dashboard sync
        const token = localStorage.getItem('token');
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(`${baseUrl}/api/public/chat`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ api_key: apiKey, question: question })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to send message');
        }

        return await response.json();
    };

    const fetchConfig = async (baseUrl, apiKey) => {
        const response = await fetch(`${baseUrl}/api/public/config/${apiKey}`);
        if (!response.ok) return null;
        const config = await response.json();
        return { ...config, baseUrl, apiKey };
    };

    return {
        saveToHistory,
        getHistory,
        clearHistory,
        sendMessage,
        fetchConfig
    };
})();

// Ensure global availability
window.ChatbotAPI = ChatbotAPI;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChatbotAPI;
}

console.log('🔗 ZeroQueries ChatbotAPI Loaded');
