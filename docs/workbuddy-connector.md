# WorkBuddy fallback connector

MCP is the preferred WorkBuddy integration. The fallback connector exists for
clients that cannot connect to MCP and provides reliable upstream turn ingest
on macOS, Linux, and Windows. Returning mentor messages to WorkBuddy is not
part of the default installation in this release.

## Install

The authenticated `/workbuddy` page provides same-origin downloads and
token-free install commands for:

- macOS and Linux: `install-macos.sh`
- Windows: `install-windows.ps1`
- runtime modules: `workbuddy-sync.mjs`, `workbuddy-transcript.mjs`,
  `workbuddy-event-id.mjs`, and `workbuddy-hook.mjs`
- `detect-runtime.sh`, which must be beside the POSIX installer
- a token-free WorkBuddy `SKILL.md` template, required only when downstream is
  explicitly enabled

The installer prompts for the one-time credential without echoing it. It sends
the credential through standard input to `configure --token-stdin`; it never
puts the credential in the command line, shell history, Skill, event, queue, or
render ledger. POSIX uses a `0700` state directory and `0600` configuration.
Windows removes inherited ACL entries and grants only the current user access.
Neither installer requires administrator privileges.

The connector needs a Node.js 22+ runtime, but students do not need Node.js on
`PATH`. The installers select, in order: an explicit `WORKBUDDY_NODE` override,
WorkBuddy's bundled Electron binary (run with `ELECTRON_RUN_AS_NODE=1`), a
Node binary WorkBuddy previously downloaded, and finally `PATH` Node as a
fallback. They embed the selected absolute runtime path in the generated
wrappers, so WorkBuddy and background work do not subsequently depend on
`PATH`.

The downstream WorkBuddy Skill is **not installed by default**. This release's
default path only sends upstream turns. Use `--with-downstream` on macOS/Linux
or `-WithDownstream` on Windows to create the Skill for an explicitly requested
downstream setup. When that switch is used, the user-Skill is created at:

- macOS/Linux: `$HOME/.workbuddy/skills/superbrain-sync/SKILL.md`
- Windows: `%USERPROFILE%\.workbuddy\skills\superbrain-sync\SKILL.md`

It also creates a current-user connector command:

- macOS/Linux: `$HOME/.local/bin/workbuddy-sync`
- Windows: `%LOCALAPPDATA%\SuperBrainCopilot\app\workbuddy-sync.ps1`

When installed, the generated Skill calls the absolute wrapper and contains no
credential. Restart WorkBuddy after an installation that changes its settings.

Normal installation also registers the upstream wrapper in the `Stop` event of
`~/.workbuddy/settings.json` (the equivalent path under `%USERPROFILE%` on
Windows). It merges the connector entry without removing the student's existing
hooks and replaces its own prior entry during an upgrade. Before changing the
file, it creates an atomic, timestamped backup of the existing settings file.
This upstream hook is independent of the optional downstream Skill.

On POSIX, the wrapper and scheduled runner also embed and export the
install-time `XDG_STATE_HOME`. Clearing or changing that environment variable
later therefore cannot silently switch the interactive command, launchd, or
cron to another configuration directory. Every install or upgrade reapplies
`0700` to the private state directories and `0600` to the existing
configuration. Windows likewise reapplies the checked current-user-only ACL to
an existing configuration and aborts if Windows rejects the ACL replacement.

The optional user-Skill location above is consistent with the WorkBuddy examples in
[腾讯云开发者社区：Skills 目录与 SKILL.md 示例](https://cloud.tencent.com/developer/article/2693324)
and
[腾讯云开发者社区：WorkBuddy Skills 使用说明](https://cloud.tencent.com/developer/article/2672691).
WorkBuddy versions and distribution channels may scan Skills differently. If an
explicitly installed Skill does not appear after restart, use **技能栏 → 导入**
and select the installed `SKILL.md`; the setup page shows this fallback
explicitly.

Install and upgrade are idempotent. They also start one background
`workbuddy-sync import --since 7d` pass unless `--no-import`/`-NoImport` was
specified. Import is hard-capped to the most recent seven days and can safely
be re-run with the same command; progress is written to `logs/import.log`.
Uninstall removes the scheduled task, registered Stop hook, and program files
but deliberately preserves the private state directory, queued events, render
ledger, and configuration for recovery.

## Commands

```text
workbuddy-sync configure --api-url https://copilot.example.com
workbuddy-sync sync --event-file /path/to/turn.json
workbuddy-sync flush
workbuddy-sync import --since 7d
workbuddy-sync status
workbuddy-sync test-connection
workbuddy-sync ipc [--poll-interval-ms 30000]
```

Use the absolute wrapper path shown above when invoking these commands from
WorkBuddy, automation, or an environment where the user bin directory may not
be on `PATH`.

`configure` uses a masked terminal prompt. In a trusted installer pipeline,
`--token-stdin` explicitly enables standard-input credential delivery.
There is intentionally no credential command-line option or environment
variable.

`ipc` is a long-running local agent endpoint for a future display shell. It
prints its private endpoint and capability-token file path as JSON once it is
ready and exits cleanly on `SIGINT` or `SIGTERM`; it does not open a TCP port.
`--poll-interval-ms` is optional (the default is currently 30000); a shell must
read the active value from IPC `status`, not assume that default.

On POSIX the endpoint is a `0600` Unix domain socket. On Windows it is a named
pipe. Every shell must include the per-agent-run capability token from
`ipc-capability.token` in `hello`; the service silently closes an unauthenticated
connection and never returns the token or the configured cloud credential. The
token file is inside the existing current-user-only state directory (POSIX 0700;
Windows installer ACL), so it is the Windows access boundary without introducing
a compiled native addon. Socket/pipe permissions remain defence in depth.

`messages.displayed` means the agent has durably accepted the shell's display
claim, not that its upstream acknowledgement has finished. The connector retries
the latter in the background and resumes outstanding acknowledgements after a
restart. `agent.shutdown` is best effort only: a shell must also treat the IPC
connection closing as the authoritative offline signal.

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

The installers create a user-level launchd, cron, or Windows Scheduled Task
that periodically runs the embedded connector paths. The runner records
timestamps, command results, and failures in `logs/scheduled-sync.log` under
the private state directory. It may run the connector's low-level `fetch`
operation, but discards message bodies and never acknowledges them; that does
not return mentor messages to WorkBuddy. The default installation intentionally
creates no downstream Skill. Treat `--with-downstream`/`-WithDownstream` as an
explicit opt-in rather than a default mentor-message delivery path.

## Verification and platform limits

The test suite executes the connector against real temporary state directories
and a local HTTP test server. It covers first-send failure/recovery,
concurrent flush, stale claims, malformed quarantine, `401`/`409`/`5xx`,
redirect and response-size rejection, exact Unicode preservation,
render-before-ack ordering, repeated and partial acknowledgement, failed-ack
recovery, expired and active leases, secret absence, and POSIX installer
idempotency/permissions. The POSIX test also executes the generated absolute
wrapper, checks the optional WorkBuddy Skill when downstream is enabled, and
checks that the default installation leaves it absent.

The Windows installer has static contract coverage on macOS. Its actual
PowerShell execution remains a Windows CI responsibility when `pwsh` is not
available locally; local results must not be reported as a Windows runtime
pass.
