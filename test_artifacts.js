const assert = require("assert");
const fs = require("fs");
const { createArtifact, countNumberedItems } = require("./artifacts");

assert.strictEqual(countNumberedItems("1. One\n2) Two\nQ3: Three\nplain"), 3);
const rejected = createArtifact({ format: "html", title: "Questions", content: "1. Only one", expected_item_count: 2 });
assert.strictEqual(rejected.ok, false);
assert.match(rejected.error, /Expected exactly 2/);
for (const format of ["html", "docx", "pdf", "txt"]) {
  const result = createArtifact({ format, title: "Sample", content: "1. First question\n2. Second question", expected_item_count: 2, file_name: `sample-${format}` });
  assert.strictEqual(result.ok, true, format);
  assert.ok(fs.statSync(result.path).size > 20, format);
  const start = fs.readFileSync(result.path).subarray(0, 4).toString();
  if (format === "pdf") assert.strictEqual(start, "%PDF");
  if (format === "docx") assert.strictEqual(start, "PK\x03\x04");
  fs.unlinkSync(result.path);
}
console.log("✅ artifact checks passed");
