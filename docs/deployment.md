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
3. Create `/opt/superbrain-copilot/releases` owned by `deploy:deploy`. Keep
   every release directory after deployment; cleanup is a separate, reviewed
   operation.
4. Install the systemd and Nginx templates from `deploy/`. Validate Nginx with
   `sudo nginx -t` before reloading it.
5. Obtain a TLS certificate for `copilot.sg.superbrain-ai.com` and redirect
   HTTP to HTTPS after the initial ACME challenge succeeds.

The site template preserves WebSocket upgrades and disables response/request
buffering so MCP and server-sent event streams are not delayed.

## External environment

Both the tracked `.env` and `.env.example` are deliberately empty-value
templates. They are not deployment configuration and must remain secret-free.

Create `/etc/superbrain-copilot.env` directly on the server, owned by
`root:deploy` with mode `0640`. Populate the variables listed in
`.env.example`; do not copy the file back into Git or a release. The service
adds `HOST=127.0.0.1` and `PORT=3410`. Each immutable release also receives a
non-secret `.release.env` containing only its validated release id.

## First-time service setup

```bash
sudo install -m 0644 deploy/systemd/superbrain-copilot.service \
  /etc/systemd/system/superbrain-copilot.service
sudo install -m 0644 deploy/nginx/copilot.sg.superbrain-ai.com.conf \
  /etc/nginx/sites-available/copilot.sg.superbrain-ai.com.conf
sudo ln -s /etc/nginx/sites-available/copilot.sg.superbrain-ai.com.conf \
  /etc/nginx/sites-enabled/copilot.sg.superbrain-ai.com.conf
sudo systemctl daemon-reload
sudo systemctl enable superbrain-copilot.service
sudo nginx -t
sudo systemctl reload nginx
```

Grant the `deploy` user narrowly scoped permission to restart and stop only
`superbrain-copilot.service`. Do not grant permission for
`workbuddy-copilot.service`.

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
HTTP 200.

Run the public post-deployment contract after TLS is active:

```bash
scripts/healthcheck.sh https://copilot.sg.superbrain-ai.com
```

It requires exact status codes for process health (200), dependency readiness
(200), MCP metadata and tool listing (200), and unauthenticated WorkBuddy
ingest rejection (401).

## Automatic and manual rollback

If restart, release identity, health, or readiness verification fails, the
deploy script atomically restores the previous `current` symlink and restarts
the same service. It exits non-zero and leaves both the previous and failed
release directories intact.

For a manual rollback, run the same deploy script with the explicit path of a
known-good old release. The frozen checks and probes run again before it is
accepted. Releases are never deleted automatically.

Inspect only the new service when diagnosing a failure:

```bash
sudo systemctl status superbrain-copilot.service
sudo journalctl -u superbrain-copilot.service --no-pager -n 100
sudo ss -ltnp | grep '127.0.0.1:3410'
```
