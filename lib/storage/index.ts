import type { StorageProvider } from './types';
import type { ConfigReader } from '../core/config';

export type { StorageProvider } from './types';

/** What the core needs from storage. The hosted server's implementation is env-driven (below); an embedder supplies its own. */
export interface StorageService {
  getProvider(): Promise<StorageProvider>;
}

/**
 * Env-driven storage for the hosted server. `read` is the same reader the config uses, so STORAGE_PROVIDER and the
 * provider settings are re-read on every call, exactly as before. The provider cache is per instance.
 *
 * Providers are loaded with dynamic import so an SDK (aws, firebase, supabase) is only ever evaluated when its
 * provider is selected, and its settings are only validated then. STORAGE_PROVIDER unset/local never touches any of them.
 */
export function createEnvStorage(read: ConfigReader): StorageService {
  const cache = new Map<string, StorageProvider>();

  return {
    async getProvider(): Promise<StorageProvider> {
      const name = (read('STORAGE_PROVIDER') || 'local').trim().toLowerCase();

      const cached = cache.get(name);
      if (cached) return cached;

      let provider: StorageProvider;
      switch (name) {
        case 'local':
          provider = (await import('./providers/local')).createLocalProvider(read);
          break;
        case 's3':
          provider = (await import('./providers/s3')).createS3Provider(read);
          break;
        case 'supabase':
          provider = (await import('./providers/supabase')).createSupabaseProvider(read);
          break;
        case 'firebase':
          provider = (await import('./providers/firebase')).createFirebaseProvider(read);
          break;
        case 'php':
          provider = (await import('./providers/php')).createPhpProvider(read);
          break;
        default:
          // Fail loud: silently falling back to local would hide a misconfigured prod.
          throw new Error(`Unknown STORAGE_PROVIDER "${name}". Supported: local, s3, supabase, firebase, php`);
      }

      cache.set(name, provider);
      return provider;
    },
  };
}
