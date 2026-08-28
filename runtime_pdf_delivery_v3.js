const fs=require('fs');const path=require('path');
(function(){const file=path.join(__dirname,'index.js');let s=fs.readFileSync(file,'utf8');
const marker='// PDF_DELIVERY_AND_LIVE_V3';if(s.includes(marker))return;
// Always deliver artifacts to the exact chat configured as the bot's primary
// CHAT_ID. The LLM must never invent or omit the destination.
const oldPdf='if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);';
const newPdf='if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });';
if(!s.includes(oldPdf))throw new Error('generate_mcq_pdf execution line not found');s=s.replace(oldPdf,newPdf);

// Remove the per-tool spinner message from executeFunctionCall. handleChatMessage
// already owns one editable live message, so keeping both creates duplicate
// "Working/Completed" cards. Background autonomous execution still gets the
// same live_activity card through goalContext.
const start=s.indexOf('async function executeFunctionCall(fc, goalContext) {');
const end=s.indexOf('\n\n// ============================================================\n// GEMINI-SHAPE SHIM',start);
if(start<0||end<0)throw new Error('executeFunctionCall boundaries not found');
const replacement=`async function executeFunctionCall(fc, goalContext) {\n  const activity = goalContext ? (() => { try { return require('./live_activity'); } catch (_) { return null; } })() : null;\n  const label = HUMAN_TOOL_LABELS[fc?.name] || String(fc?.name || 'tool').replace(/_/g,' ');\n  try {\n    if (SENSITIVE_TOOLS.has(fc.name)) {\n      confirmationCounter++;\n      const id = String(confirmationCounter);\n      const description = describeAction(fc.name, fc.args);\n      const pcEntry = { id, toolName: fc.name, args: fc.args || {}, description, buttonsSent: false, goalId: goalContext?.goalId || null, stepId: goalContext?.stepId || null, goalTitle: goalContext?.title || null };\n      pendingConfirmations.push(pcEntry);\n      await persistPendingConfirmation(pcEntry);\n      if (activity) await activity.step('Waiting for your confirmation', 'waiting').catch(()=>{});\n      return { status:'pending_confirmation', note:'Confirmation is required before this sensitive action runs.' };\n    }\n    if (activity) await activity.step('Running: ' + label, 'running').catch(()=>{});\n    const result = await runToolDirectly(fc.name, { ...(fc.args || {}), ...(fc.name === 'generate_mcq_pdf' ? { chat_id: CHAT_ID } : {}) });\n    if (activity) await activity.step((result && result.error) ? ('Failed: ' + label) : ('Completed: ' + label), (result && result.error) ? 'error' : 'done').catch(()=>{});\n    return result;\n  } catch (e) {\n    console.error('Tool execution failed:', fc?.name, e);\n    if (activity) await activity.step('Failed: ' + label + ' — retrying/repairing', 'error').catch(()=>{});\n    return { error:true, message:e.message };\n  }\n}`;
s=s.slice(0,start)+replacement+s.slice(end);

// The old 35s check-in creates extra messages and defeats the single-live-card
// UX. The real editable status card already updates on every tool transition.
const timerBlock=/\n\s*const CHECKIN_INTERVAL_MS = parseInt\(process\.env\.AGENT_CHECKIN_INTERVAL_MS \|\| "35000", 10\);[\s\S]*?\n\s*let currentStepLabel = "starting";\n/;
s=s.replace(timerBlock,'\n    let checkinTimer = null;\n    let currentStepLabel = "starting";\n');
const intervalBlock=/\n\s*if \(!checkinTimer\) \{\n\s*checkinTimer = setInterval\(\(\) => \{[\s\S]*?\n\s*\}\n\s*currentStepLabel = functionCalls\.map\(\(fc\) => fc\.name\)\.join\(", "\);/;
s=s.replace(intervalBlock,'\n        currentStepLabel = functionCalls.map((fc) => fc.name).join(", ");');

// Do not allow a successful-looking final prose response after a failed PDF
// generation. The model must either successfully deliver the artifact or the
// user gets an honest failure and can retry.
const noCallMarker='          if (harnessTask) {\n            await recordAgentTaskEvent(harnessTask.id, "MODEL_FINAL_TEXT", { text: textReply });';
const guard=`          if (hasActionIntent(userText) && /\\b(pdf|mcq|model\\s*paper|document)\\b/i.test(userText) && turnHadArtifactFailure) {\n            if (harnessTask) await updateAgentTask(harnessTask.id, { status: "active", current_step: "artifact_failed" });\n            return "❌ PDF එක තාම සාර්ථකව generate/deliver වෙලා නැහැ. මම success කියලා බොරු කියන්නේ නැහැ.";\n          }\n\n          if (harnessTask) {\n            await recordAgentTaskEvent(harnessTask.id, "MODEL_FINAL_TEXT", { text: textReply });`;
if(s.includes(noCallMarker))s=s.replace(noCallMarker,guard);
// Declare the flag beside forcedActionRetry.
s=s.replace('    let forcedActionRetry = false;','    let forcedActionRetry = false;\n    let turnHadArtifactFailure = false;');
// Record PDF tool failure immediately after result is returned in the chat loop.
const resultLine='          const result = await executeFunctionCall(fc);';
const resultPatch=`          const result = await executeFunctionCall(fc);\n          if ((fc.name === "generate_mcq_pdf" || fc.name === "generate_document") && result && result.error) turnHadArtifactFailure = true;`;
s=s.replace(resultLine,resultPatch);

s+=`\n${marker}\n`;fs.writeFileSync(file,s);console.log('PDF delivery + single live activity V3 patch applied');})();
