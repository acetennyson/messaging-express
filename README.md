# Messaging Express 🚀

A professional **Messaging-as-a-Service (MAAS)** platform built with Next.js, Postgres, and WebSockets. Integrate real-time messaging into your applications without building it from scratch.

**Support for:** Text, Images, Videos, Files, Reactions, Typing Indicators, Read Receipts, and more.

---

## 🎯 Features

### Core Messaging
- ✅ **Real-time messaging** with WebSocket support
- ✅ **Multi-media support** (text, images, videos, files)
- ✅ **Conversation types** (direct, group, customer support)
- ✅ **Message threading** (replies and threads)
- ✅ **Message reactions** (emoji reactions)
- ✅ **Typing indicators** and presence
- ✅ **Read receipts** and unread counts
- ✅ **Message editing and deletion**

### Multi-Tenancy
- ✅ **Organizations** - Top-level account management
- ✅ **Projects** - Multiple projects per organization
- ✅ **API Keys** - Project-specific authentication
- ✅ **Custom settings** per project
- ✅ **CORS configuration** per project

### Developer Experience
- ✅ **RESTful API** with consistent JSON responses
- ✅ **JWT authentication** for secure access
- ✅ **Rate limiting** to prevent abuse
- ✅ **Webhooks** for real-time event notifications
- ✅ **Analytics events** for tracking usage
- ✅ **Comprehensive error handling**
- ✅ **Request logging** with request IDs

### Production Ready
- ✅ **Postgres connection pooling**
- ✅ **Transaction support** for data integrity
- ✅ **Indexed queries** for performance
- ✅ **Health check endpoint** for monitoring
- ✅ **Structured logging** (JSON format)
- ✅ **Environment-based configuration**

---

## 🏗️ Architecture

```
messaging-express/
├── app/
│   ├── api/
│   │   ├── v1/
│   │   │   ├── conversations/    # Conversation management
│   │   │   ├── messages/         # Message CRUD
│   │   │   ├── users/            # User management
│   │   │   └── reactions/        # Message reactions
│   │   └── health/               # Health check
│   ├── layout.tsx
│   └── page.tsx                  # API playground (coming soon)
├── lib/
│   ├── auth/                     # JWT & middleware
│   ├── db/                       # Database pool & queries
│   ├── logger/                   # Structured logging
│   ├── services/                 # Media upload & webhooks
│   ├── utils/                    # API key generation
│   └── validation/               # Zod schemas
├── scripts/
│   └── migrate.ts                # Database migrations
└── DATABASE_SCHEMA.md            # Full schema documentation
```

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js** 20+ 
- **PostgreSQL** 14+ (Supabase recommended)
- **npm** or **yarn**

### 2. Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd messaging-express

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
```

### 3. Configuration

Edit `.env.local`:

```env
# Required
DATABASE_URL=postgresql://user:password@host:5432/database
JWT_SECRET=<run: openssl rand -base64 48>

# Optional
APP_URL=http://localhost:3000
LOG_LEVEL=info
RATE_LIMIT_DISABLED=false
```

### 4. Database Setup

```bash
# Run migrations
npm run db:migrate
```

### 5. Start Development Server

```bash
npm run dev
```

Visit [http://localhost:3000/api/health](http://localhost:3000/api/health) to verify the setup.

---

## 📚 API Documentation

### Base URL
```
http://localhost:3000/api/v1
```

### Authentication

All API requests (except `/health`) require a Bearer token:

```bash
Authorization: Bearer <your-jwt-token>
```

---

### 📋 API Endpoints

#### **Health Check**
```http
GET /api/health
```
No authentication required. Returns database health status.

**Response:**
```json
{
  "status": "ok",
  "database": "healthy",
  "duration": 12,
  "timestamp": "2026-10-21T10:30:00.000Z"
}
```

---

#### **Users**

##### Create/Update User
```http
POST /api/v1/users
Authorization: Bearer <token>
Content-Type: application/json

