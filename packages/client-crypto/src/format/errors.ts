export type FormatErrorCode = 'UNKNOWN_VERSION' | 'BAD_LENGTH' | 'BAD_ENCODING' | 'BAD_PADDING' | 'BAD_PAYLOAD' | 'BAD_INPUT';

/** A blob or input is structurally wrong (wrong version, length, encoding, padding or shape). Nothing was decrypted. */
export class FormatError extends Error {
  readonly code: FormatErrorCode;
  constructor(code: FormatErrorCode, message: string) {
    super(message);
    this.name = 'FormatError';
    this.code = code;
  }
}

/**
 * Authentication failed: wrong key, wrong AAD (conversation / key version / sender / device pair) or a modified blob.
 * Deliberately gives no detail about which, so it cannot be used as an oracle.
 */
export class DecryptError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'DecryptError';
  }
}
