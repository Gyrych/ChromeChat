# 项目总览与架构文档

本文档为项目的系统化说明、运行指南与变更记录（CURSOR 记忆体）。内容覆盖：项目目标、目录结构、核心实现概览、运行与调试步骤、安全与部署注意、设计决策、已知限制与历史变更。

目的：为后续开发者（包含你本人）提供一份可以离线检索的、结构化的项目记忆，减少上下文切换成本并保证实现与 PRD/README 保持一致。

一、项目简介

- 名称：Ollama Chrome Assistant
- 类型：Chrome 扩展（Manifest V3）
- 功能：在浏览器弹窗中选择本地模型并与本地 Ollama 服务对话，支持会话管理、流式与非流式响应、会话导出/导入与摘要功能。
 - 名称：Ollama Chrome Assistant
 - 类型：Chrome 扩展（Manifest V3）
 - 功能：在浏览器弹窗或侧边栏中选择本地模型并与本地 Ollama 服务对话，支持会话管理、流式与非流式响应、会话导出/导入与摘要功能。

二、目录与关键文件

- `popup.html` / `popup.css` / `popup.js`：前端 UI 与交互逻辑（会话管理、输入输出、模型选择、token 估算、设置面板）。
- `background.js`：Service Worker，负责与 Ollama 的所有网络交互（/api/tags、/api/chat、/api/generate）、流式解析、摘要生成触发、与 popup 的消息桥接与 pending 缓存。
- `manifest.json`：扩展清单（权限、host_permissions、service_worker）。
- `doc/PRD_会话管理与上下文_zh.md`：会话管理 PRD 与设计决策。
- `CURSOR.md`：本文件（项目记忆与变更记录）。

三、系统架构概览

- 浏览器弹窗（popup）作为前端展示层，负责用户输入、会话渲染与本地持久化（`chrome.storage.local`）。
 - 浏览器弹窗（popup）或侧边栏（sidebar）作为前端展示层，负责用户输入、会话渲染与本地持久化（`chrome.storage.local`）。侧边栏在较宽视口下提供更长的会话展示高度与粘性输入区域。
- `background.js` 作为网络层与控制层，处理与 Ollama 的交互、流式数据解析与中间态存储（当 popup 关闭时，pending 消息会写入 local storage）。
- 数据持久化：采用 `chrome.storage.local` 存储 session 对象与索引；会话持久化策略为“在用户发送消息后”和“模型返回完整回答后”两处自动保存。

四、关键实现细节

- 会话模型：Session 对象包含 `id, name, model, createdAt, updatedAt, messages[]`，索引保存在 `ollama.sessionIndex`（sessions 列表 + lastActiveSessionId）。
- 并发控制：在 `popup.js` 中引入内存级写锁 `_acquireSessionLock`，以序列化对单个 session 与索引的写操作，防止并发写入导致的数据竞争。
- 流式解析：`background.js` 使用 `response.body.getReader()` 读取流，按行拆分 NDJSON，兼容多种格式（Ollama `/api/chat`、OpenAI 风格 delta），增量发送 `streamUpdate` 消息回 popup。
- 摘要策略：在发送前评估 prompt tokens（尝试通过 `max_tokens:0` 请求获取服务端返回的 prompt_eval_count，如不可用则进行字符数/4 的估算），当接近模型上下文阈值时触发 `generateSummary` 并将摘要插入为 system 消息，保留最近若干条消息以维持短期上下文。

五、运行与配置（快速参考）

- 推荐环境变量（Windows，管理员 PowerShell）：
  - `OLLAMA_HOST=0.0.0.0:11434`
  - `OLLAMA_ORIGINS=chrome-extension://<YOUR_EXTENSION_ID>`
  注意：不要在值周围使用尖括号。修改后需重启 Ollama 进程或系统以生效。

- manifest 中已包含 `host_permissions` 指向 `http://localhost:11434/*`，确保扩展可发起请求。

