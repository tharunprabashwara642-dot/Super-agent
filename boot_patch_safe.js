// Safe startup patches: one broken optional patch must never stop the bot.
try { require('./boot_patch.js'); } catch (error) { console.error('⚠️ Optional boot patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_patch.js'); } catch (error) { console.error('⚠️ Document routing patch failed; continuing startup:', error?.stack || error?.message || error); }
try { require('./runtime_document_patch_v2.js'); } catch (error) { console.error('⚠️ Document routing V2 patch failed; continuing startup:', error?.stack || error?.message || error); }
// Do NOT load the old live-activity executor patch: index.js already owns the
// single editable live card. Loading both created duplicate Working/Completed
// messages. V3 below unifies execution and delivery instead.
try { require('./runtime_pdf_delivery_v3.js'); } catch (error) { console.error('⚠️ PDF/live V3 patch failed; continuing startup:', error?.stack || error?.message || error); }
