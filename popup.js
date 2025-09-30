class OllamaAssistant {
    constructor() {
        this.settings = {
            ollamaUrl: 'http://localhost:11434'
        };
        this.currentModel = '';
        this.conversationHistory = [];
        this.currentMessageId = null;

        this.initializeElements();
        this.loadSettings();
        this.attachEventListeners();
        this.setupMessageListeners();
        this.testConnection();
    }

    initializeElements() {
        // 状态指示器
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusText = document.getElementById('statusText');

        // 模型选择
        this.modelSelect = document.getElementById('modelSelect');

        // 设置相关
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsPanel = document.getElementById('settingsPanel');
        this.ollamaUrlInput = document.getElementById('ollamaUrl');
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
        }
    }

    async saveSettings() {
        this.settings.ollamaUrl = this.ollamaUrlInput.value;
        await chrome.storage.local.set({
            ollamaSettings: this.settings
        });
        this.hideSettings();
        this.testConnection();
    }

    attachEventListeners() {
        this.settingsBtn.addEventListener('click', () => this.toggleSettings());
        this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.testConnectionBtn.addEventListener('click', () => this.testConnection());

        this.modelSelect.addEventListener('change', (e) => {
            this.currentModel = e.target.value;
        });

        this.sendMessageBtn.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.clearChatBtn.addEventListener('click', () => this.clearConversation());
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

            if (response.success) {
                this.updateStatus('connected', '已连接');
                await this.loadModels();
            } else {
                throw new Error(response.message);
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

            if (response.success) {
                this.populateModelSelect(response.models);
            } else {
                throw new Error(response.message);
            }
        } catch (error) {
            console.error('加载模型失败:', error);
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

        console.log('选择的模型:', this.currentModel);
        console.log('发送的消息:', message);

        // 添加用户消息
        this.addMessage('user', message);
        this.messageInput.value = '';

        // 添加加载中的助手消息
        this.currentMessageId = this.addMessage('assistant', '思考中...', true);

        try {
            const response = await this.sendMessageToBackground('sendMessage', {
                url: this.settings.ollamaUrl,
                model: this.currentModel,
                message: message
            });

            if (!response.success) {
                throw new Error(response.message);
            }
            // 流式响应将通过message listener处理
        } catch (error) {
            console.error('发送消息失败:', error);
            this.removeMessage(this.currentMessageId);
            this.addMessage('assistant', `错误: ${error.message}`);
        }
    }

    handleStreamUpdate(request) {
        if (request.chunk && this.currentMessageId) {
            this.updateMessageContent(this.currentMessageId, request.chunk);
        }

        if (request.done) {
            if (request.fullResponse) {
                this.conversationHistory.push({
                    assistant: request.fullResponse
                });
            }
            this.currentMessageId = null;
        }
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
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: action,
                ...data
            }, (response) => {
                resolve(response);
            });
        });
    }

    addMessage(role, content, isTemp = false) {
        const messageDiv = document.createElement('div');
        const messageId = 'msg_' + Date.now();
        messageDiv.id = messageId;
        messageDiv.className = `message ${role} ${isTemp ? 'loading' : ''}`;
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
        const messageElement = document.getElementById(messageId);
        if (messageElement) {
            // 移除"加载中"样式
            messageElement.classList.remove('loading');

            // 追加新内容
            const currentContent = messageElement.textContent;
            if (currentContent === '思考中...') {
                messageElement.textContent = newContent;
            } else {
                messageElement.textContent += newContent;
            }
            this.scrollToBottom();
        }
    }

    scrollToBottom() {
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    clearConversation() {
        this.messagesDiv.innerHTML = '';
        this.conversationHistory = [];
        this.currentMessageId = null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new OllamaAssistant();
});
