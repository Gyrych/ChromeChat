// 处理与Ollama的通信
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 使用异步闭包以确保我们能捕获异常并总是保持消息通道打开
  (async () => {
    try {
      if (request.action === 'testConnection') {
        await testConnection(request.url, sendResponse);
        return;
      }

      if (request.action === 'getModels') {
        await getModels(request.url, sendResponse);
        return;
      }

      if (request.action === 'sendMessage') {
        await sendMessageToOllama(request.url, request.model, request.message, sendResponse);
        return;
      }

      if (request.action === 'sendChat') {
        // 先同步返回 ACK，避免消息端口超时；实际请求在后台异步执行并通过 streamUpdate 推送回前端
        try {
          sendResponse({ success: true, message: '请求已开始' });
        } catch (e) {
          console.warn('sendResponse ACK failed:', e);
        }
        // 异步处理：在发送前评估 token 并在必要时生成摘要
        (async () => {
          const streamEnabled = request.stream !== false; // 默认启用流式，除非明确设置为false
        try {
            // 临时跳过 prompt token 评估与摘要生成以排查 upstream 502 问题
            console.log('sendChat -> skipping prepareMessagesWithSummary (debug mode)');
            const preparedMessages = request.messages;
            const summaryMeta = null;
            // 若生成了摘要，通知 popup（popup 会负责把摘要元数据写入对应 session）
            if (summaryMeta) {
              try { await notifySummaryGenerated(summaryMeta); } catch (e) { console.warn('notifySummaryGenerated failed', e); }
            }
            // 继续发送 chat 请求，传入 requestId 以便支持中止
            await fetchChatAndNotify(request.url, request.model, preparedMessages, { stream: streamEnabled, requestId: request.requestId });
          } catch (err) {
            console.error('prepare/send chat failed, falling back to original messages', err);
            // 通知 popup 生成摘要失败（供 UI 显示），继续尝试发送原始 messages
            try { await safeSendToPopup({ action: 'summaryFailed', message: err && err.message ? err.message : String(err) }); } catch (e) { /* ignore */ }
            await fetchChatAndNotify(request.url, request.model, request.messages, { stream: streamEnabled, requestId: request.requestId });
          }
        })();
        return;
      }

      // 未知 action
      sendResponse({ success: false, message: '未知的 action' });
    } catch (err) {
      console.error('background handler error:', err);
      try { sendResponse({ success: false, message: err && err.message ? err.message : String(err) }); } catch (e) { /* ignore */ }
    }
  })();

  return true; // 始终返回 true 以保持消息通道开放直到 sendResponse 被调用
});

