import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import type { CryptoKeyStore } from '../keystore/types';
import { keyNames } from '../keystore/scope';
import type { RequestClient } from '../api/transport';
import { listDevices } from '../api/devices';
import { ParticipantHasNoDeviceError } from '../api/errors';
import { compareSafetyNumbers, safetyNumberOf } from './fingerprint';

export type SafetyStatus = 'unverified' | 'verified' | 'changed';
export interface SafetyView {
  /** 12 groups of 5 digits: what both people read out and compare. */
  text: string; groups: string[]; qrPayload: string;
  mine: { userId: string; deviceIds: string[] }; theirs: { userId: string; deviceIds: string[] };
  status: SafetyStatus;
}
const enc = new TextEncoder(), dec = new TextDecoder();

/** Safety numbers: a way to notice that the server showed you a device that the other person does not have. */
export function createSafetyManager(o: { client: RequestClient; keyStore: CryptoKeyStore; userId: string; provider?: CryptoProvider }) {
  const { client, keyStore, userId } = o;
  const provider = o.provider ?? nobleProvider;

  async function compute(other: string) {
    const devices = await listDevices(client, [userId, other]);
    const mine = devices.filter((d) => d.userId === userId), theirs = devices.filter((d) => d.userId === other);
    const none = [userId, other].filter((u) => !devices.some((d) => d.userId === u));
    if (none.length) throw new ParticipantHasNoDeviceError('A safety number needs every user to have an active device', { status: 409, code: 'PARTICIPANT_HAS_NO_DEVICE', details: { userIds: none } });
    const n = safetyNumberOf({ userId, publicKeys: mine.map((d) => d.publicKey) }, { userId: other, publicKeys: theirs.map((d) => d.publicKey) }, provider);
    return { n, mine: mine.map((d) => d.id), theirs: theirs.map((d) => d.id) };
  }
  async function stored(other: string): Promise<string | null> {
    const raw = await keyStore.get(keyNames.verified(other));
    return raw ? dec.decode(raw) : null;
  }
  const statusFor = (saved: string | null, digits: string): SafetyStatus => (saved === null ? 'unverified' : compareSafetyNumbers(saved, digits) ? 'verified' : 'changed');

  return {
    /** The number to compare with `otherUserId`, built from the device lists the server gives THIS client, plus whether you confirmed it before. */
    async forUser(other: string): Promise<SafetyView> {
      const { n, mine, theirs } = await compute(other);
      return { text: n.text, groups: n.groups, qrPayload: n.qrPayload, mine: { userId, deviceIds: mine }, theirs: { userId: other, deviceIds: theirs }, status: statusFor(await stored(other), n.digits) };
    },
    /**
     * Record that you compared the number with the other person. Pass what THEY read out to you: it is stored only if it equals the number
     * computed here (returns false otherwise, and nothing is stored). Without an argument it stores the current number: use that only
     * when the user has already confirmed it by some other means in your UI.
     */
    async verify(other: string, theirReading?: string): Promise<boolean> {
      const { n } = await compute(other);
      if (theirReading !== undefined && !compareSafetyNumbers(theirReading, n.digits)) return false;
      await keyStore.set(keyNames.verified(other), enc.encode(n.digits));
      return true;
    },
    /** 'unverified' (never confirmed), 'verified', or 'changed' (confirmed once, and the set of devices has changed since: confirm again). */
    async status(other: string): Promise<SafetyStatus> {
      const { n } = await compute(other);
      return statusFor(await stored(other), n.digits);
    },
    async unverify(other: string): Promise<void> { await keyStore.delete(keyNames.verified(other)); },
  };
}
export type SafetyManager = ReturnType<typeof createSafetyManager>;
