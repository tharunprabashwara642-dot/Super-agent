'use strict';

// Railway-friendly liveness/readiness endpoint. The Telegram bot itself does
// not need an HTTP server, but Railway health checks do. This tiny server is
// deliberately dependency-free and starts before index.js is loaded.
const http = require('http');

const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();
let shuttingDown = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const body = {
    ok: !shuttingDown,
    service: 'super-agent',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  };

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(body));
  }

  if (url.pathname === '/ready' || url.pathname === '/readyz') {
    const configured = Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const ready = !shuttingDown && configured;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ...body, ready, configured }));
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.on('error', (err) => {
  // Never crash the agent because a health endpoint could not bind. This is
  // especially useful when running locally beside another service.
  console.error(`⚠️ Health server unavailable on :${port}: ${err.message}`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`❤️ Health server listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shuttingDown = true;
    server.close(() => {});
  });
}

module.exports = { server };
