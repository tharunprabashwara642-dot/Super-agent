const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const PDFDocument = require('pdfkit');

const FONT_CACHE_DIR = path.join(os.tmpdir(), 'super-agent-fonts');
const FONT_CACHE_PATH = path.join(FONT_CACHE_DIR, 'NotoSansSinhala-Regular.ttf');
const FONT_CSS_URL = 'https://fonts.googleapis.com/css?family=Noto+Sans+Sinhala';
const LEGACY_UA = 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)';
let fontPromise = null;

function cleanText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function keys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(fetchText(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => { data += c; }); res.on('end', () => resolve(data)); res.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveFontPath() {
  if (fs.existsSync(FONT_CACHE_PATH)) return FONT_CACHE_PATH;
  if (!fontPromise) {
    fontPromise = (async () => {
      const css = await fetchText(FONT_CSS_URL, { 'User-Agent': LEGACY_UA });
      const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/i);
      if (!match) throw new Error('Could not resolve a Sinhala TTF font');
      fs.mkdirSync(FONT_CACHE_DIR, { recursive: true });
      const tmp = FONT_CACHE_PATH + '.part';
      await new Promise((resolve, reject) => {
        https.get(match[1], res => {
          if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Font HTTP ${res.statusCode}`)); }
          const out = fs.createWriteStream(tmp); res.pipe(out);
          out.on('finish', () => out.close(() => resolve())); out.on('error', reject);
        }).on('error', reject);
      });
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 10000) throw new Error('Downloaded Sinhala font is invalid');
      fs.renameSync(tmp, FONT_CACHE_PATH);
      return FONT_CACHE_PATH;
    })().catch(e => { fontPromise = null; throw e; });
  }
  return fontPromise;
}

function parseJson(raw) {
  const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(text);
}

async function generateStructuredContent(request, args) {
  if (args.content && Array.isArray(args.content.sections)) return args.content;
  const pool = keys();
  if (!pool.length) throw new Error('No Gemini API key configured for document generation');
  const prompt = `You are a document-production planner. Turn the user's request into a print-ready structured document.\n\nUSER REQUEST:\n${request}\n\nReturn ONLY JSON in this exact shape:\n{"title":"...","subtitle":"...","sections":[{"heading":"...","paragraphs":["..."],"bullets":["..."]}],"table":null,"footer":""}\n\nRules: understand the user's requested language, subject, count and style; do not invent a different task; if the request asks for a numbered list/questions, preserve the exact requested count; no HTML/Markdown/code fences; keep text suitable for A4 printing.`;
  let last;
  for (const key of pool) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.45, maxOutputTokens: 12000 } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
      return parseJson((data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
    } catch (e) { last = e; }
  }
  throw last || new Error('Document content generation failed');
}

function palette(style) {
  const s = String(style || '').toLowerCase();
  if (s.includes('dark')) return { primary:'#172033', accent:'#4F8CFF', text:'#E7ECF5', muted:'#AAB6C8', card:'#202B3D', bg:'#101722' };
  if (s.includes('green')) return { primary:'#14532D', accent:'#16A34A', text:'#1F2937', muted:'#64748B', card:'#F0FDF4', bg:'#FFFFFF' };
  if (s.includes('purple')) return { primary:'#4C1D95', accent:'#7C3AED', text:'#1F2937', muted:'#64748B', card:'#F5F3FF', bg:'#FFFFFF' };
  return { primary:'#173B6C', accent:'#2B6CB0', text:'#1F2937', muted:'#64748B', card:'#F7FAFC', bg:'#FFFFFF' };
}

function drawHeader(doc, data, colors) {
  const w = doc.page.width;
  doc.save(); doc.fillColor(colors.primary).rect(0,0,w,112).fill();
  doc.fillColor(colors.accent).rect(0,108,w,4).fill();
  doc.fillColor('#FFFFFF').fontSize(21).text(cleanText(data.title || 'Document'), 42, 38, { width:w-84, align:'center' });
  if (data.subtitle) doc.fillColor('#DDE7F5').fontSize(10.5).text(cleanText(data.subtitle), 42, 79, { width:w-84, align:'center' });
  doc.restore(); doc.y = 135;
}

function drawFooter(doc, page) {
  const y = doc.page.height - 34;
  doc.save(); doc.strokeColor('#D7DEE8').lineWidth(.7).moveTo(42,y-9).lineTo(doc.page.width-42,y-9).stroke();
  doc.fillColor('#64748B').fontSize(8.5).text('Super Agent • Generated document',42,y,{width:260});
  doc.text(`Page ${page}`,doc.page.width-110,y,{width:68,align:'right'}); doc.restore();
}

function renderDocument(data, style, fontPath) {
  return new Promise((resolve,reject)=>{
    const colors = palette(style);
    const doc = new PDFDocument({ size:'A4', margin:42, bufferPages:true });
    const chunks=[]; doc.on('data',c=>chunks.push(c)); doc.on('error',reject); doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.font(fontPath); drawHeader(doc,data,colors);
    for (const section of (data.sections || [])) {
      const heading = cleanText(section.heading || '');
      if (heading) {
        if (doc.y > doc.page.height-120) { doc.addPage(); drawHeader(doc,data,colors); }
        doc.fillColor(colors.primary).fontSize(14).font(fontPath).text(heading,{lineGap:2}); doc.moveDown(.35);
      }
      for (const p of (section.paragraphs || [])) {
        const text=cleanText(p); if (!text) continue;
        if (doc.y > doc.page.height-95) { doc.addPage(); drawHeader(doc,data,colors); }
        doc.fillColor(colors.text).fontSize(10.5).font(fontPath).text(text,{lineGap:3,paragraphGap:6});
      }
      for (const b of (section.bullets || [])) {
        const text=cleanText(b); if (!text) continue;
        if (doc.y > doc.page.height-95) { doc.addPage(); drawHeader(doc,data,colors); }
        doc.fillColor(colors.accent).fontSize(10.5).text('•',{continued:true});
        doc.fillColor(colors.text).text(` ${text}`,{lineGap:2,paragraphGap:3});
      }
      doc.moveDown(.45);
    }
    if (data.table && Array.isArray(data.table.rows)) {
      const headers=(data.table.headers||[]).map(cleanText); const rows=data.table.rows.slice(0,100);
      if (headers.length) {
        if (doc.y > doc.page.height-140) { doc.addPage(); drawHeader(doc,data,colors); }
        const width=doc.page.width-84, col=width/headers.length;
        doc.fillColor(colors.primary).rect(42,doc.y,width,22).fill();
        headers.forEach((h,i)=>doc.fillColor('#FFFFFF').fontSize(8.5).text(h,46+i*col,doc.y+6,{width:col-8}));
        doc.y += 28;
        for (const row of rows) {
          if (doc.y > doc.page.height-70) { doc.addPage(); drawHeader(doc,data,colors); }
          row.forEach((v,i)=>doc.fillColor(colors.text).fontSize(8.5).text(cleanText(v),46+i*col,doc.y,{width:col-8}));
          doc.moveDown(.6);
        }
      }
    }
    if (data.footer) { doc.moveDown(); doc.fillColor(colors.muted).fontSize(8.5).text(cleanText(data.footer),{align:'center'}); }
    const range=doc.bufferedPageRange(); for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);drawFooter(doc,i+1);} doc.end();
  });
}

async function sendTelegram(buffer, filename, caption) {
  const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.NIGHT_AGENT_CHAT_ID;
  if(!token||!chatId) throw new Error('Telegram credentials are not configured');
  const fd=new FormData(); fd.append('chat_id',chatId); fd.append('caption',caption);
  fd.append('document',new Blob([buffer],{type:'application/pdf'}),filename);
  const res=await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:fd});
  const data=await res.json(); if(!res.ok||!data.ok) throw new Error(data.description||`Telegram HTTP ${res.status}`);
  return data.result?.document?.file_id||null;
}

async function generatePdfDocument(args={}) {
  const request=cleanText(args.request||args.description||args.prompt||'');
  if(!request && !args.content) return {created:false,terminal:true,reason:'No document request/content supplied.'};
  const data=await generateStructuredContent(request,args);
  const font=await resolveFontPath();
  const pdf=await renderDocument(data,args.style||args.design||'professional',font);
  const safe=(data.title||'document').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,70)||'document';
  const filename=`${safe}.pdf`;
  const fileId=await sendTelegram(pdf,filename,`📄 ${cleanText(data.title||'Document')} — PDF එක සාර්ථකව හදලා attach කළා.`);
  return {created:true,delivered:true,terminal:true,format:'pdf',designed:true,file_name:filename,telegram_file_id:fileId};
}

module.exports={generatePdfDocument};
