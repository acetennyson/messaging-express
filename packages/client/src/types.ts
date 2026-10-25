/** A JWT, or a function that returns one. The function is called before EVERY request, so refreshed tokens just work. */
export type TokenSource = string | (() => string | Promise<string>);

export interface ClientOptions {
  /** Origin of the Messaging Express API, e.g. "https://api.example.com". Optional only in a browser (same origin). */
  baseUrl?: string;
  token: TokenSource;
  /** Custom fetch (tests, proxies, older runtimes). Default: the global fetch. */
  fetch?: typeof fetch;
  /** Retries for idempotent requests (GETs and presign) on network errors, 429, 502, 503 and 504. Default 2. Use 0 to disable. */
  maxRetries?: number;
  /** Longest Retry-After the SDK will wait out before giving up and throwing. Default 30000 (ms). */
  maxRetryAfterMs?: number;
}

/** `{ data, meta }` envelope every successful API response uses. */
export interface ApiResponse<T = unknown> {
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    nextCursor?: string;
  };
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Object (sent as JSON) or FormData. */
  body?: unknown;
  /** Retry on transient failures. Default: true for GET, false otherwise. Never enable it for a POST that is not idempotent. */
  retry?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** An attachment object ready for `attachments[]` of POST /api/v1/messages. */
export interface UploadedAttachment {
  type: 'image' | 'video' | 'file';
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Not known for presigned uploads: the bytes never touch the API server. */
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

/** What you can upload: a browser File, or any Blob (in Node the name comes from `File.name` when present). */
export type UploadInput = Blob | File;

export type UploadOutcome =
  | { ok: true; file: UploadInput; attachment: UploadedAttachment }
  | { ok: false; file: UploadInput; error: string; code?: string };

export interface UploadOptions {
  category?: string;
  /** Max simultaneous uploads. Default 4. */
  concurrency?: number;
  /** "auto" tries a presigned direct upload first; "never" always goes through the API. Default "auto". */
  direct?: 'auto' | 'never';
  /** Per-file progress, 0 to 100. Fine-grained in browsers (XMLHttpRequest); elsewhere only 0 and 100. */
  onProgress?: (fileIndex: number, percent: number) => void;
  /** Called as each file finishes, success or failure, before the whole batch resolves. */
  onFileDone?: (fileIndex: number, outcome: UploadOutcome) => void;
}

// ---------------------------------------------------------------------------------------------
// Resources (SDK-2). Hand-written from lib/validation/schemas.ts and the route handlers.
// Row objects are what the API returns today: columns of `m.*` / `c.*` / `u.*` come back in
// snake_case straight from the database, while nested objects (sender, attachments, participants)
// are camelCase. Counts (`reaction_count`, `participant_count`, `message_count`) are numeric STRINGS
// because Postgres returns COUNT(*) as bigint. Dates are ISO 8601 strings.
// ---------------------------------------------------------------------------------------------

export type MessageType = 'text' | 'image' | 'video' | 'file' | 'system';
export type ConversationType = 'direct' | 'group' | 'support';
export type AttachmentType = 'image' | 'video' | 'file';

/** A page of results: `data` plus the server's `meta` (which fields it fills differs per endpoint). */
export interface Page<T> {
  data: T[];
  meta: NonNullable<ApiResponse['meta']>;
}

/** Pagination fields every list endpoint accepts. `offset` is what the server pages by today. */
export interface PageParams {
  /** 1 to 200, server default 50. */
  limit?: number;
  offset?: number;
}

// ---- messages ----

export interface SendMessageInput {
  conversationId: string;
  /** Must already be a participant of the conversation. */
  senderId: string;
  content?: string;
  /** Server default "text". The SDK does not guess it from the attachments. */
  type?: MessageType;
  parentId?: string;
  metadata?: Record<string, unknown>;
  /** The `attachment` of each successful `client.uploads.upload` outcome fits here as is. */
  attachments?: UploadedAttachment[];
}

export interface MessageAttachment {
  id: string;
  type: AttachmentType;
  url: string;
  thumbnailUrl: string | null;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export interface UserSummary {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  parent_id: string | null;
  content: string | null;
  type: MessageType;
  metadata: Record<string, unknown>;
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  sender: UserSummary;
  attachments: MessageAttachment[];
  /** Only on list results, not on the object `send` returns. Numeric string. */
  reaction_count?: string;
}

export interface ListMessagesParams extends PageParams {
  conversationId: string;
  /** Messages created strictly before / after this instant. A Date is sent as ISO 8601. */
  before?: string | Date;
  after?: string | Date;
  type?: MessageType;
  senderId?: string;
}

// ---- conversations ----

export interface CreateConversationInput {
  type: ConversationType;
  title?: string;
  /** At least one, unique, all users of your project. */
  participantIds: string[];
  metadata?: Record<string, unknown>;
}

export interface ConversationParticipant extends UserSummary {
  role: string;
}

interface ConversationRow {
  id: string;
  project_id: string;
  type: ConversationType;
  title: string | null;
  metadata: Record<string, unknown>;
  is_archived: boolean;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What `conversations.create` returns: the row plus its participants. */
export interface Conversation extends ConversationRow {
  participants: ConversationParticipant[];
}

/** What `conversations.list` returns: the row plus counts (numeric strings). */
export interface ConversationListItem extends ConversationRow {
  participant_count: string;
  message_count: string;
}

export interface ListConversationsParams extends PageParams {
  type?: ConversationType;
  /** Only conversations this user participates in. */
  userId?: string;
}

// ---- users ----

export interface UpsertUserInput {
  /** Your own id for this user. With it, the call is an upsert on (project, externalId); without it, every call creates a new user. */
  externalId?: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface User {
  id: string;
  project_id: string;
  external_id: string | null;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  is_online: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListUsersParams extends PageParams {
  /** Case-insensitive match on name or email. */
  search?: string;
  externalId?: string;
}
