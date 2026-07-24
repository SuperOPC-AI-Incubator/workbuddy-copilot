# Task 6 test plan — reliable mentor delivery and WorkBuddy credentials

## Test scenarios

| Area               | Scenario                                       | Expected                                                                                                                                             |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery service   | First fetch of pending mentor messages         | Ordered safe DTOs; `first_fetched_at`, `last_fetched_at`, and `fetch_count` are updated atomically                                                   |
| Delivery service   | Repeated fetch and a new service instance      | The same unacknowledged messages remain available without process memory or duplication                                                              |
| Delivery service   | Cursor pagination with identical timestamps    | `(created_at, id)` cursor neither skips nor repeats rows                                                                                             |
| Delivery service   | Optional session filter                        | Only a session owned by the credential student is accepted                                                                                           |
| Delivery service   | Acknowledge and acknowledge again              | Both succeed and preserve the first acknowledgement timestamp                                                                                        |
| Delivery service   | Known owned ID acknowledged before first fetch | The complete request fails with the same non-disclosing invalid-ID result; every message remains pending                                             |
| Delivery service   | Mixed fetched/unfetched acknowledgement IDs    | The complete request fails before updating anything; a later fetch still returns every previously unfetched message                                  |
| Delivery service   | Mixed own/foreign/unknown acknowledgement IDs  | The whole request fails with one non-disclosing result; nothing is partially acknowledged                                                            |
| Delivery locking   | Creation-order fetch vs reverse-UUID ack       | Static lock-order guard plus three real HTTP race rounds cover the student lock; fetch returns every row, while ACK succeeds only if fetch won first |
| Delivery locking   | Fetch vs parent-table cascade delete           | State-only UPDATE trigger bypasses parent locks; trusted cascade cleanup may wait but both operations finish without a lock cycle                    |
| Mentor content     | 8000 vs 8001 Unicode characters                | 8000 is accepted at service and authenticated insert boundaries; 8001 is rejected by application and database                                        |
| Mentor input       | 8000 vs 8001 surrogate-pair characters         | Native `maxlength=16002` lets 8001 emoji reach JS; code-point validation disables/rejects it without changing student limits                         |
| Mentor content     | Manually corrupted oversized pending row       | Fetch fails closed with a sanitized `500`; content is never returned or silently truncated                                                           |
| Public routes      | Valid GET/POST/OPTIONS                         | Bearer credential ownership, CORS, request IDs, and stable response envelopes                                                                        |
| Public routes      | Invalid/revoked credential                     | Sanitized `401`, with no token/hash/internal detail                                                                                                  |
| Public routes      | Invalid query/body/UTF-8/oversize              | Stable `400`/`413`; repository is not called                                                                                                         |
| Public routes      | Malformed RPC response or gateway failure      | Sanitized `500` carrying only a request ID                                                                                                           |
| Credential service | Create first credential                        | CSPRNG token returned once; only SHA-256 and a short safe prefix reach the repository                                                                |
| Credential service | Concurrent create-first                        | Database lock plus partial unique index allow at most one active credential                                                                          |
| Credential service | Rotate                                         | New credential and revocation of all previous active credentials are one transaction                                                                 |
| Credential service | Revoke twice                                   | Idempotent safe status; old token resolves as revoked                                                                                                |
| Credential service | Student-only authorization                     | Staff/non-student callers cannot list, issue, rotate, or revoke                                                                                      |
| Credential UI      | One-time display and connector handoff         | Token exists only in component memory, is not persisted in URL/storage/logs/Skill/command, and disappears on navigation/refresh                      |
| Database           | RPC grants and invariants                      | Service-role-only delivery RPCs; authenticated credential RPCs are absent; ownership joins and mentor-kind checks remain enforced                    |
| Database           | Legacy plaintext removal                       | Legacy RPC and `students.workbuddy_token` are dropped after all source callers migrate                                                               |
| Database           | Upgrade with legacy ACK-before-fetch row       | Migration locks delivery writes, requeues the unproven ACK, validates the new CHECK, then permits fetch followed by ACK                              |

## Tools and commands

- Unit/integration/static contracts: `bun run test`
- Type and bundle boundary: `bun run typecheck`, `bun run build`
- Full gate: `bun run check`
- Database behavior: `supabase test db` when Supabase CLI and a local PostgreSQL runtime are available
- Privacy scan: source and built output scans for plaintext legacy fields, credential secrets, and accidental token persistence

## Negative controls

- Remove the delivery RPC ownership predicate: isolation contract must fail.
- Remove `COALESCE(first_fetched_at, now())`: first-fetch timestamp contract must fail.
- Remove the ACK `first_fetched_at IS NOT NULL` eligibility predicate: the
  owned-ID-before-fetch and mixed fetched/unfetched pgTAP contracts must fail.
- Remove the partial unique active-credential index: concurrency contract must fail.
- Replace token generation with deterministic/short bytes: entropy seam test must fail.
- Leave the legacy plaintext column or RPC available: removal contract must fail.
- Remove the shared student-scoped lock from one delivery write path: the
  lock-order static guard must fail.
- Broaden fetch from `FOR UPDATE OF delivery` to an unqualified parent-row
  lock: the cascade lock-graph guard must fail.
- Remove the state-only UPDATE early return from delivery validation: the
  delivery-to-parent lock-edge guard must fail.
- Remove the mentor content constraint or delivery DTO maximum: the
  8001-character contract must fail.
