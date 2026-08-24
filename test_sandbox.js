const assert = require("assert");
const sandbox = require("./sandbox");

async function main() {
  const original = process.env.AGENT_ENABLE_SANDBOX;
  delete process.env.AGENT_ENABLE_SANDBOX;
  assert.strictEqual(sandbox.isEnabled(), true, "sandbox must be on without configuration");

  const result = await sandbox.sandboxRun({
    files: [{ path: "sandbox-default-test.js", content: "console.log('sandbox works');" }],
    command: "node sandbox-default-test.js",
  });
  assert.strictEqual(result.ok, true, result.stderr || result.message);
  assert.match(result.stdout, /sandbox works/);

  process.env.AGENT_ENABLE_SANDBOX = "false";
  assert.strictEqual(sandbox.isEnabled(), false, "false must be the explicit kill switch");
  const disabled = await sandbox.sandboxRun({ command: "node --version" });
  assert.strictEqual(disabled.error, true);

  if (original === undefined) delete process.env.AGENT_ENABLE_SANDBOX;
  else process.env.AGENT_ENABLE_SANDBOX = original;
  sandbox.reset();
  console.log("sandbox default-enable tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
