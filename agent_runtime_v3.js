'use strict';

const crypto = require('crypto');
const { buildRolePrompt } = require('./sub_agents');
const { augmentSystemInstruction } = require('./skill_runtime');

const DEFAULT_LIMITS = {
  maxPlanSteps: Number(process.env.AGENT_V3_MAX_PLAN_STEPS || 12),
  maxToolRounds: Number(process.env.AGENT_V3_MAX_TOOL_ROUNDS || 10),
  maxRepairRounds: Number(process.env.AGENT_V3_MAX_REPAIR_ROUNDS || 2),
  maxFinalEvidence: Number(process.env.AGENT_V3_MAX_FINAL_EVIDENCE || 8),
};

function asText(value, max = 12000) {
  return String(value == null ? '' : value).slice(0, max);
}

function cleanJsonText(text) {
  const s = asText(text, 30000).trim();
  if (!s) return '';
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  return first >= 0 && last > first ? s.slice(first, last + 1) : s;
}

function parseJson(text, fallback = null) {
  try { return JSON.parse(cleanJsonText(text)); } catch (_) { return fallback; }
}

function extractText(response) {
  return (response?.candidates?.[0]?.content?.parts || [])
    .filter((p) => p && p.text)
    .map((p) => p.text)
    .join('')
    .trim();
}

function extractCalls(response) {
  return (response?.candidates?.[0]?.content?.parts || [])
    .filter((p) => p && p.functionCall)
    .map((p) => p.functionCall);
}

function normalisePlan(raw, userText, limits) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const normalized = steps.slice(0, limits.maxPlanSteps).map((step, index) => ({
    id: asText(step?.id || `step_${index + 1}`, 80),
    title: asText(step?.title || step?.description || `Step ${index + 1}`, 200),
    role: asText(step?.role || 'general', 60),
    description: asText(step?.description || '', 4000),
    dependencies: Array.isArray(step?.dependencies) ? step.dependencies.map((x) => asText(x, 80)).slice(0, 12) : [],
    acceptance: Array.isArray(step?.acceptance) ? step.acceptance.map((x) => asText(x, 1000)).slice(0, 8) : [],
    parallel_safe: step?.parallel_safe === true,
    action_required: step?.action_required !== false,
  })).filter((s) => s.description);

  return {
    mode: plan.mode === 'respond' ? 'respond' : (steps.length ? 'execute' : 'respond'),
    objective: asText(plan.objective || userText, 1000),
    requirements: Array.isArray(plan.requirements) ? plan.requirements.map((x) => asText(x, 1200)).slice(0, 20) : [asText(userText, 4000)],
    acceptance_criteria: Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria.map((x) => asText(x, 1200)).slice(0, 20) : [],
    risk: ['low', 'medium', 'high', 'critical'].includes(plan.risk) ? plan.risk : 'medium',
    steps,
    user_visible_summary: asText(plan.user_visible_summary || '', 1000),
  };
}

function toolDeclarationsForWorkers(declarations) {
  const groups = Array.isArray(declarations) ? declarations : [];
  return groups.map((group) => ({
    ...group,
    functionDeclarations: (group.functionDeclarations || []).filter((d) => ![
      'dispatch_sub_agent',
      'create_task_list',
    ].includes(d.name)),
  })).filter((g) => g.functionDeclarations?.length);
}

function resultLooksSuccessful(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.error === true) return false;
  for (const key of ['saved', 'sent', 'created', 'updated', 'deleted', 'deployed', 'forked', 'added', 'removed', 'scheduled']) {
    if (Object.prototype.hasOwnProperty.call(result, key) && result[key] === false) return false;
  }
  if (typeof result.final_status === 'string' && result.final_status !== 'SUCCESS') return false;
  if (result.ready === false || result.ok === false) return false;
  return true;
}

function formatToolResult(result) {
  try { return JSON.stringify(result); } catch (_) { return String(result); }
}

