import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getE2eeEnabled, getEnumFlag, resetFlagWarnings } from './flags';
import { logger } from '../logger';

const MODES = ['off', 'dry-run', 'enforce'] as const;
const NAME = 'TEST_FLAG_P2';

describe('getEnumFlag', () => {
  beforeEach(() => {
    delete process.env[NAME];
    resetFlagWarnings();
  });
  afterEach(() => {
    delete process.env[NAME];
    vi.restoreAllMocks();
  });

  it('returns the fallback when unset', () => {
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('off');
  });

  it('returns the fallback for an empty or whitespace value', () => {
    process.env[NAME] = '';
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('off');
    process.env[NAME] = '   ';
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('off');
  });

  it('accepts an allowed value, ignoring case and surrounding whitespace', () => {
    process.env[NAME] = '  Dry-Run ';
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('dry-run');
  });

  it('reads the environment on every call (no module-level caching)', () => {
    process.env[NAME] = 'dry-run';
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('dry-run');
    process.env[NAME] = 'enforce';
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('enforce');
    delete process.env[NAME];
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('off');
  });

  it('falls back (and does not throw) on an unrecognized value', () => {
    process.env[NAME] = 'enforcing';
    expect(getEnumFlag(NAME, MODES, 'off')).toBe('off');
  });

  it('warns once per distinct invalid value, not on every call', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env[NAME] = 'bogus';
    getEnumFlag(NAME, MODES, 'off');
    getEnumFlag(NAME, MODES, 'off');
    getEnumFlag(NAME, MODES, 'off');
    expect(warn).toHaveBeenCalledTimes(1);
    process.env[NAME] = 'other-bogus';
    getEnumFlag(NAME, MODES, 'off');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('getE2eeEnabled', () => {
  beforeEach(() => {
    delete process.env.E2EE_ENABLED;
    resetFlagWarnings();
  });
  afterEach(() => {
    delete process.env.E2EE_ENABLED;
    vi.restoreAllMocks();
  });

  it('defaults to off when unset, empty or invalid', () => {
    expect(getE2eeEnabled()).toBe('off');
    process.env.E2EE_ENABLED = '';
    expect(getE2eeEnabled()).toBe('off');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.E2EE_ENABLED = 'yes';
    expect(getE2eeEnabled()).toBe('off');
  });

  it('is on only for the exact value, read on every call', () => {
    process.env.E2EE_ENABLED = ' ON ';
    expect(getE2eeEnabled()).toBe('on');
    process.env.E2EE_ENABLED = 'off';
    expect(getE2eeEnabled()).toBe('off');
  });
});
