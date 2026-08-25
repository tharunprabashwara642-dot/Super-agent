// ============================================================
// GEMINI BRAIN — reliable Gemini text + tool-calling shim.
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
  if (!clientCache.has(key)) clientCache.set(key, new GoogleGenAI({ apiKey: key }));
  return clientCache.get(key);
}

function keyCount() { return apiKeys.length; }
function setUsageCallback(fn) { usageCallback = fn; }

function addKeyToPool(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return { added: false, total_keys: apiKeys.length };
  if (apiKeys.includes(key)) return { added: false, total_keys: apiKeys.length };
  apiKeys.push(key);
  return { added: true, total_keys: apiKeys.length };
}

const DEFAULT_MODEL = () => process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const MAX_TOKENS = () => {
  const n = Number.parseInt(process.env.GEMINI_MAX_TOKENS || "16000", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 65536) : 16000;
};

function isTransientError(error) {
  const status = Number(error && (error.status || error.code));
  const message = String((error && error.message) || "");
  return status === 408 || status === 429 || status >= 500 ||
    /rate.?limit|resource.?exhausted|unavailable|overloaded|timeout|timed out|fetch failed/i.test(message);
}

function normaliseCandidate(resp) {
  const candidate = resp && resp.candidates && resp.candidates[0];
  if (!candidate || !candidate.content) {
    const reason = resp && resp.promptFeedback && resp.promptFeedback.blockReason;
    return { error: { message: reason ? `Gemini blocked the request: ${reason}` : "Gemini returned no candidates." } };
  }
  return { candidates: [{ content: candidate.content }] };
}

async function chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs = 60000) {
  if (!apiKeys.length) return { error: { message: "No GEMINI_API_KEY configured." } };
  if (!Array.isArray(contents) || !contents.length) return { error: { message: "No messages to send." } };

  const model = modelOverride && String(modelOverride).startsWith("gemini") ? String(modelOverride) : DEFAULT_MODEL();
  const attempts = Math.max(apiKeys.length, 1);
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const keyIndex = cursor % apiKeys.length;
    const key = apiKeys[keyIndex];
    cursor++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000));

    try {
      const config = {
        maxOutputTokens: MAX_TOKENS(),
        abortSignal: controller.signal,
      };
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (tools && tools[0] && Array.isArray(tools[0].functionDeclarations) && tools[0].functionDeclarations.length) {
        config.tools = tools;
      }

      const resp = await getClient(key).models.generateContent({ model, contents, config });
      if (typeof usageCallback === "function") {
        try { usageCallback(); } catch (_) {}
      }
      return normaliseCandidate(resp);
    } catch (error) {
      lastErr = error;
      if (!isTransientError(error)) {
        return { error: { message: String((error && error.message) || "Gemini request failed.") } };
      }
      console.error(`⚠️ Gemini key #${keyIndex + 1} transient failure; rotating key.`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { error: { message: String((lastErr && lastErr.message) || "All Gemini API keys failed.") } };
}

module.exports = { chatShimmed, keyCount, addKeyToPool, setUsageCallback };
