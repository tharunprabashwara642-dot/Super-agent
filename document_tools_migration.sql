-- ============================================================
-- Document/model-paper capability
-- Run once in Supabase SQL Editor, then restart the bot.
-- ============================================================

create table if not exists agent_custom_tools (
  name text primary key,
  description text not null default '',
  parameters_json text not null default '{"type":"OBJECT","properties":{}}',
  code text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into agent_custom_tools (name, description, parameters_json, code, enabled, updated_at)
values (
  'create_model_paper_document',
  'Create an exact-count model paper and send it as a Word-compatible document.',
  '{"type":"object","properties":{"topic":{"type":"string"},"count":{"type":"integer"},"language":{"type":"string"},"title":{"type":"string"}},"required":["topic","count"]}',
  $tool$
const count = Math.max(1, Math.min(Number(args.count) || 50, 200));
const topic = args.topic || "ICT";
const language = args.language || "Sinhala";
const title = args.title || `${topic} Model Paper`;
const key = ctx.env.GEMINI_API_KEY || (ctx.env.GEMINI_API_KEYS || "").split(",")[0];
if (!key) return { created: false, reason: "No GEMINI_API_KEY configured." };

function esc(s) {
  let out = "";
  for (const ch of String(s || "")) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\\n") out += "\\line ";
    else if (cp >= 32 && cp <= 126) out += ch;
    else {
      const units = [];
      if (cp <= 0xFFFF) units.push(cp);
      else { const x = cp - 0x10000; units.push(0xD800 + (x >> 10), 0xDC00 + (x & 0x3FF)); }
      for (const u of units) out += `\\u${u > 32767 ? u - 65536 : u}?`;
    }
  }
  return out;
}

async function gen(prompt) {
  const r = await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ctx.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash")}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 12000 } })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `Gemini HTTP ${r.status}`);
  return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
}

const questions = [];
const seen = new Set();
for (let round = 0; questions.length < count && round < 20; round++) {
  const need = Math.min(8, count - questions.length);
  const raw = await gen(`Create EXACTLY ${need} NEW multiple-choice questions for ${topic}. Language: ${language}. Return ONLY JSON: {"questions":[{"text":"...","options":["A","B","C","D"],"answer":"A"}]}. Four distinct options and one correct answer. Do not repeat these existing questions:\n${questions.slice(-15).map(q => q.text).join("\n") || "(none)"}`);
  let parsed = null;
  try { parsed = JSON.parse(raw.replace(/^```json\\s*/i, "").replace(/```/g, "").trim()); } catch (_) {}
  for (const q of (parsed?.questions || [])) {
    const text = String(q.text || "").trim();
    const opts = Array.isArray(q.options) ? q.options.map(x => String(x).trim()).filter(Boolean).slice(0, 4) : [];
    const ans = String(q.answer || "").trim();
    const k = text.toLowerCase().replace(/\\s+/g, " ");
    if (text && opts.length === 4 && ans && !seen.has(k)) { seen.add(k); questions.push({ text, options: opts, answer: ans }); }
    if (questions.length >= count) break;
  }
}

if (questions.length !== count) return { created: false, reason: `Generated ${questions.length}/${count} valid questions only.` };

let rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\viewkind4\\uc1\\pard\\qc\\b\\fs32 ${esc(title)}\\b0\\fs24\\par\\pard\\sa180`;
questions.forEach((q, i) => {
  rtf += `\\b ${i + 1}.\\b0 ${esc(q.text)}\\par`;
  q.options.forEach((o, j) => { rtf += `    ${String.fromCharCode(65 + j)}. ${esc(o)}\\par`; });
  rtf += "\\par";
});
rtf += "}";

const token = ctx.env.TELEGRAM_BOT_TOKEN;
const chatId = ctx.env.NIGHT_AGENT_CHAT_ID;
if (!token || !chatId) return { created: false, reason: "Telegram credentials are not configured." };

const fd = new FormData();
fd.append("chat_id", chatId);
fd.append("document", new Blob([Buffer.from(rtf, "utf8")], { type: "application/rtf" }), `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${count}.doc`);
const send = await ctx.fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: fd });
const sendData = await send.json();
if (!send.ok || !sendData.ok) return { created: false, reason: sendData.description || `Telegram HTTP ${send.status}` };
return { created: true, question_count: count, file_name: `${title}-${count}.doc`, telegram_file_id: sendData.result?.document?.file_id, note: "Document sent to Telegram as a Word-compatible .doc file." };
  $tool$,
  true,
  now()
)
on conflict (name) do update set
  description = excluded.description,
  parameters_json = excluded.parameters_json,
  code = excluded.code,
  enabled = true,
  updated_at = now();
