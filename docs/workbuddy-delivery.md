# Reliable mentor message delivery

Clients without MCP use the durable cross-platform fallback described in
[WorkBuddy fallback connector](workbuddy-connector.md). It preserves the same
fetch-without-ack and next-completed-turn acknowledgement boundary.

Mentor replies are persisted in `mentor_message_deliveries` when the trusted
mentor timeline path creates them. Fetch and acknowledgement state lives in
Supabase, so an application restart does not lose pending messages or reset
delivery counters.

## Mentor send and visible status

The mentor page never inserts a mentor timeline row from the browser. Its
authenticated server function derives the author from the verified bearer
token and calls the service-role-only `create_mentor_message` RPC. That RPC
requires an active mentor or team administrator whose first password change is
complete, derives the student from the selected session, and lets the existing
timeline trigger create the pending delivery in the same transaction. A
delivery-trigger failure rolls the timeline insert back.

Mentor timeline cards show independent channel facts rather than collapsing
them into one state:

- `待 WorkBuddy 获取`: no valid fetch has occurred.
- `WorkBuddy 已获取`: WorkBuddy fetched the message but has not acknowledged a
  later completed-turn display.
- `WorkBuddy 已送达`: acknowledgement is present.
- `网页已查看`: at least half of the mentor card was visible to the learner in
  the foreground web tab. This may be shown together with any WorkBuddy state
  and never sets `acknowledged_at`.
- `历史消息（无投递记录）`: a legacy mentor item has no delivery row.

Invalid or out-of-order state is shown conservatively and never claims a false
delivery. Only a parseable acknowledgement at or after the last successful
fetch removes a message from the pending total; legacy messages without a
delivery row remain explicitly historical and do not count. Timeline and
delivery are read through one joined snapshot. On `CHANNEL_ERROR`, `TIMED_OUT`,
or `CLOSED`, the page uses the authenticated server read path at 5, 10, 20,
then 30-second intervals. `SUBSCRIBED` invalidates stale requests, clears the
polling timer, and immediately performs a fresh authoritative read. Timeline
or delivery Realtime events also request a complete joined snapshot, so a
single row event cannot replace or omit older history. All initial,
post-subscription, Realtime-event, and disconnect-poll requests pass through
one single-flight refresh scheduler. Events arriving during a load coalesce
into one immediate follow-up snapshot. A temporary snapshot failure retries
even while Realtime remains connected, at 5, 10, 20, then capped 30-second
delays until success. Success resets that backoff; a session change or unmount
invalidates stale work and clears its applicable timers. Hiding the tab pauses
the separate disconnect-poll timer.

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
the complete set before updating anything. Every message must both belong to
the credential student and have completed at least one fetch. A known owned ID
that has not been fetched, or a mixed fetched/unfetched/foreign/unknown set,
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
preserves the first acknowledgement timestamp. A table constraint also rejects
any write that would create an acknowledged delivery without a first-fetch
timestamp. During upgrade, the migration briefly locks delivery writes and
requeues any legacy acknowledged-without-fetch rows as pending; this favors a
possible repeat over permanently losing a message whose display was never
proven. The migration explicitly wraps the lock, repair, validated constraint,
RPC replacement, and grants in one transaction because PostgreSQL rejects
`LOCK TABLE` outside a transaction block.

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

## Domain packs and optional AI

`DOMAIN_PACK` is read only in server AI code. The safe default,
`general-learning-camp`, uses Pioneers Learning Community / 学习营地 context.
`industrial-automation` explicitly enables PLC and industrial automation
context. Unknown values log only a sanitized warning and fall back to the
general pack.

AI can use either a complete generic OpenAI-compatible provider configuration
(`AI_PROVIDER_API_KEY`, `AI_PROVIDER_URL`, and `AI_PROVIDER_MODEL`) or the
legacy `DEEPSEEK_API_KEY`. The generic group takes precedence and optionally
accepts `AI_PROVIDER_ENABLE_THINKING=true|false`, which is sent as the top-level
`enable_thinking` boolean. A partial generic group fails closed before fetch
and never falls back to the legacy key, preventing a credential from being
sent to the wrong provider. Generic URLs must use HTTPS and contain no
userinfo. Provider HTTP redirects are rejected rather than followed, so the
validated endpoint cannot redirect a server request to a second address.

When no generic group or legacy key is present, AI draft and answer actions
return a clear unavailable result; manual mentor send, timeline status, MCP
delivery, and the fallback connector continue to work. Tencent TokenHub is the
primary runtime profile and DashScope is a manually selected standby; the
request path does not implement automatic fallback.

Provider failures are normalized to stable internal codes before they reach a
server-function boundary. Provider response bodies, endpoint details, and keys
are never returned or logged. The browser maps only known codes to fixed
Chinese messages and restores the learner's composer input after every failed
request.

AI replies and optional diagnoses are persisted by the service-only
`create_ai_response` RPC. The verified bearer actor must resolve to the student
who owns the selected session. Reply and diagnosis inserts run in one database
transaction, so a diagnosis failure also rolls back its reply and the server
returns success only after persistence completes.

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
