const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const PDFDocument = require('pdfkit');

// Never download fonts at runtime. Railway/container networking must not be a
// dependency of document generation. Fontsource is installed in package.json.
const FONT_CANDIDATES = [
  path.join(__dirname, 'node_modules/@fontsource/noto-sans-sinhala/files/noto-sans-sinhala-sinhala-400-normal.ttf'),
  path.join(__dirname, 'node_modules/@fontsource/noto-sans-sinhala/files/noto-sans-sinhala-devanagari-400-normal.ttf'),
  path.join(__dirname, 'node_modules/@fontsource/noto-sans-sinhala/noto-sans-sinhala-sinhala-400-normal.ttf'),
  path.join(__dirname, 'node_modules/@fontsource/noto-sans-sinhala/400.css')
];
function getFont() {
  const candidates = FONT_CANDIDATES.filter(p => p.endsWith('.ttf'));
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).size > 10000) return p;
  }
  // Last-resort deterministic discovery inside the installed package.
  const root = path.join(__dirname, 'node_modules/@fontsource/noto-sans-sinhala');
  if (fs.existsSync(root)) {
    const found = [];
    const walk = dir => { for (const name of fs.readdirSync(dir)) { const p=path.join(dir,name); const st=fs.statSync(p); if(st.isDirectory()) walk(p); else if(/\.ttf$/i.test(name) && st.size>10000) found.push(p); } };
    walk(root);
    const preferred = found.find(p => /sinhala.*400|400.*sinhala/i.test(p)) || found[0];
    if (preferred) return preferred;
  }
  throw new Error('Bundled Noto Sans Sinhala TTF is missing. Run npm install so @fontsource/noto-sans-sinhala is present.');
}

