const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const PDFDocument = require('pdfkit');

// Prefer a real TTF/OTF. PDFKit cannot render Fontsource webfont (woff/woff2) files —
// @fontsource packages only ship woff/woff2, so searching them for .ttf/.otf always
// fails. Instead we cache one real TTF on disk and download it once if missing.
const FONT_CACHE_DIR = path.join(os.tmpdir(), 'super-agent-fonts');
const FONT_CACHE_PATH = path.join(FONT_CACHE_DIR, 'NotoSansSinhala-Regular.ttf');
// Google serves legacy browsers (e.g. old IE/Android UAs with no woff2 support) a
// real .ttf instead of .woff2 from this same CSS endpoint - this is the standard
// trick for getting a plain TTF straight from Google Fonts without guessing a
// gstatic filename.
const FONT_CSS_URL = 'https://fonts.googleapis.com/css?family=Noto+Sans+Sinhala';
const LEGACY_UA = 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)';

function findLocalFont(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir, { withFileTypes: true });
  const preferred = [
    ...files.filter(x => x.isFile() && /noto.?sans.?sinhala.*\.ttf$/i.test(x.name)),
    ...files.filter(x => x.isFile() && /sinhala.*\.(ttf|otf)$/i.test(x.name)),
  ];
  if (preferred.length) return path.join(dir, preferred[0].name);
  for (const entry of files) {
    if (entry.isDirectory()) {
      const found = findLocalFont(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFont(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadFont(res.headers.location, destPath, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Font download failed: HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const tmp = destPath + '.part';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (err) return reject(err);
          try {
            const stat = fs.statSync(tmp);
            if (stat.size < 10000) { fs.unlinkSync(tmp); return reject(new Error('Downloaded font file looked too small/corrupt')); }
            fs.renameSync(tmp, destPath);
            resolve(destPath);
          } catch (e) { reject(e); }
        });
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveFontUrlFromCss() {
  // Request the CSS with an old-browser UA so Google's font server replies with a
  // real .ttf url() instead of .woff2 - avoids guessing gstatic filenames.
  const css = await fetchText(FONT_CSS_URL, { 'User-Agent': LEGACY_UA });
  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/i);
  if (!match) throw new Error('Could not find a .ttf URL in Google Fonts CSS response');
  return match[1];
}

// Try a couple of known-good npm package locations first (in case one is installed
// and does ship a real ttf/otf), then fall back to a cached/downloaded copy.
function findBundledFont() {
  const candidates = [];
  try { candidates.push(path.dirname(require.resolve('@fontsource/noto-sans-sinhala/package.json'))); } catch (_) {}
  for (const dir of candidates) {
    const found = findLocalFont(dir);
    if (found) return found;
  }
  return null;
}

let fontPathPromise = null;
async function resolveFontPath() {
  const bundled = findBundledFont();
  if (bundled) return bundled;
  if (fs.existsSync(FONT_CACHE_PATH)) return FONT_CACHE_PATH;
  if (!fontPathPromise) {
    fontPathPromise = (async () => {
      const ttfUrl = await resolveFontUrlFromCss();
      return downloadFont(ttfUrl, FONT_CACHE_PATH);
    })().catch((e) => {
      fontPathPromise = null; // allow retry on next call instead of caching the failure forever
      throw e;
    });
  }
  return fontPathPromise;
}
const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

function keys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function cleanJson(s) {
  return String(s || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

// Never let model HTML/XML leak into a rendered document.
function cleanText(value) {
  let s = String(value ?? '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function gemini(prompt) {
  const pool = keys();
  if (!pool.length) throw new Error('No Gemini API key configured');
  let last;
  for (const key of pool) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.55, maxOutputTokens: 7000 } }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || `Gemini HTTP ${r.status}`);
      return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    } catch (e) { last = e; }
  }
  throw last || new Error('Gemini request failed');
}

async function makeQuestions(topic, count, language) {
  const out = []; const seen = new Set();
  for (let round = 0; out.length < count && round < 30; round++) {
    const need = Math.min(8, count - out.length);
    const existing = out.slice(-20).map(q => q.question).join('\n');
    const raw = await gemini(`Create EXACTLY ${need} NEW high-quality multiple-choice questions for ${topic}. Language: ${language}. Return ONLY valid JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":"A"}]}. Rules: exactly four distinct options; answer is A/B/C/D; NO HTML, XML, Markdown, tags, or code fences in question/option text; no placeholder text such as Item A/B; exam-quality; do not repeat existing questions. Existing:\n${existing || '(none)'}`);
    let parsed; try { parsed = JSON.parse(cleanJson(raw)); } catch (_) { continue; }
    for (const q of (parsed.questions || [])) {
      const text = cleanText(q.question);
      const options = Array.isArray(q.options) ? q.options.map(cleanText) : [];
      const answer = String(q.answer || '').trim().toUpperCase();
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      const uniqueOptions = new Set(options.map(x => x.toLowerCase()));
      const placeholder = /^(item|option|question)\s*[a-d0-9]*$/i;
      if (text && options.length === 4 && options.every(Boolean) && uniqueOptions.size === 4 && options.every(x => !placeholder.test(x)) && /^[ABCD]$/.test(answer) && !seen.has(key)) {
        seen.add(key); out.push({ question: text, options, answer });
      }
      if (out.length >= count) break;
    }
  }
  if (out.length !== count) throw new Error(`Could only create ${out.length}/${count} valid questions`);
  return out;
}

function roundedBox(doc, x, y, w, h, radius = 10) { doc.roundedRect(x, y, w, h, radius); }

