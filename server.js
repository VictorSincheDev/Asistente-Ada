// Servidor local: recibe eventos por POST http://127.0.0.1:4577/event
const http = require('http');
const PORT = Number(process.env.HADITA_PORT) || 4577;

function start(onEvent) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        onEvent(JSON.parse(body));
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  server.listen(PORT, '127.0.0.1'); // solo local, nunca expuesto a la red
  return server;
}

module.exports = { start, PORT };
