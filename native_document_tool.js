const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_PACKAGE = path.dirname(require.resolve('@fontsource/noto-sans-sinhala/package.json'));
function findFont(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { const f = findFont(p); if (f) return f; }
    else if (/\.(ttf|otf|woff2?)$/i.test(name) && /sinhala/i.test(name)) return p;
  }
  return null;
}
const FONT_PATH = findFont(FONT_PACKAGE);
const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
function keys() { return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean); }
function cleanJson(s) { return String(s || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim(); }
async function gemini(prompt) {
  const pool = keys(); if (!pool.length) throw new Error('No Gemini API key configured');
  let last;
  for (const key of pool) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:7000}}) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error?.message || `Gemini HTTP ${r.status}`);
      return (d.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
    } catch (e) { last=e; }
  }
  throw last || new Error('Gemini request failed');
}
async function makeQuestions(topic, count, language) {
  const out=[]; const seen=new Set();
  for (let round=0; out.length<count && round<30; round++) {
    const need=Math.min(8,count-out.length);
    const existing=out.slice(-20).map(q=>q.question).join('\n');
    const raw=await gemini(`Create EXACTLY ${need} NEW high-quality multiple-choice questions for ${topic}. Language: ${language}. Return ONLY valid JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":"A"}]}. Exactly 4 distinct options. answer is A/B/C/D. Do not repeat existing questions. Existing:\n${existing || '(none)'}`);
    let parsed; try { parsed=JSON.parse(cleanJson(raw)); } catch (_) { continue; }
    for (const q of (parsed.questions||[])) {
      const text=String(q.question||'').trim(); const options=Array.isArray(q.options)?q.options.map(x=>String(x||'').trim()):[]; const answer=String(q.answer||'').trim().toUpperCase();
      const k=text.toLowerCase().replace(/\s+/g,' ');
      if(text && options.length===4 && new Set(options.map(x=>x.toLowerCase())).size===4 && /^[ABCD]$/.test(answer) && !seen.has(k)) { seen.add(k); out.push({question:text,options,answer}); }
      if(out.length>=count) break;
    }
  }
  if(out.length!==count) throw new Error(`Could only create ${out.length}/${count} valid questions`);
  return out;
}
function makePdf(title, questions) {
  return new Promise((resolve,reject)=>{
    if (!FONT_PATH) return reject(new Error('Noto Sans Sinhala font not found in installed font package'));
    const doc=new PDFDocument({size:'A4',margin:48}); const chunks=[];
    doc.font(FONT_PATH); doc.on('data',c=>chunks.push(c)); doc.on('error',reject); doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.fontSize(18).text(title,{align:'center'}); doc.moveDown(.5); doc.fontSize(10).text(`ප්‍රශ්න ගණන: ${questions.length}`,{align:'center'}); doc.moveDown();
    questions.forEach((q,i)=>{ doc.fontSize(11).text(`${i+1}. ${q.question}`,{paragraphGap:4}); q.options.forEach((o,j)=>doc.fontSize(10.5).text(`${String.fromCharCode(65+j)}. ${o}`,{indent:14})); doc.moveDown(.5); });
    doc.addPage(); doc.fontSize(15).text('පිළිතුරු පත්‍රය',{align:'center'}); doc.moveDown(); questions.forEach((q,i)=>doc.fontSize(10.5).text(`${i+1}. ${q.answer}`)); doc.end();
  });
}
async function sendTelegram(buffer, filename, caption) {
  const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.NIGHT_AGENT_CHAT_ID; if(!token||!chatId) throw new Error('Telegram credentials are not configured');
  const fd=new FormData(); fd.append('chat_id',chatId); fd.append('caption',caption); fd.append('document',new Blob([buffer],{type:'application/pdf'}),filename);
  const r=await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:fd}); const d=await r.json(); if(!r.ok||!d.ok) throw new Error(d.description||`Telegram HTTP ${r.status}`); return d.result?.document?.file_id||null;
}
const completed=new Map();
async function generateDocument(args={}) {
  const count=Math.max(1,Math.min(Number(args.count)||50,100)); const topic=String(args.topic||'A/L ICT').trim(); const language=String(args.language||'Sinhala').trim(); const title=String(args.title||`${topic} MCQ Model Paper`).trim();
  const key=JSON.stringify({count,topic,language,title}); if(completed.has(key)) return {...completed.get(key),duplicate_call:true,terminal:true};
  const questions=await makeQuestions(topic,count,language); if(questions.length!==count) throw new Error(`Validation failed: ${questions.length}/${count}`);
  const pdf=await makePdf(title,questions); const filename=`${title.replace(/[^a-zA-Z0-9_-]+/g,'_')}_${count}.pdf`; const fileId=await sendTelegram(pdf,filename,`📄 ${title}\nප්‍රශ්න ${count}ක් සහිත PDF එක සාර්ථකව attach කළා.`);
  const result={created:true,delivered:true,terminal:true,question_count:questions.length,file_name:filename,telegram_file_id:fileId}; completed.set(key,result); return result;
}
module.exports={generateDocument};
