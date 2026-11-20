// Messaging Express on a plain Node http server (no framework). Run: DATABASE_URL=... CHAT_JWT_SECRET=<32+ chars> node server.mjs
import http from 'node:http';
import { MessagingServer } from '@messaging-express/server';

const port = Number(process.env.PORT || 3000);
const chat = await MessagingServer.init({
  database: process.env.DATABASE_URL,
  jwtSecret: process.env.CHAT_JWT_SECRET,
  autoMigrate: true, // demo only: in production run `npx messaging-express migrate` on deploy
  upload: { type: 'local', options: { dir: './chat-uploads', baseUrl: `http://localhost:${port}/chat` } },
});

const chatHandler = chat.nodeHandler({ root: '/chat' }); // we strip /chat; other paths get a 404 unless you handle them
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.end('my app, with chat at /chat');
  chatHandler(req, res);
});
await chat.attachRealtime(server);
server.listen(port, () => console.log(`chat: http://localhost:${port}/chat/meta`));
process.on('SIGTERM', async () => { server.close(); await chat.close(); });
