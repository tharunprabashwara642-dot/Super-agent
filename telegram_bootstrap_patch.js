// Telegram reliability bootstrap.
// Loaded before index.js so Telegram message de-duplication is installed
// before the application registers its handlers.
//
// IMPORTANT: do NOT intercept/ack callback_query here. The application owns
// the confirmation lifecycle and must be the single place that acknowledges
// and executes a confirmation. Double-answering a callback query can make
// Telegram report the callback as already answered and makes debugging the
// real confirmation handler unnecessarily confusing.
const TelegramBot = require('node-telegram-bot-api');

if (!TelegramBot.__nightAgentReliabilityPatch) {
  const originalOn = TelegramBot.prototype.on;
  const seenMessageIds = new Map();

  TelegramBot.prototype.on = function patchedOn(event, listener) {
    if (event === 'message' && typeof listener === 'function') {
      const wrapped = async (msg) => {
        // Telegram message_id is monotonic within a chat. Ignore an already
        // processed message so polling reconnects/retries cannot execute the
        // same user request twice.
        const chatId = String(msg?.chat?.id ?? '');
        const messageId = Number(msg?.message_id);
        if (chatId && Number.isFinite(messageId)) {
          const last = seenMessageIds.get(chatId) || 0;
          if (messageId <= last) {
            console.warn(`⚠️ Duplicate Telegram message ignored: chat=${chatId} message=${messageId}`);
            return;
          }
          seenMessageIds.set(chatId, messageId);
          if (seenMessageIds.size > 1000) {
            const firstKey = seenMessageIds.keys().next().value;
            seenMessageIds.delete(firstKey);
          }
        }
        return listener.call(this, msg);
      };
      return originalOn.call(this, event, wrapped);
    }

    // Leave callback_query completely untouched. The real handler in
    // index.js calls answerCallbackQuery immediately, resolves the queued
    // confirmation, edits the button message, and resumes any blocked goal.
    return originalOn.call(this, event, listener);
  };

  TelegramBot.__nightAgentReliabilityPatch = true;
  console.log('🛠️ Telegram reliability bootstrap loaded');
}
