# 项目概览

本仓库为 Chrome 扩展：`Ollama Chrome Assistant`，用于通过本地 Ollama 服务与大模型进行对话。

主要文件：
- `popup.html` / `popup.css` / `popup.js`：弹出窗口 UI 与前端逻辑
- `background.js`：Service Worker，负责与 Ollama API 通信
- `manifest.json`：扩展清单

技术栈与运行环境：
- Chrome 扩展（Manifest V3）
- 本地 Ollama 服务（默认 http://localhost:11434）
- 仅使用浏览器内置 API（chrome.runtime、chrome.storage）

运行与调试要点：
- 确保 Ollama 服务运行并能通过 `http://localhost:11434/api/tags` 返回模型列表
- 扩展需要 `host_permissions` 指定 Ollama 地址（manifest.json 已包含 `http://localhost:11434/*`）
- 在开发中使用 `chrome://extensions/` 加载未打包扩展并打开弹出窗口的控制台查看日志


# 本次问题诊断（简要）

问题描述：
- 在弹出窗口发送消息时，背景脚本向 `http://localhost:11434/api/generate` 发送请求返回 403，导致消息发送失败。

关键调试输出：
- 选择模型: `qwen3:8b`
- 发送消息: `你好`
- 后台日志显示请求发送到 `http://localhost:11434/api/generate`，返回状态码 403。

分析结论：
- Ollama 默认会拒绝来自浏览器扩展/非受信任 origin 的请求。需要通过设置环境变量 `OLLAMA_ORIGINS` 允许扩展 origin（例如 `chrome-extension://*`）。


# 我所做的修改（实现与理由）

1. 在 `popup.js` 中添加调试日志，输出当前选择的模型与发送的消息，便于定位请求参数：
   - 目的：验证模型名称与前端传入的请求体是否正确。

2. 在 `background.js` 中添加更多日志，并调整与 Ollama 的请求处理：
   - 原先使用流式（stream: true）在扩展环境中可能不稳定或触发服务器拒绝，临时改为非流式请求（stream: false）以便稳定获取完整 JSON 响应。
   - 增加对错误响应体的打印，便于诊断服务器返回的详细原因。
   - 曾尝试过用 XMLHttpRequest，后回退为标准 fetch 并记录响应头与响应体。

3. 文档：
   - （本文件）记录诊断过程与最终结论。
   - 新增 `doc/PRD_会话管理与上下文_zh.md`，定义“会话保存/加载/继续、多轮上下文与 /api/chat 切换、自动保存、导出、容量提醒、UI 交互”等需求范围与验收标准。
   - 更新 `README.md` 与 `README_zh.md`：新增 Session 管理、自动保存、/api/chat、多会话导出等说明。


# 操作建议（用户侧）

1. 启动 Ollama 时允许扩展 origin（必需）：
   - Windows PowerShell：
     ```powershell
     $env:OLLAMA_ORIGINS = "chrome-extension://*"
     ollama serve
     ```
   - 或使用批处理文件：
     ```batch
     @echo off
     set OLLAMA_ORIGINS=chrome-extension://*
     ollama serve
     ```

2. 重新加载扩展并在 popup 控制台查看日志：
   - 打开 `chrome://extensions/`，点击扩展右下角刷新按钮
   - 打开插件弹出页面并在开发者工具 Console 查看日志


# 变更记录

- 2025-09-30 09:00:00 - 添加调试日志到 `popup.js`，记录模型与消息
- 2025-09-30 09:10:00 - 修改 `background.js`：切换为非流式请求，增加错误输出，最后恢复为 `fetch` 并打印响应头
- 2025-09-30 09:25:00 - 尝试使用 `XMLHttpRequest`（已回退），最终使用 `fetch` 并记录必要日志
- 2025-10-02 10:00:00 - 增加 PRD 文档 `doc/PRD_会话管理与上下文_zh.md`，明确会话管理目标、数据结构、接口与 UI 方案
- 2025-10-02 10:30:00 - 实现会话管理（会话下拉、CRUD、导出）、切换到 `/api/chat`、自动保存与容量提醒；更新 README 中英文。
- 2025-10-02 10:40:00 - 隐藏弹出窗口顶部的连接状态文字，仅保留彩色指示器（修改 `popup.css`）。
- 2025-10-03 11:00:00 - 增强会话管理UI：重构为菜单系统，添加操作按钮（新建、重命名、导出、删除），改进视觉设计和交互逻辑。
- 2025-10-03 12:00:00 - 实现流式响应功能：支持NDJSON流式数据解析，用户可控制开关，默认启用，打字机效果，提升响应体验。


# 近期改进

## 会话管理UI增强 (2025-10-03)
- **UI重构**: 将会话管理从简单的下拉列表改为更直观的菜单系统
- **新增功能**:
  - 会话操作菜单（新建、重命名、导出、删除）
  - 改进的视觉设计，下拉箭头指示器
  - 危险操作（删除）使用红色高亮提示
- **交互优化**:
  - 点击会话按钮显示操作菜单
  - 右键或长按可快速访问会话列表
  - 自动隐藏其他菜单，避免UI冲突
- **代码改进**:
  - 重构事件处理逻辑，支持动态菜单事件绑定
  - 改进菜单显示/隐藏状态管理
  - 增强点击外部区域关闭菜单的逻辑

## 流式响应功能实现 (2025-10-03)
- **核心功能**: 实现真正的流式AI响应，提升用户体验
- **技术实现**:
  - 支持NDJSON格式的流式数据解析
  - 兼容多种响应格式（Ollama、OpenAI等）
  - 实时文本流式显示，打字机效果
  - 优雅的错误处理和连接管理
- **用户控制**:
  - 设置面板中添加流式响应开关
  - 支持在流式和非流式模式间切换
  - 默认启用流式响应
- **UI增强**:
  - 流式响应期间显示蓝色边框和打字机光标
  - 响应完成后自动移除视觉效果
  - 平滑的文本追加动画
- **性能优化**:
  - 高效的流数据处理，避免阻塞UI
  - 智能缓冲区管理，处理不完整的JSON行
  - 自动检测响应完成状态

# 未完成/需确认项

- 是否接受使用非流式请求的方案（若需要流式响应，需进一步实现 Chrome 扩展对 NDJSON 流的兼容处理或使用外部代理）
- 是否将 `CURSOR.md` 与 `README` 同步为中英文版本（我将根据用户指示继续更新 README）

# 文档同步与本次修改说明

- 我已将 `README.md` 与 `README_zh.md` 中关于会话保存的描述更新为与代码实现一致：会话仅在用户发送消息后以及模型返回完整回答后持久化；尚未包含用户消息的会话可能保留在内存中，直到包含用户消息才会写入 storage。
- 本次发布准备：建议在发布说明中注明对会话保存策略的调整与对 Ollama 服务的 `OLLAMA_ORIGINS` 要求。

## 变更记录（自动追加）

- 2025-10-04 10:30:00 - 同步 `README.md` / `README_zh.md` 的会话保存策略表述，确保文档与 `popup.js` 的实际持久化逻辑一致。

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