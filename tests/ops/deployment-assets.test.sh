#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SCRIPT="$PROJECT_ROOT/scripts/deploy.sh"
HEALTHCHECK_SCRIPT="$PROJECT_ROOT/scripts/healthcheck.sh"
SERVICE_UNIT="$PROJECT_ROOT/deploy/systemd/superbrain-copilot.service"
NGINX_SITE="$PROJECT_ROOT/deploy/nginx/copilot.sg.superbrain-ai.com.conf"
NGINX_BOOTSTRAP_SITE="$PROJECT_ROOT/deploy/nginx/copilot.sg.superbrain-ai.com.bootstrap.conf"
ENV_EXAMPLE="$PROJECT_ROOT/.env.example"
TRACKED_ENV="$PROJECT_ROOT/.env"
DEPLOYMENT_DOC="$PROJECT_ROOT/docs/deployment.md"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -F -- "$expected" "$file" >/dev/null ||
    fail "$file does not contain: $expected"
}

assert_not_contains() {
  local file="$1"
  local forbidden="$2"
  if grep -F -- "$forbidden" "$file" >/dev/null; then
    fail "$file contains forbidden text: $forbidden"
  fi
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label: expected '$expected', got '$actual'"
}

make_fake_toolchain() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"

  cat >"$bin_dir/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun|%s|%s\n' "$PWD" "$*" >>"$OPS_LOG"
if [[ "$*" == "run build" ]]; then
  mkdir -p .output/server
  printf 'export default {};\n' >.output/server/index.mjs
fi
if [[ "$*" == "install --frozen-lockfile" && -n "${FAKE_BUN_BLOCK_STARTED:-}" ]]; then
  : >"$FAKE_BUN_BLOCK_STARTED"
  while [[ ! -e "${FAKE_BUN_BLOCK_RELEASE:?}" ]]; do
    sleep 0.02
  done
fi
if [[ "$*" == "install --frozen-lockfile" && "${FAKE_SWAP_ON_INSTALL:-0}" == "1" ]]; then
  /bin/mv "$FAKE_RELEASE_PATH" "$FAKE_RENAMED_RELEASE_PATH"
  /bin/ln -s "$FAKE_EXTERNAL_RELEASE_PATH" "$FAKE_RELEASE_PATH"
fi
EOF

  cat >"$bin_dir/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl|%s\n' "$*" >>"$OPS_LOG"
case "$*" in
  "restart superbrain-copilot.service")
    restart_count="$(grep -c '^systemctl|restart superbrain-copilot.service$' "$OPS_LOG")"
    if [[ "${FAKE_SYSTEMCTL_FAIL_RESTART_NUMBER:-0}" == "$restart_count" ]]; then
      exit 1
    fi
    ;;
  "stop superbrain-copilot.service")
    exit "${FAKE_SYSTEMCTL_STOP_STATUS:-0}"
    ;;
  "is-active --quiet superbrain-copilot.service")
    exit "${FAKE_SYSTEMCTL_IS_ACTIVE_STATUS:-3}"
    ;;
esac
EOF

  cat >"$bin_dir/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'mv|%s\n' "$*" >>"$OPS_LOG"
move_count="$(grep -c '^mv|' "$OPS_LOG")"
if [[ "${FAKE_MV_FAIL_NUMBER:-0}" == "$move_count" ]]; then
  exit 1
fi
exec /bin/mv "$@"
EOF

  cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
write_format=""
method="GET"
url=""

while (($#)); do
  case "$1" in
    -o|--output)
      output_file="$2"
      shift 2
      ;;
    -w|--write-out)
      write_format="$2"
      shift 2
      ;;
    -X|--request)
      method="$2"
      shift 2
      ;;
    --data|--data-raw|--data-binary|-d)
      shift 2
      ;;
    -H|--header|--connect-timeout|--max-time)
      shift 2
      ;;
    -s|-S|-sS|--silent|--show-error)
      shift
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

