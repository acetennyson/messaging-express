/**
 * Drift guard for the client SDK (Implementation Plan, SDK-2). The SDK cannot import these Zod schemas,
 * so it keeps the field lists in packages/client/src/contract.ts. This test fails if the two disagree.
 * If it fails: update contract.ts and packages/client/src/types.ts to match the schema (or the other way round), in the same PR.
 */
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
