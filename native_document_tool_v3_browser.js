/**
 * Browser-based PDF generator (Puppeteer).
 * Prefer this path for Sinhala/complex scripts — Chromium text shaping is far
 * more reliable than PDFKit for Sinhala conjuncts and layout.
 * Fixes: empty pages, garbled Sinhala, missing content.
 */
const TelegramBot = require('node-telegram-bot-api');

let puppeteerLib = null;
try {
  puppeteerLib = require('puppeteer');
} catch (_) {}

let progressCallback = async () => {};
async function progress(msg, state = 'running') {
  try {
    const bridge = global.__nightAgentLiveBridge?.step;
    if (bridge) return await bridge(String(msg), state);
    return await progressCallback(msg, state);
  } catch (_) {}
}

function cleanJson(s) {
  return String(s || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function cleanText(value) {
  let s = String(value ?? '');
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (m) => map[m]);
}

const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

function keys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function gemini(prompt) {
  const pool = keys();
  if (!pool.length) throw new Error('No Gemini API key configured');
  let last;
  for (const key of pool) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.45, maxOutputTokens: 8000 },
          }),
        }
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || `Gemini HTTP ${r.status}`);
      return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('Gemini request failed');
}

async function makeQuestions(topic, count, language) {
  const out = [];
  const seen = new Set();
  for (let round = 0; out.length < count && round < 30; round++) {
    const need = Math.min(8, count - out.length);
    await progress(`ප්‍රශ්න generate කරනවා — ${out.length}/${count}`);
    const existing = out.slice(-20).map((q) => q.question).join('\n');
    const raw = await gemini(
      `Create EXACTLY ${need} NEW high-quality Sri Lankan G.C.E. Advanced Level ICT multiple-choice questions about "${topic}".
Language: ${language}.
Return ONLY valid JSON (no markdown, no code fences):
{"questions":[{"question":"...","options":["...","...","...","..."],"answer":"A"}]}

Rules:
- Exactly four distinct options per question
- answer must be A, B, C, or D
- Exam-quality, factual, no placeholders
- Do not repeat any of these existing questions:
${existing || '(none)'}`
    );
    let parsed;
    try {
      parsed = JSON.parse(cleanJson(raw));
    } catch (_) {
      continue;
    }
    for (const q of parsed.questions || []) {
      const question = cleanText(q.question);
      const options = Array.isArray(q.options) ? q.options.map(cleanText) : [];
      const answer = String(q.answer || '').trim().toUpperCase();
      const key = question.toLowerCase().replace(/\s+/g, ' ');
      if (
        question &&
        options.length === 4 &&
        options.every(Boolean) &&
        new Set(options.map((x) => x.toLowerCase())).size === 4 &&
        /^[ABCD]$/.test(answer) &&
        !seen.has(key)
      ) {
        seen.add(key);
        out.push({ question, options, answer });
      }
      if (out.length >= count) break;
    }
  }
  if (out.length < count) {
    throw new Error(`Could only generate ${out.length}/${count} valid questions`);
  }
  await progress(`ප්‍රශ්න ${count}ම ready`, 'done');
  return out.slice(0, count);
}