status="500"
body='{"error":"unexpected fake URL"}'
case "$url" in
  */api/health)
    status="${FAKE_HEALTH_STATUS:-200}"
    release_id="${FAKE_HEALTH_RELEASE_ID:-unknown}"
    if [[ "${FAKE_CURL_FROM_CURRENT:-0}" == "1" ]]; then
      current_release="$(basename "$(readlink "$APP_ROOT/current" 2>/dev/null || true)")"
      if [[ "$current_release" == "new-release" ]]; then
        release_id="${FAKE_NEW_HEALTH_RELEASE_ID:-new-release}"
      elif [[ "$current_release" == "old-release" ]]; then
        release_id="${FAKE_OLD_HEALTH_RELEASE_ID:-old-release}"
      fi
    fi
    body="{\"status\":\"ok\",\"release_id\":\"$release_id\"}"
    ;;
  */api/ready)
    status="${FAKE_READY_STATUS:-200}"
    if [[ "${FAKE_CURL_FROM_CURRENT:-0}" == "1" ]]; then
      current_release="$(basename "$(readlink "$APP_ROOT/current" 2>/dev/null || true)")"
      if [[ "$current_release" == "new-release" ]]; then
        status="${FAKE_NEW_READY_STATUS:-200}"
      elif [[ "$current_release" == "old-release" ]]; then
        status="${FAKE_OLD_READY_STATUS:-200}"
      fi
    fi
    body='{"status":"ready"}'
    ;;
  */.well-known/oauth-protected-resource)
    status="${FAKE_MCP_METADATA_STATUS:-200}"
    body='{"resource":"https://example.test/mcp"}'
    ;;
  */.mcp/list-tools)
    status="${FAKE_MCP_TOOLS_STATUS:-200}"
    body='{"tools":[]}'
    ;;
  */api/public/workbuddy/ingest)
    status="${FAKE_INGEST_STATUS:-401}"
    body='{"error":{"code":"UNAUTHORIZED"}}'
    ;;
esac

printf 'curl|%s|%s\n' "$method" "$url" >>"$OPS_LOG"
if [[ -n "$output_file" ]]; then
  printf '%s' "$body" >"$output_file"
else
  printf '%s' "$body"
fi
if [[ -n "$write_format" ]]; then
  printf '%s' "$status"
fi
EOF

  cat >"$bin_dir/flock" <<'EOF'
#!/usr/bin/env python3
import fcntl
import os
import sys

if sys.argv[1:] == ["-n", "9"]:
    try:
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(1)
    if os.environ.get("FAKE_SWAP_ON_FLOCK") == "1":
        os.rename(os.environ["FAKE_RELEASE_PATH"], os.environ["FAKE_RENAMED_RELEASE_PATH"])
        os.symlink(os.environ["FAKE_EXTERNAL_RELEASE_PATH"], os.environ["FAKE_RELEASE_PATH"])
elif sys.argv[1:] == ["-u", "9"]:
    fcntl.flock(9, fcntl.LOCK_UN)
else:
    raise SystemExit(2)
EOF

  cat >"$bin_dir/nginx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "-t" ]]
config="${FAKE_NGINX_CONFIG:?}"
case "${FAKE_NGINX_MODE:?}" in
  bootstrap)
    grep -F "listen 80;" "$config" >/dev/null
    grep -F "location ^~ /.well-known/acme-challenge/" "$config" >/dev/null
    ! grep -F "proxy_pass" "$config" >/dev/null
    ! grep -F "listen 443" "$config" >/dev/null
    ;;
  production)
    grep -F "listen 443 ssl http2;" "$config" >/dev/null
    grep -F "ssl_certificate /etc/letsencrypt/live/copilot.sg.superbrain-ai.com/fullchain.pem;" \
      "$config" >/dev/null
    grep -F 'return 301 https://$host$request_uri;' "$config" >/dev/null
    grep -F "proxy_pass http://127.0.0.1:3410;" "$config" >/dev/null
    ;;
  *)
    exit 2
    ;;
esac
EOF

  chmod +x "$bin_dir/bun" "$bin_dir/systemctl" "$bin_dir/mv" "$bin_dir/curl" \
    "$bin_dir/flock" "$bin_dir/nginx"
}

