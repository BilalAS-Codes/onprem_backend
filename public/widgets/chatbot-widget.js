
/**
 * ZeroQueries Chatbot Widget - Main Orchestrator
 */
(() => {
    // 1. Get initial configuration from script tag
    const script = document.currentScript;
    const apiKey = script.getAttribute('data-api-key');
    const baseUrl = script.src.split('/widgets/')[0];

    if (!apiKey) {
        console.error('ZeroQueries Chatbot: Missing data-api-key attribute');
        return;
    }

    // 2. Load Styles
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${baseUrl}/widgets/chatbot.css`;
    document.head.appendChild(link);

    // 3. Load Modules Sequentially
    const loadScript = (src) => {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    };

    const init = async () => {
        try {
            // Load all dependencies
            const version = '26';
            await Promise.all([
                loadScript('https://cdn.plot.ly/plotly-2.27.0.min.js'),
                loadScript(`${baseUrl}/widgets/chatbot-api.js?v=${version}`),
                loadScript(`${baseUrl}/widgets/chatbot-renderer.js?v=${version}`),
                loadScript(`${baseUrl}/widgets/chatbot-ui.js?v=${version}`)
            ]);

            // Fetch live config
            const config = await ChatbotAPI.fetchConfig(baseUrl, apiKey);

            // Initialize UI
            ChatbotUI.init(config);

            // Load History
            const history = ChatbotAPI.getHistory();
            if (history.length > 0) {
                ChatbotUI.loadHistory(history);
            }

            // Bind UI send action to API
            window.onChatbotSend = async (question) => {
                return await ChatbotAPI.sendMessage(baseUrl, apiKey, question);
            };

            console.log('✅ ZeroQueries Chatbot Initialized');
        } catch (err) {
            console.error('❌ ZeroQueries Chatbot Initialization Failed:', err);
        }
    };

    init();
})();
