import { afterEach, describe, expect, it } from 'vitest';
import { allowedMimeTypesFor } from './config';
import { testContext, testConfig } from '../core/testing';

const base = ['image/png', 'application/pdf'];
const env: Record<string, string | undefined> = {};
const ctx = testContext(undefined, { config: testConfig(env) });
afterEach(() => {
  delete env.E2EE_ENABLED;
});

describe('allowedMimeTypesFor (Stage 7.8)', () => {
  it('flag off: the list is untouched for every category', () => {
    env.E2EE_ENABLED = 'off';
    expect(allowedMimeTypesFor(ctx, 'e2ee', base)).toBe(base);
    expect(allowedMimeTypesFor(ctx, undefined, base)).toBe(base);
  });
  it('flag on: only category "e2ee" gains application/octet-stream', () => {
    env.E2EE_ENABLED = 'on';
    expect(allowedMimeTypesFor(ctx, 'e2ee', base)).toEqual([...base, 'application/octet-stream']);
    expect(allowedMimeTypesFor(ctx, undefined, base)).toBe(base);
    expect(allowedMimeTypesFor(ctx, 'avatars', base)).toBe(base);
    expect(allowedMimeTypesFor(ctx, 'E2EE', base)).toBe(base);
  });
  it('does not mutate the configured list or duplicate an entry', () => {
    env.E2EE_ENABLED = 'on';
    const copy = [...base];
    allowedMimeTypesFor(ctx, 'e2ee', base);
    expect(base).toEqual(copy);
    const withOctet = [...base, 'application/octet-stream'];
    expect(allowedMimeTypesFor(ctx, 'e2ee', withOctet)).toBe(withOctet);
  });
});