test_static_contracts() {
  [[ -f "$DEPLOY_SCRIPT" ]] || fail "missing deploy script"
  [[ -f "$HEALTHCHECK_SCRIPT" ]] || fail "missing healthcheck script"
  [[ -f "$SERVICE_UNIT" ]] || fail "missing systemd unit"
  [[ -f "$NGINX_SITE" ]] || fail "missing Nginx site"
  [[ -f "$NGINX_BOOTSTRAP_SITE" ]] || fail "missing Nginx ACME bootstrap site"
  [[ -f "$ENV_EXAMPLE" ]] || fail "missing environment example"
  [[ -f "$DEPLOYMENT_DOC" ]] || fail "missing deployment documentation"

  assert_contains "$SERVICE_UNIT" "User=deploy"
  assert_contains "$SERVICE_UNIT" "Group=deploy"
  assert_contains "$SERVICE_UNIT" "EnvironmentFile=/etc/superbrain-copilot.env"
  assert_contains "$SERVICE_UNIT" "EnvironmentFile=/opt/superbrain-copilot/current/.release.env"
  assert_not_contains "$SERVICE_UNIT" "Environment=HOST="
  assert_not_contains "$SERVICE_UNIT" "Environment=PORT="
  assert_contains "$SERVICE_UNIT" \
    "ExecStart=/usr/bin/env HOST=127.0.0.1 PORT=3410 /usr/bin/node /opt/superbrain-copilot/current/.output/server/index.mjs"
  assert_contains "$SERVICE_UNIT" "Restart=on-failure"
  assert_contains "$SERVICE_UNIT" "NoNewPrivileges=true"
  assert_contains "$SERVICE_UNIT" "ProtectSystem=strict"
  assert_contains "$SERVICE_UNIT" "ProtectHome=true"
  assert_not_contains "$SERVICE_UNIT" "8765"
  assert_not_contains "$SERVICE_UNIT" "workbuddy-copilot.service"

  assert_contains "$NGINX_SITE" "server_name copilot.sg.superbrain-ai.com;"
  assert_contains "$NGINX_SITE" "listen 443 ssl http2;"
  assert_contains "$NGINX_SITE" "listen [::]:443 ssl http2;"
  assert_contains "$NGINX_SITE" \
    "ssl_certificate /etc/letsencrypt/live/copilot.sg.superbrain-ai.com/fullchain.pem;"
  assert_contains "$NGINX_SITE" \
    "ssl_certificate_key /etc/letsencrypt/live/copilot.sg.superbrain-ai.com/privkey.pem;"
  assert_contains "$NGINX_SITE" "location ^~ /.well-known/acme-challenge/"
  assert_contains "$NGINX_SITE" 'return 301 https://$host$request_uri;'
  assert_contains "$NGINX_SITE" "proxy_pass http://127.0.0.1:3410;"
  assert_contains "$NGINX_SITE" 'proxy_set_header Upgrade $http_upgrade;'
  assert_contains "$NGINX_SITE" "proxy_buffering off;"
  assert_contains "$NGINX_SITE" "proxy_request_buffering off;"
  assert_contains "$NGINX_SITE" "proxy_read_timeout 3600s;"
  assert_not_contains "$NGINX_SITE" "8765"

  assert_contains "$NGINX_BOOTSTRAP_SITE" "listen 80;"
  assert_contains "$NGINX_BOOTSTRAP_SITE" \
    "location ^~ /.well-known/acme-challenge/"
  assert_contains "$NGINX_BOOTSTRAP_SITE" "try_files \$uri =404;"
  assert_not_contains "$NGINX_BOOTSTRAP_SITE" "proxy_pass"
  assert_not_contains "$NGINX_BOOTSTRAP_SITE" "127.0.0.1:3410"
  assert_not_contains "$NGINX_BOOTSTRAP_SITE" "listen 443"

  assert_contains "$DEPLOY_SCRIPT" '["bun", "install", "--frozen-lockfile"]'
  assert_contains "$DEPLOY_SCRIPT" '["bun", "run", "check"]'
  assert_contains "$DEPLOY_SCRIPT" '["bun", "run", "build"]'
  assert_not_contains "$DEPLOY_SCRIPT" "rm -rf"
  assert_not_contains "$DEPLOY_SCRIPT" "-delete"
  assert_not_contains "$DEPLOY_SCRIPT" "workbuddy-copilot.service"

  local expected_env
  expected_env=$'SUPABASE_URL=\nSUPABASE_PUBLISHABLE_KEY=\nSUPABASE_SERVICE_ROLE_KEY=\nVITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\nVITE_SUPABASE_PROJECT_ID=\nWORKBUDDY_INGEST_SECRET=\nDEEPSEEK_API_KEY=\nDOMAIN_PACK=\nPORT='
  assert_eq "$(cat "$ENV_EXAMPLE")" "$expected_env" ".env.example"

  assert_contains "$PROJECT_ROOT/.gitignore" ".env"
  assert_contains "$PROJECT_ROOT/.gitignore" ".env.*.local"
  assert_contains "$PROJECT_ROOT/.gitignore" "deploy/secrets/"
  assert_contains "$DEPLOYMENT_DOC" "Bun 1.3.10"
  assert_contains "$DEPLOYMENT_DOC" "127.0.0.1:3410"
  assert_contains "$DEPLOYMENT_DOC" "copilot.sg.superbrain-ai.com"
  assert_contains "$DEPLOYMENT_DOC" "workbuddy-copilot.service"
  assert_contains "$DEPLOYMENT_DOC" "8765"
  assert_contains "$DEPLOYMENT_DOC" "never"
  assert_contains "$DEPLOYMENT_DOC" "certbot certonly --webroot"
  assert_contains "$DEPLOYMENT_DOC" "Trust boundary"
  assert_contains "$DEPLOYMENT_DOC" "device/inode"
  assert_contains "$DEPLOYMENT_DOC" "rollback failed"
}

