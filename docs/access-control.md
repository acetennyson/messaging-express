# Access control

Who may read and write which conversation. This page explains the three modes of `PARTICIPANT_ACCESS_MODE`, what each one refuses, and how to roll it out on a live system without breaking anyone.

## The rule

Only **user tokens** are restricted. API and admin tokens are your backend and may act for anyone in the project (see [Authentication](authentication.md)). A user token (a token with `type: "user"` and a `userId`) may:

- send messages only **as itself**, only into conversations it is a **participant** of;
- read messages only from conversations it is a participant of;
- list conversations only **its own**;
- add members to a conversation it belongs to.

Everything else answers `403 FORBIDDEN`. "Not a participant" and "conversation does not exist" return the same answer on purpose, so nobody can probe for valid conversation ids.

## The modes

Set with `PARTICIPANT_ACCESS_MODE`. It is read on every request, so changing it needs no rebuild (restart or env reload depending on how you deploy).

| Mode | Behaviour |
|---|---|
| `off` (default) | No checks. Same behaviour as before the setting existed. |
| `dry-run` | Nothing is refused. Every request that **would** be refused in `enforce` is logged as `participant_access_would_deny` with the rule that failed. |
| `enforce` | Violations return `403`. |

**Encrypted conversations are always enforced**, whatever the mode, because they only exist when `E2EE_ENABLED=on`. See the [E2EE guide](e2ee/guide.md).

### The three rules

| Rule (in logs) | Trigger | Error message |
|---|---|---|
| `not_participant` | Sending to, reading, or adding members to a conversation the user is not in | `You are not a participant of this conversation` |
| `sender_mismatch` | `senderId` in `POST /messages` is not the token's user | `A user token can only send as that user` |
| `foreign_listing` | `GET /conversations?userId=<someone else>` | `A user token can only list its own conversations` |

With `enforce`, `GET /conversations` with **no** `userId` filter is not an error: the list is narrowed to the caller's own conversations.

## Examples

Alice and Bob are in conversation `CONV`. Carol is not. All three have user tokens.

```bash
# Carol tries to read CONV → refused
curl "$BASE/messages?conversationId=$CONV" -H "Authorization: Bearer $CAROL_TOKEN"
# 403 {"error":{"message":"You are not a participant of this conversation","code":"FORBIDDEN"}}

# Alice tries to send as Bob → refused
curl -X POST $BASE/messages -H "Authorization: Bearer $ALICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"conversationId":"'$CONV'","senderId":"'$BOB_ID'","content":"hi"}'
# 403 {"error":{"message":"A user token can only send as that user","code":"FORBIDDEN"}}

# Alice lists "her" conversations: fine, and narrowed to hers even without a filter
curl "$BASE/conversations" -H "Authorization: Bearer $ALICE_TOKEN"

# Your backend (api token) can do all of the above for anyone
curl "$BASE/messages?conversationId=$CONV" -H "Authorization: Bearer $API_TOKEN"
```

## Rolling it out safely

If your app already runs with user tokens in the browser, turning on `enforce` could break any client that relies on today's open behaviour. Do it in steps:

1. **Deploy** with `PARTICIPANT_ACCESS_MODE=dry-run`. Nothing changes for users.
2. **Watch the logs** for a few days of normal traffic: search for `participant_access_would_deny`. Each line has `rule`, `projectId` and `userId`.
3. **Fix what shows up.** Typical causes: a client that sends as a different user id than its token, or a page that lists conversations for another user. Move those calls to your backend (API token).
4. **Switch to `enforce`.** The log lines stop; real violations now get `403`.
5. **Rollback** is one setting: change back to `dry-run` or `off`.

A zero-warning dry run is the signal that `enforce` is safe.

## Notes

- Removing a user from a conversation (`DELETE /conversations/:id/participants/:userId`) also takes their live sockets out of the realtime room immediately. See [Realtime](realtime.md).
- Realtime `join-conversation` always checks membership, regardless of the mode.
- A user token can only join as a participant that exists in the project; users are created by your backend (see [API reference](api-reference.md#users)).
