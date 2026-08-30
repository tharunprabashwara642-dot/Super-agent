# Super Agent

Personal autonomous AI agent — Telegram-first, with a classic simple Web UI.

## What it does

- Multi-step **tool-calling agent loop** (Anthropic + Gemini)
- **Memory, goals, reminders**, calendar / Gmail hooks
- **Document & MCQ PDF** generation (Puppeteer — proper Sinhala shaping)
- **Live activity** on Telegram: one message, spinner, elapsed timer, step list
- **Skills** (documents, pdf, research, spreadsheets)
- **Sub-agent roles** (researcher, coder, writer, verifier, planner)
- **MCP connectors** + custom tools stored in Supabase
- Guards for task scope, execution, and artifact delivery

## Quick start

```bash
npm install
# set env vars (see below)
npm start
```

Railway: uses `railway.toml` (`npm start`, healthcheck `/health`).

## Required environment

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `NIGHT_AGENT_CHAT_ID` | Your Telegram chat id |
| Anthropic / Gemini keys | LLM brains (see `index.js` header comments) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Memory, goals, custom tools |
| `WEB_UI_TOKEN` | Protects the web UI API |

Optional: Google OAuth, Vercel, Railway API, GitHub, Brave Search — documented in the top of `index.js`.

## Architecture (high level)

```
Telegram / Web UI
      ↓
 handleChatMessage (agent loop)
      ↓
 tools + skills + sub-agent prompts
      ↓
 live_activity (Telegram status)
      ↓
 native_document_tool_v3_browser (PDF via Puppeteer)
```

## PDF notes

MCQ / model-paper PDFs route through **Puppeteer** (`native_document_tool_v3_browser.js`) so Sinhala text shapes correctly and empty pages are minimized. Google Fonts (Noto Sans Sinhala) are loaded at render time.

## License

Private / personal use unless you add a license.
