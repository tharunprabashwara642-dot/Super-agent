# Super Agent

Personal autonomous AI agent — Telegram-first, with a classic Web UI.

## What it does

- Dynamic full-message planning into a structured task contract
- Multi-step tool-calling with execution, verification, repair, and bounded loops
- Real worker **sub-agents** with isolated context per step (planner, researcher, coder, writer, verifier, general)
- Durable agent tasks and resumable approval state in Supabase
- Memory, goals, reminders, calendar / Gmail hooks
- Document & MCQ PDF generation (Puppeteer — proper Sinhala shaping)
- Live activity on Telegram
- Skills loaded dynamically from `skills/*/SKILL.md`
- MCP connectors + custom tools stored in Supabase
- Execution guards and explicit completion verification

## V3 runtime architecture

```text
Telegram / Web UI
      ↓
Dynamic semantic planner
      ↓
Structured TaskSpec
      ↓
Policy / approval boundary
      ↓
Worker sub-agents (isolated context)
      ↓
Tool execution
      ↓
Independent verification
      ↓
Repair / re-plan when needed
      ↓
Verified completion
```

`index.js` remains the compatibility layer for the existing integrations. `web_boot.js` attaches `agent_runtime_v3.js` as the live request/runtime layer so the large legacy file does not need a risky wholesale rewrite.

## Quick start

```bash
npm install
# set env vars (see index.js)
npm start
```

Run the runtime checks with:

```bash
npm run check
npm run test:runtime
```

Railway: uses `railway.toml` (`npm start`, healthcheck `/health`).

## Required environment

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `NIGHT_AGENT_CHAT_ID` | Your Telegram chat id |
| Anthropic / Gemini keys | LLM brain provider(s) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Durable agent state, memory, tasks, custom tools |
| `WEB_UI_TOKEN` | Protects the web UI API |

Optional integrations include Google OAuth, Vercel, Railway API, GitHub, Brave Search and MCP connectors.

## Security notes

LLM-generated tools should be treated as untrusted code. Production deployments should enable a real isolated sandbox/container with least-privilege secrets and network permissions before allowing arbitrary custom code execution.

## PDF notes

MCQ / model-paper PDFs route through `native_document_tool_v3_browser.js` so Sinhala text shapes correctly. Noto Sans Sinhala is used for rendering.

## License

Private / personal use unless you add a license.
