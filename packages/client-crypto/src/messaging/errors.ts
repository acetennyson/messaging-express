/** No key for this conversation/version is on this device yet. A request for it was sent to the other members (at most once a minute per conversation and version); retry after a `keys.updated` event or a short wait. */
export class KeyUnavailableError extends Error {
  readonly conversationId: string;
  readonly keyVersion: number | null;
  /** True when this call sent a keys/request (false when one was sent less than a minute ago, or the request itself failed). */
  readonly requested: boolean;
  constructor(conversationId: string, keyVersion: number | null, requested: boolean, cause?: unknown) {
    super(`No key for conversation ${conversationId}${keyVersion === null ? '' : ` version ${keyVersion}`} on this device yet`);
    this.name = 'KeyUnavailableError';
    this.conversationId = conversationId;
    this.keyVersion = keyVersion;
    this.requested = requested;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
/** The server did not keep the client-chosen conversation id, so the sealed keys do not match the new conversation. Needs the server's stage 7.10. */
export class ConversationIdNotSupportedError extends Error {
  constructor() {
    super('The server ignored the client-chosen conversation id, so the sealed keys do not match it. This server needs stage 7.10 (optional "id" on POST /conversations).');
    this.name = 'ConversationIdNotSupportedError';
  }
}
