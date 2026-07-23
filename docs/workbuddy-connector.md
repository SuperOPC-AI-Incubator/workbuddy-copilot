# WorkBuddy fallback connector

MCP is the preferred WorkBuddy integration. The fallback connector exists for
clients that cannot connect to MCP and preserves the same reliable ingest and
mentor-message acknowledgement boundaries on macOS, Linux, and Windows.

## Install

The authenticated `/workbuddy` page provides same-origin downloads and
token-free install commands for:

- macOS and Linux: `install-macos.sh`
- Windows: `install-windows.ps1`
- the Node.js 22 stdlib-only runtime: `workbuddy-sync.mjs`
- a token-free WorkBuddy `SKILL.md`

The installer prompts for the one-time credential without echoing it. It sends
the credential through standard input to `configure --token-stdin`; it never
puts the credential in the command line, shell history, Skill, event, queue, or
render ledger. POSIX uses a `0700` state directory and `0600` configuration.
Windows removes inherited ACL entries and grants only the current user access.
Neither installer requires administrator privileges.

The installer creates the actual WorkBuddy user Skill at:

- macOS/Linux: `$HOME/.workbuddy/skills/superbrain-sync/SKILL.md`
- Windows: `%USERPROFILE%\.workbuddy\skills\superbrain-sync\SKILL.md`

It also creates a current-user connector command:

- macOS/Linux: `$HOME/.local/bin/workbuddy-sync`
- Windows: `%LOCALAPPDATA%\SuperBrainCopilot\app\workbuddy-sync.ps1`

These wrappers embed the install-time absolute Node.js and connector paths, so
WorkBuddy and background schedules do not depend on `PATH`. The generated Skill
calls the absolute wrapper and contains no credential. Restart WorkBuddy after
installing it.

On POSIX, the wrapper and scheduled runner also embed and export the
install-time `XDG_STATE_HOME`. Clearing or changing that environment variable
later therefore cannot silently switch the interactive command, launchd, or
cron to another configuration directory. Every install or upgrade reapplies
`0700` to the private state directories and `0600` to the existing
configuration. Windows likewise reapplies the checked current-user-only ACL to
an existing configuration and aborts if Windows rejects the ACL replacement.

