# PRD: 读取网页正文并对话

## 背景
用户希望在当前页面上下文内与本地模型讨论网页内容。插件应支持用户单击弹窗按钮抓取页面正文，将正文作为用户消息保存到会话，并利用已有的摘要流程处理长文本。

## 目标
- 允许用户在弹窗中点击“抓取并发送”按钮以抓取当前页面正文并立即与模型对话。
- 抓取动作应保留页面标题与URL，并仅将主要正文保存为 `user` 消息。
- 对于长页面，按段发送并沿用现有摘要生成逻辑保证上下文合理。

## 功能需求
- 触发方式：由用户在 `popup` 中点击“抓取并发送”按钮触发注入脚本读取页面内容。
- 抓取范围：`document.body.innerText`，同时采集 `document.title` 与 `window.location.href`。
- 过滤规则：移除脚本、样式和导航等噪音，仅保留较大连续文本块（段落级别）。
- 存储：将抓取到的正文作为一条 `role: 'user'` 的消息追加到当前会话的 `session.messages` 并持久化。
- 发送：将文本分段（例如每段不超过 12000 字符或按自然段切分）并使用现有 `sendChat` 流程发送；在必要时触发 `generateSummary` 摘要流程。
- 权限：需要在 `manifest.json` 中添加 `scripting` 与 `activeTab` 权限。
- UI：在 `popup.html` 中添加 `id="fetchAndSendBtn"` 的按钮，放置在发送按钮附近并美观协调。

## 非功能需求
- 保留原文语言与格式（不过发送给模型时仅发送纯文本）。
- 性能：抓取与过滤在用户点击后尽可能在 1s 内完成（对于非常长页面可显示进度）。
- 隐私：仅在用户点击时抓取并发送，无需额外确认。

## 接口与数据结构
- content_script 将返回对象：{ title, url, textBlocks: [string, ...] }
- popup 将把拼接或分段后的文本作为 `user` 消息追加到当前 session，并调用 `sendChat`（通过 background）发送。

## 验收标准
1. 在支持的网页中，点击“抓取并发送”后，弹窗中能看到一条新的 user 消息，内容为页面摘要或前若干段落的拼接文本。
2. 背景脚本收到分段的 messages 并按流式/非流式模式向 Ollama 发送，最终在 popup 中显示模型回复。
3. `manifest.json` 包含 `scripting` 与 `activeTab` 权限。
4. 把抓取到的页面标题与 URL 作为 metadata 存在会话中（例如 message 的开头或附加字段）。

## 实施计划（分步）
1. 更新 `manifest.json` 添加 `scripting` 与 `activeTab` 权限。
2. 在 `popup.html` 中增加按钮 `fetchAndSendBtn`，并在 `popup.js` 中添加 UI 事件处理。
3. 新增 `content_script` 文件 `content_fetch.js`：负责抓取并清洗页面内容，返回 `title/url/textBlocks`。
4. 在 `popup.js` 中实现调用 `chrome.scripting.executeScript` 注入 `content_fetch.js` 并接收结果，按策略把文本追加为 user 消息并持久化。
5. 分段并通过已有 `sendChat` 路径发送；必要时触发摘要流程并保存摘要元数据。
6. 更新 `CURSOR.md` 与 `README_zh.md`、`README.md` 的功能说明与变更记录。

## 已实现

- 已新增 `content_fetch.js`（用于抓取并清洗页面正文并返回 `title/url/textBlocks`）。
- 已在 `popup.html` 中新增按钮 `fetchAndSendBtn`，并在 `popup.js` 中实现 `handleFetchAndSend`：注入 `content_fetch.js`、把抓取结果保存为 user 消息并调用后台 `sendChat`。
- 已更新 `manifest.json` 添加 `scripting` 与 `activeTab` 权限。

## 待完成

- 在 `background.js` 中验证并（如需）增强 `prepareMessagesWithSummary` 的分段处理逻辑以更好支持来自 content_fetch 的长文本。
- 更新 `README.md` 与 `README_zh.md` 的使用说明与变更记录。

## 风险与注意事项
- 需要用户同意新增 `scripting` 权限，扩展市场审核可能关注权限变更。
- 某些页面对脚本注入有限制（如 CSP 或内嵌环境），需要回退逻辑（显示错误或提示用户复制文本）。
