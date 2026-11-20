// A client talking to the examples above. Run: CHAT_JWT_SECRET=<same secret> node plain.mjs [baseUrl]
// In your app the token comes from YOUR backend after it logs the user in. It is signed here only to keep the demo short.
import jwt from 'jsonwebtoken';
import { createClient } from '@messaging-express/client';

const baseUrl = process.argv[2] || 'http://localhost:3000/chat';
const sign = (claims) => jwt.sign(claims, process.env.CHAT_JWT_SECRET, { expiresIn: '1h' });
const admin = createClient({ baseUrl, token: () => sign({ type: 'api' }) });

const ada = await admin.users.upsert({ externalId: 'ada', name: 'Ada' });
const bob = await admin.users.upsert({ externalId: 'bob', name: 'Bob' });
const chat = await admin.conversations.create({ type: 'direct', participantIds: [ada.id, bob.id] });

const asAda = createClient({ baseUrl, token: () => sign({ type: 'user', userId: ada.id }) });
await asAda.messages.send({ conversationId: chat.id, senderId: ada.id, content: 'Hello Bob' });

const asBob = createClient({ baseUrl, token: () => sign({ type: 'user', userId: bob.id }) });
const { data } = await asBob.messages.list({ conversationId: chat.id });
console.log('Bob reads:', data.map((m) => m.content));
