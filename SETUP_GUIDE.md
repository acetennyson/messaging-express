# Messaging Express - Complete Setup Guide

This guide will walk you through setting up Messaging Express from scratch.

---

## Prerequisites

Before starting, ensure you have:

- ✅ **Node.js 20+** installed ([Download](https://nodejs.org/))
- ✅ **PostgreSQL 14+** database (Supabase recommended)
- ✅ **Git** installed
- ✅ **Code editor** (VS Code recommended)

---

## Step 1: Database Setup (Supabase)

### 1.1 Create a Supabase Account

1. Go to [supabase.com](https://supabase.com)
2. Sign up for a free account
3. Create a new project

### 1.2 Get Database Credentials

1. In your Supabase dashboard, go to **Settings** → **Database**
2. Find the **Connection pooling** section
3. Copy the **Connection string** (it looks like this):
   ```
   postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```

**Important**: Use the **pooler** connection string (port 6543), not the direct connection!

---

## Step 2: Clone and Install

```bash
# Clone the repository
git clone <your-repo-url>
cd messaging-express

# Install dependencies
npm install
```

---

## Step 3: Environment Configuration

### 3.1 Create Environment File

```bash
# Copy the example
cp .env.example .env.local
```

### 3.2 Configure Required Variables

Open `.env.local` and set these required variables:

```env
# Database (from Supabase, Step 1.2)
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

# JWT Secret (generate a random string)
# Run this in terminal: openssl rand -base64 48
JWT_SECRET=<paste-the-generated-string-here>

# App URL (for local development)
APP_URL=http://localhost:3000
```

### 3.3 Generate JWT Secret

**On Mac/Linux:**
```bash
openssl rand -base64 48
```

**On Windows (PowerShell):**
```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

Copy the output and paste it as `JWT_SECRET` in your `.env.local` file.

---

## Step 4: Database Migration

Run the migration script to create all tables:

```bash
npm run db:migrate
```

You should see output like:
```
Starting database migrations...
Running migration: create_organizations
✓ Migration create_organizations completed
Running migration: create_projects
✓ Migration create_projects completed
...
✅ All migrations completed successfully!
```

---

## Step 5: Verify Setup

### 5.1 Start the Development Server

```bash
npm run dev
```

### 5.2 Check Health Endpoint

Open your browser and visit:
```
http://localhost:3000/api/health
```

You should see:
```json
{
  "status": "ok",
  "database": "healthy",
  "duration": 12,
  "timestamp": "2026-10-21T10:30:00.000Z"
}
```

✅ If you see this, your setup is complete!

---

## Step 6: Create Your First Organization

Now that the API is running, let's create an organization and project to start using the messaging API.

### 6.1 Insert Test Organization

Open **Supabase SQL Editor** and run:

```sql
-- Create an organization
INSERT INTO organizations (name, slug, api_key, api_secret_hash, is_active)
VALUES (
  'My Company',
  'my-company',
  'org_' || substr(md5(random()::text), 1, 32),
  'temp_hash',
  true
) RETURNING *;
```

Copy the `id` from the result.

### 6.2 Create a Project

```sql
-- Replace <org-id> with the ID from above
INSERT INTO projects (organization_id, name, api_key, is_active)
VALUES (
  '<org-id>',
  'My First Project',
  'proj_' || substr(md5(random()::text), 1, 32),
  true
) RETURNING *;
```

Copy the `id` and `api_key` from the result.

### 6.3 Generate a JWT Token

For development, you can generate a JWT manually. Create a file `generate-token.js`:

```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  {
    projectId: '<project-id-from-above>',
    organizationId: '<org-id-from-above>',
    type: 'api'
  },
  process.env.JWT_SECRET || 'your-jwt-secret-here',
  { expiresIn: '7d' }
);

console.log('\nYour JWT Token:');
console.log(token);
console.log('\nUse it in requests like this:');
console.log('Authorization: Bearer ' + token);
```

Run it:
```bash
node generate-token.js
```

Copy the generated token!

---

## Step 7: Test the API

### 7.1 Create a User

```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "user_001",
    "name": "John Doe",
    "email": "john@example.com"
  }'
```

**Expected Response:**
```json
{
  "data": {
    "id": "uuid-here",
    "projectId": "uuid",
    "externalId": "user_001",
    "name": "John Doe",
    "email": "john@example.com",
    ...
  }
}
```

### 7.2 Create Another User

```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "user_002",
    "name": "Jane Smith",
    "email": "jane@example.com"
  }'
