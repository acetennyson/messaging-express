import { createClient } from '@supabase/supabase-js';
import type { StorageProvider } from '../types';
import { buildObjectKey, probeImage, requireEnv } from '../utils';

export function createSupabaseProvider(): StorageProvider {
  const env = requireEnv('supabase', [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_STORAGE_BUCKET',
  ]);
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  // Service-role key: server-only, bypasses RLS. Never send it to a client.
  const supabase = createClient(baseUrl, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const store = () => supabase.storage.from(bucket);

  // The bucket must be public for these URLs to be readable by message recipients.
  const publicUrlFor = (key: string) => store().getPublicUrl(key).data.publicUrl;

  return {
    name: 'supabase',

    async upload({ projectId, file, filename, mimeType, category }) {
      const { width, height } = await probeImage(file, mimeType);
      const key = buildObjectKey({ projectId, filename, category });

      const { error } = await store().upload(key, file, {
        contentType: mimeType,
        upsert: false,
        cacheControl: '31536000',
      });
      if (error) throw new Error(`Supabase upload failed: ${error.message}`);

      return {
        url: publicUrlFor(key),
        sizeBytes: file.length,
        ...(width && height ? { width, height } : {}),
      };
    },

    async delete(url) {
      const prefix = `${baseUrl}/storage/v1/object/public/${bucket}/`;
      if (!url.startsWith(prefix)) {
        throw new Error('URL does not belong to the configured Supabase bucket');
      }
      const key = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
      if (!key || key.includes('..')) throw new Error('Invalid object key');
      const { error } = await store().remove([key]);
      if (error) throw new Error(`Supabase delete failed: ${error.message}`);
    },

    async getPresignedUploadUrl({ projectId, filename, mimeType, category }) {
      const key = buildObjectKey({ projectId, filename, category });
      const { data, error } = await store().createSignedUploadUrl(key);
      if (error || !data) {
        throw new Error(`Supabase presign failed: ${error?.message ?? 'no data'}`);
      }
      // Supabase signed upload URLs can't be bound to a size; set file_size_limit and
      // allowed_mime_types on the bucket itself as the enforcement point.
      return {
        uploadUrl: data.signedUrl,
        publicUrl: publicUrlFor(key),
        method: 'PUT' as const,
        headers: { 'Content-Type': mimeType },
      };
    },
  };
}
