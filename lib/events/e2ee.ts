import { getWebhookDispatch } from '../config/flags';
import { query } from '../db/pool';
import { logger } from '../logger';
import { getRealtime } from '../realtime';
import { userChannel } from '../realtime/channels';
import { emitEvent, schedule } from './emit';

/**
 * E2EE realtime events (Stage 7.6). Contract: docs/E2EE_API_CONTRACT.md, "Realtime".
 *
 * Every event goes to per-user rooms (`user:<id>`), because clients only join rooms of conversations they have open.
 * Delivery is best-effort: the clients' piggyback check and request-on-failure cover lost events. These helpers never
 * throw into a request: the public `emit*` functions run after the response and log failures; the `publish*` functions
 * they wrap are exported for tests.
 */

/** Per-event cap on recipients; beyond it a warning is logged and the client fallbacks cover the rest. */
export const MAX_EVENT_RECIPIENTS = 500;

/** Is anything listening (a realtime provider, and for webhook events, webhook dispatch)? Saves the recipient queries when not. */
const realtimeOn = () => !!getRealtime();
const anyConsumer = () => realtimeOn() || getWebhookDispatch() === 'on';

/**
 * The user (their own conversations) plus every distinct co-member of the user's e2ee conversations, with the
 * conversation ids they share. Co-members are capped at MAX_EVENT_RECIPIENTS (ordered by id, so the cut is stable).
 */
async function deviceEventRecipients(projectId: string, userId: string) {
  const [own, co] = await Promise.all([
    query(
      `SELECT c.id::text AS id FROM mx_conversations c
       JOIN mx_conversation_participants p ON p.conversation_id = c.id
       WHERE p.user_id = $1 AND c.project_id = $2 AND c.encryption_mode = 'e2ee-v1'
       ORDER BY c.created_at, c.id`,
      [userId, projectId]
    ),
    query(
      `SELECT p2.user_id::text AS user_id, array_agg(DISTINCT c.id::text) AS conversation_ids
       FROM mx_conversation_participants p1
       JOIN mx_conversations c ON c.id = p1.conversation_id AND c.project_id = $2 AND c.encryption_mode = 'e2ee-v1'
       JOIN mx_conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id <> $1
       WHERE p1.user_id = $1
       GROUP BY p2.user_id
       ORDER BY p2.user_id
       LIMIT ${MAX_EVENT_RECIPIENTS + 1}`,
      [userId, projectId]
    ),
  ]);
  let coMembers = co.rows.map((r) => ({ userId: r.user_id as string, conversationIds: r.conversation_ids as string[] }));
  if (coMembers.length > MAX_EVENT_RECIPIENTS) {
    logger.warn('e2ee_event_recipients_truncated', { projectId, userId, cap: MAX_EVENT_RECIPIENTS });
    coMembers = coMembers.slice(0, MAX_EVENT_RECIPIENTS);
  }
  return { selfConversationIds: own.rows.map((r) => r.id as string), coMembers };
}

interface DeviceEventArgs {
  projectId: string;
  userId: string;
  deviceId: string;
}

/** device.added: the linking user + each co-member. ONE webhook per device (on the user's own copy), realtime to all. */
export async function publishDeviceAdded(args: DeviceEventArgs & { publicKey: string }): Promise<void> {
  if (!anyConsumer()) return;
  const { projectId, userId, deviceId, publicKey } = args;
  const r = await deviceEventRecipients(projectId, userId);
  const base = { userId, deviceId, publicKey };
  emitEvent({ projectId, event: 'device.added', data: { ...base, conversationIds: r.selfConversationIds }, channel: userChannel(userId) });
  for (const m of r.coMembers) {
    emitEvent({ projectId, event: 'device.added', data: { ...base, conversationIds: m.conversationIds }, channel: userChannel(m.userId), webhook: false });
  }
}

/** device.removed for one or more devices of one user (recipients are computed once). One webhook per device. */
export async function publishDevicesRemoved(args: { projectId: string; userId: string; deviceIds: string[] }): Promise<void> {
  if (!anyConsumer() || args.deviceIds.length === 0) return;
  const { projectId, userId, deviceIds } = args;
  const r = await deviceEventRecipients(projectId, userId);
  for (const deviceId of deviceIds) {
    emitEvent({ projectId, event: 'device.removed', data: { userId, deviceId, conversationIds: r.selfConversationIds }, channel: userChannel(userId) });
    for (const m of r.coMembers) {
      emitEvent({ projectId, event: 'device.removed', data: { userId, deviceId, conversationIds: m.conversationIds }, channel: userChannel(m.userId), webhook: false });
    }
  }
}

