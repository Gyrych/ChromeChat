# Ollama Chrome Assistant

这是一个 Chrome 扩展，用于连接本地 Ollama 服务并与本地模型对话。

## 功能

- 在弹出窗口选择本地模型并发送 prompt
- 显示模型返回的响应

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
3. 打开扩展弹窗，选择模型并发送消息。

## 注意事项

- 如果返回 403 错误，请确保已设置 `OLLAMA_ORIGINS=chrome-extension://*`。
- 目前为兼容性考虑使用非流式响应；若需流式响应，需要对扩展内的 NDJSON 流进行支持或使用代理服务。
