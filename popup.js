class OllamaAssistant {
    constructor() {
        this.settings = {
            ollamaUrl: 'http://localhost:11434',
            enableStreaming: true
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

        // 行内代码
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
            const safeUrl = this.escapeHtml(url);
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        });

        const lines = s.split(/\r?\n/);
        let inList = false;
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const m = line.match(/^\s*[-*+]\s+(.*)$/);
            if (m) {
                if (!inList) { out.push('<ul>'); inList = true; }
                out.push(`<li>${m[1]}</li>`);
            } else {
                if (inList) { out.push('</ul>'); inList = false; }
                if (line.trim() === '') out.push('<br>'); else out.push(`<p>${line}</p>`);
            }
        }
        if (inList) out.push('</ul>');
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
        this.testConnectionBtn = document.getElementById('testConnection');
        this.saveSettingsBtn = document.getElementById('saveSettings');

        // 对话相关
        this.chatContainer = document.getElementById('chatContainer');
        this.messagesDiv = document.getElementById('messages');
        this.messageInput = document.getElementById('messageInput');
        this.sendMessageBtn = document.getElementById('sendMessage');
        this.clearChatBtn = document.getElementById('clearChat');
    }

    setupMessageListeners() {
        // 监听来自background script的流式更新
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'streamUpdate') {
                this.handleStreamUpdate(request);
            } else if (request.action === 'streamError') {
                this.handleStreamError(request);
            }
        });
    }



    async loadSettings() {
        const result = await chrome.storage.local.get(['ollamaSettings']);
        if (result.ollamaSettings) {
            this.settings = { ...this.settings, ...result.ollamaSettings };
            this.ollamaUrlInput.value = this.settings.ollamaUrl;
            this.enableStreamingCheckbox.checked = this.settings.enableStreaming;
        }
    }

    async saveSettings() {
        this.settings.ollamaUrl = this.ollamaUrlInput.value;
        this.settings.enableStreaming = this.enableStreamingCheckbox.checked;
        await chrome.storage.local.set({
            ollamaSettings: this.settings
        });
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
        });

        if (this.sendMessageBtn) this.sendMessageBtn.addEventListener('click', () => this.sendMessage());
        if (this.messageInput) this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        if (this.clearChatBtn) this.clearChatBtn.addEventListener('click', () => this.handleClearConversation());
        if (this.newSessionBtn) this.newSessionBtn.addEventListener('click', () => this.handleNewSessionButSavePrevious());

        // 会话管理事件
        // 原生下拉已移除，保留该逻辑注释以便将来需要时恢复
        // this.sessionSelect.addEventListener('change', () => this.handleSessionSwitch());
        // 点击当前会话按钮显示会话列表面板（非操作菜单）
        if (this.currentSessionBtn) this.currentSessionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.debug('currentSessionBtn clicked');
            this.toggleSessionList();
        });
        // 使用捕获阶段监听，保证即使面板内部阻止了冒泡也能正确判断点击位置并关闭面板
        document.addEventListener('click', (e) => this.handleGlobalClickForMenus(e), true);
    }

    toggleSettings() {
        this.settingsPanel.classList.toggle('hidden');
    }

    hideSettings() {
        this.settingsPanel.classList.add('hidden');
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
            } else {
                throw new Error((response && response.message) ? response.message : '后台无响应');
            }
        } catch (error) {
            console.error('加载模型失败:', error);
        } finally {
            // 模型列表加载后，初始化交互状态（若未选择模型则禁用输入）
            this.updateInteractionState();
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

            const response = await this.sendMessageToBackground('sendChat', {
                url: this.settings.ollamaUrl,
                model: this.currentModel,
                messages: messagesForChat,
                stream: this.settings.enableStreaming
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
                } catch (e) {
                    console.error('保存助手消息失败:', e);
                    // 若更新失败，退回到追加行为以确保会话中至少有完整的回答
                    try { await this.appendMessageToActiveSession({ role: 'assistant', content: request.fullResponse }); } catch (err) { console.error('append fallback failed:', err); }
                }
            }
            this.currentMessageId = null;
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
        const session = { id, name: name || this.defaultSessionName(model), model: model || '', createdAt: now, updatedAt: now, messages: [] };
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
        if (this.messageInput) this.messageInput.disabled = !enabled;
        // 可视化提示：当无模型时输入框显示提示文案
        if (!enabled) {
            if (this.messageInput) this.messageInput.placeholder = '请先选择模型以启用对话';
        } else {
            if (this.messageInput) this.messageInput.placeholder = '输入您的问题...';
        }
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
        // 渲染消息
        for (const m of session.messages) {
            this.addMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content);
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
            console.debug('Showing session list panel');
            // refreshSessionListPanel may be async; call it and ignore await to keep this method sync
            this.refreshSessionListPanel().then(() => {
                panel.classList.remove('hidden');
                // 强制设置显示样式并提高 z-index 以防被覆盖
                panel.style.display = 'flex';
                panel.style.zIndex = '9999';
                // 调整位置以防超出弹窗右侧
                this.adjustSessionListPosition();

                // 添加遮罩以捕获外部点击并关闭面板（避免其他元素阻止冒泡导致无法关闭）
                if (!this._sessionListBackdrop) {
                    const backdrop = document.createElement('div');
                    backdrop.id = 'session-list-backdrop';
                    backdrop.style.position = 'fixed';
                    backdrop.style.left = '0';
                    backdrop.style.top = '0';
                    backdrop.style.width = '100%';
                    backdrop.style.height = '100%';
                    backdrop.style.background = 'transparent';
                    backdrop.style.zIndex = '9998';
                    backdrop.addEventListener('click', () => { this.hideSessionList(); });
                    this._sessionListBackdrop = backdrop;
                    // 将 backdrop 插入到 panel 之前
                    const container = document.body || document.documentElement;
                    container.appendChild(backdrop);
                }
            }).catch((e) => { console.warn('refreshSessionListPanel failed:', e); panel.classList.remove('hidden'); });
        } else {
            console.debug('Hiding session list panel');
            panel.classList.add('hidden');
            panel.style.display = '';
            panel.style.zIndex = '';
            // 移除遮罩
            if (this._sessionListBackdrop) {
                try { this._sessionListBackdrop.remove(); } catch (e) { /* ignore */ }
                this._sessionListBackdrop = null;
            }
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
    new OllamaAssistant();
});
