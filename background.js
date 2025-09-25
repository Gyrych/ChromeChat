// 背景脚本 - 处理存储和潜在的网络请求
chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Text Detector with Ollama installed');
  
  // 设置默认配置
  chrome.storage.local.set({
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama2'
  });
});

// 监听扩展图标点击
chrome.action.onClicked.addListener((tab) => {
  console.log('Extension icon clicked on tab:', tab.id);
});

// 处理来自popup的请求（如果需要）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], (data) => {
      sendResponse(data);
    });
    return true;
  }
  
  if (request.action === 'proxyRequest') {
    // 备用方案：通过background脚本发送请求
    fetch(request.url, request.options)
      .then(response => response.json())
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
