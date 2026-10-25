/**
 * Compile-time guard (checked by `npm run typecheck:sdk`, never executed): the hand-written request types
 * in src/types.ts must use exactly the field names listed in src/contract.ts, which the server's test
 * (lib/validation/sdk-contract.test.ts) in turn checks against the real Zod schemas.
 */
import type { REALTIME_WIRE, REQUEST_FIELDS } from '../src/contract';
import type { RealtimeEventMap } from '../src/realtime';
import type {
  CreateConversationInput,
  ListConversationsParams,
  ListMessagesParams,
  ListUsersParams,
  SendMessageInput,
  UpsertUserInput,
  UploadedAttachment,
} from '../src/types';

type Fields<K extends keyof typeof REQUEST_FIELDS> = (typeof REQUEST_FIELDS)[K][number];
type Same<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type Subset<A extends string, B extends string> = [A] extends [B] ? true : never;

// Inputs the SDK exposes completely: identical field sets.
export const _send: Same<keyof SendMessageInput & string, Fields<'createMessage'>> = true;
export const _conv: Same<keyof CreateConversationInput & string, Fields<'createConversation'>> = true;
export const _user: Same<keyof UpsertUserInput & string, Fields<'createUser'>> = true;
// An uploaded attachment must be assignable to the server's attachment: no field the server does not know.
export const _att: Subset<keyof UploadedAttachment & string, Fields<'messageAttachment'>> = true;
// List params: the SDK exposes a subset (no cursor/sort yet, no isArchived), never a field the server lacks.
export const _lm: Subset<keyof ListMessagesParams & string, Fields<'messageQuery'>> = true;
export const _lc: Subset<keyof ListConversationsParams & string, Fields<'conversationQuery'>> = true;
export const _lu: Subset<keyof ListUsersParams & string, Fields<'userQuery'>> = true;
// Realtime: the typed event map lists exactly the events the server publishes to rooms.
export const _rt: Same<keyof RealtimeEventMap & string, (typeof REALTIME_WIRE.serverEvents)[number]> = true;
