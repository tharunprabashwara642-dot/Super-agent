// Telegram callback reliability bootstrap.
// Loaded before index.js so it can harden node-telegram-bot-api before the
// application registers its handlers.
const TelegramBot = require('node-telegram-bot-api');

if (!TelegramBot.__nightAgentReliabilityPatch) {
  const originalOn = TelegramBot.prototype.on;
  const seenMessageIds = new Map();

  TelegramBot.prototype.on = function patchedOn(event, listener) {
    if (event === 'message' && typeof listener === 'function') {
      const wrapped = async (msg) => {
        // Telegram message_id is monotonic within a chat. Ignore an already
        // processed update in this process so reconnect/retry delivery cannot
        // execute the same user request twice.
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

    if (event === 'callback_query' && typeof listener === 'function') {
      const wrapped = async (query) => {
        // Telegram keeps the inline-button spinner active until the callback
        // is acknowledged. Do that FIRST, before Supabase/model/tool work.
        try {
          if (query?.id) {
            await this.answerCallbackQuery(query.id, { text: 'කරගෙන යනවා...' });
          }
        } catch (e) {
          console.error('callback acknowledgement failed:', e.message);
        }
        return listener.call(this, query);
      };
      return originalOn.call(this, event, wrapped);
    }

    return originalOn.call(this, event, listener);
  };

  TelegramBot.__nightAgentReliabilityPatch = true;
  console.log('🛠️ Telegram reliability bootstrap loaded');
}