// 当用户点击扩展图标时，尝试打开侧边栏（若浏览器支持 sidePanel API），否则回退在新标签页打开 sidebar.html
try {
  if (chrome && chrome.action && typeof chrome.action.onClicked !== 'undefined') {
    chrome.action.onClicked.addListener(async (tab) => {
      try {
        // 尝试使用 sidePanel API 设置面板并打开（Chrome 目前对 sidePanel 支持有限）
        if (chrome.sidePanel && typeof chrome.sidePanel.setOptions === 'function') {
          try {
            await chrome.sidePanel.setOptions({ path: 'sidebar.html' });
            // 某些实现还需要显式打开侧边栏（API 名称可能不同），尝试调用 open
            if (typeof chrome.sidePanel.open === 'function') {
              try { await chrome.sidePanel.open(); } catch (e) { /* ignore */ }
            }
            return;
          } catch (e) {
            console.warn('sidePanel.setOptions/open failed, falling back to tab:', e);
          }
        }

        // 回退：尝试在当前页面注入侧边栏 content script 切换侧边栏显示
        try {
          if (tab && tab.id) {
            // 尝试以 executeScript 注入（manifest 已声明 web_accessible_resources）
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_sidebar_inject.js'] });
            // 发送消息指示 content script 切换侧边栏
            try { await chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebarInPage' }); } catch (e) { /* ignore */ }
            return;
          }
          await chrome.tabs.create({ url: chrome.runtime.getURL('sidebar.html') });
        } catch (e) {
          console.error('fallback open sidebar tab or inject failed:', e);
        }
      } catch (err) {
        console.error('action.onClicked handler error:', err);
      }
    });
  }
} catch (e) { console.warn('registering action.onClicked failed', e); }

async function testConnection(url, sendResponse) {
  try {
    const headers = await buildRequestHeaders(url, { 'Content-Type': 'application/json' });
    const response = await fetch(`${url}/api/tags`, { headers });
    if (response.ok) {
      sendResponse({ success: true, message: '连接成功' });
    } else {
      sendResponse({ success: false, message: `连接失败: HTTP ${response.status}` });
    }
  } catch (error) {
    sendResponse({ success: false, message: `连接错误: ${error.message}` });
  }
}

// 将要发送给 popup 的消息保存为 pending，当 popup 不在时使用
async function _savePendingMessage(payload) {
  try {
    const key = 'ollama.pendingStreamUpdates';
    const res = await chrome.storage.local.get([key]);
    const arr = res[key] || [];
    arr.push(payload);
    await chrome.storage.local.set({ [key]: arr });
  } catch (e) {
    console.error('保存 pending 消息失败:', e);
  }
}

async function _savePendingError(payload) {
  try {
    const key = 'ollama.pendingStreamErrors';
    const res = await chrome.storage.local.get([key]);
    const arr = res[key] || [];
    arr.push(payload);
    await chrome.storage.local.set({ [key]: arr });
  } catch (e) {
    console.error('保存 pending 错误失败:', e);
  }
}

// 安全地向 popup 发送消息；如果发送失败（例如接收端不存在），则将消息存储以便 popup 下次打开时取回
async function safeSendToPopup(payload) {
  try {
    const res = chrome.runtime.sendMessage(payload);
    // chrome.runtime.sendMessage 在某些环境返回 Promise
    if (res && typeof res.then === 'function') await res;
    return true;
  } catch (err) {
    console.warn('safeSendToPopup -> sendMessage failed, saving to storage', err, payload && payload.action);
    await _savePendingMessage(payload);
    return false;
  }
}

async function safeSendErrorToPopup(payload) {
  try {
    const res = chrome.runtime.sendMessage(payload);
    if (res && typeof res.then === 'function') await res;
    return true;
  } catch (err) {
    console.warn('safeSendErrorToPopup -> sendMessage failed, saving error to storage', err, payload && payload.action);
    await _savePendingError(payload);
    return false;
  }
}

async function getModels(url, sendResponse) {
  try {
    const headers = await buildRequestHeaders(url, { 'Content-Type': 'application/json' });
    const response = await fetch(`${url}/api/tags`, { headers });
    if (response.ok) {
      const data = await response.json();
      sendResponse({ success: true, models: data.models || [] });
    } else {
      sendResponse({ success: false, message: `获取模型列表失败: HTTP ${response.status}` });
    }
  } catch (error) {
    sendResponse({ success: false, message: `获取模型列表错误: ${error.message}` });
  }
}

async function sendMessageToOllama(url, model, message, sendResponse) {
  try {
    console.log('发送请求到 Ollama:', {
      url: `${url}/api/generate`,
      model: model,
      message: message
    });

    // 使用构建的请求头（可能包含 Authorization）
    const headers = await buildRequestHeaders(url, { 'Content-Type': 'application/json' });
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model,
        prompt: message,
        stream: false
      })
    });

    console.log('Ollama 响应状态:', response.status);
    console.log('Ollama 响应头:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.log('错误响应内容:', errorText);
      throw new Error(`HTTP error: ${response.status} - ${errorText}`);
    }

    // 处理非流式响应
    const data = await response.json();
    console.log('Ollama 响应数据:', data);

    const fullResponse = data.response || '';

    // 提取精确 token 计数（若有）
    const promptTokens = (typeof data.prompt_eval_count === 'number') ? data.prompt_eval_count : (typeof data.prompt_tokens === 'number' ? data.prompt_tokens : null);
    const genTokens = (typeof data.eval_count === 'number') ? data.eval_count : (typeof data.eval_tokens === 'number' ? data.eval_tokens : null);
    const totalTokens = (promptTokens !== null || genTokens !== null) ? ((promptTokens || 0) + (genTokens || 0)) : null;

    // 发送完整响应及 token 信息回 popup
    await safeSendToPopup({
      action: 'streamUpdate',
      chunk: fullResponse,
      done: true,
      fullResponse: fullResponse,
      promptTokens: promptTokens,
      genTokens: genTokens,
      totalTokens: totalTokens
    });

    sendResponse({ success: true, message: '响应完成' });

  } catch (error) {
    console.error('发送消息异常:', error);
    sendResponse({ success: false, message: `发送消息失败: ${error.message}` });
  }
}

