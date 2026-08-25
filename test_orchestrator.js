const assert = require('assert');
const { augment, limits } = require('./agent_orchestrator');

const prompt = augment('base system');
assert(prompt.includes('inspect -> plan -> execute -> verify -> repair -> complete'));
assert(prompt.includes('Never claim a tool ran when it did not run'));
assert(prompt.includes('Never repeat an identical tool call after a failure'));
assert(limits().maxSteps > 0);
assert(limits().maxRepairs > 0);

const twice = augment(prompt);
assert.strictEqual(twice, prompt, 'orchestrator must be idempotent');

console.log('orchestrator tests: OK');
