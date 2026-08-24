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
  const originalFetch = global.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { role: "model", parts: [{ text: "native Gemini works" }] } }] }) };
  };
  const gemini = await brain.chatShimmed([{ role: "user", parts: [{ text: "hello" }] }], "be helpful", [{ functionDeclarations: [] }]);
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  assert.strictEqual(gemini.candidates[0].content.parts[0].text, "native Gemini works");
  assert.match(captured.url, /generativelanguage\.googleapis\.com/);
  assert.strictEqual(captured.body.systemInstruction.parts[0].text, "be helpful");
  passed++;
  console.log("  ✓ uses Gemini's native API when GEMINI_API_KEY is configured");
  console.log(`\n✅ ${passed} checks passed.`);
})().catch((e) => {
  console.error("\n❌ FAILED:", e.message);
  process.exit(1);
});
