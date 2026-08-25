'use strict';

class ExecutionGuard {
  constructor(options = {}) {
    this.maxSteps = Number(options.maxSteps || process.env.AGENT_MAX_STEPS || 24);
    this.maxSameTool = Number(options.maxSameTool || process.env.AGENT_MAX_SAME_TOOL || 3);
    this.stepTimeoutMs = Number(options.stepTimeoutMs || process.env.AGENT_STEP_TIMEOUT_MS || 120000);
    this.steps = 0;
    this.calls = new Map();
  }

  async run(tool, fn) {
    const name = String(tool || 'unknown');
    this.steps += 1;
    if (this.steps > this.maxSteps) throw new Error(`Agent step budget exceeded (${this.maxSteps})`);
    const count = (this.calls.get(name) || 0) + 1;
    this.calls.set(name, count);
    if (count > this.maxSameTool) throw new Error(`Repeated tool blocked: ${name}`);

    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool timed out after ${this.stepTimeoutMs}ms: ${name}`)), this.stepTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { ExecutionGuard };