```

Copy both user IDs!

### 7.3 Create a Conversation

```bash
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "direct",
    "title": "John and Jane Chat",
    "participantIds": ["<user-1-id>", "<user-2-id>"]
  }'
```

Copy the conversation ID!

### 7.4 Send a Message

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "<conversation-id>",
    "senderId": "<user-1-id>",
    "content": "Hello! This is my first message!",
    "type": "text"
  }'
```

### 7.5 Fetch Messages

```bash
curl http://localhost:3000/api/v1/messages?conversationId=<conversation-id> \
  -H "Authorization: Bearer <your-token>"
```

🎉 **Success!** You now have a working messaging API!

---

## Next Steps

### Turn features on (all are off by default, set in `.env.local`, no code change)

| Feature | Setting | Notes |
|---|---|---|
| Rate limiting | `RATE_LIMIT_MODE=dry-run`, then `enforce` | Watch `rate_limit_would_block` in the logs first. Limits: `RATE_LIMITS_JSON` |
| Webhooks | `WEBHOOK_DISPATCH=on` | Set the organization's `webhook_url` and `webhook_secret` |
| Webhook retries | `WEBHOOK_RETRY=on`, `CRON_SECRET=...` | Needs a cron, see below |
| Realtime | `REALTIME_PROVIDER=socketio` | Run with `npm run build && npm start` (not `next start`) |
| More than one instance | `REDIS_URL=...` on every instance | `rediss://` for TLS providers such as Upstash |
| Project lookup cache | `PROJECT_CACHE_TTL_SECONDS=15` | Optional; a deactivated project lingers for up to this long |

Full variable list: [README.md](./README.md) and `.env.example`.

### Customize

- Modify schemas in `lib/validation/schemas.ts`
- Add custom endpoints in `app/api/v1/`
- Update database schema in `scripts/migrate.ts`
- Configure rate limits with `RATE_LIMIT_MODE` and `RATE_LIMITS_JSON` in `.env.local`

---

## Step 8: Production Deployment

### 8.1 Choose how you run it

| Run command | Use when |
|---|---|
| `npm run build` then `npm start` (`node dist/server.js`) | **Default.** A long-running Node process (VPS, container, Railway, Render, Fly). Supports WebSockets. |
| `npm run build` then `npm run nextstart` (`next start`) | You do not need realtime, or as a rollback path. |
| Serverless (Vercel and similar) | REST only: `server.ts` cannot hold WebSockets there. Realtime needs a separate service or a hosted provider (planned paths B and C, not built yet). |

`npm run build` builds both Next and `dist/server.js`. The cutover steps and rollback are in
[`docs/CUTOVER_RUNBOOK.md`](./docs/CUTOVER_RUNBOOK.md); validate a release first with
[`docs/SOAK_RUNBOOK.md`](./docs/SOAK_RUNBOOK.md).

### 8.2 Realtime behind a load balancer
- The proxy must forward WebSocket upgrades.
- Use **sticky sessions** (`ip_hash` or cookie affinity), or make clients connect with `transports: ['websocket']`. Socket.IO's
  long-polling fallback needs one client's requests to reach the same instance.
- Run more than one instance only with `REDIS_URL` set on **all** of them. Check the boot log: `realtime_adapter` should say `redis`.
  Without it, an event produced on one instance never reaches sockets on another.
- Use a process manager that restarts the process (it exits 1 on a crash by design) and send SIGTERM for deploys.
- Probe `GET /api/health` before sending traffic to a new instance.

