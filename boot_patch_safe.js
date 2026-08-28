// Safe wrapper for optional source-code boot patches.
// A patch is an enhancement, not a reason for the Telegram bot to stay offline.
// boot_patch.js only writes index.js at the end, so if it throws before that
// point its in-memory changes are discarded and the original index.js remains
// intact. We therefore catch each optional patch independently and still let
// web_boot.js start.
try {
  require("./boot_patch.js");
} catch (error) {
  console.error("⚠️ Optional boot patch failed; continuing startup:", error?.stack || error?.message || error);
}

// First-class artifact routing is kept as a separate, idempotent patch so it
// can evolve without making the legacy boot patch more fragile. It runs after
// the legacy patch and before web_boot loads index.js.
try {
  require("./runtime_document_patch.js");
} catch (error) {
  console.error("⚠️ Document routing patch failed; continuing startup:", error?.stack || error?.message || error);
}
