/**
 * Start the embedded module on a port, for the golden script and manual checks (dev/test only).
 *
 *   DATABASE_URL=... JWT_SECRET=... npx tsx scripts/embedded-server.ts <http|express4|express5|express4-json> <port> [schema]
 *
 * Env: EMBEDDED_ROOT (default /chat; '/' mounts at the root), EMBEDDED_SOCKET_PATH (default <root>/socket.io), EMBEDDED_REALTIME=0 to skip
 * Socket.IO. The project id is printed so scripts that write rows directly can use it (PROJECT_ID).
 * Mounted under /chat by default, so run the golden script with BASE_URL=http://localhost:<port>/chat and GOLDEN_API_ONLY=1.
 * Modes: http (plain http.createServer with root '/chat'), express4, express5, express4-json (express.json() mounted
 * BEFORE the chat middleware: the compatibility path of decision D7).
 */
import http from 'http';
import { createRequire } from 'module';
import { MessagingServer } from '../packages/server/src';

const [mode = 'http', portArg = '3100', schema = 'embedded_golden'] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const root = process.env.EMBEDDED_ROOT ?? '/chat';
const socketPath = process.env.EMBEDDED_SOCKET_PATH ?? `${root === '/' ? '' : root}/socket.io`;

async function main() {
  const database = process.env.DATABASE_URL!;
  const jwtSecret = process.env.JWT_SECRET!;
  await MessagingServer.migrate({ database, schema });
  // The hosted baseline answers with Access-Control-Allow-Origin: *, so the golden run opens CORS to any origin.
  // EMBEDDED_UPLOAD_DIR turns on local uploads (served under the module root), for the attachment checks.
  const uploadDir = process.env.EMBEDDED_UPLOAD_DIR;
  const chat = await MessagingServer.init({
    database, jwtSecret, schema, cors: ['*'],
    ...(uploadDir ? { upload: { type: 'local' as const, options: { dir: uploadDir, baseUrl: `http://localhost:${portArg}${root === '/' ? '' : root}` } } } : {}),
  });

  let server: http.Server;
  if (mode === 'http') {
    server = http.createServer(chat.nodeHandler({ root }));
  } else {
    const express = require(mode.startsWith('express5') ? 'express5' : 'express4');
    const app = express();
    if (mode.endsWith('-json')) app.use(express.json());
    chat.middleware(app, root);
    app.get('/mine', (_req: unknown, res: { json(x: unknown): void }) => res.json({ mine: true }));
    server = http.createServer(app);
  }
  if (process.env.EMBEDDED_REALTIME !== '0') await chat.attachRealtime(server, { path: socketPath });
  server.listen(Number(portArg), () => console.log(`embedded ${mode} listening on ${portArg} project=${chat.projectId} socketPath=${socketPath}`));
  const stop = async () => {
    server.close();
    await chat.close({ timeoutMs: 2000 });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
