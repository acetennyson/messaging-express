// The same, end-to-end encrypted with @messaging-express/client-crypto: the server only ever stores ciphertext.
// Run: CHAT_JWT_SECRET=<same secret> node encrypted.mjs [baseUrl]   (the server needs the default e2ee: 'on')
import jwt from 'jsonwebtoken';
import { createClient } from '@messaging-express/client';
import { withCrypto, memoryKeyStore } from '@messaging-express/client-crypto';

const baseUrl = process.argv[2] || 'http://localhost:3000/chat';
const sign = (claims) => jwt.sign(claims, process.env.CHAT_JWT_SECRET, { expiresIn: '1h' });
const admin = createClient({ baseUrl, token: () => sign({ type: 'api' }) });
const run = Date.now().toString(36); // new demo users every run: a user's first device is registered once, and this demo keeps keys in memory only
const ada = await admin.users.upsert({ externalId: `ada-${run}`, name: 'Ada' });
const bob = await admin.users.upsert({ externalId: `bob-${run}`, name: 'Bob' });

const device = async (user) => { // one device per person: its keys stay in this key store, never on the server
  const client = withCrypto(createClient({ baseUrl, token: () => sign({ type: 'user', userId: user.id }) }), { keyStore: memoryKeyStore(), userId: user.id });
  await client.crypto.device.registerPrimaryDevice({ deviceName: 'demo' });
  return client;
};
const [adaClient, bobClient] = [await device(ada), await device(bob)];

const conv = await adaClient.crypto.secure.createSecureConversation({ participantIds: [bob.id] });
await adaClient.crypto.secure.sendSecureMessage({ conversationId: conv.id, text: 'Meet at 7' });

const page = await bobClient.messages.list({ conversationId: conv.id });
console.log('the server stored:', page.data[0].content.slice(0, 24) + '…');
for (const r of await bobClient.crypto.secure.decryptMessages(page.data)) console.log('Bob reads:', r.ok ? r.message.text : r.error);
