# Tencent Cloud deployment and rollback

The production application is an independent Node/Nitro service:

- public host: `copilot.sg.superbrain-ai.com`;
- application listener: `127.0.0.1:3410` only;
- application root: `/opt/superbrain-copilot`;
- systemd unit: `superbrain-copilot.service`;
- secret environment file: `/etc/superbrain-copilot.env`.

The existing `workbuddy-copilot.service` on port `8765` is a separate
application. The new deployment must never modify, restart, stop, proxy to, or
reuse that service or port.

## Server prerequisites

The verified target is Ubuntu 24.04 with Node.js 22.22 and Nginx 1.24. Before
the first release:

1. Install Bun 1.3.10 for the `deploy` user using an approved, pinned
   installer or package. Do not use an unpinned `latest` install in production.
   Confirm `bun --version` prints exactly `1.3.10`.
2. Confirm `/usr/bin/node` is Node.js 22.22 or the tested Node 22 maintenance
   release.
3. Confirm the Ubuntu `util-linux` package provides `flock`; the deploy script
   uses it for a non-blocking process lock.
4. Confirm `/usr/bin/python3` is the Ubuntu system Python. It is used only for
   no-follow directory identity checks and an inode-anchored build working
   directory.
5. Create `/opt/superbrain-copilot/releases` owned by `deploy:deploy`. Keep
   every release directory after deployment; cleanup is a separate, reviewed
   operation.
6. Install the systemd template from `deploy/`.
7. Install Certbot and use the HTTP-only bootstrap template below to obtain the
   first certificate before installing the production TLS template.

The site template preserves WebSocket upgrades and disables response/request
buffering so MCP and server-sent event streams are not delayed.

## External environment

Both the tracked `.env` and `.env.example` are deliberately empty-value
templates. They are not deployment configuration and must remain secret-free.

Note that the tracked `.env` defines every key with an empty value, so a build
that does not inject `VITE_SUPABASE_PROJECT_ID` gets an empty string rather than
an undefined variable. `src/lib/mcp/index.ts` therefore falls back with `||`, not
`??`, and `scripts/deploy.sh` rejects a missing or malformed ref before building.

## Hosting account facts

These are the facts a new operator needs and cannot recover from the code.

| Item                  | Value                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Supabase organization | `wangjialiang678's Org` (`pmkswkoiqbfciyxtdvaf`) — a personal account, not a team organization |
| Supabase project      | `superbrain-copilot` / `hwxbrkvvziqpvsmyllqn`                                                  |
| Region                | `ap-southeast-1` (Singapore)                                                                   |
| Plan                  | Free                                                                                           |
| Application host      | Tencent Cloud Singapore, `101.32.248.235`, reached as `copilot.sg.superbrain-ai.com`           |
| Backup location       | `/var/backups/superbrain-copilot/` on that host                                                |

Two consequences of the Free plan, both handled by `scripts/ops/supabase-maintenance.sh`:

- **Projects pause after a week of low activity.** Supabase pauses Free-plan
  projects that show low activity over a 7-day period, and its own guidance is
  that "a few user requests to the database each day" is enough to avoid it.
  Visiting the dashboard does not count; database activity does. A paused project
  keeps its data and can be resumed from the dashboard within a year, taking
  roughly 30 seconds to wake.
- **There are no automatic backups and no point-in-time recovery.** The only
  copy is the one this repository's cron job produces.

Upgrading to Pro removes the pausing behaviour and adds daily backups with 7-day
retention. Custom domains are a separate paid add-on, so today every student
browser and MCP client must reach `hwxbrkvvziqpvsmyllqn.supabase.co` directly;
see `docs/student-network-check.md` before a camp starts.

The GitHub repository lives in the `SuperOPC-AI-Incubator` organization while the
Supabase project does not. Moving the project to a team organization is possible
from the project's general settings, requires ownership of the source
organization and membership of the target, and cannot change the region.

## Free-plan maintenance cron

`scripts/ops/supabase-maintenance.sh` has two subcommands, deliberately on
different schedules:

