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
        // 异步执行请求并通知前端
        fetchChatAndNotify(request.url, request.model, request.messages);
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

async function testConnection(url, sendResponse) {
  try {
    const response = await fetch(`${url}/api/tags`);
    if (response.ok) {
      sendResponse({ success: true, message: '连接成功' });
    } else {
      sendResponse({ success: false, message: `连接失败: HTTP ${response.status}` });
    }
  } catch (error) {
    sendResponse({ success: false, message: `连接错误: ${error.message}` });
  }
}

async function getModels(url, sendResponse) {
  try {
    const response = await fetch(`${url}/api/tags`);
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

    // 使用最简单的请求头
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
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

    // 发送完整响应回popup
    chrome.runtime.sendMessage({
      action: 'streamUpdate',
      chunk: fullResponse,
      done: true,
      fullResponse: fullResponse
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

    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
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

    chrome.runtime.sendMessage({
      action: 'streamUpdate',
      chunk: assistantText,
      done: true,
      fullResponse: assistantText
    });

    sendResponse({ success: true, message: '响应完成' });
  } catch (error) {
    console.error('发送 Chat 异常:', error);
    sendResponse({ success: false, message: `发送消息失败: ${error.message}` });
  }
}

async function fetchChatAndNotify(url, model, messages) {
  try {
    console.log('fetchChatAndNotify -> sending', { url, model, messagesLength: Array.isArray(messages) ? messages.length : 'invalid' });
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('fetchChatAndNotify HTTP error', response.status, text);
      chrome.runtime.sendMessage({ action: 'streamError', error: `HTTP ${response.status}: ${text}` });
      return;
    }

    const data = await response.json();
    console.log('fetchChatAndNotify -> got data', data);
    const assistantText = (data && data.message && typeof data.message.content === 'string')
      ? data.message.content
      : (typeof data.response === 'string' ? data.response : '');

    console.log('fetchChatAndNotify -> notifying popup', { assistantTextLength: assistantText.length });
    chrome.runtime.sendMessage({ action: 'streamUpdate', chunk: assistantText, done: true, fullResponse: assistantText });
  } catch (err) {
    console.error('fetchChatAndNotify error:', err);
    chrome.runtime.sendMessage({ action: 'streamError', error: err && err.message ? err.message : String(err) });
  }
}
