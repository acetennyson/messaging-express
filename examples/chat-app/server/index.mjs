// Chat demo server: your Express app with Messaging Express embedded at /chat, plus a demo sign-in.
// DEMO ONLY: /auth/login lets anyone sign in as any name. Replace it with your real login before you ship.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { MessagingServer } from '@messaging-express/server';
import { createClient } from '@messaging-express/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const secret = process.env.CHAT_JWT_SECRET;
const database = process.env.DATABASE_URL;
if (!database || !secret || secret.length < 32) {
  console.error('Set DATABASE_URL and CHAT_JWT_SECRET (32+ characters). See .env.example.');
  process.exit(1);
}
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:5173'; // Vite dev server

const chat = await MessagingServer.init({
  database,
  jwtSecret: secret,
  schema: 'messaging',
  autoMigrate: true, // demo only: in production run `npx messaging-express migrate` on deploy
  upload: { type: 'local', options: { dir: path.resolve(process.env.UPLOAD_DIR || './data/uploads'), baseUrl: `${origin}/chat` } },
  cors: [webOrigin],
});

const sign = (claims, expiresIn) => jwt.sign(claims, secret, { expiresIn });
// The server talks to its own chat API as an admin-level "api" caller.
const admin = createClient({ baseUrl: `http://127.0.0.1:${port}/chat`, token: () => sign({ type: 'api' }, '5m') });

const app = express();
chat.middleware(app, '/chat'); // BEFORE any body parser
app.use(express.json());

app.post('/auth/login', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Pick a name between 2 and 40 characters.' });
  const externalId = name.toLowerCase();
  try {
    const user = await admin.users.upsert({ externalId, name });
    const token = sign({ type: 'user', userId: user.id }, '12h');
    res.json({ user: { id: user.id, name: user.name ?? name }, token });
  } catch (err) {
    console.error('login failed', err);
    res.status(502).json({ error: 'Chat service is not answering. Try again in a moment.' });
  }
});

const dist = path.join(here, '../web/dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => (req.method === 'GET' && !req.path.startsWith('/chat') ? res.sendFile(path.join(dist, 'index.html'), (e) => e && next()) : next()));

const server = http.createServer(app);
await chat.attachRealtime(server); // Socket.IO at /chat/socket.io
server.listen(port, () => console.log(`chat demo: ${origin}`));

let closing = false;
const stop = async () => { if (closing) return; closing = true; server.close(); await chat.close({ timeoutMs: 5000 }); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