async function sendChatToOllama(url, model, messages, sendResponse) {
  try {
    console.log('发送 Chat 到 Ollama:', {
      url: `${url}/api/chat`,
      model: model,
      messagesLength: Array.isArray(messages) ? messages.length : 'invalid'
    });

    const headers = await buildRequestHeaders(url, { 'Content-Type': 'application/json' });
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: false
      })
    });

    console.log('Ollama Chat 响应状态:', response.status);
    console.log('Ollama Chat 响应头:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.log('Chat 错误响应内容:', errorText);
      throw new Error(`HTTP error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Ollama Chat 响应数据:', data);

    // 兼容不同返回结构，优先取 chat.message.content
    const assistantText = (data && data.message && typeof data.message.content === 'string')
      ? data.message.content
      : (typeof data.response === 'string' ? data.response : '');

    // 提取精确 token 计数（若有）
    const promptTokens = (typeof data.prompt_eval_count === 'number') ? data.prompt_eval_count : (typeof data.prompt_tokens === 'number' ? data.prompt_tokens : null);
    const genTokens = (typeof data.eval_count === 'number') ? data.eval_count : (typeof data.eval_tokens === 'number' ? data.eval_tokens : null);
    const totalTokens = (promptTokens !== null || genTokens !== null) ? ((promptTokens || 0) + (genTokens || 0)) : null;

    chrome.runtime.sendMessage({
      action: 'streamUpdate',
      chunk: assistantText,
      done: true,
      fullResponse: assistantText,
      promptTokens: promptTokens,
      genTokens: genTokens,
      totalTokens: totalTokens
    });

    sendResponse({ success: true, message: '响应完成' });
  } catch (error) {
    console.error('发送 Chat 异常:', error);
    sendResponse({ success: false, message: `发送消息失败: ${error.message}` });
  }
}

async function fetchChatAndNotify(url, model, messages, stream = true) {
  // 支持两种调用方式：
  // (url, model, messages, true|false) 或 (url, model, messages, {stream: true|false, requestId: '...'})
  let requestId = null;
  if (stream && typeof stream === 'object') {
    const opts = stream || {};
    requestId = opts.requestId || null;
    stream = Boolean(opts.stream);
  }

  // activeRequests 映射：requestId -> AbortController
  if (!globalThis._ollamaActiveRequests) globalThis._ollamaActiveRequests = {};
  let fullResponse = '';
  let isFirstChunk = true;

  try {
    console.log('fetchChatAndNotify -> sending request', {
      url: normalizeUrl(url),
      model,
      messagesLength: Array.isArray(messages) ? messages.length : 'invalid',
      stream,
      firstMessagePreview: (Array.isArray(messages) && messages[0]) ? (messages[0].content || '').slice(0, 120) : ''
    });

    const headers = await buildRequestHeaders(url, { 'Content-Type': 'application/json' });
    console.log('fetchChatAndNotify -> request headers info', { hasAuthorization: !!headers.Authorization, urlHost: (new URL(normalizeUrl(url))).host });

    // 过滤空 assistant 消息（有些上游实现会对空内容产生异常）
    let sanitizedMessages = Array.isArray(messages) ? messages.filter(m => {
      if (!m || !m.role) return false;
      if (m.role === 'assistant') return typeof m.content === 'string' && m.content.trim() !== '';
      return true;
    }) : [];
    if (sanitizedMessages.length === 0) sanitizedMessages = messages; // 若全被过滤，回退为原始
    if (sanitizedMessages.length !== (messages ? messages.length : 0)) {
      console.log('fetchChatAndNotify -> sanitizedMessages applied', { before: (messages||[]).length, after: sanitizedMessages.length });
    }

    // 如果提供了 requestId，则为该请求创建 AbortController 并传入 signal
    let controller = null;
    if (requestId) {
      controller = new AbortController();
      try { globalThis._ollamaActiveRequests[requestId] = controller; } catch (e) { /* ignore */ }
    }
    const response = await fetch(`${normalizeUrl(url)}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: sanitizedMessages, stream }),
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('fetchChatAndNotify HTTP error', response.status, text);
      await safeSendErrorToPopup({ action: 'streamError', error: `HTTP ${response.status}: ${text}` });
      return;
    }

    // 如果不使用流式响应，直接处理完整响应
    if (!stream) {
      const data = await response.json();
      console.log('fetchChatAndNotify -> got non-stream response', data);
      const assistantText = (data && data.message && typeof data.message.content === 'string')
        ? data.message.content
        : (typeof data.response === 'string' ? data.response : '');

      const promptTokens = (typeof data.prompt_eval_count === 'number') ? data.prompt_eval_count : (typeof data.prompt_tokens === 'number' ? data.prompt_tokens : null);
      const genTokens = (typeof data.eval_count === 'number') ? data.eval_count : (typeof data.eval_tokens === 'number' ? data.eval_tokens : null);
      const totalTokens = (promptTokens !== null || genTokens !== null) ? ((promptTokens || 0) + (genTokens || 0)) : null;

      chrome.runtime.sendMessage({
        action: 'streamUpdate',
        chunk: assistantText,
        done: true,
        fullResponse: assistantText,
        promptTokens: promptTokens,
        genTokens: genTokens,
        totalTokens: totalTokens
      });
      return;
    }

    if (!response.body) {
      throw new Error('Response body is not available');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 用于记录流中可能发送的最终 token 计数
    let finalPromptTokens = null;
    let finalGenTokens = null;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('fetchChatAndNotify -> stream ended');
        // 发送最终完成信号
        chrome.runtime.sendMessage({
          action: 'streamUpdate',
          chunk: '',
          done: true,
          fullResponse: fullResponse
        });
        break;
      }

      // 解码二进制数据为文本
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // 处理NDJSON格式的流数据
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行

      for (const line of lines) {
        if (line.trim() === '') continue;

        try {
          const data = JSON.parse(line);
          // 额外日志：将 chunk 长度与包含的 keys 打印出来，避免泄露完整内容
          console.log('fetchChatAndNotify -> parsed chunk meta', { len: line.length, keys: Object.keys(data || {}) });

          // 处理不同格式的响应
          let chunkContent = '';

          if (data.message && typeof data.message.content === 'string') {
            // Ollama /api/chat 格式
            chunkContent = data.message.content;
          } else if (typeof data.response === 'string') {
            // 兼容其他格式
            chunkContent = data.response;
          } else if (data.choices && data.choices[0] && data.choices[0].delta) {
            // OpenAI兼容格式，delta 里可能包含 content 或 reasoning_content
            const delta = data.choices[0].delta;
            if (typeof delta.content === 'string' && delta.content !== '') {
              chunkContent = delta.content;
            } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
              chunkContent = delta.reasoning_content;
            }
          } else if (data.delta && typeof data.delta === 'object') {
            // 有些实现会把 delta 放在顶层的 data.delta
            const deltaTop = data.delta;
            if (typeof deltaTop.content === 'string' && deltaTop.content !== '') {
              chunkContent = deltaTop.content;
            } else if (typeof deltaTop.reasoning_content === 'string' && deltaTop.reasoning_content !== '') {
              chunkContent = deltaTop.reasoning_content;
            }
          }

          if (chunkContent) {
            fullResponse += chunkContent;

            // 发送流式更新
            await safeSendToPopup({
              action: 'streamUpdate',
              chunk: chunkContent,
              done: false,
              fullResponse: fullResponse
            });
          }

          // 检查是否完成
          // 若包含 token 字段则记录，可能在完成时发送给 popup
          if (typeof data.prompt_eval_count === 'number') finalPromptTokens = data.prompt_eval_count;
          if (typeof data.eval_count === 'number') finalGenTokens = data.eval_count;

          if (data.done === true || (data.choices && data.choices[0] && data.choices[0].finish_reason)) {
            console.log('fetchChatAndNotify -> response completed');
            const totalTokens = (finalPromptTokens !== null || finalGenTokens !== null) ? ((finalPromptTokens || 0) + (finalGenTokens || 0)) : null;
            await safeSendToPopup({
              action: 'streamUpdate',
              chunk: '',
              done: true,
              fullResponse: fullResponse,
              promptTokens: finalPromptTokens,
              genTokens: finalGenTokens,
              totalTokens: totalTokens
            });
            return;
          }

        } catch (parseError) {
          console.warn('fetchChatAndNotify -> failed to parse line:', line, parseError);
          // 继续处理下一行，不要因为一行解析失败而中断整个流
        }
      }
    }

  } catch (err) {
    console.error('fetchChatAndNotify error:', err);
    // 如果是被中止的错误，发送特殊 error 到 popup
    if (err && err.name === 'AbortError') {
      await safeSendErrorToPopup({ action: 'streamError', error: '请求已被用户取消（Abort）' });
      // 清理 activeRequests
      try { if (requestId && globalThis._ollamaActiveRequests && globalThis._ollamaActiveRequests[requestId]) delete globalThis._ollamaActiveRequests[requestId]; } catch (e) { /* ignore */ }
      return;
    }
    await safeSendErrorToPopup({
      action: 'streamError',
      error: err && err.message ? err.message : String(err)
    });
    try { if (requestId && globalThis._ollamaActiveRequests && globalThis._ollamaActiveRequests[requestId]) delete globalThis._ollamaActiveRequests[requestId]; } catch (e) { /* ignore */ }
  }
}

