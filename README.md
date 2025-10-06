# Ollama Chrome Assistant

Lightweight Chrome extension that provides a popup or sidebar UI to interact with local Ollama models. Designed for quick technical workflows, it supports multi-turn sessions, streaming and non-streaming responses, session persistence, and export/import of sessions.

## Features

- Model selection and prompt sending in a compact popup UI
- Streaming responses with typewriter effect (configurable)
- Session management: create / switch / rename / delete / export
- Automatic session persistence at two points: after user sends a message and after the model returns a full response
- Support for `/api/chat` for multi-turn context; fallback to non-streaming when needed

## Architecture Overview

- Popup / Sidebar (UI): `popup.html` / `sidebar.html`, `popup.css`, `popup.js` — user interface, session rendering, local persistence (`chrome.storage.local`).
- Background worker: `background.js` — network layer to Ollama (`/api/tags`, `/api/chat`, `/api/generate`), stream parsing, summary generation, and bridging updates to popup.
- Storage: sessions stored as `ollama.session.<id>`; index stored as `ollama.sessionIndex` in `chrome.storage.local`.

## Requirements

- Chrome (Manifest V3)
- Local Ollama service (default `http://localhost:11434`)

## Installation & Configuration

1. Configure Ollama to allow requests from the extension. Recommended (Windows PowerShell, admin):

```powershell
setx OLLAMA_HOST "0.0.0.0:11434" -m
setx OLLAMA_ORIGINS "chrome-extension://<YOUR_EXTENSION_ID>" -m
```

Replace `<YOUR_EXTENSION_ID>` with the extension id from `chrome://extensions/` (do not include angle brackets). Restart Ollama or the system after changing environment variables.

2. Load the extension:

- Open `chrome://extensions/` → enable Developer mode → Load unpacked → select this project folder.

3. Open the popup, choose a model, and start chatting. The extension will auto-create a session on first model selection.

Note about cloud models: If you want to use Ollama's cloud models at `https://ollama.com`, open the settings panel and enter your `Ollama API Key` (saved to `chrome.storage.local`). The extension will add an `Authorization: Bearer <API_KEY>` header when calling the cloud API. After updating `manifest.json` you must reload the extension in `chrome://extensions`.

## Usage Notes

- Sessions are auto-saved at two points to reduce write churn: after the user sends a message and after the assistant completes its response.
- You can export single sessions or all sessions as JSON from the session menu.

## Troubleshooting

- If `GET /api/tags` succeeds but `POST /api/chat` returns 403, confirm `OLLAMA_ORIGINS` includes the extension origin. Test with:

```bash
curl -v -H "Origin: chrome-extension://<YOUR_EXTENSION_ID>" http://localhost:11434/api/tags
```

- If streaming fails (e.g. `Response body is not available`), switch to non-streaming in settings to capture a full JSON response for debugging.

## Security

- Do not set `OLLAMA_ORIGINS` to `*` in production. Prefer `chrome-extension://<id>`.
- When exposing Ollama on a LAN (`0.0.0.0`), restrict firewall rules to limit access to trusted hosts.

## Development Notes

- The background worker normalizes different response formats and sends `streamUpdate` messages to the popup. The popup applies a simple token estimation (`chars/4`) for warnings; consider integrating a tokenizer for accuracy.

## Changelog (high level)

- 2025-10-05: Documented OLLAMA_ORIGINS fix and synced docs.

- 2025-10-06: Added a light glassmorphism UI for popup and sidebar to modernize appearance and ensure consistent styling.

