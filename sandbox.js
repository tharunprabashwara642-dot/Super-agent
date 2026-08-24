// ============================================================
// SANDBOX TERMINAL — isolated background workspace for self-testing code.
// ============================================================
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// The self-testing terminal is part of the bot's normal execution path, not
// an optional feature which silently disappears on a fresh deployment.  Keep
// it enabled by default; an operator can explicitly disable it with
// AGENT_ENABLE_SANDBOX=false if a host has a stricter policy.
const ENABLED = () => process.env.AGENT_ENABLE_SANDBOX !== "false";
const SANDBOX_DIR = path.resolve(process.env.SANDBOX_DIR || path.join(process.cwd(), "agent_sandbox"));
const TIMEOUT_MS = () => parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);

function ensureDir() {
  if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

function safeResolve(relPath) {
  const p = path.resolve(SANDBOX_DIR, relPath || "");
  const rel = path.relative(SANDBOX_DIR, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the sandbox — only paths inside the sandbox are allowed.`);
  }
  return p;
}

function writeFiles(files) {
  ensureDir();
  const written = [];
  for (const f of files || []) {
    if (!f || !f.path) continue;
    const abs = safeResolve(f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(f.content == null ? "" : f.content), "utf-8");
    written.push(path.relative(SANDBOX_DIR, abs).replace(/\\/g, "/"));
  }
  return written;
}

function listFiles() {
  ensureDir();
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out.push(path.relative(SANDBOX_DIR, abs).replace(/\\/g, "/"));
    }
  })(SANDBOX_DIR);
  return out;
}

function readFile(relPath) {
  const abs = safeResolve(relPath);
  return fs.readFileSync(abs, "utf-8");
}

function reset() {
  if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  ensureDir();
  return true;
}

function run(command, timeoutMs) {
  ensureDir();
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: SANDBOX_DIR,
        timeout: timeoutMs || TIMEOUT_MS(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          command,
          ok: !err,
          exit_code: err ? (err.code == null ? -1 : err.code) : 0,
          timed_out: !!(err && err.killed && err.signal === "SIGTERM"),
          stdout: String(stdout || "").slice(0, 8000),
          stderr: String(stderr || "").slice(0, 6000),
        });
      }
    );
  });
}

async function sandboxRun({ files, command, timeoutMs } = {}) {
  if (!ENABLED()) {
    return {
      error: true,
      message: "Sandbox is explicitly disabled by AGENT_ENABLE_SANDBOX=false.",
    };
  }
  try {
    const written = files && files.length ? writeFiles(files) : [];
    let cmd = command && command.trim();
    if (!cmd) {
      const firstJs = written.find((p) => p.endsWith(".js")) || written[0];
      cmd = firstJs ? `node --check "${firstJs}"` : "node --version";
    }
    const result = await run(cmd, timeoutMs);
    return { sandbox_dir: SANDBOX_DIR, files_written: written, ...result };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

module.exports = {
  sandboxRun,
  writeFiles,
  listFiles,
  readFile,
  reset,
  run,
  isEnabled: ENABLED,
  SANDBOX_DIR,
  safeResolve,
};
