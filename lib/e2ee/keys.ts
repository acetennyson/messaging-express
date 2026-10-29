import { ForbiddenError, NotFoundError, RequestValidationError } from '../errors';
import { ParticipantHasNoDeviceError, StaleDeviceSetError } from './errors';
import type { KeyEntry } from './schemas';

/** Anything with a pg-style query(): a pool client inside a transaction, or the pool-level `query` wrapper. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read by column name at each call site
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface E2eeConversation {
  id: string;
  encryption_mode: string;
  min_key_version: number;
}

/**
 * Load a conversation of this project that the caller takes part in, and require it to be end-to-end encrypted.
 * 404 unknown (or another project's), 403 not a participant, 400 not an e2ee conversation.
 */
export async function loadE2eeConversationForMember(
  client: Queryable,
  conversationId: string,
  projectId: string,
  userId: string,
  opts: { lock?: boolean } = {}
): Promise<E2eeConversation> {
  const r = await client.query(
    `SELECT c.id, c.encryption_mode, c.min_key_version,
            EXISTS (SELECT 1 FROM mx_conversation_participants p WHERE p.conversation_id = c.id AND p.user_id = $3) AS is_member
     FROM mx_conversations c
     WHERE c.id = $1 AND c.project_id = $2
     ${opts.lock ? 'FOR UPDATE OF c' : ''}`,
    [conversationId, projectId, userId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Conversation not found');
  if (!r.rows[0].is_member) throw new ForbiddenError('You are not a participant of this conversation');
  if (r.rows[0].encryption_mode !== 'e2ee-v1') {
    throw new RequestValidationError('This conversation is not end-to-end encrypted');
  }
  return r.rows[0];
}

/**
 * Active devices of the given users. First takes a SHARE lock on those user rows (in id order, so concurrent calls cannot
 * deadlock): register / link / pair / revoke / reset all take the same row FOR UPDATE, so the device set cannot change
 * between this read and the key insert that follows in the same transaction.
 */
export async function lockedActiveDevices(
  client: Queryable,
  projectId: string,
  userIds: string[]
): Promise<{ id: string; user_id: string }[]> {
  await client.query('SELECT id FROM mx_users WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE', [projectId, userIds]);
  const r = await client.query(
    `SELECT id, user_id FROM mx_devices
     WHERE project_id = $1 AND user_id = ANY($2::uuid[]) AND revoked_at IS NULL
     ORDER BY created_at, id`,
    [projectId, userIds]
  );
  return r.rows;
}

/** Reject duplicate target devices, and wraps that were not made by the calling device. */
export function assertWellFormedKeys(keys: KeyEntry[], callerDeviceId: string): void {
  if (new Set(keys.map((k) => k.deviceId)).size !== keys.length) {
    throw new RequestValidationError('keys contains the same deviceId more than once');
  }
  if (keys.some((k) => k.wrappedByDeviceId !== callerDeviceId)) {
    throw new RequestValidationError('wrappedByDeviceId must be the calling device (X-Device-Id)');
  }
}

/** The keys must cover EXACTLY the active devices of the participants (no more, no fewer). */
export function assertFullCoverage(
  active: { id: string; user_id: string }[],
  participantIds: string[],
  keys: KeyEntry[]
): void {
  const usersWithDevice = new Set(active.map((d) => d.user_id));
  const without = participantIds.filter((u) => !usersWithDevice.has(u));
  if (without.length > 0) throw new ParticipantHasNoDeviceError(without);

  const have = new Set(keys.map((k) => k.deviceId));
  const need = active.map((d) => d.id);
  if (have.size !== need.length || need.some((id) => !have.has(id))) throw new StaleDeviceSetError(need);
}

/** Insert wrapped keys for one version. First writer wins per (conversation, device, version). Returns rows inserted. */
export async function insertKeys(
  client: Queryable,
  conversationId: string,
  keyVersion: number,
  keys: KeyEntry[]
): Promise<number> {
  const r = await client.query(
    `INSERT INTO mx_conversation_keys (conversation_id, device_id, key_version, wrapped_key, wrapped_by_device_id)
     SELECT $1, k.device_id, $2, k.wrapped_key, k.by_device_id
     FROM unnest($3::uuid[], $4::text[], $5::uuid[]) AS k(device_id, wrapped_key, by_device_id)
     ON CONFLICT (conversation_id, device_id, key_version) DO NOTHING
     RETURNING device_id`,
    [conversationId, keyVersion, keys.map((k) => k.deviceId), keys.map((k) => k.wrappedKey), keys.map((k) => k.wrappedByDeviceId)]
  );
  return r.rows.length;
}
