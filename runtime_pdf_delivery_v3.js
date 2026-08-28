const fs=require('fs');const path=require('path');
(function(){
  const file=path.join(__dirname,'index.js');
  let s=fs.readFileSync(file,'utf8');
  const marker='// PDF_DELIVERY_AND_LIVE_V4';
  if(s.includes(marker)) return;

  const oldPdf='if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);';
  const newPdf='if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });';
  if(s.includes(oldPdf)) s=s.replace(oldPdf,newPdf);

  const execStart=s.indexOf('async function executeFunctionCall(fc, goalContext) {');
  const execEnd=s.indexOf('\n\n// ============================================================\n// GEMINI-SHAPE SHIM',execStart);
  if(execStart>=0&&execEnd>=0){
    const replacement=`async function executeFunctionCall(fc, goalContext) {
  try {
    if (SENSITIVE_TOOLS.has(fc.name)) {
      confirmationCounter++;
      const id=String(confirmationCounter);
      const description=describeAction(fc.name,fc.args);
      const pcEntry={id,toolName:fc.name,args:fc.args||{},description,buttonsSent:false,goalId:goalContext?.goalId||null,stepId:goalContext?.stepId||null,goalTitle:goalContext?.title||null};
      pendingConfirmations.push(pcEntry); await persistPendingConfirmation(pcEntry);
      if(global.__nightAgentLiveBridge) await global.__nightAgentLiveBridge.step('Waiting for your confirmation','waiting').catch(()=>{});
      return{status:'pending_confirmation',note:'Confirmation is required before this sensitive action runs.'};
    }
    const label=HUMAN_TOOL_LABELS[fc?.name]||String(fc?.name||'tool').replace(/_/g,' ');
    if(global.__nightAgentLiveBridge) await global.__nightAgentLiveBridge.step('Running: '+label,'running').catch(()=>{});
    const result=await runToolDirectly(fc.name,{...(fc.args||{}),...(fc.name==='generate_mcq_pdf'?{chat_id:CHAT_ID}:{})});
    const failed=!!(result&&(result.error===true||result.deployed===false||result.saved===false||result.sent===false||result.created===false||result.updated===false||result.deleted===false||result.final_status==='FAILED'||result.final_status==='CRASHED'));
    if(global.__nightAgentLiveBridge) await global.__nightAgentLiveBridge.step((failed?'Failed: ':'Completed: ')+label,failed?'error':'done').catch(()=>{});
    return result;
  }catch(e){console.error('Tool execution failed:',fc?.name,e);if(global.__nightAgentLiveBridge)await global.__nightAgentLiveBridge.step('Failed: '+(HUMAN_TOOL_LABELS[fc?.name]||fc?.name||'tool'),'error').catch(()=>{});return{error:true,message:e.message};}
}`;
    s=s.slice(0,execStart)+replacement+s.slice(execEnd);
  }

  s=s.replace(/\s*const CHECKIN_INTERVAL_MS = parseInt\(process\.env\.AGENT_CHECKIN_INTERVAL_MS \|\| "35000", 10\);/,'    const CHECKIN_INTERVAL_MS = 0;');
  const timerStart='    let checkinTimer = null;\n    let currentStepLabel = "starting";';
  if(s.includes(timerStart))s=s.replace(timerStart,'    let checkinTimer = null;\n    let currentStepLabel = "starting";\n    let liveTicker=null;\n    const liveStartedAt=Date.now();\n    let liveFrame=0;\n    const LIVE_SPINNER=["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];');

  const oldHeader='      const header = statusDone ? `✅ වැඩේ ඉවරයි!` : `⚙️ මන් දැන් වැඩේ කරගෙන යනවා බොස්...`;';
  const newHeader='      const elapsed=Math.max(0,Math.floor((Date.now()-liveStartedAt)/1000)); const mm=String(Math.floor(elapsed/60)).padStart(2,"0"); const ss=String(elapsed%60).padStart(2,"0"); const spin=LIVE_SPINNER[liveFrame%LIVE_SPINNER.length]; const header=statusDone?`✅ වැඩේ ඉවරයි!  ${mm}:${ss}`:`${spin} වැඩේ කරගෙන යනවා  ${mm}:${ss}`;';
  if(s.includes(oldHeader))s=s.replace(oldHeader,newHeader);

  const bridgeMarker='    const MAX_TOOL_ROUNDS = 10;';
  if(s.includes(bridgeMarker)&&!s.includes('global.__nightAgentLiveBridge = {')){
    const bridge=`    global.__nightAgentLiveBridge={step:async(label,state='running')=>{const icon=state==='done'?'▫️':state==='error'?'⚠️':state==='waiting'?'⏸️':LIVE_SPINNER[liveFrame%LIVE_SPINNER.length];statusLines.push(\`${icon} \${String(label)}\${state==='running'?'...':state==='done'?' — හරි ගියා':state==='waiting'?' — confirm එකක් ඕනේ':' — අවුලක් ආවා'}\`);await renderStatus();}};\n    liveTicker=setInterval(()=>{liveFrame++;renderStatus().catch(()=>{});},2200);\n\n`;
    s=s.replace(bridgeMarker,bridge+bridgeMarker);
  }
  const oldCheckin=`        if (!checkinTimer) {\n          checkinTimer = setInterval(() => {\n            bot.sendMessage(CHAT_ID, \`🔄 Still working on this — now doing: \${currentStepLabel}\`)\n              .catch((e) => console.error("progress check-in send failed:", e.message));\n          }, CHECKIN_INTERVAL_MS);\n        }\n        currentStepLabel = functionCalls.map((fc) => fc.name).join(", ");`;
  if(s.includes(oldCheckin))s=s.replace(oldCheckin,'        currentStepLabel=functionCalls.map((fc)=>fc.name).join(", ");');
  const finallyMarker='      if (checkinTimer) clearInterval(checkinTimer);';
  if(s.includes(finallyMarker))s=s.replace(finallyMarker,'      if(checkinTimer)clearInterval(checkinTimer); if(liveTicker)clearInterval(liveTicker); if(global.__nightAgentLiveBridge)delete global.__nightAgentLiveBridge;');

  // Robust design schema insertion: locate the actual generate_mcq_pdf
  // declaration and its title line instead of depending on exact escaping.
  if(!/name:\s*["']generate_mcq_pdf["'][\s\S]{0,5000}\bdesign:\s*\{/.test(s)){
    const mcq=s.indexOf('name: "generate_mcq_pdf"');
    if(mcq>=0){
      const titlePos=s.indexOf('title:',mcq);
      const titleEnd=s.indexOf('\n',titlePos);
      const reqPos=s.indexOf('required: ["topic"]',titleEnd);
      if(titlePos>=0&&titleEnd>=0&&reqPos>=0){
        const designLine='            design: { type: "STRING", description: "FREE-FORM design/layout brief extracted from the USER\\'S ENTIRE MESSAGE. Preserve every requested visual requirement, density, spacing, colors, typography, header/footer, answer-key layout and any request to avoid blank/wasted pages. Do not replace this with a fixed template." },\n';
        s=s.slice(0,titleEnd+1)+designLine+s.slice(titleEnd+1);
      }
    }
  }

  s=s.replace('if (name === "generate_mcq_pdf") return await require("./native_document_tool").generateDocument(args);','if (name === "generate_mcq_pdf") return await require("./native_document_tool_v2").generateDocument({ ...(args || {}), chat_id: CHAT_ID });');
  s+=`\n${marker}\n`;
  fs.writeFileSync(file,s);
  console.log('PDF delivery + single live activity V4 patch applied');
})();
