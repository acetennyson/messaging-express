import { describe, expect, it } from 'vitest';
import { makeWorld, userWithDevice } from './world';

// The mock is what Lane B tests trust, so it gets its own checks on the rules that are easy to get subtly wrong.
describe('mock server', () => {
  it('unknown routes and unknown paths are 404; auth is checked before anything', async () => {
    const w = makeWorld();
    expect((await w.mock.fetch('http://mock/api/v1/nothing', { headers: { authorization: 'Bearer admin' } })).status).toBe(404);
    expect((await w.mock.fetch('http://mock/api/v1/devices')).status).toBe(401);
    expect((await w.mock.fetch('http://mock/elsewhere', { headers: { authorization: 'Bearer admin' } })).status).toBe(404);
  });
  it('registration is serialised: two concurrent first registrations yield exactly one primary', async () => {
    const w = makeWorld();
    const u = w.user();
    const kp = (await import('./world')).newKeyPair;
    const r = await Promise.allSettled([u.client.crypto.devices.register({ publicKey: kp().publicKeyB64 }), u.client.crypto.devices.register({ publicKey: kp().publicKeyB64 })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(w.mock.state.devices().filter((d) => d.isPrimary)).toHaveLength(1);
  });
  it('concurrent link of one approval: exactly one wins', async () => {
    const w = makeWorld();
    const a = await userWithDevice(w);
    const k = (await import('./world')).newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k.publicKeyB64);
    const r = await Promise.allSettled([a.client.crypto.devices.link({ publicKey: k.publicKeyB64 }), a.client.crypto.devices.link({ publicKey: k.publicKeyB64 })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(w.mock.state.devices().filter((d) => !d.revokedAt)).toHaveLength(2);
  });
  it('injections fire the requested number of times, then stop', async () => {
    const w = makeWorld();
    const u = w.user();
    w.mock.inject({ match: /GET \/devices/, status: 503, code: 'UNAVAILABLE', times: 2 });
    for (let i = 0; i < 2; i++) await expect(u.client.crypto.devices.list([u.id])).rejects.toMatchObject({ status: 503 });
    await expect(u.client.crypto.devices.list([u.id])).resolves.toEqual([]);
  });
});
