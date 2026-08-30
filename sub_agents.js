/**
 * Lightweight sub-agent dispatcher.
 * The main agent can spawn focused workers for research, coding, document
 * drafting, or verification without leaving the same process.
 */
const { augment } = require('./agent_orchestrator');

const ROLES = {
  researcher: {
    name: 'Researcher',
    emoji: '🔎',
    system: `You are a focused research sub-agent. Search, cross-check, and return
only verified findings with short source notes. Never invent URLs or quotes.
Separate facts from inference. Be concise.`,
  },
  coder: {
    name: 'Coder',
    emoji: '💻',
    system: `You are a focused coding sub-agent. Inspect first, change minimally,
syntax-check mentally, and report exact files/functions touched. Prefer small
safe patches over rewrites.`,
  },
  writer: {
    name: 'Writer',
    emoji: '✍️',
    system: `You are a focused writing sub-agent. Produce clean Sinhala or English
prose as requested. Preserve the user's tone. Structure with short paragraphs
or bullets only when needed. No fluff.`,
  },
  verifier: {
    name: 'Verifier',
    emoji: '✅',
    system: `You are a focused verification sub-agent. Check whether each claimed
requirement was actually satisfied with evidence. Mark gaps honestly.
Never claim success without proof.`,
  },
  planner: {
    name: 'Planner',
    emoji: '🗺️',
    system: `You are a focused planning sub-agent. Turn the full user message into
a short ordered plan with acceptance checks. Do not execute tools yourself.`,
  },
};

function pickRole(taskHint = '') {
  const t = String(taskHint).toLowerCase();
  if (/research|search|lookup|investigate|news|compare/.test(t)) return 'researcher';
  if (/code|bug|fix|patch|refactor|function|repo|git/.test(t)) return 'coder';
  if (/write|draft|essay|letter|report|ප්‍රශ්න|වාර්තා|ලිපි/.test(t)) return 'writer';
  if (/verify|check|validate|test|confirm/.test(t)) return 'verifier';
  if (/plan|steps|breakdown|strategy/.test(t)) return 'planner';
  return 'researcher';
}

/**
 * Build a system instruction for a sub-agent role.
 * The caller still owns the actual LLM + tool loop.
 */
function buildSubAgentPrompt(roleKey, parentGoal = '') {
  const role = ROLES[roleKey] || ROLES.researcher;
  const base = `${role.system}

You are a SUB-AGENT working under the main Super Agent.
Parent goal: ${String(parentGoal || '').slice(0, 800) || '(not specified)'}
Stay inside your specialty. Return a structured result the parent can use.
If blocked, say exactly what is missing.`;
  return augment(base);
}

function listRoles() {
  return Object.entries(ROLES).map(([key, r]) => ({
    key,
    name: r.name,
    emoji: r.emoji,
  }));
}

module.exports = {
  ROLES,
  pickRole,
  buildSubAgentPrompt,
  listRoles,
};
