import { MAX_KEY_LENGTH } from './types';

export function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) throw new TypeError(`key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
  return key;
}
export function checkValue(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError('value must be a Uint8Array');
  return value;
}
export function checkPrefix(prefix: unknown): string {
  if (prefix === undefined) return '';
  if (typeof prefix !== 'string') throw new TypeError('prefix must be a string');
  return prefix;
}
/** Sort by UTF-16 code units, which is how string comparison and IndexedDB key ordering both work, so every store lists identically. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
