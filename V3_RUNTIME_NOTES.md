# V3 runtime notes

The live Telegram/Web request path now uses `agent_runtime_v3.js` through `web_boot.js`.

## Behavior changes

- User requests are semantically planned from the complete message into a structured TaskSpec instead of using action-intent regexes in the live path.
- Execution tasks use durable `agent_tasks` state when available.
- Each plan step runs as an isolated worker context with an explicit role, acceptance criteria, tool loop, and verifier pass.
- Failed verification produces a repair instruction instead of silently marking a step complete.
- Sensitive tools use a V3 approval namespace and can resume the worker plan after approval.
- `dispatch_sub_agent` routes to the same real worker runtime rather than a one-shot role prompt.
- Existing Gmail/Drive/Sheets/Docs/GitHub/Railway/MCP/custom-tool implementations stay in `index.js` as reusable capability providers.

## Important deployment note

A real isolated sandbox/container is still recommended before enabling arbitrary LLM-generated custom JavaScript in a production environment. The existing project intentionally exposes powerful integrations, so least-privilege credentials and network isolation should be enforced at deployment time.
