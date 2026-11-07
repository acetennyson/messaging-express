# Rate limiting

Protects the server (and your database) from a client that sends too many requests. Counters live in Postgres, so every server instance shares them. There is nothing else to run.

It is **off by default** and is controlled by `RATE_LIMIT_MODE`.

| Mode | Behaviour |
|---|---|
| `off` (default) | No counting, no headers, no extra queries. |
| `dry-run` | Counts and logs what it **would** block, but never blocks. |
| `enforce` | Over the limit returns `429` with `Retry-After`. |

## What is counted

Per **project and user** (API/admin tokens share one counter per project), per **fixed one-minute window**, per **route group**. Default limits:

| Group | Limit per minute |
|---|---|
| `POST /messages` | 120 |
| `GET /messages` | 600 |
| `POST /uploads` | 30 |
| `POST /uploads/presign` | 60 |
| `/conversations...` | 120 |
| `/users...` | 120 |
| `/devices...` (E2EE) | 60 (pairing: 5, link polling: 40, backup: 10) |
| `POST /conversations/:id/keys/request` | 30 |
| everything else | 300 |

Lookup order for a request: `"<group>:<METHOD>"`, then `"<group>"`, then `default`.

## Responses

When the mode is not `off`, every authenticated response carries:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 117
X-RateLimit-Reset: 1793882460     # Unix seconds when the window resets
```

An over-limit request in `enforce` returns:

```
HTTP/1.1 429
Retry-After: 23
{"error":{"message":"Too many requests","code":"RATE_LIMIT_EXCEEDED"}}
```

Wait `Retry-After` seconds, then retry. The TypeScript SDK does this for you.

## Customizing the limits

`RATE_LIMITS_JSON` overrides any rule by name. Unlisted rules keep their defaults. It is re-read whenever it changes.

```bash
RATE_LIMITS_JSON='{"messages:POST":{"limit":60,"windowMs":60000},"default":{"limit":1000,"windowMs":60000}}'
```

Invalid entries are ignored with a warning in the log.

## Rolling it out

1. Set `RATE_LIMIT_MODE=dry-run` and watch the logs for would-be blocks during normal traffic.
2. Raise any limit that real users hit, with `RATE_LIMITS_JSON`.
3. Switch to `enforce`.

## Failure behaviour

The limiter **fails open**: if the database counter cannot be read, the request is allowed. It is a safety net, not a security boundary, so it never turns a database hiccup into an outage.

## Not covered

- Socket.IO message volume (only the join/leave calls are limited, to 20 per 10 seconds per socket). Messages sent over REST are limited normally.
- Per-project or per-plan limits: there is one set of defaults for the whole server. The database has a `rate_limit_override` column that no code reads yet.
- IP-based limits. Put a reverse proxy (nginx, Cloudflare) in front for that.
