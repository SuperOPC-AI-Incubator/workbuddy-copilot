# WorkBuddy reliable ingest

`POST /api/public/workbuddy/ingest` accepts one complete WorkBuddy turn. The
request uses a per-student bearer credential:

```http
Authorization: Bearer <workbuddy-credential>
Content-Type: application/json
```

```json
{
  "event_id": "20000000-0000-4000-8000-000000000001",
  "source": "connector",
  "source_session_key": "machine-a/session-42",
  "session_title": "PLC troubleshooting",
  "prompt": "Why did the interlock trip?",
  "reply": "Check the isolation state first.",
  "diagnosis": {
    "text": "The learner skipped the isolation check.",
    "severity": "warn"
  },
  "client_created_at": "2026-07-23T09:00:00.000Z"
}
```

- `event_id` is the idempotency key. A retry must reuse it.
- `source_session_key` is stable for the lifetime of one local conversation.
- The cloud session identity is `(student, source, source_session_key)`. A
  visible title never merges sessions.
- The request never accepts `student_id`, `session_id`, timeline `kind`, or a
  mentor message.
- `prompt`, `reply`, and `diagnosis` are written with ordinals 0, 1, and 2 in
  one database transaction.

The canonical payload hash includes contract version, source,
source-session key, title, prompt, reply, diagnosis, and client timestamp. It
excludes `event_id` (the ledger key) and `student_id` (resolved from the
credential).

A successful response returns stable item IDs:

```json
{
  "ok": true,
  "event_id": "20000000-0000-4000-8000-000000000001",
  "session_id": "30000000-0000-4000-8000-000000000001",
  "item_ids": {
    "prompt": "40000000-0000-4000-8000-000000000001",
    "reply": "40000000-0000-4000-8000-000000000002",
    "diagnosis": "40000000-0000-4000-8000-000000000003"
  },
  "duplicate": false
}
```

The same event and payload returns the same IDs with `duplicate: true`. The
same event with changed content or a different student returns
`409 EVENT_ID_CONFLICT`. Other stable public responses are `400
INVALID_PAYLOAD`, `401 UNAUTHORIZED`, `413 PAYLOAD_TOO_LARGE`, and a sanitized
`500 INTERNAL_ERROR`.

The MCP `log_turn` tool uses the same service and database RPC. It derives the
student from the authenticated MCP user and requires `event_id` plus
`source_session_key`; it never accepts a cloud session or student ID.

## Updating an installed SKILL

The old SKILL body used top-level `session` and `items` objects, with a `kind`
on every timeline item. That shape is intentionally not accepted by the
reliable endpoint. Because there is no production learner data to migrate,
existing installations should delete or update the old SKILL and reinstall
the reliable template from the WorkBuddy setup page.

The setup page no longer reads the deprecated plaintext token RPC. Until Task
6 provides create/rotate/revoke credential management and one-time credential
display, the page shows a `<WORKBUDDY_CREDENTIAL>` placeholder and must be
treated as a format preview rather than an immediately usable installation.
