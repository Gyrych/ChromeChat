class ChromeChatAssistant {
    constructor() {
        this.settings = {
            ollamaUrl: 'http://localhost:11434',
            enableStreaming: true,
            apiKey: '',
            defaultModel: ''
        };
        this.currentModel = '';
        // 仅用于UI显示的临时历史，真实持久化在会话对象中
        this.conversationHistory = [];
        this.currentMessageId = null;

        // 会话管理相关
        this.sessionIndexKey = 'ollama.sessionIndex';
        this.sessionKeyPrefix = 'ollama.session.';
        this.activeSessionId = null;
        this.maxMessagesToKeep = 20; // 简易上下文截断策略：仅保留最近N条
        // 简单的内存级写锁，用于避免对 session index 与单个 session 的并发写入竞态
        this._sessionLocks = {}; // { [sessionId]: Promise }
        this._unsavedSessions = {}; // 临时内存会话，避免在无消息时持久化

        this.initializeElements();
        this.loadSettings();
        this.attachEventListeners();
        this.setupMessageListeners();
        // 在 popup 初始化时尝试拉取 background 中因 popup 不在而持久化的 pending 消息
        if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
            this._deferredFetchPending = setTimeout(() => { try { this._fetchPendingMessages(); } catch (e) { console.warn('fetchPendingMessages 异常:', e); } }, 200);
        }
        this.testConnection();
    }

    // 简单的 HTML 转义函数（作为类方法）
    escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 简单安全的 Markdown 渲染器，作为类方法
    renderMessageHtml(raw) {
        if (!raw) return '';
        let s = raw;
        const codeBlocks = [];
        s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
            codeBlocks.push(code);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });

        // 转义 HTML
        s = this.escapeHtml(s);

        // 恢复代码块
        s = s.replace(/__CODE_BLOCK_(\d+)__/g, (m, idx) => {
            const code = this.escapeHtml(codeBlocks[Number(idx)] || '');
            return `<pre><code>${code}</code></pre>`;
        });

        // 行内格式（代码/加粗/斜体/链接）
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
            const safeUrl = this.escapeHtml(url);
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        });

        const lines = s.split(/\r?\n/);
        // inList: null | 'ul' | 'ol'
        let inList = null;
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // 标题支持：# ... ######
            const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
            if (h) {
                if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; }
                const level = Math.min(6, h[1].length);
                out.push(`<h${level}>${h[2]}</h${level}>`);
                continue;
            }

            // 引用块支持：> ...
            const bq = line.match(/^\s*>\s+(.*)$/);
            if (bq) {
                if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; }
                out.push(`<blockquote>${bq[1]}</blockquote>`);
                continue;
            }

            // 有序列表：1. item
            const ol = line.match(/^\s*\d+\.\s+(.*)$/);
            if (ol) {
                if (inList !== 'ol') { if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>'); out.push('<ol>'); inList = 'ol'; }
                out.push(`<li>${ol[1]}</li>`);
                continue;
            }

            // 无序列表：-, *, +, 或者常见的 '•'、'·'
            const ul = line.match(/^\s*(?:[-*+]|[•·])\s+(.*)$/);
            if (ul) {
                if (inList !== 'ul') { if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>'); out.push('<ul>'); inList = 'ul'; }
                out.push(`<li>${ul[1]}</li>`);
                continue;
            }

            // 非列表行：如果当前处于列表中，先关闭列表
            if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; }

            if (line.trim() === '') {
                // 保留一个空行渲染为换行，避免连续多行产生大量 <br>
                out.push('<br>');
            } else {
                out.push(`<p>${line}</p>`);
            }
        }
        if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>');
        return out.join('');
    }

    async _fetchPendingMessages() {
        try {
            const res = await chrome.storage.local.get(['ollama.pendingStreamUpdates', 'ollama.pendingStreamErrors']);
            const updates = res['ollama.pendingStreamUpdates'] || [];
            const errors = res['ollama.pendingStreamErrors'] || [];

            for (const u of updates) {
                try { this.handleStreamUpdate(u); } catch (e) { console.warn('处理 pending update 失败:', e); }
            }

            for (const e of errors) {
                try { this.handleStreamError(e); } catch (er) { console.warn('处理 pending error 失败:', er); }
            }

            // 清理已消费的 pending
            if (updates.length || errors.length) {
                await chrome.storage.local.remove(['ollama.pendingStreamUpdates', 'ollama.pendingStreamErrors']);
            }
        } catch (err) {
            console.warn('fetchPendingMessages 异常:', err);
        }
    }

    initializeElements() {
        // 状态指示器
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusText = document.getElementById('statusText');

        // 模型选择
        this.modelSelect = document.getElementById('modelSelect');

        // 会话选择与管理
        // 已移除原生 sessionSelect，下方 UI 使用 sessionListPanel 管理会话
        this.sessionSelect = null;
        this.newSessionBtn = document.getElementById('newSessionBtn');
        this.currentSessionBtn = document.getElementById('currentSessionBtn');
        this.currentSessionText = document.getElementById('currentSessionText');
        this.sessionListPanel = document.getElementById('sessionListPanel');
        this.sessionMenu = document.getElementById('sessionMenu');

        // 设置相关
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsPanel = document.getElementById('settingsPanel');
        this.ollamaUrlInput = document.getElementById('ollamaUrl');
        this.enableStreamingCheckbox = document.getElementById('enableStreaming');
        this.ollamaApiKeyInput = document.getElementById('ollamaApiKey');
        this.testConnectionBtn = document.getElementById('testConnection');
        this.saveSettingsBtn = document.getElementById('saveSettings');

        // 对话相关
        this.chatContainer = document.getElementById('chatContainer');
        this.messagesDiv = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendMessageBtn = document.getElementById('sendMessage');
        this.clearChatBtn = document.getElementById('clearChat');
        this.fetchAndSendBtn = document.getElementById('fetchAndSendBtn');
        // 停止按钮（用于中断正在进行的生成）
        this.stopMessageBtn = document.getElementById('stopMessageBtn');
        // 底部显示元素：模型上下文、会话已消耗与预计 tokens
        this.modelContextValue = document.getElementById('modelContextValue');
        this.sessionConsumedTokensEl = document.getElementById('sessionConsumedTokens');
        this.nextTurnTokensEl = document.getElementById('nextTurnTokens');
    }

    setupMessageListeners() {
        // 监听来自 background script 的消息（流式更新、摘要生成/失败等）
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (!request || !request.action) return;
            switch (request.action) {
                case 'streamUpdate':
                    this.handleStreamUpdate(request);
                    break;
                case 'streamError':
                    this.handleStreamError(request);
                    break;
                case 'summaryGenerated':
                    // 后台生成了摘要，request 包含 summaryMeta（summaryId, summary, startIdx, endIdx, ts, byModel）
                    (async () => {
                        try {
                            const meta = {
                                summaryId: request.summaryId,
                                summary: request.summary,
                                startIdx: request.startIdx,
                                endIdx: request.endIdx,
                                ts: request.ts,
                                byModel: request.byModel
                            };
                            if (!this.activeSessionId) return;
                            const session = await this.loadSession(this.activeSessionId);
                            if (!session) return;
                            // 将摘要元数据追加到 session.summaries
                            if (!Array.isArray(session.summaries)) session.summaries = [];
                            session.summaries.push(meta);
                            await this.saveSession(session);
                            // 重新渲染会话以显示摘要条目
                            await this.renderActiveSessionMessages();
                        } catch (e) {
                            console.warn('处理 summaryGenerated 失败:', e);
                        }
                    })();
                    break;
                case 'summaryFailed':
                    // 在 UI 中内嵌提示摘要失败
                    if (this.currentMessageId) {
                        this.updateMessageContent(this.currentMessageId, `\n（自动摘要失败：${request.message || '未知错误'}，将继续使用完整历史）`);
                    } else {
                        this.addMessage('assistant', `（自动摘要失败：${request.message || '未知错误'}，将继续使用完整历史）`);
                    }
                    break;
            }
        });
    }



    async loadSettings() {
        const result = await chrome.storage.local.get(['ollamaSettings']);
        if (result.ollamaSettings) {
            this.settings = { ...this.settings, ...result.ollamaSettings };
            this.ollamaUrlInput.value = this.settings.ollamaUrl;
            this.enableStreamingCheckbox.checked = this.settings.enableStreaming;
            if (this.ollamaApiKeyInput) this.ollamaApiKeyInput.value = this.settings.apiKey || '';
            // 如果存储了默认模型，则在模型列表加载完成后设置为选中
            this._storedDefaultModel = this.settings.defaultModel || '';
        }
    }

    async saveSettings() {
        this.settings.ollamaUrl = this.ollamaUrlInput.value;
        this.settings.enableStreaming = this.enableStreamingCheckbox.checked;
        if (this.ollamaApiKeyInput) this.settings.apiKey = this.ollamaApiKeyInput.value;
        // 保存用户选择的默认模型（通过 "保存设置" 按钮）
        try {
            if (this.modelSelect) this.settings.defaultModel = this.modelSelect.value || (this.settings.defaultModel || '');
        } catch (e) { /* ignore */ }
        await chrome.storage.local.set({
            ollamaSettings: this.settings
        });
        // 同步内存中的默认模型，确保随后加载模型列表时能选中已保存值
        try { this._storedDefaultModel = this.settings.defaultModel || ''; } catch (e) { /* ignore */ }
        // 如果模型列表已加载，立即尝试选中并触发 change 以刷新 UI 状态
        try {
            if (this.modelSelect && this._storedDefaultModel) {
                const foundOption = Array.from(this.modelSelect.options).find(o => o.value === this._storedDefaultModel);
                if (foundOption) {
                    this.modelSelect.value = this._storedDefaultModel;
                    const ev = new Event('change');
                    this.modelSelect.dispatchEvent(ev);
                }
            }
        } catch (e) { /* ignore */ }
        this.hideSettings();
        this.testConnection();
    }

    attachEventListeners() {
        if (this.settingsBtn) this.settingsBtn.addEventListener('click', () => this.toggleSettings());
        if (this.saveSettingsBtn) this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        if (this.testConnectionBtn) this.testConnectionBtn.addEventListener('click', () => this.testConnection());

        if (this.modelSelect) this.modelSelect.addEventListener('change', async (e) => {
            const prevModel = this.currentModel;
            this.currentModel = e.target.value;
            // 当用户选择模型后：启用输入与发送按钮，并在首次选择模型时自动创建一个会话
            this.updateInteractionState();
            if (this.currentModel && !this.activeSessionId) {
                // 在用户首次选定模型时，自动新建一个会话
                const id = await this.createSession({ model: this.currentModel, name: this.defaultSessionName(this.currentModel) });
                await this.setActiveSession(id);
                await this.refreshSessionSelect();
                await this.renderActiveSessionMessages();
            } else if (this.activeSessionId) {
                // 同步当前会话的模型名（若已选中会话）
                await this.updateActiveSessionModel(this.currentModel);
            }
        this.updateModelContextDisplay();
        this.refreshTokenStats();
        });

        if (this.sendMessageBtn) this.sendMessageBtn.addEventListener('click', () => this.sendMessage());
        if (this.stopMessageBtn) this.stopMessageBtn.addEventListener('click', () => this.handleStopRequested());
        if (this.messageInput) this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        if (this.messageInput) this.messageInput.addEventListener('input', () => { this.refreshTokenStats(); });

        if (this.clearChatBtn) this.clearChatBtn.addEventListener('click', () => this.handleClearConversation());
        if (this.newSessionBtn) this.newSessionBtn.addEventListener('click', () => this.handleNewSessionButSavePrevious());
        if (this.fetchAndSendBtn) {
            this.fetchAndSendBtn.addEventListener('click', () => this.handleFetchAndSend());
            // 简易 tooltip：使用 title 属性已在 DOM 中设置，增强无障碍
            this.fetchAndSendBtn.addEventListener('mouseenter', (e) => {
                // 可在未来扩展为更复杂的 tooltip 实现
                const el = e.currentTarget;
                if (el && !el.dataset._hasTooltip) el.dataset._hasTooltip = '1';
            });
        }

        // 会话管理事件
        // 原生下拉已移除，保留该逻辑注释以便将来需要时恢复
        // this.sessionSelect.addEventListener('change', () => this.handleSessionSwitch());
        // 点击当前会话按钮显示会话列表面板（非操作菜单）
        if (this.currentSessionBtn) this.currentSessionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.debug('currentSessionBtn clicked');
            // 和设置按钮一致的行为：切换对应面板并更新 aria 状态
            this.toggleSessionList();
            try { this.currentSessionBtn.setAttribute('aria-expanded', String(!this.sessionListPanel.classList.contains('hidden'))); } catch (err) { /* ignore */ }
        });
        // 使用捕获阶段监听，保证即使面板内部阻止了冒泡也能正确判断点击位置并关闭面板
        document.addEventListener('click', (e) => this.handleGlobalClickForMenus(e), true);
    }

    // 被调用以显示或隐藏停止按钮
    setStopButtonVisible(visible) {
        try {
            if (!this.stopMessageBtn) return;
            this.stopMessageBtn.style.display = visible ? '' : 'none';
            this.stopMessageBtn.disabled = !visible;
            // 当显示停止按钮时，隐藏发送按钮；当隐藏停止按钮时，恢复发送按钮显示
            try {
                if (this.sendMessageBtn) this.sendMessageBtn.style.display = visible ? 'none' : '';
                if (this.sendMessageBtn) this.sendMessageBtn.disabled = visible; // 禁用发送按钮在停止期间
            } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    }

    // 用户点击停止按钮的处理
    async handleStopRequested() {
        try {
            if (!this._currentRequestId) return;
            const reqId = this._currentRequestId;
            // 发送中止请求到 background
            await this.sendMessageToBackground('abortChat', { requestId: reqId });
            // 立即清理 UI：移除占位并隐藏停止按钮
            if (this.currentMessageId) {
                // 直接移除未完成的助手占位，不显示任何取消文案
                this.removeMessage(this.currentMessageId);
                this.currentMessageId = null;
            }
            this._currentRequestId = null;
            this.setStopButtonVisible(false);
        } catch (e) {
            console.warn('handleStopRequested failed:', e);
        }
    }

    // 抓取并发送：注入 content_fetch.js 并将抓取文本保存为 user 消息并触发 sendChat
    async handleFetchAndSend() {
        try {
            if (!this.currentModel) {
                alert('请先选择一个模型');
                return;
            }

            await this.ensureActiveSession();

            // 获取当前活动 tab
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs && tabs[0];
            if (!tab || !tab.id) {
                alert('未检测到活动标签页');
                return;
            }

            // 在 UI 中添加占位 user 消息
            const placeholderId = this.addMessage('user', '正在抓取页面内容...');

            let res = null;
            try {
                console.debug('handleFetchAndSend -> 注入 content_fetch.js 到 tabId', tab.id, 'url:', tab.url);
                // 如果页面不允许注入脚本（如 chrome:// 或 Chrome Web Store），提前提示并返回
                if (!this.isInjectableUrl(tab.url)) {
                    const msg = '当前页面不允许脚本注入（例如 Chrome 商店或浏览器内部页面），请手动复制页面文本并粘贴到输入框后发送。';
                    console.warn('handleFetchAndSend -> 注入被浏览器限制，url:', tab.url);
                    // 直接把占位 user 消息替换为提示
                    const el = document.getElementById(placeholderId);
                    if (el) {
                        el.dataset.raw = msg;
                        el.textContent = msg;
                    } else {
                        this.addMessage('assistant', msg);
                    }
                    return;
                }
                const execResults = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_fetch.js'] });
                console.debug('handleFetchAndSend -> executeScript results', execResults);
                res = execResults && execResults[0] && execResults[0].result ? execResults[0].result : null;

                // 回退策略：若文件注入未返回结果，尝试直接注入内联函数读取 body
                if (!res) {
                    console.warn('content_fetch.js 未返回结果，尝试回退注入内联抓取函数');
                    const fallback = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            try {
                                const normalize = s => (s || '').replace(/\s+/g, ' ').trim();
                                const title = document.title || '';
                                const url = window.location.href || '';
                                const body = normalize(document.body ? document.body.innerText : '');
                                // 返回一个简单的 textBlocks 数组
                                return { title, url, textBlocks: body ? [body] : [] };
                            } catch (e) { return null; }
                        }
                    });
                    console.debug('handleFetchAndSend -> fallback results', fallback);
                    res = fallback && fallback[0] && fallback[0].result ? fallback[0].result : null;
                }

                if (!res) throw new Error('未获取到页面内容');

                const metaHeader = `${res.title || ''}\n${res.url || ''}\n\n`;
                const fullText = metaHeader + (Array.isArray(res.textBlocks) ? res.textBlocks.join('\n\n') : (res.text || ''));

                // 把“请用中文总结这个网页内容：”放在抓取到的页面内容开头，并作为 user 消息持久化与发送
                const userPrefix = '请用中文总结这个网页内容：\n\n';
                const userPrefixed = userPrefix + fullText;

                // 更新 UI：把正在抓取的占位替换为最终的 user 内容（直接修改 DOM，避免使用 updateMessageContent 覆盖 user 气泡导致创建 assistant 复制）
                const userEl = document.getElementById(placeholderId);
                if (userEl) {
                    userEl.dataset.raw = userPrefixed;
                    userEl.innerHTML = this.renderMessageHtml(userPrefixed);
                } else {
                    this.addMessage('user', userPrefixed);
                }

                // 持久化为 user 消息
                await this.appendMessageToActiveSession({ role: 'user', content: userPrefixed });

                // 在会话中追加一个占位的 assistant 消息（内容为空），以便后续通过流式更新定位并保存回复
                await this.appendMessageToActiveSession({ role: 'assistant', content: '' });

                // 在 UI 中显示 assistant 占位并记录 currentMessageId 以供流式更新使用
                this.currentMessageId = this.addMessage('assistant', '思考中...', true);

                // 将该会话消息的时间戳映射到 DOM 元素，便于后续更新时定位并保存（读取最后一条消息的 ts）
                const sessionAfter = await this.loadSession(this.activeSessionId);
                if (sessionAfter && Array.isArray(sessionAfter.messages) && sessionAfter.messages.length) {
                    const last = sessionAfter.messages[sessionAfter.messages.length - 1];
                    const el = document.getElementById(this.currentMessageId);
                    if (el && last) el.dataset.sessionTs = String(last.ts);
                }

                // 构建发送给后台的 messages（沿用已有截断/摘要策略）并发送
                const messagesForChat = this.buildMessagesForChat((await this.loadSession(this.activeSessionId)).messages);
                console.debug('handleFetchAndSend -> sending sendChat with messages length', messagesForChat.length);
                // 生成 requestId 并保存，显示停止按钮
                const requestId = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
                this._currentRequestId = requestId;
                this.setStopButtonVisible(true);

                const bgResp = await this.sendMessageToBackground('sendChat', {
                    url: this.settings.ollamaUrl,
                    model: this.currentModel,
                    messages: messagesForChat,
                    stream: this.settings.enableStreaming,
                    requestId: requestId
                });
                console.debug('handleFetchAndSend -> background response', bgResp);

            } catch (e) {
                console.error('抓取失败:', e);
                this.updateMessageContent(placeholderId, `抓取失败: ${e && e.message ? e.message : String(e)}`);
            }

        } catch (err) {
            console.error('handleFetchAndSend error:', err);
        }
    }

    toggleSettings() {
        if (!this.settingsPanel) return;
        const panel = this.settingsPanel;
        const isHidden = panel.classList.contains('hidden');
        if (isHidden) {
            // 将面板移动到 document.body 以避免被父级毛玻璃或 overflow 影响（portal）
            try {
                if (panel.parentElement !== document.body) {
                    panel._origParent = panel.parentElement;
                    panel._origNextSibling = panel.nextSibling;
                    document.body.appendChild(panel);
                }
            } catch (e) { /* ignore */ }

            panel.classList.remove('hidden');
            panel.style.display = 'block';
            panel.style.zIndex = '9999';
            panel.setAttribute('aria-hidden', 'false');
            try { this.settingsBtn.setAttribute('aria-expanded', 'true'); } catch (e) { /* ignore */ }
            try { this.adjustFloatingPanelPosition(panel, this.settingsBtn); } catch (e) { /* ignore */ }
        } else {
            panel.classList.add('hidden');
            panel.style.display = '';
            panel.style.zIndex = '';
            panel.setAttribute('aria-hidden', 'true');
            try { this.settingsBtn.setAttribute('aria-expanded', 'false'); } catch (e) { /* ignore */ }
            // 如之前移动过，尝试还原到原始父节点
            try {
                if (panel._origParent) {
                    const parent = panel._origParent;
                    const next = panel._origNextSibling;
                    if (next) parent.insertBefore(panel, next); else parent.appendChild(panel);
                    panel._origParent = null;
                    panel._origNextSibling = null;
                }
            } catch (e) { /* ignore */ }
        }
    }

    hideSettings() {
        if (!this.settingsPanel) return;
        this.settingsPanel.classList.add('hidden');
        this.settingsPanel.style.display = '';
        this.settingsPanel.style.zIndex = '';
        try { this.settingsPanel.setAttribute('aria-hidden', 'true'); } catch (e) { /* ignore */ }
        try { this.settingsBtn.setAttribute('aria-expanded', 'false'); } catch (e) { /* ignore */ }
        // 如之前移动过，尝试还原到原始父节点
        try {
            const panel = this.settingsPanel;
            if (panel._origParent) {
                const parent = panel._origParent;
                const next = panel._origNextSibling;
                if (next) parent.insertBefore(panel, next); else parent.appendChild(panel);
                panel._origParent = null;
                panel._origNextSibling = null;
            }
        } catch (e) { /* ignore */ }
    }

    // 计算并调整任意浮层面板（如 settingsPanel）的显示位置，使其靠近对应按钮并避免溢出
    adjustFloatingPanelPosition(panel, anchorBtn) {
        if (!panel || !anchorBtn) return;
        try {
            const btnRect = anchorBtn.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            const viewportW = document.documentElement.clientWidth || window.innerWidth;
            const viewportH = document.documentElement.clientHeight || window.innerHeight;

            // 默认左对齐按钮左侧
            let left = Math.max(8, btnRect.left);
            // 如果会溢出右侧，则右对齐到按钮右侧
            if (left + panelRect.width + 8 > viewportW) {
                left = Math.max(8, btnRect.right - panelRect.width);
            }

            // 优先放在按钮下方，否则放在上方
            let top = btnRect.bottom + 8;
            if (top + panelRect.height + 8 > viewportH) {
                top = Math.max(8, btnRect.top - panelRect.height - 8);
            }

            // 采用 absolute 定位，使 panel 相对于文档定位
            panel.style.position = 'absolute';
            panel.style.left = `${Math.round(left)}px`;
            panel.style.top = `${Math.round(top)}px`;
            panel.style.right = 'auto';
        } catch (e) {
            console.warn('adjustFloatingPanelPosition failed:', e);
        }
    }

    updateStatus(status, text) {
        this.statusIndicator.className = `status-indicator ${status}`;
        this.statusText.textContent = text;
    }

    async testConnection() {
        this.updateStatus('connecting', '连接中...');

        try {
            const response = await this.sendMessageToBackground('testConnection', {
                url: this.settings.ollamaUrl
            });

            if (response && response.success) {
                this.updateStatus('connected', '已连接');
                await this.loadModels();
                // 不再在打开插件时自动创建或加载会话，直到用户选择模型
                await this.refreshSessionSelect();
            } else {
                throw new Error((response && response.message) ? response.message : '后台无响应');
            }
        } catch (error) {
            console.error('连接测试失败:', error);
            this.updateStatus('disconnected', '连接失败');
            this.modelSelect.innerHTML = '<option value="">选择模型...</option>';
        }
    }

    async loadModels() {
        try {
            const response = await this.sendMessageToBackground('getModels', {
                url: this.settings.ollamaUrl
            });

            if (response && response.success) {
                this.populateModelSelect(response.models);
                // 如果之前保存了默认模型并在列表中存在，选择它
                try {
                    if (this._storedDefaultModel && this._storedDefaultModel.length) {
                        const found = response.models.find(m => m.name === this._storedDefaultModel);
                        if (found && this.modelSelect) {
                            this.modelSelect.value = this._storedDefaultModel;
                            // 触发 change 处理以同步 UI 状态
                            const ev = new Event('change');
                            this.modelSelect.dispatchEvent(ev);
                        }
                    }
                } catch (e) { /* ignore */ }
            } else {
                throw new Error((response && response.message) ? response.message : '后台无响应');
            }
        } catch (error) {
            console.error('加载模型失败:', error);
        } finally {
            // 模型列表加载后，初始化交互状态（若未选择模型则禁用输入）
            this.updateInteractionState();
            // 更新模型上下文显示（若已选模型则根据映射显示）
            this.updateModelContextDisplay();
            // 刷新 token 统计
            this.refreshTokenStats();
        }
    }

    // 根据模型名映射最大上下文长度并显示
    updateModelContextDisplay() {
        const map = {
            'deepseek-r1:1.5b': '128k',
            'deepseek-v3.1:671b-cloud': '160k',
            'gpt-oss:120b-cloud': '128k',
            'gpt-oss:20b-cloud': '128k',
            'qwen3-coder:480b-cloud': '256k',
            'kimi-k2:1t-cloud': '256k',
            'gemma3:270m': '32k',
            'gemma3:1b': '32k',
            'gemma3:4b': '128k',
            'qwen3:0.6b': '40k',
            'qwen3:1.7b': '40k',
            'qwen3:4b': '256k'
        };
        const val = map[this.currentModel] || '未知';
        if (this.modelContextValue) this.modelContextValue.textContent = val;
        return val;
    }

    // 简易 token 估算：按空格分词，作为占位估算
    estimateTokensFromText(text) {
        if (!text) return 0;
        // 把连续空白视为分隔
        const parts = String(text).trim().split(/\s+/);
        return parts.filter(p => p.length > 0).length;
    }

    // 计算下一回合的预估 tokens（历史 + 当前输入），并在底部显示预览与估算
    async refreshTokenStats() {
        try {
            let total = 0;
            if (this.activeSessionId) {
                const session = await this.loadSession(this.activeSessionId);
                if (session && Array.isArray(session.messages)) {
                    for (const m of session.messages) {
                        total += this.estimateTokensFromText(m.content || '');
                    }
                }
            }
            const input = this.messageInput ? this.messageInput.value || '' : '';
            const nextTurn = total + this.estimateTokensFromText(input);

            // 更新消耗 tokens（以 k 为单位显示，保留一位小数）
            if (this.nextTurnTokensEl) this.nextTurnTokensEl.textContent = `${(nextTurn/1024).toFixed(1)}k`;
        } catch (e) {
            console.warn('刷新 token 统计失败:', e);
        }
    }

    // 刷新并显示当前会话累计已消耗 tokens（从 session.tokenUsage 读取）
    async refreshSessionConsumedTokens() {
        try {
            let consumed = 0;
            if (this.activeSessionId) {
                const session = await this.loadSession(this.activeSessionId);
                if (session && typeof session.tokenUsage === 'number') consumed = session.tokenUsage;
            }
            // 以 k 为单位显示
            if (this.sessionConsumedTokensEl) this.sessionConsumedTokensEl.textContent = `${((consumed||0)/1024).toFixed(1)}k`;
        } catch (e) {
            console.warn('刷新会话已消耗 tokens 失败:', e);
        }
    }

    populateModelSelect(models) {
        this.modelSelect.innerHTML = '<option value="">选择模型...</option>';
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.name;
            option.textContent = model.name;
            this.modelSelect.appendChild(option);
        });
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) return;

        if (!this.currentModel) {
            alert('请先选择一个模型');
            return;
        }

        // 确保存在活动会话
        await this.ensureActiveSession();

        console.log('选择的模型:', this.currentModel);
        console.log('发送的消息:', message);

        // 添加用户消息到UI
        this.addMessage('user', message);
        this.messageInput.value = '';
        // 发送后刷新 token 统计
        this.refreshTokenStats();

        // 先在 UI 中显示助手占位
        this.currentMessageId = this.addMessage('assistant', '思考中...', true);

        try {
            // 先将用户消息追加到会话并持久化（保持会话内顺序为 user -> assistant）
            await this.appendMessageToActiveSession({ role: 'user', content: message });

            // 在会话中追加一个占位的助手消息（内容为空），以便后续更新时能保存到会话
            await this.appendMessageToActiveSession({ role: 'assistant', content: '' });

            // 发送完用户消息后，立即覆盖保存一次当前会话（自动保存点1）
            await this.saveSession(await this.loadSession(this.activeSessionId));

            // 将该会话消息的时间戳映射到 DOM 元素，便于后续更新时定位并保存（读取最后一条消息的 ts）
            const session = await this.loadSession(this.activeSessionId);
            if (session && Array.isArray(session.messages) && session.messages.length) {
                const last = session.messages[session.messages.length - 1];
                const el = document.getElementById(this.currentMessageId);
                if (el && last) el.dataset.sessionTs = String(last.ts);
            }

            // 组装上下文（截断最近 N 条）
            const sessionForChat = await this.loadSession(this.activeSessionId);
            const messagesForChat = this.buildMessagesForChat(sessionForChat.messages);

            // 在发送请求前刷新一次 token 统计（更准确地反映下一回合）
            await this.refreshTokenStats();

            // 生成 requestId 并保存
            const requestId = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
            this._currentRequestId = requestId;
            // 在 UI 中显示停止按钮
            this.setStopButtonVisible(true);

            const response = await this.sendMessageToBackground('sendChat', {
                url: this.settings.ollamaUrl,
                model: this.currentModel,
                messages: messagesForChat,
                stream: this.settings.enableStreaming
                , requestId: requestId
            });
            if (!response || !response.success) {
                throw new Error((response && response.message) ? response.message : '后台无响应');
            }
            // 流式响应将通过 message listener 处理并在完成时更新会话中的占位消息
        } catch (error) {
            console.error('发送消息失败:', error);
            // 移除占位 DOM 并显示错误气泡
            this.removeMessage(this.currentMessageId);
            this.addMessage('assistant', `错误: ${error.message}`);
            this.currentMessageId = null;
            this._currentRequestId = null;
            this.setStopButtonVisible(false);
        }
    }

    async handleStreamUpdate(request) {
        if (request.chunk && this.currentMessageId) {
            // 添加流式响应样式类
            const messageElement = document.getElementById(this.currentMessageId);
            if (messageElement) {
                messageElement.classList.add('streaming');
                // 添加打字机光标效果
                messageElement.classList.add('typing');
            }

            this.updateMessageContent(this.currentMessageId, request.chunk);
        }

        if (request.done) {
            // 移除流式样式
            const messageElement = document.getElementById(this.currentMessageId);
            if (messageElement) {
                messageElement.classList.remove('streaming', 'typing');
            }

            if (request.fullResponse) {
                try {
                    // 优先尝试根据 DOM 元素上记录的 sessionTs 更新会话中对应的占位消息，实现自动保存
                    const el = document.getElementById(this.currentMessageId);
                    const sessionTs = el ? el.dataset.sessionTs : null;
                    if (sessionTs) {
                        await this.updateSessionMessageByTs(Number(sessionTs), request.fullResponse);
                    } else {
                        // fallback：找最后一条空内容的 assistant 消息并更新
                        await this.updateLastAssistantPlaceholder(request.fullResponse);
                    }
                    // 在模型返回并会话更新后，立即覆盖保存一次当前会话（自动保存点2）
                    await this.saveSession(await this.loadSession(this.activeSessionId));
                    await this.refreshSessionTimestamps();

                    // 若 background 发送了精确 token 信息，更新底部显示（优先使用精确值）并累加到会话的 tokenUsage
                    if (typeof request.totalTokens === 'number' || typeof request.promptTokens === 'number' || typeof request.genTokens === 'number') {
                        const total = typeof request.totalTokens === 'number' ? request.totalTokens : ((request.promptTokens || 0) + (request.genTokens || 0));
                        if (this.nextTurnTokensEl) this.nextTurnTokensEl.textContent = `${(((total||0)/1024)).toFixed(1)}k`;
                        try {
                            // 累加到当前会话并持久化
                            if (this.activeSessionId) {
                                const session = await this.loadSession(this.activeSessionId);
                                if (session) {
                                    session.tokenUsage = (session.tokenUsage || 0) + (total || 0);
                                    await this.saveSession(session);
                                    await this.refreshSessionConsumedTokens();
                                }
                            }
                        } catch (e) { console.warn('累加会话 tokenUsage 失败:', e); }
                    } else {
                        // fallback：使用本地估算
                        await this.refreshTokenStats();
                    }
                } catch (e) {
                    console.error('保存助手消息失败:', e);
                    // 若更新失败，退回到追加行为以确保会话中至少有完整的回答
                    try { await this.appendMessageToActiveSession({ role: 'assistant', content: request.fullResponse }); } catch (err) { console.error('append fallback failed:', err); }
                }
            }
            this.currentMessageId = null;
            // 请求完成后隐藏停止按钮并清理 requestId
            this._currentRequestId = null;
            this.setStopButtonVisible(false);
        }
    }

    // 根据时间戳更新会话中对应消息的内容并保存
    async updateSessionMessageByTs(ts, newContent) {
        if (!this.activeSessionId) await this.ensureActiveSession();
        const session = await this.loadSession(this.activeSessionId);
        if (!session || !Array.isArray(session.messages)) return;
        const idx = session.messages.findIndex(m => m.ts === ts && m.role === 'assistant');
        if (idx !== -1) {
            session.messages[idx].content = newContent;
            session.messages[idx].ts = session.messages[idx].ts || Date.now();
            await this.saveSession(session);
            return;
        }
        // 若未找到匹配项则抛出以触发 fallback
        throw new Error('未找到匹配的会话消息用于更新');
    }

    // 回退方案：更新最后一条空占位的 assistant 消息
    async updateLastAssistantPlaceholder(newContent) {
        if (!this.activeSessionId) await this.ensureActiveSession();
        const session = await this.loadSession(this.activeSessionId);
        if (!session || !Array.isArray(session.messages)) return;
        for (let i = session.messages.length - 1; i >= 0; i--) {
            const m = session.messages[i];
            if (m.role === 'assistant' && (!m.content || m.content === '')) {
                session.messages[i].content = newContent;
                session.messages[i].ts = session.messages[i].ts || Date.now();
                await this.saveSession(session);
                return;
            }
        }
        // 若仍找不到，则追加一条
        await this.appendMessageToActiveSession({ role: 'assistant', content: newContent });
    }

    handleStreamError(request) {
        console.error('流式响应错误:', request.error);
        if (this.currentMessageId) {
            this.removeMessage(this.currentMessageId);
            this.addMessage('assistant', `流式响应错误: ${request.error}`);
            this.currentMessageId = null;
            this._currentRequestId = null;
            this.setStopButtonVisible(false);
        }
    }

    sendMessageToBackground(action, data) {
        // 超时保护：避免消息通道挂起导致永远等待
        const TIMEOUT_MS = 10000;
        console.debug('sendMessageToBackground -> sending', { action, data });
        return new Promise((resolve) => {
            let finished = false;
            const timer = setTimeout(() => {
                if (!finished) {
                    finished = true;
                    console.warn('sendMessageToBackground -> timeout', { action, data });
                    resolve({ success: false, message: '后台响应超时' });
                }
            }, TIMEOUT_MS);

            try {
                chrome.runtime.sendMessage({ action: action, ...data }, (response) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) {
                        console.error('sendMessageToBackground -> chrome.runtime.lastError', chrome.runtime.lastError);
                        resolve({ success: false, message: chrome.runtime.lastError.message });
                    } else {
                        console.debug('sendMessageToBackground -> received response', response);
                        resolve(response);
                    }
                });
            } catch (err) {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    console.error('sendMessageToBackground -> exception', err);
                    resolve({ success: false, message: err && err.message ? err.message : String(err) });
                }
            }
        });
    }

    addMessage(role, content, isTemp = false) {
        const messageDiv = document.createElement('div');
        // 更可靠的唯一ID，避免在高并发下 Date.now() 碰撞导致消息覆盖
        const messageId = 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
        messageDiv.id = messageId;
        messageDiv.className = `message ${role} ${isTemp ? 'loading' : ''}`;
        // 为了支持 Markdown 渲染与流式追加，辅以原始内容缓存
        messageDiv.dataset.raw = content || '';
        // 初始渲染为纯文本以避免 XSS，后续会使用 renderMessageHtml 受控转换
        messageDiv.textContent = content;

        this.messagesDiv.appendChild(messageDiv);
        this.scrollToBottom();

        return messageId;
    }

    removeMessage(messageId) {
        const messageElement = document.getElementById(messageId);
        if (messageElement) {
            messageElement.remove();
        }
    }

    updateMessageContent(messageId, newContent) {
        let messageElement = document.getElementById(messageId);
        if (!messageElement) {
            console.warn('updateMessageContent: target message element not found, creating new assistant message', messageId);
            // 目标元素不存在，创建新的 assistant 消息并使用新的 id
            const newId = this.addMessage('assistant', newContent);
            // 由于 addMessage 会滚动到底部，直接返回
            return newId;
        }

        // 如果 found element 不是 assistant（可能因 id 冲突或渲染替换），不要往 user 气泡追加
        if (!messageElement.classList.contains('assistant')) {
            console.warn('updateMessageContent: target element is not assistant, creating new assistant message to avoid overwriting user message', { messageId });
            const newId = this.addMessage('assistant', newContent);
            return newId;
        }

        // 移除"加载中"样式
        messageElement.classList.remove('loading');

        // 使用 data-raw 缓存完整原始文本以便最终渲染为 HTML
        const prevRaw = messageElement.dataset.raw || '';
        const updatedRaw = prevRaw === '思考中...' ? newContent : (prevRaw + newContent);
        messageElement.dataset.raw = updatedRaw;

        // 先以纯文本追加，最后由 renderMessageHtml 进行受控的 Markdown -> HTML 转换
        // 这里我们直接调用渲染函数以便即时显示格式化内容
        messageElement.innerHTML = this.renderMessageHtml(updatedRaw);
        this.scrollToBottom();
    }

    scrollToBottom() {
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    async handleClearConversation() {
        try {
            // 旧的 "清空对话" 行为改为“新建会话并保存当前会话”。
            await this.ensureActiveSession();
            // 在新建之前保存当前会话（覆盖保存）
            const curSession = await this.loadSession(this.activeSessionId);
            if (curSession) await this.saveSession(curSession);
            const currentModel = this.currentModel;
            const newSessionId = await this.createSession({ model: currentModel, name: this.defaultSessionName(currentModel) });
            await this.setActiveSession(newSessionId);
            await this.refreshSessionSelect();
            this.clearConversationUI();
        } catch (e) {
            console.error('清空对话失败:', e);
        }
    }

    clearConversationUI() {
        this.messagesDiv.innerHTML = '';
        this.conversationHistory = [];
        this.currentMessageId = null;
    }

    // ===== 会话相关：存储与管理 =====

    // 生成默认会话名
    defaultSessionName(model) {
        const d = new Date();
        const pad = (n) => (n < 10 ? '0' + n : '' + n);
        return `${model || '未选模型'}_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // 简易UUID
    uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async loadSessionIndex() {
        const result = await chrome.storage.local.get([this.sessionIndexKey]);
        if (result && result[this.sessionIndexKey]) return result[this.sessionIndexKey];
        const index = { sessions: [], lastActiveSessionId: null };
        await chrome.storage.local.set({ [this.sessionIndexKey]: index });
        return index;
    }

    // 获取一个基于 sessionId 锁的 Promise 队列入口
    async _acquireSessionLock(sessionId) {
        const key = sessionId || '__index__';
        const prev = this._sessionLocks[key] || Promise.resolve();
        let release;
        const p = new Promise((resolve) => { release = resolve; });
        // 新的锁链由 prev.then(() => p)
        this._sessionLocks[key] = prev.then(() => p);
        // 返回释放函数，调用后允许下一个等待者继续
        return () => { release(); };
    }

    async saveSessionIndex(index) {
        // 直接写入索引（调用方应在需要时获取索引锁以保证原子性）
        await chrome.storage.local.set({ [this.sessionIndexKey]: index });
    }

    async loadSession(id) {
        const key = this.sessionKeyPrefix + id;
        // 优先从持久化存储加载
        const result = await chrome.storage.local.get([key]);
        if (result && result[key]) return result[key];
        // 若未持久化但存在内存临时会话则返回该对象
        if (this._unsavedSessions && this._unsavedSessions[id]) return this._unsavedSessions[id];
        return null;
    }

    async saveSession(session) {
        const key = this.sessionKeyPrefix + session.id;
        session.updatedAt = Date.now();
        // 使用会话级锁，确保对同一 session 的并发写入按序执行
        const release = await this._acquireSessionLock(session.id);
        try {
            // 如果会话没有任何消息（仅创建但未写入用户消息），则不持久化
            const hasNonEmpty = Array.isArray(session.messages) && session.messages.some(m => m && m.content && m.content.trim() !== '');
            if (!hasNonEmpty) {
                // 将会话保存在内存临时结构，避免丢失未保存状态，但不写入 storage
                if (!this._unsavedSessions) this._unsavedSessions = {};
                this._unsavedSessions[session.id] = session;
            } else {
                // 正常持久化
                await chrome.storage.local.set({ [key]: session });
                // 持久化后若存在内存临时副本则删除
                if (this._unsavedSessions && this._unsavedSessions[session.id]) delete this._unsavedSessions[session.id];
            }
        } finally {
            release();
        }
    }

    async deleteSession(id) {
        const key = this.sessionKeyPrefix + id;
        // 使用会话锁防止删除与其他写入冲突
        const releaseSession = await this._acquireSessionLock(id);
        const releaseIndex = await this._acquireSessionLock();
        try {
            await chrome.storage.local.remove([key]);
            const index = await this.loadSessionIndex();
            index.sessions = index.sessions.filter(sid => sid !== id);
            if (index.lastActiveSessionId === id) index.lastActiveSessionId = index.sessions.length ? index.sessions[0] : null;
            await this.saveSessionIndex(index);
        } finally {
            releaseIndex();
            releaseSession();
        }
    }

    async createSession({ model, name }) {
        const id = this.uuid();
        const now = Date.now();
        const session = { id, name: name || this.defaultSessionName(model), model: model || '', createdAt: now, updatedAt: now, messages: [], tokenUsage: 0 };
        // 为确保一致性，先获得索引锁与会话锁，再执行保存与索引更新
        const releaseIndex = await this._acquireSessionLock();
        const releaseSession = await this._acquireSessionLock(id);
        try {
            await this.saveSession(session);
            const index = await this.loadSessionIndex();
            index.sessions.unshift(id);
            index.lastActiveSessionId = id;
            await this.saveSessionIndex(index);
        } finally {
            releaseSession();
            releaseIndex();
        }
        return id;
    }

    async setActiveSession(id) {
        const index = await this.loadSessionIndex();
        index.lastActiveSessionId = id;
        await this.saveSessionIndex(index);
        this.activeSessionId = id;
        const session = await this.loadSession(id);
        if (session && session.model) {
            // 同步模型选择器
            this.currentModel = session.model;
            if (this.modelSelect) this.modelSelect.value = session.model;
        }
        // 更新当前会话按钮文本
        if (this.currentSessionText && session) this.currentSessionText.textContent = session.name || '会话';
    }

    async ensureActiveSession() {
        const index = await this.loadSessionIndex();
        if (index.lastActiveSessionId) {
            this.activeSessionId = index.lastActiveSessionId;
            return;
        }
        const model = this.currentModel || '';
        const id = await this.createSession({ model, name: this.defaultSessionName(model) });
        this.activeSessionId = id;
    }

    async appendMessageToActiveSession(msg) {
        if (!this.activeSessionId) await this.ensureActiveSession();
        const session = await this.loadSession(this.activeSessionId);
        if (!session) return;
        session.messages.push({ role: msg.role, content: msg.content, ts: Date.now() });
        await this.saveSession(session);
        // 追加后评估上下文与容量
        await this.maybeWarnStorage();
    }

    buildMessagesForChat(allMessages) {
        // 简单策略：只取最近 N 条
        const msgs = Array.isArray(allMessages) ? allMessages : [];
        const sliced = msgs.slice(-this.maxMessagesToKeep);
        // 仅传递 role/content
        return sliced.map(m => ({ role: m.role, content: m.content }));
    }

    async refreshSessionTimestamps() {
        if (!this.activeSessionId) return;
        const session = await this.loadSession(this.activeSessionId);
        if (!session) return;
        await this.saveSession(session);
    }

    async refreshSessionSelect() {
        // 兼容性处理：将原生下拉的刷新调用路由到自定义的会话列表面板
        await this.refreshSessionListPanel();
    }

    // 根据是否已选择模型来启用或禁用输入/按钮
    updateInteractionState() {
        const enabled = !!this.currentModel;
        if (this.sendMessageBtn) this.sendMessageBtn.disabled = !enabled;
        if (this.newSessionBtn) this.newSessionBtn.disabled = !enabled;
        if (this.fetchAndSendBtn) this.fetchAndSendBtn.disabled = !enabled;
        if (this.messageInput) this.messageInput.disabled = !enabled;
        // 可视化提示：当无模型时输入框显示提示文案
        if (!enabled) {
            if (this.messageInput) this.messageInput.placeholder = '请先选择模型以启用对话';
        } else {
            if (this.messageInput) this.messageInput.placeholder = '输入您的问题...';
        }
    }

    // 判断给定 URL 是否允许注入脚本（排除 chrome://、chrome-extension://、webstore 等受限页面）
    isInjectableUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const lower = url.toLowerCase();
        // 常见受限 scheme
        if (lower.startsWith('chrome://') || lower.startsWith('chrome-extension://') || lower.startsWith('about:') || lower.startsWith('edge://')) return false;
        // Chrome Web Store 页面（不允许注入）
        if (lower.indexOf('chrome.google.com/webstore') !== -1) return false;
        // 浏览器设置页或扩展管理页
        if (lower.indexOf('extensions') !== -1 && (lower.startsWith('chrome://') || lower.indexOf('/extensions') !== -1)) return false;
        return true;
    }

    async renderActiveSessionMessages() {
        this.clearConversationUI();
        if (!this.activeSessionId) return;
        const session = await this.loadSession(this.activeSessionId);
        if (!session) return;
        // 同步模型下拉
        if (session.model) {
            this.currentModel = session.model;
            if (this.modelSelect) this.modelSelect.value = session.model;
        }
        // 渲染消息（支持 summaries 折叠显示）
        const summaries = Array.isArray(session.summaries) ? session.summaries : [];
        const hiddenRanges = [];
        for (const s of summaries) {
            if (typeof s.startIdx === 'number' && typeof s.endIdx === 'number') hiddenRanges.push([s.startIdx, s.endIdx, s]);
        }

        for (let i = 0; i < session.messages.length; i++) {
            const m = session.messages[i];
            // 检查当前 index 是否处于某个被摘要的范围的开始
            const startRange = hiddenRanges.find(r => r[0] === i);
            if (startRange) {
                const sMeta = startRange[2];
                // 插入摘要条目
                const summaryId = this.addMessage('system', `（已被摘要）${sMeta.summary}`);
                const el = document.getElementById(summaryId);
                if (el) {
                    el.classList.add('summary-item');
                    el.dataset.summaryId = sMeta.summaryId || '';
                    el.addEventListener('click', async () => {
                        // 展开原始范围：渲染原始消息并移除该摘要占位（用户可通过回滚操作恢复）
                        await this.renderOriginalRange(session.id, sMeta.startIdx, sMeta.endIdx);
                    });
                }
                // 跳过被摘要的原始消息范围
                i = startRange[1];
                continue;
            }
            const addedId = this.addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content);
            // 初始渲染历史消息时使用 Markdown -> HTML 受控渲染
            try {
                const el = document.getElementById(addedId);
                if (el) el.innerHTML = this.renderMessageHtml(m.content);
            } catch (e) { /* ignore */ }
        }
        // 渲染完会话消息后，更新会话已消耗 tokens 显示
        try { await this.refreshSessionConsumedTokens(); } catch (e) { console.warn('refreshSessionConsumedTokens failed', e); }
    }

    // 展示原始范围的消息（用于展开摘要）
    async renderOriginalRange(sessionId, startIdx, endIdx) {
        try {
            const session = await this.loadSession(sessionId);
            if (!session) return;
            // 清空当前 UI 并重渲染，插入原始范围的消息为未折叠状态
            this.clearConversationUI();
            for (let i = 0; i < session.messages.length; i++) {
                const m = session.messages[i];
                if (i >= startIdx && i <= endIdx) {
                    // 直接渲染原始消息
                    this.addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content);
                } else {
                    // 其他消息照常渲染（注意：若存在其他 summaries，本函数暂按简单方式处理）
                    this.addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content);
                }
            }
        } catch (e) {
            console.error('renderOriginalRange failed:', e);
        }
    }

    async updateActiveSessionModel(model) {
        if (!this.activeSessionId) return;
        const session = await this.loadSession(this.activeSessionId);
        if (!session) return;
        session.model = model || '';
        await this.saveSession(session);
    }

    // ===== 会话相关：交互事件 =====

    async handleSessionSwitch() {
        const id = this.sessionSelect.value;
        if (!id) return;
        await this.setActiveSession(id);
        await this.renderActiveSessionMessages();
    }

    async handleNewSession() {
        const model = this.currentModel || '';
        const id = await this.createSession({ model, name: this.defaultSessionName(model) });
        await this.setActiveSession(id);
        await this.refreshSessionSelect();
        await this.renderActiveSessionMessages();
    }

    // 新建会话，但先保存当前会话再新建（供新建按钮使用）
    async handleNewSessionButSavePrevious() {
        await this.ensureActiveSession();
        const cur = await this.loadSession(this.activeSessionId);
        if (cur) await this.saveSession(cur);
        await this.handleNewSession();
    }

    async handleRenameSession() {
        if (!this.activeSessionId) return;
        const session = await this.loadSession(this.activeSessionId);
        if (!session) return;
        const name = prompt('输入新的会话名称：', session.name || '');
        if (name && name.trim()) {
            session.name = name.trim();
            await this.saveSession(session);
            await this.refreshSessionSelect();
        }
    }

    async handleDeleteSession() {
        if (!this.activeSessionId) return;
        const ok = confirm('确定删除当前会话？该操作不可恢复');
        if (!ok) return;
        const toDelete = this.activeSessionId;
        await this.deleteSession(toDelete);
        const index = await this.loadSessionIndex();
        this.activeSessionId = index.lastActiveSessionId;
        await this.refreshSessionSelect();
        await this.renderActiveSessionMessages();
    }

    async handleExportCurrentSession() {
        if (!this.activeSessionId) return;
        const session = await this.loadSession(this.activeSessionId);
        if (!session) return;
        const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.name || 'session'}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async handleExportAllSessions() {
        const index = await this.loadSessionIndex();
        const sessions = [];
        for (const id of index.sessions) {
            const s = await this.loadSession(id);
            if (s) sessions.push(s);
        }
        const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ollama_sessions.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ===== 容量与上下文估算（简版提醒） =====
    async estimateStorageUsageBytes() {
        const index = await this.loadSessionIndex();
        const sessions = [];
        for (const id of index.sessions) {
            const s = await this.loadSession(id);
            if (s) sessions.push(s);
        }
        const json = JSON.stringify({ index, sessions });
        return new Blob([json]).size;
    }

    async maybeWarnStorage() {
        try {
            const used = await this.estimateStorageUsageBytes();
            // 经验阈值：45MB 警告（浏览器实现可能不同，这里仅作提醒）
            const warnThreshold = 45 * 1024 * 1024;
            if (used > warnThreshold) {
                this.updateStatus('connecting', `存储接近上限（≈${(used/1024/1024).toFixed(1)}MB）`);
            }
        } catch (e) {
            console.warn('容量估算失败:', e);
        }
    }

    toggleSessionMenu(e) {
        // 隐藏其他菜单
        this.hideSessionList();
        this.hideSettings();

        // 切换会话菜单
        if (!this.sessionMenu) return;
        const isHidden = this.sessionMenu.classList.contains('hidden');
        if (isHidden) {
            this.sessionMenu.classList.remove('hidden');
            // 为菜单项添加事件监听器
            this.attachSessionMenuEvents();
        } else {
            this.sessionMenu.classList.add('hidden');
            this.detachSessionMenuEvents();
        }
    }

    toggleSessionList() {
        // 隐藏其他菜单
        this.hideSessionMenu();
        this.hideSettings();

        if (!this.sessionListPanel) return;
        const panel = this.sessionListPanel;
        const isHidden = panel.classList.contains('hidden');
        if (isHidden) {
            console.debug('Showing session list panel (inline dropdown)');
            // refreshSessionListPanel may be async; call it and ignore await to keep this method sync
            this.refreshSessionListPanel().then(() => {
                // 为避免被父级的毛玻璃影响，将 panel 暂时移动到 document.body（portal），与 settingsPanel 相同的层级
                try {
                    if (panel.parentElement !== document.body) {
                        // 记录原始位置以便关闭时还原
                        panel.dataset._orig_parent_id = '1';
                        panel.dataset._had_parent = '1';
                        panel._origParent = panel.parentElement;
                        panel._origNextSibling = panel.nextSibling;
                        document.body.appendChild(panel);
                    }
                } catch (e) { /* ignore */ }

                panel.classList.remove('hidden');
                // 与 settings 面板一致的显示样式
                panel.style.display = 'flex';
                panel.style.zIndex = '9999';
                panel.setAttribute('aria-hidden', 'false');
                // 使用绝对定位并靠近触发按钮
                panel.style.position = 'absolute';
                this.adjustFloatingPanelPosition(panel, this.currentSessionBtn);
                // 提升渲染上下文，避免被 backdrop-filter 影响
                panel.style.backdropFilter = 'none';
                panel.style.webkitBackdropFilter = 'none';
                panel.style.filter = 'none';
            }).catch((e) => { console.warn('refreshSessionListPanel failed:', e); panel.classList.remove('hidden'); });
        } else {
            console.debug('Hiding session list panel');
            panel.classList.add('hidden');
            panel.style.display = '';
            panel.style.zIndex = '';
            panel.setAttribute('aria-hidden', 'true');
            // 若之前移动到了 document.body，则还原到原始父节点
            try {
                if (panel._origParent) {
                    const parent = panel._origParent;
                    const next = panel._origNextSibling;
                    if (next) parent.insertBefore(panel, next); else parent.appendChild(panel);
                    // 清理临时引用
                    panel._origParent = null;
                    panel._origNextSibling = null;
                    delete panel.dataset._had_parent;
                }
            } catch (e) { /* ignore */ }
        }
    }

    hideSessionMenu() {
        if (!this.sessionMenu) return;
        this.sessionMenu.classList.add('hidden');
        this.detachSessionMenuEvents();
    }

    hideSessionList() {
        if (!this.sessionListPanel) return;
        this.sessionListPanel.classList.add('hidden');
        // 重置样式
        try {
            this.sessionListPanel.style.display = '';
            this.sessionListPanel.style.zIndex = '';
        } catch (e) { /* ignore */ }
        // 移除遮罩（如存在）
        if (this._sessionListBackdrop) {
            try { this._sessionListBackdrop.remove(); } catch (e) { /* ignore */ }
            this._sessionListBackdrop = null;
        }
    }

    attachSessionMenuEvents() {
        if (!this.sessionMenu) return;
        const menuItems = this.sessionMenu.querySelectorAll('.session-menu-item');
        menuItems.forEach(item => {
            item.addEventListener('click', (e) => this.handleSessionMenuAction(e));
        });
    }

    detachSessionMenuEvents() {
        if (!this.sessionMenu) return;
        const menuItems = this.sessionMenu.querySelectorAll('.session-menu-item');
        menuItems.forEach(item => {
            item.removeEventListener('click', (e) => this.handleSessionMenuAction(e));
        });
    }

    handleSessionMenuAction(e) {
        const action = e.currentTarget.dataset.action;
        this.hideSessionMenu();

        switch (action) {
            case 'new':
                this.handleNewSession();
                break;
            case 'rename':
                this.handleRenameSession();
                break;
            case 'export':
                this.handleExportCurrentSession();
                break;
            case 'delete':
                this.handleDeleteSession();
                break;
        }
    }

    handleGlobalClickForMenus(e) {
        // 检查是否点击在任何菜单区域内
        const withinSessionMenu = this.sessionMenu && this.sessionMenu.contains(e.target);
        const withinSessionList = this.sessionListPanel && this.sessionListPanel.contains(e.target);
        const withinCurrentSessionBtn = this.currentSessionBtn && this.currentSessionBtn.contains(e.target);

        if (!withinSessionMenu && !withinSessionList && !withinCurrentSessionBtn) {
            this.hideSessionMenu();
            this.hideSessionList();
        }
    }

    async refreshSessionListPanel() {
        if (!this.sessionListPanel) return;
        this.sessionListPanel.innerHTML = '';
        const index = await this.loadSessionIndex();
        for (const id of index.sessions) {
            const s = await this.loadSession(id);
            if (!s) continue;
            const item = document.createElement('div');
            item.className = 'session-item';
            const title = document.createElement('div');
            title.textContent = s.name || s.id;
            title.style.flex = '1';
            title.style.cursor = 'pointer';
            title.addEventListener('click', async () => {
                await this.setActiveSession(s.id);
                await this.renderActiveSessionMessages();
                this.hideSessionList();
                // 更新当前会话按钮文本
                if (this.currentSessionText) this.currentSessionText.textContent = s.name || '会话';
            });

            const controls = document.createElement('div');
            controls.className = 'item-controls';

            const btnRename = document.createElement('button');
            btnRename.className = 'session-icon-btn';
            btnRename.title = '重命名';
            btnRename.textContent = '✏️';
            btnRename.addEventListener('click', async (e) => { e.stopPropagation(); await this.renameSessionById(s.id); await this.refreshSessionListPanel(); });

            const btnDelete = document.createElement('button');
            btnDelete.className = 'session-icon-btn';
            btnDelete.title = '删除';
            btnDelete.textContent = '🗑️';
            btnDelete.addEventListener('click', async (e) => { e.stopPropagation(); await this.deleteSessionById(s.id); await this.refreshSessionListPanel(); });

            const btnExport = document.createElement('button');
            btnExport.className = 'session-icon-btn';
            btnExport.title = '导出';
            btnExport.textContent = '⬇️';
            btnExport.addEventListener('click', async (e) => { e.stopPropagation(); await this.exportSessionById(s.id); });

            controls.appendChild(btnRename);
            controls.appendChild(btnDelete);
            controls.appendChild(btnExport);

            item.appendChild(title);
            item.appendChild(controls);
            this.sessionListPanel.appendChild(item);
        }
        // 设置当前会话按钮文本
        const index2 = await this.loadSessionIndex();
        if (index2.lastActiveSessionId) {
            const cur = await this.loadSession(index2.lastActiveSessionId);
            if (this.currentSessionText && cur) this.currentSessionText.textContent = cur.name || '会话';
        }
    }

    // 计算并调整会话列表位置，避免水平溢出
    adjustSessionListPosition() {
        if (!this.sessionListPanel || !this.currentSessionBtn) return;
        try {
            const panel = this.sessionListPanel;
            const btnRect = this.currentSessionBtn.getBoundingClientRect();
            const parentRect = panel.offsetParent ? panel.offsetParent.getBoundingClientRect() : document.documentElement.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            const popupWidth = document.documentElement.clientWidth || window.innerWidth;

            // 计算相对于 offsetParent 的左偏移
            let desiredLeft = btnRect.left - parentRect.left;

            // 最大左偏移，确保面板不会超出右侧边界（保留 8px 边距）
            const maxLeft = Math.max(8, popupWidth - 8 - panelRect.width - parentRect.left);

            // 取合适的位置
            let left = Math.max(8, Math.min(desiredLeft, maxLeft));

            // 如果空间更适合右对齐，则使用 right:8px
            if (left > (btnRect.left - parentRect.left + 8)) {
                panel.style.left = `${left}px`;
                panel.style.right = 'auto';
            } else {
                // 优先右对齐，避免覆盖按钮
                panel.style.right = '8px';
                panel.style.left = 'auto';
            }
        } catch (e) {
            console.warn('调整会话列表位置失败:', e);
        }
    }

    async renameSessionById(id) {
        const session = await this.loadSession(id);
        if (!session) return;
        const name = prompt('输入新的会话名称：', session.name || '');
        if (name && name.trim()) {
            session.name = name.trim();
            await this.saveSession(session);
            await this.refreshSessionSelect();
        }
    }

    async deleteSessionById(id) {
        const ok = confirm('确定删除该会话？该操作不可恢复');
        if (!ok) return;
        await this.deleteSession(id);
        const index = await this.loadSessionIndex();
        this.activeSessionId = index.lastActiveSessionId;
        await this.refreshSessionSelect();
        if (this.activeSessionId) await this.renderActiveSessionMessages(); else this.clearConversationUI();
    }

    async exportSessionById(id) {
        const session = await this.loadSession(id);
        if (!session) return;
        const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${session.name || 'session'}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

}

document.addEventListener('DOMContentLoaded', () => {
    new ChromeChatAssistant();
});