六、调试要点与常见问题

- 如果 `GET /api/tags` 成功但 `POST /api/chat` 返回 403，通常为 Ollama 白名单（`OLLAMA_ORIGINS`）问题。使用 `curl -v -H "Origin: chrome-extension://<id>"` 验证。
- 若流式解析抛出 `Response body is not available`，说明服务端未提供可读流或被拦截，建议回退到非流式模式以获取完整 JSON 并打印响应体以诊断。
- 在 popup 开发时若收不到流式更新，检查 background -> popup 的消息桥接（`chrome.runtime.sendMessage`）与 pending 缓存逻辑（`ollama.pendingStreamUpdates`）。

七、安全与部署注意

- 切勿长期在 `OLLAMA_ORIGINS` 使用 `*`，生产环境应仅允许具体扩展 origin。
- 若需要通过局域网访问 Ollama，应同时在系统防火墙中针对端口 `11434` 做最小化放行策略。

八、历史变更摘要（高亮）

- 2025-09-30: 增加强调/debug 日志，改进 background 的错误处理；实现对 `/api/chat` 的支持并初步实现非流式回退逻辑。
- 2025-10-02: 增加 PRD 并实现会话管理（CRUD、导出）、摘要触发与会话索引管理。
- 2025-10-03: 重构会话 UI，完善流式解析、打字机效果与 token 显示。
- 2025-10-05: 修复 Ollama 白名单导致的 403 问题，记录在本文件并同步到 README。

九、未决与建议改进项

- 更精确的 token 计数：集成 tokenizer 库或请求服务端提供精确计数以替代字符/4 的估算。
- 流式兼容性：研究是否能通过 Service Worker 与 MessageChannel 更稳健地传递大体量 NDJSON 流，或引入本地小型代理以统一 CORS 与流式处理。
- 自动化部署：提供可选的 Windows 服务或任务计划脚本以保证 Ollama 在系统启动时以正确环境变量启动，免去手动干预。

如需我把本文件进一步拆分为单独的开发文档（API 参考、架构图、变更日志），或把关键设计决策写成议题便于审阅，我可以继续分步输出。
- 2025-10-04 11:20:00 - 实现摘要失败回退：当摘要生成失败时，后台会发送 `summaryFailed` 给 popup，popup 在会话中内嵌提示并继续使用完整历史发送请求。
- 2025-10-04 11:25:00 - 导出/导入：会话导出已包含 `session.summaries` 字段，保证导入后能还原摘要元数据与原始历史。
- 2025-10-04 11:30:00 - CURSOR.md 与 PRD 文档已同步更新，记录实现细节与审计要求（每次摘要需记录时间戳与覆盖范围）。
 - 2025-10-05 16:10:00 - 新增：支持 Ollama 云 API Key 配置并在请求中添加 Authorization 头
  - 更改文件：`popup.html`, `popup.js`, `background.js`, `manifest.json`
  - 目的：允许用户通过扩展直接调用 `https://ollama.com` 云端模型并在请求头中包含 `Authorization: Bearer <API_KEY>`，解决扩展无法读取系统环境变量导致的云端认证问题。
  - 主要实现：
    - 在 `popup.html` 的设置面板新增 `Ollama API Key` 输入框（`#ollamaApiKey`），类型为 `password`，并保存到 `chrome.storage.local` 的 `ollamaSettings.apiKey`。
    - 在 `background.js` 中新增 `buildRequestHeaders(url, extraHeaders)` 工具函数：当目标 host 中包含 `ollama.com` 时，从 `chrome.storage.local` 读取 `ollamaSettings.apiKey` 并在 headers 中加入 `Authorization: Bearer <apiKey>`（若存在）。
    - 将原有直接使用的 `headers: {'Content-Type': 'application/json'}` 替换为通过 `buildRequestHeaders` 构建的 headers，从而统一处理 cloud 与本地请求。
    - 在 `manifest.json` 中追加 `host_permissions` 条目：`https://ollama.com/*`，以允许扩展向云端发起请求（用户需要手动重新加载扩展以使权限生效）。
  - 风险与说明：
    - API Key 将存储在 `chrome.storage.local`（本地浏览器存储），存在一定风险，请用户仅在可信环境下使用并在不需要时删除。
    - 日志中不会打印明文 API Key，仅输出是否包含 Authorization 标志以便调试。

