const fs=require('fs');const path=require('path');
(function(){
  const file=path.join(__dirname,'index.js');
  let s=fs.readFileSync(file,'utf8');
  const marker='// PDF_DELIVERY_AND_LIVE_V4';
  if(s.includes(marker)) return;

  // -----------------------------------------------------------------------
  // 1) PDF delivery must use the real native document implementation.
  // -----------------------------------------------------------------------
  const oldPdf='if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);';
  const newPdf='if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });';
  if(s.includes(oldPdf)) s=s.replace(oldPdf,newPdf);

  // -----------------------------------------------------------------------
  // 2) The previous live_activity patch was disconnected from direct chat:
  // executeFunctionCall(fc) was called without goalContext, so its activity
  // object was null. The direct-chat status renderer owns the one Telegram
  // card. Give deeper tools a bridge into THAT SAME card instead of creating
  // another message.
  // -----------------------------------------------------------------------
  const execStart=s.indexOf('async function executeFunctionCall(fc, goalContext) {');
  const execEnd=s.indexOf('\n\n// ============================================================\n// GEMINI-SHAPE SHIM',execStart);
  if(execStart>=0 && execEnd>=0){
    const replacement=`async function executeFunctionCall(fc, goalContext) {
  try {
    if (SENSITIVE_TOOLS.has(fc.name)) {
      confirmationCounter++;
      const id = String(confirmationCounter);
      const description = describeAction(fc.name, fc.args);
      const pcEntry = { id, toolName: fc.name, args: fc.args || {}, description, buttonsSent: false,
        goalId: goalContext?.goalId || null, stepId: goalContext?.stepId || null, goalTitle: goalContext?.title || null };
      pendingConfirmations.push(pcEntry);
      await persistPendingConfirmation(pcEntry);
      if (global.__nightAgentLiveBridge) await global.__nightAgentLiveBridge.step('Waiting for your confirmation', 'waiting').catch(()=>{});
      return { status:'pending_confirmation', note:'Confirmation is required before this sensitive action runs.' };
    }

    const label = HUMAN_TOOL_LABELS[fc?.name] || String(fc?.name || 'tool').replace(/_/g,' ');
    if (global.__nightAgentLiveBridge) await global.__nightAgentLiveBridge.step('Running: ' + label, 'running').catch(()=>{});

    const result = await runToolDirectly(fc.name, { ...(fc.args || {}), ...(fc.name === 'generate_mcq_pdf' ? { chat_id: CHAT_ID } : {}) });

    if (global.__nightAgentLiveBridge) {
      const failed = result && (result.error === true || result.deployed === false || result.saved === false || result.sent === false || result.created === false || result.updated === false || result.deleted === false || result.final_status === 'FAILED' || result.final_status === 'CRASHED');
      await global.__nightAgentLiveBridge.step((failed ? 'Failed: ' : 'Completed: ') + label, failed ? 'error' : 'done').catch(()=>{});
    }
    return result;
  } catch (e) {
    console.error('Tool execution failed:', fc?.name, e);
    if (global.__nightAgentLiveBridge) await global.__nightAgentLiveBridge.step('Failed: ' + (HUMAN_TOOL_LABELS[fc?.name] || fc?.name || 'tool'), 'error').catch(()=>{});
    return { error:true, message:e.message };
  }
}`;
    s=s.slice(0,execStart)+replacement+s.slice(execEnd);
  }

  // -----------------------------------------------------------------------
  // 3) Replace the old 35-second "Still working" extra-message mechanism.
  // The user wants ONE edited message. A ticker updates that same message
  // every 2.2s. Telegram's own FAQ recommends avoiding >1 message/sec/chat;
  // 2.2s keeps us comfortably below that while still feeling live.
  // -----------------------------------------------------------------------
  const checkinDecl='    const CHECKIN_INTERVAL_MS = parseInt(process.env.AGENT_CHECKIN_INTERVAL_MS || "35000", 10);';
  s=s.replace(checkinDecl,'    const CHECKIN_INTERVAL_MS = 0; // replaced by the single live-card ticker below');
  const timerStart='    let checkinTimer = null;\n    let currentStepLabel = "starting";';
  if(s.includes(timerStart)) s=s.replace(timerStart,'    let checkinTimer = null;\n    let currentStepLabel = "starting";\n    let liveTicker = null;\n    const liveStartedAt = Date.now();\n    let liveFrame = 0;\n    const LIVE_SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];');

  // Add elapsed time + spinner to the existing renderStatus function.
  const oldHeader='      const header = statusDone ? `✅ වැඩේ ඉවරයි!` : `⚙️ මන් දැන් වැඩේ කරගෙන යනවා බොස්...`;';
  const newHeader='      const elapsed = Math.max(0, Math.floor((Date.now() - liveStartedAt) / 1000));\n      const mm = String(Math.floor(elapsed / 60)).padStart(2,"0");\n      const ss = String(elapsed % 60).padStart(2,"0");\n      const spin = LIVE_SPINNER[liveFrame % LIVE_SPINNER.length];\n      const header = statusDone ? `✅ වැඩේ ඉවරයි!  ${mm}:${ss}` : `${spin} වැඩේ කරගෙන යනවා  ${mm}:${ss}`;';
  if(s.includes(oldHeader)) s=s.replace(oldHeader,newHeader);

  // After renderStatus(), expose a bridge for deep tools such as PDFKit.
  const bridgeMarker='    const MAX_TOOL_ROUNDS = 10;';
  const bridgeCode=`    // One-card bridge: native document generation and other deep tools
    // report their REAL internal phases into this same Telegram message.
    global.__nightAgentLiveBridge = {
      step: async (label, state='running') => {
        const icon = state === 'done' ? '▫️' : state === 'error' ? '⚠️' : state === 'waiting' ? '⏸️' : LIVE_SPINNER[liveFrame % LIVE_SPINNER.length];
        const existing = statusLines.findIndex(x => String(x).includes(String(label)) && /പටන් ගත්තා|running|කරගෙන|.../.test(String(x)));
        if (existing >= 0 && state !== 'running') statusLines[existing] = `${icon} ${label} — ${state === 'done' ? 'හරි ගියා' : state === 'error' ? 'අවුලක් ආවා' : 'waiting'}`;
        else statusLines.push(`${icon} ${label}${state === 'running' ? '...' : state === 'waiting' ? ' — confirm එකක් ඕනේ' : state === 'done' ? ' — හරි ගියා' : ' — අවුලක් ආවා'}`);
        await renderStatus();
      },
      setTitle: async (title) => { statusLines.push(`▫️ ${String(title)}`); await renderStatus(); },
    };
    liveTicker = setInterval(() => { liveFrame++; renderStatus().catch(()=>{}); }, 2200);

`;
  if(s.includes(bridgeMarker) && !s.includes('global.__nightAgentLiveBridge = {')) s=s.replace(bridgeMarker,bridgeCode+bridgeMarker);

  // Stop the old extra check-in timer creation block entirely.
  const oldCheckinBlock=`        if (!checkinTimer) {
          checkinTimer = setInterval(() => {
            bot.sendMessage(CHAT_ID, \`🔄 Still working on this — now doing: \${currentStepLabel}\`)
              .catch((e) => console.error("progress check-in send failed:", e.message));
          }, CHECKIN_INTERVAL_MS);
        }
        currentStepLabel = functionCalls.map((fc) => fc.name).join(", ");`;
  const newCheckinBlock=`        currentStepLabel = functionCalls.map((fc) => fc.name).join(", ");`;
  if(s.includes(oldCheckinBlock)) s=s.replace(oldCheckinBlock,newCheckinBlock);

  // In the direct chat loop, executeFunctionCall now owns the tool-level
  // activity updates. Keep the outer narrative line only for the top-level
  // tool lifecycle so the message stays readable rather than duplicated.
  // No extra action required here: bridge events are inserted between the
  // existing start/done lines.

  // Clean the global bridge/ticker on every exit path.
  const finallyMarker='      if (checkinTimer) clearInterval(checkinTimer);';
  if(s.includes(finallyMarker)) s=s.replace(finallyMarker,'      if (checkinTimer) clearInterval(checkinTimer);\n      if (liveTicker) clearInterval(liveTicker);\n      if (global.__nightAgentLiveBridge) delete global.__nightAgentLiveBridge;');

  // -----------------------------------------------------------------------
  // 4) Give generate_mcq_pdf a REAL design argument. The model must derive
  // it from the COMPLETE user request instead of a fixed first-paragraph
  // template. This is a semantic requirement in the tool schema, not a
  // hard-coded visual template.
  // -----------------------------------------------------------------------
  const oldDecl='            title: { type: "STRING", description: "Title for the PDF. Defaults to \\\"<topic> MCQ Model Paper\\\"." },';
  const newDecl='            title: { type: "STRING", description: "Title for the PDF. Defaults to \\\"<topic> MCQ Model Paper\\\"." },\n            design: { type: "STRING", description: "FREE-FORM design/layout brief extracted from the USER\'S ENTIRE MESSAGE. Preserve all requested visual requirements: page size, density, colors, typography, header, spacing, answer-key layout, compactness, and any request to avoid blank/wasted pages. Never replace this with a fixed template name." },';
  if(s.includes(oldDecl)) s=s.replace(oldDecl,newDecl);

  // -----------------------------------------------------------------------
  // 5) Patch runToolDirectly so the design brief actually reaches the native
  // renderer, not merely the Gemini tool schema.
  // -----------------------------------------------------------------------
  const oldRun='  if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);';
  const newRun='  if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });';
  if(s.includes(oldRun)) s=s.replace(oldRun,newRun);

  // -----------------------------------------------------------------------
  // 6) Repair the known Sinhala-font 404 in native_document_tool_v2 at boot.
  // The Railway log explicitly showed "Font download HTTP 404" from that
  // file. Use the stable GitHub raw asset rather than the old google-webfonts
  // URL that was returning 404.
  // -----------------------------------------------------------------------
  const docFile=path.join(__dirname,'native_document_tool_v2.js');
  if(fs.existsSync(docFile)){
    let d=fs.readFileSync(docFile,'utf8');
    d=d.replace(/https:\\/\\/fonts\.googleapis\.com\\/sinhala[^"']+/g,'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansSinhala/NotoSansSinhala-Regular.ttf');
    d=d.replace(/https:\\/\\/raw\.githubusercontent\.com\\/notofonts\\/noto-fonts\\/main\\/hinted\\/ttf\\/NotoSansSinhala\\/NotoSansSinhala-Regular\.ttf/g,'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansSinhala/NotoSansSinhala-Regular.ttf');
    fs.writeFileSync(docFile,d,'utf8');
  }

  // -----------------------------------------------------------------------
  // 7) Native renderer progress hook. It is deliberately a global callback
  // because the existing native tool API is used from several paths. This
  // lets the PDF generator report actual phases without creating a second
  // Telegram message.
  // -----------------------------------------------------------------------
  if(fs.existsSync(docFile)){
    let d=fs.readFileSync(docFile,'utf8');
    if(!d.includes('__nightAgentPdfProgress')){
      const inject='\nfunction __nightAgentPdfProgress(label,state="running"){ try { return global.__nightAgentLiveBridge?.step(String(label),state); } catch(_) { return Promise.resolve(); } }\n';
      const anchor='const PDFDocument = require("pdfkit");';
      if(d.includes(anchor)) d=d.replace(anchor,anchor+inject);
      // Best-effort phase instrumentation around stable function names.
      d=d.replace(/async function generateDocument\(args=\{\}\)\{/,'async function generateDocument(args={}){\n  await __nightAgentPdfProgress("PDF request එක prepare කරනවා");');
      d=d.replace(/async function getSinhalaFont\(\)\{/,'async function getSinhalaFont(){\n  await __nightAgentPdfProgress("Sinhala font එක load කරනවා");');
      d=d.replace(/async function generateQuestions\(/,'async function generateQuestions(\n');
      // If the exact question function is one-line/renamed, the renderer
      // still gets the critical phases below through generateDocument.
      d=d.replace(/const questions = await generateQuestions\(/,'await __nightAgentPdfProgress("MCQ ප්‍රශ්න generate කරනවා");\n  const questions = await generateQuestions(');
      d=d.replace(/const pdfBuffer = await createPdf\(/,'await __nightAgentPdfProgress("PDF layout/design render කරනවා");\n  const pdfBuffer = await createPdf(');
      d=d.replace(/await bot\.sendDocument\(/,'await __nightAgentPdfProgress("Telegram document upload කරනවා");\n    const __deliveryResult = await bot.sendDocument(');
      d=d.replace(/return \{[^\n]*delivered:\s*true/,'await __nightAgentPdfProgress("Telegram delivery confirm උනා","done");\n    return { delivered: true');
      fs.writeFileSync(docFile,d,'utf8');
    }
  }

  // Never leave the patch marker absent: boot_patch_safe runs this once.
  s += `\n${marker}\n`;
  fs.writeFileSync(file,s);
  console.log('PDF delivery + single live activity V4 patch applied');
})();
