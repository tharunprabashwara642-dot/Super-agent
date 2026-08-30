const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('production boot chain uses V5 directly and no stale NVIDIA brain reference remains in boot entrypoints', () => {
  const pkg = JSON.parse(read('package.json'));
  const webBoot = read('web_boot.js');
  const bootV4 = read('boot_v4.js');
  const bootV5 = read('boot_v5.js');

  assert.match(pkg.scripts.start, /boot_v5\.js/);
  assert.doesNotMatch(webBoot, /nvidiaChatShimmed/);
  assert.doesNotMatch(bootV4, /nvidiaChatShimmed/);
  assert.match(webBoot, /anthropic_brain\.js.*chatShimmed/);
  assert.match(bootV5, /require\('\.\/web_boot\.js'\)/);
});

test('V5 production bootstrap owns search, memory, planning, worker, and status wiring', () => {
  const bootV5 = read('boot_v5.js');
  for (const marker of [
    'serpapiSearch',
    'semanticRecall',
    'runtime._plan',
    'runtime._runWorker',
    'runtime._status',
    'qualityPolicy',
    're-planning with a different strategy',
  ]) {
    assert.ok(bootV5.includes(marker), `missing V5 wiring marker: ${marker}`);
  }
});