function plannerPrompt(userText, context) {
  return `You are the planning layer of a general-purpose personal AI agent.\n\nCreate a machine-readable execution plan from the user's ENTIRE message. Do not use keyword rules. Understand meaning, constraints, dependencies, desired outputs, quality requirements, and acceptance conditions semantically.\n\nThe user message is authoritative:\n---\n${asText(userText, 12000)}\n---\n\nExisting task/memory context:\n${asText(context, 12000)}\n\nReturn ONLY valid JSON with this schema:\n{\n  "mode": "respond" | "execute",\n  "objective": "...",\n  "requirements": ["..."],\n  "acceptance_criteria": ["..."],\n  "risk": "low" | "medium" | "high" | "critical",\n  "user_visible_summary": "...",\n  "steps": [\n    {\n      "id": "stable short id",\n      "title": "...",\n      "role": "planner/researcher/coder/writer/verifier/general or another useful role",\n      "description": "one concrete outcome to perform",\n      "dependencies": ["step id"],\n      "acceptance": ["machine-checkable or evidence-based conditions"],\n      "parallel_safe": true | false,\n      "action_required": true | false\n    }\n  ]\n}\n\nRules: use execute when real-world actions or artifacts are requested; use respond for explanation/chat. Do not invent requirements. Do not collapse multiple user requirements into one vague step. Prefer small, independently verifiable steps.`;
}

function workerSystem(role, plan, step, extraContext) {
  const base = buildRolePrompt(role, plan.objective, step.description);
  return `${base}\n\nPARENT TASK CONTRACT\nObjective: ${plan.objective}\nRequirements:\n- ${plan.requirements.join('\n- ')}\nAcceptance criteria:\n- ${plan.acceptance_criteria.join('\n- ') || '(none globally defined)'}\n\nCURRENT WORKER STEP\nTitle: ${step.title}\nDescription: ${step.description}\nStep acceptance:\n- ${step.acceptance.join('\n- ') || '(use evidence from tool results)'}\n\nWORKER RULES\n- You are a real execution worker, not a narrator. Use tools when the step requires a real action.\n- Keep your own context separate from other workers.\n- Never claim an action happened unless a tool result provides evidence.\n- If a tool fails, inspect the returned reason and change strategy rather than repeating an identical call.\n- Stop when the step's acceptance conditions are satisfied or when a genuine blocker remains.\n- Do not create new tasks, spawn more agents, or silently change the user's requirements.\n\nAdditional context:\n${asText(extraContext, 10000)}`;
}

function verifierPrompt(plan, step, observations) {
  return `You are the verification worker for a general-purpose AI agent. Determine whether ONE execution step is actually complete. Use only the supplied evidence. Do not infer that a requested action happened merely because the worker said it did.\n\nTASK: ${plan.objective}\nSTEP: ${step.title}\nSTEP DESCRIPTION: ${step.description}\nSTEP ACCEPTANCE:\n- ${(step.acceptance || []).join('\n- ') || '(use strongest available evidence)'}\n\nOBSERVATIONS:\n${asText(observations, 30000)}\n\nReturn ONLY valid JSON:\n{\n  "pass": true | false,\n  "evidence": ["specific evidence"],\n  "missing": ["what is not proven"],\n  "repair_instruction": "concrete next action if pass=false"\n}`;
}

function finalizerPrompt(userText, plan, stepResults) {
  return `You are the final response layer of an autonomous personal agent. Answer the user based ONLY on the actual execution record below. Never claim success for work that is missing or unverified. Mention blockers plainly. Preserve the user's language when practical. Be concise unless the task needs detail.\n\nORIGINAL USER REQUEST:\n${asText(userText, 12000)}\n\nPLAN:\n${JSON.stringify(plan)}\n\nEXECUTION RECORD:\n${asText(JSON.stringify(stepResults), 30000)}\n\nWrite the final user-facing response. Do not say you will do something later unless a durable task is explicitly waiting on user input.`;
}

