# Super Agent

Gemini-only autonomous personal agent with dynamic planning, worker sub-agents, tools, memory, verification, SerpAPI research, and Telegram + Web UI.

## Runtime provider
Production chat/planning/tool-calling uses **Gemini** through `gemini_brain.js`.

Required Railway variables:
- `GEMINI_API_KEY` (or `GEMINI_API_KEYS` for key rotation)
- `SERPAPI_API_KEY` for fresh web research
- existing Telegram/Supabase variables used by the project

`npm start` loads the Gemini runtime bootstrap (`boot_v6.js`). No Anthropic API key is required.

## Agent flow

`User → Planner → Worker(s) → Tool(s) → Verify → Re-plan/Repair → Final response`

When the user requests explicit worker roles, the planner preserves those roles and dependencies. Worker handoffs contain status, deliverables, evidence, important context, and next action.
