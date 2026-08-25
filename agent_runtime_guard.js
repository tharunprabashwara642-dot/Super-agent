// Runtime guards loaded before index.js. Reliability/safety shims only.
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const originalOn = TelegramBot.prototype.on;
const MCP_URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const wrappedMessageHandlers = new WeakSet();

async function verifyAndStoreMcp(url) {
  let client;
  try {
    const mod = await import("@modelcontextprotocol/sdk/client/index.js");
    const httpMod = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    client = new mod.Client({ name: "super-personal-agent-mcp-probe", version: "2.0.0" }, { capabilities: {} });
    const transport = new httpMod.StreamableHTTPClientTransport(new URL(url));
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error("MCP probe timed out after 12s")), 12000)),
    ]);
    const { tools = [] } = await client.listTools();
    if (!tools.length) throw new Error("MCP handshake succeeded but the server exposed no tools");
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase is not configured");
    const supabase = createClient(supabaseUrl, serviceKey);
    const host = new URL(url).hostname;
    const id = `auto_${host.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 36) || Date.now()}`;
    const { error } = await supabase.from("mcp_connectors").upsert({ id, label: host, type: "http", url, auth_header: null, command: null, args: null, env_json: null, enabled: true });
    if (error) throw new Error(`MCP verified but could not be saved: ${error.message}`);
    return { ok: true, id, tools: tools.map((t) => t.name).slice(0, 30) };
  } finally { try { await client?.close(); } catch (_) {} }
}

TelegramBot.prototype.on = function(event, handler) {
  if (event !== "message" || wrappedMessageHandlers.has(handler)) return originalOn.call(this, event, handler);
  const wrapped = async (msg) => {
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (MCP_URL_RE.test(text) && !/\.(?:html?|pdf|png|jpg|jpeg|gif|zip|js|ts|json)(?:[?#].*)?$/i.test(text)) {
      try {
        const result = await verifyAndStoreMcp(text);
        if (result.ok) {
          await this.sendMessage(msg.chat.id, `🔌 MCP verified: ${result.tools.length} tools found and connector saved. The agent will discover the tools on its next runtime sync.`);
          return;
        }
      } catch (_) {}
    }
    return handler(msg);
  };
  wrappedMessageHandlers.add(handler);
  return originalOn.call(this, event, wrapped);
};

// ============================================================
// PERSONAL AGENT CONTRACT + SAFE TOOL LOOP
// ============================================================
// Injected at runtime so every model turn follows the same definition of
// done. This makes natural Sinhala requests behave like executable tasks.
try {
  const brain = require("./gemini_brain");
  const originalChat = brain.chatShimmed;
  let lastToolSignature = null;
  let lastToolRepeatCount = 0;

  const PERSONAL_CONTRACT = `
You are the user's personal autonomous AI operator.

- Understand casual Sinhala and Sinhala-English mixed language naturally.
- Treat concrete requests as tasks to complete, not merely questions to answer.
- Plan internally, use tools, and continue until the requested outcome exists.
- Never claim success because a tool was merely called; verify the real result.
- If a tool fails, diagnose it, retry with a better method, or use another tool.
- Preserve exact constraints: quantity, language, file type, formatting, dates, names, and destination.
- For large outputs, work in batches automatically instead of returning a small partial answer.
- For exact quantities (for example 50 questions), produce EXACTLY that quantity and validate the count before saying done.
- For DOC/PDF/XLSX/PPTX/ZIP/code/site/database requests, create or change the real artifact using tools; never substitute text when a real artifact was requested.
- For database mutations, verify the affected data after writing whenever the available tools permit it.
- For multi-part requests, complete every part before reporting completion.
- Do not ask unnecessary confirmation for safe, reversible work. Ask only when a real blocker, destructive action, credential, or ambiguity requires it.
- Keep progress updates short during long work; progress text is not a substitute for execution.

PERSONAL STYLE:
- Speak naturally like a trusted personal assistant.
- Prefer Sinhala when the user speaks Sinhala; technical English terms are fine.
- Be concise for simple chat and thorough for complex work.
- Use memory tools for relevant personal context; never invent personal facts.

DEFINITION OF DONE:
A task is DONE only when the requested outcome exists, important constraints are verified, and required delivery (message/file/database/deployment) has succeeded.
`;

  brain.chatShimmed = async (...args) => {
    const contents = Array.isArray(args[0]) ? args[0] : [];
    args[1] = `${PERSONAL_CONTRACT}\n\nAPPLICATION INSTRUCTIONS:\n${args[1] || ""}`;
    const last = contents[contents.length - 1];
    const isToolResultTurn = last?.role === "user" && Array.isArray(last.parts) && last.parts.some((p) => p.functionResponse);
    const result = await originalChat(...args);
    const calls = result?.candidates?.[0]?.content?.parts?.filter((p) => p.functionCall)?.map((p) => p.functionCall) || [];
    const sig = calls.length ? JSON.stringify(calls.map((c) => ({ name: c.name, args: c.args || {} }))) : null;
    if (isToolResultTurn && sig && sig === lastToolSignature) {
      lastToolRepeatCount += 1;
      if (lastToolRepeatCount >= 3) {
        lastToolSignature = null;
        lastToolRepeatCount = 0;
        return { candidates: [{ content: { parts: [{ text: "I stopped a repeated tool loop after three identical attempts. I will use a different approach or report the blocker instead of looping." }] } }] };
      }
    } else {
      lastToolRepeatCount = 0;
    }
    lastToolSignature = isToolResultTurn ? sig : null;
    return result;
  };
} catch (e) {
  console.error("personal-agent runtime patch failed:", e.message);
}
