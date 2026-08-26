// Starts the existing agent unchanged, then attaches the web UI to the
// SAME HTTP server and the SAME chat/tool state. This avoids creating a
// second agent, second model session, or second Telegram poller.
const fs = require("fs");
const Module = require("module");
const path = require("path");

const entry = path.join(__dirname, "index.js");
const source = fs.readFileSync(entry, "utf8");

// Expose only the small set of live agent functions/state needed by the web
// adapter. The agent itself remains the source of truth.
const exportHook = `\n;global.__nightAgentWeb = {\n  httpServer,\n  handleChatMessage,\n  fetchRecentConversation,\n  logBotMessage,\n  pendingConfirmations,\n  applyDetectedCredentials,\n  runToolDirectly,\n  cancelAllGoals,\n};\n`;

const m = new Module(entry, module);
m.filename = entry;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(source + exportHook, entry);

const agent = global.__nightAgentWeb;
if (!agent || !agent.httpServer) {
  throw new Error("Night Agent HTTP server was not exposed by index.js");
}

const { handleWebRequest } = require("./web_ui");

// index.js already has a health/voice request listener. Put the web UI first;
// if it handles the request, the original listener is never allowed to send
// the fallback `ok` response. WebSocket /voice remains handled by ws itself.
agent.httpServer.prependListener("request", async (req, res) => {
  if (req.url === "/voice" && req.headers.upgrade === "websocket") return;
  let handled = false;
  try {
    handled = await handleWebRequest(req, res, agent);
  } catch (e) {
    console.error("Web UI request error:", e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    handled = true;
  }
  // The original index.js listener will still run for unhandled requests.
  // For handled requests it must not run; remove it for this request by
  // marking the response so the original listener can see the flag.
  if (handled) res.__nightAgentWebHandled = true;
});

// The original handler is patched once so it respects the marker above.
// Node request listeners cannot be stopped from another listener, so replace
// the original listener with a small wrapper while preserving every other
// request listener (notably ws internals are attached separately).
const listeners = agent.httpServer.listeners("request");
const original = listeners[listeners.length - 1];
if (original && !original.__nightAgentWrapped) {
  agent.httpServer.removeListener("request", original);
  const wrapped = function(req, res) {
    if (res.__nightAgentWebHandled) return;
    return original.call(this, req, res);
  };
  wrapped.__nightAgentWrapped = true;
  agent.httpServer.on("request", wrapped);
}

console.log("🌐 Claude-style web UI attached to the existing Night Agent server");
console.log("🌐 Open the Railway public URL in a browser and use WEB_UI_TOKEN to sign in.");