### 8.3 Cron for webhook retries
Nothing retries on its own. Call this once a minute from any scheduler:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-host>/api/internal/webhooks/retry
```

The route refuses everything while `CRON_SECRET` is unset, and does nothing (`skipped`) while `WEBHOOK_RETRY` is not `on`.
Receivers must be idempotent: delivery is at-least-once.

### 8.4 Upload limits at the storage provider
Presigned uploads go straight from the client to storage, so the provider itself must enforce size and type.
Set limits **at or above** `MAX_UPLOAD_SIZE_BYTES` so nothing the app accepts today is rejected.

- **Supabase:** set `file_size_limit` and `allowed_mime_types` on the bucket.
- **Firebase:** add Storage security rules limiting `request.resource.size` and `request.resource.contentType`.
- **S3 / R2 / Spaces:** the current presigned PUT **cannot cap size**. Apply a bucket lifecycle rule to expire the `uploads/` prefix
  and a CDN or WAF size limit, or switch to presigned POST with a `content-length-range` condition (a later change).
- **local / php:** the app enforces `MAX_UPLOAD_SIZE_BYTES` itself.

Test it: upload an oversize file directly to a presigned URL; the provider must reject it.

### 8.5 Production checklist
- [ ] `JWT_SECRET` is long and random, and not shared with other environments
- [ ] `DATABASE_URL` uses the pooler; `CORS_ALLOWED_ORIGINS` lists your real origins (not `*`)
- [ ] `bash scripts/smoke.sh` passes against the new release
- [ ] `RATE_LIMIT_MODE` went through `dry-run` before `enforce`
- [ ] `REDIS_URL` set on every instance if you run more than one
- [ ] The previous release is noted for rollback

---

## Optional: End-to-End Encryption

End-to-end encryption (E2EE) is off by default. Read `docs/E2EE_WHAT_IT_PROTECTS.md` before you offer it to your users: it says what it does and does not protect.

### Enable it

1. Make sure the migrations have run in **every** environment first (`npm run db:migrate`); the message check reads the new columns.
2. Set `E2EE_ENABLED=on` and restart. Optional tuning (all have defaults):

| Variable | Default | Meaning |
|---|---|---|
| `E2EE_ENABLED` | `off` | `on` turns the E2EE routes on. Read on every request. |
| `MAX_DEVICES_PER_USER` | `10` | 1-50. Enforced when a device is approved and when it links. |
| `PAIRING_TTL_SECONDS` | `60` | 30-300. How long an approval of a new device stays valid. |
| `E2EE_KEYS_MAX_BATCH` | `200` | 1-1000. Max wrapped keys in one create or upload. |

3. Check it: `npm run verify:e2ee` (use a dev or staging database; it creates temporary users).

### Recovering a user who lost every device

The user's device keys exist only on their devices. If they lose all of them and have no key backup, they cannot read old encrypted messages
and the server cannot help. Your backend can let them start again:

```bash
curl -X POST http://localhost:3000/api/v1/users/<user-id>/devices/reset \
  -H "Authorization: Bearer <admin-or-api-token>"
```

This revokes all of the user's devices (an end-user token is refused, even for the user's own devices). The user then registers a fresh device and,
if they saved a backup, restores it with their passphrase. Messages they cannot decrypt stay unreadable until another member's device wraps the key
for the new device. Because this route can enrol access for a user, keep admin/API tokens on your backend only.

### Turning it off

`E2EE_ENABLED=off` hides the device, key and backup routes at once. **It does not make existing encrypted conversations safe to use as plain ones:**
the message route stops checking them, so plaintext sent into an encrypted conversation would be accepted and stored. If you have live encrypted users,
tell them before turning the flag off.

### Running it for a while before you rely on it

See `docs/E2EE_SOAK.md` for the soak scripts, the daily checklist and the rollout steps.

---

## Troubleshooting

### Database Connection Issues

**Error**: `Database connection failed`

**Solutions**:
1. Check DATABASE_URL is correct
2. Verify you're using the **pooler** connection string (port 6543)
3. Check Supabase project is not paused
4. Test connection:
   ```bash
   psql "<your-database-url>"
   ```

### JWT Token Issues

**Error**: `Invalid or expired token`

**Solutions**:
1. Verify JWT_SECRET matches in `.env.local` and token generation
2. Check token hasn't expired (default 7 days)
3. Regenerate token with `generate-token.js`

### Migration Fails

**Error**: `Migration failed: relation already exists`

**Solution**: Drop and recreate tables (⚠️ This deletes data!):
```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

Then run migrations again:
```bash
npm run db:migrate
```

### Port Already in Use

**Error**: `Port 3000 is already in use`

**Solution**: Kill the process or use a different port:
```bash
# Kill process on port 3000 (Mac/Linux)
lsof -ti:3000 | xargs kill

# Or use a different port
PORT=3001 npm run dev
```

---

## Getting Help

- 📖 **Documentation**: [README.md](./README.md)
- 🏗️ **Architecture**: [ARCHITECTURE.md](./ARCHITECTURE.md)
- 🗄️ **Database**: [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md)
- 💬 **Issues**: [GitHub Issues](your-repo/issues)

---

**Setup complete! Happy coding! 🚀**
