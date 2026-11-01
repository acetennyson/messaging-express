// Tiny static server for the playground (no dependencies). Serves ./playground and the frozen vectors at /vectors.json.
//   npm run playground -w @messaging-express/client-crypto      then open http://localhost:5174
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5174);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.map': 'application/json' };
export const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  const file = url === '/vectors.json' ? path.join(here, '..', 'test', 'vectors', 'vectors.json') : path.join(here, url === '/' ? 'index.html' : url);
  if (!file.startsWith(here) && url !== '/vectors.json') { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  });
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(port, () => console.log(`playground on http://localhost:${port}`));
