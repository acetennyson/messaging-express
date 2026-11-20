import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors';
import { resolveOptions, configReaderFor } from './options';
import { createConfig } from './core/config';

const SECRET = 'a-secret-that-is-long-enough-for-us-1234';
const ok = { database: 'postgres://u@localhost/db', jwtSecret: SECRET };

function failure(input: unknown): ConfigError {
  try {
    resolveOptions(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('expected resolveOptions to throw');
}

describe('init option validation (D5)', () => {
  it('names the missing required option', () => {
    expect(failure({ jwtSecret: SECRET }).option).toBe('database');
    expect(failure({ jwtSecret: SECRET }).message).toContain("'database'");
    expect(failure({ database: ok.database }).option).toBe('jwtSecret');
    expect(failure({ database: '  ', jwtSecret: SECRET }).option).toBe('database');
    expect(failure({ database: {}, jwtSecret: SECRET }).option).toBe('database');
    expect(failure(undefined).option).toBe('options');
  });

  it('rejects a short or blank secret', () => {
    expect(failure({ ...ok, jwtSecret: 'short' }).message).toContain('too short');
    expect(failure({ ...ok, jwtSecret: '   ' }).option).toBe('jwtSecret');
    expect(failure({ ...ok, jwtSecret: 123 }).option).toBe('jwtSecret');
  });

  it('rejects unknown options (typos) by name', () => {
    expect(failure({ ...ok, jwtSecrt: 'x' }).option).toBe('jwtSecrt');
    expect(failure({ ...ok, apiKey: 'x' }).option).toBe('apiKey'); // removed from the module (D4)
  });

  it.each([
    ['schema', 'Bad-Schema'],
    ['schema', 'a; drop table x'],
    ['projectName', ''],
    ['participantAccess', 'maybe'],
    ['e2ee', true],
    ['authenticate', 'nope'],
    ['authenticateTimeoutMs', 0],
    ['authenticateTimeoutMs', 1.5],
    ['cors', []],
    ['cors', 'https://a.example'],
    ['cors', ['a,b']],
    ['logger', { info() {} }],
  ])('rejects bad %s = %j', (name, value) => {
    expect(failure({ ...ok, [name]: value }).option).toBe(name);
  });

  it('applies the documented defaults', () => {
    const r = resolveOptions(ok);
    expect(r).toMatchObject({
      schema: 'messaging',
      projectName: 'default',
      participantAccess: 'enforce',
      e2ee: 'on',
      authenticateTimeoutMs: 5000,
      cors: false,
    });
    expect(r.authenticate).toBeUndefined();
  });

  it('accepts a pool, a connection string and a config object', () => {
    const pool = { query() {}, connect() {}, end() {} };
    expect(() => resolveOptions({ ...ok, database: pool })).not.toThrow();
    expect(() => resolveOptions({ ...ok, database: { host: 'h', database: 'd' } })).not.toThrow();
  });

  it('derives the shared config from the options, never from process.env', () => {
    const cfg = (o: object) => createConfig(configReaderFor(resolveOptions({ ...ok, ...o })));
    const d = cfg({});
    expect(d.participantAccessMode()).toBe('enforce');
    expect(d.e2eeEnabled()).toBe('on');
    expect(d.rateLimitMode()).toBe('off');
    expect(d.webhookDispatch()).toBe('off');
    expect(d.jwt.secret).toBe(SECRET);
    expect(d.corsAllowedOrigins).not.toBe('*'); // cors:false must not open CORS
    const o = cfg({ participantAccess: 'off', e2ee: 'off', cors: ['https://a.example', 'https://b.example'] });
    expect(o.participantAccessMode()).toBe('off');
    expect(o.e2eeEnabled()).toBe('off');
    expect(o.corsAllowedOrigins).toBe('https://a.example,https://b.example');
  });
});
