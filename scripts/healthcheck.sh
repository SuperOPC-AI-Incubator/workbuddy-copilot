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

check_mcp_oauth_challenge() {
  local path="/.mcp/list-tools"
  local expected_metadata="$BASE_URL/.well-known/oauth-protected-resource"
  local response_file
  local header_file
  local actual
  local challenge
  local scheme
  response_file="$(mktemp)"
  header_file="$(mktemp)"

  if ! actual="$(
    curl --noproxy '*' -sS --connect-timeout 3 --max-time 10 \
      -D "$header_file" -o "$response_file" -w '%{http_code}' \
      -X GET "$BASE_URL$path"
  )"; then
    rm -f "$response_file" "$header_file"
    fail "MCP OAuth challenge request failed"
  fi

  challenge="$(
    awk '
      tolower($0) ~ /^www-authenticate:[[:space:]]*/ {
        sub(/^[^:]*:[[:space:]]*/, "")
        sub(/\r$/, "")
        print
        exit
      }
    ' "$header_file"
  )"
  rm -f "$response_file" "$header_file"

  [[ "$actual" == "401" ]] ||
    fail "MCP tool list returned HTTP $actual; expected exactly 401 without credentials"
  [[ -n "$challenge" ]] ||
    fail "MCP tool list omitted the WWW-Authenticate challenge"
  scheme="$(printf '%s\n' "$challenge" | awk '{ print $1 }')"
  [[ "$(printf '%s' "$scheme" | tr '[:upper:]' '[:lower:]')" == "bearer" ]] ||
    fail "MCP tool list returned a non-Bearer authentication challenge"
  printf '%s\n' "$challenge" | awk -v expected="$expected_metadata" '
    {
      sub(/^[^[:space:]]+[[:space:]]+/, "")
      count = split($0, parameters, ",")
      for (position = 1; position <= count; position += 1) {
        parameter = parameters[position]
        sub(/^[[:space:]]+/, "", parameter)
        sub(/[[:space:]]+$/, "", parameter)
        separator = index(parameter, "=")
        if (separator == 0) {
          continue
        }
        key = substr(parameter, 1, separator - 1)
        value = substr(parameter, separator + 1)
        if (tolower(key) == "resource_metadata" && value == "\"" expected "\"") {
          found = 1
        }
      }
    }
    END { exit found ? 0 : 1 }
  ' ||
    fail "MCP tool list challenge points at the wrong OAuth metadata resource"
  printf 'ok: MCP OAuth challenge (%s)\n' "$actual"
}

check_status "process health" GET "/api/health" 200
check_status "dependency readiness" GET "/api/ready" 200
check_status "MCP OAuth metadata" GET "/.well-known/oauth-protected-resource" 200
check_mcp_oauth_challenge
check_status "unauthenticated WorkBuddy ingest rejection" POST \
  "/api/public/workbuddy/ingest" 401
