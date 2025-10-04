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
        const streamEnabled = request.stream !== false; // 默认启用流式，除非明确设置为false
        fetchChatAndNotify(request.url, request.model, request.messages, streamEnabled);
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
    // 使用安全发送，若 popup 不存在则持久化以便 popup 下次打开时取回
    await safeSendToPopup({
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

async function fetchChatAndNotify(url, model, messages, stream = true) {
  let fullResponse = '';
  let isFirstChunk = true;

  try {
    console.log('fetchChatAndNotify -> sending request', {
      url,
      model,
      messagesLength: Array.isArray(messages) ? messages.length : 'invalid',
      stream
    });

    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream })
    });

    if (!response.ok) {
      const text = await response.text();
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

      chrome.runtime.sendMessage({
        action: 'streamUpdate',
        chunk: assistantText,
        done: true,
        fullResponse: assistantText
      });
      return;
    }

    if (!response.body) {
      throw new Error('Response body is not available');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          console.log('fetchChatAndNotify -> parsed chunk', data);

          // 处理不同格式的响应
          let chunkContent = '';

          if (data.message && typeof data.message.content === 'string') {
            // Ollama /api/chat 格式
            chunkContent = data.message.content;
          } else if (typeof data.response === 'string') {
            // 兼容其他格式
            chunkContent = data.response;
          } else if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
            // OpenAI兼容格式
            chunkContent = data.choices[0].delta.content;
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
          if (data.done === true || (data.choices && data.choices[0] && data.choices[0].finish_reason)) {
            console.log('fetchChatAndNotify -> response completed');
            await safeSendToPopup({
              action: 'streamUpdate',
              chunk: '',
              done: true,
              fullResponse: fullResponse
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
    await safeSendErrorToPopup({
      action: 'streamError',
      error: err && err.message ? err.message : String(err)
    });
  }
}
