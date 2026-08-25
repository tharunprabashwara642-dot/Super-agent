const fs=require('fs');
const path=require('path');
const file=path.join(__dirname,'index.js');
let s=fs.readFileSync(file,'utf8');

// Native document pipeline patch
const docMarker='async function runCustomTool(name, args) {\n';
const docInjection='async function runCustomTool(name, args) {\n  // Native document pipeline: generate_document must be deterministic, terminal, and delivered as a real Telegram file.\n  if (name === "generate_document") {\n    try { const { generateDocument } = require("./native_document_tool"); return await generateDocument(args || {}); }\n    catch (e) { return { error: true, terminal: true, message: `generate_document failed: ${e.message}` }; }\n  }\n';
if (!s.includes('Native document pipeline: generate_document')) {
  if (!s.includes(docMarker)) throw new Error('runCustomTool marker not found');
  s=s.replace(docMarker,docInjection);
  console.log('🧩 Native generate_document patch applied');
}

// ToolJet MCP integration patch
// ToolJet officially exposes an MCP server as @tooljet/mcp. The main agent
// already has a generic MCP loader, so we only need to add ToolJet as another
// stdio MCP server. It is enabled only when both credentials are configured.
const tooljetMarker='// TOOLJET_MCP_PATCH_V1';
if (!s.includes(tooljetMarker)) {
  const mcpMarker='const MCP_SERVER_CONFIGS = [';
  const tooljetConfig=`// TOOLJET_MCP_PATCH_V1
  {
    id: "tooljet",
    label: "ToolJet",
    enabled: !!process.env.TOOLJET_HOST && !!process.env.TOOLJET_ACCESS_TOKEN,
    command: "npx",
    args: ["-y", "@tooljet/mcp"],
    env: {
      TOOLJET_HOST: process.env.TOOLJET_HOST || "",
      TOOLJET_ACCESS_TOKEN: process.env.TOOLJET_ACCESS_TOKEN || "",
    },
  },
`;
  if (!s.includes(mcpMarker)) throw new Error('MCP_SERVER_CONFIGS marker not found');
  s=s.replace(mcpMarker,mcpMarker+'\n'+tooljetConfig);
  console.log('🔌 ToolJet MCP patch applied');
}

fs.writeFileSync(file,s);
