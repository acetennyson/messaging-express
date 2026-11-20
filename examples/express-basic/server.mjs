// Messaging Express inside your own Express app. Run: DATABASE_URL=... CHAT_JWT_SECRET=<32+ chars> node server.mjs
import express from 'express';
import http from 'node:http';
import { MessagingServer } from '@messaging-express/server';

const port = Number(process.env.PORT || 3000);
const chat = await MessagingServer.init({
  database: process.env.DATABASE_URL, // your Postgres
  jwtSecret: process.env.CHAT_JWT_SECRET, // 32+ characters; anyone who knows it can mint chat tokens
  schema: 'messaging', // the tables live here, away from yours
  autoMigrate: true, // demo only: in production run `npx messaging-express migrate` on deploy
  upload: { type: 'local', options: { dir: './chat-uploads', baseUrl: `http://localhost:${port}/chat` } },
  cors: ['http://localhost:5173'], // your front end's origin
});

const app = express();
chat.middleware(app, '/chat'); // BEFORE any body parser
app.use(express.json());
app.get('/', (_req, res) => res.send('my app, with chat at /chat'));

const server = http.createServer(app);
await chat.attachRealtime(server); // Socket.IO at /chat/socket.io
server.listen(port, () => console.log(`chat: http://localhost:${port}/chat/meta`));
process.on('SIGTERM', async () => { server.close(); await chat.close(); });