test_nginx_tls_lifecycle() {
  local test_root="$1"
  local fake_bin="$test_root/nginx-bin"
  make_fake_toolchain "$fake_bin"

  PATH="$fake_bin:$PATH" FAKE_NGINX_MODE=bootstrap \
    FAKE_NGINX_CONFIG="$NGINX_BOOTSTRAP_SITE" nginx -t ||
    fail "fake Nginx rejected the HTTP-only ACME bootstrap"
  PATH="$fake_bin:$PATH" FAKE_NGINX_MODE=production \
    FAKE_NGINX_CONFIG="$NGINX_SITE" nginx -t ||
    fail "fake Nginx rejected the production TLS and redirect contract"
}

test_systemd_binding_cannot_be_overridden() {
  local hostile_port
  for hostile_port in "" "9999"; do
    local observed
    observed="$(
      HOST="0.0.0.0" PORT="$hostile_port" \
        /usr/bin/env HOST=127.0.0.1 PORT=3410 \
        /bin/sh -c 'printf "%s|%s" "$HOST" "$PORT"'
    )"
    assert_eq "$observed" "127.0.0.1|3410" \
      "ExecStart binding with EnvironmentFile PORT='$hostile_port'"
  done
}

test_tracked_env_is_secret_free() {
  [[ -f "$TRACKED_ENV" ]] || fail "tracked .env must remain as a secret-free template"

  local line
  local key
  local value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "tracked .env contains a non-assignment line"
    key="${line%%=*}"
    value="${line#*=}"
    [[ -n "$key" ]] || fail "tracked .env contains an empty key"
    [[ -z "$value" ]] || fail "tracked .env contains a non-empty assignment for $key"
  done <"$TRACKED_ENV"
}

test_deploy_requires_explicit_release() {
  local test_root="$1"
  local ops_log="$test_root/no-release.log"
  : >"$ops_log"

  if APP_ROOT="$test_root/app root" OPS_LOG="$ops_log" DEPLOY_NO_SUDO=1 \
    "$DEPLOY_SCRIPT" >"$test_root/no-release.out" 2>&1; then
    fail "deploy accepted a missing release directory"
  fi
  [[ ! -s "$ops_log" ]] || fail "deploy ran commands before validating the release"
}

