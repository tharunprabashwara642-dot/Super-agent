// Production startup intentionally avoids legacy source-mutation patches.
// All agent planning, provider wiring, search, memory, verification and live
// activity now live in the real Gemini runtime. Keeping old text-rewrite
// patches out of the boot chain prevents stale-provider/scope failures.
console.log('✅ Legacy source-mutation patches disabled; using Gemini runtime directly.');
