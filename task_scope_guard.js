// Task-scope firewall: prevents the model from silently switching the user's
// current task to an unrelated tool/action. Loaded before index.js.
const brain = require("./gemini_brain");
const originalChat = brain.chatShimmed;

const WEBSITE_TOOLS = new Set([
  "deploy_website",
  "deploy_multipage_website",
  "deploy_github_repo_to_railway",
  "delete_deployed_site",
  "list_deployed_sites",
]);

const DOCUMENT_HINTS = /\b(pdf|doc|docx|document|paper|model\s*paper|worksheet|report|presentation|pptx?|spreadsheet|xlsx|certificate|proposal)\b/i;
const WEBSITE_HINTS = /\b(website|web\s*site|webpage|web\s*page|landing\s*page|site|vercel|deploy\s+(?:the|a|this)?\s*(?:website|site|app|repo)|host\s+(?:the|a|this)?\s*(?:website|site|app))\b/i;
const NEGATIVE_WEBSITE = /\b(no\s+website|not\s+(?:a\s+)?website|website\s+e?pa|website\s+epa|website\s+one\s+e?pa)\b/i;

function latestUserText(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const m = contents[i];
    if (m?.role !== "user" || !Array.isArray(m.parts)) continue;
    const texts = m.parts.filter((p) => typeof p?.text === "string").map((p) => p.text.trim()).filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  return "";
}

function websiteAllowedForRequest(text) {
  if (!text) return false;
  if (NEGATIVE_WEBSITE.test(text)) return false;
  return WEBSITE_HINTS.test(text);
}

brain.chatShimmed = async (...args) => {
  const contents = Array.isArray(args[0]) ? args[0] : [];
  const currentRequest = latestUserText(contents);
  const result = await originalChat(...args);
  const parts = result?.candidates?.[0]?.content?.parts || [];
  const calls = parts.filter((p) => p?.functionCall);
  if (!calls.length) return result;

  const isDocumentTask = DOCUMENT_HINTS.test(currentRequest);
  const websiteAllowed = websiteAllowedForRequest(currentRequest);
  const blocked = [];
  const kept = [];

  for (const part of parts) {
    const call = part?.functionCall;
    if (!call) {
      kept.push(part);
      continue;
    }

    if (WEBSITE_TOOLS.has(call.name) && !websiteAllowed) {
      blocked.push(call.name);
      continue;
    }
    kept.push(part);
  }

  if (!blocked.length) return result;

  console.warn(`🛑 Task-scope guard blocked unrelated tool(s): ${blocked.join(", ")} | request=${currentRequest.slice(0, 180)}`);

  // If this is a document/artifact request, explicitly steer the next model
  // round toward the artifact tool instead of letting old conversation turns
  // pull it into a website/deployment workflow.
  const steering = isDocumentTask
    ? `Task-scope guard: the current user request is a DOCUMENT/ARTIFACT task. Do NOT build, deploy, list, or delete a website. Continue only with tools that create, validate, format, or deliver the requested document/file. The user's current request is authoritative over older conversation context.`
    : `Task-scope guard: the current user request does not ask for a website or deployment. Do NOT perform website/deployment actions. Follow the current request exactly; older conversation context cannot replace it.`;

  // Keep non-tool text, but append the steering instruction as a model note.
  // The chat loop will then receive the tool results from any kept calls and
  // can choose the correct tool on the next round.
  const filtered = kept.filter((p) => p?.text !== steering);
  filtered.push({ text: steering });

  return {
    ...result,
    candidates: result.candidates.map((candidate, index) =>
      index === 0 ? { ...candidate, content: { ...(candidate.content || {}), parts: filtered } } : candidate
    ),
  };
};

console.log("🧭 Task-scope firewall loaded");
