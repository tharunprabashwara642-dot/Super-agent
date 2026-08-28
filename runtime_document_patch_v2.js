const fs = require('fs');
const path = require('path');

(function applyDocumentPatchV2() {
  const file = path.join(__dirname, 'index.js');
  let s = fs.readFileSync(file, 'utf8');
  const marker = '// FIRST_CLASS_DOCUMENT_ROUTER_V2';
  if (s.includes(marker)) return;

  const oldIntent = `const lastUserText = [...(contents || [])].reverse().find((m) => m?.role === "user")?.parts?.map((p) => p?.text || "").join(" ") || "";\n  const documentIntent = /\\b(pdf|document|report|worksheet|model\\s*paper|question\\s*paper|mcq|notes|handout|certificate|invoice)\\b/i.test(lastUserText) || /\\b(පීඩීඑෆ්|pdf|වාර්තාව|ප්‍රශ්න පත්‍ර|මොඩල් පේපර්|සටහන්|ලේඛනය|සහතික)\\b/i.test(lastUserText);`;
  const newIntent = `const allUserText = (contents || []).filter((m) => m?.role === "user").flatMap((m) => m?.parts || []).map((p) => p?.text || "").join(" ");\n  const lastUserText = [...(contents || [])].reverse().find((m) => m?.role === "user")?.parts?.map((p) => p?.text || "").join(" ") || "";\n  const documentIntent = /\\b(pdf|document|report|worksheet|model\\s*paper|question\\s*paper|mcq|notes|handout|certificate|invoice)\\b/i.test(allUserText) || /\\b(පීඩීඑෆ්|pdf|වාර්තාව|ප්‍රශ්න පත්‍ර|මොඩල් පේපර්|සටහන්|ලේඛනය|සහතික)\\b/i.test(allUserText);`;
  if (!s.includes(oldIntent)) throw new Error('V1 document intent block not found');
  s = s.replace(oldIntent, newIntent);

  s = s.replace(
    'Use it for PDF/report/notes/worksheet/model-paper/document requests.',
    'Use it for general PDF/report/notes/worksheet/document requests. For an MCQ/model-paper request with numbered questions, prefer the specialized generate_mcq_pdf tool.'
  );
  s = s.replace(
    'Use the native generate_pdf_document tool when the user wants a PDF.',
    'Use generate_mcq_pdf for MCQ/model-paper PDFs; use generate_pdf_document for other PDFs/documents.'
  );

  const oldTerminal = 'const terminalArtifact = functionCalls.some((fc, idx) => fc.name === "generate_pdf_document" && responseParts[idx]?.functionResponse?.response?.result?.terminal === true && responseParts[idx]?.functionResponse?.response?.result?.delivered === true);';
  const newTerminal = 'const terminalArtifact = functionCalls.some((fc, idx) => (fc.name === "generate_pdf_document" || fc.name === "generate_mcq_pdf") && responseParts[idx]?.functionResponse?.response?.result?.terminal === true && responseParts[idx]?.functionResponse?.response?.result?.delivered === true);';
  if (!s.includes(oldTerminal)) throw new Error('V1 terminal artifact check not found');
  s = s.replace(oldTerminal, newTerminal);

  s += `\n${marker}\n`;
  fs.writeFileSync(file, s);
  console.log('✅ Document routing V2 persistence patch applied');
})();
