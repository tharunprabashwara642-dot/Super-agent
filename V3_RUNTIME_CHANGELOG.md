# V3 runtime refactor

- Added a semantic planner that extracts the complete user request into a structured TaskSpec.
- Removed dependency on action-intent regexes for the live Telegram/Web request path.
- Added real worker sub-agents with independent context, tool loops, verification, and repair.
- Added resumable V3 approvals using a dedicated callback namespace.
- Added CI configuration and focused runtime tests.
- Hardened the execution guard with AbortSignal support for tools that honor cancellation.

The existing 350KB `index.js` capability layer remains intact for integration compatibility; `web_boot.js` installs the V3 runtime as the live request layer.