test_successful_atomic_deploy_with_quoted_paths() {
  local test_root="$1"
  local app_root="$test_root/app root"
  local old_release="$app_root/releases/old-release"
  local new_release="$app_root/releases/new-release"
  local new_release_real
  local fake_bin="$test_root/fake bin"
  local ops_log="$test_root/success.log"

  mkdir -p "$old_release/.output/server" "$new_release"
  printf '{}\n' >"$new_release/package.json"
  printf 'old\n' >"$old_release/.output/server/index.mjs"
  ln -s "$old_release" "$app_root/current"
  : >"$ops_log"
  make_fake_toolchain "$fake_bin"
  new_release_real="$(cd "$new_release" && pwd -P)"

  PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
    DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
    FAKE_HEALTH_RELEASE_ID="new-release" \
    "$DEPLOY_SCRIPT" "$new_release"

  assert_eq "$(readlink "$app_root/current")" "$new_release_real" \
    "current release symlink"
  assert_eq "$(cat "$new_release/.release.env")" \
    "SUPERBRAIN_RELEASE_ID=new-release" "release environment"
  assert_contains "$ops_log" "bun|$new_release_real|install --frozen-lockfile"
  assert_contains "$ops_log" "bun|$new_release_real|run check"
  assert_contains "$ops_log" "bun|$new_release_real|run build"
  assert_eq "$(grep -c '^systemctl|' "$ops_log")" "1" "successful restart count"
  assert_contains "$ops_log" "systemctl|restart superbrain-copilot.service"
  [[ -d "$old_release" ]] || fail "successful deployment deleted the old release"
  [[ -d "$new_release" ]] || fail "successful deployment deleted the new release"
}

test_failed_verification_rolls_back_without_deleting_releases() {
  local test_root="$1"
  local app_root="$test_root/rollback app"
  local old_release="$app_root/releases/old-release"
  local new_release="$app_root/releases/new-release"
  local fake_bin="$test_root/rollback-bin"
  local ops_log="$test_root/rollback.log"

  mkdir -p "$old_release/.output/server" "$new_release"
  printf '{}\n' >"$new_release/package.json"
  printf 'old\n' >"$old_release/.output/server/index.mjs"
  ln -s "$old_release" "$app_root/current"
  : >"$ops_log"
  make_fake_toolchain "$fake_bin"

  if PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
    DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
    FAKE_CURL_FROM_CURRENT=1 FAKE_NEW_HEALTH_RELEASE_ID="wrong-release" \
    "$DEPLOY_SCRIPT" "$new_release"; then
    fail "deploy accepted a 200 health response from the wrong release"
  fi

  assert_eq "$(readlink "$app_root/current")" "$old_release" "rolled back release symlink"
  assert_eq "$(grep -c '^systemctl|' "$ops_log")" "2" "rollback restart count"
  if grep '^systemctl|' "$ops_log" | grep -Fv \
    "systemctl|restart superbrain-copilot.service" >/dev/null; then
    fail "deploy restarted a service outside superbrain-copilot.service"
  fi
  [[ -d "$old_release" ]] || fail "rollback deleted the old release"
  [[ -d "$new_release" ]] || fail "rollback deleted the failed release"
}

test_deploy_requires_exact_ready_status() {
  local test_root="$1"
  local app_root="$test_root/status app"
  local old_release="$app_root/releases/old-release"
  local new_release="$app_root/releases/new-release"
  local fake_bin="$test_root/status-bin"
  local ops_log="$test_root/status.log"

  mkdir -p "$old_release/.output/server" "$new_release"
  printf '{}\n' >"$new_release/package.json"
  printf 'old\n' >"$old_release/.output/server/index.mjs"
  ln -s "$old_release" "$app_root/current"
  : >"$ops_log"
  make_fake_toolchain "$fake_bin"

  if PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
    DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
    FAKE_CURL_FROM_CURRENT=1 FAKE_NEW_READY_STATUS=204 \
    "$DEPLOY_SCRIPT" "$new_release"; then
    fail "deploy accepted readiness status 204 instead of exactly 200"
  fi
  assert_eq "$(readlink "$app_root/current")" "$old_release" \
    "status failure rollback symlink"
}