// 处理来自 popup 的中止请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) return;
  if (request.action === 'abortChat') {
    const reqId = request.requestId;
    try {
      if (reqId && globalThis._ollamaActiveRequests && globalThis._ollamaActiveRequests[reqId]) {
        try { globalThis._ollamaActiveRequests[reqId].abort(); } catch (e) { /* ignore */ }
        delete globalThis._ollamaActiveRequests[reqId];
        try { sendResponse({ success: true, message: 'abort sent' }); } catch (e) { /* ignore */ }
        return true;
      } else {
        try { sendResponse({ success: false, message: 'requestId not found or already finished' }); } catch (e) { /* ignore */ }
        return true;
      }
    } catch (e) {
      console.warn('abortChat handler failed', e);
      try { sendResponse({ success: false, message: String(e) }); } catch (er) { /* ignore */ }
      return true;
    }
  }
});

// 将摘要元数据通过 safeSendToPopup 发送到 popup（字段名与 popup 期望一致）
async function notifySummaryGenerated(meta) {
  try {
    await safeSendToPopup({ action: 'summaryGenerated', summaryId: meta.summaryId, summary: meta.summary, startIdx: meta.startIdx, endIdx: meta.endIdx, ts: meta.ts, byModel: meta.byModel });
  } catch (e) {
    console.warn('notifySummaryGenerated failed', e);
  }
}

