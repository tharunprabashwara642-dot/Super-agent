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

// Lazy skill routing
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

// Production execution guard
const guardMarker='// AGENT_RUNTIME_GUARD_V1';
if (!s.includes(guardMarker)) {
  const marker='async function runCustomTool(name, args) {';
  const replacement=`// AGENT_RUNTIME_GUARD_V1
const { createAgentRuntimeGuard } = require("./agent_runtime_guard");
const agentRuntimeGuard = createAgentRuntimeGuard();

async function runCustomTool(name, args) {
  return agentRuntimeGuard.run({ tool: name }, async () => {
    return await __runCustomToolImpl(name, args);
  });
}

async function __runCustomToolImpl(name, args) {`;
  if (s.includes(marker) && !s.includes('async function __runCustomToolImpl')) {
    s=s.replace(marker,replacement);
    console.log('🛡️ Agent execution guard applied');
  }
}

fs.writeFileSync(file,s);
