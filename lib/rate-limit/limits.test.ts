import { afterEach, describe, expect, it } from 'vitest';
import { limitForRequest, pathGroup, DEFAULT_RULES } from './limits';

const who = { projectId: 'p1', userId: 'u1' };

describe('pathGroup', () => {
  it('maps known paths', () => {
    expect(pathGroup('/api/v1/messages')).toBe('messages');
    expect(pathGroup('/api/v1/messages/')).toBe('messages');
    expect(pathGroup('/api/v1/uploads')).toBe('uploads');
    expect(pathGroup('/api/v1/uploads/presign')).toBe('uploads/presign');
    expect(pathGroup('/api/v1/conversations')).toBe('conversations');
    expect(pathGroup('/api/v1/users')).toBe('users');
    expect(pathGroup('/api/v1/devices')).toBe('devices');
    expect(pathGroup('/api/v1/devices/3f2c')).toBe('devices');
    expect(pathGroup('/api/v1/devices/pair')).toBe('devices/pair');
    expect(pathGroup('/api/v1/devices/link/')).toBe('devices/link');
    expect(pathGroup('/api/v1/conversations/3f2c/keys/request')).toBe('conversations/keys/request');
    expect(pathGroup('/api/v1/conversations/3f2c/keys')).toBe('conversations');
    expect(pathGroup('/api/health')).toBe('default');
  });
});

describe('E2EE device limits', () => {
  it('uses the method-specific pair/link rules and the generic devices rule otherwise', () => {
    expect(limitForRequest('/api/v1/devices/pair', 'POST', who).limit).toBe(5);
    expect(limitForRequest('/api/v1/devices/link', 'POST', who).limit).toBe(40);
    expect(limitForRequest('/api/v1/devices', 'GET', who).group).toBe('devices');
    expect(limitForRequest('/api/v1/devices/pair', 'GET', who).group).toBe('default');
  });
});

describe('limitForRequest', () => {
  afterEach(() => {
    delete process.env.RATE_LIMITS_JSON;
  });

  it('uses method-specific rules where they exist', () => {
    expect(limitForRequest('/api/v1/messages', 'POST', who).limit).toBe(DEFAULT_RULES['messages:POST'].limit);
    expect(limitForRequest('/api/v1/messages', 'get', who).limit).toBe(DEFAULT_RULES['messages:GET'].limit);
  });

  it('uses the method-agnostic rule otherwise, and default as last resort', () => {
    expect(limitForRequest('/api/v1/users', 'POST', who).group).toBe('users');
    expect(limitForRequest('/api/v1/messages', 'DELETE', who).group).toBe('default');
    expect(limitForRequest('/api/nothing', 'GET', who).group).toBe('default');
  });

  it('builds a per-user key, and a shared per-project key for api tokens', () => {
    expect(limitForRequest('/api/v1/users', 'GET', who).key).toBe('rl:users:p1:u1');
    expect(limitForRequest('/api/v1/users', 'GET', { projectId: 'p1' }).key).toBe('rl:users:p1:api');
  });

  it('applies RATE_LIMITS_JSON overrides at request time', () => {
    expect(limitForRequest('/api/v1/messages', 'POST', who).limit).toBe(120);
    process.env.RATE_LIMITS_JSON = JSON.stringify({ 'messages:POST': { limit: 5, windowMs: 1000 } });
    const r = limitForRequest('/api/v1/messages', 'POST', who);
    expect(r.limit).toBe(5);
    expect(r.windowMs).toBe(1000);
    delete process.env.RATE_LIMITS_JSON;
    expect(limitForRequest('/api/v1/messages', 'POST', who).limit).toBe(120);
  });

  it('ignores invalid overrides instead of throwing', () => {
    process.env.RATE_LIMITS_JSON = '{not json';
    expect(limitForRequest('/api/v1/messages', 'POST', who).limit).toBe(120);
    process.env.RATE_LIMITS_JSON = JSON.stringify({ 'messages:POST': { limit: -1, windowMs: 'x' } });
    expect(limitForRequest('/api/v1/messages', 'POST', who).limit).toBe(120);
  });
});
