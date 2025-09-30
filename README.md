# Ollama Chrome Assistant

A Chrome extension that connects to a local Ollama server and allows chatting with local models.

## Features

- Select a local model and send prompts
- Display model responses in the popup UI

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
3. Open the extension popup, select a model and send messages.

## Notes

- If messages fail with HTTP 403, ensure `OLLAMA_ORIGINS` allows `chrome-extension://*`.
- The extension currently uses non-streaming responses for compatibility; streaming may be added later.
