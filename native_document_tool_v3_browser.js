/**
 * Browser-based exam-paper PDF generator (Puppeteer).
 * Prefer this path for Sinhala/complex scripts — Chromium text shaping is far
 * more reliable than PDFKit for Sinhala conjuncts and layout.
 * Fixes: empty pages, garbled Sinhala, missing content.
 *
 * Subject-agnostic: `subject` (falls back to `topic` if omitted) and `topic`
 * are threaded through the Gemini prompt, PDF header, and filename — nothing
 * is hardcoded to a single subject.
 *
 * Supports three question_type modes: "mcq" (default), "structured"
 * (sub-parts a/b/c with marks + a marking scheme), and "essay" (long-form
 * questions with a marks-annotated guidance/marking scheme).
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

// Short label for marking-scheme headings — avoids repeating the entire
// (often very long) question text a second time under "Marking Scheme".
function shortLabel(text, n = 70) {
  const s = String(text || '').trim();
  return s.length > n ? `${s.slice(0, n).trim()}…` : s;
}

function slugify(value, fallback) {
  const s = String(value || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || fallback).slice(0, 40);
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

// ============================================================
// MCQ
// ============================================================
async function makeMcqQuestions(subject, topic, count, language) {
  const out = [];
  const seen = new Set();
  for (let round = 0; out.length < count && round < 30; round++) {
    const need = Math.min(8, count - out.length);
    await progress(`${subject} ප්‍රශ්න generate කරනවා — ${out.length}/${count}`);
    const existing = out.slice(-20).map((q) => q.question).join('\n');
    const raw = await gemini(
      `Create EXACTLY ${need} NEW high-quality Sri Lankan G.C.E. Advanced Level ${subject} multiple-choice questions about "${topic}".
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

function buildMcqHtml(title, subject, questions) {
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

  return wrapHtml(
    title,
    subject,
    `MCQ Model Paper · ${questions.length} Questions`,
    blocks,
    `
  <div class="answer-page">
    <h2>පිළිතුරු පත්‍රය</h2>
    <p class="sub">Answer Key</p>
    <div class="answer-grid">${answers}</div>
    <p class="footer-note">Super Agent · Generated for study use</p>
  </div>`
  );
}

// ============================================================
// STRUCTURED (sub-parts a/b/c with marks + marking scheme)
// ============================================================
async function makeStructuredQuestions(subject, topic, count, language) {
  const out = [];
  for (let round = 0; out.length < count && round < 15; round++) {
    const need = Math.min(4, count - out.length);
    await progress(`${subject} structured ප්‍රශ්න generate කරනවා — ${out.length}/${count}`);
    const existing = out.map((q) => q.question).join('\n');
    const raw = await gemini(
      `Create EXACTLY ${need} NEW Sri Lankan G.C.E. Advanced Level ${subject} STRUCTURED exam questions about "${topic}".
Language: ${language}.
Each question has a short stem and 3-5 lettered sub-parts (a, b, c, ...) with mark allocations that sum to the question's total marks (use 10 or 15 total marks per question). Each sub-part needs a concise model answer for the marking scheme.
Return ONLY valid JSON (no markdown, no code fences):
{"questions":[{"question":"stem text","marks":15,"parts":[{"label":"(a)","text":"sub-question text","marks":5,"answer":"concise model answer"}]}]}

Rules:
- Exam-quality, factual, no placeholders
- Sub-part marks must sum to the question's total marks
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
      const parts = Array.isArray(q.parts)
        ? q.parts
            .map((p) => ({
              label: cleanText(p.label || ''),
              text: cleanText(p.text || ''),
              marks: Number(p.marks) || 0,
              answer: cleanText(p.answer || ''),
            }))
            .filter((p) => p.text && p.answer)
        : [];
      const marks = Number(q.marks) || parts.reduce((sum, p) => sum + p.marks, 0);
      if (question && parts.length >= 2) {
        out.push({ question, marks, parts });
      }
      if (out.length >= count) break;
    }
  }
  if (out.length < count) {
    throw new Error(`Could only generate ${out.length}/${count} valid structured questions`);
  }
  await progress(`Structured ප්‍රශ්න ${count}ම ready`, 'done');
  return out.slice(0, count);
}

function buildStructuredHtml(title, subject, questions) {
  const blocks = questions
    .map((q, i) => {
      const parts = q.parts
        .map(
          (p) => `
        <div class="sub-part">
          <span class="sub-label">${escapeHtml(p.label)}</span>
          <span class="sub-text">${escapeHtml(p.text)}</span>
          <span class="sub-marks">[${p.marks}]</span>
        </div>`
        )
        .join('');
      return `
      <div class="question-block">
        <div class="question-text">
          <span class="question-number">${i + 1}.</span>
          ${escapeHtml(q.question)}
          <span class="total-marks">(${q.marks} marks)</span>
        </div>
        <div class="parts">${parts}</div>
      </div>`;
    })
    .join('');

  const scheme = questions
    .map(
      (q, i) => `
      <div class="scheme-block">
        <div class="scheme-title">${i + 1}. ${escapeHtml(shortLabel(q.question))}</div>
        ${q.parts
          .map(
            (p) => `<div class="scheme-part"><strong>${escapeHtml(p.label)}</strong> (${p.marks}) — ${escapeHtml(p.answer)}</div>`
          )
          .join('')}
      </div>`
    )
    .join('');

  return wrapHtml(
    title,
    subject,
    `Structured Model Paper · ${questions.length} Questions`,
    blocks,
    `
  <div class="answer-page">
    <h2>Marking Scheme</h2>
    <p class="sub">ලකුණු ලබා දෙන ක්‍රමය</p>
    ${scheme}
    <p class="footer-note">Super Agent · Generated for study use</p>
  </div>`,
    STRUCTURED_EXTRA_CSS
  );
}

// ============================================================
// ESSAY
// ============================================================
async function makeEssayQuestions(subject, topic, count, language) {
  const out = [];
  for (let round = 0; out.length < count && round < 15; round++) {
    const need = Math.min(3, count - out.length);
    await progress(`${subject} essay ප්‍රශ්න generate කරනවා — ${out.length}/${count}`);
    const existing = out.map((q) => q.question).join('\n');
    const raw = await gemini(
      `Create EXACTLY ${need} NEW Sri Lankan G.C.E. Advanced Level ${subject} ESSAY exam questions about "${topic}".
Language: ${language}.
Each question is worth 100 marks and needs a marking-scheme guidance list of 5-8 bullet points, each with its own mark allocation, that together sum to 100.
Return ONLY valid JSON (no markdown, no code fences):
{"questions":[{"question":"full essay question text","marks":100,"guidance":[{"point":"expected content point","marks":15}]}]}

Rules:
- Exam-quality, factual, no placeholders
- Guidance point marks must sum to 100
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
      const guidance = Array.isArray(q.guidance)
        ? q.guidance
            .map((g) => ({ point: cleanText(g.point || ''), marks: Number(g.marks) || 0 }))
            .filter((g) => g.point)
        : [];
      const marks = Number(q.marks) || 100;
      if (question && guidance.length >= 3) {
        out.push({ question, marks, guidance });
      }
      if (out.length >= count) break;
    }
  }
  if (out.length < count) {
    throw new Error(`Could only generate ${out.length}/${count} valid essay questions`);
  }
  await progress(`Essay ප්‍රශ්න ${count}ම ready`, 'done');
  return out.slice(0, count);
}

function buildEssayHtml(title, subject, questions) {
  const blocks = questions
    .map(
      (q, i) => `
      <div class="question-block">
        <div class="question-text">
          <span class="question-number">${i + 1}.</span>
          ${escapeHtml(q.question)}
          <span class="total-marks">(${q.marks} marks)</span>
        </div>
      </div>`
    )
    .join('');

  const scheme = questions
    .map(
      (q, i) => `
      <div class="scheme-block">
        <div class="scheme-title">${i + 1}. ${escapeHtml(shortLabel(q.question))}</div>
        ${q.guidance
          .map((g) => `<div class="scheme-part">• ${escapeHtml(g.point)} <strong>[${g.marks}]</strong></div>`)
          .join('')}
      </div>`
    )
    .join('');

  return wrapHtml(
    title,
    subject,
    `Essay Model Paper · ${questions.length} Questions`,
    blocks,
    `
  <div class="answer-page">
    <h2>Marking Scheme</h2>
    <p class="sub">ලකුණු ලබා දෙන ක්‍රමය</p>
    ${scheme}
    <p class="footer-note">Super Agent · Generated for study use</p>
  </div>`,
    STRUCTURED_EXTRA_CSS
  );
}

// ============================================================
// SHARED HTML SHELL
// ============================================================
const STRUCTURED_EXTRA_CSS = `
    .sub-part { display: flex; gap: 6pt; margin: 4pt 0 4pt 10pt; font-size: 9.6pt; color: #374151; }
    .sub-label { font-weight: 700; color: #1e3a5f; flex-shrink: 0; }
    .sub-marks { margin-left: auto; color: #64748b; font-weight: 600; }
    .total-marks { float: right; color: #64748b; font-weight: 600; font-size: 9pt; }
    .scheme-block { margin-bottom: 10pt; page-break-inside: avoid; }
    .scheme-title { font-weight: 700; color: #1e3a5f; margin-bottom: 4pt; font-size: 9.8pt; }
    .scheme-part { font-size: 9.2pt; color: #374151; margin: 2pt 0 2pt 8pt; }
`;

function wrapHtml(title, subject, subheading, bodyBlocks, tailSection, extraCss = '') {
  return `<!DOCTYPE html>
<html lang="si">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Sinhala:wght@400;600;700&family=Noto+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js"></script>
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
    .katex-display { margin: 4pt 0; overflow-x: hidden; }
    .katex { font-size: 1em; }
    ${extraCss}
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subject)} · ${escapeHtml(subheading)}</p>
  </div>
  ${bodyBlocks}
  ${tailSection}
  <script>
    // Questions come back from Gemini with LaTeX between $...$ / $$...$$
    // (e.g. Combined Maths integrals). Without this, that LaTeX source was
    // showing up as raw, unrendered text in the PDF. KaTeX renders it into
    // real math typesetting before Puppeteer takes the PDF snapshot.
    (function () {
      function done() { window.__mathReady = true; }
      try {
        if (typeof renderMathInElement !== 'function') { done(); return; }
        renderMathInElement(document.body, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\\\(', right: '\\\\)', display: false },
            { left: '\\\\[', right: '\\\\]', display: true },
          ],
          throwOnError: false,
        });
      } catch (e) { /* fall through to plain text rather than block the PDF */ }
      done();
    })();
  </script>
