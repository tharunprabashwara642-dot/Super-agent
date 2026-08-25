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
    client = new mod.Client({ name: "night-agent-mcp-probe", version: "1.0.0" }, { capabilities: {} });
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
    const { error } = await supabase.from("mcp_connectors").upsert({
      id,
      label: host,
      type: "http",
      url,
      auth_header: null,
      command: null,
      args: null,
      env_json: null,
      enabled: true,
    });
    if (error) throw new Error(`MCP verified but could not be saved: ${error.message}`);
    return { ok: true, id, tools: tools.map((t) => t.name).slice(0, 30) };
  } finally {
    try { await client?.close(); } catch (_) {}
  }
}

TelegramBot.prototype.on = function(event, handler) {
  if (event !== "message" || wrappedMessageHandlers.has(handler)) return originalOn.call(this, event, handler);
  const wrapped = async (msg) => {
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    // Bare links are NOT assumed to be MCP. Probe the actual MCP handshake
    // first; if it is not MCP, fall through to the normal chat handler.
    if (MCP_URL_RE.test(text) && !/\.(?:html?|pdf|png|jpg|jpeg|gif|zip|js|ts|json)(?:[?#].*)?$/i.test(text)) {
      try {
        const result = await verifyAndStoreMcp(text);
        if (result.ok) {
          await this.sendMessage(msg.chat.id, `🔌 මේ link එක ඇත්තම MCP server එකක්. Handshake + tools/list verify කළා. ${result.tools.length} tools හම්බුනා, connector එක save කළා — runtime sync එකෙන් tools live වෙනවා.`);
          return;
        }
      } catch (_) {
        // Not MCP / unavailable: normal chat handling continues unchanged.
      }
    }
    return handler(msg);
  };
  wrappedMessageHandlers.add(handler);
  return originalOn.call(this, event, wrapped);
};

// Stop an identical consecutive tool call from becoming an infinite loop.
try {
  const brain = require("./gemini_brain");
  const originalChat = brain.chatShimmed;
  let lastSignature = null;
  let repeatCount = 0;
  brain.chatShimmed = async (...args) => {
    const result = await originalChat(...args);
    const calls = result?.candidates?.[0]?.content?.parts?.filter((p) => p.functionCall)?.map((p) => p.functionCall) || [];
    const sig = calls.length ? JSON.stringify(calls.map((c) => ({ name: c.name, args: c.args || {} }))) : null;
    if (sig && sig === lastSignature) repeatCount++; else repeatCount = 0;
    lastSignature = sig;
    if (repeatCount >= 1) {
      repeatCount = 0;
      return { candidates: [{ content: { parts: [{ text: "I stopped this repeated tool call to prevent an infinite loop. The previous tool result was already returned; use a different next action or report the blocker." }] } }] };
    }
    return result;
  };
} catch (e) {
  console.error("runtime guard brain patch failed:", e.message);
}
