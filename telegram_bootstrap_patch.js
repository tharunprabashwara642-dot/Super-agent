// Telegram reliability bootstrap.
// Loaded before index.js so Telegram message de-duplication and callback
// delivery are installed before the application registers its handlers.
//
// IMPORTANT: callback_query must NEVER be swallowed or double-acknowledged
// here. index.js owns the confirmation lifecycle and is the single place
// that answers callbacks and executes the queued action.
const TelegramBot = require('node-telegram-bot-api');

if (!TelegramBot.__nightAgentReliabilityPatch) {
  const originalOn = TelegramBot.prototype.on;
  const originalStartPolling = TelegramBot.prototype.startPolling;
  const seenMessageIds = new Map();

  // Telegram remembers the previous `allowed_updates` value for a bot when
  // getUpdates is called without an explicit value. If this bot was ever
  // started with only `message`, callback_query updates can silently stop
  // arriving even though inline buttons are rendered correctly. Force the
  // two update types this application actually consumes on every startup.
  // This is especially important on Railway where the same bot token may
  // have been used by an older deployment/configuration.
  TelegramBot.prototype.startPolling = function patchedStartPolling(options) {
    const opts = options ? { ...options } : {};
    opts.params = { ...(opts.params || {}) };
    opts.params.allowed_updates = ["message", "callback_query"];
    return originalStartPolling.call(this, opts);
  };

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
  console.log('🛠️ Telegram reliability bootstrap loaded (message + callback_query)');
}
