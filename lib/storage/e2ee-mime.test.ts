import { afterEach, describe, expect, it } from 'vitest';
import { allowedMimeTypesFor } from './config';

const base = ['image/png', 'application/pdf'];
afterEach(() => {
  delete process.env.E2EE_ENABLED;
});

describe('allowedMimeTypesFor (Stage 7.8)', () => {
  it('flag off: the list is untouched for every category', () => {
    process.env.E2EE_ENABLED = 'off';
    expect(allowedMimeTypesFor('e2ee', base)).toBe(base);
    expect(allowedMimeTypesFor(undefined, base)).toBe(base);
  });
  it('flag on: only category "e2ee" gains application/octet-stream', () => {
    process.env.E2EE_ENABLED = 'on';
    expect(allowedMimeTypesFor('e2ee', base)).toEqual([...base, 'application/octet-stream']);
    expect(allowedMimeTypesFor(undefined, base)).toBe(base);
    expect(allowedMimeTypesFor('avatars', base)).toBe(base);
    expect(allowedMimeTypesFor('E2EE', base)).toBe(base);
  });
  it('does not mutate the configured list or duplicate an entry', () => {
    process.env.E2EE_ENABLED = 'on';
    const copy = [...base];
    allowedMimeTypesFor('e2ee', base);
    expect(base).toEqual(copy);
    const withOctet = [...base, 'application/octet-stream'];
    expect(allowedMimeTypesFor('e2ee', withOctet)).toBe(withOctet);
  });
});
