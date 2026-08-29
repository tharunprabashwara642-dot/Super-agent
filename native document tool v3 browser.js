const fs = require('fs');
const path = require('path');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
let puppeteerLib = null;
try { puppeteerLib = require('puppeteer'); } catch(_) {}

// Progress callback placeholder
let progressCallback = async (msg, state) => {};
async function progress(msg, state='running') { 
  try { await progressCallback(msg, state); } catch(_) {} 
}

function cleanJson(s){return String(s||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/i,'').trim();}
function cleanText(value){let s=String(value??'');s=s.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'");return s.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}

const MODEL=process.env.GEMINI_TEXT_MODEL||'gemini-2.5-flash';
function keys(){return(process.env.GEMINI_API_KEYS||process.env.GEMINI_API_KEY||'').split(',').map(s=>s.trim()).filter(Boolean);}
async function gemini(prompt){const pool=keys();if(!pool.length)throw new Error('No Gemini API key configured');let last;for(const key of pool){try{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:.55,maxOutputTokens:7000}})});const d=await r.json();if(!r.ok)throw new Error(d.error?.message||`Gemini HTTP ${r.status}`);return(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');}catch(e){last=e;}}throw last||new Error('Gemini request failed');}

async function makeQuestions(topic,count,language){const out=[],seen=new Set();for(let round=0;out.length<count&&round<30;round++){const need=Math.min(8,count-out.length);const existing=out.slice(-20).map(q=>q.question).join('\n');const raw=await gemini(`Create EXACTLY ${need} NEW high-quality multiple-choice questions for ${topic}. Language: ${language}. Return ONLY valid JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":"A"}]}. Rules: exactly four distinct options; answer A/B/C/D; NO HTML/XML/Markdown/code fences; no placeholder text; exam-quality; do not repeat existing questions. Existing:\n${existing||'(none)'}`);let parsed;try{parsed=JSON.parse(cleanJson(raw));}catch(_){continue;}for(const q of(parsed.questions||[])){const text=cleanText(q.question),options=Array.isArray(q.options)?q.options.map(cleanText):[],answer=String(q.answer||'').trim().toUpperCase(),key=text.toLowerCase().replace(/\s+/g,' '),unique=new Set(options.map(x=>x.toLowerCase()));if(text&&options.length===4&&options.every(Boolean)&&unique.size===4&&/^[ABCD]$/.test(answer)&&!seen.has(key)){seen.add(key);out.push({question:text,options,answer});}if(out.length>=count)break;}}if(out.length!==count)throw new Error(`Could only create ${out.length}/${count} valid questions`);return out;}

// Browser-based PDF rendering with full Sinhala support
async function generatePdfViaHtml(title, questions) {
  if (!puppeteerLib) {
    throw new Error('Puppeteer not installed. Install with: npm install puppeteer');
  }
  
  await progress('Browser එක launch කරනවා');
  
  const questionsHtml = questions.map((q, i) => `
    <div class="question-block">
      <div class="question-number">${i + 1}.</div>
      <div class="question-text">${escapeHtml(q.question)}</div>
      <div class="options">
        ${q.options.map((opt, j) => `
          <div class="option">
            <div class="option-label">${String.fromCharCode(65 + j)}</div>
            <div class="option-text">${escapeHtml(opt)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
  
  const answerKeyHtml = questions.map((q, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    return `<div class="answer-cell" style="grid-column: ${col + 1}; grid-row: ${row + 1};">${i + 1}. ${q.answer}</div>`;
  }).join('');
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: A4; margin: 42pt; }
    @page :first { margin-top: 42pt; }
    body { font-family: 'Noto Sans', 'Noto Sans Sinhala', system-ui, sans-serif; line-height: 1.6; color: #202938; background: white; }
    .page-header {
      background: linear-gradient(135deg, #173B6C 0%, #1a4080 100%);
      color: white;
      padding: 24pt;
      margin: -42pt -42pt 24pt -42pt;
      text-align: center;
      border-bottom: 4pt solid #27A7A0;
    }
    .page-header h1 { font-size: 20pt; margin-bottom: 8pt; font-weight: 600; }
    .page-header p { font-size: 10pt; opacity: 0.9; }
    .question-block {
      margin-bottom: 16pt;
      page-break-inside: avoid;
      padding-bottom: 12pt;
      border-bottom: 1pt solid #e5e7eb;
    }
    .question-number {
      font-weight: 600;
      color: #173B6C;
      font-size: 11pt;
      display: inline-block;
      width: 24pt;
    }
    .question-text {
      font-size: 10.3pt;
      margin-bottom: 8pt;
      color: #202938;
      word-wrap: break-word;
    }
    .options {
      margin-left: 24pt;
    }
    .option {
      display: flex;
      gap: 8pt;
      margin-bottom: 6pt;
      align-items: flex-start;
    }
    .option-label {
      background: #EAF2FF;
      border: 1pt solid #27A7A0;
      border-radius: 4pt;
      width: 20pt;
      height: 20pt;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      color: #173B6C;
      font-size: 9.2pt;
      flex-shrink: 0;
    }
    .option-text {
      font-size: 9.4pt;
      color: #374151;
      word-wrap: break-word;
      padding-top: 2pt;
    }
    .answer-page {
      margin-top: 24pt;
      page-break-before: always;
    }
    .answer-page h2 {
      text-align: center;
      color: #173B6C;
      font-size: 19pt;
      margin-bottom: 12pt;
    }
    .answer-page p {
      text-align: center;
      color: #64748B;
      font-size: 9.5pt;
      margin-bottom: 16pt;
    }
    .answer-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8pt;
      margin-top: 16pt;
    }
    .answer-cell {
      background: #F3F7FC;
      border: 1pt solid #d8dee8;
      border-radius: 4pt;
      padding: 8pt;
      text-align: center;
      font-size: 9.2pt;
      color: #173B6C;
      font-weight: 500;
      page-break-inside: avoid;
    }
    .page-footer {
      position: fixed;
      bottom: 42pt;
      left: 42pt;
      right: 42pt;
      border-top: 1pt solid #d8dee8;
      padding-top: 8pt;
      font-size: 7.5pt;
      color: #657184;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="page-header">
    <h1>${escapeHtml(cleanText(title))}</h1>
    <p>ප්‍රශ්න ${questions.length} | Multiple Choice Question Paper</p>
  </div>
  
  <div class="questions">
    ${questionsHtml}
  </div>
  
  <div class="answer-page">
    <h2>පිළිතුරු පත්‍රය</h2>
    <p>Answer Key</p>
    <div class="answer-grid">
      ${answerKeyHtml}
    </div>
  </div>
  
  <div class="page-footer">
    <span>Super Agent • Generated document</span>
    <span><span class="page-number"></span></span>
  </div>
</body>
</html>`;

  let browser;
  try {
    await progress('Chromium කරුණ launch කරනවා');
    browser = await puppeteerLib.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      timeout: 30000,
    });

    await progress('HTML render කරනවා');
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    
    await progress('PDF generate කරනවා');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: 42, bottom: 42, left: 42, right: 42 },
      displayHeaderFooter: false,
      printBackground: true,
      timeout: 30000,
    });

    await progress('PDF එක ready', 'done');
    return pdfBuffer;
  } catch (e) {
    throw new Error(`Browser PDF generation failed: ${e.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch(_) {}
    }
  }
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}

// Telegram uploader
async function sendTelegram(buffer, filename, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.NIGHT_AGENT_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram credentials are not configured');
  
  const telegram = new TelegramBot(token, { polling: false });
  const msg = await telegram.sendDocument(chatId, buffer, { filename, contentType: 'application/pdf' }, { caption });
  const fileId = msg?.document?.file_id;
  if (!fileId) throw new Error('Telegram accepted the request but returned no document file_id');
  return { file_id: fileId, message_id: msg.message_id };
}

const completed = new Map();
async function generateDocument(args = {}) {
  const count = Math.max(1, Math.min(Number(args.count) || 50, 100));
  const topic = cleanText(args.topic || 'A/L ICT');
  const language = cleanText(args.language || 'Sinhala');
  const title = cleanText(args.title || `${topic} MCQ Model Paper`);
  const key = JSON.stringify({ count, topic, language, title });
  
  if (completed.has(key)) {
    return { ...completed.get(key), duplicate_call: true, terminal: true };
  }
  
  const questions = await makeQuestions(topic, count, language);
  
  // Set the progress callback if provided
  if (args.progress) {
    progressCallback = args.progress;
  }
  
  const pdf = await generatePdfViaHtml(title, questions);
  
  if (!pdf || pdf.length < 1000) {
    throw new Error('Generated PDF is empty or invalid');
  }
  
  const filename = `${title.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${count}.pdf`;
  const delivery = await sendTelegram(
    pdf,
    filename,
    `📄 ${title}\nප්‍රශ්න ${count}ක් සහිත designed PDF එක සාර්ථකව attach කළා.`
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
    format: 'pdf',
    designed: true,
  };
  
  completed.set(key, result);
  return result;
}

module.exports = { generateDocument, progress };
