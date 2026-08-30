// Runtime entrypoint for the Super Agent.
//
// index.js is intentionally kept as the compatibility layer for the existing
// integrations. We transform only the two top-level handlers at compile time:
// the new runtime owns user-request planning/execution and the new worker
// dispatcher owns real sub-agent execution. The existing tool implementations
// remain reusable without duplicating Gmail/Drive/GitHub/Railway logic.
const fs = require("fs");
const Module = require("module");
const path = require("path");

require("./telegram_bootstrap_patch.js");

// The legacy NVIDIA brain was removed during the Anthropic migration. Keep
// the runtime entrypoint provider-neutral and explicitly wire the current
// Anthropic Gemini-shape compatibility brain into the agent runtime.
const { chatShimmed: __agentBrain } = require("./anthropic_brain.js");

const entry = path.join(__dirname, "index.js");
let source = fs.readFileSync(entry, "utf8");

const handleMarker = "async function handleChatMessage(userText) {";
const subAgentMarker = "async function dispatchSubAgent(args = {}) {";
if (!source.includes(handleMarker)) throw new Error("index.js handleChatMessage entrypoint not found");
if (!source.includes(subAgentMarker)) throw new Error("index.js dispatchSubAgent entrypoint not found");

source = source.replace(handleMarker, "async function legacyHandleChatMessage(userText) {");
source = source.replace(subAgentMarker, "async function legacyDispatchSubAgent(args = {}) {");

const exportHook = `
;
const { createAgentRuntime } = require("./agent_runtime_v3");
const { handleApprovalCallback } = require("./agent_runtime_v3_callback");
const __agentRuntime = createAgentRuntime({
  brain: __agentBrain,
  toolDeclarations: CHAT_TOOLS,
  directTool: runToolDirectly,
  sensitiveTools: SENSITIVE_TOOLS,
  bot,
  chatId: CHAT_ID,
  supabase,
  baseSystemInstruction: BASE_SYSTEM_INSTRUCTION,
  fetchRecentConversation,
  fetchRecentMemories,
  getUserProfile,
  createAgentTask,
  updateAgentTask,
  recordAgentTaskEvent,
});

async function handleChatMessage(userText) {
  return __agentRuntime.handleUserRequest(userText);
}

async function dispatchSubAgent(args = {}) {
  return __agentRuntime.runStandaloneSubAgent(args);
}

global.__nightAgentWeb = {
  bot,
  httpServer,
  handleChatMessage,
  legacyHandleChatMessage,
  fetchRecentConversation,
  fetchRecentMemories,
  logBotMessage,
  pendingConfirmations,
  applyDetectedCredentials,
  runToolDirectly,
  cancelAllGoals,
  handleAgentV3Callback: (query) => handleApprovalCallback(__agentRuntime, query),
  agentRuntime: __agentRuntime,
};
`;

const m = new Module(entry, module);
m.filename = entry;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(source + exportHook, entry);

const agent = global.__nightAgentWeb;
if (!agent || !agent.httpServer || !agent.bot) {
  throw new Error("Night Agent did not expose its HTTP server and Telegram bot");
}

// The V3 runtime owns its own callback namespace (agentv3:*), while the
// existing index.js confirmation handler continues to own legacy callbacks.
agent.bot.on("callback_query", async (query) => {
  const handled = await agent.handleAgentV3Callback(query).catch((error) => {
    console.error("agent-v3 callback error:", error?.stack || error?.message || error);
    return true;
  });
  if (handled) return;
});

let pollingRecoveryTimer = null;
let pollingRecoveryRunning = false;
agent.bot.on("polling_error", async (error) => {
  const message = String(error?.message || "");
  const is409 = error?.response?.statusCode === 409 || /409\s*conflict|terminated by other getupdates|another getupdates/i.test(message);
  if (!is409 || pollingRecoveryRunning) return;

  pollingRecoveryRunning = true;
  const delay = 5000 + Math.floor(Math.random() * 10000);
  console.error(`🚨 Telegram 409 Conflict: another poller owns this bot token. Pausing this poller for ${delay}ms before one controlled retry.`);

  try {
    if (pollingRecoveryTimer) clearTimeout(pollingRecoveryTimer);
    try { await Promise.resolve(agent.bot.stopPolling()); } catch (stopError) {
      console.warn("⚠️ Telegram stopPolling after 409 failed:", stopError?.message || stopError);
    }
    pollingRecoveryTimer = setTimeout(async () => {
      try {
        console.log("🔄 Retrying Telegram polling after 409 recovery window...");
        await Promise.resolve(agent.bot.startPolling({
          params: { allowed_updates: ["message", "callback_query"] }
        }));
        console.log("✅ Telegram polling recovered after 409 conflict");
      } catch (restartError) {
        console.error("❌ Telegram polling recovery failed:", restartError?.message || restartError);
      } finally {
        pollingRecoveryRunning = false;
        pollingRecoveryTimer = null;
      }
    }, delay);
  } catch (e) {
    pollingRecoveryRunning = false;
    console.error("❌ Telegram 409 recovery handler failed:", e?.message || e);
  }
});

const { handleWebRequest } = require("./web_ui");

const originals = agent.httpServer.listeners("request").slice();
agent.httpServer.removeAllListeners("request");
const original = originals[0];
agent.httpServer.on("request", (req, res) => {
  if (req.url === "/voice" && req.headers.upgrade === "websocket") {
    if (original) original.call(agent.httpServer, req, res);
    return;
  }
  Promise.resolve(handleWebRequest(req, res, agent)).then((handled) => {
    if (!handled && original) original.call(agent.httpServer, req, res);
  }).catch((e) => {
    console.error("Web UI request error:", e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

console.log("🌐 Super Agent V3 runtime attached (dynamic planning + worker sub-agents)");
console.log("🌐 Open the Railway public URL in a browser and use WEB_UI_TOKEN to sign in.");
