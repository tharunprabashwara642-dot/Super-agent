// ============================================================
// LLM BRAIN — talks to an OpenAI-compatible Chat Completions endpoint
// (e.g. tabitoken.com) instead of Anthropic's native Messages API.
//
// WHY THIS CHANGED: the previous version used the @anthropic-ai/sdk,
// which always calls api.anthropic.com and always speaks the Anthropic
// Messages request/response shape. A tabitoken (or any other reseller/
// proxy) key isn't necessarily an Anthropic key underneath — even
// though it may start with "sk-", that prefix alone doesn't tell you
// the request format or the server it needs to hit. This file now
// speaks plain HTTP to a configurable OpenAI-compatible base URL using
// the standard /chat/completions request/response shape instead.
//
// Filename kept as anthropic_brain.js on purpose — index.js does
// require("./anthropic_brain") and nothing else about the module's
// public interface (chatShimmed/keyCount/addKeyToPool/setUsageCallback/
// normalizeSchema) changed, so no other file needs to be touched.
//
// REQUIRED Railway → Variables:
//   OPENAI_COMPAT_BASE_URL   The API base URL, WITHOUT a trailing
//                            /chat/completions (this file appends that
//                            itself). Get the exact value from your
//                            tabitoken dashboard/docs — providers differ
//                            on whether it's e.g. "https://api.tabitoken.com/v1"
//                            or something else. There is no safe default
//                            to guess here, so the bot refuses to start
//                            a request (with a clear error) until this
//                            is set.
//   OPENAI_COMPAT_API_KEY    Your tabitoken key (the "sk-..." one).
//     (or OPENAI_COMPAT_API_KEYS, comma-separated, for round-robin
//      rotation + failover across multiple keys — same behavior as
//      before.)
//
// Back-compat: if OPENAI_COMPAT_API_KEY(S) isn't set, this also checks
// ANTHROPIC_API_KEY(S) so you don't have to rename an existing Railway
// variable just to test this — but the base URL always comes from
// OPENAI_COMPAT_BASE_URL (or TABITOKEN_BASE_URL) since that has no safe
// default.
//
// OPTIONAL:
//   OPENAI_COMPAT_MODEL      Model name as tabitoken expects it, e.g.
//                            "claude-opus-5" or "claude-opus-4-8"
//                            (falls back to ANTHROPIC_TEXT_MODEL, then
//                            "claude-opus-5").
//   OPENAI_COMPAT_EFFORT     Reasoning effort, sent as "reasoning_effort"
//                            (falls back to ANTHROPIC_EFFORT). Only
//                            meaningful if the model you pick actually
//                            supports it — e.g. a "-thinking" model
//                            variant may ignore this and reason by
//                            default instead.
//   OPENAI_COMPAT_MAX_TOKENS Per-reply output cap (falls back to
//                            ANTHROPIC_MAX_TOKENS, default 16000).
// ============================================================

function parseKeys() {
  return (
    process.env.OPENAI_COMPAT_API_KEYS ||
    process.env.OPENAI_COMPAT_API_KEY ||
    process.env.ANTHROPIC_API_KEYS ||
    process.env.ANTHROPIC_API_KEY ||
    ""
  )
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function getBaseUrl() {
  const raw = (process.env.OPENAI_COMPAT_BASE_URL || process.env.TABITOKEN_BASE_URL || "").trim();
  return raw.replace(/\/+$/, ""); // strip trailing slash(es)
}

function geminiKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
}

let apiKeys = parseKeys();
let cursor = 0;
let usageCallback = null;

