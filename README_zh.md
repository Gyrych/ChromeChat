# Ollama Chrome Assistant

轻量级 Chrome 扩展，在浏览器弹窗或侧边栏中与本地 Ollama 模型快速交互，面向技术工作流设计。支持多轮会话、流式与非流式响应、会话持久化与导出/导入。

## 功能亮点

- 模型选择与快速发送 prompt
- 流式响应（可配置打字机效果）与非流式回退
- 会话管理：新建/切换/重命名/删除/导出
- 自动持久化：在用户发送消息后及模型返回完整回答后保存会话
- 使用 `/api/chat` 支持多轮上下文

## 架构概览

- 弹窗 / 侧边栏（UI）：`popup.html` / `sidebar.html`、`popup.css`、`popup.js` — 负责渲染会话、用户交互与本地存储（`chrome.storage.local`）。侧边栏在较宽视口下会提供更高的消息展示区域与固定输入区。
- 后台 worker：`background.js` — 与 Ollama 网络交互（`/api/tags`、`/api/chat`、`/api/generate`）、流式解析、摘要生成，并将更新发送给 popup。
- 存储：会话以 `ollama.session.<id>` 保存，索引保存在 `ollama.sessionIndex`。

## 运行要求

- Chrome（Manifest V3）
- 本地 Ollama 服务（默认 `http://localhost:11434`）

## 安装与配置

1. 配置 Ollama 允许扩展访问（Windows PowerShell，管理员）：

```powershell
setx OLLAMA_HOST "0.0.0.0:11434" -m
setx OLLAMA_ORIGINS "chrome-extension://<YOUR_EXTENSION_ID>" -m
```

将 `<YOUR_EXTENSION_ID>` 替换为 `chrome://extensions/` 中的扩展 id（不要带尖括号）。修改环境变量后需重启 Ollama 进程或系统。

2. 加载扩展：

- 打开 `chrome://extensions/` → 开启开发者模式 → Load unpacked → 选择本项目目录。

3. 打开弹窗，选择模型并开始对话。首次选择模型时会自动创建会话。

关于云端模型：若要使用 Ollama 的云端模型（`https://ollama.com`），请在设置面板中填写 `Ollama API Key`（将保存在 `chrome.storage.local`），并保存。扩展会在请求云端 API 时自动携带 `Authorization: Bearer <API_KEY>` 头。修改 `manifest.json` 后需在 `chrome://extensions` 手动重新加载扩展以应用新权限。

## 使用说明

- 会话只在两个时刻持久化：用户发送消息后、模型返回完整回答后，以减少频繁写入。
- 可在会话菜单导出单个或全部会话为 JSON 文件。

## 故障排查

- 若 `GET /api/tags` 成功但 `POST /api/chat` 返回 403，通常是 `OLLAMA_ORIGINS` 未正确配置。可用以下命令排查：

```bash
curl -v -H "Origin: chrome-extension://<YOUR_EXTENSION_ID>" http://localhost:11434/api/tags
```

- 若流式解析失败（如 `Response body is not available`），请在设置中切换到非流式以获取完整 JSON 响应用于排查。

## 安全注意

- 生产环境不要将 `OLLAMA_ORIGINS` 设为 `*`，优先使用 `chrome-extension://<id>`。
- 将 Ollama 暴露到局域网时，请在防火墙中限制访问权限。

## 开发备注

- background 负责将不同格式的响应统一为 `streamUpdate` 事件；popup 使用简单的字符/4 估算 token，可考虑集成 tokenizer 获取精确值。

## 变更记录（高层）

- 2025-10-05: 记录并修复 Ollama 白名单导致的 403 问题，更新文档。

- 2025-10-06: 增加浅色毛玻璃界面（glassmorphism），统一弹窗与侧边栏视觉风格，提升现代感。

