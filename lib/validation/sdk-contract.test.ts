/**
 * Drift guard for the client SDK (Implementation Plan, SDK-2). The SDK cannot import these Zod schemas,
 * so it keeps the field lists in packages/client/src/contract.ts. This test fails if the two disagree.
 * If it fails: update contract.ts and packages/client/src/types.ts to match the schema (or the other way round), in the same PR.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conversationQuerySchema,
  createConversationSchema,
  createMessageSchema,
  createUserSchema,
  messageQuerySchema,
  userQuerySchema,
} from './schemas';
import {
  ATTACHMENT_TYPES,
  CONVERSATION_TYPES,
  MESSAGE_TYPES,
  REALTIME_WIRE,
  REQUEST_FIELDS,
} from '../../packages/client/src/contract';

const keys = (shape: Record<string, unknown>) => Object.keys(shape).sort();
const sorted = (a: readonly string[]) => [...a].sort();

describe('SDK contract matches the server schemas', () => {
  it('createMessage fields', () => expect(sorted(REQUEST_FIELDS.createMessage)).toEqual(keys(createMessageSchema.shape)));

  it('message attachment fields', () => {
    const attachment = createMessageSchema.shape.attachments.unwrap().element;
    expect(sorted(REQUEST_FIELDS.messageAttachment)).toEqual(keys(attachment.shape));
  });

  it('messageQuery fields', () => expect(sorted(REQUEST_FIELDS.messageQuery)).toEqual(keys(messageQuerySchema.shape)));
  it('createConversation fields', () => expect(sorted(REQUEST_FIELDS.createConversation)).toEqual(keys(createConversationSchema.shape)));
  it('conversationQuery fields', () => expect(sorted(REQUEST_FIELDS.conversationQuery)).toEqual(keys(conversationQuerySchema.shape)));
  it('createUser fields', () => expect(sorted(REQUEST_FIELDS.createUser)).toEqual(keys(createUserSchema.shape)));
  it('userQuery fields', () => expect(sorted(REQUEST_FIELDS.userQuery)).toEqual(keys(userQuerySchema.shape)));

  it('enums', () => {
    expect(sorted(MESSAGE_TYPES)).toEqual(sorted(createMessageSchema.shape.type.removeDefault().options));
    expect(sorted(ATTACHMENT_TYPES)).toEqual(sorted(createMessageSchema.shape.attachments.unwrap().element.shape.type.options));
    expect(sorted(CONVERSATION_TYPES)).toEqual(sorted(createConversationSchema.shape.type.options));
  });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('SDK realtime wire contract matches the server source', () => {
  const socketSource = readFileSync(path.join(__dirname, '../realtime/providers/socketio.ts'), 'utf8');

  it.each([
    ['client events', REALTIME_WIRE.clientEvents],
    ['ack codes', REALTIME_WIRE.ackCodes],
    ['connect error codes', REALTIME_WIRE.connectErrorCodes],
  ])('%s are still spelled the same in socketio.ts', (_label, names) => {
    for (const name of names) expect(socketSource, `"${name}" not found in socketio.ts`).toContain(`'${name}'`);
  });

  it('the events routes publish to rooms are exactly the ones the SDK types', () => {
    const published = new Set<string>();
    for (const file of routeFiles(path.join(__dirname, '../../app/api/v1'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/emitEvent\(\{([\s\S]*?)\}\);/g)) {
        if (/\bchannel\s*:/.test(m[1])) {
          const ev = m[1].match(/event:\s*'([^']+)'/);
          if (ev) published.add(ev[1]);
        }
      }
    }
    expect([...published].sort()).toEqual([...REALTIME_WIRE.serverEvents].sort());
  });
});