# 新增功能记录：模型上下文与 token 统计显示 (2025-10-04)

- 更改文件：`popup.html`、`popup.css`、`popup.js`
- 目的：在弹出窗口底部显示所选模型的最大上下文长度（若已知），以及当前会话的总 token 数和下一回合发送给模型的预计 token 数。方便用户把控上下文长度与成本。
- 主要实现：
  - 在 `popup.html` 添加底部信息栏，包含 `#modelContextValue`、`#totalTokens`、`#nextTurnTokens` 三个元素。
  - 在 `popup.css` 中添加 `.footer-info`、`.model-context`、`.token-stats` 的样式，保证布局美观且与现有风格协调。
  - 在 `popup.js` 内：添加 `updateModelContextDisplay()` 函数用于将已知模型名映射到其最大上下文长度并显示；添加 `estimateTokensFromText()` 与 `refreshTokenStats()` 实现简易 token 估算（按空格分词作为占位估算），并在关键交互点（切换模型、输入变化、发送前后）调用刷新。
- 注意事项：当前 token 估算为简易基于词的估算，仅做相对参考；如果需要精确计数（例如使用特定 tokenizer）可后续集成更精确的 tokenizer 库或在后端由 Ollama/模型服务返回精确计数。


## 变更记录（自动追加）

- 2025-10-03 13:00:00 - 修复 `popup.js` 中 `sendMessage` 的持久化顺序问题：
  - 问题：原实现先将 assistant 占位写入会话再写 user，导致会话内消息顺序不正确（assistant 在 user 之前）。
  - 变更：调整为在持久化层面先 append user，再 append assistant 占位；UI 渲染仍保持先展示 user 并显示 assistant 占位。相关文件：`popup.js`。
  - 目的：保证会话中消息顺序为 user -> assistant，避免上下文构建时顺序错误。

- 2025-10-03 13:05:00 - 添加内存级写锁以防止 session index 与单个会话并发写入竞态：
 - 2025-10-03 14:00:00 - 会话管理行为更新：
   - 变更：在 UI 上禁用发送与新建按钮，直到用户选择模型；将底部“清空对话”按钮替换为“新建会话”并改为在新建前保存当前会话。
   - 变更：移除在打开插件时自动创建/加载会话的逻辑，改为只有用户在选择模型后自动新建一个会话。
   - 变更：仅在两处场景自动保存会话（覆盖保存）：用户发送消息后、模型返回完整回复后。其他时机不再触发自动保存。
   - 相关文件：`popup.html`、`popup.js`
  - 变更：在 `popup.js` 中增加 `_sessionLocks` 结构与 `_acquireSessionLock` 方法，并在 `saveSession`、`saveSessionIndex`、`createSession`、`deleteSession` 中使用锁保护读写。
  - 目的：避免并发创建/删除/保存会话时导致索引或会话数据不一致的问题。

- 2025-10-05 15:00:00 - 新增：抓取并发送当前网页正文功能（实现初版）
  - 更改文件：`manifest.json`（添加 `scripting` 与 `activeTab` 权限）、`popup.html`（新增 `fetchAndSendBtn`）、`popup.js`（添加注入并保存逻辑）、新增 `content_fetch.js`（抓取/清洗页面文本）。
  - 目的：允许用户在弹窗中一键抓取当前页面正文并将其作为 `user` 消息保存与发送，沿用后台摘要与分段处理逻辑。
  - 状态：已实现前端注入与抓取脚本，后台分段/摘要逻辑将沿用现有 `prepareMessagesWithSummary`。