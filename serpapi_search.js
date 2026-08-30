'use strict';

function getKey() {
  return String(process.env.SERPAPI_API_KEY || '').trim();
}

function text(value, max = 5000) {
  return String(value == null ? '' : value).slice(0, max);
}

async function serpapiSearch(args = {}, { signal } = {}) {
  const apiKey = getKey();
  if (!apiKey) throw new Error('SERPAPI_API_KEY is not configured.');

  const q = text(args.query || args.q, 500);
  if (!q.trim()) throw new Error('Search query is required.');

  const params = new URLSearchParams({
    engine: text(args.engine || 'google', 40),
    q,
    api_key: apiKey,
    num: String(Math.min(Math.max(Number(args.num) || 8, 1), 10)),
    hl: text(args.hl || 'en', 10),
    safe: 'active',
  });
  if (args.location) params.set('location', text(args.location, 200));

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason || new Error('Search cancelled'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(`https://serpapi.com/search.json?${params}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(text(body.error || `SerpAPI HTTP ${response.status}`, 1000));
    if (body.error) throw new Error(text(body.error, 1000));

    return {
      provider: 'serpapi',
      query: q,
      results: (body.organic_results || []).slice(0, 10).map((item, i) => ({
        position: i + 1,
        title: text(item.title, 500),
        url: text(item.link, 2000),
        snippet: text(item.snippet, 1200),
        source: text(item.source || '', 300),
      })),
      answer_box: body.answer_box ? {
        title: text(body.answer_box.title, 300),
        answer: text(body.answer_box.answer || body.answer_box.snippet, 2500),
        link: text(body.answer_box.link, 2000),
      } : null,
    };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

module.exports = { serpapiSearch };
