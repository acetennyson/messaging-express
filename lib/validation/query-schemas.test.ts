import { describe, expect, it } from 'vitest';
import { conversationQuerySchema } from './schemas';

// Routes build the input with Object.fromEntries(searchParams), so every value arrives as a string.
describe('conversationQuerySchema: isArchived from a query string', () => {
  it('"true" becomes true and "false" becomes false', () => {
    expect(conversationQuerySchema.parse({ isArchived: 'true' }).isArchived).toBe(true);
    expect(conversationQuerySchema.parse({ isArchived: 'false' }).isArchived).toBe(false);
  });

  it('stays undefined when the filter is not sent (so the route adds no WHERE clause)', () => {
    expect(conversationQuerySchema.parse({}).isArchived).toBeUndefined();
  });

  it('rejects anything else instead of guessing', () => {
    for (const bad of ['yes', '1', '', 'TRUE', 'null']) {
      expect(conversationQuerySchema.safeParse({ isArchived: bad }).success, `"${bad}" should be rejected`).toBe(false);
    }
  });

  it('works together with the other filters', () => {
    const q = conversationQuerySchema.parse({ type: 'group', isArchived: 'false', limit: '10' });
    expect(q).toMatchObject({ type: 'group', isArchived: false, limit: 10 });
  });
});
