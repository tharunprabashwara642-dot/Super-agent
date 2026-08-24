// ============================================================
// ANTHROPIC (CLAUDE) BRAIN — replaces the old NVIDIA/Gemini text brain.
// FIXED VERSION: Better max_tokens, error handling, and reasoning support
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");

function parseKeys() {
  return (process.env.ANTHROPIC_API_KEYS || process.env.ANTHROPIC_API_KEY || "")
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
    clientCache.set(key, new Anthropic({ apiKey: key, maxRetries: 2 }));
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

// FIXED: Better model selection with reasoning support
const DEFAULT_MODEL = () => process.env.ANTHROPIC_TEXT_MODEL || "claude-sonnet-4-20250514";
const EFFORT = () => (process.env.ANTHROPIC_EFFORT || "high").toLowerCase();

// FIXED: Much higher max_tokens for complex tasks like exam papers
const MAX_TOKENS = () => {
  const envVal = parseInt(process.env.ANTHROPIC_MAX_TOKENS || "0", 10);
  if (envVal > 0) return envVal;
  // Default: 64K for sonnet, 128K for opus
  return DEFAULT_MODEL().includes("opus") ? 128000 : 64000;
};

const TYPE_MAP = {
  OBJECT: "object", STRING: "string", NUMBER: "number",
  INTEGER: "integer", BOOLEAN: "boolean", ARRAY: "array",
};

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = {};
  if (schema.type) out.type = TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = normalizeSchema(v);
  }
  if (schema.items) out.items = normalizeSchema(schema.items);
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function inlineDataToBlock(inlineData) {
  const mime = inlineData.mimeType || "application/octet-stream";
  if (IMAGE_TYPES.has(mime)) {
    return { type: "image", source: { type: "base64", media_type: mime, data: inlineData.data } };
  }
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: inlineData.data } };
  }
  return { type: "text", text: `[attached file of type ${mime} — cannot be read inline]` };
}

function toAnthropicMessages(contents) {
  const messages = [];
  let lastToolUseIds = [];

  for (const c of contents || []) {
    const parts = c.parts || [];

    if (c.role === "model") {
      const rawPart = parts.find((p) => p && p.__anthropicRaw);
      if (rawPart && Array.isArray(rawPart.__anthropicRaw) && rawPart.__anthropicRaw.length) {
        messages.push({ role: "assistant", content: rawPart.__anthropicRaw });
        lastToolUseIds = rawPart.__anthropicRaw.filter((b) => b.type === "tool_use").map((b) => b.id);
        continue;
      }
      const blocks = [];
      for (const p of parts) {
        if (p.text) blocks.push({ type: "text", text: p.text });
        else if (p.functionCall) {
          blocks.push({
            type: "tool_use",
            id: `call_${messages.length}_${blocks.length}`,
            name: p.functionCall.name,
            input: p.functionCall.args || {},
          });
        }
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "(continuing)" });
      messages.push({ role: "assistant", content: blocks });
      lastToolUseIds = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
      continue;
    }

    const frParts = parts.filter((p) => p.functionResponse);
    if (frParts.length) {
      const content = frParts.map((p, idx) => ({
        type: "tool_result",
        tool_use_id: lastToolUseIds[idx] || `call_unknown_${idx}`,
        content: JSON.stringify(p.functionResponse.response),
      }));
      messages.push({ role: "user", content });
      lastToolUseIds = [];
    } else {
      const content = [];
      for (const p of parts) {
        if (p.text) content.push({ type: "text", text: p.text });
        else if (p.inlineData) content.push(inlineDataToBlock(p.inlineData));
      }
      if (content.length === 1 && content[0].type === "text") messages.push({ role: "user", content: content[0].text });
      else if (content.length) messages.push({ role: "user", content });
    }
  }

  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

function toGeminiParts(message) {
  const parts = [];
  for (const b of message.content || []) {
    if (b.type === "text") parts.push({ text: b.text });
    else if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input || {} } });
  }
  if (Array.isArray(message.content) && message.content.length) {
    parts.push({ __anthropicRaw: message.content });
  }
  return parts;
}

// FIXED: Better timeout and token handling
async function chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs = 120000) {
  if (apiKeys.length === 0) {
    return { error: { message: "No ANTHROPIC_API_KEY configured. Set it in the environment variables." } };
  }

  const messages = toAnthropicMessages(contents);
  if (!messages.length) return { error: { message: "No messages to send." } };

  const model = modelOverride && String(modelOverride).startsWith("claude") ? modelOverride : DEFAULT_MODEL();

  // FIXED: Dynamic max_tokens based on task complexity
  const maxTokens = timeoutMs >= 120000 ? MAX_TOKENS() : Math.min(MAX_TOKENS(), 16000);

  const params = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  // FIXED: Enable thinking/reasoning for complex tasks
  if (model.includes("claude-3-7") || model.includes("claude-sonnet-4")) {
    params.thinking = { type: "enabled", budget_tokens: Math.floor(maxTokens * 0.2) };
  }

  if (systemInstruction) params.system = systemInstruction;

  const fnDecls = (tools && tools[0] && tools[0].functionDeclarations) || [];
  if (fnDecls.length) {
    params.tools = fnDecls.map((fd) => ({
      name: fd.name,
      description: fd.description || "",
      input_schema: normalizeSchema(fd.parameters || { type: "OBJECT", properties: {} }),
    }));
  }

  let lastErr;
  const attempts = Math.max(apiKeys.length, 1);
  for (let i = 0; i < attempts; i++) {
    const key = apiKeys[cursor % apiKeys.length];
    cursor++;
    try {
      const client = getClient(key);
      const resp = await client.messages.create(params, { timeout: timeoutMs });
      if (typeof usageCallback === "function") { try { usageCallback(); } catch (_) {} }
      if (resp.stop_reason === "refusal") {
        return { error: { message: "The request was declined by Claude's safety system.", refusal: true } };
      }
      return { candidates: [{ content: { role: "model", parts: toGeminiParts(resp) } }] };
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      if (status === 429 || status === 529 || (status >= 500 && status < 600)) {
        console.error(`⚠️ Anthropic key #${(cursor - 1) % apiKeys.length} transient error ${status} — rotating.`);
        continue;
      }
      return { error: { message: e.message || `Anthropic HTTP ${status || "error"}` } };
    }
  }
  return { error: { message: (lastErr && lastErr.message) || "All Anthropic API keys failed." } };
}

module.exports = {
  chatShimmed,
  keyCount,
  addKeyToPool,
  setUsageCallback,
  normalizeSchema,
  toAnthropicMessages,
  toGeminiParts,
};
