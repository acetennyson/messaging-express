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

#### Same fix applied to the other routes
| Route | Situation | Before | Now |
|---|---|---|---|
| `GET /users`, `GET /conversations`, `GET /messages`, `POST /users`, `POST /conversations` | Database failure or bug | `400` with the internal error text | `500 INTERNAL_ERROR`, generic message |
| `GET /users` | `limit` or `offset` not a number | `400` with a database error message | `400 VALIDATION_ERROR` (validated like the other list routes) |
| `GET /users` | `limit` above 200 or below 1 | accepted | `400 VALIDATION_ERROR` (same bounds as the other list routes) |
| `POST /conversations` | `participantIds` contains a duplicate | `400` with a database error message | `400`, message `participantIds must be unique` |
| `POST /conversations` | A participant id that does not exist | `400` with a database error message | `400`, message `One or more participantIds are not users of this project` |
| Any route | A unique constraint is violated (for example a duplicate email) | `400` with the constraint text | `409 CONFLICT`, message `Resource already exists` |

### Security fix
- `POST /api/v1/conversations` accepted a `participantId` that belongs to a **different project** (the foreign key only
  checks that the user exists). It now returns `400`. Conversations created before this fix may already contain such
  participants; see `docs/ENGINEERING_LOG.md` entry 5.19 for a query to find them.

### Added
- `PROJECT_CACHE_TTL_SECONDS` (Track H4): optional in-memory cache of the project lookup that runs on every authenticated
  request. Off by default, so nothing changes unless you set it. When on, deactivating a project or organization takes
  effect after at most that many seconds per instance.

### Fixed
- The server no longer exits when an idle database connection errors (Track H1).