function keyCount() {
  // Native Gemini keys are a first-class brain route too. Reporting only the
  // OpenAI-compatible pool made a valid Gemini-only deployment look broken.
  return geminiKeys().length || apiKeys.length;
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

const DEFAULT_MODEL = () =>
  process.env.OPENAI_COMPAT_MODEL || process.env.ANTHROPIC_TEXT_MODEL || "claude-opus-5";
const EFFORT = () =>
  (process.env.OPENAI_COMPAT_EFFORT || process.env.ANTHROPIC_EFFORT || "medium").toLowerCase();
const MAX_TOKENS = () =>
  parseInt(process.env.OPENAI_COMPAT_MAX_TOKENS || process.env.ANTHROPIC_MAX_TOKENS || "16000", 10);

function geminiModel(modelOverride) {
  return String(modelOverride || process.env.GEMINI_TEXT_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite").replace(/^models\//, "");
}

// ------------------------------------------------------------
// Gemini-shaped schema (OBJECT/STRING/...) -> plain JSON Schema.
// Same shape OpenAI's "function" tool definitions expect, so this
// is unchanged from before.
// ------------------------------------------------------------
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

// OpenAI-style multimodal content part for a piece of inline file data.
// Standard Chat Completions has no first-class "document"/PDF block the
// way Anthropic's Messages API does — only image_url is broadly
// supported across OpenAI-compatible providers. So: images go in as
// image_url data URIs; anything else (PDFs included) gets a text note
// instead of being silently dropped or sent in a shape the endpoint
// might reject.
function inlineDataToPart(inlineData) {
  const mime = inlineData.mimeType || "application/octet-stream";
  if (IMAGE_TYPES.has(mime)) {
    return { type: "image_url", image_url: { url: `data:${mime};base64,${inlineData.data}` } };
  }
  return { type: "text", text: `[attached file of type ${mime} — cannot be read inline]` };
}

// ------------------------------------------------------------
// Gemini-shaped `contents` (the shape the rest of the codebase already
// builds and passes in) -> OpenAI Chat Completions `messages`.
//
// Tool-call bookkeeping: OpenAI ties a tool result back to its call via
// tool_call_id, so each assistant message with tool_calls must keep its
// call ids stable across turns. We stash the raw OpenAI message
// (content + tool_calls, ids and all) on a synthetic part
// (__openaiRaw) the first time we see it, exactly like the previous
// Anthropic version stashed __anthropicRaw — that way replaying history
// on the next turn reuses the exact same ids instead of regenerating
// new ones that wouldn't match.
// ------------------------------------------------------------
function toOpenAIMessages(contents, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: "system", content: systemInstruction });

  let lastToolCallIds = [];

  for (const c of contents || []) {
    const parts = c.parts || [];

    if (c.role === "model") {
      const rawPart = parts.find((p) => p && p.__openaiRaw);
      if (rawPart && rawPart.__openaiRaw) {
        const raw = rawPart.__openaiRaw;
        messages.push({ role: "assistant", content: raw.content ?? null, tool_calls: raw.tool_calls || undefined });
        lastToolCallIds = (raw.tool_calls || []).map((tc) => tc.id);
        continue;
      }
      // No raw stash (e.g. hand-built history) — reconstruct as best we can.
      let text = "";
      const toolCalls = [];
      for (const p of parts) {
        if (p.text) text += p.text;
        else if (p.functionCall) {
          const id = `call_${messages.length}_${toolCalls.length}`;
          toolCalls.push({
            id,
            type: "function",
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
          });
        }
      }
      messages.push({
        role: "assistant",
        content: text || (toolCalls.length ? null : "(continuing)"),
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });
      lastToolCallIds = toolCalls.map((tc) => tc.id);
      continue;
    }

    const frParts = parts.filter((p) => p.functionResponse);
    if (frParts.length) {
      frParts.forEach((p, idx) => {
        messages.push({
          role: "tool",
          tool_call_id: lastToolCallIds[idx] || `call_unknown_${idx}`,
          content: JSON.stringify(p.functionResponse.response),
        });
      });
      lastToolCallIds = [];
    } else {
      const contentParts = [];
      for (const p of parts) {
        if (p.text) contentParts.push({ type: "text", text: p.text });
        else if (p.inlineData) contentParts.push(inlineDataToPart(p.inlineData));
      }
      if (contentParts.length === 1 && contentParts[0].type === "text") {
        messages.push({ role: "user", content: contentParts[0].text });
      } else if (contentParts.length) {
        messages.push({ role: "user", content: contentParts });
      }
    }
  }

  // Drop any leading non-user turns (mirrors the old behavior) — system
  // message (if any) was already unshifted above and is exempt.
  const firstUserIdx = messages.findIndex((m) => m.role !== "system");
  if (firstUserIdx > -1 && messages[firstUserIdx].role !== "user") {
    let i = firstUserIdx;
    while (i < messages.length && messages[i].role !== "user") messages.splice(i, 1);
  }
  return messages;
}

// OpenAI Chat Completions `choice.message` -> Gemini-shaped parts, so
// the rest of the codebase (which was built around Gemini-shaped
// candidates/parts) doesn't need to change at all.
function toGeminiParts(message) {
  const parts = [];
  if (message.content) parts.push({ text: message.content });
  for (const tc of message.tool_calls || []) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) { /* leave {} on bad JSON */ }
    parts.push({ functionCall: { name: tc.function.name, args } });
  }
  // Stash the raw message so the next turn's history replay can reuse
  // the same tool_call ids (see toOpenAIMessages above).
  parts.push({ __openaiRaw: { content: message.content ?? null, tool_calls: message.tool_calls || undefined } });
  return parts;
}

