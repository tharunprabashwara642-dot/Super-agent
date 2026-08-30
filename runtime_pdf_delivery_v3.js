const fs = require('fs');
const path = require('path');
(function () {
  const file = path.join(__dirname, 'index.js');
  let s = fs.readFileSync(file, 'utf8');
  const marker = '// PDF_DELIVERY_AND_LIVE_V5_BROWSER';
  if (s.includes(marker)) return;

  // Prefer Puppeteer browser PDF (correct Sinhala shaping, fewer empty pages)
  const patterns = [
    'if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);',
    'if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });',
    'if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });',
  ];
  const target =
    'if (name === "generate_mcq_pdf") return await require("./native_document_tool_v3_browser").generateDocument({ ...(args || {}), chat_id: CHAT_ID });';
  for (const p of patterns) {
    if (s.includes(p)) s = s.split(p).join(target);
  }
  // Also catch any remaining native_document_tool_v2 MCQ routing
  s = s.replace(
    /require\(["']\.\/native_document_tool_v2["']\)\.generateDocument/g,
    'require("./native_document_tool_v3_browser").generateDocument'
  );
  s = s.replace(
    /require\(["']\.\/native_document_tool["']\)\.generateDocument/g,
    'require("./native_document_tool_v3_browser").generateDocument'
  );

  if (!s.includes(marker)) s += `\n${marker}\n`;
  fs.writeFileSync(file, s);
  console.log('PDF delivery V5: route generate_mcq_pdf → native_document_tool_v3_browser (Puppeteer)');
})();
