// Telegram confirmation hardening patch.
// IMPORTANT: this file is an optional compatibility patch. A changed index.js
// must NEVER prevent the bot from starting. Every edit below is best-effort.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "index.js");
let s = fs.readFileSync(file, "utf8");

const MARKER = "// TELEGRAM_CONFIRMATION_HARDENING_V2";
if (s.includes(MARKER)) {
  console.log("🛡️ Telegram confirmation hardening already applied");
  process.exit(0);
}

let changed = false;

function replaceIfPresent(label, from, to) {
  if (!s.includes(from)) {
    console.warn(`⚠️ Telegram confirmation patch skipped: ${label} marker not found`);
    return false;
  }
  s = s.replace(from, to);
  console.log(`🛡️ Telegram confirmation patch applied: ${label}`);
  changed = true;
  return true;
}

const sendBlock = `      await bot.sendMessage(CHAT_ID, pc.description, {\n        reply_markup: {\n          inline_keyboard: [[\n            { text: "✅ ඔව්", callback_data: \`confirm:\${pc.id}\` },\n            { text: "❌ එපා", callback_data: \`cancel:\${pc.id}\` },\n          ]],\n        },\n      });`;
const sendReplacement = `      const confirmationMessage = await bot.sendMessage(CHAT_ID, pc.description, {\n        reply_markup: {\n          inline_keyboard: [[\n            { text: "✅ ඔව්", callback_data: \`confirm:\${pc.id}\` },\n            { text: "❌ එපා", callback_data: \`cancel:\${pc.id}\` },\n          ]],\n        },\n      });\n      pc.messageId = confirmationMessage?.message_id || null;`;
replaceIfPresent("confirmation message id", sendBlock, sendReplacement);

const callbackMarker = `bot.on("callback_query", async (query) => {\n  if (!query.message || String(query.message.chat.id) !== String(CHAT_ID)) return;`;
const callbackReplacement = `bot.on("callback_query", async (query) => {\n  console.log("🔘 Telegram callback received", JSON.stringify({ id: query?.id, data: query?.data, chat_id: query?.message?.chat?.id }));\n  if (!query.message || String(query.message.chat.id) !== String(CHAT_ID)) {\n    console.warn("⚠️ Ignoring callback from unexpected chat or inline context");\n    return;\n  }`;
replaceIfPresent("callback handler logging", callbackMarker, callbackReplacement);

const toolLine = `        result = await runToolDirectly(pc.toolName, pc.args);`;
const toolReplacement = `        await bot.editMessageText(\n          \`⏳ \${pc.description}\\n🔄 Action received — executing now...\`,\n          { chat_id: CHAT_ID, message_id: query.message.message_id }\n        ).catch(() => {});\n        const startedAt = Date.now();\n        const toolPromise = runToolDirectly(pc.toolName, pc.args);\n        const slowNotice = setTimeout(() => {\n          bot.editMessageText(\n            \`⏳ \${pc.description}\\n🔄 Still working... (\${Math.round((Date.now() - startedAt) / 1000)}s)\`,\n            { chat_id: CHAT_ID, message_id: query.message.message_id }\n          ).catch(() => {});\n        }, 8000);\n        try {\n          result = await toolPromise;\n        } finally {\n          clearTimeout(slowNotice);\n        }`;
replaceIfPresent("confirmation tool execution status", toolLine, toolReplacement);

const waitingMarker = `    try {\n    const { data: waiting } = await supabase\n      .from("goal_steps")`;
const waitingReplacement = `    // TELEGRAM_CONFIRMATION_HARDENING_V2\n    // Reliable text fallback for confirmation. Only consumes the newest\n    // pending confirmation and routes it through the same callback handler.\n    if (pendingConfirmations.length > 0) {\n      const confirmWords = new Set(["confirm", "yes", "y", "ok", "okay", "ඔව්", "හරි", "හරිම"]);\n      const cancelWords = new Set(["cancel", "no", "n", "නෑ", "එපා", "අවශ්‍ය නෑ"]);\n      const newest = pendingConfirmations.find((pc) => pc.buttonsSent) || pendingConfirmations[0];\n      if (confirmWords.has(lower) || cancelWords.has(lower)) {\n        const action = confirmWords.has(lower) ? "confirm" : "cancel";\n        console.log(\`📝 Text confirmation fallback: \${action}:\${newest.id}\`);\n        bot.emit("callback_query", {\n          id: \`text-fallback-\${Date.now()}-\${newest.id}\`,\n          data: \`\${action}:\${newest.id}\`,\n          from: msg.from,\n          message: {\n            chat: { id: CHAT_ID },\n            message_id: newest.messageId || msg.message_id,\n          },\n        });\n        return;\n      }\n    }\n\n    try {\n    const { data: waiting } = await supabase\n      .from("goal_steps")`;
replaceIfPresent("text confirmation fallback", waitingMarker, waitingReplacement);

// Mark the file only after a successful best-effort pass. On the next boot
// this patch becomes a cheap no-op. Most importantly, a changed index.js can
// never turn this optional patch into a process-crashing startup dependency.
if (changed) {
  if (!s.includes(MARKER)) s = `${MARKER}\n${s}`;
  fs.writeFileSync(file, s);
  console.log("🛡️ Telegram confirmation hardening completed (best-effort)");
} else {
  console.log("🛡️ Telegram confirmation hardening skipped — index.js layout has changed; continuing startup safely");
}

process.exit(0);