make_deploy_fixture() {
  local test_root="$1"
  local app_root="$2"
  local old_release="$app_root/releases/old-release"
  local new_release="$app_root/releases/new-release"
  local fake_bin="$test_root/fake-bin"

  mkdir -p "$old_release/.output/server" "$new_release"
  printf '{}\n' >"$new_release/package.json"
  printf 'old\n' >"$old_release/.output/server/index.mjs"
  ln -s "$old_release" "$app_root/current"
  make_fake_toolchain "$fake_bin"
}

test_rollback_failures_are_never_reported_as_restored() {
  local test_root="$1"
  local scenario
  for scenario in restart-fails old-not-ready symlink-fails; do
    local case_root="$test_root/rollback-$scenario"
    local app_root="$case_root/app"
    local new_release="$app_root/releases/new-release"
    local fake_bin="$case_root/fake-bin"
    local ops_log="$case_root/ops.log"
    mkdir -p "$case_root"
    make_deploy_fixture "$case_root" "$app_root"
    : >"$ops_log"

    local -a scenario_env=()
    if [[ "$scenario" == "restart-fails" ]]; then
      scenario_env+=(FAKE_SYSTEMCTL_FAIL_RESTART_NUMBER=2)
    elif [[ "$scenario" == "old-not-ready" ]]; then
      scenario_env+=(FAKE_OLD_READY_STATUS=503)
    else
      scenario_env+=(FAKE_MV_FAIL_NUMBER=2 FAKE_NEW_HEALTH_RELEASE_ID=old-release)
    fi

    set +e
    env PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
      DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
      FAKE_CURL_FROM_CURRENT=1 FAKE_NEW_HEALTH_RELEASE_ID=wrong-release \
      "${scenario_env[@]}" \
      "$DEPLOY_SCRIPT" "$new_release" >"$case_root/deploy.out" 2>&1
    local deploy_status=$?
    set -e

    [[ "$deploy_status" -ne 0 ]] || fail "$scenario rollback unexpectedly succeeded"
    assert_contains "$case_root/deploy.out" "rollback failed"
    assert_not_contains "$case_root/deploy.out" "restored previous release"
  done
}

test_first_deploy_requires_stop_and_inactive_service() {
  local test_root="$1"
  local scenario
  for scenario in stop-fails still-active; do
    local case_root="$test_root/first-$scenario"
    local app_root="$case_root/app"
    local new_release="$app_root/releases/new-release"
    local fake_bin="$case_root/fake-bin"
    local ops_log="$case_root/ops.log"
    mkdir -p "$new_release" "$case_root"
    printf '{}\n' >"$new_release/package.json"
    make_fake_toolchain "$fake_bin"
    : >"$ops_log"

    local -a scenario_env=()
    if [[ "$scenario" == "stop-fails" ]]; then
      scenario_env+=(FAKE_SYSTEMCTL_STOP_STATUS=1)
    else
      scenario_env+=(FAKE_SYSTEMCTL_IS_ACTIVE_STATUS=0)
    fi

    set +e
    env PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
      DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
      FAKE_HEALTH_RELEASE_ID=wrong-release "${scenario_env[@]}" \
      "$DEPLOY_SCRIPT" "$new_release" >"$case_root/deploy.out" 2>&1
    local deploy_status=$?
    set -e

    [[ "$deploy_status" -ne 0 ]] || fail "$scenario first deployment unexpectedly succeeded"
    assert_contains "$case_root/deploy.out" "rollback failed"
    assert_contains "$ops_log" "systemctl|stop superbrain-copilot.service"
    assert_not_contains "$case_root/deploy.out" "restored"
    if [[ "$scenario" == "still-active" ]]; then
      assert_contains "$ops_log" "systemctl|is-active --quiet superbrain-copilot.service"
    fi
  done
}

