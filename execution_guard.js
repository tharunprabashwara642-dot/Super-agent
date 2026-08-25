'use strict';

// Bounded execution guard. This guard is intentionally time-windowed because
// runCustomTool is invoked from a long-lived Telegram process rather than a
// request-scoped HTTP handler. A guard that stores lifetime counters would
// eventually block legitimate future tasks.
class ExecutionGuard {
  constructor(options = {}) {
    this.maxSteps = Number(options.maxSteps || process.env.AGENT_MAX_STEPS || 32);
    this.maxSameTool = Number(options.maxSameTool || process.env.AGENT_MAX_SAME_TOOL || 8);
    this.maxSameCall = Number(options.maxSameCall || process.env.AGENT_MAX_SAME_CALL || 3);
    this.stepTimeoutMs = Number(options.stepTimeoutMs || process.env.AGENT_STEP_TIMEOUT_MS || 120000);
    this.windowMs = Number(options.windowMs || process.env.AGENT_GUARD_WINDOW_MS || 5 * 60 * 1000);
    this.steps = 0;
    this.calls = new Map();
    this.signatures = new Map();
    this.lastActivity = 0;
  }

  reset() {
    this.steps = 0;
    this.calls.clear();
    this.signatures.clear();
    this.lastActivity = 0;
  }

  _ensureWindow(now) {
    if (this.lastActivity && now - this.lastActivity > this.windowMs) this.reset();
    this.lastActivity = now;
  }

  _prune(now) {
    for (const [key, item] of this.signatures) {
      if (now - item.at > this.windowMs) this.signatures.delete(key);
    }
  }

  _signature(name, args) {
    try { return `${name}:${JSON.stringify(args ?? {})}`; }
    catch (_) { return `${name}:<unserializable>`; }
  }

  async run(tool, fn, args = {}) {
    const name = String(tool || 'unknown');
    const now = Date.now();
    this._ensureWindow(now);
    this._prune(now);

    this.steps += 1;
    if (this.steps > this.maxSteps) {
      throw new Error(`Agent step budget exceeded (${this.maxSteps}). Stop and report the blocker instead of looping.`);
    }

    const toolCount = (this.calls.get(name) || 0) + 1;
    this.calls.set(name, toolCount);
    if (toolCount > this.maxSameTool) {
      throw new Error(`Repeated tool blocked: ${name} was called ${toolCount} times in the active window. Change strategy.`);
    }

    const signature = this._signature(name, args);
    const previous = this.signatures.get(signature);
    const repeats = previous ? previous.count + 1 : 1;
    this.signatures.set(signature, { count: repeats, at: now });
    if (repeats > this.maxSameCall) {
      throw new Error(`Repeated identical tool call blocked: ${name}. Change strategy or report the blocker.`);
    }

    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool timed out after ${this.stepTimeoutMs}ms: ${name}`)), this.stepTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { ExecutionGuard };
