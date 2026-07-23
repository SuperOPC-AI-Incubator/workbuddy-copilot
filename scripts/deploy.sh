#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/superbrain-copilot}"
SERVICE_NAME="superbrain-copilot.service"
HEALTH_BASE_URL="http://127.0.0.1:3410"
WAIT_ATTEMPTS="${DEPLOY_WAIT_ATTEMPTS:-30}"
WAIT_INTERVAL_SECONDS="${DEPLOY_WAIT_INTERVAL_SECONDS:-2}"
CURRENT_LINK="$APP_ROOT/current"
NEXT_LINK="$APP_ROOT/.current.next.$$"

fail() {
  printf 'deploy failed: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -L "$NEXT_LINK" ]]; then
    rm -f "$NEXT_LINK"
  fi
}
trap cleanup EXIT INT TERM

if (($# != 1)); then
  fail "usage: scripts/deploy.sh /opt/superbrain-copilot/releases/RELEASE_ID"
fi

RELEASE_ARGUMENT="$1"
[[ "$RELEASE_ARGUMENT" == /* ]] || fail "release directory must be an absolute path"
[[ -d "$APP_ROOT/releases" ]] || fail "release root does not exist: $APP_ROOT/releases"
[[ -d "$RELEASE_ARGUMENT" ]] || fail "release directory does not exist"
[[ ! -L "$RELEASE_ARGUMENT" ]] || fail "release directory must not be a symlink"

APP_ROOT_REAL="$(cd "$APP_ROOT" && pwd -P)"
RELEASES_ROOT_REAL="$(cd "$APP_ROOT/releases" && pwd -P)"
RELEASE_DIR="$(cd "$RELEASE_ARGUMENT" && pwd -P)"
[[ "$(dirname "$RELEASE_DIR")" == "$RELEASES_ROOT_REAL" ]] ||
  fail "release directory must be a direct child of $RELEASES_ROOT_REAL"
[[ "$RELEASE_DIR" != "$APP_ROOT_REAL" ]] || fail "application root is not a release"

RELEASE_ID="$(basename "$RELEASE_DIR")"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
  fail "release id contains unsupported characters"
[[ -f "$RELEASE_DIR/package.json" ]] || fail "release is missing package.json"
[[ "$WAIT_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] && ((WAIT_ATTEMPTS <= 120)) ||
  fail "DEPLOY_WAIT_ATTEMPTS must be an integer from 1 to 120"
[[ "$WAIT_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] && ((WAIT_INTERVAL_SECONDS <= 30)) ||
  fail "DEPLOY_WAIT_INTERVAL_SECONDS must be an integer from 0 to 30"
command -v bun >/dev/null 2>&1 || fail "Bun is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed"

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  fail "$CURRENT_LINK must be a symlink"
fi

PREVIOUS_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$CURRENT_LINK")"
fi

(
  cd "$RELEASE_DIR"
  bun install --frozen-lockfile
  bun run check
  bun run build
)
[[ -f "$RELEASE_DIR/.output/server/index.mjs" ]] ||
  fail "build did not create .output/server/index.mjs"

RELEASE_ENV_TEMP="$RELEASE_DIR/.release.env.$$"
(
  umask 077
  printf 'SUPERBRAIN_RELEASE_ID=%s\n' "$RELEASE_ID" >"$RELEASE_ENV_TEMP"
)
mv -f "$RELEASE_ENV_TEMP" "$RELEASE_DIR/.release.env"

atomic_set_current() {
  local target="$1"
  rm -f "$NEXT_LINK"
  ln -s "$target" "$NEXT_LINK"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    mv -hf "$NEXT_LINK" "$CURRENT_LINK"
  else
    mv -Tf "$NEXT_LINK" "$CURRENT_LINK"
  fi
}

run_systemctl() {
  if [[ "${DEPLOY_NO_SUDO:-0}" == "1" ]]; then
    systemctl "$@"
  else
    sudo systemctl "$@"
  fi
}

probe_exact_status() {
  local path="$1"
  local expected_status="$2"
  local response_file
  local actual_status
  response_file="$(mktemp)"
  if ! actual_status="$(
    curl --noproxy '*' -sS --connect-timeout 2 --max-time 5 \
      -o "$response_file" -w '%{http_code}' "${HEALTH_BASE_URL%/}$path"
  )"; then
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"
  [[ "$actual_status" == "$expected_status" ]]
}

probe_expected_release() {
  local response_file
  local actual_status
  response_file="$(mktemp)"
  if ! actual_status="$(
    curl --noproxy '*' -sS --connect-timeout 2 --max-time 5 \
      -o "$response_file" -w '%{http_code}' "${HEALTH_BASE_URL%/}/api/health"
  )"; then
    rm -f "$response_file"
    return 1
  fi
  if [[ "$actual_status" != "200" ]]; then
    rm -f "$response_file"
    return 1
  fi
  if ! node -e '
    const fs = require("node:fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (body.status !== "ok" || body.release_id !== process.argv[2]) process.exit(1);
  ' "$response_file" "$RELEASE_ID"; then
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"
}

wait_until_ready() {
  local attempt=1
  while ((attempt <= WAIT_ATTEMPTS)); do
    if probe_expected_release && probe_exact_status "/api/ready" "200"; then
      return 0
    fi
    if ((attempt < WAIT_ATTEMPTS)); then
      sleep "$WAIT_INTERVAL_SECONDS"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

rollback() {
  if [[ -n "$PREVIOUS_TARGET" ]]; then
    printf 'verification failed; restoring previous release\n' >&2
    atomic_set_current "$PREVIOUS_TARGET"
    run_systemctl restart "$SERVICE_NAME" || true
  else
    printf 'verification failed; no previous release exists, stopping service\n' >&2
    rm -f "$CURRENT_LINK"
    run_systemctl stop "$SERVICE_NAME" || true
  fi
}

atomic_set_current "$RELEASE_DIR"
if ! run_systemctl restart "$SERVICE_NAME"; then
  rollback
  fail "service restart failed and the previous release was restored"
fi
if ! wait_until_ready; then
  rollback
  fail "release $RELEASE_ID did not pass health and readiness verification"
fi

printf 'deployed release %s\n' "$RELEASE_ID"
