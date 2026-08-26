// Starts the existing agent unchanged, then attaches the web UI to the
// SAME HTTP server and the SAME chat/tool state. This avoids creating a
// second agent, second model session, or second Telegram poller.
const fs = require("fs");
const Module = require("module");
const path = require("path");

// IMPORTANT: telegram_bootstrap_patch.js must run in THIS Node process.
// Running it as a separate `node telegram_bootstrap_patch.js` process only
// patches that process's TelegramBot prototype and has no effect on index.js.
// Loading it here makes allowed_updates + message de-duplication effective
// for the real bot instance created when index.js is compiled below.
require("./telegram_bootstrap_patch.js");

const entry = path.join(__dirname, "index.js");
const source = fs.readFileSync(entry, "utf8");
const exportHook = `\n;global.__nightAgentWeb = {\n  httpServer,\n  handleChatMessage,\n  fetchRecentConversation,\n  logBotMessage,\n  pendingConfirmations,\n  applyDetectedCredentials,\n  runToolDirectly,\n  cancelAllGoals,\n};\n`;

const m = new Module(entry, module);
m.filename = entry;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(source + exportHook, entry);

const agent = global.__nightAgentWeb;
if (!agent || !agent.httpServer) throw new Error("Night Agent HTTP server was not exposed by index.js");
const { handleWebRequest } = require("./web_ui");

// Replace the original request handler with one dispatcher. It awaits the
// web handler before falling back to the agent's existing health response,
// avoiding the race where index.js could answer `ok` before the web API did.
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
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
  });
});

console.log("🌐 Claude-style web UI attached to the existing Night Agent server");
console.log("🌐 Open the Railway public URL in a browser and use WEB_UI_TOKEN to sign in.");
