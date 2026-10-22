import type { StorageProvider } from './types';
import { localProvider } from './providers/local';

export type { StorageProvider } from './types';

export function getStorageProvider(): StorageProvider {
  // Read per call, not at module load, so a changed env takes effect on restart only
  // where Next inlines it, and tests can switch providers.
  const name = (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();

  switch (name) {
    case 'local':
      return localProvider;
    default:
      // Fail loud: silently falling back to local would hide a misconfigured prod.
      throw new Error(
        `Unknown STORAGE_PROVIDER "${name}". Supported in this build: local`
      );
  }
}
