// 内容脚本 - 简化版本，主要用于基本功能
console.log('AI Detector content script loaded');

// 简单的消息监听
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({ status: "active", tabId: sender.tab.id });
  }
  
  if (request.action === "getText") {
    try {
      const text = getPageTextContent();
      sendResponse({ text: text });
    } catch (error) {
      sendResponse({ error: error.message });
    }
  }
  return true;
});

function getPageTextContent() {
  const mainContent = document.querySelector('article') || 
                     document.querySelector('.content') || 
                     document.querySelector('main') || 
                     document.body;
  
  const clone = mainContent.cloneNode(true);
  const elementsToRemove = clone.querySelectorAll(
    'script, style, nav, header, footer, aside, iframe, form, button, .ad, .advertisement'
  );
  elementsToRemove.forEach(el => el.remove());
  
  let text = clone.textContent || clone.innerText || '';
  return text.replace(/\s+/g, ' ').trim();
}
