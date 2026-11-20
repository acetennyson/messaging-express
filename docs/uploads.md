# Uploads

Messages carry attachments as **URLs**. To get a URL for a file, upload it first, then put the URL in the message's `attachments`. Two ways to upload:

1. **Through the server**: `POST /uploads` (simple, works everywhere).
2. **Direct to storage**: `POST /uploads/presign` returns a one-time URL so the browser sends the file straight to S3, Supabase or Firebase (saves your server bandwidth).

## Storage providers

Set `STORAGE_PROVIDER`:

| Value | Where files go | Needed settings | Presign |
|---|---|---|---|
| `local` (default) | The server's `.uploads` folder (next to where you start the server), served back at `/uploads/<file>` | `APP_URL` (public base URL, default `http://localhost:3000`) | no |
| `s3` | S3 or any S3-compatible store (MinIO, R2, ...) | `S3_BUCKET`, `S3_REGION`; optional `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`; AWS credentials from the environment | yes |
| `supabase` | Supabase Storage | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | yes |
| `firebase` | Firebase Storage | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_STORAGE_BUCKET` | yes |
| `php` | A PHP endpoint you host (multipart POST, answers `{success, url}`) | `PHP_UPLOAD_ENDPOINT` | no |

The `local` provider is fine for development and a single server. In containers, mount a volume on `.uploads` or use S3, otherwise files disappear when the container is replaced.

## Limits

| Setting | Default |
|---|---|
| `MAX_UPLOAD_SIZE_BYTES` | 25 MB (26214400) per file |
| `MAX_CONCURRENT_UPLOADS` | 4 files processed at once per request |
| `UPLOAD_ALLOWED_MIME_TYPES` | `image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,application/pdf` |
| Rate limit | 30 uploads per minute per user, 60 presigns (see [Rate limiting](rate-limiting.md)) |

## Upload through the server

```bash
curl -X POST $BASE/uploads -H "Authorization: Bearer $TOKEN" -F "file=@menu.pdf" -F "file=@photo.png"
```

Response (HTTP 200, even if some files failed: check each item):

```json
{ "data": [
  { "filename": "menu.pdf", "type": "file", "mimeType": "application/pdf", "sizeBytes": 20480,
    "url": "https://chat.example.com/uploads/<uuid>-menu.pdf" },
  { "filename": "archive.zip", "mimeType": "application/zip", "error": "File type not allowed: application/zip" }
] }
```

Then attach it:

```bash
curl -X POST $BASE/messages -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "conversationId":"<ID>","senderId":"<MY_ID>","type":"file","content":"Our menu",
  "attachments":[{"type":"file","url":"https://chat.example.com/uploads/<uuid>-menu.pdf",
                  "filename":"menu.pdf","mimeType":"application/pdf","sizeBytes":20480}] }'
```

## Direct upload (presign)

```js
// 1. ask the server for a signed URL
const r = await fetch(`${BASE}/uploads/presign`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
}).then((x) => x.json());

// 2. send the bytes straight to storage with the method and headers it gave you
await fetch(r.data.uploadUrl, { method: r.data.method, headers: r.data.headers, body: file });

// 3. use r.data.publicUrl in the message attachment
```

The response `data` has `uploadUrl`, `publicUrl`, `method` (`PUT` or `POST`), `headers` (they are part of the signature: send them unchanged) and, for some providers, `fields`. With `local` or `php`, the call returns `501 PRESIGN_NOT_SUPPORTED`: use `POST /uploads` instead.

## Encrypted attachments

In an encrypted conversation the client encrypts the file before uploading, so the server only ever sees an opaque blob. With `E2EE_ENABLED=on`, upload it with `category=e2ee` and it is accepted as `application/octet-stream`. This does not widen the allowed types for any other category. See the [E2EE guide](e2ee/guide.md#attachments).

## Production checklist

- Use S3 (or similar) for anything with more than one server instance.
- Put a CDN in front of the public URL.
- Remember that `local` uploads are public to anyone who has the URL.
- Keep the allowed types list as small as your product needs.

## Embedded module: the `upload` option

The embedded server does **not** read `STORAGE_PROVIDER` or any other environment variable. Storage comes only from `init`. Without
the option, `POST /api/v1/uploads` and `/uploads/presign` answer `501 STORAGE_NOT_CONFIGURED` and nothing is stored.

### Local disk

```ts
upload: {
  type: 'local',
  route: '/uploads',                      // optional, default '/uploads'
  options: {
    dir: '/var/data/chat-uploads',        // where files are written
    baseUrl: 'https://api.acme.com/chat', // how your clients reach the module's root
  },
}
```

Files are served by the module at `<root><route>/<file>`, so with the above, `https://api.acme.com/chat/uploads/<uuid>-photo.png`.
`baseUrl` must be absolute because message attachments are required to carry absolute URLs; it has to include whatever prefix
you mounted the module under (`chat.middleware(app, '/chat')`). A custom `route` replaces `/uploads` (the old path then answers 404).
Local disk is **not shared** between instances and does not survive an ephemeral filesystem (most serverless hosts, many
containers): use S3 there.

### S3 and S3-compatible services

```ts
upload: {
  type: 's3',
  options: {
    bucket: 'chat-files',
    region: 'us-east-1',                 // 'auto' for Cloudflare R2
    endpoint: 'https://<account>.r2.cloudflarestorage.com', // omit for AWS S3
    publicBaseUrl: 'https://files.acme.com',                // optional: CDN or public bucket URL
    accessKeyId: '…', secretAccessKey: '…',                 // optional: both, or neither
  },
}
```

- Works with AWS S3, Cloudflare R2, Supabase Storage (its S3 endpoint), Backblaze B2, DigitalOcean Spaces and MinIO. With an
  `endpoint`, path-style addressing is used unless `forcePathStyle: false`.
- **Your clients must be able to read the file URLs**: make the bucket (or the CDN in front of it, via `publicBaseUrl`) publicly
  readable. The module hands out the object URL; it does not sign downloads.
- Without `accessKeyId`/`secretAccessKey` the AWS SDK's default credential chain applies (environment variables, IAM role).
- Needs the optional packages `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` installed in your app. A missing package or a missing
  bucket/region makes `init` fail with a `ConfigError` naming `upload`, rather than failing on the first upload.
- S3 supports `POST /api/v1/uploads/presign` (clients upload straight to the bucket); local disk does not (clients fall back to the plain upload).
- Set the bucket's CORS to allow `PUT` from your web origins if browsers upload with presigned URLs.

### Limits

`limits: { maxSizeBytes, maxConcurrent, allowedMimeTypes }` (all optional) on either type. Defaults: 25 MB, 4 at a time,
JPEG/PNG/GIF/WebP/MP4/WebM/PDF. With E2EE on, `category=e2ee` also accepts `application/octet-stream` (encrypted blobs), as on the hosted server.
