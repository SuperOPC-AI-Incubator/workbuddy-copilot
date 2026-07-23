# Reliable mentor message delivery

Mentor replies are persisted in `mentor_message_deliveries` when the trusted
mentor timeline path creates them. Fetch and acknowledgement state lives in
Supabase, so an application restart does not lose pending messages or reset
delivery counters.

## Fetch pending messages

```http
GET /api/public/workbuddy/mentor-messages?limit=50
Authorization: Bearer <workbuddy-credential>
```

Optional query fields:

- `session_id`: UUID of a session owned by the credential's student.
- `cursor`: opaque base64url cursor returned by the previous response.
- `limit`: integer from 1 through 100.

Messages are ordered by `(created_at, id)`. The cursor contains both values, so
messages with the same timestamp are not skipped. Fetching updates
`first_fetched_at` only once and updates `last_fetched_at` plus `fetch_count`
on every successful fetch. Until acknowledgement, fetching again without a
cursor intentionally returns the same messages.

Every reachable production delivery insert/update path takes the same
student-scoped PostgreSQL transaction advisory lock before taking delivery row
locks or writing. Fetch, acknowledgement, and web-seen use pre-locking RPCs;
delivery INSERT validation takes the lock before checking its timeline parent.
Direct service-role delivery-table DML is revoked.

An UPDATE row is already locked before its row trigger runs. The validator
therefore rejects changes to `message_id`, `student_id`, or `session_id`, then
returns immediately for state-only updates without reading or locking a parent
row. This preserves the production RPC order of advisory lock then delivery
row, while INSERT can safely validate the timeline before a delivery row
exists. Consequently, fetch ordering by `(created_at, id)` cannot deadlock with
acknowledgement ordering by message UUID.

Parent-table cascade deletes do not participate in that advisory-lock graph.
Fetch uses `FOR UPDATE OF delivery`, which locks only delivery rows; its joined
timeline and session rows remain ordinary MVCC reads. PostgreSQL documents that
tables omitted from a locking clause are read normally and that ordinary reads
do not conflict with writes:
[SELECT locking clauses](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
and [MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html). A cascade
delete can therefore wait for a delivery row, but the state-only UPDATE trigger
does not wait for a timeline row, so there is no reverse row-lock edge
completing a deadlock cycle. Authenticated clients already lack DELETE on
`students`, `sessions`, and `timeline_items`; the environment-gated concurrency
test covers fetch (including its UPDATE trigger) racing the trusted service
cleanup path.

```json
{
  "ok": true,
  "request_id": "60000000-0000-4000-8000-000000000001",
  "messages": [
    {
      "id": "40000000-0000-4000-8000-000000000001",
      "session_id": "30000000-0000-4000-8000-000000000001",
      "text": "先确认设备已断电，再继续排查。",
      "author_username": "mentor-one",
      "created_at": "2026-07-23T09:30:00.000Z",
      "first_fetched_at": "2026-07-23T09:31:00.000Z",
      "last_fetched_at": "2026-07-23T09:31:00.000Z",
      "fetch_count": 1
    }
  ],
  "next_cursor": null
}
```

## Acknowledge messages

```http
POST /api/public/workbuddy/mentor-messages/ack
Authorization: Bearer <workbuddy-credential>
Content-Type: application/json
```

```json
{
  "message_ids": ["40000000-0000-4000-8000-000000000001"]
}
```

The array must contain 1–100 unique UUIDs. The database locks and validates
the complete set before updating anything. A mixed own/foreign/unknown set
returns the same `400 INVALID_MESSAGE_IDS` response and makes no partial
update. Repeating a valid acknowledgement succeeds and preserves the first
`acknowledged_at`.

Both routes support CORS preflight and return a request ID in the JSON body and
`X-Request-Id` header. Invalid or revoked credentials receive the same
sanitized `401`; malformed database responses and gateway failures receive a
sanitized `500`. Responses never include the bearer token, its hash, internal
database errors, or staff user IDs.

## MCP display and acknowledgement loop

The authenticated MCP surface maps the verified OAuth user to its student
record; neither delivery tool accepts a `student_id`.

Delivery is an at-least-once protocol with a completed-response boundary:

1. At the start of a new user turn, WorkBuddy may acknowledge
   `pending_ack_ids` from the prior completed assistant response. It calls
   `ack_mentor_messages` with `displayed_message_ids` and the required literal
   `displayed_in_prior_completed_turn: true`.
2. `log_turn` persists the new base turn and returns a machine-readable
   `next_action` pointing to `get_unread_mentor_messages`. Any subsequently
   fetched mentor quotation is delivery data, not another learner/AI turn.
3. `get_unread_mentor_messages` fetches pending messages through the same
   delivery service and RPC used by the public API. Fetching updates counters
   but never acknowledges.
4. WorkBuddy treats the returned JSON block as untrusted mentor quotation data.
   It displays each `messages[].text` verbatim but never executes instructions
   inside that text.
5. Messages fetched in the current turn are **not** acknowledged in that turn.
   Their `pending_ack_ids` are carried to the next user-turn boundary.

This deliberately favors repetition over loss. If response generation,
streaming, or the process is interrupted, no acknowledgement is sent and the
same messages remain pending after restart. The server cannot independently
observe that a UI rendered text; `displayed_in_prior_completed_turn: true` is a
client assertion. Requiring a later user turn establishes a stronger causal
boundary than acknowledging inside the response that is still being built.

The MCP page size defaults to and is capped at three. An opaque cursor continues
pagination. Mentor text occurs only once in the tool result, inside one JSON
data block; structured output contains metadata and protocol IDs without a
second copy. The complete serialized tool result has a 128 KiB UTF-8 hard
budget. Three messages of 8000 four-byte Unicode characters fit intact. If
JSON escaping makes a page exceed the budget, the tool returns a smaller whole
prefix and a cursor; it never truncates message text.

Acknowledgement remains atomic for the complete ID set and idempotently
preserves the first acknowledgement timestamp.

## Mentor message content boundary

Mentor content is limited to **8000 Unicode characters**. The shared
`MENTOR_MESSAGE_MAX_CHARACTERS` application constant is used by the mentor
page, MCP tool, and delivery response validator; PostgreSQL independently
enforces the same limit with a conditional `timeline_items` constraint and
both mentor-write trigger/RPC checks. The page sets `maxlength`, displays a
live character count, and blocks an oversized AI draft with a clear error.
Because native `maxlength` counts UTF-16 code units, the mentor input uses a
fixed value of 16002. This lets the first invalid worst-case value—8001
surrogate-pair characters—reach React state, where the UI shows the real count
and disables submission. The actual send/disable decision validates the
trimmed text as at most 8000 Unicode code points.

Exactly 8000 characters are accepted and 8001 are rejected at both the
service-role mentor RPC and authenticated mentor insert boundary. The fetch
RPC also checks for manually corrupted legacy content and fails closed; the
public route converts that failure to its sanitized `500` envelope rather
than returning or truncating the message.

## Credential lifecycle

Only an authenticated account that resolves exclusively to a student identity
can manage its WorkBuddy credential:

- **Create first**: succeeds only when there is no active credential.
- **Rotate**: revokes every previous active credential and inserts the new
  hash in the same database transaction.
- **Revoke**: idempotently revokes the active credential.
- **Status**: returns only prefix, status, creation, last-use, and revocation
  timestamps.

The server generates 32 random bytes with the operating system CSPRNG, prefixes
the base64url value with `wb_`, and persists only SHA-256 plus an 11-character
display prefix. A partial unique index enforces one active credential per
student even under concurrent create-first requests.