```
keepalive   one small database request, daily
backup      pg_dump of the public and auth schemas, weekly, latest copy only
```

The schedules are not interchangeable. A weekly job alone sits exactly on the
7-day pausing threshold, so `keepalive` runs daily; the dump is the expensive
half and runs weekly.

`keepalive` reuses `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from
`/etc/superbrain-copilot.env`, so it needs no new credential. Row-level security
denies the anonymous read and an empty result is expected — the point is that
PostgREST evaluated the policy against the database.

`backup` needs database credentials that are deliberately absent from the
application environment file. Create `/etc/superbrain-copilot-backup.env` owned
by `root:root` with mode `0600`, containing standard libpq variables taken from
the Supabase dashboard's database settings:

```dotenv
PGHOST=
PGPORT=5432
PGUSER=
PGPASSWORD=
PGDATABASE=postgres
PGSSLMODE=require
```

Nothing is passed on the command line, so no credential appears in `ps` output.

Two host-specific details decide how the connection is configured.

**The client must be at least as new as the server.** The project runs
PostgreSQL 17 and Ubuntu 24.04 ships the 16 client, which refuses to dump a
newer server outright. This host is shared: a system PostgreSQL 16 serves other
services on the same machine, so installing `postgresql-client-17` over the
shared `libpq5` was rejected as too wide a change for a backup job. The 17
client is unpacked into its own prefix instead, touching no packages:

```bash
dpkg -x postgresql-client-17_17.9-1.pgdg24.04+1_amd64.deb /opt/pg17
dpkg -x libpq5_18.4-1.pgdg24.04+1_amd64.deb /opt/pg17
```

`/etc/cron.d/superbrain-copilot-ops` then points the script at that prefix:

```
PG_DUMP=/opt/pg17/usr/lib/postgresql/17/bin/pg_dump
PG_DUMP_LIB_PATH=/opt/pg17/usr/lib/x86_64-linux-gnu
```

`PG_DUMP_LIB_PATH` is not optional dressing. Without it the 17 client resolves
`libpq.so.5` to the system's 16.13 copy, which happens to satisfy `--version`
but is older than the `libpq5 (>= 17.9)` the package declares. Removing
`/opt/pg17` and those two cron lines fully reverts this.

**Direct database connections need IPv6, which this host does not have.**
`db.<project-ref>.supabase.co` publishes only an AAAA record and the server has
no global IPv6 address, so a direct connection can never work from here. Use the
dashboard's **Session pooler** connection (port 5432), not the transaction
pooler on 6543: transaction pooling does not preserve the session state
`pg_dump` relies on. The pooler user is `postgres.<project-ref>`.

The dump is verified before it replaces the retained copy: a size floor plus the
presence of `"public"."students"`, `"public"."timeline_items"` and
`"auth"."users"`. This ordering exists so a truncated or empty dump can never
overwrite a good backup. If the `auth` schema cannot be read with the configured
role, the run fails rather than silently shrinking; retry with
`BACKUP_SCHEMAS=public` and treat account recovery as a separate problem.

To restore, decompress and apply with a matching client:

```bash
gunzip -c /var/backups/superbrain-copilot/superbrain-copilot-latest.sql.gz |
  psql "$CONNECTION_STRING"
```

The dump is taken with `--clean --if-exists`, so it drops the objects it
recreates. Never point a restore at the production project unless that is the
intent.

## Managed Supabase Auth configuration

The tracked Supabase project is `hwxbrkvvziqpvsmyllqn`. Production Auth intent
is stored in `supabase/auth.production.json`; it contains only public URLs and
booleans. Do not add an access token, database password, service-role key, or
publishable key to that file.

Do not use `supabase config push` for the production Auth setup. The current CLI
has no Auth dry-run and builds a broader Auth update body than the five fields
reviewed for this prototype. Use the scoped Management API helper instead:

```bash
bun run supabase:auth:plan
node scripts/configure-supabase-auth.mjs \
  --apply \
  --project-ref hwxbrkvvziqpvsmyllqn
