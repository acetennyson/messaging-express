import { RequestValidationError } from '../errors';
import { KeyRotationRequiredError, KeysNotReadyError } from './errors';
import type { Queryable } from './keys';

export const E2EE_V1_SCHEME = 'ck-xchacha-v1';
/** version byte (1) + XChaCha20 nonce (24) + Poly1305 tag (16): the smallest possible v1 ciphertext (empty plaintext). */
const MIN_CIPHERTEXT_BYTES = 41;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const HINT = 'Use client.crypto.sendSecureMessage() from @messaging-express/client-crypto, which encrypts for you.';

export interface ConversationMode {
  id: string;
  encryption_mode: string;
  min_key_version: number;
}

interface MessageInput {
  content?: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{
    mimeType?: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
  }>;
}

/**
 * Stage 7.5. Runs only when E2EE_ENABLED=on, after the existing conversation/participant checks and before the insert.
 *
 * These checks catch MISTAKES (a client that forgot to encrypt, or used a retired key), not attackers: the server cannot
 * tell real ciphertext from random bytes, and `senderId` is still supplied by the caller.
 */
export async function assertMessageMatchesEncryption(client: Queryable, conv: ConversationMode, data: MessageInput): Promise<void> {
  const meta = data.metadata ?? {};

  if (conv.encryption_mode === 'none') {
    if (meta.scheme !== undefined) {
      throw new RequestValidationError('metadata.scheme is only valid in an end-to-end encrypted conversation');
    }
    return;
  }
  if (conv.encryption_mode !== 'e2ee-v1') {
    throw new RequestValidationError(`Messages in a "${conv.encryption_mode}" conversation are not supported by this endpoint`);
  }

  // ---- structure (400): the message is not an e2ee-v1 message
  if (meta.scheme !== E2EE_V1_SCHEME) {
    throw new RequestValidationError(`This conversation is end-to-end encrypted: metadata.scheme must be "${E2EE_V1_SCHEME}". ${HINT}`);
  }
  const keyVersion = meta.key_version;
  if (typeof keyVersion !== 'number' || !Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new RequestValidationError(`This conversation is end-to-end encrypted: metadata.key_version must be a positive integer. ${HINT}`);
  }
  const content = data.content;
  if (typeof content !== 'string' || !BASE64URL.test(content)) {
    throw new RequestValidationError(`This conversation is end-to-end encrypted: content must be a base64url ciphertext, not plaintext. ${HINT}`);
  }
  const bytes = Buffer.from(content, 'base64url');
  if (bytes.length < MIN_CIPHERTEXT_BYTES || bytes[0] !== 0x01) {
    throw new RequestValidationError(`content is not a valid ${E2EE_V1_SCHEME} ciphertext (wrong version byte or too short). ${HINT}`);
  }
  for (const a of data.attachments ?? []) {
    // Attachments in an encrypted conversation are opaque blobs; their real type, size and dimensions live inside the
    // encrypted payload. Image-derived fields here mean a plaintext upload slipped through.
    if (
      (a.mimeType !== undefined && a.mimeType !== 'application/octet-stream') ||
      a.thumbnailUrl !== undefined ||
      a.width !== undefined ||
      a.height !== undefined ||
      a.durationSeconds !== undefined
    ) {
      throw new RequestValidationError(
        'Attachments in an end-to-end encrypted conversation must be encrypted blobs (mimeType application/octet-stream, no thumbnail, width, height or duration). ' + HINT
      );
    }
  }

  // ---- key state (409): the structure is fine but the key situation is not
  const latest = (await client.query('SELECT MAX(key_version) AS v FROM mx_conversation_keys WHERE conversation_id = $1', [conv.id])).rows[0].v as number | null;
  if (latest === null) throw new KeysNotReadyError();
  if (keyVersion < conv.min_key_version) throw new KeyRotationRequiredError(conv.min_key_version);
  if (keyVersion > latest) {
    throw new RequestValidationError(`metadata.key_version ${keyVersion} does not exist yet (the latest is ${latest})`);
  }
}