function clean(s) { return String(s ?? '').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim(); }
function jsonOnly(s) { return String(s || '').replace(/^```json\s*/i,'').replace(/```$/,'').trim(); }
function geminiKeys() { return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(x=>x.trim()).filter(Boolean); }
async function ask(prompt) {
  const keys = geminiKeys(); if (!keys.length) throw new Error('No Gemini API key configured for PDF content generation');
  let last;
  for (const key of keys) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(key)}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:.45,maxOutputTokens:8000}})});
      const d=await r.json(); if(!r.ok) throw new Error(d.error?.message || `Gemini HTTP ${r.status}`);
      return (d.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
    } catch(e) { last=e; }
  }
  throw last || new Error('Gemini request failed');
}
async function makeQuestions(topic,count,language) {
  const result=[]; const seen=new Set();
  for(let round=0; result.length<count && round<20; round++) {
    const need=Math.min(10,count-result.length); const existing=result.slice(-30).map(q=>q.question).join('\n');
    const raw=await ask(`Create exactly ${need} new high-quality Sri Lankan G.C.E. Advanced Level ICT multiple-choice questions about ${topic}. Language: ${language}. Return ONLY JSON {"questions":[{"question":"...","options":["...","...","...","..."],"answer":"A"}]}. Exactly four distinct options, answer A/B/C/D, exam-quality, no markdown, no duplicates. Existing questions to avoid:\n${existing || '(none)'}`);
    let data; try { data=JSON.parse(jsonOnly(raw)); } catch(_) { continue; }
    for(const q of data.questions || []) { const question=clean(q.question), options=Array.isArray(q.options)?q.options.map(clean):[], answer=String(q.answer||'').trim().toUpperCase(); const key=question.toLowerCase(); if(question&&options.length===4&&new Set(options.map(x=>x.toLowerCase())).size===4&&/^[ABCD]$/.test(answer)&&!seen.has(key)){seen.add(key);result.push({question,options,answer});} if(result.length>=count)break; }
  }
  if(result.length!==count) throw new Error(`Could only generate ${result.length}/${count} valid questions`); return result;
}
function pdfBuffer(title,questions,font){return new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:42,bufferPages:true});const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));const W=doc.page.width-84;const header=()=>{doc.save();doc.fillColor('#173B6C').rect(0,0,doc.page.width,105).fill();doc.fillColor('#27A7A0').rect(0,101,doc.page.width,4).fill();doc.fillColor('#fff').font(font).fontSize(19).text(title,42,38,{width:W,align:'center'});doc.fillColor('#DDEBFF').fontSize(9.5).text(`A/L ICT • MCQ Model Paper • ${questions.length} Questions`,42,76,{width:W,align:'center'});doc.restore();};const footer=n=>{doc.save();doc.strokeColor('#d8dee8').moveTo(42,doc.page.height-35).lineTo(doc.page.width-42,doc.page.height-35).stroke();doc.fillColor('#657184').font(font).fontSize(8).text('Super Agent',42,doc.page.height-27);doc.text(`Page ${n}`,doc.page.width-100,doc.page.height-27,{width:58,align:'right'});doc.restore();};const question=(q,i)=>{const y=doc.y;doc.save();doc.fillColor('#F5F8FC').roundedRect(42,y-5,W,20,7).fill();doc.restore();doc.font(font).fontSize(10.5).fillColor('#173B6C').text(`${i}.`,52,y+1,{continued:true});doc.font(font).fontSize(10.3).fillColor('#202938').text(` ${q.question}`,{width:W-30,lineGap:2});['A','B','C','D'].forEach((l,k)=>{const yy=doc.y+2;doc.save();doc.fillColor('#EAF2FF').roundedRect(52,yy,19,16,6).fill();doc.restore();doc.font(font).fontSize(8.7).fillColor('#173B6C').text(l,52,yy+3,{width:19,align:'center'});doc.font(font).fontSize(9.4).fillColor('#374151').text(q.options[k],80,yy,{width:W-38,lineGap:1});});doc.moveDown(.5);};doc.font(font);header();doc.y=125;questions.forEach((q,i)=>{if(doc.y>doc.page.height-105){doc.addPage();header();doc.y=125;}question(q,i+1);});doc.addPage();header();doc.y=130;doc.font(font).fontSize(18).fillColor('#173B6C').text('පිළිතුරු පත්‍රය',{align:'center'});doc.font(font).fontSize(9).fillColor('#64748B').text('Answer Key',{align:'center'});doc.moveDown(1.2);const cw=W/4;questions.forEach((q,i)=>{const x=42+(i%4)*cw,y=doc.y+(Math.floor(i/4))*24;doc.save();doc.fillColor('#F5F8FC').roundedRect(x+2,y-2,cw-7,19,5).fill();doc.restore();doc.font(font).fontSize(9).fillColor('#173B6C').text(`${i+1}. ${q.answer}`,x+8,y+2,{width:cw-15});});const pages=doc.bufferedPageRange();for(let i=pages.start;i<pages.start+pages.count;i++){doc.switchToPage(i);footer(i+1);}doc.end();});}
async function sendPdf(buffer,filename,caption,chatId){const id=String(chatId||process.env.NIGHT_AGENT_CHAT_ID||'').trim();if(!id)throw new Error('Telegram chat ID is missing');if(!process.env.TELEGRAM_BOT_TOKEN)throw new Error('TELEGRAM_BOT_TOKEN is missing');if(!Buffer.isBuffer(buffer)||buffer.length<1000||buffer.subarray(0,4).toString()!=='%PDF')throw new Error('PDF validation failed before Telegram upload');const bot=new TelegramBot(process.env.TELEGRAM_BOT_TOKEN,{polling:false});const msg=await bot.sendDocument(id,buffer,{filename,contentType:'application/pdf'},{caption});if(!msg?.document?.file_id)throw new Error('Telegram did not return a document file_id');return {file_id:msg.document.file_id,message_id:msg.message_id,chat_id:id};}
async function generateDocument(args={}){const count=Math.max(1,Math.min(Number(args.count)||50,100));const topic=clean(args.topic||'Operating Systems');const language=clean(args.language||'Sinhala');const title=clean(args.title||`A/L ICT — ${topic} MCQ Model Paper`);const font=getFont();const questions=await makeQuestions(topic,count,language);const pdf=await pdfBuffer(title,questions,font);const filename=`AL_ICT_${topic.replace(/[^a-zA-Z0-9]+/g,'_')}_MCQ_${count}.pdf`;const delivery=await sendPdf(pdf,filename,`📄 ${title}\n${count} MCQ questions + answer key`,args.chat_id);return {created:true,question_count:questions.length,format:'pdf',designed:true,delivered:true,delivery_verified:true,terminal:true,file_name:filename,telegram_file_id:delivery.file_id,telegram_message_id:delivery.message_id,chat_id:delivery.chat_id};}
module.exports={generateDocument};