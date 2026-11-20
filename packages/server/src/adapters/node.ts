import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';

/**
 * Node `http` <-> Web `Request`/`Response`. No framework imports: Express (4 and 5) passes the same IncomingMessage and
 * ServerResponse, so one adapter serves plain `http.createServer` and Express.
 */

/** What the adapter needs from the server: answer a Web Request, and say up front whether a route exists. */
export interface WebHandler {
  handler(request: Request): Promise<Response>;
  matches(method: string, pathname: string): boolean;
}

export interface NodeHandlerOptions {
  /**
   * Path prefix to strip before routing, for plain `http` servers that mount us under a prefix (`/chat`). Express strips
   * its own mount path (req.url is already relative), so leave this unset there.
   */
  root?: string;
}

export type NodeHandler = (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => void;

const BODYLESS = new Set(['GET', 'HEAD']);

export function normalizeRoot(root: string | undefined): string {
  if (!root || root === '/') return '';
  return '/' + root.replace(/^\/+|\/+$/g, '');
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return headers;
}

type Parsed = { body?: BodyInit | null; error?: { status: number; code: string; message: string } };

/**
 * The request body, per decision D7:
 *  - stream still unread (the preferred setup: mounted before any body parser, or a parser that skipped this content type):
 *    stream it as is, so multipart uploads stay streaming and the size limit is enforced by the handler while reading;
 *  - already consumed as parsed JSON (`express.json()` ran): re-serialise it;
 *  - any other consumed body (urlencoded, raw, a global multipart parser): a clear error naming the fix.
 */
function bodyOf(req: IncomingMessage, headers: Headers): Parsed {
  if (BODYLESS.has((req.method ?? 'GET').toUpperCase())) return {};
  if (!req.readableEnded && !req.destroyed) return { body: Readable.toWeb(req) as unknown as ReadableStream };

  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  const type = (headers.get('content-type') ?? '').toLowerCase();
  const declared = headers.get('content-length');
  const sentNothing = declared === '0' || (declared === null && headers.get('transfer-encoding') === null);
  if (sentNothing) return {};
  if (type.includes('json') && parsed !== null && typeof parsed === 'object' && !Buffer.isBuffer(parsed)) {
    return { body: JSON.stringify(parsed) };
  }
  return {
    error: {
      status: 500,
      code: 'body_already_consumed',
      message:
        'The request body was already read by another middleware, so Messaging Express cannot read it. Mount the chat middleware BEFORE body parsers (recommended), or limit the parser to your own routes. A global express.json() is tolerated; urlencoded, raw and multipart parsers are not.',
    },
  };
}

export function toWebRequest(req: IncomingMessage, signal: AbortSignal, root = ''): { request?: Request; error?: NonNullable<Parsed['error']> } {
  const headers = toHeaders(req);
  const raw = req.url ?? '/';
  const path = root && (raw === root || raw.startsWith(root + '/') || raw.startsWith(root + '?')) ? raw.slice(root.length) || '/' : raw;
  const host = headers.get('host') ?? 'localhost';
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const { body, error } = bodyOf(req, headers);
  if (error) return { error };
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal };
  if (body !== undefined && body !== null) {
    init.body = body;
    init.duplex = 'half';
  }
  return { request: new Request(`${proto}://${host}${path.startsWith('/') ? path : '/' + path}`, init) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Write a Web Response to the ServerResponse: status, headers (Set-Cookie as separate headers), streamed body. */
export async function writeWebResponse(response: Response, res: ServerResponse, method: string): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body || method === 'HEAD') {
    res.end();
    return;
  }
  const source = Readable.fromWeb(response.body as never);
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    res.once('close', () => {
      source.destroy(); // client went away: stop reading the body
      done();
    });
    source.once('error', () => {
      res.destroy(); // headers are gone already; cutting the connection is the only honest signal
      done();
    });
    source.once('end', done);
    source.pipe(res);
  });
}

/**
 * Build the (req, res, next) function for `http.createServer` or Express.
 * Unknown routes call `next()` when there is one (Express: the customer's own routes keep working), else answer 404.
 * Nothing thrown here reaches the client except a generic 500: no stack traces, no messages.
 */
export function createNodeHandler(server: WebHandler, options: NodeHandlerOptions = {}, onError: (error: unknown) => void = () => {}): NodeHandler {
  const root = normalizeRoot(options.root);
  return (req, res, next) => {
    void (async () => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const raw = req.url ?? '/';
        if (root && !(raw === root || raw.startsWith(root + '/') || raw.startsWith(root + '?'))) {
          return next ? next() : sendJson(res, 404, { error: { message: 'Not found', code: 'NOT_FOUND' } });
        }
        const pathname = new URL(root ? raw.slice(root.length) || '/' : raw, 'http://x').pathname;
        if (!server.matches(method, pathname)) {
          return next ? next() : sendJson(res, 404, { error: { message: 'Not found', code: 'NOT_FOUND' } });
        }

        const abort = new AbortController();
        res.once('close', () => {
          if (!res.writableFinished) abort.abort();
        });
        const { request, error } = toWebRequest(req, abort.signal, root);
        if (error) return sendJson(res, error.status, { error: { message: error.message, code: error.code } });
        const response = await server.handler(request!);
        await writeWebResponse(response, res, method);
      } catch (error) {
        onError(error);
        sendJson(res, 500, { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
      }
    })();
  };
}
