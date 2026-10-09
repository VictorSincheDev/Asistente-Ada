#!/usr/bin/env node
// Hook de Claude Code: reenvía el evento (JSON por stdin) a la hadita.
// Nunca bloquea a Claude: si la hadita no está abierta, sale en silencio.
const http = require('http');
const PORT = Number(process.env.HADITA_PORT) || 4577;

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST', timeout: 400,
      headers: { 'Content-Type': 'application/json' } },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(input || '{}');
});
