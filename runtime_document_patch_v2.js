const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'index.js');
let s = fs.readFileSync(file, 'utf8');
const marker = '// FIRST_CLASS_DOCUMENT_ROUTER_V2';
if (s.includes(marker)) process.exit(0);

// Keep document intent active across the whole tool-call conversation. After a
// tool failure, the last user message may be a functionResponse, so looking
// only at the last turn would accidentally re-expose custom tools and let the
// model fall back into the exact custom-tool loop this patch is meant to stop.
const oldIntent = `const lastUserText = [...(contents || [])].reverse().find((m) => m?.role === "user")?.parts?.map((p) => p?.text || "").join(" ") || "";\n  const documentIntent = /\\b(pdf|document|report|worksheet|model\\s*paper|question\\s*paper|mcq|notes|handout|certificate|invoice)\\b/i.test(lastUserText) || /\\b(පීඩීඑෆ්|pdf|වාර්තාව|ප්‍රශ්න පත්‍ර|මොඩල් පේපර්|සටහන්|ලේඛනය|සහතික)\\b/i.test(lastUserText);`;
const newIntent = `const allUserText = (contents || []).filter((m) => m?.role === "user").flatMap((m) => m?.parts || []).map((p) => p?.text || "").join(" ");\n  const lastUserText = [...(contents || [])].reverse().find((m) => m?.role === "user")?.parts?.map((p) => p?.text || "").join(" ") || "";\n  const documentIntent = /\\b(pdf|document|report|worksheet|model\\s*paper|question\\s*paper|mcq|notes|handout|certificate|invoice)\\b/i.test(allUserText) || /\\b(පීඩීඑෆ්|pdf|වාර්තාව|ප්‍රශ්න පත්‍ර|මොඩල් පේපර්|සටහන්|ලේඛනය|සහතික)\\b/i.test(allUserText);`;
if (!s.includes(oldIntent)) throw new Error('V1 document intent block not found');
s = s.replace(oldIntent, newIntent);

// Make the generic PDF tool clearly defer MCQ/model-paper requests to the
// specialized native MCQ renderer, which already guarantees exact question
// count and answer-key layout.
s = s.replace(
  'Use it for PDF/report/notes/worksheet/model-paper/document requests.',
  'Use it for general PDF/report/notes/worksheet/document requests. For an MCQ/model-paper request with numbered questions, prefer the specialized generate_mcq_pdf tool.'
);

// Strengthen the hard routing instruction with the specialized path.
s = s.replace(
  'Use the native generate_pdf_document tool when the user wants a PDF.',
  'Use generate_mcq_pdf for MCQ/model-paper PDFs; use generate_pdf_document for other PDFs/documents.'
);

s += `\n${marker}\n`;
fs.writeFileSync(file, s);
console.log('✅ Document routing V2 persistence patch applied');
