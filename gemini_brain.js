// ============================================================
// GEMINI BRAIN — reliable Gemini text + tool-calling shim.
// ============================================================
const { GoogleGenAI } = require("@google/genai");
function parseKeys() { return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean); }
let apiKeys = parseKeys(), cursor = 0;
const clientCache = new Map(); let usageCallback = null;
function getClient(key) { if (!clientCache.has(key)) clientCache.set(key, new GoogleGenAI({ apiKey: key })); return clientCache.get(key); }
function keyCount() { return apiKeys.length; }
function setUsageCallback(fn) { usageCallback = fn; }
function addKeyToPool(rawKey) { const key = String(rawKey || "").trim(); if (!key) return { added:false,total_keys:apiKeys.length }; if (apiKeys.includes(key)) return {added:false,total_keys:apiKeys.length}; apiKeys.push(key); return {added:true,total_keys:apiKeys.length}; }
const DEFAULT_MODEL = () => process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const MAX_TOKENS = () => { const n = Number.parseInt(process.env.GEMINI_MAX_TOKENS || "16000",10); return Number.isFinite(n)&&n>0?Math.min(n,65536):16000; };
function isTransientError(e) { const s=Number(e&&(e.status||e.code)); const m=String(e?.message||""); return s===408||s===429||s>=500||/rate.?limit|resource.?exhausted|unavailable|overloaded|timeout|timed out|fetch failed/i.test(m); }
function normaliseCandidate(resp) { const c=resp?.candidates?.[0]; if(!c||!c.content){const r=resp?.promptFeedback?.blockReason;return {error:{message:r?`Gemini blocked the request: ${r}`:"Gemini returned no candidates."}};} return {candidates:[{content:c.content}]}; }
function extractUserText(contents){const l=contents?.[contents.length-1];return l?.parts?.filter(p=>p.text).map(p=>p.text).join("\n")||"";}
function requestedExactCount(text){const s=String(text||"");for(const re of [/(?:exactly|total|give me|make|create|generate|write)\s+(\d{1,3})\s+(?:questions|items|examples|steps|points|records|rows|sentences)/i,/(\d{1,3})\s*(?:ක්|ක්\s*දෙන|ප්‍රශ්න|questions)/i,/ප්‍රශ්න\s*(\d{1,3})/i]){const m=s.match(re);if(m)return Number(m[1]);}return null;}
function countNumberedItems(text){const m=String(text||"").match(/(?:^|\n)\s*(?:\d{1,3}[.)]|Q\s*\d{1,3}[.:])/g);return m?m.length:0;}
async function rawGenerate(contents,systemInstruction,tools,modelOverride,timeoutMs=60000,extraConfig={}){
 if(!apiKeys.length)return {error:{message:"No GEMINI_API_KEY configured."}}; if(!Array.isArray(contents)||!contents.length)return {error:{message:"No messages to send."}};
 const model=modelOverride&&String(modelOverride).startsWith("gemini")?String(modelOverride):DEFAULT_MODEL(); let lastErr;
 for(let i=0;i<Math.max(apiKeys.length,1);i++){const keyIndex=cursor%apiKeys.length,key=apiKeys[keyIndex];cursor++;const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),Math.max(1000,Number(timeoutMs)||60000));try{const config={maxOutputTokens:MAX_TOKENS(),abortSignal:ac.signal,...extraConfig};if(systemInstruction)config.systemInstruction=systemInstruction;if(tools?.[0]?.functionDeclarations?.length)config.tools=tools;const resp=await getClient(key).models.generateContent({model,contents,config});if(typeof usageCallback==="function"){try{usageCallback();}catch(_){}}return normaliseCandidate(resp);}catch(e){lastErr=e;if(!isTransientError(e))return {error:{message:String(e?.message||"Gemini request failed.")}};console.error(`⚠️ Gemini key #${keyIndex+1} transient failure; rotating key.`);}finally{clearTimeout(timer);}}
 return {error:{message:String(lastErr?.message||"All Gemini API keys failed.")}};
}
async function expandExactCount(systemInstruction,model,baseResp,requested){
 let combined=(baseResp.candidates?.[0]?.content?.parts||[]).filter(p=>p.text).map(p=>p.text).join("").trim();
 for(let round=0;countNumberedItems(combined)<requested&&round<10;round++){const current=countNumberedItems(combined),need=requested-current;const prompt=`The user explicitly requested EXACTLY ${requested} numbered items. You already have ${current}. Produce ONLY the next ${Math.min(need,12)} new numbered items, continuing at ${current+1}. Do not repeat existing items. No introduction or conclusion. Existing tail:\n${combined.slice(-14000)}`;const r=await rawGenerate([{role:"user",parts:[{text:prompt}]}],systemInstruction,null,model,90000);if(r.error)break;const t=(r.candidates?.[0]?.content?.parts||[]).filter(p=>p.text).map(p=>p.text).join("").trim();if(!t)break;combined+=`\n${t}`;}
 const finalCount=countNumberedItems(combined); if(finalCount<requested)return {error:{message:`Could not complete the requested ${requested} items; generated ${finalCount}.`}}; return {candidates:[{content:{role:"model",parts:[{text:combined}]}}]};
}
async function chatShimmed(contents,systemInstruction,tools,modelOverride,timeoutMs=60000){const r=await rawGenerate(contents,systemInstruction,tools,modelOverride,timeoutMs);if(r.error||tools?.[0]?.functionDeclarations?.length)return r;const n=requestedExactCount(extractUserText(contents));if(!n||n>200)return r;return expandExactCount(systemInstruction,modelOverride,r,n);}
module.exports={chatShimmed,keyCount,addKeyToPool,setUsageCallback};
