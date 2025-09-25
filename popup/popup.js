// Ollama服务类
// 兼容性补丁：拦截对已弃用事件类型（如 DOMNodeInserted / DOMNodeInsertedIntoDocument）的注册，
// 并用 MutationObserver 替代注册逻辑以避免浏览器警告和性能问题。
// 该补丁尽量保留原有回调的调用签名：当检测到 childList 变化时，会调用原来通过
// addEventListener 注册的回调函数，参数为新增节点列表。
(function installDeprecatedDomEventShim() {
  if (!Element.prototype.addEventListener) return;

  const originalAddEventListener = Element.prototype.addEventListener;
  const deprecatedEvents = new Set(['DOMNodeInserted', 'DOMNodeInsertedIntoDocument']);

  Element.prototype.addEventListener = function(type, listener, options) {
    try {
      if (deprecatedEvents.has(type) && typeof listener === 'function') {
        // 使用 MutationObserver 监听新增节点，并在发现时调用 listener
        const observer = new MutationObserver((mutationsList) => {
          for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
              // 模拟旧事件的行为：调用 listener，并传入类似事件对象（包含 addedNodes）
              try {
                listener.call(this, { type, addedNodes: mutation.addedNodes, mutation });
              } catch (e) {
                console.error('Deprecated event listener error:', e);
              }
            }
          }
        });

        // 开始观察当前元素的子树变化
        observer.observe(this, { childList: true, subtree: true });

        // 返回 without registering the deprecated event to avoid browser warning
        return;
      }
    } catch (e) {
      // 如果 shim 本身失败，回退到原生实现
      console.warn('Deprecated DOM event shim failed, falling back to native addEventListener', e);
    }

    return originalAddEventListener.call(this, type, listener, options);
  };
})();

class OllamaService {
  constructor(baseUrl = 'http://localhost:11434', model = 'qwen3:8b') {
    this.baseUrl = baseUrl;
    this.model = model;
    this.isConnected = false;
    this.availableModels = [];
  }

  // 测试连接 - 修复版本
  async testConnection() {
    try {
      console.log('Testing connection to:', this.baseUrl);

      // 添加超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      console.log('Connection response status:', response.status);

      if (response.ok) {
        const data = await response.json();
        this.isConnected = true;
        this.availableModels = data.models || [];

        return {
          success: true,
          message: `连接成功！可用模型: ${this.availableModels.map(m => m.name).join(', ')}`,
          models: this.availableModels
        };
      } else {
        throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Connection error:', error);
      this.isConnected = false;

      let errorMessage = error.message;
      if (error.name === 'AbortError') {
        errorMessage = '连接超时，请检查Ollama服务是否运行';
      } else if (error.message.includes('Failed to fetch')) {
        errorMessage = '无法连接到Ollama服务，请检查：\n1. Ollama是否运行\n2. 地址是否正确\n3. 端口是否被防火墙阻止';
      }

      return { success: false, error: errorMessage };
    }
  }

  // 检查模型是否存在
  async checkModelExists(modelName) {
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: modelName
        })
      });

      return { exists: response.ok, error: response.ok ? '' : `HTTP ${response.status}` };
    } catch (error) {
      return { exists: false, error: error.message };
    }
  }

  // 分析文本
  async analyzeText(text) {
    try {
      console.log('Analyzing text with model:', this.model);

      if (!text || text.length < 10) {
        throw new Error('文本太短，无法分析');
      }

      const prompt = this.buildAnalysisPrompt(text);

      const requestBody = {
        model: this.model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.9
        }
      };

      console.log('Sending request to:', this.model);

      // 记录即将发送的请求体，便于排查服务器拒绝原因
      console.log('Analysis request body:', requestBody);

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      console.log('Analysis response status:', response.status);
      // 读取并记录响应 headers 与 body（使用 clone() 以便后续解析）
      let responseText = '';
      try {
        console.log('Analysis response headers:', Array.from(response.headers.entries()));
        responseText = await response.clone().text();
        console.log('Analysis response body (text):', responseText);
      } catch (e) {
        console.warn('无法读取响应体:', e);
      }

      if (!response.ok) {
        let errorDetail = `${response.status} ${response.statusText}`;
        if (responseText) errorDetail += ` - ${responseText}`;
        throw new Error(`分析请求失败: ${errorDetail}`);
      }

      // 尝试解析为 JSON；若失败则将文本作为 raw 响应
      let data;
      try {
        data = responseText ? JSON.parse(responseText) : await response.json();
      } catch (e) {
        console.warn('解析响应 JSON 失败，使用文本响应作为 raw:', e);
        data = { response: responseText };
      }
      console.log('Analysis response data:', data);

      if (!data.response) {
        throw new Error('Ollama返回了空响应');
      }

      return this.parseAnalysisResult(data.response);

    } catch (error) {
      console.error('Analysis error:', error);
      throw new Error(`分析失败: ${error.message}`);
    }
  }

  buildAnalysisPrompt(text) {
    const truncatedText = text.substring(0, 500);
    return `请分析以下文本是否可能由AI生成：

文本内容：
"""
${truncatedText}
"""

请严格按照以下格式回复：

判断: [AI生成/人类写作/不确定]
置信度: [0-100]%
理由: [简要分析说明]`;
  }

  parseAnalysisResult(response) {
    const result = {
      judgment: '不确定',
      confidence: 50,
      reasoning: response,
      raw: response
    };

    try {
      const judgmentMatch = response.match(/判断:\s*([^\n]+)/i);
      const confidenceMatch = response.match(/置信度:\s*(\d+)%/i);
      const reasoningMatch = response.match(/理由:\s*([^\n]+)/i);

      if (judgmentMatch) result.judgment = judgmentMatch[1].trim();
      if (confidenceMatch) result.confidence = parseInt(confidenceMatch[1]);
      if (reasoningMatch) result.reasoning = reasoningMatch[1].trim();

    } catch (error) {
      console.warn('解析响应时出错:', error);
    }

    return result;
  }

  updateSettings(url, model) {
    this.baseUrl = url || 'http://localhost:11434';
    this.model = model || 'qwen3:8b';
    console.log('Settings updated:', this.baseUrl, this.model);
  }
}

