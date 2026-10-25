import type { Transport } from './http';
import type {
  Conversation,
  ConversationListItem,
  CreateConversationInput,
  ListConversationsParams,
  ListMessagesParams,
  ListUsersParams,
  Message,
  Page,
  SendMessageInput,
  UpsertUserInput,
  User,
} from './types';

const iso = (v: string | Date | undefined) => (v instanceof Date ? v.toISOString() : v);

/** The server answers lists with `{ data, meta }`; guarantee both are present so callers never null-check. */
function toPage<T>(res: { data: T[]; meta?: Page<T>['meta'] }): Page<T> {
  return { data: res.data ?? [], meta: res.meta ?? {} };
}

// None of the POST wrappers retry: the API has no idempotency key, so a retried POST after a lost
// response could send a message twice. GET wrappers use the transport's default (retry on transient failures).

export function createMessages(t: Transport) {
  return {
    /** Send a message. Rejects with MessagingExpressError (404 conversation not found, 400 sender not a participant, ...). Never retried. */
    async send(input: SendMessageInput): Promise<Message> {
      return (await t.request<Message>('POST', '/api/v1/messages', { body: input })).data;
    },
    /** Newest first. `meta` carries `limit` and `page` (no total for messages). */
    async list(params: ListMessagesParams): Promise<Page<Message>> {
      const { before, after, ...rest } = params;
      return toPage(await t.request<Message[]>('GET', '/api/v1/messages', { query: { ...rest, before: iso(before), after: iso(after) } }));
    },
  };
}

export function createConversations(t: Transport) {
  return {
    /** Create a conversation and add its participants. Never retried. */
    async create(input: CreateConversationInput): Promise<Conversation> {
      return (await t.request<Conversation>('POST', '/api/v1/conversations', { body: input })).data;
    },
    /** Most recently active first. `meta` carries `total` and `totalPages`. */
    async list(params: ListConversationsParams = {}): Promise<Page<ConversationListItem>> {
      return toPage(await t.request<ConversationListItem[]>('GET', '/api/v1/conversations', { query: { ...params } }));
    },
  };
}

export function createUsers(t: Transport) {
  return {
    /**
     * Create a user, or update the existing one with the same `externalId` (the API answers 201 either way).
     * Never retried.
     */
    async upsert(input: UpsertUserInput): Promise<User> {
      return (await t.request<User>('POST', '/api/v1/users', { body: input })).data;
    },
    /** Newest first. Note: `meta.total` counts ALL users of the project, not only those matching `search` / `externalId`. */
    async list(params: ListUsersParams = {}): Promise<Page<User>> {
      return toPage(await t.request<User[]>('GET', '/api/v1/users', { query: { ...params } }));
    },
  };
}
