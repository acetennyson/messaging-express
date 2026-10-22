import type { StorageProvider } from './types';

export type { StorageProvider } from './types';

const cache = new Map<string, StorageProvider>();

/**
 * Providers are loaded with dynamic import so an SDK (aws, firebase, supabase)
 * is only ever evaluated when its provider is selected, and its env vars are
 * only validated then. STORAGE_PROVIDER unset/local never touches any of them.
 */
export async function getStorageProvider(): Promise<StorageProvider> {
  const name = (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();

  const cached = cache.get(name);
  if (cached) return cached;

  let provider: StorageProvider;
  switch (name) {
    case 'local':
      provider = (await import('./providers/local')).localProvider;
      break;
    case 's3':
      provider = (await import('./providers/s3')).createS3Provider();
      break;
    case 'supabase':
      provider = (await import('./providers/supabase')).createSupabaseProvider();
      break;
    case 'firebase':
      provider = (await import('./providers/firebase')).createFirebaseProvider();
      break;
    case 'php':
      provider = (await import('./providers/php')).createPhpProvider();
      break;
    default:
      // Fail loud: silently falling back to local would hide a misconfigured prod.
      throw new Error(
        `Unknown STORAGE_PROVIDER "${name}". Supported: local, s3, supabase, firebase, php`
      );
  }

  cache.set(name, provider);
  return provider;
}
