# Messaging Express - Architecture Documentation

## Overview

Messaging Express is a multi-tenant, real-time messaging platform built as a SaaS product. It enables developers to integrate complete messaging functionality into their applications without building from scratch.

## System Design

### Multi-Tenancy Architecture

```
┌─────────────────┐
│  Organization   │  (Top level account)
└────────┬────────┘
         │ 1:N
         ▼
┌─────────────────┐
│    Projects     │  (Individual apps/services)
└────────┬────────┘
         │ 1:N
         ▼
┌─────────────────┐
│     Users       │  (End users in each app)
└────────┬────────┘
         │ N:M
         ▼
┌─────────────────┐
│  Conversations  │  (Chat rooms/threads)
└────────┬────────┘
         │ 1:N
         ▼
┌─────────────────┐
│    Messages     │  (Individual messages)
└─────────────────┘
```

### Data Flow

```
Client App
    │
    │ 1. API Request (JWT)
    ▼
┌────────────────────┐
│  Next.js API Route │
│   (Middleware)     │
└─────────┬──────────┘
          │
          │ 2. Authenticate & Validate
          ▼
┌─────────────────────┐
│   Auth Middleware   │
│   (JWT Verify)      │
└─────────┬───────────┘
          │
          │ 3. Authorize (Project check)
          ▼
┌─────────────────────┐
│  Business Logic     │
│  (Validation)       │
└─────────┬───────────┘
          │
          │ 4. Database Query
          ▼
┌─────────────────────┐
│   Postgres Pool     │
│   (Connection)      │
└─────────┬───────────┘
          │
          │ 5. Response
          ▼
      Client App
```

## Core Components

### 1. Authentication Layer

#### JWT-based Authentication
- **Token Generation**: `lib/auth/jwt.ts`
- **Token Format**:
  ```json
  {
    "projectId": "uuid",
    "userId": "uuid",
    "organizationId": "uuid",
    "type": "api|user|admin",
    "exp": 1234567890
  }
  ```

#### Middleware
- **Location**: `lib/auth/middleware.ts`
- **Responsibilities**:
  - Extract Bearer token
  - Verify JWT signature
  - Check project & organization status
  - Populate request context

### 2. Database Layer

#### Connection Pooling
- **Library**: `pg` (node-postgres)
- **Configuration**:
  - Max connections: 20
  - Idle timeout: 30s
  - Connection timeout: 5s
- **Pooler**: Supabase connection pooler (port 6543)

#### Query Patterns

**Simple Query**:
```typescript
import { query } from '@/lib/db/pool';

const result = await query(
  'SELECT * FROM users WHERE project_id = $1',
  [projectId]
);
```

**Transaction**:
```typescript
import { transaction } from '@/lib/db/pool';

const result = await transaction(async (client) => {
  await client.query('INSERT INTO ...');
  await client.query('UPDATE ...');
  return data;
});
```

### 3. Validation Layer

#### Zod Schemas
- **Location**: `lib/validation/schemas.ts`
- **Purpose**: Request validation and type safety
- **Example**:
  ```typescript
  export const createMessageSchema = z.object({
    conversationId: z.string().uuid(),
    senderId: z.string().uuid(),
    content: z.string().optional(),
    type: z.enum(['text', 'image', 'video', 'file', 'system']),
  });
  ```

### 4. API Response Layer

#### Standard Response Format
```typescript
// Success
{
  data: T,
  meta?: {
    page: number,
    limit: number,
    total: number,
    totalPages: number
  }
}

// Error
{
  error: {
    message: string,
    code: string,
    details: any
  }
}
```

#### Helper Functions
- `successResponse(data, meta)` → 200
- `createdResponse(data)` → 201
- `validationError(message)` → 400
- `unauthorizedError()` → 401
- `forbiddenError()` → 403
- `notFoundError()` → 404
- `conflictError()` → 409
- `tooManyRequestsError()` → 429

### 5. Logging Layer

#### Structured Logging
- **Format**: JSON lines on stdout
- **Log Levels**: debug, info, warn, error, silent
- **Features**:
  - Timestamp in ISO 8601
  - Automatic redaction of sensitive fields
  - Request ID correlation

#### Usage
```typescript
import { logger } from '@/lib/logger';

logger.info('User created', { userId, projectId });
logger.error('Database error', error, { query });
```

## API Versioning

### URL Structure
```
/api/v1/<resource>
```

### Version Management
- **Current**: v1
- **Strategy**: URL-based versioning
- **Migration Path**: New major version = new `/api/v2/` routes

## Security Model

### Authentication Flow

1. **Client obtains JWT**:
   - Organization registers & receives API key
   - API key exchanged for JWT
   - JWT contains project context

2. **Request Authentication**:
   ```
   Authorization: Bearer eyJhbGc...
   ```

3. **Token Verification**:
   - Signature check (JWT_SECRET)
   - Expiration check
   - Project & org status check

4. **Authorization Check**:
   - Resource belongs to project?
   - User has permission?
   - Rate limit OK?

### Rate Limiting

#### Implementation
- **Storage**: Postgres table `rate_limits`
- **Algorithm**: Fixed window counter
- **Key Format**: `{endpoint}:{identifier}:{window}`

#### Limits (Example)
```typescript
{
  '/api/v1/messages': {
    limit: 100,
    window: 60000, // 1 minute
    keyBy: 'projectId'
  }
}
```

### CORS Policy

#### Configuration
```typescript
// Per-project CORS settings
{
  allowedOrigins: [
    'https://app.example.com',
    'https://admin.example.com'
  ]
}
```

