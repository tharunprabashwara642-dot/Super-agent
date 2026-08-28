const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const PDFDocument = require('pdfkit');

// PDFKit needs a real TTF/OTF. @fontsource/noto-sans-sinhala commonly ships
// webfont assets, not a TTF, so relying on a guessed package path caused the
// production failure. Use a project-local TTF when present, otherwise cache
// the official Noto Sans Sinhala hinted TTF from the Noto project. The exact
// static font URL is used; no Google Fonts CSS parsing is involved.
const FONT_CACHE_DIR = path.join(os.tmpdir(), 'super-agent-fonts');
const FONT_CACHE_PATH = path.join(FONT_CACHE_DIR, 'NotoSansSinhala-Regular.ttf');
const FONT_URL = process.env.SINHALA_FONT_URL || 'https://notofonts.github.io/sinhala/fonts/NotoSansSinhala/hinted/ttf/NotoSansSinhala-Regular.ttf';
const FONT_MIN_BYTES = 30000;

function isUsableFont(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).size >= FONT_MIN_BYTES; } catch (_) { return false; }
}
function findLocalFont(dir) {
  if (!fs.existsSync(dir)) return null;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && /noto.?sans.?sinhala.*\.(ttf|otf)$/i.test(e.name) && isUsableFont(p)) return p;
    if (e.isDirectory()) { const f = findLocalFont(p); if (f) return f; }
  }
  return null;
}
function findBundledFont() {
  for (const p of [
    path.join(__dirname, 'assets', 'fonts', 'NotoSansSinhala-Regular.ttf'),
    path.join(__dirname, 'fonts', 'NotoSansSinhala-Regular.ttf'),
    path.join(__dirname, 'NotoSansSinhala-Regular.ttf')
  ]) if (isUsableFont(p)) return p;
  try {
    const root = path.dirname(require.resolve('@fontsource/noto-sans-sinhala/package.json'));
    const found = findLocalFont(root);
    if (found) return found;
  } catch (_) {}
  return null;
}
function downloadFont(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Super-Agent-PDF/1.0', Accept: 'font/ttf,application/octet-stream,*/*' }, timeout: 20000 }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume(); return resolve(downloadFont(new URL(res.headers.location, url).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Font download failed: HTTP ${res.statusCode}`)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part-${process.pid}`; const out = fs.createWriteStream(tmp); res.pipe(out);
      out.on('finish', () => out.close(err => {
        if (err) return reject(err);
        try { if (!isUsableFont(tmp)) throw new Error(`Downloaded font is invalid/small (${fs.statSync(tmp).size} bytes)`); fs.renameSync(tmp, dest); resolve(dest); }
        catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); }
      }));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Sinhala font download timed out')));
    req.on('error', reject);
  });
}
let fontPromise = null;
async function getFont() {
  const local = findBundledFont(); if (local) return local;
  if (isUsableFont(FONT_CACHE_PATH)) return FONT_CACHE_PATH;
  if (!fontPromise) fontPromise = downloadFont(FONT_URL, FONT_CACHE_PATH).catch(e => { fontPromise = null; throw new Error(`Sinhala font unavailable: ${e.message}`); });
  return fontPromise;
}

function clean(s) { return String(s ?? '').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim(); }
function jsonOnly(s) { return String(s || '').replace(/^```json\s*/i,'').replace(/```$/,'').trim(); }
function geminiKeys() { return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(x=>x.trim()).filter(Boolean); }
async function ask(prompt) {
  const keys=geminiKeys(); if(!keys.length) throw new Error('No Gemini API key configured for PDF content generation'); let last;
  for(const key of keys){try{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_TEXT_MODEL||'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:.45,maxOutputTokens:8000}})});const d=await r.json();if(!r.ok)throw new Error(d.error?.message||`Gemini HTTP ${r.status}`);return(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');}catch(e){last=e;}}
  throw last||new Error('Gemini request failed');
}
async function makeQuestions(topic,count,language){const result=[],seen=new Set();for(let round=0;result.length<count&&round<25;round++){const need=Math.min(8,count-result.length),existing=result.slice(-30).map(q=>q.question).join('\n');const raw=await ask(`Create EXACTLY ${need} new high-quality Sri Lankan G.C.E. Advanced Level ICT multiple-choice questions about ${topic}. Language: ${language}. Return ONLY JSON {"questions":[{"question":"...","options":["...","...","...","..."],"answer":"A"}]}. Exactly four distinct options, answer A/B/C/D, exam-quality, no markdown, no duplicates. Existing questions to avoid:\n${existing||'(none)'}`);let data;try{data=JSON.parse(jsonOnly(raw));}catch(_){continue;}for(const q of data.questions||[]){const question=clean(q.question),options=Array.isArray(q.options)?q.options.map(clean):[],answer=String(q.answer||'').trim().toUpperCase(),key=question.toLowerCase().replace(/\s+/g,' ');if(question&&options.length===4&&options.every(Boolean)&&new Set(options.map(x=>x.toLowerCase())).size===4&&/^[ABCD]$/.test(answer)&&!seen.has(key)){seen.add(key);result.push({question,options,answer});}if(result.length>=count)break;}}if(result.length!==count)throw new Error(`Could only generate ${result.length}/${count} valid questions`);return result;}
function pdfBuffer(title,questions,font){return new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:42,bufferPages:true}),chunks=[];doc.on('data',c=>chunks.push(c));doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));const W=doc.page.width-84;const header=()=>{doc.save();doc.fillColor('#173B6C').rect(0,0,doc.page.width,105).fill();doc.fillColor('#27A7A0').rect(0,101,doc.page.width,4).fill();doc.fillColor('#fff').font(font).fontSize(19).text(clean(title),42,38,{width:W,align:'center'});doc.fillColor('#DDEBFF').font(font).fontSize(9.5).text(`A/L ICT • MCQ Model Paper • ${questions.length} Questions`,42,76,{width:W,align:'center'});doc.restore();};const footer=n=>{doc.save();doc.strokeColor('#d8dee8').moveTo(42,doc.page.height-35).lineTo(doc.page.width-42,doc.page.height-35).stroke();doc.fillColor('#657184').font(font).fontSize(8).text('Super Agent',42,doc.page.height-27);doc.text(`Page ${n}`,doc.page.width-100,doc.page.height-27,{width:58,align:'right'});doc.restore();};const question=(q,i)=>{const y=doc.y;doc.save();doc.fillColor('#F5F8FC').roundedRect(42,y-5,W,20,7).fill();doc.restore();doc.font(font).fontSize(10.5).fillColor('#173B6C').text(`${i}.`,52,y+1,{continued:true});doc.font(font).fontSize(10.3).fillColor('#202938').text(` ${q.question}`,{width:W-30,lineGap:2});['A','B','C','D'].forEach((l,k)=>{const yy=doc.y+2;doc.save();doc.fillColor('#EAF2FF').roundedRect(52,yy,19,16,6).fill();doc.restore();doc.font(font).fontSize(8.7).fillColor('#173B6C').text(l,52,yy+3,{width:19,align:'center'});doc.font(font).fontSize(9.4).fillColor('#374151').text(q.options[k],80,yy,{width:W-38,lineGap:1});});doc.moveDown(.5);};doc.font(font);header();doc.y=125;questions.forEach((q,i)=>{if(doc.y>doc.page.height-105){doc.addPage();header();doc.y=125;}question(q,i+1);});doc.addPage();doc.font(font).fontSize(18).fillColor('#173B6C').text('පිළිතුරු පත්‍රය',{align:'center'});doc.font(font).fontSize(9).fillColor('#64748B').text('Answer Key',{align:'center'});doc.moveDown(1.2);const cw=W/4;questions.forEach((q,i)=>{const x=42+(i%4)*cw,y=150+Math.floor(i/4)*24;doc.save();doc.fillColor('#F5F8FC').roundedRect(x+2,y-2,cw-7,19,5).fill();doc.restore();doc.font(font).fontSize(9).fillColor('#173B6C').text(`${i+1}. ${q.answer}`,x+8,y+2,{width:cw-15});});const pages=doc.bufferedPageRange();for(let i=pages.start;i<pages.start+pages.count;i++){doc.switchToPage(i);footer(i+1);}doc.end();});}
async function sendPdf(buffer,filename,caption,chatId){const id=String(chatId||process.env.NIGHT_AGENT_CHAT_ID||'').trim();if(!id)throw new Error('Telegram chat ID is missing');if(!process.env.TELEGRAM_BOT_TOKEN)throw new Error('TELEGRAM_BOT_TOKEN is missing');if(!Buffer.isBuffer(buffer)||buffer.length<1000||buffer.subarray(0,4).toString()!=='%PDF')throw new Error('PDF validation failed before Telegram upload');const bot=new TelegramBot(process.env.TELEGRAM_BOT_TOKEN,{polling:false});const msg=await bot.sendDocument(id,buffer,{filename,contentType:'application/pdf'},{caption});if(!msg?.document?.file_id)throw new Error('Telegram did not return a document file_id');return{file_id:msg.document.file_id,message_id:msg.message_id,chat_id:id};}
const completed=new Map();const inflight=new Map();
async function generateDocument(args={}){const count=Math.max(1,Math.min(Number(args.count)||50,100)),topic=clean(args.topic||'Operating Systems'),language=clean(args.language||'Sinhala'),title=clean(args.title||`A/L ICT — ${topic} MCQ Model Paper`),chatId=args.chat_id||process.env.NIGHT_AGENT_CHAT_ID,key=JSON.stringify({count,topic,language,title,chatId:String(chatId||'')});if(completed.has(key))return{...completed.get(key),duplicate_call:true,terminal:true};if(inflight.has(key))return{...(await inflight.get(key)),duplicate_call:true,terminal:true};const work=(async()=>{const font=await getFont();const questions=await makeQuestions(topic,count,language);const pdf=await pdfBuffer(title,questions,font);if(!pdf||pdf.length<1000||pdf.subarray(0,4).toString()!=='%PDF')throw new Error('Generated PDF is empty or invalid');const filename=`AL_ICT_${topic.replace(/[^a-zA-Z0-9]+/g,'_')}_MCQ_${count}.pdf`;const delivery=await sendPdf(pdf,filename,`📄 ${title}\n${count} MCQ questions + answer key`,chatId);const result={created:true,question_count:questions.length,format:'pdf',designed:true,delivered:true,delivery_verified:true,terminal:true,file_name:filename,telegram_file_id:delivery.file_id,telegram_message_id:delivery.message_id,chat_id:delivery.chat_id};completed.set(key,result);return result;})();inflight.set(key,work);try{return await work;}finally{inflight.delete(key);}}
module.exports={generateDocument};