test_release_path_swap_fails_before_external_write_or_publish() {
  local test_root="$1"
  local attack_phase
  for attack_phase in flock install; do
    local case_root="$test_root/swap-$attack_phase"
    local app_root="$case_root/app"
    local old_release="$app_root/releases/old-release"
    local new_release="$app_root/releases/new-release"
    local renamed_release="$app_root/releases/new-release-original"
    local external_release="$case_root/external"
    local fake_bin="$case_root/fake-bin"
    local ops_log="$case_root/ops.log"
    mkdir -p "$external_release" "$case_root"
    make_deploy_fixture "$case_root" "$app_root"
    : >"$ops_log"

    local -a attack_env=(
      FAKE_RELEASE_PATH="$new_release"
      FAKE_RENAMED_RELEASE_PATH="$renamed_release"
      FAKE_EXTERNAL_RELEASE_PATH="$external_release"
    )
    if [[ "$attack_phase" == "flock" ]]; then
      attack_env+=(FAKE_SWAP_ON_FLOCK=1)
    else
      attack_env+=(FAKE_SWAP_ON_INSTALL=1)
    fi

    set +e
    env PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
      DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
      FAKE_HEALTH_RELEASE_ID=new-release "${attack_env[@]}" \
      "$DEPLOY_SCRIPT" "$new_release" >"$case_root/deploy.out" 2>&1
    local deploy_status=$?
    set -e

    [[ "$deploy_status" -ne 0 ]] ||
      fail "$attack_phase path replacement was published"
    [[ ! -e "$external_release/.output" ]] ||
      fail "$attack_phase path replacement wrote .output outside the release root"
    [[ ! -e "$external_release/.release.env" ]] ||
      fail "$attack_phase path replacement wrote .release.env outside the release root"
    assert_eq "$(readlink "$app_root/current")" "$old_release" \
      "$attack_phase path replacement current symlink"
    if grep -q '^systemctl|' "$ops_log"; then
      fail "$attack_phase path replacement restarted or stopped a service"
    fi
  done
}

test_concurrent_deploy_fails_before_side_effects_and_releases_lock() {
  local test_root="$1"
  local app_root="$test_root/concurrent app"
  local old_release="$app_root/releases/old-release"
  local new_release="$app_root/releases/new-release"
  local fake_bin="$test_root/concurrent-bin"
  local ops_log="$test_root/concurrent.log"
  local first_started="$test_root/first-install-started"
  local release_first="$test_root/release-first-install"
  local first_pid

  mkdir -p "$old_release/.output/server" "$new_release"
  printf '{}\n' >"$new_release/package.json"
  printf 'old\n' >"$old_release/.output/server/index.mjs"
  ln -s "$old_release" "$app_root/current"
  : >"$ops_log"
  make_fake_toolchain "$fake_bin"

  PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
    DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
    FAKE_HEALTH_RELEASE_ID="new-release" \
    FAKE_BUN_BLOCK_STARTED="$first_started" FAKE_BUN_BLOCK_RELEASE="$release_first" \
    "$DEPLOY_SCRIPT" "$new_release" >"$test_root/first-deploy.out" 2>&1 &
  first_pid=$!

  local attempts=0
  while [[ ! -e "$first_started" && "$attempts" -lt 100 ]]; do
    sleep 0.02
    attempts=$((attempts + 1))
  done
  if [[ ! -e "$first_started" ]]; then
    : >"$release_first"
    wait "$first_pid" || true
    fail "first deployment never reached its install step"
  fi

  local side_effect_count_before
  side_effect_count_before="$(grep -Ec '^(bun|systemctl)\|' "$ops_log" || true)"
  set +e
  PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
    DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
    FAKE_HEALTH_RELEASE_ID="new-release" \
    "$DEPLOY_SCRIPT" "$new_release" >"$test_root/second-deploy.out" 2>&1
  local second_status=$?
  set -e
  local side_effect_count_after
  side_effect_count_after="$(grep -Ec '^(bun|systemctl)\|' "$ops_log" || true)"

  : >"$release_first"
  wait "$first_pid"

  [[ "$second_status" -ne 0 ]] ||
    fail "a concurrent deployment was allowed to install or publish"
  assert_eq "$side_effect_count_after" "$side_effect_count_before" \
    "concurrent deployment side-effect count"
  assert_contains "$test_root/second-deploy.out" "another deployment is already running"

  PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" APP_ROOT="$app_root" \
    DEPLOY_NO_SUDO=1 DEPLOY_WAIT_ATTEMPTS=1 DEPLOY_WAIT_INTERVAL_SECONDS=0 \
    FAKE_HEALTH_RELEASE_ID="new-release" \
    "$DEPLOY_SCRIPT" "$new_release" >"$test_root/third-deploy.out" 2>&1 ||
    fail "deployment lock was not released by the exit trap"
}

