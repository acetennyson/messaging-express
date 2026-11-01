export const hex = (s: string): Uint8Array => new Uint8Array((s.replace(/\s+/g, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));
export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
export const seq = (n: number, start = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
