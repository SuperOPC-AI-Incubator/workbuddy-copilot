#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${SUPERBRAIN_BASE_URL:-http://127.0.0.1:3410}}"
BASE_URL="${BASE_URL%/}"

fail() {
  printf 'healthcheck failed: %s\n' "$*" >&2
  exit 1
}

check_status() {
  local label="$1"
  local method="$2"
  local path="$3"
  local expected="$4"
  local response_file
  local actual
  response_file="$(mktemp)"

  local -a request=(
    curl --noproxy '*' -sS --connect-timeout 3 --max-time 10
    -o "$response_file" -w '%{http_code}' -X "$method"
  )
  if [[ "$method" == "POST" ]]; then
    request+=(-H "Content-Type: application/json" --data '{}')
  fi
  request+=("$BASE_URL$path")

  if ! actual="$("${request[@]}")"; then
    rm -f "$response_file"
    fail "$label request failed"
  fi
  rm -f "$response_file"
  [[ "$actual" == "$expected" ]] ||
    fail "$label returned HTTP $actual; expected exactly $expected"
  printf 'ok: %s (%s)\n' "$label" "$actual"
}

check_status "process health" GET "/api/health" 200
check_status "dependency readiness" GET "/api/ready" 200
check_status "MCP OAuth metadata" GET "/.well-known/oauth-protected-resource" 200
check_status "MCP tool list" GET "/.mcp/list-tools" 200
check_status "unauthenticated WorkBuddy ingest rejection" POST \
  "/api/public/workbuddy/ingest" 401
