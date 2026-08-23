const assert = require("assert");
const brain = require("./anthropic_brain");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("normalizeSchema:");
check("maps Gemini uppercase types to JSON Schema", () => {
  const out = brain.normalizeSchema({
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "the name" },
      count: { type: "INTEGER" },
      tags: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["name"],
  });
  assert.strictEqual(out.type, "object");
  assert.strictEqual(out.properties.name.type, "string");
});

console.log("chatShimmed (no key configured):");
(async () => {
  const res = await brain.chatShimmed([{ role: "user", parts: [{ text: "hi" }] }], null, null);
  assert.ok(res.error, "expected an error object");
  passed++;
  console.log("  ✓ returns a Gemini-shaped error when no keys are set");
  console.log(`\n✅ ${passed} checks passed.`);
})().catch((e) => {
  console.error("\n❌ FAILED:", e.message);
  process.exit(1);
});
