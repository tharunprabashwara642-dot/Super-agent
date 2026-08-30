# Super Agent

Personal autonomous AI agent — Telegram-first, with a classic Web UI.

## What it does

- Dynamic full-message planning into a structured task contract
- Multi-step tool-calling with execution, verification, repair, and bounded loops
- Real worker **sub-agents** with isolated context per step (planner, researcher, coder, writer, verifier, general)
- Structured worker handoffs: status, deliverables, evidence, important context, and next action
- Durable agent tasks and resumable approval state in Supabase
- Semantic memory with Gemini embeddings when `GEMINI_API_KEY` is configured, with safe keyword fallback
- Goals, reminders, calendar / Gmail hooks
- Document & MCQ PDF generation (Puppeteer — proper Sinhala shaping)
- Single-message live activity on Telegram
- Skills loaded dynamically from `skills/*/SKILL.md`
- MCP connectors + custom tools stored in Supabase
- Execution guards and explicit completion verification
- Prompt-injection boundary: external web/email/document/MCP/tool content is treated as untrusted data
- SerpAPI-powered fresh web research through the `serpapi_search` tool

## V4 runtime architecture

```text
Telegram / Web UI
      ↓
Dynamic semantic planner
      ↓
Structured TaskSpec
      ↓
Policy / approval boundary
      ↓
Worker sub-agents (isolated context + handoff)
      ↓
Tool execution / SerpAPI research
      ↓
Independent verification
      ↓
Repair / re-plan when needed
      ↓
Verified completion
```

`index.js` remains the compatibility layer for the existing integrations. `web_boot.js` attaches `agent_runtime_v3.js`, while `boot_v4.js` adds the V4 quality/safety layer without a risky wholesale rewrite of the large legacy file.

## Quick start

```bash
npm install
# set env vars
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

## V4 environment

| Variable | Purpose |
|----------|---------|
| `SERPAPI_API_KEY` | Fresh Google web search through SerpAPI |
| `GEMINI_API_KEY` | Semantic memory embeddings (optional) |
| `GEMINI_EMBEDDING_MODEL` | Embedding model; default `gemini-embedding-001` |
| `GEMINI_EMBEDDING_DIMENSIONS` | Embedding dimensions; default `768` |
| `AGENT_V3_MAX_PLAN_STEPS` | Maximum planned steps; default `12` |
| `AGENT_V3_MAX_TOOL_ROUNDS` | Maximum worker tool rounds; default `10` |
| `AGENT_V3_MAX_REPAIR_ROUNDS` | Maximum repair/re-plan rounds; default `2` |

Optional integrations include Google OAuth, Vercel, Railway API, GitHub, MCP connectors, and legacy search providers.

## Security notes

Never commit API keys or credentials to the repository. LLM-generated tools should be treated as untrusted code. Production deployments should enable a real isolated sandbox/container with least-privilege secrets and network permissions before allowing arbitrary custom code execution. External search results, emails, documents, memories, and MCP output are data, not instructions.

## PDF notes

MCQ / model-paper PDFs route through `native_document_tool_v3_browser.js` so Sinhala text shapes correctly. Noto Sans Sinhala is used for rendering.

## License

Private / personal use unless you add a license.