// 评估 prompt tokens（优先尝试 Ollama 返回的精确值，失败则返回 null）
async function evaluatePromptTokens(url, model, messages) {
  try {
    // 发送一个不生成 token 的请求以让 Ollama 返回 prompt token 计数（若支持）
    const headers = await buildRequestHeaders(url, { 'Content-Type': 'application/json' });
    console.log('evaluatePromptTokens -> POST', { url: normalizeUrl(url) + '/api/chat', model, headersInfo: { hasAuthorization: !!headers.Authorization } });
    const resp = await fetch(`${normalizeUrl(url)}/api/chat`, {
      method: 'POST',
      headers,
      // 通过 stream:false 并尽量让生成体为空，期待服务返回 prompt_eval_count 或 prompt_tokens
      body: JSON.stringify({ model, messages, stream: false, max_tokens: 0 })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn('evaluatePromptTokens -> non-ok response', resp.status, txt);
      return null;
    }

    const data = await resp.json();
    const promptTokens = (typeof data.prompt_eval_count === 'number') ? data.prompt_eval_count : (typeof data.prompt_tokens === 'number' ? data.prompt_tokens : null);
    return promptTokens !== null ? promptTokens : null;
  } catch (err) {
    console.warn('evaluatePromptTokens failed', err);
    return null;
  }
}

// 构建请求头，如果目标是 ollama.com 且用户在设置中提供了 apiKey，则自动加入 Authorization
async function buildRequestHeaders(url, extraHeaders = {}) {
  // 克隆 extraHeaders，避免外部被修改
  const headers = Object.assign({}, extraHeaders || {});
  try {
    // 读取存储的 API Key（如果存在，则无论目标 host 都加入 Authorization）
    const res = await chrome.storage.local.get(['ollamaSettings']);
    const settings = res.ollamaSettings || {};
    const apiKey = settings.apiKey || '';
    if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
      headers['Authorization'] = 'Bearer ' + apiKey.trim();
    }
  } catch (e) {
    console.warn('buildRequestHeaders failed to read apiKey from storage', e);
  }

  // 供调试：仅显示是否包含 Authorization，而不打印明文
  const cleaned = (typeof url === 'string' ? url.trim() : url);
  try {
    console.log('buildRequestHeaders -> host', (new URL(cleaned)).host, 'hasAuthorization', !!headers['Authorization']);
  } catch (e) {
    console.log('buildRequestHeaders -> url', cleaned, 'hasAuthorization', !!headers['Authorization']);
  }

  return headers;
}

