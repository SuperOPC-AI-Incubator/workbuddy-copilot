#!/usr/bin/env bash
#
# Free-plan Supabase maintenance for the superbrain-copilot project.
#
#   keepalive   Send one small database request so the project is not paused.
#   backup      pg_dump public + auth into a single latest-only compressed archive.
#
# Why both, on different schedules: Supabase pauses Free-plan projects that show low
# activity over a 7-day window, and its own guidance is "a few user requests to the
# database each day". A weekly backup alone sits exactly on that threshold, so keepalive
# runs daily and backup runs weekly. Free-plan projects have no automatic backups and no
# point-in-time recovery, which is why this dump exists at all.
#
# Credentials are never passed on the command line. keepalive reuses the deployment's
# existing publishable key; backup reads standard libpq PG* variables from a separate
# root-only file, so pg_dump picks the connection up from the environment and nothing
# secret appears in `ps` output.
set -euo pipefail

APP_ENV_FILE=${APP_ENV_FILE:-/etc/superbrain-copilot.env}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/superbrain-copilot-backup.env}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/superbrain-copilot}
BACKUP_NAME=${BACKUP_NAME:-superbrain-copilot-latest.sql.gz}
BACKUP_SCHEMAS=${BACKUP_SCHEMAS:-public auth}
MIN_BACKUP_BYTES=${MIN_BACKUP_BYTES:-20000}
# pg_dump runs with --quote-all-identifiers, so these appear verbatim in a healthy dump.
DEFAULT_MARKERS='"public"."students" "public"."timeline_items" "auth"."users"'
REQUIRED_MARKERS=${REQUIRED_MARKERS:-$DEFAULT_MARKERS}
CURL_TIMEOUT=${CURL_TIMEOUT:-30}

log() {
  printf '%s [supabase-maintenance] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "FAIL: $*"
  exit 1
}

# libpq error text can carry the host and user; keep any credential out of the log.
redact() {
  sed -E \
    -e 's#(postgres(ql)?://[^:[:space:]/@]+):[^@[:space:]]+@#\1:[REDACTED]@#g' \
    -e 's#(password[[:space:]]*=[[:space:]]*)[^[:space:]]+#\1[REDACTED]#gI'
}

require_file() {
  [[ -r "$1" ]] || die "cannot read $1"
}

keepalive() {
  require_file "$APP_ENV_FILE"
  # Subshell so the deployment's other secrets never outlive the request.
  local status
  status=$(
    set -a
    # shellcheck disable=SC1090
    . "$APP_ENV_FILE"
    set +a
    [[ -n "${SUPABASE_URL:-}" ]] || exit 64
    [[ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ]] || exit 65
    curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      -H "apikey: ${SUPABASE_PUBLISHABLE_KEY}" \
      "${SUPABASE_URL}/rest/v1/students?select=id&limit=1"
  ) || {
    local rc=$?
    case "$rc" in
      64) die "$APP_ENV_FILE does not define SUPABASE_URL" ;;
      65) die "$APP_ENV_FILE does not define SUPABASE_PUBLISHABLE_KEY" ;;
      *) die "keepalive request could not be sent (exit $rc)" ;;
    esac
  }

  # Row-level security denies anonymous reads, so an empty result is expected. What matters
  # is that PostgREST evaluated the policy against the database, which is the activity
  # Supabase measures. A non-2xx status means the request never reached that point.
  [[ "$status" =~ ^2[0-9][0-9]$ ]] || die "keepalive request returned HTTP $status"
  log "keepalive ok (HTTP $status)"
}

require_matching_pg_dump() {
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump is not installed"
  local version major
  version=$(pg_dump --version | grep -oE '[0-9]+(\.[0-9]+)*' | head -1)
  major=${version%%.*}
  # pg_dump refuses to dump a newer server outright, so check before spending a run on it.
  # The tracked project runs PostgreSQL 17; Ubuntu 24.04 ships the 16 client by default.
  [[ -n "$major" && "$major" -ge 17 ]] ||
    die "pg_dump $version is older than the PostgreSQL 17 server; install postgresql-client-17"
}

