# Postbox: a chat app on Messaging Express

A small, forkable chat app: sign in by name, chat list with previews and unread dots, direct and group chats, photos and PDFs, live delivery. It is one Node server (your Express app with `@messaging-express/server` embedded at `/chat`) plus one React web app.

It is a **demo**. The sign-in lets anyone use any name, so replace `/auth/login` in `server/index.mjs` with your real login before you ship anything. Chats are plain by default; turn on **Private chat** when you start one to make it end-to-end encrypted (beta, see below).

## Run it

You need Node 20+ and a Postgres you can write to (a throwaway database is fine; the chat tables go in their own `messaging` schema).

```bash
cd examples/chat-app
cp .env.example .env          # set DATABASE_URL and a 32+ character CHAT_JWT_SECRET
npm run setup:local           # builds + packs the server, client and client-crypto packages from this repo, installs everything
npm run build                 # builds the web app into web/dist
npm start                     # http://localhost:3000
```

Open it in two windows (use a private window for the second), sign in as two different names, and start a chat from either side.

While developing, run `npm run dev:server` and `npm run dev:web` in two terminals and open http://localhost:5173. Vite forwards `/auth` and `/chat` (including the websocket) to the server.

Once the packages are on npm, `setup:local` is not needed: `npm install` is enough.

## How it fits together

| Piece | Where | What it does |
| --- | --- | --- |
| Chat API + realtime | `server/index.mjs` | `MessagingServer.init(...)`, `chat.middleware(app, '/chat')`, `chat.attachRealtime(server)`. Uploads go to `data/uploads`. |
| Sign in | `server/index.mjs` | `POST /auth/login {name}` creates or finds the user and returns a 12 hour user token. Demo only. |
| API client | `web/src/api.ts` | `createClient` and `createRealtime` share one token function that signs in again before expiry. |
| Chat list | `web/src/App.tsx` | Lists the user's chats, fetches the latest message of each, refreshes every 8 s and on live events. |
| Conversation | `web/src/Thread.tsx` | Loads history, pages back with "Show earlier messages", appends live messages, uploads then sends attachments. |
| New chat | `web/src/NewChat.tsx` | Picks people. One person opens the existing direct chat or creates it; several make a group. |

## Things the API does not do for you (so the app works around them)

- The chat list has no last message and no participants. The app fetches one message per chat, and stores both people's names in the direct chat's `metadata.members` so it can show the other person's name.
- Only new messages are pushed live. A chat someone else just created shows up on the next refresh (up to 8 s). Events missed while offline are not replayed, so the app reloads after a reconnect.
- "Unread" is kept per browser in `localStorage`. The server has no read receipts.
- Uploads accept images, mp4/webm video and PDF by default. Widen it with `upload.limits.allowedMimeTypes`. Files are stored on the server's disk; for more than one instance use `upload: { type: 's3', ... }`.

## Test it in real browsers

`scripts/e2e.mjs` drives the built app with Playwright: three users, a direct chat, live delivery, a photo and a PDF, a rejected file type, a group, reload, and the mobile layout.

```bash
npm i -D playwright && npx playwright install chromium
npm run build && npm start &              # on a throwaway database
BASE_URL=http://localhost:3000 node scripts/e2e.mjs
```

Screenshots land in your temp folder (`SHOTS_DIR` to change it).

## Private chats (end-to-end encrypted, beta)

In **New chat**, switch on **Private chat** before you pick people. Then:

- The chat is created through `@messaging-express/client-crypto`: a key for the conversation is wrapped for every person's device, and messages and files are encrypted in the browser. The database only ever holds ciphertext (the e2e test checks this, and so did a direct query of `mx_messages`).
- **Everyone is told.** The first message in the chat is an encrypted notice ("Ada turned on private chat..."). Each other member also gets an alert in the app the first time the chat appears (within about 8 s), the chat shows a lock in the list and header, and the top of the chat explains what private means and that it is beta.
- Private chats accept any file type, because the server cannot see what the file is.

What it needs and what it does not do:

- Each person's key is created on first sign-in and lives in **that browser's IndexedDB**. Signing in as the same name in another browser shows Private chat as off ("keys live on another browser"). Linking a second device is in `client-crypto` but not wired into this demo.
- **No recovery.** Clearing site data deletes the keys and that person's private history becomes unreadable. `client-crypto` has passphrase backup; this demo does not use it.
- The server still sees who talks to whom, when, group names and file sizes. Only message text and file contents are hidden.
- Someone who has never opened this version has no key yet, so they are greyed out in the private list.
- Device changes (a new device, a removed member) are not handled live here: the re-keying engine is not switched on.
- **Beta.** The `client-crypto` design has only had its author's review. Do not promise real users confidentiality until it has had an independent one (see `docs/review-brief.md` and the client-crypto README).
