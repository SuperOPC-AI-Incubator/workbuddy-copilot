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

Create `/etc/superbrain-copilot.env` directly on the server, owned by
`root:deploy` with mode `0640`. Populate the variables listed in
`.env.example`; do not copy the file back into Git or a release. The systemd
`ExecStart` command sets `HOST=127.0.0.1` and `PORT=3410` after every
EnvironmentFile has been read, so blank or conflicting `HOST`/`PORT` entries
cannot change the listener. Each immutable release also receives a non-secret
`.release.env` containing only its validated release id.

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
`WORKBUDDY_INGEST_SECRET`, or `DEEPSEEK_API_KEY`; those remain runtime-only
systemd environment values.

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
(200), MCP metadata and tool listing (200), and unauthenticated WorkBuddy
ingest rejection (401).

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
