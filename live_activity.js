const TelegramBot = require('node-telegram-bot-api');

// Presentation is deliberately NOT hard-coded to one visual style.
// The orchestrator may pass a presentation profile per task. This module only
// renders the current real execution state and maintains the live timer.
let bot = null;
let messageId = null;
let active = false;
let startedAt = 0;
let timer = null;
let frame = 0;
let frozenElapsed = 0;
let presentation = null;
const steps = [];
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function getBot() {
  if (bot) return bot;
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  return bot;
}

function cid(chatId) {
  const id = chatId ?? process.env.NIGHT_AGENT_CHAT_ID;
  if (!id) throw new Error('Telegram chat id is not configured');
  return id;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function elapsedSeconds() {
  if (frozenElapsed) return frozenElapsed;
  return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

function clock(s) {
  const n = Math.max(0, Number(s) || 0);
  const m = Math.floor(n / 60);
  return `${String(m).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

function normalizePresentation(p = {}) {
  return {
    // Defaults are intentionally neutral; no fixed "Claude/ChatGPT" imitation.
    title: p.title == null ? null : String(p.title),
    showTimer: p.showTimer !== false,
    showSpinner: p.showSpinner !== false,
    showIcons: p.showIcons !== false,
    showCompletedSteps: p.showCompletedSteps !== false,
    maxSteps: Number.isFinite(Number(p.maxSteps)) ? Math.max(1, Math.min(30, Number(p.maxSteps))) : 20,
    compact: Boolean(p.compact),
    headerStyle: p.headerStyle || 'plain',
    language: p.language || 'auto',
  };
}

function statusHeader(mode) {
  if (presentation.title) return esc(presentation.title);
  if (presentation.headerStyle === 'minimal') return mode === 'working' ? 'Working' : mode === 'done' ? 'Done' : 'Failed';
  return mode === 'working' ? 'Working' : mode === 'done' ? 'Task completed' : 'Task failed';
}

function render(mode = 'working') {
  const p = presentation || normalizePresentation();
  const spinner = p.showSpinner ? ` ${SPINNER[frame % SPINNER.length]}` : '';
  const timerText = p.showTimer ? `  <code>${clock(elapsedSeconds())}</code>` : '';
  const header = `<b>${statusHeader(mode)}</b>${mode === 'working' ? spinner : ''}${timerText}`;

  const visible = steps.slice(-p.maxSteps).filter(x => p.showCompletedSteps || x.state !== 'done');
  const body = visible.map(x => {
    const icon = p.showIcons ? (x.state === 'running' && p.showSpinner ? SPINNER[frame % SPINNER.length] : x.icon) + ' ' : '';
    return `${icon}${esc(x.text)}`;
  }).join('\n');

  return p.compact ? `${header}${body ? `\n${body}` : ''}` : `${header}${body ? `\n\n${body}` : ''}`;
}

async function edit(mode = 'working', chatId) {
  if (!messageId) return;
  try {
    await getBot().editMessageText(render(mode), {
      chat_id: cid(chatId), message_id: messageId,
      parse_mode: 'HTML', disable_web_page_preview: true,
    });
  } catch (e) {
    if (!/message is not modified/i.test(String(e?.message || ''))) console.warn('Live activity edit failed:', e?.message || e);
  }
}

async function start(label = 'Understanding request', options = {}) {
  if (active) return;
  active = true;
  startedAt = Date.now();
  frozenElapsed = 0;
  frame = 0;
  steps.length = 0;
  presentation = normalizePresentation(options.presentation || options);
  steps.push({ icon: '🧠', text: String(label), state: 'running' });

  const m = await getBot().sendMessage(cid(options.chatId), render('working'), {
    parse_mode: 'HTML', disable_web_page_preview: true,
  });
  messageId = m.message_id;

  timer = setInterval(() => { frame++; edit('working', options.chatId).catch(() => {}); }, 1200);
}

async function step(label, state = 'running', options = {}) {
  if (!active) await start('Understanding request', options);
  const normalized = state === 'done' ? 'done' : state === 'error' ? 'error' : state === 'waiting' ? 'waiting' : 'running';
  const icon = normalized === 'done' ? '✅' : normalized === 'error' ? '❌' : normalized === 'waiting' ? '⏳' : '🔧';
  const text = String(label);
  const last = steps[steps.length - 1];
  if (last && last.text === text && last.state === 'running' && normalized === 'done') {
    last.state = 'done'; last.icon = '✅';
  } else if (!last || last.text !== text || last.state !== normalized) {
    steps.push({ icon, text, state: normalized });
  }
  await edit('working', options.chatId);
}

async function setPresentation(patch = {}, options = {}) {
  presentation = normalizePresentation({ ...(presentation || {}), ...patch });
  if (active) await edit('working', options.chatId);
}

async function finish(label = 'Done', options = {}) {
  if (!active) return;
  steps.push({ icon: '✅', text: String(label), state: 'done' });
  frozenElapsed = elapsedSeconds();
  if (timer) clearInterval(timer);
  timer = null;
  await edit('done', options.chatId);
  active = false; messageId = null;
}

async function fail(label = 'Failed', options = {}) {
  if (!active) return;
  steps.push({ icon: '❌', text: String(label), state: 'error' });
  frozenElapsed = elapsedSeconds();
  if (timer) clearInterval(timer);
  timer = null;
  await edit('failed', options.chatId);
  active = false; messageId = null;
}

module.exports = { start, step, setPresentation, finish, fail };
