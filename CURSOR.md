# ChromeChat — 项目总览与架构文档

本文档为项目的系统化说明、运行与调试指南与变更记录（CURSOR 记忆体）。用于记录项目目标、目录结构、核心实现概览、运行配置、设计决策、已知限制与历史变更，供开发者离线检索与快速上手。

一、项目简介
- 名称：ChromeChat
- 类型：Chrome 扩展（Manifest V3）
- 版本：0.1.0
- 功能概览：
  - 在弹窗或侧边栏与本地或云端 Ollama 模型对话。
  - 支持流式（streaming）与非流式响应、打字机效果、会话管理（CRUD）、会话导出/导入、自动摘要与上下文截断。
  - 支持抓取当前页面正文并作为 user 消息发送。
  - 支持停止生成（中断进行中的请求）。

二、目录结构（简要）
- `popup.html` / `popup.css` / `popup.js`：弹窗 UI 与前端交互逻辑（会话管理、输入/输出、模型选择、设置）。
- `sidebar.html` / `content_sidebar_inject.js`：页面侧边栏与把手注入逻辑。
- `background.js`：Service Worker，负责与 Ollama 的网络交互、流式解析、摘要生成与消息桥接。
- `content_fetch.js`：注入脚本，抓取并清洗网页正文文本。
- `manifest.json`：扩展清单（权限、host_permissions、service_worker）。
- `doc/`：PRD 与产品设计文档（中文）。
- `icons/`, `lib/`：资源与库文件。
- 根目录：`README.md`、`README_zh.md`、`CURSOR.md`（本文件）。

三、系统架构概览
- 前端（Popup / Sidebar）
  - 负责渲染会话、处理用户输入、展示消息、会话持久化（`chrome.storage.local`）与 UI 设置。
  - 使用 `Chrome.scripting.executeScript` 注入 `content_fetch.js` 抓取页面内容。
- 后台（Service Worker — `background.js`）
  - 负责对 Ollama 的请求（`/api/tags`、`/api/chat`、`/api/generate`）、流式解析（ReadStream -> NDJSON/line delimited parsing）、摘要生成触发逻辑与与 popup 的消息桥接。
  - 提供非流式回退逻辑（当流不可用时），并支持云端 API Key（`ollama.com`）的 Authorization 注入。
- 存储
  - 会话单元保存在 `chrome.storage.local`，键名以 `ollama.session.<id>` 存储，会话索引保存在 `ollama.sessionIndex`（包含 `sessions[]` 与 `lastActiveSessionId`）。
  - 临时未持久化会话保存在内存 `_unsavedSessions`，避免大量空会话写入 storage。

四、关键数据模型
- Session:
  - { id, name, model, createdAt, updatedAt, messages[], summaries[], tokenUsage }
  - message: { role: 'user'|'assistant'|'system', content, ts }
- 索引（`ollama.sessionIndex`）:
  - { sessions: [id], lastActiveSessionId }

五、主要实现要点与设计决策
- 会话持久化策略：仅在“用户发送消息后”和“模型返回完整回答后”进行覆盖式保存，减少写入频率并通过会话锁序列化写操作。
- 并发写锁：前端实现内存级会话/索引写锁 `_acquireSessionLock(sessionId)`，串行化对单会话或索引的写入操作，避免竞态。
- 流解析与回退：后台按行解析 stream（兼容 Ollama NDJSON 及 OpenAI delta），如 stream 不可读则使用非流式 JSON 回退。
- 摘要触发：通过估算 prompt tokens（尝试使用服务端返回的 prompt_eval_count，否则用字符/4 估算），靠近模型上下文限制时触发自动摘要并以 system message 插入。
- Token 统计：窗口端使用简单的基于空白分词的估算器（chars/space 或 chars/4）作为占位，后台可能返回精确 token 信息用于累加 `session.tokenUsage`。
- 中断机制：每个请求生成 `requestId` 并由 background 管理对应的 `AbortController`，popup 可发送 `abortChat` 以中止在进行的请求并清理 UI 占位。

六、运行与配置（快速）
- 推荐环境变量（Windows PowerShell，管理员）：
  - setx OLLAMA_HOST "0.0.0.0:11434" -m
  - setx OLLAMA_ORIGINS "chrome-extension://<YOUR_EXTENSION_ID>" -m
- 默认 Ollama 地址：`http://localhost:11434`
- manifest 已包含 `host_permissions`：`http://localhost:11434/*` 与 `https://ollama.com/*`
- 加载扩展：`chrome://extensions/` -> Developer mode -> Load unpacked -> 选择项目目录。

七、常见问题与排查
- 403 from POST /api/chat：通常因 `OLLAMA_ORIGINS` 未包含扩展 origin -> 检查并重启 Ollama。
- Response body is not available：后端未提供可读流或 CORS/代理拦截 -> 切换到非流式模式获取完整 JSON。
- 注入脚本失败：某些 Chrome 内置页面或 Web Store 页面禁止注入，代码中已做检测 `isInjectableUrl()`。

八、安全与注意事项
- 不要在生产环境将 `OLLAMA_ORIGINS` 设为 `*`。
- Ollama API Key 存储在 `chrome.storage.local`，慎用并在不必要时移除。
- 若将 Ollama 暴露至 LAN，请配置防火墙规则限制访问。

九、历史变更（摘要）
- 2025-10-03: 修复消息持久化顺序、引入写锁。
- 2025-10-05: 支持 Ollama 云 API Key 配置并在请求中注入 Authorization。
- 2025-10-06: 引入浅色毛玻璃 UI（glassmorphism）。
- 2025-10-07: 增加“停止生成”中断功能；注入侧边栏把手以打开/关闭侧边栏。
（详细变更请见项目根 CURSOR.md 的变更记录）

十、待办与建议改进
- 集成 tokenizer 库以获得精确 token 计数。
- 改进流式兼容性：研究 MessageChannel 或 local proxy 以更可靠地传递大体量 NDJSON。
- 提供可选的 Ollama 启动脚本/服务以简化 Windows 启动时的环境变量配置。

变更记录（自动追加）
- 2025-10-08: 本次草稿由 AI 助手生成，已由用户确认并写入。