const TelegramBot = require('node-telegram-bot-api');

/**
 * Live activity status for Telegram.
 * Shows a single edited message with spinner, elapsed timer (from start → finish),
 * and step list with emojis — polished, readable, not spammy.
 */
let bot = null;
let messageId = null;
let active = false;
let startedAt = 0;
let timer = null;
let frame = 0;
let frozenElapsed = 0;
let presentation = null;
let chatIdCache = null;
const steps = [];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Picks a contextual emoji for a running step based on its label text, so
// the live card reads as real progress ("📝 generating question 12/50",
// "🎨 applying layout", "📤 uploading to Telegram") instead of one flat
// generic icon for every step.
const KEYWORD_ICONS = [
  [/ප්‍රශ්න|question/i, '📝'],
  [/layout|font|Sinhala|design/i, '🎨'],
  [/render|PDF|Browser/i, '🖨️'],
  [/Telegram|attach|upload/i, '📤'],
  [/delivery|confirm|deliver/i, '📬'],
  [/scheme|marking|answer/i, '🗝️'],
  [/prepare|request/i, '🧠'],
  [/search|research|lookup/i, '🔎'],
  [/code|bug|patch|repo/i, '💻'],
  [/write|draft|essay/i, '✍️'],
  [/verify|check|validate/i, '🕵️'],
  [/plan|strategy|steps/i, '🗺️'],
];

function pickIcon(text) {
  const t = String(text || '');
  for (const [re, icon] of KEYWORD_ICONS) {
    if (re.test(t)) return icon;
  }
  return null;
}

function getBot() {
  if (bot) return bot;
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  return bot;
}

function cid(chatId) {
  const id = chatId ?? chatIdCache ?? process.env.NIGHT_AGENT_CHAT_ID;
  if (!id) throw new Error('Telegram chat id is not configured');
  chatIdCache = id;
  return id;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function elapsedSeconds() {
  if (frozenElapsed) return frozenElapsed;
  return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

function clock(s) {
  const n = Math.max(0, Number(s) || 0);
  const m = Math.floor(n / 60);
  const sec = n % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function normalizePresentation(p = {}) {
  return {
    title: p.title == null ? null : String(p.title),
    showTimer: p.showTimer !== false,
    showSpinner: p.showSpinner !== false,
    showIcons: p.showIcons !== false,
    showCompletedSteps: p.showCompletedSteps !== false,
    maxSteps: Number.isFinite(Number(p.maxSteps)) ? Math.max(1, Math.min(30, Number(p.maxSteps))) : 12,
    compact: Boolean(p.compact),
    headerStyle: p.headerStyle || 'emoji',
    language: p.language || 'auto',
  };
}

function statusHeader(mode) {
  const p = presentation || normalizePresentation();
  if (p.title) return esc(p.title);

  if (p.headerStyle === 'minimal') {
    if (mode === 'working') return 'Working';
    if (mode === 'done') return 'Done';
    return 'Failed';
  }

  // Default: emoji + clear Sinhala/English hybrid labels
  if (mode === 'working') return '🔄 වැඩ කරනවා';
  if (mode === 'done') return '✅ ඉවරයි';
  return '❌ අසාර්ථකයි';
}

function render(mode = 'working') {
  const p = presentation || normalizePresentation();
  const spinner = mode === 'working' && p.showSpinner ? ` ${SPINNER[frame % SPINNER.length]}` : '';
  const timerText = p.showTimer ? ` · <code>${clock(elapsedSeconds())}</code>` : '';
  const header = `<b>${statusHeader(mode)}</b>${spinner}${timerText}`;

  const visible = steps
    .slice(-p.maxSteps)
    .filter((x) => p.showCompletedSteps || x.state !== 'done' || mode !== 'working');

  const body = visible
    .map((x) => {
      // Keep the contextual emoji (📝/🎨/🖨️/...) visible on the currently
      // running step instead of overwriting it every tick with the plain
      // spinner glyph — only fall back to the spinner when a step has no
      // recognizable keyword to pick an icon for.
      let icon = x.icon;
      if (x.state === 'running' && mode === 'working' && p.showSpinner && icon === '🔧') {
        icon = SPINNER[frame % SPINNER.length];
      }
      const prefix = p.showIcons ? `${icon} ` : '';
      return `${prefix}${esc(x.text)}`;
    })
    .join('\n');

  if (p.compact) return body ? `${header}\n${body}` : header;
  return body ? `${header}\n\n${body}` : header;
}

async function edit(mode = 'working', chatId) {
  if (!messageId) return;
  try {
    await getBot().editMessageText(render(mode), {
      chat_id: cid(chatId),
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    if (!/message is not modified/i.test(String(e?.message || ''))) {
      console.warn('Live activity edit failed:', e?.message || e);
    }
  }
}

async function start(label = 'ඉල්ලීම තේරුම් ගන්නවා', options = {}) {
  if (active) return;
  active = true;
  startedAt = Date.now();
  frozenElapsed = 0;
  frame = 0;
  steps.length = 0;
  presentation = normalizePresentation(options.presentation || options);
  if (options.chatId) chatIdCache = options.chatId;

  steps.push({ icon: '🧠', text: String(label), state: 'running' });

  const m = await getBot().sendMessage(cid(options.chatId), render('working'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  messageId = m.message_id;

  // Tick every 1s so the elapsed timer feels live
  timer = setInterval(() => {
    frame++;
    edit('working', options.chatId).catch(() => {});
  }, 1000);
}

async function step(label, state = 'running', options = {}) {
  if (!active) await start('ඉල්ලීම තේරුම් ගන්නවා', options);

  const normalized =
    state === 'done' ? 'done' :
    state === 'error' ? 'error' :
    state === 'waiting' ? 'waiting' : 'running';

  const icon =
    normalized === 'done' ? '✅' :
    normalized === 'error' ? '❌' :
    normalized === 'waiting' ? '⏳' : (pickIcon(label) || '🔧');

  const text = String(label);
  const last = steps[steps.length - 1];

  if (last && last.text === text && last.state === 'running' && normalized === 'done') {
    last.state = 'done';
    last.icon = '✅';
  } else if (!last || last.text !== text || last.state !== normalized) {
    // Mark previous running step as done when a new one starts
    if (last && last.state === 'running' && normalized === 'running') {
      last.state = 'done';
      last.icon = '✅';
    }
    steps.push({ icon, text, state: normalized });
  }

  await edit('working', options.chatId);
}

async function setPresentation(patch = {}, options = {}) {
  presentation = normalizePresentation({ ...(presentation || {}), ...patch });
  if (active) await edit('working', options.chatId);
}

async function finish(label = '🎉 සාර්ථකයි', options = {}) {
  if (!active) return;
  // Close any open running step
  const last = steps[steps.length - 1];
  if (last && last.state === 'running') {
    last.state = 'done';
    last.icon = '✅';
  }
  steps.push({ icon: '✅', text: String(label), state: 'done' });
  frozenElapsed = elapsedSeconds();
  if (timer) clearInterval(timer);
  timer = null;
  await edit('done', options.chatId);
  active = false;
  messageId = null;
}

async function fail(label = 'අසාර්ථකයි', options = {}) {
  if (!active) return;
  steps.push({ icon: '❌', text: String(label), state: 'error' });
  frozenElapsed = elapsedSeconds();
  if (timer) clearInterval(timer);
  timer = null;
  await edit('failed', options.chatId);
  active = false;
  messageId = null;
}

module.exports = { start, step, setPresentation, finish, fail };
