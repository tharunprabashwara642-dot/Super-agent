const fs=require('fs');
const path=require('path');
const file=path.join(__dirname,'index.js');
let s=fs.readFileSync(file,'utf8');
const marker='async function runCustomTool(name, args) {\n';
const injection='async function runCustomTool(name, args) {\n  // Native document pipeline: generate_document must be deterministic, terminal, and delivered as a real Telegram file.\n  if (name === "generate_document") {\n    try { const { generateDocument } = require("./native_document_tool"); return await generateDocument(args || {}); }\n    catch (e) { return { error: true, terminal: true, message: `generate_document failed: ${e.message}` }; }\n  }\n';
if (!s.includes('Native document pipeline: generate_document')) {
  if (!s.includes(marker)) throw new Error('runCustomTool marker not found');
  s=s.replace(marker,injection);
  fs.writeFileSync(file,s);
  console.log('🧩 Native generate_document patch applied');
} else console.log('🧩 Native generate_document patch already present');
