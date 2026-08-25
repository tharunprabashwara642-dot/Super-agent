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

// Claude-Code-style bounded orchestration policy. Injected at the model
// boundary so every task follows inspect -> plan -> execute -> verify ->
// repair -> complete without a risky rewrite of the large legacy loop.
const orchestrationMarker='// CLAUDE_CODE_ORCHESTRATOR_V1';
if (!s.includes(orchestrationMarker)) {
  const importMarker='// SKILL_RUNTIME_PATCH_V1';
  const orchestrationImport=`// CLAUDE_CODE_ORCHESTRATOR_V1
const agentOrchestrator = require("./agent_orchestrator");
`;
  if (!s.includes(importMarker)) throw new Error('skill runtime marker not found');
  s=s.replace(importMarker,importMarker+'\n'+orchestrationImport);

  const skillLine='const enrichedSystemInstruction = skillRuntime.augmentSystemInstruction(systemInstruction, contents);';
  const orchestrationLine='const enrichedSystemInstruction = agentOrchestrator.augment(skillRuntime.augmentSystemInstruction(systemInstruction, contents));';
  if (!s.includes(skillLine)) throw new Error('enriched system instruction marker not found');
  s=s.replace(skillLine,orchestrationLine);
  console.log('🧠 Claude-Code-style orchestration policy applied');
}

// Production execution guard. It is deliberately attached to custom-tool
// execution because this function is the single registry boundary used by
// generated/runtime tools. The guard is argument-aware and time-windowed.
const guardMarker='// AGENT_RUNTIME_GUARD_V1';
if (!s.includes(guardMarker)) {
  const marker='async function runCustomTool(name, args) {';
  const replacement=`// AGENT_RUNTIME_GUARD_V1
const { ExecutionGuard } = require("./execution_guard");
const agentExecutionGuard = new ExecutionGuard();

async function runCustomTool(name, args) {
  return agentExecutionGuard.run(name, async () => {
    return await __runCustomToolImpl(name, args);
  }, args);
}

async function __runCustomToolImpl(name, args) {`;
  if (s.includes(marker) && !s.includes('async function __runCustomToolImpl')) {
    s=s.replace(marker,replacement);
    console.log('🛡️ Agent execution guard applied');
  }
}

// Goal cancellation hardening.
// The old cancel_all_goals() changed the DB status and added an in-memory
// cancellation flag, but an already-running runGoalStep() could finish and
// then mark its step done + send a "step done" message anyway. It also left
// queued confirmations alive. Patch both sides so cancellation is a real
// stop boundary: no post-cancel step completion, no stale confirmation, and
// no later maybeCompleteGoal() call for a cancelled goal.
const goalCancelMarker='// GOAL_CANCEL_HARDENING_V1';
if (!s.includes(goalCancelMarker)) {
  const oldCancel=`async function cancelAllGoals() {
  const { data, error } = await supabase
    .from("goals")
    .update({ status: "cancelled" })
    .eq("status", "active")
    .select("id");
  if (error) return { cancelled: 0, reason: error.message };
  // Also drop it from the in-memory "currently running" tracker so
  // autonomousTick's kickOffGoal no-op guard doesn't block a legitimate
  // fresh goal with the same title later, and so any in-flight tick for
  // one of these goals doesn't keep posting updates for a cancelled task.
  for (const g of data || []) {
    cancelledGoalIds.add(g.id);
    trackedActiveGoals.delete(g.id);
  }
  return { cancelled: (data || []).length };
}`;
  const newCancel=`${goalCancelMarker}
async function cancelAllGoals() {
  const { data, error } = await supabase
    .from("goals")
    .update({ status: "cancelled" })
    .eq("status", "active")
    .select("id");
  if (error) return { cancelled: 0, reason: error.message };

  const cancelledIds = new Set((data || []).map((g) => g.id));

  // Make the stop visible to every in-flight goal loop immediately.
  for (const id of cancelledIds) {
    cancelledGoalIds.add(id);
    trackedActiveGoals.delete(id);
  }

  // Pending/awaiting steps belonging to cancelled goals must never be
  // resumed by the 60s stalled-goal safety net.
  if (cancelledIds.size > 0) {
    await supabase
      .from("goal_steps")
      .update({ status: "cancelled" })
      .in("goal_id", Array.from(cancelledIds))
      .in("status", ["pending", "awaiting_approval"]);

    // Drop any Telegram confirmation that was waiting for one of these
    // goals. Otherwise a late button tap could resurrect a cancelled step.
    if (Array.isArray(pendingConfirmations)) {
      pendingConfirmations = pendingConfirmations.filter((pc) => {
        if (pc.goalId && cancelledIds.has(pc.goalId)) return false;
        return true;
      });
    }
  }

  return { cancelled: cancelledIds.size, background_stopped: true };
}`;
  if (!s.includes(oldCancel)) throw new Error('cancelAllGoals marker not found');
  s=s.replace(oldCancel,newCancel);

  const oldAfterStep=`      const result = await runGoalStep({ id: goalId, title }, nextStep);

      if (result.needsConfirmation) {`;
  const newAfterStep=`      const result = await runGoalStep({ id: goalId, title }, nextStep);

      // A cancellation may arrive while the current tool is still running.
      // Never commit that in-flight result as "done" after the user stopped
      // the goal. The running tool is allowed to finish its current atomic
      // call, then this boundary drops the result and exits cleanly.
      const { data: goalStateAfterStep } = await supabase
        .from("goals")
        .select("status")
        .eq("id", goalId)
        .maybeSingle();
      if (cancelledGoalIds.has(goalId) || goalStateAfterStep?.status === "cancelled") {
        cancelledGoalIds.delete(goalId);
        return;
      }

      if (result.needsConfirmation) {`;
  if (!s.includes(oldAfterStep)) throw new Error('runGoalAutonomously post-step marker not found');
  s=s.replace(oldAfterStep,newAfterStep);

  console.log('🛑 Goal cancellation hardening applied');
}

fs.writeFileSync(file,s);
console.log('✅ boot patch complete');
