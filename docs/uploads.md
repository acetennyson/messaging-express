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
