'use strict';

const GEMINI_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const DIMENSIONS = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 768);
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, rows: [] };

function key() { return String(process.env.GEMINI_API_KEY || '').trim(); }
function norm(s) { return String(s || '').trim(); }
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

async function embed(text) {
  const apiKey = key();
  if (!apiKey || !norm(text)) return null;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: norm(text).slice(0, 8000) }] },
      outputDimensionality: DIMENSIONS,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Embedding HTTP ${response.status}`);
  return body?.embedding?.values || null;
}

async function fetchRows(supabase, limit = 40) {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS && cache.rows.length) return cache.rows;
  const { data, error } = await supabase.from('agent_memories')
    .select('id, content, created_at, embedding')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  cache = { at: now, rows: data || [] };
  return cache.rows;
}

async function semanticRecall(supabase, query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  const rows = await fetchRows(supabase, 40);
  if (!rows.length) return [];

  if (key()) {
    const qv = await embed(q).catch(() => null);
    if (qv) {
      const scored = await Promise.all(rows.map(async (row) => {
        let v = row.embedding;
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch (_) { v = null; }
        }
        if (!Array.isArray(v) || !v.length) v = await embed(row.content).catch(() => null);
        return v ? { ...row, similarity: cosine(qv, v) } : null;
      }));
      return scored.filter(Boolean).sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit).filter(x => x.similarity >= 0.25).map(x => x.content);
    }
  }

  const terms = q.toLowerCase().split(/\s+/).filter(x => x.length > 2);
  return rows.map(r => ({ r, score: terms.reduce((n, t) => n + (norm(r.content).toLowerCase().includes(t) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.r.content);
}

function invalidateMemoryCache() { cache = { at: 0, rows: [] }; }
module.exports = { semanticRecall, invalidateMemoryCache };
