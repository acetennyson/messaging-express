# Changelog

## Unreleased

### Changed (API behaviour): error status codes (Track H2, H3)
Clients that branch on HTTP status should review this.

| Situation | Before | Now |
|---|---|---|
| A handler throws unexpectedly (bug, database error) | `401 UNAUTHORIZED` with the internal error text | `500 INTERNAL_ERROR`, message `Internal server error` |
| Database fails while authenticating a request | `401 UNAUTHORIZED` | `500 INTERNAL_ERROR` |
| `POST /api/v1/messages`, conversation not found in your project | `400 VALIDATION_ERROR` | `404 NOT_FOUND` |
| `POST /api/v1/messages`, unexpected failure (database, bug) | `400 VALIDATION_ERROR` with the internal error text | `500 INTERNAL_ERROR`, generic message |

Unchanged: missing/invalid token, inactive project or organization (still `401`, same body); schema validation,
malformed JSON and "sender is not a participant" (still `400 VALIDATION_ERROR`); rate limiting (`429`).

Also: internal error messages (for example connection strings in database errors) are no longer sent to clients.

Not yet changed: the other `app/api/v1/*` routes and `GET /api/v1/messages` still report every error as `400`.

### Fixed
- The server no longer exits when an idle database connection errors (Track H1).