function buildHtml(title, questions) {
  const blocks = questions
    .map((q, i) => {
      const opts = q.options
        .map(
          (opt, k) => `
        <div class="option">
          <span class="option-label">${'ABCD'[k]}</span>
          <span class="option-text">${escapeHtml(opt)}</span>
        </div>`
        )
        .join('');
      return `
      <div class="question-block">
        <div class="question-text">
          <span class="question-number">${i + 1}.</span>
          ${escapeHtml(q.question)}
        </div>
        <div class="options">${opts}</div>
      </div>`;
    })
    .join('');

  const answers = questions
    .map(
      (q, i) =>
        `<div class="answer-cell"><strong>${i + 1}.</strong> ${escapeHtml(q.answer)}</div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="si">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Sinhala:wght@400;600;700&family=Noto+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
    body {
      font-family: 'Noto Sans Sinhala', 'Noto Sans', system-ui, sans-serif;
      font-size: 10.5pt;
      line-height: 1.55;
      color: #1f2937;
      background: #fff;
      -webkit-font-smoothing: antialiased;
    }
    .header {
      background: linear-gradient(135deg, #1e3a5f 0%, #1a4a7a 100%);
      color: #fff;
      padding: 18pt 16pt;
      margin: -18mm -16mm 14pt -16mm;
      text-align: center;
      border-bottom: 3.5pt solid #2dd4bf;
    }
    .header h1 {
      font-size: 16pt;
      font-weight: 700;
      margin-bottom: 4pt;
      letter-spacing: 0.2px;
    }
    .header p {
      font-size: 9pt;
      opacity: 0.92;
    }
    .question-block {
      margin-bottom: 11pt;
      padding-bottom: 9pt;
      border-bottom: 0.6pt solid #e5e7eb;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .question-text {
      font-size: 10.4pt;
      margin-bottom: 6pt;
      color: #111827;
    }
    .question-number {
      font-weight: 700;
      color: #1e3a5f;
      margin-right: 4pt;
    }
    .options { margin-left: 4pt; }
    .option {
      display: flex;
      gap: 7pt;
      margin-bottom: 4pt;
      align-items: flex-start;
      page-break-inside: avoid;
    }
    .option-label {
      flex-shrink: 0;
      width: 18pt;
      height: 18pt;
      background: #eff6ff;
      border: 1pt solid #2dd4bf;
      border-radius: 4pt;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 8.5pt;
      color: #1e3a5f;
    }
    .option-text {
      font-size: 9.6pt;
      color: #374151;
      padding-top: 1.5pt;
      word-break: break-word;
    }
    .answer-page {
      page-break-before: always;
      break-before: page;
      padding-top: 8pt;
    }
    .answer-page h2 {
      text-align: center;
      color: #1e3a5f;
      font-size: 15pt;
      margin-bottom: 4pt;
    }
    .answer-page .sub {
      text-align: center;
      color: #64748b;
      font-size: 9pt;
      margin-bottom: 14pt;
    }
    .answer-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6pt;
    }
    .answer-cell {
      background: #f1f5f9;
      border: 1pt solid #e2e8f0;
      border-radius: 4pt;
      padding: 6pt 4pt;
      text-align: center;
      font-size: 9pt;
      color: #1e3a5f;
      page-break-inside: avoid;
    }
    .footer-note {
      margin-top: 16pt;
      text-align: center;
      font-size: 8pt;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <p>A/L ICT · MCQ Model Paper · ${questions.length} Questions</p>
  </div>
  ${blocks}
  <div class="answer-page">
    <h2>පිළිතුරු පත්‍රය</h2>
    <p class="sub">Answer Key</p>
    <div class="answer-grid">${answers}</div>
    <p class="footer-note">Super Agent · Generated for study use</p>
  </div>
</body>
</html>`;
}

async function generatePdfViaHtml(title, questions) {
  if (!puppeteerLib) {
    throw new Error('Puppeteer is not installed — cannot render browser PDF');
  }

  await progress('Browser PDF layout හදනවා');
  const html = buildHtml(title, questions);

  let browser;
  try {
    browser = await puppeteerLib.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
      ],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.evaluateHandle('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 400));

    await progress('PDF render කරනවා');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: false,
      timeout: 45000,
    });

    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 2000 || pdfBuffer.subarray(0, 4).toString() !== '%PDF') {
      throw new Error('Browser produced an invalid or empty PDF');
    }

    await progress('PDF එක ready', 'done');
    return pdfBuffer;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

async function sendTelegram(buffer, filename, caption, chatId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id = String(chatId || process.env.NIGHT_AGENT_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  if (!id) throw new Error('Telegram chat ID is missing');
  if (!Buffer.isBuffer(buffer) || buffer.length < 1000 || buffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('PDF validation failed before Telegram upload');
  }

  await progress('Telegram එකට attach කරනවා');
  const telegram = new TelegramBot(token, { polling: false });
  const msg = await telegram.sendDocument(
    id,
    buffer,
    { filename, contentType: 'application/pdf' },
    { caption }
  );
  const fileId = msg?.document?.file_id;
  if (!fileId) throw new Error('Telegram accepted the request but returned no document file_id');
  await progress('Delivery confirm උනා', 'done');
  return { file_id: fileId, message_id: msg.message_id, chat_id: id };
}

const completed = new Map();
const inflight = new Map();

async function generateDocument(args = {}) {
  const count = Math.max(1, Math.min(Number(args.count) || 50, 100));
  const topic = cleanText(args.topic || 'A/L ICT');
  const language = cleanText(args.language || 'Sinhala');
  const title = cleanText(args.title || `${topic} MCQ Model Paper`);
  const chatId = args.chat_id || process.env.NIGHT_AGENT_CHAT_ID;
  const key = JSON.stringify({ count, topic, language, title, chatId: String(chatId || '') });

  if (completed.has(key)) {
    return { ...completed.get(key), duplicate_call: true, terminal: true };
  }
  if (inflight.has(key)) {
    return { ...(await inflight.get(key)), duplicate_call: true, terminal: true };
  }

  if (args.progress) progressCallback = args.progress;

  const work = (async () => {
    await progress('PDF request prepare කරනවා');
    const questions = await makeQuestions(topic, count, language);
    await progress('Layout + Sinhala font apply කරනවා');
    const pdf = await generatePdfViaHtml(title, questions);
    const filename = `AL_ICT_${topic.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40)}_MCQ_${count}.pdf`;
    const delivery = await sendTelegram(
      pdf,
      filename,
      `📄 ${title}\nප්‍රශ්න ${count}ක් · Answer key සමඟ`,
      chatId
    );
    const result = {
      created: true,
      delivered: true,
      delivery_verified: true,
      terminal: true,
      question_count: questions.length,
      file_name: filename,
      telegram_file_id: delivery.file_id,
      telegram_message_id: delivery.message_id,
      chat_id: delivery.chat_id,
      format: 'pdf',
      designed: true,
      engine: 'puppeteer',
    };
    completed.set(key, result);
    return result;
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

module.exports = { generateDocument, progress };
