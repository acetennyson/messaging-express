import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Handler = (req: Recorded, res: http.ServerResponse) => void | Promise<void>;

/** A tiny HTTP server standing in for the API and for object storage. */
export async function startMockServer(handler: Handler) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rec: Recorded = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(rec);
      try {
        await handler(rec, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
