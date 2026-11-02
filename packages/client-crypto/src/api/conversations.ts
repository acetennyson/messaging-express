import { call, type RequestClient } from './transport';
import type { KeyEntry } from './keys';

/** The conversation row as the server returns it (snake_case), reduced to what this package reads. Extra fields pass through. */
export interface E2eeConversation {
  id: string;
  type: string;
  encryption_mode: 'none' | 'e2ee-v1';
  min_key_version: number;
  [k: string]: unknown;
}

export interface CreateEncryptedConversationInput {
  /** The conversation id the wraps were bound to. Wraps need the id before the server could assign one, so the client chooses it (UUID). Needs server change 7.10. */
  id: string;
  type: 'direct' | 'group';
  title?: string;
  /** Must include the creator. */
  participantIds: string[];
  metadata?: Record<string, unknown>;
  /** Wraps of the version-1 key for EXACTLY the active devices of every participant, wrapped by the calling device. */
  keys: KeyEntry[];
}

/** POST /conversations with encryptionMode "e2ee-v1" [Dev]. Atomic: the conversation and its keys exist together or not at all. Never retried. */
export const createEncryptedConversation = (c: RequestClient, deviceId: string, input: CreateEncryptedConversationInput, signal?: AbortSignal) =>
  call<E2eeConversation>(c, 'POST', '/conversations', { deviceId, body: { ...input, encryptionMode: 'e2ee-v1' }, signal });

/** POST /conversations/:id/participants. `added` is false when the user was already a participant (200 instead of 201). */
export function addParticipant(c: RequestClient, conversationId: string, userId: string, signal?: AbortSignal) {
  return call<{ conversationId: string; userId: string }>(c, 'POST', `/conversations/${encodeURIComponent(conversationId)}/participants`, { body: { userId }, signal });
}

/** DELETE /conversations/:id/participants/:userId. `minKeyVersion` is the new floor in an e2ee conversation (null otherwise): rotate before sending. */
export const removeParticipant = (c: RequestClient, conversationId: string, userId: string, signal?: AbortSignal) =>
  call<{ conversationId: string; userId: string; minKeyVersion: number | null }>(
    c, 'DELETE', `/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(userId)}`, { signal });

export interface PostMessageInput {
  conversationId: string;
  senderId: string;
  /** Base64url ciphertext from encryptSecureMessage. */
  content: string;
  keyVersion: number;
  type?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
}

/** POST /messages on an e2ee conversation: adds metadata.scheme "ck-xchacha-v1" and metadata.key_version. Never retried. */
export function postEncryptedMessage(c: RequestClient, input: PostMessageInput, signal?: AbortSignal) {
  const { keyVersion, metadata, ...rest } = input;
  return call<Record<string, unknown> & { id: string }>(c, 'POST', '/messages', {
    body: { ...rest, metadata: { ...metadata, scheme: 'ck-xchacha-v1', key_version: keyVersion } },
    signal,
  });
}
