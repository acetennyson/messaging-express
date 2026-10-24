# 🚀 Getting Started with Messaging Express

Welcome! This guide will get you from zero to sending your first message in **under 10 minutes**.

---

## What You're Building

A **complete messaging API** for your application. Think Intercom, Zendesk Chat, or WhatsApp's API, but:
- ✅ **Open source** (no vendor lock-in)
- ✅ **Self-hosted** (full control)
- ✅ **Free** (no per-message fees)
- ✅ **Customizable** (your features, your way)

---

## Prerequisites

✅ **Node.js 20+** - [Download here](https://nodejs.org/)  
✅ **PostgreSQL database** - [Free Supabase account](https://supabase.com) (recommended)  
✅ **5-10 minutes** of your time

---

## Step 1: Get Your Database (2 min)

### Option A: Supabase (Recommended - Free)

1. Go to [supabase.com](https://supabase.com) and sign up
2. Create a new project
3. Go to **Settings** → **Database**
4. Copy the **Connection pooling** string (looks like this):
   ```
   postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```
5. **Save this!** You'll need it in Step 3

### Option B: Local PostgreSQL

```bash
# Mac
brew install postgresql
brew services start postgresql

# Ubuntu
sudo apt-get install postgresql
sudo systemctl start postgresql

# Windows
# Download installer from postgresql.org
```

---

## Step 2: Clone & Install (1 min)

```bash
# Clone the repo
git clone <your-repo-url>
cd messaging-express

# Install dependencies
npm install
```

---

## Step 3: Configure (2 min)

```bash
# Create environment file
cp .env.example .env.local
```

Open `.env.local` and add:

```env
# Your database URL from Step 1
DATABASE_URL=postgresql://postgres...

# Generate a random JWT secret
# Mac/Linux: openssl rand -base64 48
# Windows PowerShell: [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
JWT_SECRET=<paste-generated-secret-here>

# Local dev URL
APP_URL=http://localhost:3000
```

---

## Step 4: Setup Database (1 min)

```bash
npm run db:migrate
```

You should see:
```
Starting database migrations...
✓ Migration create_organizations completed
✓ Migration create_projects completed
...
✅ All migrations completed successfully!
```

---

## Step 5: Start Server (30 sec)

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) - you should see a beautiful landing page! 🎉

Test the API:
```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "database": "healthy",
  "duration": 12,
  "timestamp": "2026-10-21T..."
}
```

---

## Step 6: Send Your First Message (3 min)

### 6.1 Create Test Data in Database

Open your Supabase SQL editor (or psql) and run:

```sql
-- Create an organization
INSERT INTO organizations (id, name, slug, api_key, api_secret_hash)
VALUES (
  'org_123',
  'Test Company',
  'test-company',
  'org_test_key',
  'hash'
);

-- Create a project
INSERT INTO projects (id, organization_id, name, api_key)
VALUES (
  'proj_456',
  'org_123',
  'My App',
  'proj_test_key'
);

-- Create two users
INSERT INTO users (id, project_id, external_id, name, email)
VALUES 
  ('user_1', 'proj_456', 'alice_ext', 'Alice', 'alice@example.com'),
  ('user_2', 'proj_456', 'bob_ext', 'Bob', 'bob@example.com');
```

### 6.2 Generate JWT Token

Create a file `test-token.js`:

```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  {
    projectId: 'proj_456',
    organizationId: 'org_123',
    type: 'api'
  },
  process.env.JWT_SECRET || 'your-secret-from-env',
  { expiresIn: '7d' }
);

console.log('Token:', token);
```

Run it:
```bash
node test-token.js
```

**Copy the token!**

### 6.3 Create a Conversation

```bash
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "direct",
    "title": "Alice and Bob",
    "participantIds": ["user_1", "user_2"]
  }'
```

**Copy the conversation ID from the response!**

### 6.4 Send a Message

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "<conversation-id>",
    "senderId": "user_1",
    "content": "Hello! This is my first message! 🎉",
    "type": "text"
  }'
```

### 6.5 Fetch Messages

```bash
curl "http://localhost:3000/api/v1/messages?conversationId=<conversation-id>" \
  -H "Authorization: Bearer <your-token>"
```

**🎉 SUCCESS!** You just sent and received a message through your own messaging API!

---

## What You Can Do Now

### Send an Image
```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "<conv-id>",
    "senderId": "user_1",
    "content": "Check this out!",
    "type": "image",
    "attachments": [{
      "type": "image",
      "url": "https://picsum.photos/800/600",
      "thumbnailUrl": "https://picsum.photos/200/150",
      "filename": "photo.jpg",
      "mimeType": "image/jpeg"
    }]
  }'
```

### Create a Group Chat
```bash
# Add a third user first
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "charlie_ext",
    "name": "Charlie",
    "email": "charlie@example.com"
  }'

# Create group
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "group",
    "title": "The Squad",
    "participantIds": ["user_1", "user_2", "<charlie-id>"]
  }'
```

---

## Next Steps

### 1. Read the Docs
- **README.md** - Full feature list & API docs
- **API_EXAMPLES.md** - More API examples
- **ARCHITECTURE.md** - How it all works

### 2. Integrate With Your App

```javascript
// Example: Send message from your app
async function sendMessage(content) {
  const response = await fetch('http://localhost:3000/api/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_TOKEN',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      conversationId: 'your-conv-id',
      senderId: 'your-user-id',
      content,
      type: 'text'
    })
  });
  
  return response.json();
}
```

### 3. Add Features
- Real-time messaging: already built, set `REALTIME_PROVIDER=socketio` and run `npm run build && npm start` (see README, Realtime)
- File upload: built (`/api/v1/uploads`); choose a storage provider with `STORAGE_PROVIDER`
- Message search
- Push notifications
- Email notifications
- Read receipts UI

### 4. Deploy to Production
- Deploy to Vercel (free)
- Use Supabase Pro (~$25/mo)
- Add Redis for caching
- Setup monitoring

---

## Troubleshooting

### Database Connection Fails
- ✅ Check DATABASE_URL is correct
- ✅ Use **pooler** connection string (port 6543)
- ✅ Verify Supabase project is active

### Token Invalid
- ✅ JWT_SECRET must match in `.env.local` and token generation
- ✅ Token expires after 7 days - generate a new one

### Migration Fails
- ✅ Check database credentials
- ✅ Ensure database is empty (first run)
- ✅ Or drop/recreate: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`

### Port 3000 in Use
```bash
# Use different port
PORT=3001 npm run dev
```

---

## Get Help

- 📖 **Full Docs**: Check README.md, SETUP_GUIDE.md, ARCHITECTURE.md
- 💬 **Issues**: [GitHub Issues](your-repo/issues)
- 📧 **Email**: your-email@example.com

---

## What's Next?

Your messaging API is now running! Here's what people typically do next:

1. **Build a chat UI** (React, Vue, etc.)
2. **Turn on realtime** (`REALTIME_PROVIDER=socketio`) for live updates
3. **Integrate with your app** using the API
4. **Deploy to production**: see Step 8 of [SETUP_GUIDE.md](./SETUP_GUIDE.md) (realtime needs a long-running Node process, so not Vercel serverless)
5. **Add advanced features** (search, files, etc.)

**You're ready to build something amazing!** 🚀

---

**Happy Coding!** ✨