test_healthcheck_exact_status_contract() {
  local test_root="$1"
  local fake_bin="$test_root/health-bin"
  local ops_log="$test_root/health.log"
  make_fake_toolchain "$fake_bin"
  : >"$ops_log"

  PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" \
    "$HEALTHCHECK_SCRIPT" "https://copilot.example.test"

  assert_contains "$ops_log" "curl|GET|https://copilot.example.test/api/health"
  assert_contains "$ops_log" "curl|GET|https://copilot.example.test/api/ready"
  assert_contains "$ops_log" \
    "curl|GET|https://copilot.example.test/.well-known/oauth-protected-resource"
  assert_contains "$ops_log" "curl|GET|https://copilot.example.test/.mcp/list-tools"
  assert_contains "$ops_log" \
    "curl|POST|https://copilot.example.test/api/public/workbuddy/ingest"

  if PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" FAKE_INGEST_STATUS=403 \
    "$HEALTHCHECK_SCRIPT" "https://copilot.example.test"; then
    fail "healthcheck accepted ingest status 403 instead of exactly 401"
  fi

  if PATH="$fake_bin:$PATH" OPS_LOG="$ops_log" FAKE_HEALTH_STATUS=204 \
    "$HEALTHCHECK_SCRIPT" "https://copilot.example.test"; then
    fail "healthcheck accepted health status 204 instead of exactly 200"
  fi
}

main() {
  TEST_ROOT="$(mktemp -d)"
  trap 'rm -rf "$TEST_ROOT"' EXIT

  if [[ "${1:-}" == "concurrency" ]]; then
    test_concurrent_deploy_fails_before_side_effects_and_releases_lock "$TEST_ROOT"
    printf 'deployment concurrency test passed\n'
    return
  fi
  if [[ "${1:-}" == "tls" ]]; then
    test_static_contracts
    test_nginx_tls_lifecycle "$TEST_ROOT"
    printf 'nginx TLS lifecycle test passed\n'
    return
  fi
  if [[ "${1:-}" == "rollback" ]]; then
    test_rollback_failures_are_never_reported_as_restored "$TEST_ROOT"
    test_first_deploy_requires_stop_and_inactive_service "$TEST_ROOT"
    printf 'deployment rollback failure tests passed\n'
    return
  fi
  if [[ "${1:-}" == "toctou" ]]; then
    test_release_path_swap_fails_before_external_write_or_publish "$TEST_ROOT"
    printf 'deployment path identity tests passed\n'
    return
  fi

  test_tracked_env_is_secret_free
  test_static_contracts
  test_systemd_binding_cannot_be_overridden
  test_nginx_tls_lifecycle "$TEST_ROOT"

  test_deploy_requires_explicit_release "$TEST_ROOT"
  test_successful_atomic_deploy_with_quoted_paths "$TEST_ROOT"
  test_failed_verification_rolls_back_without_deleting_releases "$TEST_ROOT"
  test_deploy_requires_exact_ready_status "$TEST_ROOT"
  test_rollback_failures_are_never_reported_as_restored "$TEST_ROOT"
  test_first_deploy_requires_stop_and_inactive_service "$TEST_ROOT"
  test_release_path_swap_fails_before_external_write_or_publish "$TEST_ROOT"
  test_concurrent_deploy_fails_before_side_effects_and_releases_lock "$TEST_ROOT"
  test_healthcheck_exact_status_contract "$TEST_ROOT"
  printf 'deployment asset tests passed\n'
}

main "$@"
