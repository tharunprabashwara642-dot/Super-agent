// ============================================================
// GEMINI BRAIN — same shim shape as anthropic_brain.js, so it's a
// drop-in swap. Use this while running on a free/cheap Gemini key
// instead of paying for Anthropic. Switch back later by changing
// ONE require() line in index.js — nothing else needs to change,
// because CHAT_TOOLS in index.js is already in native Gemini
// function-declaration format (OBJECT/STRING/... types), so unlike
// the Anthropic shim, this one needs no schema translation at all.
//
// Env vars:
//   GEMINI_API_KEYS or GEMINI_API_KEY   (comma-separate multiple for
//                                        rotation + failover, same as
//                                        the voice relay uses)
//   GEMINI_TEXT_MODEL                   (default: gemini-2.5-flash —
//                                        NOT flash-lite. Flash-Lite is
//                                        too weak to reliably follow
//                                        multi-tool instructions or
//                                        exact-count/format requests;
//                                        plain 2.5 Flash is still free
//                                        tier on API keys and handles
//                                        tool-calling far more reliably.)
// ============================================================
const { GoogleGenAI } = require("@google/genai");

function parseKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

let apiKeys = parseKeys();
let cursor = 0;
const clientCache = new Map();
let usageCallback = null;

function getClient(key) {
  if (!clientCache.has(key)) {
    clientCache.set(key, new GoogleGenAI({ apiKey: key }));
  }
  return clientCache.get(key);
}

function keyCount() {
  return apiKeys.length;
}

function setUsageCallback(fn) {
  usageCallback = fn;
}

function addKeyToPool(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return { added: false };
  if (apiKeys.includes(key)) return { added: false, total_keys: apiKeys.length };
  apiKeys.push(key);
  return { added: true, total_keys: apiKeys.length };
}

const DEFAULT_MODEL = () => process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const MAX_TOKENS = () => parseInt(process.env.GEMINI_MAX_TOKENS || "16000", 10);

// contents/tools/systemInstruction coming from index.js are ALREADY in
// Gemini's native shape (that's the shape the whole file was written
// against), so — unlike anthropic_brain.js — there is no format to
// convert here. We just pass them straight through to the SDK.

async function chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs = 60000) {
  if (apiKeys.length === 0) {
    return { error: { message: "No GEMINI_API_KEY configured. Set it in the environment variables." } };
  }
  if (!contents || !contents.length) return { error: { message: "No messages to send." } };

  const model = modelOverride && String(modelOverride).startsWith("gemini") ? modelOverride : DEFAULT_MODEL();

  const config = {
    maxOutputTokens: MAX_TOKENS(),
  };
  if (systemInstruction) config.systemInstruction = systemInstruction;
  if (tools && tools[0] && tools[0].functionDeclarations && tools[0].functionDeclarations.length) {
    config.tools = tools;
  }

  let lastErr;
  const attempts = Math.max(apiKeys.length, 1);
  for (let i = 0; i < attempts; i++) {
    const key = apiKeys[cursor % apiKeys.length];
    cursor++;
    try {
      const client = getClient(key);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      let resp;
      try {
        resp = await client.models.generateContent({
          model,
          contents,
          config,
        });
      } finally {
        clearTimeout(t);
      }

      if (typeof usageCallback === "function") { try { usageCallback(); } catch (_) {} }

      const candidate = resp && resp.candidates && resp.candidates[0];
      if (!candidate) {
        return { error: { message: "Gemini returned no candidates (likely blocked by safety filters)." } };
      }
      // Already Gemini-shaped — pass straight through, same as the
      // real Gemini API always returned to this codebase before.
      return { candidates: [{ content: candidate.content }] };
    } catch (e) {
      lastErr = e;
      const status = e && (e.status || e.code);
      const message = String((e && e.message) || "");
      const transient =
        status === 429 || status === 503 || (typeof status === "number" && status >= 500) ||
        /rate.?limit|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(message);
      if (transient) {
        console.error(`⚠️ Gemini key #${(cursor - 1) % apiKeys.length} transient error (${status || "?"}) — rotating.`);
        continue;
      }
      return { error: { message: message || `Gemini error ${status || ""}` } };
    }
  }
  return { error: { message: (lastErr && lastErr.message) || "All Gemini API keys failed." } };
}

module.exports = {
  chatShimmed,
  keyCount,
  addKeyToPool,
  setUsageCallback,
};
