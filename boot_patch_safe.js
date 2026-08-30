// Safe startup patches only. Avoid stale source-text patches in production.
try { require('./boot_patch.js'); } catch (error) { console.error('⚠️ Optional boot patch failed; continuing startup:', error?.stack || error?.message || error); }
// The legacy document V2 patch is intentionally not loaded: document routing
// now belongs to the real Gemini runtime and should not depend on exact source text.
try { require('./runtime_pdf_delivery_v3.js'); } catch (error) { console.error('⚠️ PDF/live V3 patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_routing_v4.js'); } catch (error) { console.error('⚠️ Document routing V4 patch failed; continuing startup:', error?.stack || error?.message || error); }
