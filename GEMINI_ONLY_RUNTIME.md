# Gemini-only runtime

The production entrypoint uses `gemini_brain.js` as the single LLM provider.
Required runtime secret: `GEMINI_API_KEY` (or `GEMINI_API_KEYS` for rotation).
Web research uses `SERPAPI_API_KEY` when search is required.

The legacy Anthropic/NVIDIA provider names are not part of the production runtime.
