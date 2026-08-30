# Agent Runtime V3

The live request path is now driven by `agent_runtime_v3.js`.

Flow:

`user message -> semantic planner -> TaskSpec -> worker sub-agents -> tools -> verifier -> repair/replan -> verified result`

The existing `index.js` remains the capability layer for Telegram, Google, GitHub, Railway, Vercel, MCP and document tooling. `web_boot.js` swaps only the live request and sub-agent entrypoints to the V3 runtime, minimizing risk from the legacy 350KB compatibility file.

Sub-agent workers use isolated conversation state and explicit role contracts. Sensitive actions use a separate `agentv3:*` approval namespace and can resume the worker plan after approval.
