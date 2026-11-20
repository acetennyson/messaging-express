/** Thrown by an embedded server that was started without an `upload` option. Upload routes answer 501 for it. */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Uploads are not configured. Pass upload: { type: 'local' | 's3', options } to MessagingServer.init().");
    this.name = 'StorageNotConfiguredError';
  }
}
