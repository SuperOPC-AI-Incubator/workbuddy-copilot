# Cloud loop and multi-OS verification

This is the executable test plan for the managed Supabase and Tencent-hosted
prototype. It supplements the focused unit and pgTAP contracts already in the
repository.

## Locked acceptance paths

| Path                         | Deterministic input                                  | Required result                                                                                 | Runner                          |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| Public signup                | Unique email and display name                        | No privileged role control in the UI; database has exactly the `student` role                   | `auth-and-mentor.spec.ts`       |
| Staff first login            | Unique username and temporary test password          | Redirect to password change; `must_change_password=false` after completion                      | `auth-and-mentor.spec.ts`       |
| Mentor administration        | Completed team admin and a unique new mentor         | Admin UI creates the mentor; disable bans Auth and makes database authorization fail closed     | `auth-and-mentor.spec.ts`       |
| Disabled existing session    | Mentor browser is open before disable                | The next send is rejected, no row is written, and reload signs the mentor out                   | `auth-and-mentor.spec.ts`       |
| WorkBuddy ingest             | Unique event UUID and exact prompt/reply/diagnosis   | First request writes one timeline set; exact replay is duplicate; changed payload is HTTP 409   | `workbuddy-loop.spec.ts`        |
| Mentor observation and reply | Exact session title and message text                 | REST event is visible on the mentor timeline; mentor reply is visible in the student web client | `workbuddy-loop.spec.ts`        |
| Durable delivery             | Exact mentor message UUID                            | GET returns the same unread message until ACK; after ACK it disappears                          | `workbuddy-loop.spec.ts`        |
| Ownership isolation          | A second student's credential                        | Other session fetch and other student's message ACK are both rejected                           | `workbuddy-loop.spec.ts`        |
| Database concurrency         | Three simultaneous-ingest/credential/delivery rounds | No duplicate rows, split state, skipped case, or delivery deadlock                              | `workbuddy-concurrency.test.ts` |
| Connector installation       | Disposable user home and stdin-only credential       | Canonical program, wrapper, Skill, protected config, status, and no permanent test schedule     | connector matrix                |

Every browser test creates a unique namespace and deletes only the Auth users it
created. Auth cascades remove the linked student, staff, session, timeline,
delivery, and credential rows. Public API helpers never print request headers,
credentials, passwords, or raw response objects.

## Red controls

Each of the four required browser cases has its own automated negative control:
student-only signup, password rotation, disabled-session sending, and WorkBuddy
delivery. CI runs each exact file/title pair independently and accepts RED only
when the JSON report contains one failed test, no skip or infrastructure error,
and that control's assertion marker. Zero discovery, compilation failure,
fixture failure, and unrelated assertions cannot satisfy a control.

Development RED evidence for this change:

1. The initial Playwright discovery failed because the real Supabase fixture did
   not exist and reported zero tests.
2. The CI contract suite initially failed all five cases because the workflow,
   required-suite runners, host gate, and real installer tests did not exist.
3. After implementation, discovery finds four browser cases and the CI contract
   suite passes its complete current contract set.

## CI topology

- `quality`: frozen public-registry install, forbidden-host gate, formatting,
  lint, type check, unit/integration surface tests, and production build.
- `local-cloud-loop`: starts disposable local Supabase, resets from all
  migrations, runs pgTAP, runs the write-enabled concurrency suite with zero
  skips, proves all four browser RED controls, and runs Playwright with one
  worker. The required runner compares the report with an exact four-entry
  `{file, title}` manifest, not only a test count. Supabase is stopped in an
  `always()` step.
- `connectors`: Node 22 plus Bun on Ubuntu, macOS, and Windows. Linux/macOS run
  the real POSIX installer; Windows runs the real PowerShell installer with
  `-NoSchedule`, verifies protected ACLs, and runs the installed wrapper.
- `live-predeploy`: skipped unless `LIVE_PREDEPLOY_ENABLED=true` is set as a
  repository variable and the manually dispatched job receives all test-project
  secrets. A second guard requires `LIVE_PREDEPLOY_TEST_PROJECT=true`; the job
  is not a production-data test. Before any browser or signup step, the guard
  requires the deployment-identity endpoint's server-runtime `SUPABASE_URL` hash
  and browser-build `VITE_SUPABASE_URL` hash to be mutually consistent and equal
  to the configured E2E Supabase host hash. A missing or mismatched value stops
  the job before any page, browser fixture, or test user write.

CI disables Playwright traces, screenshots, and video because those artifacts
can contain typed passwords, authenticated page state, and Auth responses.
Only a generated summary containing allowlisted `file`, `title`, `status`,
`count`, and `duration` fields is uploaded. Error messages, steps, attachments,
stdout, network data, and DOM content are never copied into the artifact. Local
developer runs may still retain browser artifacts. WorkBuddy Bearer requests use
Node's native fetch outside browser tracing.

## Public Lovable package boundary

`@lovable.dev/mcp-js` and `@lovable.dev/vite-tanstack-config` remain only as
public npmjs packages providing the MCP protocol SDK and the existing Vite
plugin configuration. They do not connect this repository to a Lovable-hosted
project or private artifact registry. Every lockfile source resolves through the
public npm registry; the packages can be replaced later if the same protocol and
build behavior are provided. The host gate continues to reject `lovable.app`,
`works.dev`, and Lovable private `pkg.dev` URLs without treating the public
package scope itself as a deployment dependency.

## Commands

```sh
bun run check
bun run ci:forbidden-hosts
bun run test:connectors
CONNECTOR_TEST_TOKEN='<test-only-token>' bun run test:connectors:posix
```

With local Supabase environment variables exported:

```sh
bun run test:integration:required
bun run test:e2e:negative-control
bun run test:e2e:local
```

The `:required` commands reject missing configuration, zero discovered tests,
and any skipped test. Plain `bun run test:e2e` remains a developer discovery
command and marks the four tests skipped when no local Supabase environment is
available.

## Local verification boundary

The development machine used for this change has no Docker, Supabase CLI, or
PowerShell. It can verify Playwright discovery, TypeScript, the full unit/build
gate, the URL/registry gate, and the real POSIX installer. pgTAP, database
concurrency, browser/database execution, and the Windows ACL installer run are
therefore mandatory CI checks and must not be reported as locally passed.
