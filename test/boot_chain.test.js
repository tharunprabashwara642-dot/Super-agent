const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('production boot chain is Gemini-only', () => {
  const pkg = JSON.parse(read('package.json'));
  const webBoot = read('web_boot.js');
  const bootV6 = read('boot_v6.js');
  const live = read('live_activity.js');

  assert.match(pkg.scripts.start, /boot_v6\.js/);
  assert.doesNotMatch(JSON.stringify(pkg.dependencies), /anthropic/i);
  assert.doesNotMatch(webBoot, /anthropic_brain|nvidiaChatShimmed/);
  assert.match(webBoot, /gemini_brain\.js/);
  assert.doesNotMatch(bootV6, /Anthropic|nvidiaChatShimmed/i);
  assert.match(bootV6, /serpapiSearch/);
  assert.match(bootV6, /semanticRecall/);
  assert.match(bootV6, /re-planning/);
  assert.match(live, /global\.__nightAgentWeb\?\.bot/);
});

test('stale V2 document patch is not in the production startup chain', () => {
  const safe = read('boot_patch_safe.js');
  assert.doesNotMatch(safe, /runtime_document_patch_v2\.js/);
});