// 规范化并清理 base url（去除前后空格与尾部斜杠）
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  return rawUrl.trim().replace(/\/+$/g, '');
}

// 使用当前 model 生成摘要，返回摘要文本与元数据
async function generateSummary(url, model, messagesToSummarize) {
  // 构造 system 指令，控制摘要行为
  const systemPrompt = `请把下面的用户与助手对话摘要为一段用于后续对话的 system 上下文说明：保留关键决策、重要参数与代码块，摘要长度应不超过原始内容的 50%，语言与原文一致，不要删减 system 指令本身。`;

  // 将 system 指令与待摘要消息拼接为一次 chat 请求
  const reqMessages = [{ role: 'system', content: systemPrompt }].concat(messagesToSummarize.map(m => ({ role: m.role, content: m.content })));

  const resp = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: reqMessages, stream: false })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`generateSummary HTTP ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const summary = (data && data.message && typeof data.message.content === 'string') ? data.message.content : (typeof data.response === 'string' ? data.response : '');
  if (!summary || !summary.trim()) throw new Error('摘要内容为空');

  return summary;
}

// 准备 messages：评估 token 并在必要时生成摘要，返回最终发送的 messages 与摘要元数据（若有）
async function prepareMessagesWithSummary(url, model, originalMessages) {
  // 过滤出可被摘要的消息（排除 role=system）
  const canBeSummarized = Array.isArray(originalMessages) ? originalMessages.filter(m => m && m.role && m.role !== 'system') : [];

  // 读取模型最大上下文（简易内置映射，若未知返回 null）
  const modelMaxContextMap = {
    'deepseek-r1:1.5b': 128000,
    'gemma3:270m': 32000,
    'gemma3:1b': 32000,
    'gemma3:4b': 128000,
    'qwen3:0.6b': 40000,
    'qwen3:1.7b': 40000,
    'qwen3:4b': 256000
  };
  const maxContext = modelMaxContextMap[model] || null;

  // 尝试精确评估 prompt tokens
  let promptTokens = null;
  try { promptTokens = await evaluatePromptTokens(url, model, originalMessages); } catch (e) { promptTokens = null; }

  // 若无法从 Ollama 获得精确值且已知 maxContext，则无法准确触发时使用 null（调用方会回退到估算）
  if (promptTokens === null && maxContext === null) {
    // 无法判断，直接返回原始 messages
    return { messages: originalMessages, summaryMeta: null };
  }

  // 判断是否需要摘要：若 promptTokens 可用则基于精确值判断；否则回退到本地估算（字符数/4）
  let needsSummary = false;
  if (promptTokens !== null && maxContext !== null) {
    needsSummary = (promptTokens >= Math.floor(0.8 * maxContext));
  } else if (maxContext !== null) {
    // 估算 token：简单按字符数/4
    const joined = canBeSummarized.map(m => m.content || '').join('\n');
    const est = Math.max(0, Math.floor((joined.length || 0) / 4));
    needsSummary = (est >= Math.floor(0.8 * maxContext));
  }

  if (!needsSummary) {
    return { messages: originalMessages, summaryMeta: null };
  }

  // 需要生成摘要：我们将尝试对整个可被摘要的历史进行摘要，并在发送时插入为 system
  try {
    const summaryText = await generateSummary(url, model, canBeSummarized);
    // 构建最终 messages：摘要作为 system 消息放在最前，随后保留最近若干条消息以保持上下文（例如最近 10 条）
    const recentKeep = 10;
    const recent = canBeSummarized.slice(-recentKeep).map(m => ({ role: m.role, content: m.content }));
    // 同时保留原始 system 消息（如果存在）
    const originalSystem = Array.isArray(originalMessages) ? originalMessages.filter(m => m && m.role === 'system') : [];
    const finalMessages = [].concat(originalSystem, [{ role: 'system', content: summaryText }], recent);

    // 生成摘要元数据（需要包含覆盖范围 startIdx/endIdx，使用索引基于原始 messages 列表）
    // 计算 startIdx/endIdx 在 originalMessages 中的位置（第一个和最后一个非 system）
    let startIdx = null, endIdx = null;
    for (let i = 0; i < originalMessages.length; i++) {
      const m = originalMessages[i];
      if (m && m.role && m.role !== 'system') { startIdx = i; break; }
    }
    for (let i = originalMessages.length - 1; i >= 0; i--) {
      const m = originalMessages[i];
      if (m && m.role && m.role !== 'system') { endIdx = i; break; }
    }

    const meta = {
      summaryId: 's_' + Date.now() + '_' + Math.floor(Math.random() * 1000000),
      summary: summaryText,
      startIdx: startIdx,
      endIdx: endIdx,
      ts: Date.now(),
      byModel: model
    };

    return { messages: finalMessages, summaryMeta: meta };
  } catch (err) {
    throw err; // 调用方会处理失败回退
  }
}
