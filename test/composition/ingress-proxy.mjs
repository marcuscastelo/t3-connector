// Ingress stand-in for the composition harness: a plain HTTP reverse proxy run as a child process
// so a transport supervisor can relaunch it. Fault injection comes from a mode file, read per
// request, and is consumed once:
//   normal         forward and relay
//   drop-response  forward, wait for the full upstream response, then exit(1) without replying
//                  (the request reached the server; the response is lost)
// Usage: node ingress-proxy.mjs <listenPort> <upstreamPort> <modeFile>
import { createServer, request } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [listenPort, upstreamPort, modeFile] = process.argv.slice(2);
const takeMode = () => {
  if (!existsSync(modeFile)) return 'normal';
  const m = readFileSync(modeFile, 'utf8').trim() || 'normal';
  if (m !== 'normal') writeFileSync(modeFile, 'normal');
  return m;
};

const server = createServer((req, res) => {
  const mode = req.url.startsWith('/mcp') && req.method === 'POST' ? takeMode() : 'normal';
  const up = request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, upRes => {
    const parts = [];
    upRes.on('data', c => parts.push(c));
    upRes.on('end', () => {
      if (mode === 'drop-response') { process.stderr.write('ingress: response dropped\n'); process.exit(1); }
      res.writeHead(upRes.statusCode, upRes.headers);
      res.end(Buffer.concat(parts));
    });
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
  req.pipe(up);
});
server.listen(Number(listenPort), '127.0.0.1', () => process.stderr.write(`ingress: listening ${listenPort} -> ${upstreamPort}\n`));
