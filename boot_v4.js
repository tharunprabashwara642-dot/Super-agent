'use strict';

// Compatibility entrypoint for older deployments/scripts.
// V4 used to inject code into web_boot.js before index.js was compiled,
// which made provider/runtime variables out of scope after the Anthropic
// migration. The production bootstrap is now boot_v5.js, which applies all
// quality wrappers after the runtime is initialized.
require('./web_boot.js');

const agent = global.__nightAgentWeb;
if (!agent || !agent.agentRuntime) {
  throw new Error('V4 compatibility bootstrap could not obtain the agent runtime');
}

console.log('🧠 Super Agent V4 compatibility entrypoint active; use boot_v5.js for production quality layers.');
