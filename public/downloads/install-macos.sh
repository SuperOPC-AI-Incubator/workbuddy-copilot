#!/bin/sh

set -eu
umask 077

usage() {
  echo "Usage: install-macos.sh [install|upgrade|uninstall] --api-url HTTPS_URL [--no-schedule]" >&2
}

ACTION=install
API_URL=
NO_SCHEDULE=0

if [ "${1:-}" = "install" ] || [ "${1:-}" = "upgrade" ] || [ "${1:-}" = "uninstall" ]; then
  ACTION=$1
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-url)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      API_URL=$2
      shift 2
      ;;
    --no-schedule)
      NO_SCHEDULE=1
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[ -n "${HOME:-}" ] || { echo "HOME is unavailable." >&2; exit 1; }

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="$HOME/.local/share/superbrain-copilot"
CONNECTOR="$INSTALL_ROOT/workbuddy-sync.mjs"
SKILL_TEMPLATE="$INSTALL_ROOT/SKILL.template.md"
RUNNER="$INSTALL_ROOT/scheduled-sync.sh"
BIN_ROOT="$HOME/.local/bin"
WRAPPER="$BIN_ROOT/workbuddy-sync"
WORKBUDDY_SKILL_DIR="$HOME/.workbuddy/skills/superbrain-sync"
INSTALLED_SKILL="$WORKBUDDY_SKILL_DIR/SKILL.md"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
case "$STATE_HOME" in
  /*) ;;
  *) echo "XDG_STATE_HOME must resolve to an absolute path." >&2; exit 1 ;;
esac
STATE_ROOT="$STATE_HOME/superbrain-copilot"
LOG_ROOT="$STATE_ROOT/logs"
RUNNER_LOG="$LOG_ROOT/scheduled-sync.log"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.superbrain.workbuddy-sync.plist"
CRON_MARKER="# superbrain-workbuddy-sync"

remove_schedule() {
  case "$(uname -s)" in
    Darwin)
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
      fi
      rm -f "$LAUNCH_AGENT"
      ;;
    *)
      if command -v crontab >/dev/null 2>&1; then
        current_cron=$(crontab -l 2>/dev/null || true)
        filtered_cron=$(printf '%s\n' "$current_cron" | awk -v marker="$CRON_MARKER" 'index($0, marker) == 0')
        printf '%s\n' "$filtered_cron" | crontab -
      fi
      ;;
  esac
}

if [ "$ACTION" = "uninstall" ]; then
  remove_schedule
  rm -f "$CONNECTOR" "$SKILL_TEMPLATE" "$RUNNER" "$WRAPPER" "$INSTALLED_SKILL"
  rmdir "$WORKBUDDY_SKILL_DIR" 2>/dev/null || true
  rmdir "$HOME/.workbuddy/skills" 2>/dev/null || true
  rmdir "$HOME/.workbuddy" 2>/dev/null || true
  rmdir "$BIN_ROOT" 2>/dev/null || true
  rmdir "$INSTALL_ROOT" 2>/dev/null || true
  echo "Connector program removed. Private queue and configuration were preserved at $STATE_ROOT."
  exit 0
fi

[ -n "$API_URL" ] || { usage; exit 2; }
[ -f "$SCRIPT_DIR/workbuddy-sync.mjs" ] || {
  echo "workbuddy-sync.mjs must be downloaded beside this installer." >&2
  exit 1
}
[ -f "$SCRIPT_DIR/SKILL.md" ] || {
  echo "SKILL.md must be downloaded beside this installer." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || { echo "Node.js 22 or newer is required." >&2; exit 1; }
NODE_PATH=$(command -v node)
case "$NODE_PATH" in
  /*) ;;
  *) echo "Node.js executable must resolve to an absolute path." >&2; exit 1 ;;
esac
NODE_MAJOR=$("$NODE_PATH" -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node.js 22 or newer is required." >&2; exit 1; }

mkdir -p "$INSTALL_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$BIN_ROOT" "$WORKBUDDY_SKILL_DIR"
chmod 700 "$INSTALL_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$BIN_ROOT" "$HOME/.workbuddy" \
  "$HOME/.workbuddy/skills" "$WORKBUDDY_SKILL_DIR"
cp "$SCRIPT_DIR/workbuddy-sync.mjs" "$CONNECTOR"
cp "$SCRIPT_DIR/SKILL.md" "$SKILL_TEMPLATE"
chmod 700 "$CONNECTOR"
chmod 600 "$SKILL_TEMPLATE"

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

NODE_QUOTED=$(shell_quote "$NODE_PATH")
CONNECTOR_QUOTED=$(shell_quote "$CONNECTOR")
RUNNER_LOG_QUOTED=$(shell_quote "$RUNNER_LOG")
STATE_HOME_QUOTED=$(shell_quote "$STATE_HOME")

{
  echo '#!/bin/sh'
  printf 'XDG_STATE_HOME=%s\n' "$STATE_HOME_QUOTED"
  echo 'export XDG_STATE_HOME'
  printf 'exec %s %s "$@"\n' "$NODE_QUOTED" "$CONNECTOR_QUOTED"
} >"$WRAPPER"
chmod 700 "$WRAPPER"

"$NODE_PATH" -e '
  const fs = require("node:fs");
  const [templatePath, outputPath, wrapperPath] = process.argv.slice(1);
  const shellQuote = (value) => "'"'"'" + value.replaceAll("'"'"'", "'"'"'\"'"'"'\"'"'"'") + "'"'"'";
  const template = fs.readFileSync(templatePath, "utf8");
  const output = template.replaceAll(
    "__WORKBUDDY_CONNECTOR_ENTRYPOINT__",
    shellQuote(wrapperPath),
  );
  if (output.includes("__WORKBUDDY_CONNECTOR_ENTRYPOINT__")) process.exit(2);
  fs.writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o600 });
' "$SKILL_TEMPLATE" "$INSTALLED_SKILL" "$WRAPPER"
chmod 600 "$INSTALLED_SKILL"

if [ ! -f "$STATE_ROOT/config.json" ]; then
  token=
  restore_tty=0
  if [ -t 0 ]; then
    printf "Paste the one-time WorkBuddy credential: " >&2
    stty -echo
    restore_tty=1
    trap 'if [ "$restore_tty" -eq 1 ]; then stty echo; printf "\n" >&2; fi' EXIT HUP INT TERM
  fi
  IFS= read -r token
  if [ "$restore_tty" -eq 1 ]; then
    stty echo
    restore_tty=0
    printf "\n" >&2
  fi
  [ -n "$token" ] || { echo "Credential input is required." >&2; exit 1; }
  printf '%s\n' "$token" | "$NODE_PATH" "$CONNECTOR" configure --api-url "$API_URL" --token-stdin
  token=
fi
chmod 700 "$STATE_ROOT"
chmod 600 "$STATE_ROOT/config.json"

{
  echo '#!/bin/sh'
  printf 'XDG_STATE_HOME=%s\n' "$STATE_HOME_QUOTED"
  echo 'export XDG_STATE_HOME'
  printf 'NODE_PATH=%s\n' "$NODE_QUOTED"
  printf 'CONNECTOR=%s\n' "$CONNECTOR_QUOTED"
  printf 'LOG_FILE=%s\n' "$RUNNER_LOG_QUOTED"
  cat <<'EOF'
status=0
printf '%s scheduled sync start\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
if "$NODE_PATH" "$CONNECTOR" flush >/dev/null 2>>"$LOG_FILE"; then
  printf '%s flush ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
else
  printf '%s flush failed\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
  status=1
fi
if "$NODE_PATH" "$CONNECTOR" fetch >/dev/null 2>>"$LOG_FILE"; then
  printf '%s fetch ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
else
  printf '%s fetch failed\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
  status=1
fi
exit "$status"
EOF
} >"$RUNNER"
chmod 700 "$RUNNER"

if [ "$NO_SCHEDULE" -eq 0 ]; then
  case "$(uname -s)" in
    Darwin)
      mkdir -p "$HOME/Library/LaunchAgents"
      chmod 700 "$HOME/Library/LaunchAgents"
      escaped_runner=$(printf '%s' "$RUNNER" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')
      cat >"$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.superbrain.workbuddy-sync</string>
  <key>ProgramArguments</key><array><string>$escaped_runner</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
      chmod 600 "$LAUNCH_AGENT"
      launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
      ;;
    *)
      if command -v crontab >/dev/null 2>&1; then
        current_cron=$(crontab -l 2>/dev/null || true)
        filtered_cron=$(printf '%s\n' "$current_cron" | awk -v marker="$CRON_MARKER" 'index($0, marker) == 0')
        {
          printf '%s\n' "$filtered_cron"
          printf '*/5 * * * * "%s" >/dev/null 2>&1 %s\n' "$RUNNER" "$CRON_MARKER"
        } | crontab -
      else
        echo "crontab is unavailable; run flush/fetch manually or install a user scheduler." >&2
      fi
      ;;
  esac
fi

echo "SuperBrain WorkBuddy connector installed for the current user."
echo "Skill installed at: $INSTALLED_SKILL"
echo "Connector command: $WRAPPER"
echo "Run: \"$WRAPPER\" status"
echo "Restart WorkBuddy to load the new skill."