</body>
</html>`;
}

async function generatePdfViaHtml(html) {
  if (!puppeteerLib) {
    throw new Error('Puppeteer is not installed — cannot render browser PDF');
  }

  await progress('Browser PDF layout හදනවා');

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
    // Wait for KaTeX's auto-render pass (set by the inline <script> in
    // wrapHtml) so LaTeX like $\int f(x)\,dx$ is typeset before the
    // snapshot instead of showing up as raw, unrendered source text.
    await page.waitForFunction('window.__mathReady === true', { timeout: 15000 }).catch(() => {});
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

const QUESTION_TYPE_LABEL = { mcq: 'MCQ', structured: 'Structured', essay: 'Essay' };
const DEFAULT_COUNT = { mcq: 50, structured: 8, essay: 4 };

async function generateDocument(args = {}) {
  const questionType = ['mcq', 'structured', 'essay'].includes(String(args.question_type || '').toLowerCase())
    ? String(args.question_type).toLowerCase()
    : 'mcq';

  const topic = cleanText(args.topic || 'General Knowledge');
  // `subject` is independent of `topic` (e.g. subject="Biology", topic="Cell
  // Division") so any exam subject works, not just one hardcoded subject.
  // Falls back to the topic itself when no separate subject is given.
  const subject = cleanText(args.subject || topic);
  const language = cleanText(args.language || 'Sinhala');
  const maxCount = questionType === 'mcq' ? 100 : questionType === 'structured' ? 20 : 10;
  const count = Math.max(1, Math.min(Number(args.count) || DEFAULT_COUNT[questionType], maxCount));
  const title = cleanText(args.title || `${subject} ${QUESTION_TYPE_LABEL[questionType]} Model Paper`);
  const chatId = args.chat_id || process.env.NIGHT_AGENT_CHAT_ID;
  const key = JSON.stringify({ questionType, count, subject, topic, language, title, chatId: String(chatId || '') });

  if (completed.has(key)) {
    return { ...completed.get(key), duplicate_call: true, terminal: true };
  }
  if (inflight.has(key)) {
    return { ...(await inflight.get(key)), duplicate_call: true, terminal: true };
  }

  if (args.progress) progressCallback = args.progress;

  const work = (async () => {
    await progress(`${QUESTION_TYPE_LABEL[questionType]} PDF request prepare කරනවා`);

    let html;
    let questionCount;
    if (questionType === 'structured') {
      const questions = await makeStructuredQuestions(subject, topic, count, language);
      await progress('Layout + Sinhala font apply කරනවා');
      html = buildStructuredHtml(title, subject, questions);
      questionCount = questions.length;
    } else if (questionType === 'essay') {
      const questions = await makeEssayQuestions(subject, topic, count, language);
      await progress('Layout + Sinhala font apply කරනවා');
      html = buildEssayHtml(title, subject, questions);
      questionCount = questions.length;
    } else {
      const questions = await makeMcqQuestions(subject, topic, count, language);
      await progress('Layout + Sinhala font apply කරනවා');
      html = buildMcqHtml(title, subject, questions);
      questionCount = questions.length;
    }

    const pdf = await generatePdfViaHtml(html);
    const filename = `${slugify(subject, 'Subject')}_${slugify(topic, 'Topic')}_${QUESTION_TYPE_LABEL[questionType]}_${count}.pdf`;
    const delivery = await sendTelegram(
      pdf,
      filename,
      `📄 ${title}\nප්‍රශ්න ${count}ක් · ${questionType === 'mcq' ? 'Answer key' : 'Marking scheme'} සමඟ`,
      chatId
    );
    const result = {
      created: true,
      delivered: true,
      delivery_verified: true,
      terminal: true,
      question_type: questionType,
      subject,
      topic,
      question_count: questionCount,
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
