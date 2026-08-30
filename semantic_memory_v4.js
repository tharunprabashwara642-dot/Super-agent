'use strict';

const { GoogleGenAI } = require('@google/genai');

const EMBEDDING_MODEL = process.env.AGENT_MEMORY_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIM = Number(process.env.AGENT_MEMORY_EMBEDDING_DIM || 768);
const DEFAULT_LIMIT = Number(process.env.AGENT_MEMORY_LIMIT || 8);

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  client = new GoogleGenAI({ apiKey });
  return client;
}

async function embed(text, taskType = 'RETRIEVAL_QUERY') {
  const ai = getClient();
  if (!ai || !text) return null;
  try {
    const result = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: String(text).slice(0, 12000),
      config: {
        outputDimensionality: EMBEDDING_DIM,
        taskType,
      },
    });
    const values = result?.embeddings?.[0]?.values;
    return Array.isArray(values) && values.length === EMBEDDING_DIM ? values : null;
  } catch (error) {
    console.warn(`⚠️ Semantic memory embedding failed: ${error.message}`);
    return null;
  }
}

async function searchSemanticMemory(supabase, query, limit = DEFAULT_LIMIT) {
  if (!supabase || !query) return [];
  const vector = await embed(query, 'RETRIEVAL_QUERY');
  if (!vector) return [];
  try {
    const { data, error } = await supabase.rpc('match_memories', {
      query_embedding: vector,
      match_count: Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 20)),
    });
    if (error) throw error;
    return (data || []).filter((row) => row && row.content).map((row) => ({
      id: row.id,
      content: String(row.content),
      similarity: Number(row.similarity || 0),
    }));
  } catch (error) {
    console.warn(`⚠️ Semantic memory search failed: ${error.message}`);
    return [];
  }
}

async function storeSemanticMemory(supabase, content) {
  if (!supabase || !content) return null;
  const vector = await embed(content, 'RETRIEVAL_DOCUMENT');
  if (!vector) return null;
  try {
    const { data, error } = await supabase
      .from('agent_memories')
      .insert({ content: String(content).slice(0, 12000), embedding: vector })
      .select('id, content, created_at')
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn(`⚠️ Semantic memory store failed: ${error.message}`);
    return null;
  }
}

module.exports = { embed, searchSemanticMemory, storeSemanticMemory, EMBEDDING_MODEL, EMBEDDING_DIM };