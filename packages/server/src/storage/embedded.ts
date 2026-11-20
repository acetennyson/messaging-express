import path from 'path';
import type { StorageProvider } from './types';
import type { StorageService } from './index';
import { StorageNotConfiguredError } from './not-configured';

export type ResolvedUpload =
  | { type: 'local'; route: string; dir: string; baseUrl: string }
  | {
      type: 's3';
      bucket: string;
      region: string;
      endpoint?: string;
      forcePathStyle?: boolean;
      publicBaseUrl?: string;
      credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    };

/**
 * Storage for an embedded server: built once from the `upload` option, never from the environment.
 * No option → every upload route answers 501 STORAGE_NOT_CONFIGURED. The provider is created lazily by getProvider(),
 * and init calls it once so a missing bucket or a missing AWS package fails at startup rather than on the first upload.
 */
export function createEmbeddedStorage(upload: ResolvedUpload | undefined, read: (name: string) => string | undefined): StorageService {
  if (!upload) {
    return {
      localDir: null,
      async getProvider(): Promise<StorageProvider> {
        throw new StorageNotConfiguredError();
      },
    };
  }
  let provider: Promise<StorageProvider> | undefined;
  return {
    localDir: upload.type === 'local' ? path.resolve(upload.dir) : null,
    getProvider() {
      provider ??=
        upload.type === 'local'
          ? import('./providers/local').then((m) =>
              m.createLocalProvider(read, { dir: path.resolve(upload.dir), publicPrefix: `${upload.baseUrl}${upload.route}` })
            )
          : import('./providers/s3').then((m) => m.createS3Provider(read, upload.credentials));
      provider.catch(() => {
        provider = undefined; // a failed start may be retried
      });
      return provider;
    },
  };
}
