#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/superbrain-copilot}"
SERVICE_NAME="superbrain-copilot.service"
HEALTH_BASE_URL="http://127.0.0.1:3410"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-/etc/superbrain-copilot.env}"
WAIT_ATTEMPTS="${DEPLOY_WAIT_ATTEMPTS:-30}"
WAIT_INTERVAL_SECONDS="${DEPLOY_WAIT_INTERVAL_SECONDS:-2}"
CURRENT_LINK="$APP_ROOT/current"
NEXT_LINK="$APP_ROOT/.current.next.$$"
LOCK_FILE="$APP_ROOT/.deploy.lock"
LOCK_ACQUIRED=0

fail() {
  printf 'deploy failed: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -L "$NEXT_LINK" ]]; then
    rm -f "$NEXT_LINK"
  fi
  if [[ "$LOCK_ACQUIRED" == "1" ]]; then
    flock -u 9 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if (($# != 1)); then
  fail "usage: scripts/deploy.sh /opt/superbrain-copilot/releases/RELEASE_ID"
fi

RELEASE_ARGUMENT="$1"
[[ -d "$APP_ROOT" ]] || fail "application root does not exist: $APP_ROOT"
command -v flock >/dev/null 2>&1 || fail "flock is not installed"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  fail "another deployment is already running"
fi
LOCK_ACQUIRED=1

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
[[ -x /usr/bin/python3 ]] || fail "/usr/bin/python3 is not installed"

release_identity() {
  /usr/bin/python3 - "$1" <<'PY'
import os
import stat
import sys

value = os.lstat(sys.argv[1])
if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
    raise SystemExit(1)
print(f"{value.st_dev}:{value.st_ino}")
PY
}

RELEASE_IDENTITY="$(release_identity "$RELEASE_DIR")" ||
  fail "release directory identity could not be fixed"

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  fail "$CURRENT_LINK must be a symlink"
fi

PREVIOUS_TARGET=""
PREVIOUS_RELEASE_ID=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$CURRENT_LINK")"
  PREVIOUS_RELEASE_ID="$(basename "$PREVIOUS_TARGET")"
fi

run_release_build() {
  /usr/bin/python3 - \
    "$RELEASE_DIR" "$RELEASE_IDENTITY" "$RELEASE_ID" "$DEPLOY_ENV_FILE" <<'PY'
import os
import re
import shlex
import stat
import subprocess
import sys
from urllib.parse import urlsplit

release_path, expected_identity, release_id, deploy_env_path = sys.argv[1:]
required_flags = ("O_DIRECTORY", "O_NOFOLLOW")
if any(not hasattr(os, name) for name in required_flags):
    raise SystemExit("directory identity flags are unavailable")

public_names = (
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_PROJECT_ID",
)
private_names = (
    "SUPABASE_SERVICE_ROLE_KEY",
    "WORKBUDDY_INGEST_SECRET",
    "DEEPSEEK_API_KEY",
)


def load_public_config(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    config_fd = os.open(path, flags)
    try:
        metadata = os.fstat(config_fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit("deployment environment must be a regular file")
        with os.fdopen(os.dup(config_fd), encoding="utf-8") as config_file:
            lines = config_file.readlines()
    finally:
        os.close(config_fd)

    values = {}
    for line_number, original in enumerate(lines, start=1):
        stripped = original.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, raw_value = original.partition("=")
        key = key.strip()
        if not separator:
            raise SystemExit(
                f"deployment environment line {line_number} is not an assignment"
            )
        if key not in public_names:
            continue
        if key in values:
            raise SystemExit(f"deployment environment repeats {key}")
        try:
            tokens = shlex.split(raw_value, comments=True, posix=True)
        except ValueError as error:
            raise SystemExit(
                f"deployment environment has invalid quoting for {key}"
            ) from error
        if len(tokens) != 1 or not tokens[0]:
            raise SystemExit(f"deployment environment has an invalid value for {key}")
        values[key] = tokens[0]

    missing = [name for name in public_names if not values.get(name)]
    if missing:
        raise SystemExit(
            "deployment environment is missing public build value(s): "
            + ", ".join(missing)
        )

    project_id = values["VITE_SUPABASE_PROJECT_ID"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,62}", project_id):
        raise SystemExit("VITE_SUPABASE_PROJECT_ID has an invalid format")

    public_url = urlsplit(values["VITE_SUPABASE_URL"])
    if (
        public_url.scheme != "https"
        or public_url.hostname != f"{project_id}.supabase.co"
        or public_url.username is not None
        or public_url.password is not None
        or public_url.port is not None
        or public_url.path not in ("", "/")
        or public_url.query
        or public_url.fragment
    ):
        raise SystemExit(
            "VITE_SUPABASE_URL must be the matching direct HTTPS Supabase project origin"
        )

    return values


public_config = load_public_config(deploy_env_path)
clean_environment = os.environ.copy()
for name in (*public_names, *private_names):
    clean_environment.pop(name, None)
build_environment = clean_environment | public_config

directory_fd = os.open(
    release_path,
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
)
try:
    opened = os.fstat(directory_fd)
    if f"{opened.st_dev}:{opened.st_ino}" != expected_identity:
        raise SystemExit("release directory identity changed before build")
    if not stat.S_ISDIR(opened.st_mode):
        raise SystemExit("release path is not a directory")

    os.fchdir(directory_fd)
    subprocess.run(
        ["bun", "install", "--frozen-lockfile"],
        check=True,
        env=clean_environment,
    )
    subprocess.run(["bun", "run", "check"], check=True, env=clean_environment)
    subprocess.run(["bun", "run", "build"], check=True, env=build_environment)

    if not os.path.isfile(".output/server/index.mjs"):
        raise SystemExit("build did not create .output/server/index.mjs")

    named = os.lstat(release_path)
    if (
        stat.S_ISLNK(named.st_mode)
        or not stat.S_ISDIR(named.st_mode)
        or f"{named.st_dev}:{named.st_ino}" != expected_identity
    ):
        raise SystemExit("release directory identity changed during build")

    temporary_name = f".release.env.{os.getpid()}"
    output_fd = os.open(
        temporary_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        os.write(output_fd, f"SUPERBRAIN_RELEASE_ID={release_id}\n".encode())
        os.fsync(output_fd)
    finally:
        os.close(output_fd)
    os.rename(
        temporary_name,
        ".release.env",
        src_dir_fd=directory_fd,
        dst_dir_fd=directory_fd,
    )
finally:
    os.close(directory_fd)
PY
}

revalidate_release_path() {
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || return 1
  local current_directory
  local current_identity
  current_directory="$(cd "$RELEASE_DIR" && pwd -P)" || return 1
  [[ "$current_directory" == "$RELEASE_DIR" ]] || return 1
  [[ "$(dirname "$current_directory")" == "$RELEASES_ROOT_REAL" ]] || return 1
  current_identity="$(release_identity "$current_directory")" || return 1
  [[ "$current_identity" == "$RELEASE_IDENTITY" ]]
}

run_release_build || fail "release build or identity verification failed"
revalidate_release_path ||
  fail "release path identity changed before publication"

atomic_set_current() {
  local target="$1"
  local expected_identity="${2:-}"
  rm -f "$NEXT_LINK" || return 1
  ln -s "$target" "$NEXT_LINK" || return 1
  /usr/bin/python3 - \
    "$APP_ROOT" "$NEXT_LINK" "$CURRENT_LINK" "$target" "$expected_identity" <<'PY'
import os
import sys

app_root, next_path, current_path, expected_target, expected_identity = sys.argv[1:]
if os.path.dirname(next_path) != app_root or os.path.dirname(current_path) != app_root:
    raise SystemExit("publication links must be direct children of the application root")

app_fd = os.open(app_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    next_name = os.path.basename(next_path)
    current_name = os.path.basename(current_path)
    if os.readlink(next_name, dir_fd=app_fd) != expected_target:
        raise SystemExit("publication symlink target changed")
    if expected_identity:
        target_fd = os.open(next_name, os.O_RDONLY | os.O_DIRECTORY, dir_fd=app_fd)
        try:
            target = os.fstat(target_fd)
            if f"{target.st_dev}:{target.st_ino}" != expected_identity:
                raise SystemExit("publication symlink does not resolve to pinned release")
        finally:
            os.close(target_fd)
    os.replace(
        next_name,
        current_name,
        src_dir_fd=app_fd,
        dst_dir_fd=app_fd,
    )
finally:
    os.close(app_fd)
PY
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
  local expected_release_id="$1"
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
  ' "$response_file" "$expected_release_id"; then
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"
}

wait_until_ready() {
  local expected_release_id="$1"
  local attempt=1
  while ((attempt <= WAIT_ATTEMPTS)); do
    if probe_expected_release "$expected_release_id" &&
      probe_exact_status "/api/ready" "200"; then
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
    printf 'verification failed; attempting previous release rollback\n' >&2
    if ! atomic_set_current "$PREVIOUS_TARGET"; then
      printf 'rollback failed: previous release symlink switch failed\n' >&2
      return 1
    fi
    if ! run_systemctl restart "$SERVICE_NAME"; then
      printf 'rollback failed: previous release restart failed\n' >&2
      return 1
    fi
    if ! wait_until_ready "$PREVIOUS_RELEASE_ID"; then
      printf 'rollback failed: previous release is not healthy and ready\n' >&2
      return 1
    fi
    printf 'rollback restored previous release %s\n' "$PREVIOUS_RELEASE_ID" >&2
  else
    printf 'verification failed; no previous release exists, stopping service\n' >&2
    if ! rm -f "$CURRENT_LINK"; then
      printf 'rollback failed: failed release symlink removal failed\n' >&2
      return 1
    fi
    if ! run_systemctl stop "$SERVICE_NAME"; then
      printf 'rollback failed: service stop failed\n' >&2
      return 1
    fi
    local active_status
    if run_systemctl is-active --quiet "$SERVICE_NAME"; then
      printf 'rollback failed: service remains active after stop\n' >&2
      return 1
    else
      active_status=$?
      if ((active_status != 3)); then
        printf 'rollback failed: service inactive state check failed with status %s\n' \
          "$active_status" >&2
        return 1
      fi
    fi
    printf 'rollback stopped the failed first release\n' >&2
  fi
  return 0
}

fail_after_rollback() {
  local reason="$1"
  if rollback; then
    fail "$reason; rollback completed"
  else
    fail "$reason; rollback failed"
  fi
}

atomic_set_current "$RELEASE_DIR" "$RELEASE_IDENTITY"
if ! run_systemctl restart "$SERVICE_NAME"; then
  fail_after_rollback "service restart failed"
fi
if ! wait_until_ready "$RELEASE_ID"; then
  fail_after_rollback \
    "release $RELEASE_ID did not pass health and readiness verification"
fi

printf 'deployed release %s\n' "$RELEASE_ID"
