// Safe startup patches: one broken optional patch must never stop the bot.
try { require('./boot_patch.js'); } catch (error) { console.error('⚠️ Optional boot patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_patch.js'); } catch (error) { console.error('⚠️ Document routing patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_patch_v2.js'); } catch (error) { console.error('⚠️ Document routing V2 patch failed; continuing startup:', error?.stack || error?.message || error); }
// The old runtime_live_activity_patch is intentionally disabled: index.js
// already owns the single editable live card and loading both produced
// duplicate Working/Completed messages.
try { require('./runtime_pdf_delivery_v3.js'); } catch (error) { console.error('⚠️ PDF/live V3 patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_routing_v4.js'); } catch (error) { console.error('⚠️ Document routing V4 patch failed; continuing startup:', error?.stack || error?.message || error); }
