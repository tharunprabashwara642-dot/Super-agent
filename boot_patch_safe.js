// Safe startup patches only. Avoid source-text mutation patches whose exact
// markers become stale after runtime refactors.
try { require('./boot_patch.js'); } catch (error) { console.error('⚠️ Optional boot patch failed; continuing startup:', error?.stack || error?.message || error); }
// The legacy runtime_document_patch_v2 exact-string patch is intentionally
// disabled. Document routing now belongs to the actual Gemini runtime.
// The old runtime_live_activity_patch is intentionally disabled because the
// real runtime owns the single editable Telegram activity card.
try { require('./runtime_pdf_delivery_v3.js'); } catch (error) { console.error('⚠️ PDF/live V3 patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_routing_v4.js'); } catch (error) { console.error('⚠️ Document routing V4 patch failed; continuing startup:', error?.stack || error?.message || error); }
