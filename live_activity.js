const TelegramBot = require('node-telegram-bot-api');

// One clean, edited-in-place activity message. The runtime should call step()
// only for real lifecycle events; this module never invents tool progress.
let bot = null;
let messageId = null;
let active = false;
let startedAt = 0;
let timer = null;
let frame = 0;
let frozenElapsed = 0;
const steps = [];
const MAX_VISIBLE_STEPS = 12;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function getBot() {
  if (bot) return bot;
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  return bot;
}

function cid() {
  const id = process.env.NIGHT_AGENT_CHAT_ID;
  if (!id) throw new Error('NIGHT_AGENT_CHAT_ID is not configured');
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
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function render(mode = 'working') {
  const header = mode === 'done'
    ? '🤖 <b>Task completed</b>'
    : mode === 'failed'
      ? '🤖 <b>Task failed</b>'
      : `🤖 <b>Working ${SPINNER[frame % SPINNER.length]}</b>`;

  const body = steps.slice(-MAX_VISIBLE_STEPS).map(x => {
    const icon = x.state === 'running' ? SPINNER[frame % SPINNER.length] : x.icon;
    return `${icon} ${esc(x.text)}`;
  }).join('\n');

  return `${header}  <code>${clock(elapsedSeconds())}</code>\n\n${body || '🧠 Understanding request'}`;
}

async function edit(mode = 'working') {
  if (!messageId) return;
  try {
    await getBot().editMessageText(render(mode), {
      chat_id: cid(),
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

async function start(label = 'Understanding request') {
  if (active) return;
  active = true;
  startedAt = Date.now();
  frozenElapsed = 0;
  frame = 0;
  steps.length = 0;
  steps.push({ icon: '🧠', text: String(label), state: 'running' });

  const m = await getBot().sendMessage(cid(), render('working'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  messageId = m.message_id;

  // Fast enough to feel alive, but not so fast that Telegram rate-limits edits.
  timer = setInterval(() => {
    frame++;
    edit('working').catch(() => {});
  }, 1200);
}

async function step(label, state = 'running') {
  if (!active) await start();
  const text = String(label);
  const normalized = state === 'done' ? 'done' : state === 'error' ? 'error' : state === 'waiting' ? 'waiting' : 'running';
  const icon = normalized === 'done' ? '✅' : normalized === 'error' ? '❌' : normalized === 'waiting' ? '⏳' : '🔧';
  const last = steps[steps.length - 1];

  // Avoid duplicate consecutive events, but allow a running -> done transition.
  if (last && last.text === text && last.state === normalized) return;
  if (last && last.text === text && last.state === 'running' && normalized === 'done') {
    last.state = 'done';
    last.icon = '✅';
  } else {
    steps.push({ icon, text, state: normalized });
  }
  await edit('working');
}

async function finish(label = 'Done') {
  if (!active) return;
  const text = String(label);
  const last = steps[steps.length - 1];
  if (!last || last.text !== text || last.state !== 'done') {
    steps.push({ icon: '✅', text, state: 'done' });
  }
  frozenElapsed = elapsedSeconds();
  if (timer) clearInterval(timer);
  timer = null;
  await edit('done');
  active = false;
  messageId = null;
}

async function fail(label = 'Failed') {
  if (!active) return;
  const text = String(label);
  const last = steps[steps.length - 1];
  if (!last || last.text !== text || last.state !== 'error') {
    steps.push({ icon: '❌', text, state: 'error' });
  }
  frozenElapsed = elapsedSeconds();
  if (timer) clearInterval(timer);
  timer = null;
  await edit('failed');
  active = false;
  messageId = null;
}

module.exports = { start, step, finish, fail };
