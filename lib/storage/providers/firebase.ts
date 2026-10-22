import { randomUUID } from 'crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import type { StorageProvider } from '../types';
import { buildObjectKey, probeImage, requireEnv, PRESIGN_TTL_SECONDS } from '../utils';

const APP_NAME = 'messaging-express-storage'; // avoid clashing with a default app
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const TOKEN_HEADER = 'x-goog-meta-firebasestoragedownloadtokens';

export function createFirebaseProvider(): StorageProvider {
  const env = requireEnv('firebase', [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_STORAGE_BUCKET',
  ]);
  const bucketName = env.FIREBASE_STORAGE_BUCKET;

  const app =
    getApps().find((a) => a.name === APP_NAME) ??
    initializeApp(
      {
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          // .env files and most hosts store the key with literal "\n" sequences
          privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        storageBucket: bucketName,
      },
      APP_NAME
    );

  const bucket = getStorage(app).bucket(bucketName);

  // Permanent, rules-independent download URL: the same shape the Firebase client
  // SDK's getDownloadURL() returns. Signed read URLs max out at 7 days, which is no
  // good for attachment URLs we persist in the DB.
  const downloadUrlFor = (key: string, token: string) =>
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(key)}?alt=media&token=${token}`;

  return {
    name: 'firebase',

    async upload({ projectId, file, filename, mimeType, category }) {
      const { width, height } = await probeImage(file, mimeType);
      const key = buildObjectKey({ projectId, filename, category });
      const token = randomUUID();

      await bucket.file(key).save(file, {
        contentType: mimeType,
        resumable: false,
        metadata: {
          cacheControl: CACHE_CONTROL,
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });

      return {
        url: downloadUrlFor(key, token),
        sizeBytes: file.length,
        ...(width && height ? { width, height } : {}),
      };
    },

    async delete(url) {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (
        parsed.hostname !== 'firebasestorage.googleapis.com' ||
        !match ||
        match[1] !== bucketName
      ) {
        throw new Error('URL does not belong to the configured Firebase bucket');
      }
      const key = decodeURIComponent(match[2]);
      if (!key || key.includes('..')) throw new Error('Invalid object key');
      await bucket.file(key).delete({ ignoreNotFound: true });
    },

    async getPresignedUploadUrl({ projectId, filename, mimeType, category }) {
      const key = buildObjectKey({ projectId, filename, category });
      const token = randomUUID();
      const [uploadUrl] = await bucket.file(key).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + PRESIGN_TTL_SECONDS * 1000,
        contentType: mimeType,
        // Attaches the download token as object metadata at upload time, so the
        // publicUrl we return now is already valid once the client's PUT lands.
        extensionHeaders: { [TOKEN_HEADER]: token },
      });
      return {
        uploadUrl,
        publicUrl: downloadUrlFor(key, token),
        method: 'PUT' as const,
        headers: { 'Content-Type': mimeType, [TOKEN_HEADER]: token },
      };
    },
  };
}
