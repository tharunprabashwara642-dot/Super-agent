'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRuntimeV3 } = require('../agent_runtime_v3');

function response(text, calls = []) {
  return { candidates: [{ content: { role: 'model', parts: [
    ...(text ? [{ text }] : []),
    ...calls.map((c) => ({ functionCall: c })),
  ] } }] };
}

function fakeSupabase() {
  return {
    from() {
      const chain = {
        select() { return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({ data: null }),
        upsert: async () => ({ error: null }),
        delete() { return chain; },
        update() { return chain; },
      };
      return chain;
    },
  };
}

test('planner uses model semantics instead of action-keyword regexes', async () => {
  const calls = [];
  const brain = async () => {
    calls.push(calls.length);
    if (calls.length === 1) {
      return response(JSON.stringify({
        mode: 'execute',
        objective: 'Prepare a clean study plan and save it',
        requirements: ['Keep it concise'],
        acceptance_criteria: ['A saved plan exists'],
        risk: 'low',
        steps: [{
          id: 'plan',
          title: 'Prepare plan',
          role: 'writer',
          description: 'Create the requested study plan and save it.',
          dependencies: [],
          acceptance: ['The plan is saved'],
          parallel_safe: false,
          action_required: true,
        }],
      }));
    }
    return response('', [{ name: 'save_memory', args: { content: 'study plan saved' } }]);
  };

  const saved = [];
  const runtime = new AgentRuntimeV3({
    brain,
    toolDeclarations: [{ functionDeclarations: [{ name: 'save_memory' }] }],
    directTool: async (name, args) => { saved.push({ name, args }); return { saved: true }; },
    sensitiveTools: new Set(),
    bot: { sendMessage: async () => ({}) },
    chatId: 'test',
    supabase: fakeSupabase(),
    baseSystemInstruction: '',
    fetchRecentConversation: async () => [],
    fetchRecentMemories: async () => [],
    getUserProfile: async () => '',
  });

  const result = await runtime.handleUserRequest('මේ වැඩේ කරලා දාන්න');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'save_memory');
  assert.match(result, /✅|completed|සාර්ථක|saved/i);
});

test('worker stops on failed verification instead of treating budget exhaustion as success', async () => {
  let turn = 0;
  const brain = async () => {
    turn += 1;
    if (turn === 1) return response('', [{ name: 'save_memory', args: { content: 'x' } }]);
    return response(JSON.stringify({ pass: false, evidence: [], missing: ['no proof'], repair_instruction: 'retry with evidence' }));
  };

  const runtime = new AgentRuntimeV3({
    brain,
    toolDeclarations: [{ functionDeclarations: [{ name: 'save_memory' }] }],
    directTool: async () => ({ saved: true }),
    sensitiveTools: new Set(),
    bot: { sendMessage: async () => ({}) },
    chatId: 'test',
    supabase: fakeSupabase(),
    baseSystemInstruction: '',
  });

  const plan = {
    objective: 'test',
    requirements: ['test'],
    acceptance_criteria: ['proof'],
  };
  const step = {
    id: 's1',
    title: 'test step',
    role: 'verifier',
    description: 'perform the operation',
    dependencies: [],
    acceptance: ['proof'],
  };
  const result = await runtime._runWorker(null, plan, step, []);
  assert.equal(result.pass, false);
  assert.ok(Array.isArray(result.missing) || Array.isArray(result.observations));
});
