// Safe wrapper for optional source-code boot patches.
try {
  require('./boot_patch.js');
} catch (error) {
  console.error('⚠️ Optional boot patch failed; continuing startup:', error?.stack || error?.message || error);
}
try {
  require('./runtime_document_patch.js');
} catch (error) {
  console.error('⚠️ Document routing patch failed; continuing startup:', error?.stack || error?.message || error);
}
try {
  require('./runtime_document_patch_v2.js');
} catch (error) {
  console.error('⚠️ Document routing V2 patch failed; continuing startup:', error?.stack || error?.message || error);
}
try {
  require('./runtime_live_activity_patch.js');
} catch (error) {
  console.error('⚠️ Live activity patch failed; continuing startup:', error?.stack || error?.message || error);
}