/** keys.updated: each user owning a target device is told which of their devices got a wrap (realtime only). */
export async function publishKeysUpdated(args: { projectId: string; conversationId: string; keyVersion: number; deviceIds: string[] }): Promise<void> {
  if (!realtimeOn() || args.deviceIds.length === 0) return;
  const { projectId, conversationId, keyVersion } = args;
  const r = await query('SELECT id::text AS id, user_id::text AS user_id FROM mx_devices WHERE project_id = $1 AND id = ANY($2::uuid[])', [
    projectId,
    args.deviceIds,
  ]);
  const byUser = new Map<string, string[]>();
  for (const d of r.rows) byUser.set(d.user_id, [...(byUser.get(d.user_id) ?? []), d.id]);
  for (const [uid, deviceIds] of [...byUser].slice(0, MAX_EVENT_RECIPIENTS)) {
    emitEvent({ projectId, event: 'keys.updated', data: { conversationId, keyVersion, deviceIds }, channel: userChannel(uid), webhook: false });
  }
}

/** Participants of a conversation (cap applied), optionally without one user. */
async function participantIds(projectId: string, conversationId: string, exclude?: string): Promise<string[]> {
  const r = await query(
    `SELECT p.user_id::text AS user_id FROM mx_conversation_participants p
     JOIN mx_conversations c ON c.id = p.conversation_id
     WHERE p.conversation_id = $1 AND c.project_id = $2 ORDER BY p.user_id LIMIT ${MAX_EVENT_RECIPIENTS + 1}`,
    [conversationId, projectId]
  );
  let ids = r.rows.map((x) => x.user_id as string).filter((id) => id !== exclude);
  if (r.rows.length > MAX_EVENT_RECIPIENTS) {
    logger.warn('e2ee_event_recipients_truncated', { projectId, conversationId, cap: MAX_EVENT_RECIPIENTS });
    ids = ids.slice(0, MAX_EVENT_RECIPIENTS);
  }
  return ids;
}

/** keys.requested: every OTHER participant, so a member holding the key can answer (realtime only). */
export async function publishKeysRequested(args: {
  projectId: string;
  conversationId: string;
  requestingUserId: string;
  requestingDeviceId: string;
  keyVersion?: number;
}): Promise<void> {
  if (!realtimeOn()) return;
  const { projectId, conversationId, requestingDeviceId, keyVersion } = args;
  const data = { conversationId, ...(keyVersion !== undefined ? { keyVersion } : {}), requestingDeviceId };
  for (const uid of await participantIds(projectId, conversationId, args.requestingUserId)) {
    emitEvent({ projectId, event: 'keys.requested', data, channel: userChannel(uid), webhook: false });
  }
}

/**
 * participant.added / participant.removed (wired by Stage 7.7): every current participant, plus the user concerned
 * (a removed user is no longer a participant but must still hear about it). `minKeyVersion` only on removal.
 */
export async function publishParticipantChange(args: {
  projectId: string;
  conversationId: string;
  userId: string;
  event: 'participant.added' | 'participant.removed';
  minKeyVersion?: number | null;
}): Promise<void> {
  if (!realtimeOn()) return;
  const { projectId, conversationId, userId, event } = args;
  const data = { conversationId, userId, ...(event === 'participant.removed' && args.minKeyVersion != null ? { minKeyVersion: args.minKeyVersion } : {}) };
  const recipients = new Set([...(await participantIds(projectId, conversationId)), userId]);
  for (const uid of recipients) emitEvent({ projectId, event, data, channel: userChannel(uid), webhook: false });
}

// ---- Fire-and-forget wrappers used by the routes: run after the response, failures logged, never thrown. ----
const background = (work: () => Promise<void>, name: string, meta: Record<string, unknown>): void => schedule(work, `emit_${name}_failed`, meta);

export const emitDeviceAdded = (a: Parameters<typeof publishDeviceAdded>[0]): void =>
  background(() => publishDeviceAdded(a), 'device_added', { projectId: a.projectId, userId: a.userId });
export const emitDevicesRemoved = (a: Parameters<typeof publishDevicesRemoved>[0]): void =>
  background(() => publishDevicesRemoved(a), 'device_removed', { projectId: a.projectId, userId: a.userId });
export const emitKeysUpdated = (a: Parameters<typeof publishKeysUpdated>[0]): void =>
  background(() => publishKeysUpdated(a), 'keys_updated', { projectId: a.projectId, conversationId: a.conversationId });
export const emitKeysRequested = (a: Parameters<typeof publishKeysRequested>[0]): void =>
  background(() => publishKeysRequested(a), 'keys_requested', { projectId: a.projectId, conversationId: a.conversationId });
export const emitParticipantChange = (a: Parameters<typeof publishParticipantChange>[0]): void =>
  background(() => publishParticipantChange(a), 'participant_change', { projectId: a.projectId, conversationId: a.conversationId });
