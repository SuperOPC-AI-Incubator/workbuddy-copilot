#!/bin/sh

set -eu
umask 077

: "${CONNECTOR_TEST_TOKEN:?CONNECTOR_TEST_TOKEN is required}"

ROOT=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

TEST_HOME="$TEST_ROOT/home"
STATE_HOME="$TEST_ROOT/state"
mkdir -p "$TEST_HOME" "$STATE_HOME"
OUTPUT_FILE="$TEST_ROOT/install-output.txt"
CRON_BEFORE=
if command -v crontab >/dev/null 2>&1; then
  CRON_BEFORE=$(crontab -l 2>/dev/null || true)
fi

printf '%s\n' "$CONNECTOR_TEST_TOKEN" |
  HOME="$TEST_HOME" XDG_STATE_HOME="$STATE_HOME" \
    "$ROOT/connectors/install-macos.sh" \
    --api-url "https://copilot.example.test" \
    --no-schedule >"$OUTPUT_FILE" 2>&1

HOME="$TEST_HOME" XDG_STATE_HOME="$STATE_HOME" \
  "$ROOT/connectors/install-macos.sh" \
  --api-url "https://copilot.example.test" \
    --no-schedule >>"$OUTPUT_FILE" 2>&1

test ! -e "$TEST_HOME/Library/LaunchAgents/com.superbrain.workbuddy-sync.plist"
if command -v crontab >/dev/null 2>&1; then
  CRON_AFTER=$(crontab -l 2>/dev/null || true)
  test "$CRON_AFTER" = "$CRON_BEFORE"
fi

if grep -F "$CONNECTOR_TEST_TOKEN" "$OUTPUT_FILE" >/dev/null 2>&1; then
  echo "installer output leaked credential material" >&2
  exit 1
fi

CONFIG="$STATE_HOME/superbrain-copilot/config.json"
SKILL="$TEST_HOME/.workbuddy/skills/superbrain-sync/SKILL.md"
WRAPPER="$TEST_HOME/.local/bin/workbuddy-sync"
RUNNER="$TEST_HOME/.local/share/superbrain-copilot/scheduled-sync.sh"

test -f "$CONFIG"
test -f "$SKILL"
test -x "$WRAPPER"
test -x "$RUNNER"

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

test "$(file_mode "$CONFIG")" = "600"
test "$(file_mode "$SKILL")" = "600"
test "$(file_mode "$WRAPPER")" = "700"
test "$(file_mode "$RUNNER")" = "700"

CONFIG_PATH="$CONFIG" node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
  if (config.token !== process.env.CONNECTOR_TEST_TOKEN) process.exit(1);
  if (config.api_url !== "https://copilot.example.test") process.exit(1);
'

HOME="$TEST_HOME" SKILL_PATH="$SKILL" node -e '
  const fs = require("node:fs");
  const skill = fs.readFileSync(process.env.SKILL_PATH, "utf8");
  if (skill.includes(process.env.CONNECTOR_TEST_TOKEN)) process.exit(1);
  if (!skill.includes(process.env.HOME + "/.local/bin/workbuddy-sync")) process.exit(1);
  if (skill.includes("__WORKBUDDY_CONNECTOR_ENTRYPOINT__")) process.exit(1);
'

STATUS_FILE="$TEST_ROOT/status.json"
HOME="$TEST_HOME" XDG_STATE_HOME="$STATE_HOME" "$WRAPPER" status >"$STATUS_FILE"
node -e '
  const fs = require("node:fs");
  const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (status.configured !== true || status.queue.pending !== 0) process.exit(1);
' "$STATUS_FILE"

for asset in workbuddy-sync.mjs install-macos.sh install-windows.ps1 SKILL.md; do
  cmp "$ROOT/connectors/$asset" "$ROOT/public/downloads/$asset"
done

echo "POSIX connector install verification passed."
