import { createTransport } from './http';
import { createUploads } from './uploads';
import { createConversations, createMessages, createUsers } from './resources';
import type { ClientOptions } from './types';

export { MessagingExpressError } from './errors';
export { DEFAULT_MAX_CONCURRENT_UPLOADS } from './uploads';
export type {
  ApiResponse,
  AttachmentType,
  ClientOptions,
  Conversation,
  ConversationListItem,
  ConversationParticipant,
  ConversationType,
  CreateConversationInput,
  ListConversationsParams,
  ListMessagesParams,
  ListUsersParams,
  Message,
  MessageAttachment,
  MessageType,
  Page,
  PageParams,
  SendMessageInput,
  UpsertUserInput,
  User,
  UserSummary,
  RequestOptions,
  TokenSource,
  UploadedAttachment,
  UploadInput,
  UploadOptions,
  UploadOutcome,
} from './types';

export function createClient(options: ClientOptions) {
  const transport = createTransport(options);
  return {
    /** Low-level typed request, for endpoints the SDK has no wrapper for yet. Rejects with MessagingExpressError. */
    request: transport.request,
    uploads: createUploads(transport),
    messages: createMessages(transport),
    conversations: createConversations(transport),
    users: createUsers(transport),
  };
}

export type MessagingExpressClient = ReturnType<typeof createClient>;
