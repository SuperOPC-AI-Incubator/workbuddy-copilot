#!/bin/sh
#
# Check, from a student's own machine and network, whether the three hosted paths this
# product depends on are reachable. Run it before a camp starts, from the network the
# students will actually use.
#
# The connector only talks to this application's own origin, but the browser and any MCP
# client also talk straight to the Supabase project host. Those direct paths are the ones
# that fail first on a restricted network, so they are checked separately here.
#
# Needs nothing but `sh` and `curl`, and no credentials. It deliberately reads the Supabase
# host out of the application's published metadata instead of hardcoding it, so it keeps
# testing the right project after a migration.
#
# What this cannot tell you: an HTTP response proves the path is open, not that browser
# signup or a live WebSocket subscription succeeds. Finish with the manual steps in
# docs/student-network-check.md.
set -u

APP_ORIGIN=${APP_ORIGIN:-https://copilot.sg.superbrain-ai.com}
ATTEMPTS=${ATTEMPTS:-3}
TIMEOUT=${TIMEOUT:-20}

failures=0
warnings=0

say() {
  printf '%s\n' "$*"
}

# Print one probe line per attempt, then a verdict. `expect` is either an HTTP status code or
# the literal word "any", because some endpoints answer 401 by design and a refusal is still
# proof that the network path is open. Any further arguments are passed to curl, which is how
# a POST-only route gets probed with POST: this application answers an unauthenticated GET
# with the single-page app shell, so a GET probe would report a misleading 200.
probe() {
  label=$1
  url=$2
  expect=$3
  shift 3
  attempt=1
  ok=0
  while [ "$attempt" -le "$ATTEMPTS" ]; do
    result=$(
      curl -s -o /dev/null \
        -w '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_total}' \
        --max-time "$TIMEOUT" "$@" "$url" 2>/dev/null
    ) || result="000 - - - -"
    # Read the fields without `set --`, which would discard the curl arguments in "$@".
    code=$(printf '%s' "$result" | cut -d' ' -f1)
    timings=$(printf '%s' "$result" | cut -d' ' -f2-)
    say "    attempt $attempt: http=$code dns/tcp/tls/total=$timings"
    if [ "$code" != "000" ]; then
      if [ "$expect" = "any" ] || [ "$code" = "$expect" ]; then
        ok=$((ok + 1))
      fi
    fi
    attempt=$((attempt + 1))
  done

  if [ "$ok" -eq "$ATTEMPTS" ]; then
    say "  PASS $label ($ok/$ATTEMPTS)"
  elif [ "$ok" -gt 0 ]; then
    warnings=$((warnings + 1))
    say "  FLAKY $label ($ok/$ATTEMPTS reachable) - intermittent is still a camp-day outage"
  else
    failures=$((failures + 1))
    say "  FAIL $label (0/$ATTEMPTS)"
  fi
}

say "WorkBuddy Copilot network check"
say "application origin: $APP_ORIGIN"
say "attempts per probe: $ATTEMPTS, timeout: ${TIMEOUT}s"
say ""

say "1. Application origin (connector and web UI)"
probe "application origin" "$APP_ORIGIN/" 200
say ""

say "2. MCP protected-resource metadata (also tells us which Supabase project to test)"
probe "protected-resource metadata" "$APP_ORIGIN/.well-known/oauth-protected-resource" 200
metadata=$(curl -s --max-time "$TIMEOUT" "$APP_ORIGIN/.well-known/oauth-protected-resource" 2>/dev/null || true)
issuer=$(
  printf '%s' "$metadata" |
    sed -n 's/.*"authorization_servers"[[:space:]]*:[[:space:]]*\[[[:space:]]*"\([^"]*\)".*/\1/p'
)
if [ -z "$issuer" ]; then
  failures=$((failures + 1))
  say "  FAIL could not read authorization_servers from the metadata"
  say ""
  say "Result: cannot continue without the Supabase host. Check the application first."
  exit 1
fi
supabase_origin=$(printf '%s' "$issuer" | sed -n 's#^\(https://[^/]*\).*#\1#p')
say "  Supabase host in use: $supabase_origin"
say ""

say "3. Supabase Auth over HTTPS (browser signup and login both need this)"
say "   401 is the expected answer without an API key; it proves the path is open."
probe "supabase auth" "$supabase_origin/auth/v1/health" any
say ""

say "4. Supabase Realtime WebSocket endpoint (mentor messages appearing without a refresh)"
say "   401 is expected without an API key; a timeout means the WebSocket path is blocked."
probe "supabase realtime" "$supabase_origin/realtime/v1/websocket?vsn=1.0.0" any
say ""

say "5. Application ingest endpoint (connector upload path)"
say "   Probed with POST because a GET returns the web app shell. Exactly 401 is expected"
say "   without a student token: anything else means the route is not answering."
probe "connector ingest" "$APP_ORIGIN/api/public/workbuddy/ingest" 401 \
  -X POST -H "content-type: application/json" -d '{}'
say ""

say "----------------------------------------------------------------"
if [ "$failures" -gt 0 ]; then
  say "RESULT: $failures probe(s) failed, $warnings flaky."
  say "The camp will hit this. See docs/student-network-check.md for what each failure blocks."
  exit 1
fi
if [ "$warnings" -gt 0 ]; then
  say "RESULT: all paths answered at least once, but $warnings were intermittent."
  say "Re-run at different times of day before trusting it."
  exit 1
fi
say "RESULT: all paths reachable from this network."
say ""
say "This is necessary, not sufficient. Now do the manual steps in"
say "docs/student-network-check.md: real browser signup, a live mentor message, and"
say "one connector sync. Only those exercise signup, WebSocket upgrade and delivery."
