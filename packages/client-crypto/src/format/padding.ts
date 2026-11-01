import { FormatError } from './errors';
import { PAD_BLOCK } from './context';

/** ISO/IEC 7816-4 style: append 0x80, then zeros up to a multiple of 64 bytes. Always adds at least one byte, so it is unambiguous. */
export function pad(data: Uint8Array): Uint8Array {
  const total = Math.ceil((data.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  out.set(data, 0);
  out[data.length] = 0x80;
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length === 0 || padded.length % PAD_BLOCK !== 0) throw new FormatError('BAD_PADDING', 'padded length is not a multiple of 64');
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0) i--;
  if (i < 0 || padded[i] !== 0x80) throw new FormatError('BAD_PADDING', 'missing padding marker');
  if (padded.length - i > PAD_BLOCK) throw new FormatError('BAD_PADDING', 'padding longer than one block');
  return padded.subarray(0, i);
}
