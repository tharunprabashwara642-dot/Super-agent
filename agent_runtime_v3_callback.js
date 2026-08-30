'use strict';

// The live V3 runtime uses its own callback namespace. This handler is kept
// separate from the legacy confirmation handler so approved V3 actions can
// resume the worker plan instead of executing one action and stopping.

async function continuePlan(runtime, taskId, plan, startIndex, initialResults) {
  const results = Array.isArray(initialResults) ? [...initialResults] : [];
  for (let i = startIndex; i < (plan?.steps || []).length; i++) {
    const step = plan.steps[i];
    const result = await runtime._runWorker(taskId, plan, step, results);
    if (result.status === 'waiting_user') return { waiting: true, results };
    results.push(result);
    if (result.pass !== true) {
      await runtime._persistTask(taskId, {
        status: 'blocked',
        current_step: step.id,
        blocker: (result.missing || ['Worker step was not verified.']).join('; '),
        context_json: { plan, step_results: results, pending_approval: null },
      });
      return { waiting: false, results };
    }
  }
  const passed = results.length === plan.steps.length && results.every((r) => r.pass === true);
  await runtime._persistTask(taskId, {
    status: passed ? 'completed' : 'blocked',
    current_step: passed ? 'completed' : (results.find((r) => r.pass !== true)?.step_id || 'blocked'),
    blocker: passed ? null : 'One or more planned steps were not verified.',
    context_json: { plan, step_results: results, pending_approval: null },
  });
  try {
    await runtime._status(passed ? '✅ All planned worker steps completed and verified.' : '⚠️ The remaining worker plan was not fully verified.');
  } catch (_) {}
  return { waiting: false, results, passed };
}

async function handleApprovalCallback(runtime, query) {
  const data = String(query?.data || '');
  if (!data.startsWith('agentv3:')) return false;
  const [, decision, id] = data.split(':');
  if (!id || !['approve', 'deny'].includes(decision)) return true;
  try { await runtime.ctx.bot.answerCallbackQuery(query.id); } catch (_) {}

  let row = null;
  try {
    const { data: found } = await runtime.ctx.supabase
      .from('pending_confirmations')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    row = found;
  } catch (_) {}

  if (!row?.payload?.pending) {
    try { await runtime.ctx.bot.sendMessage(runtime.ctx.chatId, '⚠️ That approval request is no longer available. The task can be resumed from its saved state.'); } catch (_) {}
    return true;
  }

  const pending = row.payload.pending;
  const taskId = row.payload.task_id || pending.payload?.task_id || null;
  try { await runtime.ctx.supabase.from('pending_confirmations').delete().eq('id', id); } catch (_) {}

  if (decision === 'deny') {
    if (taskId) {
      await runtime._persistTask(taskId, {
        status: 'blocked',
        blocker: `User denied ${pending.tool_name}`,
        context_json: { plan: pending.worker_state?.plan || {}, pending_approval: null, step_results: [] },
      });
    }
    try { await runtime.ctx.bot.sendMessage(runtime.ctx.chatId, `❌ ${pending.tool_name} denied. I stopped this task at the approval boundary.`); } catch (_) {}
    return true;
  }

  let result;
  try { result = await runtime.ctx.directTool(pending.tool_name, pending.args || {}); }
  catch (e) { result = { error: true, message: e.message }; }

  const plan = pending.worker_state?.plan;
  const stepIndex = Number.isInteger(pending.payload?.step_index) ? pending.payload.step_index : Math.max(0, (plan?.steps || []).findIndex((s) => s.id === pending.payload?.step_id));
  const step = plan?.steps?.[stepIndex];
  if (!plan || !step) {
    try { await runtime.ctx.bot.sendMessage(runtime.ctx.chatId, '⚠️ Saved approval state was incomplete. Please send the task again so I can re-plan it safely.'); } catch (_) {}
    return true;
  }

  const contents = Array.isArray(pending.worker_state?.contents) ? [...pending.worker_state.contents] : [{ role: 'user', parts: [{ text: step.description }] }];
  const observations = Array.isArray(pending.worker_state?.observations) ? [...pending.worker_state.observations] : [];
  observations.push(`${pending.tool_name}: ${JSON.stringify(result)}`);
  contents.push({ role: 'user', parts: [{ functionResponse: { name: pending.tool_name, response: { result } } }] });

  if (taskId) {
    await runtime._persistTask(taskId, {
      status: 'active',
      blocker: null,
      current_step: step.id,
      context_json: { plan, pending_approval: null, step_results: [] },
    });
  }

  // Re-enter the current worker after the approved action. This allows the
  // worker to observe the real result and decide whether another tool call or
  // verification is needed before the next planned step starts.
  const current = await runtime._runWorker(taskId, plan, step, [], contents);
  if (current.status === 'waiting_user') return true;
  if (current.pass !== true) {
    if (taskId) {
      await runtime._persistTask(taskId, {
        status: 'blocked',
        current_step: step.id,
        blocker: (current.missing || ['Approved action did not lead to a verified step.']).join('; '),
        context_json: { plan, step_results: [current], pending_approval: null },
      });
    }
    try { await runtime.ctx.bot.sendMessage(runtime.ctx.chatId, '⚠️ The approved action ran, but the worker could not verify the step. The task is blocked instead of being marked done.'); } catch (_) {}
    return true;
  }

  if (!taskId) {
    try { await runtime.ctx.bot.sendMessage(runtime.ctx.chatId, '✅ Approved action completed and the worker verified it.'); } catch (_) {}
    return true;
  }

  await continuePlan(runtime, taskId, plan, stepIndex + 1, [current]);
  return true;
}

module.exports = { handleApprovalCallback, continuePlan };