```

The plan is the default and performs only a remote read. Apply fails before
network access unless the explicit ref matches both
`supabase/config.toml` and `supabase/auth.production.json`; it PATCHes only the
reviewed URL/signup/email-confirmation fields and then reads them back for exact
verification. The helper never prints the access token or a raw remote response.

After an interactive `supabase login` on macOS, the CLI stores the default
profile token in Keychain. The helper reads that item directly with
`/usr/bin/security` and no shell, so the resolved value is not placed in a
command argument, environment variable, log, or file. macOS may ask the signed-in
user to approve Keychain access once. In CI and on non-macOS hosts, inject
`SUPABASE_ACCESS_TOKEN` through the platform secret store; never put its resolved
value in shell history or a tracked environment file.

The prototype keeps public Email signup enabled and Email confirmation disabled
so a student receives a session immediately. This does not open public mentor
registration: the public UI submits only student metadata, the database
provisions the student role, and mentors remain an admin-created account type.

Create `/etc/superbrain-copilot.env` directly on the server, owned by
`root:deploy` with mode `0640`. Populate the variables listed in
`.env.example`; do not copy the file back into Git or a release. The systemd
`ExecStart` command sets `HOST=127.0.0.1` and `PORT=3410` after every
EnvironmentFile has been read, so blank or conflicting `HOST`/`PORT` entries
cannot change the listener. Each immutable release also receives a non-secret
`.release.env` containing only its validated release id.

For the Tencent TokenHub primary provider, configure the complete generic
provider group at runtime:

```dotenv
AI_PROVIDER_API_KEY=<injected by the server secret store>
AI_PROVIDER_URL=https://tokenhub.tencentmaas.com/v1/chat/completions
AI_PROVIDER_MODEL=qwen3.5-flash
AI_PROVIDER_ENABLE_THINKING=false
```

`AI_PROVIDER_API_KEY`, `AI_PROVIDER_URL`, and `AI_PROVIDER_MODEL` are an atomic
group. If any one is set, all three must be non-empty; partial or invalid
generic configuration fails before network access even when
`DEEPSEEK_API_KEY` is present. The URL must use HTTPS and must not contain
userinfo. `AI_PROVIDER_ENABLE_THINKING` is optional, but when set accepts only
the literal value `true` or `false`.

To switch manually to the DashScope standby, replace the complete group with
the approved regional OpenAI-compatible chat-completions URL, credential, and
model (for example the Beijing shared endpoint
`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` with
`qwen-plus`), restart the service, and run the post-deployment smoke checks.
There is no automatic provider fallback. A deployment that sets only the
legacy `DEEPSEEK_API_KEY` keeps the existing DeepSeek endpoint, model, and
request shape.

## First-time service setup

```bash
sudo install -m 0644 deploy/systemd/superbrain-copilot.service \
  /etc/systemd/system/superbrain-copilot.service
sudo systemctl daemon-reload
sudo systemctl enable superbrain-copilot.service
```

Grant the `deploy` user narrowly scoped permission to restart and stop only
`superbrain-copilot.service`. Do not grant permission for
`workbuddy-copilot.service`.

## Reproducible TLS bootstrap

The production Nginx template references fixed Let's Encrypt paths, so it must
not be enabled before the first certificate exists. Bootstrap in this order:

```bash
sudo install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge
sudo install -m 0644 \
  deploy/nginx/copilot.sg.superbrain-ai.com.bootstrap.conf \
  /etc/nginx/sites-available/copilot.sg.superbrain-ai.com.conf
sudo ln -sfn /etc/nginx/sites-available/copilot.sg.superbrain-ai.com.conf \
  /etc/nginx/sites-enabled/copilot.sg.superbrain-ai.com.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt \
  --domain copilot.sg.superbrain-ai.com

sudo install -m 0644 deploy/nginx/copilot.sg.superbrain-ai.com.conf \
  /etc/nginx/sites-available/copilot.sg.superbrain-ai.com.conf
sudo nginx -t
sudo systemctl reload nginx

curl --noproxy '*' -sS --connect-timeout 5 --max-time 10 \
  -o /dev/null https://copilot.sg.superbrain-ai.com/