class AgentRuntimeV3 {
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.limits = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
    this.runningTasks = new Set();
  }

  async _brain(contents, systemInstruction, tools = null) {
    return this.ctx.brain(contents, augmentSystemInstruction(systemInstruction, contents), tools);
  }

  async _loadContext(userText) {
    let history = [];
    let memories = [];
    let profile = '';
    try { history = await this.ctx.fetchRecentConversation?.(12) || []; } catch (_) {}
    try { memories = await this.ctx.fetchRecentMemories?.(12) || []; } catch (_) {}
    try { profile = await this.ctx.getUserProfile?.() || ''; } catch (_) {}
    const openTasks = await this._openTasks();
    return {
      history: history.filter((m) => !(m?.role === 'user' && m?.content === userText)),
      contextText: [
        profile ? `Profile: ${profile}` : '',
        memories.length ? `Memories:\n- ${memories.join('\n- ')}` : '',
        openTasks.length ? `Open tasks:\n${openTasks.map((t) => JSON.stringify({ id: t.id, objective: t.objective, status: t.status, current_step: t.current_step, blocker: t.blocker })).join('\n')}` : '',
      ].filter(Boolean).join('\n\n') || 'No prior context available.',
    };
  }

  async _openTasks() {
    try {
      const { data, error } = await this.ctx.supabase.from('agent_tasks')
        .select('id, objective, user_request, status, current_step, success_criteria, blocker, context_json, updated_at')
        .in('status', ['active', 'waiting_user', 'blocked'])
        .order('updated_at', { ascending: false })
        .limit(8);
      return error ? [] : (data || []);
    } catch (_) { return []; }
  }

  async _createTask(userText, plan) {
    try {
      const task = await this.ctx.createAgentTask?.(plan.objective, userText, plan.acceptance_criteria.join('\n'));
      if (task) {
        await this.ctx.updateAgentTask?.(task.id, {
          status: 'active',
          current_step: plan.steps[0]?.id || 'planning',
          context_json: { plan, step_results: [], pending_approval: null },
        });
      }
      return task || null;
    } catch (_) { return null; }
  }

  async _persistTask(taskId, patch) {
    if (!taskId) return;
    try { await this.ctx.updateAgentTask?.(taskId, patch); } catch (_) {}
  }

  async _status(text) {
    try { await this.ctx.bot?.sendMessage(this.ctx.chatId, asText(text, 3500)); } catch (_) {}
  }

  async _plan(userText, contextText) {
    const data = await this._brain([{ role: 'user', parts: [{ text: plannerPrompt(userText, contextText) }] }], 'You are a strict JSON planning engine. Never use markdown fences.', null);
    if (data?.error) throw new Error(data.error.message || 'Planner failed');
    const raw = parseJson(extractText(data), null);
    return normalisePlan(raw, userText, this.limits);
  }

  async _runWorker(taskId, plan, step, priorResults = [], savedContents = null) {
    const workerKey = `${taskId || 'standalone'}:${step.id}`;
    if (this.runningTasks.has(workerKey)) return { status: 'already_running', step_id: step.id };
    this.runningTasks.add(workerKey);
    try {
      let contents = savedContents || [{ role: 'user', parts: [{ text: `Execute this step now: ${step.description}` }] }];
      const toolDecls = toolDeclarationsForWorkers(this.ctx.toolDeclarations);
      const system = workerSystem(step.role, plan, step, priorResults.length ? JSON.stringify(priorResults.slice(-4)) : 'No earlier step results.');
      const observations = [];

      for (let round = 0; round < this.limits.maxToolRounds; round++) {
        const response = await this._brain(contents, system, toolDecls);
        if (response?.error) return { pass: false, error: response.error.message, step_id: step.id };
        const calls = extractCalls(response);
        const text = extractText(response);
        if (!calls.length) {
          const verify = await this._verify(plan, step, observations.concat(text ? [`Worker final text: ${text}`] : []));
          if (verify.pass || round >= this.limits.maxRepairRounds) {
            return { pass: verify.pass, worker_text: text, evidence: verify.evidence, missing: verify.missing, observations, step_id: step.id };
          }
          observations.push(`Verifier requested repair: ${verify.repair_instruction}`);
          contents.push({ role: 'model', parts: response?.candidates?.[0]?.content?.parts || [] });
          contents.push({ role: 'user', parts: [{ text: `Verification failed. Repair the step. Required repair: ${verify.repair_instruction}` }] });
          continue;
        }

        contents.push({ role: 'model', parts: response?.candidates?.[0]?.content?.parts || [] });
        const responseParts = [];
        for (const call of calls) {
          if (!call?.name) continue;
          await this._status(`🤖 ${step.role} worker → ${call.name}`);
          if (this.ctx.sensitiveTools?.has(call.name)) {
            const approval = await this._requestApproval({ taskId, plan, step, contents, call, observations });
            return approval;
          }
          let result;
          try { result = await this.ctx.directTool(call.name, call.args || {}); }
          catch (e) { result = { error: true, message: e.message }; }
          observations.push(`${call.name}: ${formatToolResult(result)}`);
          responseParts.push({ functionResponse: { name: call.name, response: { result } } });
          if (!resultLooksSuccessful(result)) {
            observations.push(`Tool ${call.name} did not report success. The worker must diagnose or change strategy.`);
          }
        }
        contents.push({ role: 'user', parts: responseParts });
      }
      return { pass: false, missing: ['Worker tool budget exhausted before verification.'], observations, step_id: step.id };
    } finally {
      this.runningTasks.delete(workerKey);
    }
  }

  async _verify(plan, step, observations) {
    const prompt = verifierPrompt(plan, step, observations.join('\n'));
    const data = await this._brain([{ role: 'user', parts: [{ text: prompt }] }], 'Return strict JSON only.', null);
    if (data?.error) return { pass: false, evidence: [], missing: [data.error.message], repair_instruction: 'Inspect the last failed action and retry with a different strategy.' };
    const parsed = parseJson(extractText(data), null);
    if (!parsed || typeof parsed.pass !== 'boolean') return { pass: false, evidence: [], missing: ['Verifier did not return valid structured evidence.'], repair_instruction: 'Re-run the step and collect explicit tool evidence.' };
    return {
      pass: parsed.pass,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((x) => asText(x, 1000)).slice(0, this.limits.maxFinalEvidence) : [],
      missing: Array.isArray(parsed.missing) ? parsed.missing.map((x) => asText(x, 1000)).slice(0, this.limits.maxFinalEvidence) : [],
      repair_instruction: asText(parsed.repair_instruction || '', 2000),
    };
  }

  async _requestApproval(state) {
    const id = `v3_${crypto.randomUUID()}`;
    const payload = { task_id: state.taskId, step_id: state.step.id, step_index: state.plan.steps.findIndex((s) => s.id === state.step.id) };
    const pending = {
      approval_id: id,
      status: 'pending',
      tool_name: state.call.name,
      args: state.call.args || {},
      description: `🤖 ${state.step.role} worker wants to run: ${state.call.name}\n${JSON.stringify(state.call.args || {}).slice(0, 1400)}\n\nAllow this action?`,
      payload,
      worker_state: {
        plan: state.plan,
        contents: state.contents,
        observations: state.observations,
      },
    };
    if (state.taskId) {
      await this._persistTask(state.taskId, {
        status: 'waiting_user',
        blocker: `Approval required for ${state.call.name}`,
        context_json: {
          plan: state.plan,
          pending_approval: pending,
          step_results: [],
        },
        current_step: state.step.id,
      });
    }
    try {
      await this.ctx.supabase.from('pending_confirmations').upsert({
        id,
        tool_name: state.call.name,
        args: state.call.args || {},
        description: pending.description,
        kind: 'agent_runtime_v3',
        payload: { task_id: state.taskId, pending },
        goal_id: null,
        step_id: state.step.id,
        goal_title: state.plan.objective,
        message_id: null,
      });
    } catch (_) {}

    try {
      await this.ctx.bot.sendMessage(this.ctx.chatId, pending.description, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Allow', callback_data: `agentv3:approve:${id}` },
          { text: '❌ Deny', callback_data: `agentv3:deny:${id}` },
        ]] },
      });
    } catch (_) {}
    await this._status(`⏸️ ${state.step.title} — waiting for your approval for ${state.call.name}.`);
    return { status: 'waiting_user', approval_id: id, step_id: state.step.id };
  }

  async _resumeApproval(confirmation) {
    const pending = confirmation?.payload?.pending;
    if (!pending) return { ok: false, reason: 'Approval state missing.' };
    const taskId = confirmation?.payload?.task_id || pending.payload?.task_id || null;
    if (confirmation.decision === 'deny') {
      if (taskId) await this._persistTask(taskId, { status: 'blocked', blocker: `User denied ${pending.tool_name}`, context_json: { plan: pending.worker_state?.plan || {}, pending_approval: null } });
      await this._status(`❌ ${pending.tool_name} was denied, so I stopped that step.`);
      return { ok: false, denied: true };
    }

    let result;
    try { result = await this.ctx.directTool(pending.tool_name, pending.args || {}); }
    catch (e) { result = { error: true, message: e.message }; }

    if (!taskId) {
      await this._status(resultLooksSuccessful(result) ? `✅ ${pending.tool_name} completed.` : `⚠️ ${pending.tool_name} failed.`);
      return { ok: resultLooksSuccessful(result), result };
    }

    const plan = pending.worker_state?.plan;
    const step = plan?.steps?.find((s) => s.id === pending.payload?.step_id) || plan?.steps?.[pending.payload?.step_index];
    if (!plan || !step) return { ok: false, reason: 'Saved plan/step state is missing.' };

    const contents = Array.isArray(pending.worker_state?.contents) ? [...pending.worker_state.contents] : [{ role: 'user', parts: [{ text: step.description }] }];
    const observations = Array.isArray(pending.worker_state?.observations) ? [...pending.worker_state.observations] : [];
    observations.push(`${pending.tool_name}: ${formatToolResult(result)}`);
    contents.push({ role: 'user', parts: [{ functionResponse: { name: pending.tool_name, response: { result } } }] });
    await this._persistTask(taskId, { status: 'active', blocker: null, current_step: step.id, context_json: { plan, pending_approval: null, step_results: [] } });
    return this._runWorker(taskId, plan, step, [], contents);
  }

  async handleCallbackQuery(query) {
    const data = String(query?.data || '');
    if (!data.startsWith('agentv3:')) return false;
    const parts = data.split(':');
    const decision = parts[1] === 'approve' ? 'approve' : parts[1] === 'deny' ? 'deny' : null;
    const id = parts.slice(2).join(':');
    if (!decision || !id) return true;
    try { await this.ctx.bot.answerCallbackQuery(query.id); } catch (_) {}

    let row = null;
    try {
      const { data: found } = await this.ctx.supabase.from('pending_confirmations').select('*').eq('id', id).maybeSingle();
      row = found;
    } catch (_) {}
    if (!row) {
      try { await this.ctx.bot.sendMessage(this.ctx.chatId, '⚠️ That approval request is no longer available. The task can be re-planned from the current state.'); } catch (_) {}
      return true;
    }

    const confirmation = {
      payload: row.payload,
      decision: decision === 'approve' ? 'approve' : 'deny',
    };
    try { await this.ctx.supabase.from('pending_confirmations').delete().eq('id', id); } catch (_) {}
    await this._resumeApproval(confirmation);
    return true;
  }

  async _completeTask(task, plan, stepResults) {
    const passed = stepResults.length === plan.steps.length && stepResults.every((s) => s.pass === true);
    const status = passed ? 'completed' : 'blocked';
    await this._persistTask(task?.id, {
      status,
      current_step: passed ? 'completed' : (stepResults.find((s) => !s.pass)?.step_id || 'blocked'),
      blocker: passed ? null : 'One or more planned steps were not verified.',
      context_json: { plan, step_results: stepResults, pending_approval: null },
    });
    return passed;
  }

  async handleUserRequest(userText) {
    const text = asText(userText, 12000).trim();
    if (!text) return 'කරන්න ඕනේ දේ ටිකක් කියන්න.';
    const { history, contextText } = await this._loadContext(text);
    let plan;
    try {
      plan = await this._plan(text, contextText);
    } catch (e) {
      return `⚠️ Planning failed: ${e.message}`;
    }

    if (plan.mode === 'respond') {
      return this._respond(text, history, contextText);
    }

    const task = await this._createTask(text, plan);
    if (!task) {
      // The agent must still be useful if durable task tables are unavailable.
      return this._executeEphemeral(text, plan, contextText);
    }

    await this._status(`🧠 Plan ready — ${plan.steps.length} worker step(s). Starting execution.`);
    const stepResults = [];
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const depsOk = step.dependencies.every((dep) => stepResults.find((r) => r.step_id === dep)?.pass === true);
      if (!depsOk) {
        stepResults.push({ step_id: step.id, pass: false, missing: [`Dependency not verified: ${step.dependencies.join(', ')}`] });
        break;
      }
      await this._persistTask(task.id, { current_step: step.id, status: 'active', blocker: null, context_json: { plan, step_results: stepResults, pending_approval: null } });
      const result = await this._runWorker(task.id, plan, step, stepResults);
      if (result.status === 'waiting_user') return `⏸️ ${step.title} is waiting for your approval.`;
      stepResults.push(result);
      if (!result.pass) break;
    }

    const success = await this._completeTask(task, plan, stepResults);
    if (!success) return this._finalResponse(text, plan, stepResults);
    return this._finalResponse(text, plan, stepResults);
  }

  async _respond(userText, history, contextText) {
    const contents = history.map((m) => ({ role: m.role === 'agent' ? 'model' : 'user', parts: [{ text: m.content }] }));
    contents.push({ role: 'user', parts: [{ text: userText }] });
    const tools = toolDeclarationsForWorkers(this.ctx.toolDeclarations);
    const system = `${this.ctx.baseSystemInstruction || ''}\n\nDynamic runtime rules:\n- Understand the user's complete message semantically; do not depend on keyword/regex intent detection.\n- Use tools when the user asks for information or an action that a tool can actually perform.\n- Never claim completion without evidence.\n- Preserve constraints, language, quantities, dates and output requirements.\nContext:\n${contextText}`;
    for (let round = 0; round < this.limits.maxToolRounds; round++) {
      const response = await this._brain(contents, system, tools);
      if (response?.error) return `⚠️ ${response.error.message || 'Model request failed.'}`;
      const calls = extractCalls(response);
      const text = extractText(response);
      if (!calls.length) return text || 'I processed the request but the model returned no final answer.';
      contents.push({ role: 'model', parts: response?.candidates?.[0]?.content?.parts || [] });
      const responseParts = [];
      for (const call of calls) {
        await this._status(`🤖 Agent → ${call.name}`);
        if (this.ctx.sensitiveTools?.has(call.name)) {
          const plan = normalisePlan({ mode: 'execute', objective: userText, steps: [{ id: 'chat_action', title: 'Requested action', role: 'general', description: userText, acceptance: [] }] }, userText, this.limits);
          const approval = await this._requestApproval({ taskId: null, plan, step: plan.steps[0], contents, call, observations: [] });
          return `⏸️ Waiting for approval to run ${call.name}.`;
        }
        let result;
        try { result = await this.ctx.directTool(call.name, call.args || {}); } catch (e) { result = { error: true, message: e.message }; }
        responseParts.push({ functionResponse: { name: call.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
    return '⚠️ I reached the execution limit before obtaining a verified final answer.';
  }

  async _executeEphemeral(userText, plan, contextText) {
    const results = [];
    for (const step of plan.steps) {
      const result = await this._runWorker(null, plan, step, results);
      results.push(result);
      if (!result.pass || result.status === 'waiting_user') break;
    }
    return this._finalResponse(userText, plan, results);
  }

  async _finalResponse(userText, plan, stepResults) {
    try {
      const data = await this._brain([{ role: 'user', parts: [{ text: finalizerPrompt(userText, plan, stepResults) }] }], 'Write only the final user-facing response.', null);
      if (!data?.error) {
        const text = extractText(data);
        if (text) return text;
      }
    } catch (_) {}
    const failed = stepResults.find((s) => s.pass !== true);
    if (failed) return `⚠️ වැඩේ සම්පූර්ණයෙන් verify කරන්න බැරි වුණා. Blocker: ${(failed.missing || ['unverified step']).join('; ')}`;
    return `✅ වැඩේ සම්පූර්ණ කරලා verify කරලා තියෙනවා.`;
  }

  async runStandaloneSubAgent(args = {}) {
    const task = asText(args.task || '', 8000).trim();
    if (!task) return { error: true, message: 'Sub-agent task is required.' };
    const role = asText(args.role || 'general', 60);
    const parentGoal = asText(args.context || task, 4000);
    const plan = {
      objective: parentGoal,
      requirements: [task],
      acceptance_criteria: [],
    };
    const step = {
      id: `standalone_${crypto.randomUUID().slice(0, 8)}`,
      title: `${role} worker`,
      role,
      description: task,
      dependencies: [],
      acceptance: Array.isArray(args.acceptance) ? args.acceptance : [],
      action_required: args.execute_tools !== false,
    };
    const result = await this._runWorker(null, plan, step, []);
    return { dispatched: true, role, task, result };
  }
}

function createAgentRuntime(ctx) {
  return new AgentRuntimeV3(ctx);
}

module.exports = { AgentRuntimeV3, createAgentRuntime };