#### Headers
- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Methods`
- `Access-Control-Allow-Headers`
- `Access-Control-Expose-Headers`

## Real-Time Features

### WebSocket Architecture (Planned)

```
┌─────────────┐      WebSocket      ┌──────────────┐
│   Client    │ ◄─────────────────► │  WS Server   │
└─────────────┘                      └──────┬───────┘
                                            │
                                            │ Pub/Sub
                                            ▼
                                      ┌──────────────┐
                                      │    Redis     │
                                      └──────────────┘
```

### Events

#### Client → Server
- `message.send`
- `typing.start`
- `typing.stop`
- `message.read`

#### Server → Client
- `message.new`
- `message.updated`
- `message.deleted`
- `user.typing`
- `user.online`
- `user.offline`

## Media Upload Flow

### Architecture

```
Client
  │ 1. Request presigned URL
  ▼
API Server
  │ 2. Generate presigned URL
  ▼
S3/CDN
  │ 3. Direct upload
  ◄─┘
  │ 4. Upload complete, return URL
  ▼
API Server
  │ 5. Create message with attachment
  ▼
Database
```

### Current Implementation
- **Service**: `lib/services/mediaUploadService.ts`
- **Method**: Direct upload to configured endpoint
- **Future**: S3 presigned URLs

## Webhook System

### Event Types
```typescript
type WebhookEvent = 
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'conversation.created'
  | 'conversation.updated'
  | 'user.created'
  | 'user.online'
  | 'user.offline';
```

### Delivery

1. **Event occurs** (e.g., message created)
2. **Insert into `webhook_logs`**
3. **Background worker sends HTTP POST**
4. **Retry logic**:
   - Exponential backoff
   - Max 5 attempts
   - 24-hour window

### Payload Format
```json
{
  "event": "message.created",
  "timestamp": "2026-10-21T10:00:00Z",
  "projectId": "uuid",
  "data": { ... },
  "signature": "sha256=..."
}
```

### Signature Verification
```typescript
const signature = createHmac('sha256', webhookSecret)
  .update(JSON.stringify(payload))
  .digest('hex');
```

## Performance Optimizations

### Database Indexes

#### Critical Indexes
```sql
-- Messages by conversation (hot path)
CREATE INDEX idx_messages_conversation 
  ON messages(conversation_id, created_at DESC);

-- User lookup by external ID
CREATE INDEX idx_users_external_id 
  ON users(project_id, external_id);

-- Conversation participants
CREATE INDEX idx_participants_conversation 
  ON conversation_participants(conversation_id);
```

### Query Optimization

#### Pagination
```typescript
// Offset-based (simple, works for small datasets)
LIMIT 50 OFFSET 100

// Cursor-based (better for large datasets)
WHERE created_at < $cursor
ORDER BY created_at DESC
LIMIT 50
```

#### N+1 Prevention
```typescript
// ❌ Bad: N+1 queries
for (message of messages) {
  const sender = await getUserById(message.senderId);
}

// ✅ Good: Single query with JOIN
SELECT m.*, u.name as sender_name
FROM messages m
JOIN users u ON m.sender_id = u.id
WHERE m.conversation_id = $1
```

### Connection Pooling

#### Benefits
- Reuse database connections
- Lower latency (no connection overhead)
- Handle concurrent requests efficiently

#### Configuration
```typescript
{
  max: 20,              // Max connections
  idleTimeoutMillis: 30000,  // Close idle after 30s
  connectionTimeoutMillis: 5000  // Wait 5s for connection
}
```

## Monitoring & Observability

### Health Checks
- **Endpoint**: `/api/health`
- **Checks**:
  - Database connectivity
  - Response time (<2s)
  - Service status

### Logging Strategy

#### What to Log
- All HTTP requests (method, path, status, duration)
- Authentication failures
- Validation errors
- Database errors
- Webhook deliveries

#### What NOT to Log
- Passwords
- API keys
- JWT tokens
- Sensitive user data

### Metrics (Future)

- Request rate
- Error rate
- P95/P99 latency
- Database query time
- WebSocket connections
- Active users

## Scaling Strategy

### Horizontal Scaling

```
┌────────────┐      ┌────────────┐      ┌────────────┐
│  Instance  │      │  Instance  │      │  Instance  │
│      1     │      │      2     │      │      3     │
└──────┬─────┘      └──────┬─────┘      └──────┬─────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                           │
                    ┌──────▼──────┐
                    │ Load Balancer│
                    └──────┬───────┘
                           │
                    ┌──────▼──────┐
                    │   Database  │
                    │  (Pooled)   │
                    └─────────────┘
```

### Database Scaling

1. **Vertical**: Increase instance size
2. **Connection Pooling**: Already implemented ✅
3. **Read Replicas**: For read-heavy operations
4. **Partitioning**: By date or project (if needed)
5. **Caching**: Redis for hot data

### File Storage Scaling

1. **CDN**: CloudFront + S3
2. **Image Optimization**: Resize on upload
3. **Lazy Loading**: Paginated media
4. **Compression**: WebP for images, H.265 for video

## Future Enhancements

### Phase 2
- [ ] WebSocket real-time messaging
- [ ] Redis for caching & pub/sub
- [ ] S3 media storage
- [ ] Message search (full-text)
- [ ] Presence & online status

### Phase 3
- [ ] Voice messages
- [ ] Video calls (WebRTC)
- [ ] Screen sharing
- [ ] Message templates
- [ ] Chatbots integration

### Phase 4
- [ ] Analytics dashboard
- [ ] Admin panel
- [ ] Billing & usage tracking
- [ ] Multi-region support
- [ ] End-to-end encryption

---

**Last Updated**: October 21, 2026