require_backup_env() {
  require_file "$BACKUP_ENV_FILE"
  # Validate before creating directories or spending a dump, so a misconfigured file reports
  # the missing variable instead of whatever the next command happens to complain about.
  (
    set -a
    # shellcheck disable=SC1090
    . "$BACKUP_ENV_FILE"
    set +a
    [[ -n "${PGHOST:-}" && -n "${PGUSER:-}" && -n "${PGPASSWORD:-}" && -n "${PGDATABASE:-}" ]]
  ) ||
    die "$BACKUP_ENV_FILE must define PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE"
}

backup() {
  require_matching_pg_dump
  require_backup_env

  local schema_args=()
  local schema
  for schema in $BACKUP_SCHEMAS; do
    schema_args+=("--schema=$schema")
  done

  mkdir -p "$BACKUP_DIR"
  local plain gz
  plain=$(mktemp "${TMPDIR:-/tmp}/superbrain-copilot-dump.XXXXXX")
  gz="${plain}.gz"
  # shellcheck disable=SC2064
  trap "rm -f '$plain' '$gz'" EXIT

  local dump_status=0
  (
    set -a
    # shellcheck disable=SC1090
    . "$BACKUP_ENV_FILE"
    set +a
    [[ -n "${PGHOST:-}" && -n "${PGUSER:-}" && -n "${PGPASSWORD:-}" && -n "${PGDATABASE:-}" ]] ||
      exit 64
    export PGSSLMODE="${PGSSLMODE:-require}"
    # No connection string in argv: pg_dump reads PG* from this subshell's environment.
    pg_dump \
      "${schema_args[@]}" \
      --no-owner \
      --no-privileges \
      --clean \
      --if-exists \
      --quote-all-identifiers
  ) >"$plain" 2> >(redact >&2) || dump_status=$?

  if ((dump_status == 64)); then
    die "$BACKUP_ENV_FILE must define PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE"
  fi
  if ((dump_status != 0)); then
    die "pg_dump exited $dump_status; if it was a permission error on the auth schema, retry with BACKUP_SCHEMAS=public"
  fi

  # Verify before replacing the only retained copy. Overwriting a good backup with a
  # truncated or empty dump is the failure this ordering exists to prevent.
  local bytes
  bytes=$(wc -c <"$plain" | tr -d ' ')
  ((bytes >= MIN_BACKUP_BYTES)) ||
    die "dump is only $bytes bytes, below the $MIN_BACKUP_BYTES byte floor"

  local marker
  for marker in $REQUIRED_MARKERS; do
    grep -qF -- "$marker" "$plain" ||
      die "dump does not mention $marker; refusing to replace the retained backup"
  done

  gzip -9 -c "$plain" >"$gz"
  local gz_bytes
  gz_bytes=$(wc -c <"$gz" | tr -d ' ')

  # Same filesystem as the target, so the replacement is atomic.
  local target="$BACKUP_DIR/$BACKUP_NAME"
  local staged="$target.staging"
  cp "$gz" "$staged"
  chmod 600 "$staged"
  mv -f "$staged" "$target"

  {
    printf 'completed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'schemas=%s\n' "$BACKUP_SCHEMAS"
    printf 'plain_bytes=%s\n' "$bytes"
    printf 'gzip_bytes=%s\n' "$gz_bytes"
    printf 'verified_markers=%s\n' "$REQUIRED_MARKERS"
  } >"$target.info"
  chmod 644 "$target.info"

  log "backup ok ($bytes bytes plain, $gz_bytes bytes gzip) -> $target"
}

usage() {
  cat <<'USAGE'
Usage: supabase-maintenance.sh <keepalive|backup>

  keepalive  One small database request so the Free-plan project is not paused.
             Uses SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from the deployment env file.
  backup     pg_dump of the configured schemas into a single latest-only archive.
             Needs PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE in the backup env file.
USAGE
}

case "${1:-}" in
  keepalive) keepalive ;;
  backup) backup ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
