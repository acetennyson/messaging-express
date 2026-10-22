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

### Add More Features

1. **Upload Media** - Integrate with AWS S3 or Cloudinary
2. **WebSockets** - Add real-time message delivery
3. **Webhooks** - Configure event notifications
4. **Search** - Implement full-text search
5. **Analytics** - Track usage metrics

### Customize

- Modify schemas in `lib/validation/schemas.ts`
- Add custom endpoints in `app/api/v1/`
- Update database schema in `scripts/migrate.ts`
- Configure rate limits in `.env.local`

### Deploy

See [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment guide.

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