// 主应用程序
class App {
  constructor() {
    this.ollamaService = new OllamaService();
    this.initializeElements();
    this.bindEvents();
    this.loadSettings();
    this.addDebugButton();
  }

  initializeElements() {
    this.elements = {
      detectBtn: document.getElementById('detectBtn'),
      testConnectionBtn: document.getElementById('testConnectionBtn'),
      clearBtn: document.getElementById('clearBtn'),
      ollamaUrlInput: document.getElementById('ollamaUrl'),
      ollamaModelInput: document.getElementById('ollamaModel'),
      connectionStatus: document.getElementById('connectionStatus'),
      loading: document.getElementById('loading'),
      result: document.getElementById('result'),
      error: document.getElementById('error'),
      resultContent: document.getElementById('resultContent'),
      analysisDetails: document.getElementById('analysisDetails'),
      confidenceBadge: document.getElementById('confidenceBadge'),
      errorDetails: document.getElementById('errorDetails')
    };
  }

  bindEvents() {
    this.elements.testConnectionBtn.addEventListener('click', () => this.testConnection());
    this.elements.detectBtn.addEventListener('click', () => this.detectText());
    this.elements.clearBtn.addEventListener('click', () => this.clearResults());

    this.elements.ollamaUrlInput.addEventListener('change', () => this.saveSettings());
    this.elements.ollamaModelInput.addEventListener('change', () => this.saveSettings());
  }

  addDebugButton() {
    const debugBtn = document.createElement('button');
    debugBtn.textContent = '调试';
    debugBtn.className = 'debug-btn';
    debugBtn.addEventListener('click', () => this.showDebugInfo());
    document.body.appendChild(debugBtn);
  }

  async showDebugInfo() {
    try {
      const pageText = await this.getPageText();

      alert(`调试信息：
URL: ${this.elements.ollamaUrlInput.value}
模型: ${this.elements.ollamaModelInput.value}
文本长度: ${pageText?.length || 0}

请检查：
1. Ollama服务是否运行: curl http://localhost:11434/api/tags
2. 模型是否存在: ollama list
      `);
    } catch (error) {
      alert(`调试错误: ${error.message}`);
    }
  }

  async testConnection() {
    this.showLoading('测试连接中...');
    this.hideError();
    this.hideResult();

    this.saveSettings();
    this.ollamaService.updateSettings(
      this.elements.ollamaUrlInput.value,
      this.elements.ollamaModelInput.value
    );

    try {
      const result = await this.ollamaService.testConnection();
      this.hideLoading();

      if (result.success) {
        this.updateConnectionStatus(true, result.message);
      } else {
        this.updateConnectionStatus(false, result.error);
        this.showError(result.error);
      }
    } catch (error) {
      this.hideLoading();
      this.updateConnectionStatus(false, '连接测试失败');
      this.showError(error.message);
    }
  }