{
  "externalId": "user_123",
  "name": "John Doe",
  "email": "john@example.com",
  "avatarUrl": "https://example.com/avatar.jpg",
  "metadata": { "plan": "pro" }
}
```

**Response: 201 Created**
```json
{
  "data": {
    "id": "uuid",
    "projectId": "uuid",
    "externalId": "user_123",
    "name": "John Doe",
    "email": "john@example.com",
    "avatarUrl": "https://example.com/avatar.jpg",
    "metadata": { "plan": "pro" },
    "isOnline": false,
    "createdAt": "2026-10-21T10:00:00.000Z",
    "updatedAt": "2026-10-21T10:00:00.000Z"
  }
}
```

##### List Users
```http
GET /api/v1/users?limit=50&offset=0&search=john
Authorization: Bearer <token>
```

---

#### **Conversations**

##### Create Conversation
```http
POST /api/v1/conversations
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "group",
  "title": "Project Discussion",
  "participantIds": ["user-uuid-1", "user-uuid-2"],
  "metadata": { "projectId": "proj_123" }
}
```

**Response: 201 Created**
```json
{
  "data": {
    "id": "uuid",
    "projectId": "uuid",
    "type": "group",
    "title": "Project Discussion",
    "participants": [
      {
        "id": "uuid",
        "name": "John Doe",
        "email": "john@example.com",
        "avatarUrl": "...",
        "role": "member"
      }
    ],
    "messageCount": 0,
    "isArchived": false,
    "createdAt": "2026-10-21T10:00:00.000Z"
  }
}
```

##### List Conversations
```http
GET /api/v1/conversations?type=group&limit=50&offset=0
Authorization: Bearer <token>
```

**Query Parameters:**
- `type` - `direct`, `group`, `support`
- `isArchived` - `true`, `false`
- `userId` - Filter by participant
- `limit` - Max 200, default 50
- `offset` - For pagination

---

#### **Messages**

##### Send Message
```http
POST /api/v1/messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "conversationId": "conv-uuid",
  "senderId": "user-uuid",
  "content": "Hello, world!",
  "type": "text",
  "attachments": [
    {
      "type": "image",
      "url": "https://cdn.example.com/image.jpg",
      "thumbnailUrl": "https://cdn.example.com/thumb.jpg",
      "filename": "screenshot.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 204800,
      "width": 1920,
      "height": 1080
    }
  ]
}
```

**Response: 201 Created**
```json
{
  "data": {
    "id": "uuid",
    "conversationId": "uuid",
    "sender": {
      "id": "uuid",
      "name": "John Doe",
      "email": "john@example.com",
      "avatarUrl": "..."
    },
    "content": "Hello, world!",
    "type": "text",
    "attachments": [...],
    "reactionCount": 0,
    "isEdited": false,
    "isDeleted": false,
    "createdAt": "2026-10-21T10:00:00.000Z"
  }
}
```

##### List Messages
```http
GET /api/v1/messages?conversationId=<uuid>&limit=50
Authorization: Bearer <token>
```

**Query Parameters:**
- `conversationId` - **Required**
- `before` - ISO 8601 datetime
- `after` - ISO 8601 datetime
- `type` - Message type filter
- `senderId` - Filter by sender
- `limit` - Max 200, default 50

---

### 🔧 Response Format

#### Success Response
```json
{
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "totalPages": 3
  }
}
```

#### Error Response
```json
{
  "error": {
    "message": "Validation failed",
    "code": "VALIDATION_ERROR",
    "details": { ... }
  }
}
```

#### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Validation error
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden
- `404` - Not found
- `409` - Conflict
- `429` - Rate limit exceeded
- `500` - Server error
- `503` - Service unavailable

---

## 🔐 Security

### API Key Management
```typescript
import { generateApiKey } from '@/lib/utils/apiKey';

const { key, prefix, hash } = generateApiKey('live');
// key: mex_live_xxxxx (give to customer)
// hash: stored in database
// prefix: for display (mex_live_abc...)
```

### JWT Authentication
```typescript
import { signToken, verifyToken } from '@/lib/auth/jwt';

const token = signToken({
  projectId: 'project-uuid',
  userId: 'user-uuid',
  type: 'user'
});
```

### Rate Limiting
Built-in rate limiting per IP and per user. Configure in `.env`:
```env
RATE_LIMIT_DISABLED=false
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
```

---

## 🎨 Frontend Integration Example

### React/Next.js Example

```typescript
const API_URL = 'https://your-api.com/api/v1';
const API_TOKEN = 'your-jwt-token';

// Send a message
async function sendMessage(conversationId: string, content: string) {
  const response = await fetch(`${API_URL}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversationId,
      senderId: 'user-uuid',
      content,
      type: 'text',
    }),
  });
  
  return response.json();
}

// Fetch messages
async function getMessages(conversationId: string) {
  const response = await fetch(
    `${API_URL}/messages?conversationId=${conversationId}&limit=50`,
    {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    }
  );
  
  return response.json();
}
```

---

## 📊 Database Schema

See [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for the complete schema with all tables, indexes, and relationships.

**Key Tables:**
- `organizations` - Multi-tenant accounts
- `projects` - Apps using the messaging service
- `users` - End users in each project
- `conversations` - Chat rooms/threads
- `messages` - Individual messages
- `message_attachments` - Media files
- `message_reactions` - Emoji reactions
- `webhook_logs` - Event delivery tracking

---

## 🧪 Testing

```bash
# Run tests
npm test

# Run linter
npm run lint
```

---

## 🚢 Deployment

### Vercel (Recommended)

1. Push your code to GitHub
2. Connect to Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

### Environment Variables (Production)
```env
DATABASE_URL=<supabase-pooler-connection-string>
JWT_SECRET=<secure-random-string>
APP_URL=https://your-domain.com
LOG_LEVEL=info
NODE_ENV=production
```

---

## 📈 Scaling Considerations

For high-traffic applications:

1. **Use connection pooling** ✅ (Already implemented)
2. **Add Redis** for rate limiting and caching
3. **Use CDN** for media uploads (AWS S3 + CloudFront)
4. **Database read replicas** for read-heavy workloads
5. **WebSocket clustering** with Redis pub/sub
6. **Message queues** for webhook delivery (Bull/BullMQ)

---

## 🤝 Contributing

Contributions welcome! Please read our contributing guidelines first.

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🙏 Inspired By

This project is inspired by the excellent work on [global-tech-trial](https://github.com/acetennyson/global-tech-trial) and aims to provide a similar level of quality for messaging services.

---

## 📞 Support

- Documentation: [Your docs URL]
- Issues: [GitHub Issues](your-repo/issues)
- Email: support@messagingexpress.com

---

**Built with ❤️ by your team**
