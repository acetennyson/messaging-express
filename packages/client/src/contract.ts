/**
 * The request fields and enums this SDK knows about, as runtime data.
 *
 * Why this file exists: the SDK deliberately does not import the server's Zod schemas (it cannot: they
 * live in the server repo and would drag `zod` into every customer's bundle). To stop the hand-written
 * types in types.ts from silently drifting, the SERVER's test suite
 * (lib/validation/sdk-contract.test.ts) compares these lists against the real schemas on every `npm test`.
 * If you change a field in lib/validation/schemas.ts, that test fails until this file (and types.ts) agree.
 */
export const MESSAGE_TYPES = ['text', 'image', 'video', 'file', 'system'] as const;
export const ATTACHMENT_TYPES = ['image', 'video', 'file'] as const;
export const CONVERSATION_TYPES = ['direct', 'group', 'support'] as const;

export const REQUEST_FIELDS = {
  createMessage: ['conversationId', 'senderId', 'content', 'type', 'parentId', 'metadata', 'attachments'],
  messageAttachment: [
    'type', 'url', 'thumbnailUrl', 'filename', 'mimeType', 'sizeBytes', 'width', 'height', 'durationSeconds', 'metadata',
  ],
  messageQuery: ['limit', 'offset', 'cursor', 'sort', 'conversationId', 'before', 'after', 'type', 'senderId'],
  createConversation: ['type', 'title', 'participantIds', 'metadata'],
  conversationQuery: ['limit', 'offset', 'cursor', 'sort', 'type', 'isArchived', 'userId'],
  createUser: ['externalId', 'name', 'email', 'avatarUrl', 'metadata'],
  userQuery: ['limit', 'offset', 'cursor', 'sort', 'search', 'externalId'],
} as const;

/**
 * The realtime wire contract the SDK (src/realtime.ts) depends on. Checked against the server source by
 * lib/validation/sdk-contract.test.ts, so renaming an event or an error code there fails a test here.
 */
export const REALTIME_WIRE = {
  clientEvents: ['join-conversation', 'leave-conversation'],
  ackCodes: ['INVALID_PAYLOAD', 'FORBIDDEN', 'RATE_LIMITED', 'INTERNAL_ERROR'],
  connectErrorCodes: ['AUTH_REQUIRED', 'INVALID_TOKEN', 'PROJECT_INACTIVE'],
  /** Events routes publish to conversation rooms (emitEvent with a `channel`). Other events (conversation.*, user.*) reach webhooks only. */
  serverEvents: ['message.created'],
} as const;
