// 处理与Ollama的通信
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'testConnection') {
    testConnection(request.url, sendResponse);
    return true; // 保持消息通道开放，用于异步响应
  }

  if (request.action === 'getModels') {
    getModels(request.url, sendResponse);
    return true;
  }

  if (request.action === 'sendMessage') {
    sendMessageToOllama(request.url, request.model, request.message, sendResponse);
    return true;
  }
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