The user-Skill location above is consistent with the WorkBuddy examples in
[腾讯云开发者社区：Skills 目录与 SKILL.md 示例](https://cloud.tencent.com/developer/article/2693324)
and
[腾讯云开发者社区：WorkBuddy Skills 使用说明](https://cloud.tencent.com/developer/article/2672691).
WorkBuddy versions and distribution channels may scan Skills differently. If
the Skill does not appear after restart, use **技能栏 → 导入** and select the
installed `SKILL.md`; the setup page shows this fallback explicitly.

Install and upgrade are idempotent. Uninstall removes the scheduled task and
program files but deliberately preserves the private state directory, queued
events, render ledger, and configuration for recovery.

## Commands

```text
workbuddy-sync configure --api-url https://copilot.example.com
workbuddy-sync sync --event-file /path/to/turn.json
workbuddy-sync flush
workbuddy-sync fetch [--session-id UUID]
workbuddy-sync ack --message-ids UUID[,UUID...]
workbuddy-sync status
workbuddy-sync test-connection
```

Use the absolute wrapper path shown above when invoking these commands from
WorkBuddy, automation, or an environment where the user bin directory may not
be on `PATH`.

`configure` uses a masked terminal prompt. In a trusted installer pipeline,
`--token-stdin` explicitly enables standard-input credential delivery.
There is intentionally no credential command-line option or environment
variable.

## State and crash recovery

State lives at:

- POSIX:
  `${XDG_STATE_HOME:-$HOME/.local/state}/superbrain-copilot`
- Windows: `%LOCALAPPDATA%\SuperBrainCopilot`

Before any network request, `sync` validates the strict reliable-turn contract
and atomically writes the event through a same-directory temporary file,
`fsync`, and rename. `flush` atomically renames one outbox file into the claims
directory using a filename containing claim timestamp, process ID, and nonce,
so two processes cannot send the same local event concurrently. Staleness is
measured from that claim timestamp rather than the original event file's
modification time. A newly claimed old event is therefore not stolen, while a
truly expired claim is recovered after a crash. Malformed queue files and `409
EVENT_ID_CONFLICT` events move to quarantine. `401` and exhausted
network/`5xx` failures retain the original event.

Every cross-directory move follows a fixed durability order. No-replace
recovery creates the destination hard link, syncs the destination directory,
unlinks the source, then syncs the source directory. Unique claim and
quarantine renames sync the destination directory before the source directory;
a same-directory move syncs once. A crash can therefore leave a recoverable
duplicate link, but never a source deletion whose destination name was not
durable.

Enqueue, render-ledger, and acknowledgement critical sections use
crash-recoverable JSON leases containing version, acquisition time, heartbeat
time, process ID, nonce, and ticket. Each lock has a persistent directory;
contenders publish a unique `choosing` file, choose `1 + max(ticket)`, then wait
for all choosing phases and for the smallest `(ticket, nonce)`. This preserves
ordering even when two processes choose the same ticket. The owner atomically
refreshes its nonce-specific lease every third of the stale interval with an
unreferenced timer. A stale-looking lease is protected while its same-machine
PID is alive only for a bounded grace period (`LIVE_PID_GRACE_MS`, defaulting
to five stale intervals within a 30-second to 30-minute range, with
`livePidGraceMs` available for deterministic embedding and tests). After that
hard grace, the exact old nonce file is reclaimed even if the PID was reused.
Before any queue or ledger commit, the owner rereads its exact lease and
verifies the nonce, ticket, acquisition time, and hard-grace age. A resumed old
owner therefore fails closed instead of overwriting newer state. Release stops
the heartbeat and removes only the owner's unique file, so a late release
cannot delete a newer owner.

Requests use HTTPS, a stable user agent and request ID, bounded bodies,
timeouts, and three retries with exponential backoff and jitter. Redirects are
never followed, so the authorization header cannot cross an origin boundary.
Plain HTTP is accepted only through an injected localhost-only test setting.

## Mentor-message delivery boundary

`fetch` requests at most three pending messages and validates the complete
response. Each exact message is atomically persisted with its ID, session,
original text, creation timestamp, and local render timestamp before it is
printed. Mentor text is untrusted quotation data and is never executed.

Fetching does not acknowledge. `ack` accepts only a unique, exact set of IDs
that exist in the unified render ledger. IDs already acknowledged locally are
successful no-ops. For a mixed request, the connector validates every ID,
releases the ledger lease, performs the idempotent server acknowledgement with
no local lock held, then reacquires the short acknowledgement and ledger
leases. It reloads the latest ledger, merges acknowledgement timestamps, and
rewrites it once. A mentor message fetched during a slow acknowledgement is
therefore preserved. A network failure makes no local acknowledgement change.
A crash after server success but before the atomic ledger rewrite safely
retries the server call and fills the local acknowledgement state.

The installers create a user-level launchd, cron, or Windows Scheduled Task
that periodically runs `flush` and `fetch` using embedded absolute paths. The
runner writes timestamps, command results, and failures to
`logs/scheduled-sync.log` under the private state directory. Scheduled `fetch`
discards the message body and never acknowledges it. The WorkBuddy Skill still
performs the visible fetch and acknowledges only at the next completed
user-turn boundary.

## Verification and platform limits

The test suite executes the connector against real temporary state directories
and a local HTTP test server. It covers first-send failure/recovery,
concurrent flush, stale claims, malformed quarantine, `401`/`409`/`5xx`,
redirect and response-size rejection, exact Unicode preservation,
render-before-ack ordering, repeated and partial acknowledgement, failed-ack
recovery, expired and active leases, secret absence, and POSIX installer
idempotency/permissions. The POSIX test also executes the generated absolute
wrapper and checks the installed WorkBuddy Skill and file permissions.

The Windows installer has static contract coverage on macOS. Its actual
PowerShell execution remains a Windows CI responsibility when `pwsh` is not
available locally; local results must not be reported as a Windows runtime
pass.