```

The bootstrap template serves only `/.well-known/acme-challenge/` and returns
404 for application paths. The production template keeps that challenge path
for renewal, redirects all other HTTP traffic to HTTPS, and proxies application
traffic only from its `listen 443 ssl http2` server. Never reload Nginx when
`nginx -t` fails. The final `curl` checks DNS and the public TLS handshake
without requiring the application to be running; HTTP error responses do not
fail that command because the first release does not exist yet.

## Release

Upload a fresh checkout to a new, explicit directory directly under
`/opt/superbrain-copilot/releases`. Use a release id made of letters, numbers,
periods, underscores, or hyphens, for example a UTC timestamp plus commit:

```bash
sudo -u deploy /opt/superbrain-copilot/releases/RELEASE_ID/scripts/deploy.sh \
  /opt/superbrain-copilot/releases/RELEASE_ID
```

The script installs from the frozen lockfile, runs the complete check, builds
the Node output, and only then atomically changes the `current` symlink. It
restarts only `superbrain-copilot.service`, verifies that `/api/health`
identifies the requested release, and requires `/api/ready` to return exactly
HTTP 200. A second deploy attempt fails before install, symlink, or service
side effects while another deploy process holds `/opt/superbrain-copilot/.deploy.lock`.

The production build reads `/etc/superbrain-copilot.env` as data, never as a
shell script. It requires a matching HTTPS `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_SUPABASE_PROJECT_ID`. Only those
three public values are passed to the final browser build. Install, checks, and
the final build do not receive `SUPABASE_SERVICE_ROLE_KEY`,
`WORKBUDDY_INGEST_SECRET`, `DEEPSEEK_API_KEY`, `AI_PROVIDER_API_KEY`,
`AI_PROVIDER_URL`, `AI_PROVIDER_MODEL`, or
`AI_PROVIDER_ENABLE_THINKING`; those remain runtime-only systemd environment
values.

### Trust boundary and path identity

`/opt/superbrain-copilot` and every release directory must be writable only by
the trusted `deploy` account (and root). The process lock serializes deployment
scripts using that account. After taking the lock, the script validates the
release as a direct, non-symlink child of `releases`, records its device/inode
identity, and opens it with `O_DIRECTORY|O_NOFOLLOW`. Install, check, build, and
release metadata writes stay anchored to that open directory even if its name
is replaced. The path and device/inode are checked again before `current` or
systemd can change.

This closes accidental and concurrent path-swap races; it does not make an
actively malicious root or `deploy` account untrusted. Those accounts can
replace application code or the service definition directly and remain inside
the deployment trust boundary.

After `scripts/deploy.sh` reports a successful release, run the public
post-deployment business contract:

```bash
scripts/healthcheck.sh https://copilot.sg.superbrain-ai.com
```

It requires exact status codes for process health (200), dependency readiness
(200), public MCP metadata (200), the OAuth-protected MCP tool listing (401
without credentials), and unauthenticated WorkBuddy ingest rejection (401).
The MCP 401 is accepted only when its `WWW-Authenticate` Bearer challenge points
back to this deployment's protected-resource metadata URL; an unauthenticated
200 tool listing is treated as an authentication regression.

## Automatic and manual rollback

If restart, release identity, health, or readiness verification fails, the
deploy script atomically restores the previous `current` symlink and restarts
the same service. Rollback is complete only after the previous release id
passes both health and readiness. On a first deployment with no previous
release, rollback must stop the service and verify it is inactive. Restart,
probe, stop, or inactive-verification failures are reported explicitly as
`rollback failed`; the script never claims that a failed rollback restored
service. It exits non-zero and leaves both the previous and failed release
directories intact.

For a manual rollback, run the same deploy script with the explicit path of a
known-good old release. The frozen checks and probes run again before it is
accepted. Releases are never deleted automatically.

Inspect only the new service when diagnosing a failure:

```bash
sudo systemctl status superbrain-copilot.service
sudo journalctl -u superbrain-copilot.service --no-pager -n 100
sudo ss -ltnp | grep '127.0.0.1:3410'
```
