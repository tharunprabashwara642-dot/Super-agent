// Artifact delivery guard.
// Some legacy document tools returned an RTF/PDF payload as a giant base64
// string inside a normal Telegram message. This guard converts that payload
// into a real Telegram document before it can leak into chat.
const TelegramBot = require("node-telegram-bot-api");

const originalSendMessage = TelegramBot.prototype.sendMessage;
let deliveryGuardInstalled = false;

function looksLikeBase64Line(line) {
  const s = String(line || "").trim();
  return s.length >= 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function extractBase64Block(text) {
  const lines = String(text || "").split(/\r?\n/);
  let best = [];
  let run = [];
  for (const line of lines) {
    if (looksLikeBase64Line(line)) {
      run.push(line.trim());
    } else {
      if (run.join("").length > best.join("").length) best = run;
      run = [];
    }
  }
  if (run.join("").length > best.join("").length) best = run;
  const joined = best.join("");
  if (joined.length < 2000 || joined.length % 4 !== 0) return null;
  try {
    const buf = Buffer.from(joined, "base64");
    if (buf.length < 1000) return null;
    return buf;
  } catch (_) {
    return null;
  }
}

function requestedFilename(text) {
  const m = String(text || "").match(/([A-Za-z0-9][A-Za-z0-9_.-]{2,180}\.(?:pdf|docx?|rtf|txt|xlsx|pptx?|zip))/i);
  return m ? m[1] : "generated-document";
}

function detectArtifact(buf, requested) {
  const head = buf.subarray(0, 16).toString("latin1");
  if (head.startsWith("%PDF-")) return { ext: ".pdf", type: "application/pdf" };
  if (head.startsWith("{\\rtf")) return { ext: ".doc", type: "application/msword" };
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const ext = /\.xlsx$/i.test(requested) ? ".xlsx" : /\.pptx$/i.test(requested) ? ".pptx" : ".docx";
    const type = ext === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : ext === ".pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return { ext, type };
  }
  return null;
}

TelegramBot.prototype.sendMessage = function(chatId, text, options = {}) {
  if (deliveryGuardInstalled || typeof text !== "string") return originalSendMessage.call(this, chatId, text, options);
  if (text.length < 2500 || !/(download\s*link|\.pdf|\.docx?|\.rtf|\.xlsx|\.pptx?)/i.test(text)) {
    return originalSendMessage.call(this, chatId, text, options);
  }

  const buf = extractBase64Block(text);
  if (!buf) return originalSendMessage.call(this, chatId, text, options);
  const requested = requestedFilename(text);
  const artifact = detectArtifact(buf, requested);
  if (!artifact) return originalSendMessage.call(this, chatId, text, options);

  const base = requested.replace(/\.(pdf|docx?|rtf|txt|xlsx|pptx?|zip)$/i, "");
  const filename = `${base}${artifact.ext}`;
  const caption = artifact.ext === ".doc" && /\.pdf$/i.test(requested)
    ? "📄 Document generated. The payload was RTF/Word format, so I sent it as a real Word-compatible .doc file instead of exposing the raw data."
    : "📄 Document generated and attached.";

  deliveryGuardInstalled = true;
  return this.sendDocument(chatId, buf, { caption }, { filename, contentType: artifact.type })
    .finally(() => { deliveryGuardInstalled = false; });
};

console.log("🛡️ Artifact delivery guard loaded");
