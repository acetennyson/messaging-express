import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/** Stage 7.6 emitters, no database: `query` and `emitEvent` are fakes. */
const queryMock = vi.fn();
vi.mock('../db/pool', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
const emitMock = vi.fn();
vi.mock('./emit', () => ({ emitEvent: (i: unknown) => emitMock(i), schedule: (w: () => Promise<unknown>) => void w() }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerRealtime, unregisterRealtime } from '../realtime';
import {
  MAX_EVENT_RECIPIENTS,
  publishDeviceAdded,
  publishDevicesRemoved,
  publishKeysRequested,
  publishKeysUpdated,
  publishParticipantChange,
} from './e2ee';

const P = 'proj';
const U = 'u-linking';
const A = 'u-a';
const B = 'u-b';
const calls = () => emitMock.mock.calls.map((c) => c[0] as { event: string; channel: string; data: Record<string, unknown>; webhook?: boolean });

/** query(): first matching rule wins. */
function db(rules: Array<[RegExp, unknown[]]>) {
  queryMock.mockImplementation(async (sql: string) => {
    for (const [re, rows] of rules) if (re.test(sql)) return { rows };
    return { rows: [] };
  });
}

beforeEach(() => {
  emitMock.mockClear();
  queryMock.mockReset();
  registerRealtime({ publish: async () => {}, stats: () => ({}), close: async () => {} } as never);
});
afterEach(() => {
  unregisterRealtime();
  delete process.env.WEBHOOK_DISPATCH;
});

describe('device.added / device.removed', () => {
  const recipients = () =>
    db([
      [/SELECT c\.id::text AS id/, [{ id: 'c1' }, { id: 'c2' }]],
      [/array_agg/, [{ user_id: A, conversation_ids: ['c1'] }, { user_id: B, conversation_ids: ['c1', 'c2'] }]],
    ]);

  it('sends to the user and each co-member with only the shared conversation ids; one webhook per event', async () => {
    recipients();
    await publishDeviceAdded({ projectId: P, userId: U, deviceId: 'd9', publicKey: 'pk' });
    const c = calls();
    expect(c.map((x) => x.channel)).toEqual([`user:${U}`, `user:${A}`, `user:${B}`]);
    expect(c.every((x) => x.event === 'device.added')).toBe(true);
    expect(c[0].data).toEqual({ userId: U, deviceId: 'd9', publicKey: 'pk', conversationIds: ['c1', 'c2'] });
    expect(c[1].data.conversationIds).toEqual(['c1']);
    expect(c[2].data.conversationIds).toEqual(['c1', 'c2']);
    expect(c.map((x) => x.webhook)).toEqual([undefined, false, false]);
  });

  it('device.removed: one event per device per recipient, webhook once per device, no publicKey', async () => {
    recipients();
    await publishDevicesRemoved({ projectId: P, userId: U, deviceIds: ['d1', 'd2'] });
    const c = calls();
    expect(c).toHaveLength(6);
    expect(c.filter((x) => x.webhook === undefined).map((x) => x.data.deviceId)).toEqual(['d1', 'd2']);
    expect(c[0].data).toEqual({ userId: U, deviceId: 'd1', conversationIds: ['c1', 'c2'] });
  });

  it('a user with no e2ee conversations still hears about their own devices', async () => {
    db([]);
    await publishDeviceAdded({ projectId: P, userId: U, deviceId: 'd9', publicKey: 'pk' });
    expect(calls()).toHaveLength(1);
    expect(calls()[0].data.conversationIds).toEqual([]);
  });

  it('caps co-member recipients at MAX_EVENT_RECIPIENTS', async () => {
    const many = Array.from({ length: MAX_EVENT_RECIPIENTS + 1 }, (_, i) => ({ user_id: `m${i}`, conversation_ids: ['c1'] }));
    db([[/array_agg/, many]]);
    await publishDeviceAdded({ projectId: P, userId: U, deviceId: 'd9', publicKey: 'pk' });
    expect(calls()).toHaveLength(1 + MAX_EVENT_RECIPIENTS);
  });

  it('does no database work when nothing is listening (no realtime provider, webhooks off)', async () => {
    unregisterRealtime();
    await publishDeviceAdded({ projectId: P, userId: U, deviceId: 'd9', publicKey: 'pk' });
    await publishDevicesRemoved({ projectId: P, userId: U, deviceIds: ['d1'] });
    expect(queryMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('with webhooks on but no realtime provider it still emits (for the webhook)', async () => {
    unregisterRealtime();
    process.env.WEBHOOK_DISPATCH = 'on';
    db([]);
    await publishDeviceAdded({ projectId: P, userId: U, deviceId: 'd9', publicKey: 'pk' });
    expect(calls()).toHaveLength(1);
  });
});

describe('realtime-only events', () => {
  it('keys.updated: one event per owning user listing only that user\'s devices; never a webhook', async () => {
    db([[/FROM mx_devices/, [{ id: 'd1', user_id: A }, { id: 'd2', user_id: A }, { id: 'd3', user_id: B }]]]);
    await publishKeysUpdated({ projectId: P, conversationId: 'cv', keyVersion: 2, deviceIds: ['d1', 'd2', 'd3'] });
    expect(calls()).toEqual([
      { projectId: P, event: 'keys.updated', data: { conversationId: 'cv', keyVersion: 2, deviceIds: ['d1', 'd2'] }, channel: `user:${A}`, webhook: false },
      { projectId: P, event: 'keys.updated', data: { conversationId: 'cv', keyVersion: 2, deviceIds: ['d3'] }, channel: `user:${B}`, webhook: false },
    ]);
  });

  it('keys.requested: every other participant, keyVersion only when given', async () => {
    db([[/mx_conversation_participants/, [{ user_id: U }, { user_id: A }, { user_id: B }]]]);
    await publishKeysRequested({ projectId: P, conversationId: 'cv', requestingUserId: U, requestingDeviceId: 'd9' });
    expect(calls().map((x) => x.channel)).toEqual([`user:${A}`, `user:${B}`]);
    expect(calls()[0].data).toEqual({ conversationId: 'cv', requestingDeviceId: 'd9' });
    emitMock.mockClear();
    await publishKeysRequested({ projectId: P, conversationId: 'cv', requestingUserId: U, requestingDeviceId: 'd9', keyVersion: 3 });
    expect(calls()[0].data).toEqual({ conversationId: 'cv', keyVersion: 3, requestingDeviceId: 'd9' });
    expect(calls().every((x) => x.webhook === false)).toBe(true);
  });

  it('participant.removed: remaining participants AND the removed user hear it, with minKeyVersion', async () => {
    db([[/mx_conversation_participants/, [{ user_id: A }, { user_id: B }]]]);
    await publishParticipantChange({ projectId: P, conversationId: 'cv', userId: U, event: 'participant.removed', minKeyVersion: 4 });
    expect(calls().map((x) => x.channel).sort()).toEqual([`user:${A}`, `user:${B}`, `user:${U}`].sort());
    expect(calls()[0].data).toEqual({ conversationId: 'cv', userId: U, minKeyVersion: 4 });
  });

  it('participant.added carries no minKeyVersion; removal from a plain conversation has none either', async () => {
    db([[/mx_conversation_participants/, [{ user_id: A }, { user_id: U }]]]);
    await publishParticipantChange({ projectId: P, conversationId: 'cv', userId: U, event: 'participant.added' });
    expect(calls()).toHaveLength(2);
    expect(calls()[0].data).toEqual({ conversationId: 'cv', userId: U });
    emitMock.mockClear();
    await publishParticipantChange({ projectId: P, conversationId: 'cv', userId: U, event: 'participant.removed', minKeyVersion: null });
    expect(calls()[0].data).toEqual({ conversationId: 'cv', userId: U });
  });

  it('are no-ops without a realtime provider', async () => {
    unregisterRealtime();
    await publishKeysUpdated({ projectId: P, conversationId: 'cv', keyVersion: 1, deviceIds: ['d1'] });
    await publishKeysRequested({ projectId: P, conversationId: 'cv', requestingUserId: U, requestingDeviceId: 'd9' });
    await publishParticipantChange({ projectId: P, conversationId: 'cv', userId: U, event: 'participant.added' });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