async function chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs = 60000) {
  // Gemini uses the same contents/functionDeclarations shape used by the
  // rest of this project. A real GEMINI_API_KEY always uses Gemini's native
  // route, even if an old OpenAI-compatible base URL remains configured.
  const nativeGeminiKeys = geminiKeys();
  if (nativeGeminiKeys.length) {
    const key = nativeGeminiKeys[cursor++ % nativeGeminiKeys.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = {
        contents,
        generationConfig: { maxOutputTokens: timeoutMs >= 120000 ? 32000 : MAX_TOKENS() },
      };
      if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
      if (tools && tools.length) payload.tools = tools;
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel(modelOverride))}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) return { error: { message: data?.error?.message || `Gemini HTTP ${response.status}` } };
      if (typeof usageCallback === "function") { try { usageCallback(); } catch (_) {} }
      if (!data?.candidates?.[0]?.content) return { error: { message: data?.promptFeedback?.blockReason || "Malformed Gemini response — no candidate content." } };
      return { candidates: [{ content: data.candidates[0].content }] };
    } catch (e) {
      return { error: { message: e.name === "AbortError" ? `Gemini request timed out after ${timeoutMs}ms.` : `Gemini request failed: ${e.message}` } };
    } finally { clearTimeout(timer); }
  }
  if (apiKeys.length === 0) {
    return { error: { message: "No API key configured. Set GEMINI_API_KEY, OPENAI_COMPAT_API_KEY, or ANTHROPIC_API_KEY in the environment variables." } };
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return { error: { message: "OPENAI_COMPAT_BASE_URL is not set. Set it to your provider's API base URL (e.g. from the tabitoken dashboard/docs) — there's no safe default to assume here." } };
  }

  const messages = toOpenAIMessages(contents, systemInstruction);
  if (!messages.some((m) => m.role === "user" || m.role === "tool")) {
    return { error: { message: "No messages to send." } };
  }

  const model = modelOverride ? String(modelOverride) : DEFAULT_MODEL();

  const params = {
    model,
    max_tokens: timeoutMs >= 120000 ? 32000 : MAX_TOKENS(),
    messages,
  };
  const effort = EFFORT();
  if (effort) params.reasoning_effort = effort;

  const fnDecls = (tools && tools[0] && tools[0].functionDeclarations) || [];
  if (fnDecls.length) {
    params.tools = fnDecls.map((fd) => ({
      type: "function",
      function: {
        name: fd.name,
        description: fd.description || "",
        parameters: normalizeSchema(fd.parameters || { type: "OBJECT", properties: {} }),
      },
    }));
    params.tool_choice = "auto";
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Retries per key, for transient failures (429/524/5xx/timeout). With
  // only 1 key configured, apiKeys.length alone gave exactly 1 attempt —
  // i.e. no real retry at all, despite the "rotating" log message
  // implying otherwise. This makes retry behavior independent of how
  // many keys are configured: every key gets RETRIES_PER_KEY tries
  // (with a short backoff) before moving on, so a single flaky reseller
  // key still gets a real second/third chance.
  const RETRIES_PER_KEY = 3;
  let lastErr;
  const totalAttempts = Math.max(apiKeys.length, 1) * RETRIES_PER_KEY;

  for (let i = 0; i < totalAttempts; i++) {
    const key = apiKeys[cursor % apiKeys.length];
    const keyIdx = cursor % apiKeys.length;
    const retryNum = Math.floor(i / Math.max(apiKeys.length, 1)); // 0-based retry count for this pass
    cursor++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const status = resp.status;
      let data;
      try {
        data = await resp.json();
      } catch (_) {
        data = null;
      }

      if (!resp.ok) {
        const msg = (data && (data.error?.message || data.message)) || `HTTP ${status}`;
        const transient = status === 429 || status === 524 || status === 529 || (status >= 500 && status < 600);
        if (transient && i < totalAttempts - 1) {
          lastErr = new Error(msg);
          console.error(`⚠️ Key #${keyIdx} transient error ${status} (${msg}) — retry ${retryNum + 1}/${RETRIES_PER_KEY}.`);
          await sleep(1000 * (retryNum + 1)); // 1s, 2s, 3s backoff
          continue;
        }
        return { error: { message: msg } };
      }

      if (typeof usageCallback === "function") { try { usageCallback(); } catch (_) {} }

      const choice = data && data.choices && data.choices[0];
      if (!choice || !choice.message) {
        return { error: { message: "Malformed response — no choices[0].message in the API response." } };
      }
      if (choice.finish_reason === "content_filter") {
        return { error: { message: "The request was declined by the provider's safety filter.", refusal: true } };
      }

      return { candidates: [{ content: { role: "model", parts: toGeminiParts(choice.message) } }] };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isTimeout = e.name === "AbortError";
      if (i < totalAttempts - 1) {
        console.error(`⚠️ Key #${keyIdx} ${isTimeout ? "timed out" : `request error (${e.message})`} — retry ${retryNum + 1}/${RETRIES_PER_KEY}.`);
        await sleep(1000 * (retryNum + 1));
        continue;
      }
      if (isTimeout) return { error: { message: `Request timed out after ${timeoutMs}ms (retried ${RETRIES_PER_KEY}x).` } };
    }
  }
  return { error: { message: (lastErr && lastErr.message) || "All API keys failed." } };
}

module.exports = {
  chatShimmed,
  keyCount,
  addKeyToPool,
  setUsageCallback,
  normalizeSchema,
  toOpenAIMessages,
  toGeminiParts,
};
