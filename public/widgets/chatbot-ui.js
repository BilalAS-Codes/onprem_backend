
/**
 * Chatbot UI Module
 */
const ChatbotUI = (() => {
    let container, bubble, window_, messages, input, send, header;
    let isMaximized = false;
    let isOpen = false;

    const ICONS = {
        close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
        maximize: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v6h6"/></svg>`,
        restore: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-6 6"/><path d="M3 21l6-6"/></svg>`
    };

    const init = (config) => {
        container = document.createElement('div');
        container.id = 'zq-chatbot-container';

        const primaryColor = config?.primaryColor || '#e1e0f4ff';
        const botName = config?.botName || 'Assistant';
        const greeting = config?.greeting || 'Hello! How can I help you today?';

        container.innerHTML = `
            <div id="zq-chat-window">
                <div id="zq-chat-header" style="background-color: ${primaryColor}; color: white; border-bottom: none;">
                    <div class="zq-header-info">
                        <img src="${config.baseUrl}/widgets/zqicon.png" style="width: 42px; height: 42px; border-radius: 8px; object-fit: contain;" />
                        <h3 id="zq-bot-name-display" style="color: white;">${botName}</h3>
                    </div>
                    <div class="zq-header-actions">
                        <div id="zq-chat-maximize" class="zq-header-btn" style="color: white !important;" title="Maximize">
                            ${ICONS.maximize}
                        </div>
                        <div id="zq-chat-close" class="zq-header-btn" style="color: white !important;" title="Close">
                            ${ICONS.close}
                        </div>
                    </div>
                </div>
                <div id="zq-chat-messages">
                    <div class="zq-message bot">${greeting}</div>
                </div>
                <div id="zq-chat-input-container">
                    <input type="text" id="zq-chat-input" placeholder="Ask a question...">
                    <button id="zq-chat-send" style="background-color: ${primaryColor}">Send</button>
                </div>
            </div>
            <div id="zq-chat-bubble" style="background-color: transparent; box-shadow: none;">
                <img src="${config.baseUrl}/widgets/bot.png" style="width: 72px; height: 72px; object-fit: cover; border-radius: 50%;" />
            </div>
        `;

        document.body.appendChild(container);

        bubble = document.getElementById('zq-chat-bubble');
        window_ = document.getElementById('zq-chat-window');
        messages = document.getElementById('zq-chat-messages');
        input = document.getElementById('zq-chat-input');
        send = document.getElementById('zq-chat-send');

        setupEventListeners();
    };

    const setupEventListeners = () => {
        bubble.onclick = toggleChat;
        document.getElementById('zq-chat-close').onclick = (e) => {
            e.stopPropagation();
            toggleChat();
        };
        document.getElementById('zq-chat-maximize').onclick = toggleMaximize;

        input.onkeypress = (e) => {
            if (e.key === 'Enter') handleSend();
        };
        send.onclick = handleSend;

        // Action delegation for Suggestions, Export, and Download
        messages.onclick = (e) => {
            // 1. Suggestions
            // 1. Suggestion Pills/Items
            const pill = e.target.closest('.zq-suggestion-pill, .zq-suggestion-item');
            if (pill) {
                const question = pill.getAttribute('data-question');
                if (question) {
                    input.value = question;
                    handleSend();
                }
                return;
            }

            // 2. Export CSV
            const exportBtn = e.target.closest('.zq-export-btn');
            if (exportBtn) {
                const msgDiv = exportBtn.closest('.zq-message');
                if (msgDiv && msgDiv._data) {
                    generateCSV(msgDiv._data);
                }
                return;
            }

            // 3. Download PDF Report
            const downloadBtn = e.target.closest('.zq-download-btn');
            if (downloadBtn) {
                const msgDiv = downloadBtn.closest('.zq-message');
                if (msgDiv && msgDiv._data) {
                    generatePDF(msgDiv._data, downloadBtn);
                }
                return;
            }
        };
    };

    const generateCSV = (data) => {
        if (!data.data || !data.data.data) return;
        const rows = data.data.data;
        const columns = data.data.columns || Object.keys(rows[0] || {});
        
        const headers = columns.map(col => typeof col === 'string' ? col : col.name).join(',');
        const csvContent = [
            headers,
            ...rows.map(row => columns.map(col => {
                const key = typeof col === 'string' ? col : (col.key || col.name);
                const val = row[key] === null || row[key] === undefined ? '' : row[key];
                return `"${String(val).replace(/"/g, '""')}"`;
            }).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', `Analysis_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const generatePDF = async (data, btn) => {
        const originalHtml = btn.innerHTML;
        btn.innerHTML = 'Generating...';
        btn.disabled = true;

        try {
            if (!window.html2pdf) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
            }

            const html = ChatbotRenderer.renderReportHtml(data);
            const container = document.createElement('div');
            container.id = 'zq-temp-report-container';
            container.style.position = 'fixed';
            container.style.left = '0';
            container.style.top = '0';
            container.style.width = '1100px';
            container.style.height = 'auto';
            container.style.opacity = '1';
            container.style.pointerEvents = 'none';
            container.style.zIndex = '-9999';
            container.style.background = '#f8fafc';
            container.innerHTML = html;
            document.body.appendChild(container);

            const reportElement = container.firstElementChild || container;

            const opt = {
                margin: 10,
                filename: `Report_${Date.now()}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { 
                    scale: 2, 
                    useCORS: true,
                    backgroundColor: '#f8fafc',
                    letterRendering: true,
                    logging: false
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                pagebreak: { mode: ['css', 'legacy'] }
            };

            // Small delay to ensure DOM is painted and styles are applied
            await new Promise(resolve => setTimeout(resolve, 500));
            await window.html2pdf().from(reportElement).set(opt).save();
            // Safety delay to ensure pdf rendering has completed before removing container
            await new Promise(resolve => setTimeout(resolve, 2000));
            document.body.removeChild(container);
        } catch (err) {
            console.error('PDF Generation failed:', err);
            alert('Failed to generate PDF. Please try again.');
        } finally {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    };

    const loadScript = (url) => {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    };

    const toggleChat = () => {
        isOpen = !isOpen;
        window_.style.display = isOpen ? 'flex' : 'none';

        // If closing, ensure we un-maximize to reset positioning/overflow
        if (!isOpen && isMaximized) {
            toggleMaximize();
        }

        if (isOpen) {
            input.focus();
            scrollToBottom();
            // Important: Trigger resize after window becomes visible so Plotly can calculate dimensions
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 100);
        }
    };

    const toggleMaximize = () => {
        isMaximized = !isMaximized;
        const maxBtn = document.getElementById('zq-chat-maximize');

        if (isMaximized) {
            container.classList.add('zq-maximized');
            document.body.style.overflow = 'hidden';
            maxBtn.innerHTML = ICONS.restore;
            maxBtn.title = 'Restore';
        } else {
            container.classList.remove('zq-maximized');
            document.body.style.overflow = '';
            maxBtn.innerHTML = ICONS.maximize;
            maxBtn.title = 'Maximize';
        }
        // Trigger chart resize after animation
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            const charts = document.querySelectorAll('.js-plotly-plot');
            charts.forEach(chart => {
                if (window.Plotly) window.Plotly.Plots.resize(chart);
            });
        }, 300);
    };

    // Global resize listener for charts
    window.addEventListener('resize', () => {
        const charts = document.querySelectorAll('.js-plotly-plot');
        charts.forEach(chart => {
            if (window.Plotly) window.Plotly.Plots.resize(chart);
        });
    });

    const addMessage = (role, content, isHtml = false, data = null) => {
        const msgDiv = document.createElement('div');
        msgDiv.className = `zq-message ${role}`;
        if (data) msgDiv._data = data; // Store raw data for actions
        if (isHtml) {
            msgDiv.innerHTML = content;
        } else {
            msgDiv.textContent = content;
        }
        messages.appendChild(msgDiv);
        scrollToBottom();
        return msgDiv;
    };

    const addThinking = () => {
        const div = document.createElement('div');
        div.className = 'zq-message bot zq-thinking';
        div.innerHTML = `
            <div class="zq-thinking-state">
                <div class="zq-dot-pulse"></div>
                <span>Analyzing data...</span>
            </div>
        `;
        messages.appendChild(div);
        scrollToBottom();
        return div;
    };

    const scrollToBottom = () => {
        messages.scrollTop = messages.scrollHeight;
    };

    const handleSend = async () => {
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        addMessage('user', text);
        ChatbotAPI.saveToHistory({ role: 'user', content: text });

        const thinking = addThinking();

        try {
            if (window.onChatbotSend) {
                const response = await window.onChatbotSend(text);
                messages.removeChild(thinking);

                const html = ChatbotRenderer.formatMessage(response);
                addMessage('bot', html, true, response); // Pass response data here

                // Save raw response data for history parity
                ChatbotAPI.saveToHistory({ role: 'bot', content: response, isRaw: true });
            }
        } catch (err) {
            if (thinking && thinking.parentNode) {
                messages.removeChild(thinking);
            }

            const errorMessage = err.message || 'I encountered an issue processing your request.';
            addMessage('error', `⚠️ ${errorMessage}`);

            // NEW: Save error to local history so it persists on reload
            ChatbotAPI.saveToHistory({ role: 'error', content: `⚠️ ${errorMessage}` });
        }
    };

    const loadHistory = (history) => {
        history.forEach(msg => {
            if (msg.role === 'error') {
                addMessage('error', msg.content);
            } else if (msg.isRaw) {
                const html = ChatbotRenderer.formatMessage(msg.content);
                addMessage(msg.role, html, true, msg.content); // Restore data here
            } else {
                addMessage(msg.role, msg.content, msg.isHtml);
            }
        });
        // Ensure all charts are resized properly after bulk loading
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 500);
    };

    return {
        init,
        addMessage,
        loadHistory
    };
})();

// Ensure global availability
window.ChatbotUI = ChatbotUI;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChatbotUI;
}

console.log('📱 ZeroQueries ChatbotUI Loaded');
