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

// Local skill runtime patch
// Skills are loaded lazily from ./skills/*/SKILL.md. Only skills whose
// keywords match the current user/task text are injected into the model
// context. This keeps prompts small and prevents unrelated skills from
// confusing the agent. The patch is intentionally placed at the single
// nvidiaChatShimmed gateway so normal chat and autonomous goal steps both
// receive the same skill routing.
const skillMarker='// SKILL_RUNTIME_PATCH_V1';
if (!s.includes(skillMarker)) {
  const brainMarker='async function nvidiaChatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs) {';
  const brainReplacement=`// SKILL_RUNTIME_PATCH_V1
const skillRuntime = require("./skill_runtime");

async function nvidiaChatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs) {
  const enrichedSystemInstruction = skillRuntime.augmentSystemInstruction(systemInstruction, contents);`;
  if (!s.includes(brainMarker)) throw new Error('nvidiaChatShimmed marker not found');
  s=s.replace(brainMarker,brainReplacement);
  const oldCall='return brain.chatShimmed(contents, systemInstruction, tools, modelOverride, timeoutMs);';
  const newCall='return brain.chatShimmed(contents, enrichedSystemInstruction, tools, modelOverride, timeoutMs);';
  if (!s.includes(oldCall)) throw new Error('brain.chatShimmed call marker not found');
  s=s.replace(oldCall,newCall);
  console.log('🧠 Lazy skill routing patch applied');
}

fs.writeFileSync(file,s);