function drawHeader(doc, title, count) {
  const left = 42, width = doc.page.width - 84;
  doc.save();
  doc.fillColor('#173B6C').rect(0, 0, doc.page.width, 112).fill();
  doc.fillColor('#27A7A0').rect(0, 108, doc.page.width, 4).fill();
  doc.fillColor('#FFFFFF').fontSize(20).font(FONT_PATH).text(cleanText(title), left, 47, { width, align: 'center', lineGap: 3 });
  doc.fillColor('#DDEBFF').fontSize(10.5).text(`ප්‍රශ්න ${count} | Multiple Choice Question Paper`, left, 88, { width, align: 'center' });
  doc.restore();
}

function drawFooter(doc, pageNumber) {
  const y = doc.page.height - 34;
  doc.save();
  doc.strokeColor('#D7DEE8').lineWidth(0.7).moveTo(42, y - 9).lineTo(doc.page.width - 42, y - 9).stroke();
  doc.fillColor('#657184').fontSize(8.5).font(FONT_PATH).text('Super Agent • Generated document', 42, y, { width: 250 });
  doc.text(`Page ${pageNumber}`, doc.page.width - 110, y, { width: 68, align: 'right' });
  doc.restore();
}

function drawQuestion(doc, q, index) {
  const x = 42, width = doc.page.width - 84, startY = doc.y, accent = '#2B6CB0';
  // Subtle question card, blue number badge, readable typography and spacing.
  doc.save(); doc.fillColor('#F7FAFC'); roundedBox(doc, x, startY - 5, width, 20, 8); doc.fill(); doc.restore();
  doc.fillColor(accent).fontSize(11.2).font(FONT_PATH).text(`${index}.`, x + 10, startY + 1, { continued: true });
  doc.fillColor('#1F2937').fontSize(10.7).font(FONT_PATH).text(` ${q.question}`, { width: width - 30, lineGap: 2, paragraphGap: 4 });
  ['A', 'B', 'C', 'D'].forEach((label, i) => {
    const y = doc.y + 2;
    doc.save(); doc.fillColor('#EAF2FF'); roundedBox(doc, x + 10, y - 1, 20, 17, 7); doc.fill(); doc.restore();
    doc.fillColor(accent).fontSize(9.2).font(FONT_PATH).text(label, x + 10, y + 2, { width: 20, align: 'center' });
    doc.fillColor('#374151').fontSize(9.7).font(FONT_PATH).text(q.options[i], x + 38, y, { width: width - 48, lineGap: 1.5 });
  });
  doc.moveDown(0.45);
}

let FONT_PATH = null;

function makePdf(title, questions) {
  return new Promise((resolve, reject) => {
    if (!FONT_PATH) return reject(new Error('A TTF/OTF Sinhala font could not be found'));
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    doc.font(FONT_PATH); doc.on('data', c => chunks.push(c)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(doc, title, questions.length); doc.y = 132;
    questions.forEach((q, i) => {
      if (doc.y > doc.page.height - 105) { doc.addPage(); drawHeader(doc, title, questions.length); doc.y = 132; }
      drawQuestion(doc, q, i + 1);
    });

    doc.addPage();
    doc.fillColor('#173B6C').fontSize(19).font(FONT_PATH).text('පිළිතුරු පත්‍රය', { align: 'center' });
    doc.moveDown(0.8); doc.fillColor('#64748B').fontSize(9.5).text('Answer Key', { align: 'center' }); doc.moveDown(1.2);
    const cols = 4, colWidth = (doc.page.width - 84) / cols;
    questions.forEach((q, i) => {
      const col = i % cols, row = Math.floor(i / cols), x = 42 + col * colWidth, y = 150 + row * 25;
      doc.save(); doc.fillColor('#F3F7FC'); roundedBox(doc, x + 3, y - 3, colWidth - 8, 20, 6); doc.fill(); doc.restore();
      doc.fillColor('#173B6C').fontSize(9.2).font(FONT_PATH).text(`${i + 1}. ${q.answer}`, x + 8, y + 2, { width: colWidth - 18 });
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); drawFooter(doc, i + 1); }
    doc.end();
  });
}

async function sendTelegram(buffer, filename, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.NIGHT_AGENT_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram credentials are not configured');
  const fd = new FormData();
  fd.append('chat_id', chatId); fd.append('caption', caption);
  fd.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
  const d = await r.json(); if (!r.ok || !d.ok) throw new Error(d.description || `Telegram HTTP ${r.status}`);
  return d.result?.document?.file_id || null;
}

const completed = new Map();
async function generateDocument(args = {}) {
  const count = Math.max(1, Math.min(Number(args.count) || 50, 100));
  const topic = cleanText(args.topic || 'A/L ICT');
  const language = cleanText(args.language || 'Sinhala');
  const title = cleanText(args.title || `${topic} MCQ Model Paper`);
  const key = JSON.stringify({ count, topic, language, title });
  if (completed.has(key)) return { ...completed.get(key), duplicate_call: true, terminal: true };

  const questions = await makeQuestions(topic, count, language);
  FONT_PATH = await resolveFontPath();
  const pdf = await makePdf(title, questions);
  const filename = `${title.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${count}.pdf`;
  const fileId = await sendTelegram(pdf, filename, `📄 ${title}\nප්‍රශ්න ${count}ක් සහිත designed PDF එක සාර්ථකව attach කළා.`);
  const result = { created: true, delivered: true, terminal: true, question_count: questions.length, file_name: filename, telegram_file_id: fileId, format: 'pdf', designed: true };
  completed.set(key, result);
  return result;
}
module.exports = { generateDocument };
