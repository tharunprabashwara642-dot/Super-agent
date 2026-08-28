// ============================================================
// ANTHROPIC BRAIN — Gemini-shape shim over the real Anthropic Messages API.
// ============================================================
// index.js (and the tool loop inside it) was written against Gemini's
// request/response shape:
//   contents = [{ role: "user"|"model", parts: [{text}|{functionCall}|
//                 {functionResponse}|{inlineData}] }]
//   response  = { candidates: [{ content: { role, parts } }] }
// This file translates that shape to/from Anthropic's real Messages API
// (system prompt, user/assistant turns, tool_use/tool_result blocks,
// image/document blocks) and owns API-key rotation + 429/5xx failover,
// mirroring gemini_brain.js's contract exactly:
//   chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs)
//   keyCount() / addKeyToPool(key) / setUsageCallback(fn)
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
  if (!clientCache.has(key)) clientCache.set(key, new Anthropic({ apiKey: key }));
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
  if (!key) return { added: false, reason: "Empty key.", total_keys: apiKeys.length };
  if (apiKeys.includes(key)) return { added: false, reason: "That key is already in the rotation.", total_keys: apiKeys.length };
  apiKeys.push(key);
  return { added: true, total_keys: apiKeys.length };
}

const DEFAULT_MODEL = () => process.env.ANTHROPIC_TEXT_MODEL || "claude-opus-5";
const MAX_TOKENS = () => {
  const n = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS || "8192", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 64000) : 8192;
};

function isTransientError(e) {
  const s = Number(e && (e.status || e.code));
  const m = String(e?.message || "");
  return s === 408 || s === 429 || s >= 500 || /rate.?limit|overloaded|timeout|timed out|fetch failed|connection/i.test(m);
}

// ---- Gemini "type: OBJECT/STRING/ARRAY..." -> JSON Schema lowercase ----
function lowercaseSchemaTypes(node) {
  if (Array.isArray(node)) return node.map(lowercaseSchemaTypes);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "type" && typeof v === "string") out[k] = v.toLowerCase();
      else out[k] = lowercaseSchemaTypes(v);
    }
    return out;
  }
  return node;
}

function convertTools(tools) {
  const decls = tools?.[0]?.functionDeclarations;
  if (!Array.isArray(decls) || !decls.length) return undefined;
  return decls.map((d) => ({
    name: d.name,
    description: d.description || "",
    input_schema: lowercaseSchemaTypes(d.parameters) || { type: "object", properties: {} },
  }));
}

// ---- Gemini "parts" -> Anthropic content blocks ----
function partsToAnthropicContent(parts, forRole) {
  const blocks = [];
  for (const p of parts || []) {
    if (p == null) continue;
    if (p.text != null) {
      if (p.text === "" ) continue;
      blocks.push({ type: "text", text: p.text });
    } else if (p.functionCall) {
      blocks.push({
        type: "tool_use",
        id: p.functionCall.id || `toolu_${Math.random().toString(36).slice(2)}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    } else if (p.functionResponse) {
      blocks.push({
        type: "tool_result",
        tool_use_id: p.functionResponse.id || p.functionResponse.name,
        content: JSON.stringify(p.functionResponse.response ?? {}),
      });
    } else if (p.inlineData) {
      const mime = p.inlineData.mimeType || "application/octet-stream";
      if (mime === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: mime, data: p.inlineData.data },
        });
      } else if (mime.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: p.inlineData.data },
        });
      }
      // other binary types: silently dropped (matches Gemini-side behavior
      // of only handling image/pdf inlineData for model input)
    }
  }
  return blocks;
}

function contentsToMessages(contents) {
  const messages = [];
  for (const turn of contents || []) {
    const role = turn.role === "model" ? "assistant" : "user";
    const content = partsToAnthropicContent(turn.parts, role);
    if (!content.length) continue;
    // Anthropic requires consecutive same-role turns to be merged.
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  return messages;
}

// ---- Anthropic response -> Gemini-shape { candidates: [...] } ----
function anthropicToGeminiShape(resp) {
  const parts = [];
  for (const block of resp.content || []) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "tool_use") {
      parts.push({ functionCall: { id: block.id, name: block.name, args: block.input || {} } });
    }
    // thinking/redacted_thinking blocks are passed through verbatim so a
    // caller that resends `contents` (as index.js does across tool rounds)
    // keeps them intact for Anthropic's extended-thinking continuity.
    else if (block.type === "thinking" || block.type === "redacted_thinking") {
      parts.push(block);
    }
  }
  return { candidates: [{ content: { role: "model", parts } }] };
}

async function rawGenerate(contents, systemInstruction, tools, modelOverride, timeoutMs = 60000) {
  if (!apiKeys.length) return { error: { message: "No ANTHROPIC_API_KEY configured." } };
  if (!Array.isArray(contents) || !contents.length) return { error: { message: "No messages to send." } };

  const model = modelOverride && String(modelOverride).startsWith("claude") ? String(modelOverride) : DEFAULT_MODEL();
  const messages = contentsToMessages(contents);
  if (!messages.length) return { error: { message: "No valid message content to send." } };

  const anthropicTools = convertTools(tools);
  let lastErr;

  for (let i = 0; i < Math.max(apiKeys.length, 1); i++) {
    const keyIndex = cursor % apiKeys.length;
    const key = apiKeys[keyIndex];
    cursor++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000));

    try {
      const params = {
        model,
        max_tokens: MAX_TOKENS(),
        messages,
      };
      if (systemInstruction) {
        params.system = typeof systemInstruction === "string" ? systemInstruction : (systemInstruction.parts || []).map((p) => p.text || "").join("\n");
      }
      if (anthropicTools) {
        params.tools = anthropicTools;
      }

      const resp = await getClient(key).messages.create(params, { signal: controller.signal });

      if (typeof usageCallback === "function") {
        try { usageCallback(); } catch (_) {}
      }
      return anthropicToGeminiShape(resp);
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e)) {
        return { error: { message: String(e?.message || "Anthropic request failed.") } };
      }
      console.error(`⚠️ Anthropic key #${keyIndex + 1} transient failure; rotating key.`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { error: { message: String(lastErr?.message || "All Anthropic API keys failed.") } };
}

async function chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs = 60000) {
  return rawGenerate(contents, systemInstruction, tools, modelOverride, timeoutMs);
}

module.exports = { chatShimmed, keyCount, addKeyToPool, setUsageCallback };
