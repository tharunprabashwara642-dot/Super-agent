const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'index.js');
let s = fs.readFileSync(file, 'utf8');

const marker = '// FIRST_CLASS_DOCUMENT_ROUTER_V1';
if (s.includes(marker)) {
  console.log('📄 First-class document router patch already present');
  process.exit(0);
}

const toolMarker = '      {\n        name: "generate_mcq_pdf",';
const toolInjection = `      {\n        name: "generate_pdf_document",\n        description: "Create a polished A4 PDF from the user's actual request and DELIVER the finished PDF directly to the user's Telegram chat. This is a native artifact tool. Use it for PDF/report/notes/worksheet/model-paper/document requests. NEVER create a custom tool for a normal PDF request when this tool applies. Understand the user's requested language, content, count, title and visual style; then generate, render and verify the final PDF before returning.",\n        parameters: {\n          type: "OBJECT",\n          properties: {\n            request: { type: "STRING", description: "The user's complete document request, preserving requested topic, language, count, layout and style." },\n            style: { type: "STRING", description: "Requested visual style, e.g. professional, exam paper, dark, green, purple. Defaults to professional." },\n          },\n          required: ["request"],\n        },\n      },\n${toolMarker}`;
if (!s.includes(toolMarker)) throw new Error('generate_mcq_pdf declaration marker not found');
s = s.replace(toolMarker, toolInjection);

const runMarker = '  if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);';
const runInjection = `  // FIRST_CLASS_DOCUMENT_ROUTER_V1\n  if (name === "generate_pdf_document") {\n    try {\n      const { generatePdfDocument } = require("./native_document_router");\n      return await generatePdfDocument(args || {});\n    } catch (e) {\n      return { error: true, terminal: true, message: e.message };\n    }\n  }\n${runMarker}`;
if (!s.includes(runMarker)) throw new Error('generate_mcq_pdf execution marker not found');
s = s.replace(runMarker, runInjection);

const callMarker = 'async function callBrain(contents, systemInstruction) {';
const callReplacement = `async function callBrain(contents, systemInstruction) {\n  const lastUserText = [...(contents || [])].reverse().find((m) => m?.role === "user")?.parts?.map((p) => p?.text || "").join(" ") || "";\n  const documentIntent = /\\b(pdf|document|report|worksheet|model\\s*paper|question\\s*paper|mcq|notes|handout|certificate|invoice)\\b/i.test(lastUserText) || /\\b(පීඩීඑෆ්|pdf|වාර්තාව|ප්‍රශ්න පත්‍ර|මොඩල් පේපර්|සටහන්|ලේඛනය|සහතික)\\b/i.test(lastUserText);\n  const explicitToolBuild = /\\b(make|create|build|write|add|හද|හදා|හදලා)\\b.{0,40}\\b(custom\\s*tool|tool)\\b/i.test(lastUserText);\n  const baseDeclarations = CHAT_TOOLS[0].functionDeclarations;\n  const safeDeclarations = documentIntent && !explicitToolBuild\n    ? baseDeclarations.filter((d) => !["add_custom_tool", "delete_custom_tool", "add_mcp_connector", "remove_mcp_connector", "edit_own_code", "insert_own_code", "update_own_code", "run_shell_command"].includes(d.name))\n    : baseDeclarations;\n  const documentInstruction = documentIntent && !explicitToolBuild\n    ? `\\n\\nDOCUMENT ROUTING RULES (HARD): This is a document/PDF request. Use the native generate_pdf_document tool when the user wants a PDF. Do NOT create a custom tool, do NOT ask for confirmation to create a tool, and do NOT expose internal tool/runtime errors. The native tool generates, designs, verifies and delivers the finished PDF directly. If it fails, diagnose/retry the document operation once with corrected arguments; do not invent a replacement tool.`\n    : "";\n  const customDeclarations = documentIntent && !explicitToolBuild ? [] : customToolDeclarations;\n  const combinedTools = (mcpToolDeclarations.length > 0 || customDeclarations.length > 0)\n    ? [{ functionDeclarations: [...safeDeclarations, ...mcpToolDeclarations, ...customDeclarations] }]\n    : [{ functionDeclarations: safeDeclarations }];\n  const finalInstruction = `${systemInstruction || ""}${documentInstruction}`;\n  const data = await nvidiaChatShimmed(contents, finalInstruction, combinedTools);\n  if (data.error) console.error("LLM API error:", JSON.stringify(data));\n  return data;\n}`;
if (!s.includes(callMarker)) throw new Error('callBrain marker not found');
const callStart = s.indexOf(callMarker);
const callEndMarker = '\n\nasync function fetchRecentConversation';
const callEnd = s.indexOf(callEndMarker, callStart);
if (callEnd === -1) throw new Error('callBrain end marker not found');
s = s.slice(0, callStart) + callReplacement + s.slice(callEnd);

const execStart = s.indexOf('async function executeFunctionCall(fc, goalContext) {');
const execEnd = s.indexOf('\n\n// ============================================================\n// GEMINI-SHAPE SHIM', execStart);
if (execStart === -1 || execEnd === -1) throw new Error('executeFunctionCall boundaries not found');
const newExec = `async function executeFunctionCall(fc, goalContext) {\n  try {\n    if (SENSITIVE_TOOLS.has(fc.name)) {\n      confirmationCounter++;\n      const id = String(confirmationCounter);\n      const description = describeAction(fc.name, fc.args);\n      const pcEntry = {\n        id, toolName: fc.name, args: fc.args || {}, description, buttonsSent: false,\n        goalId: goalContext?.goalId || null, stepId: goalContext?.stepId || null, goalTitle: goalContext?.title || null,\n      };\n      pendingConfirmations.push(pcEntry);\n      await persistPendingConfirmation(pcEntry);\n      return { status: "pending_confirmation", note: "Confirmation is required before this sensitive action runs." };\n    }\n    return await runToolDirectly(fc.name, fc.args);\n  } catch (e) {\n    console.error(`Tool execution failed: ${fc?.name}:`, e);\n    return { error: true, message: e.message };\n  }\n}`;
s = s.slice(0, execStart) + newExec + s.slice(execEnd);

const labelsMarker = 'const HUMAN_TOOL_LABELS = {';
if (!s.includes(labelsMarker)) throw new Error('HUMAN_TOOL_LABELS marker not found');
s = s.replace(labelsMarker, `${labelsMarker}\n  generate_pdf_document: "PDF එක design කරලා හදනවා",\n  generate_mcq_pdf: "MCQ PDF එක design කරලා හදනවා",`);

const terminalMarker = '        contents.push({ role: "user", parts: responseParts });';
const terminalCheck = `${terminalMarker}\n\n        const terminalArtifact = functionCalls.some((fc, idx) => fc.name === "generate_pdf_document" && responseParts[idx]?.functionResponse?.response?.result?.terminal === true && responseParts[idx]?.functionResponse?.response?.result?.delivered === true);\n        if (terminalArtifact) {\n          if (harnessTask) await completeAgentTask(harnessTask.id, "completed");\n          return "📎 PDF එක හදලා ඉවරයි — file එක chat එකට attach කළා.";\n        }`;
if (!s.includes(terminalMarker)) throw new Error('chat responseParts marker not found');
s = s.replace(terminalMarker, terminalCheck);

s += `\n${marker}\n`;
fs.writeFileSync(file, s);
console.log('✅ First-class document routing + quiet tool execution patch applied');
