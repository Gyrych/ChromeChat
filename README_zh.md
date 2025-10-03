# Ollama Chrome Assistant

这是一个 Chrome 扩展，用于连接本地 Ollama 服务并与本地模型对话。

## 功能

- 在弹出窗口选择本地模型并发送 prompt
- 支持**流式响应**显示模型返回结果
- 增强的会话管理UI，直观的菜单系统
- 自动保存所有对话，无"临时会话"概念
- 通过 `/api/chat` 延续上下文进行多轮对话
- 导出当前/全部会话为 JSON
- 实时流式响应，打字机效果（可配置）
- 改进的用户界面，更好的会话控制

## 运行要求

- Chrome（支持 Manifest V3）
- 本地运行 Ollama（默认 `http://localhost:11434`）

## 安装与运行

1. 启动 Ollama 并允许扩展访问来源：

```powershell
$env:OLLAMA_ORIGINS = "chrome-extension://*"
ollama serve
```

2. 打开 `chrome://extensions/`，开启开发者模式（Developer mode），加载未打包扩展，选择本项目目录。
3. 打开扩展弹窗，配置设置（流式响应默认启用），选择模型并发送消息。
4. 使用顶部会话菜单按钮访问会话管理选项（新建/切换/重命名/删除/导出）。

## 注意事项

- 如果返回 403 错误，请确保已设置 `OLLAMA_ORIGINS=chrome-extension://*`。
- 流式响应默认启用以提供更好的用户体验；如需要可在设置中关闭。
- 已启用 `unlimitedStorage` 权限以放宽存储限制；实际可用空间依浏览器实现而定。
- 扩展支持多种响应格式，并优雅地处理连接问题。
