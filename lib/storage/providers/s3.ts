import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider } from '../types';
import { buildObjectKey, probeImage, PRESIGN_TTL_SECONDS } from '../utils';

const CACHE_CONTROL = 'public, max-age=31536000, immutable'; // keys are unique per upload

function readConfig() {
  const bucket = (process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || '').trim();
  const region = (process.env.S3_REGION || process.env.AWS_REGION || '').trim();
  const missing: string[] = [];
  if (!bucket) missing.push('S3_BUCKET');
  if (!region) missing.push('S3_REGION');
  if (missing.length) {
    throw new Error(`STORAGE_PROVIDER=s3 requires env var(s): ${missing.join(', ')}`);
  }

  // Optional, for S3-compatible services (R2, Spaces, MinIO) and CDN-fronted buckets.
  const endpoint = process.env.S3_ENDPOINT?.trim().replace(/\/+$/, '') || undefined;
  const forcePathStyle =
    process.env.S3_FORCE_PATH_STYLE === 'true' || (!!endpoint && process.env.S3_FORCE_PATH_STYLE !== 'false');
  const publicBase = (
    process.env.S3_PUBLIC_BASE_URL?.trim() ||
    (endpoint
      ? forcePathStyle
        ? `${endpoint}/${bucket}`
        : endpoint.replace('://', `://${bucket}.`)
      : `https://${bucket}.s3.${region}.amazonaws.com`)
  ).replace(/\/+$/, '');

  return { bucket, region, endpoint, forcePathStyle, publicBase };
}

export function createS3Provider(): StorageProvider {
  const cfg = readConfig();
  // Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from env, or whatever the
  // SDK default chain finds (IAM role, shared config) when they are unset.
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle } : {}),
  });

  const publicUrlFor = (key: string) =>
    `${cfg.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;

  return {
    name: 's3',

    async upload({ projectId, file, filename, mimeType, category }) {
      const { width, height } = await probeImage(file, mimeType);
      const key = buildObjectKey({ projectId, filename, category });

      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: file,
          ContentType: mimeType,
          ContentLength: file.length,
          CacheControl: CACHE_CONTROL,
        })
      );

      return {
        url: publicUrlFor(key),
        sizeBytes: file.length,
        ...(width && height ? { width, height } : {}),
      };
    },

    async delete(url) {
      const prefix = `${cfg.publicBase}/`;
      if (!url.startsWith(prefix)) {
        throw new Error('URL does not belong to the configured S3 bucket');
      }
      const key = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
      if (!key || key.includes('..')) throw new Error('Invalid object key');
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    async getPresignedUploadUrl({ projectId, filename, mimeType, sizeBytes, category }) {
      const key = buildObjectKey({ projectId, filename, category });
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ContentType: mimeType,
          CacheControl: CACHE_CONTROL,
          // Binds the URL to this exact size so it can't be reused for a bigger file.
          ...(sizeBytes ? { ContentLength: sizeBytes } : {}),
        }),
        {
          expiresIn: PRESIGN_TTL_SECONDS,
          signableHeaders: new Set(
            ['content-type', 'cache-control', ...(sizeBytes ? ['content-length'] : [])]
          ),
        }
      );
      return {
        uploadUrl,
        publicUrl: publicUrlFor(key),
        method: 'PUT' as const,
        // Browsers set Content-Length themselves; these two must match the signature.
        headers: { 'Content-Type': mimeType, 'Cache-Control': CACHE_CONTROL },
      };
    },
  };
}