  async detectText() {
    this.showLoading('分析中...');
    this.hideError();
    this.hideResult();

    this.saveSettings();
    this.ollamaService.updateSettings(
      this.elements.ollamaUrlInput.value,
      this.elements.ollamaModelInput.value
    );

    try {
      const pageText = await this.getPageText();

      if (!pageText || pageText.length < 50) {
        throw new Error('文本内容太少，请打开包含更多文字的网页');
      }

      console.log('Starting analysis...');
      const analysis = await this.ollamaService.analyzeText(pageText);
      this.displayResults(analysis, pageText);

    } catch (error) {
      console.error('Detection error:', error);
      this.showError(error.message);
    } finally {
      this.hideLoading();
    }
  }

  async getPageText() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          const mainContent = document.querySelector('article') ||
                             document.querySelector('.content') ||
                             document.querySelector('main') ||
                             document.body;

          const clone = mainContent.cloneNode(true);
          const elementsToRemove = clone.querySelectorAll(
            'script, style, nav, header, footer, aside, iframe, form, button, .ad'
          );
          elementsToRemove.forEach(el => el.remove());

          return clone.textContent.replace(/\s+/g, ' ').trim();
        }
      });

      return results[0]?.result || null;
    } catch (error) {
      throw new Error('无法获取页面内容: ' + error.message);
    }
  }

  displayResults(analysis, text) {
    const isAI = analysis.judgment.includes('AI') || analysis.confidence > 60;

    this.elements.result.className = isAI ? 'result ai-result' : 'result human-result';

    this.elements.confidenceBadge.textContent = `${analysis.confidence}%`;
    this.elements.confidenceBadge.className = `confidence-badge confidence-${this.getConfidenceLevel(analysis.confidence)}`;

    this.elements.resultContent.innerHTML = `
      <p><strong>判断:</strong> ${analysis.judgment}</p>
      <p><strong>置信度:</strong> ${analysis.confidence}%</p>
      <p><strong>理由:</strong> ${analysis.reasoning}</p>
      <p><strong>文本片段:</strong> "${text.substring(0, 80)}..."</p>
    `;

    this.elements.analysisDetails.innerHTML = `
      <div class="analysis-text">${analysis.raw}</div>
    `;

    this.elements.result.classList.remove('hidden');
  }

  getConfidenceLevel(confidence) {
    if (confidence >= 70) return 'high';
    if (confidence >= 40) return 'medium';
    return 'low';
  }

  updateConnectionStatus(connected, message) {
    this.elements.connectionStatus.classList.remove('hidden');
    this.elements.connectionStatus.className = connected ?
      'connection-status connected' : 'connection-status disconnected';
    this.elements.connectionStatus.querySelector('.status-icon').textContent = connected ? '🟢' : '🔴';
    this.elements.connectionStatus.querySelector('.status-text').textContent = message;
  }

  showLoading(message = '处理中...') {
    this.elements.loading.querySelector('span').textContent = message;
    this.elements.loading.classList.remove('hidden');
  }

  hideLoading() {
    this.elements.loading.classList.add('hidden');
  }

  showError(message) {
    this.elements.errorDetails.textContent = message;
    this.elements.error.classList.remove('hidden');
  }

  hideError() {
    this.elements.error.classList.add('hidden');
  }

  hideResult() {
    this.elements.result.classList.add('hidden');
  }

  clearResults() {
    this.hideError();
    this.hideResult();
  }

  saveSettings() {
    const settings = {
      ollamaUrl: this.elements.ollamaUrlInput.value,
      ollamaModel: this.elements.ollamaModelInput.value
    };
    chrome.storage.local.set(settings);
  }

  loadSettings() {
    // 读取存储的设置，使用正确的键名并提供默认值
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], (data) => {
      if (data?.ollamaUrl) this.elements.ollamaUrlInput.value = data.ollamaUrl;
      if (data?.ollamaModel) this.elements.ollamaModelInput.value = data.ollamaModel;
      this.ollamaService.updateSettings(data?.ollamaUrl || undefined, data?.ollamaModel || undefined);
    });
  }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
  new App();
});
