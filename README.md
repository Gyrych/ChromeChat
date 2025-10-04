# Ollama Chrome Assistant

A Chrome extension that connects to a local Ollama server and allows chatting with local models.

## Features

- Select a local model and send prompts
- Display model responses in the popup UI with **streaming support**
- Enhanced session management UI with intuitive menu system
- Session auto-save: sessions are persisted only at two moments (after the user sends a message, and after the model returns a complete response); unsaved/temporary sessions may be kept in memory until they contain user messages.
- Continue conversations with full context via `/api/chat`
- Export current/all sessions to JSON
- Real-time streaming responses with typewriter effect (configurable)
- Improved user interface with better session controls

## Requirements

- Chrome (Manifest V3 compatible)
- Ollama running locally (default `http://localhost:11434`)

## Installation

1. Start Ollama with origins allowed for extensions:

```powershell
$env:OLLAMA_ORIGINS = "chrome-extension://*"
ollama serve
```

2. Open `chrome://extensions/`, enable Developer mode and load unpacked extension pointing to this project folder.
3. Open the extension popup, configure settings (streaming is enabled by default). Note: the input and send/new session buttons are disabled until you select a model. After selecting a model the extension will automatically create a new session.
4. Use the session menu button at the top to access session management options (create/switch/rename/delete/export).

## Notes

- If messages fail with HTTP 403, ensure `OLLAMA_ORIGINS` allows `chrome-extension://*`.
- Streaming responses are enabled by default for better user experience; can be disabled in settings if needed.
- Unlimited storage permission is enabled to improve available storage for sessions; actual limits depend on the browser.
- The extension supports multiple response formats and gracefully handles connection issues.
- Session saving policy:
  - Sessions are saved (overwritten) only at two moments: after the user sends a message, and after the model returns a complete response. Opening the popup will not auto-load or auto-create sessions until a model is selected.
