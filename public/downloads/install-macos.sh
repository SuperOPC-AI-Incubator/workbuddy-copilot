#!/bin/sh

set -eu
umask 077

usage() {
  echo "Usage: install-macos.sh [install|upgrade|uninstall] --api-url HTTPS_URL" >&2
  echo "                        [--no-schedule] [--no-hook] [--no-import] [--with-downstream]" >&2
}

ACTION=install
API_URL=
NO_SCHEDULE=0
NO_HOOK=0
NO_IMPORT=0
WITH_DOWNSTREAM=0

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
    --no-hook)
      # 跳过 WorkBuddy Stop hook 注册（排障/CI 用；正常安装不要加）
      NO_HOOK=1
      shift
      ;;
    --no-import)
      # 跳过装机时的历史补传
      NO_IMPORT=1
      shift
      ;;
    --with-downstream)
      # 下行（导师回信 Skill）本期默认不安装，需要时显式打开
      WITH_DOWNSTREAM=1
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
HOOK_ENTRY="$INSTALL_ROOT/workbuddy-hook.mjs"
HOOK_WRAPPER="$INSTALL_ROOT/workbuddy-hook.sh"
SETTINGS_HELPER="$INSTALL_ROOT/register-workbuddy-hook.mjs"
SKILL_TEMPLATE="$INSTALL_ROOT/SKILL.template.md"
RUNNER="$INSTALL_ROOT/scheduled-sync.sh"
BIN_ROOT="$HOME/.local/bin"
WRAPPER="$BIN_ROOT/workbuddy-sync"
WORKBUDDY_ROOT="${WORKBUDDY_HOME:-$HOME/.workbuddy}"
case "$WORKBUDDY_ROOT" in
  /*) ;;
  *) echo "WORKBUDDY_HOME must resolve to an absolute path." >&2; exit 1 ;;
esac
WORKBUDDY_SETTINGS="$WORKBUDDY_ROOT/settings.json"
WORKBUDDY_SKILL_DIR="$WORKBUDDY_ROOT/skills/superbrain-sync"
INSTALLED_SKILL="$WORKBUDDY_SKILL_DIR/SKILL.md"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
case "$STATE_HOME" in
  /*) ;;
  *) echo "XDG_STATE_HOME must resolve to an absolute path." >&2; exit 1 ;;
esac
STATE_ROOT="$STATE_HOME/superbrain-copilot"
LOG_ROOT="$STATE_ROOT/logs"
RUNNER_LOG="$LOG_ROOT/scheduled-sync.log"
HOOK_LOG="$LOG_ROOT/hook.log"
IMPORT_LOG="$LOG_ROOT/import.log"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.superbrain.workbuddy-sync.plist"
CRON_MARKER="# superbrain-workbuddy-sync"
# hook 事件与识别标记：升级时靠这个标记就地替换旧命令，绝不重复追加。
HOOK_EVENT=Stop
HOOK_MARKER=workbuddy-hook.sh
# hook 自身的总预算最多 4 秒（stdin、读取与本地入队均受其限制）；注册 15 秒
# 给 WorkBuddy 留出足够余量，且不会把 Stop 关键路径拖到注册上限。
HOOK_TIMEOUT=15
# 上行 hook 依赖的模块，必须与安装脚本一起下载。
# workbuddy-sync.mjs 自身就 import transcript / event-id（import 子命令要用），
# 因此它们是 connector 的依赖，不是 hook 的。归错类会让 --no-hook 安装出来的
# connector 一运行就 ERR_MODULE_NOT_FOUND。
CONNECTOR_MODULES="workbuddy-sync.mjs workbuddy-transcript.mjs workbuddy-event-id.mjs"
HOOK_MODULES="workbuddy-hook.mjs"

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

# 用探测到的运行时执行 node。electron 模式必须带 ELECTRON_RUN_AS_NODE=1，
# 否则 WorkBuddy 的二进制会当 GUI 启动而不是当 node 用。
run_node() {
  if [ "${NODE_MODE:-plain}" = electron ]; then
    ELECTRON_RUN_AS_NODE=1 "$NODE_PATH" "$@"
  else
    "$NODE_PATH" "$@"
  fi
}

# 生成 settings.json 的合并/摘除辅助脚本（用探测到的 node 执行，绝不手写 JSON 字符串拼接）。
write_settings_helper() {
  cat >"$1" <<'SETTINGS_HELPER_EOF'
// 把上行 hook 合并进 WorkBuddy 的 settings.json：
//  - 保留学员自己已有的 hook
//  - 已存在本项目的 hook 条目则就地替换（升级不会留下旧命令）
//  - 改动前做原子备份（写临时文件 + rename）
// argv: <settingsPath> <event> <marker> <mode: register|remove> [command] [timeoutSeconds]
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

const [settingsPath, event, marker, mode, command, timeoutRaw] = process.argv.slice(2);
if (!settingsPath || !event || !marker || (mode !== "register" && mode !== "remove")) {
  process.stderr.write("register-workbuddy-hook: invalid arguments\n");
  process.exit(2);
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sleep = (milliseconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const lockPath = `${settingsPath}.superbrain.lock`;
const staleLockAgeMs = 5 * 60 * 1000;
const isStaleLock = () => {
  try {
    const metadata = JSON.parse(readFileSync(lockPath, "utf8"));
    if (Number.isInteger(metadata?.pid) && metadata.pid > 0) {
      try {
        process.kill(metadata.pid, 0);
        return false;
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        if (error?.code === "EPERM") return false;
      }
    }
  } catch {
    // 新建 lock 与写入 metadata 之间可能极短暂为空；只按年龄回收这种 lock。
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleLockAgeMs;
  } catch (error) {
    return error?.code === "ENOENT";
  }
};
let lockFd;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    break;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (isStaleLock()) {
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    sleep(25);
  }
}
if (lockFd === undefined) {
  process.stderr.write(`${settingsPath} 正在被另一个安装或卸载操作修改，请稍后重试。\n`);
  process.exit(4);
}

const fail = (message, code) => {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
};
const readSnapshot = () => {
  const exists = existsSync(settingsPath);
  return { exists, raw: exists ? readFileSync(settingsPath, "utf8") : null };
};

try {
  const snapshot = readSnapshot();
  let raw = snapshot.raw;
  let settings = {};
  let originalMode = 0o600;
  if (snapshot.exists) {
    try {
      originalMode = statSync(settingsPath).mode & 0o777;
    } catch {
      originalMode = 0o600;
    }
    if (raw.trim().length > 0) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(
          `${settingsPath} 不是合法 JSON，已中止且未做任何修改。\n` +
            "请先修好该文件（或改名备份后让 WorkBuddy 重新生成）再重跑安装脚本。",
          3,
        );
      }
      if (!isPlainObject(parsed)) {
        fail(`${settingsPath} 顶层不是 JSON 对象，已中止且未做任何修改。`, 3);
      }
      settings = parsed;
    }
  }
  const absentRemove = !snapshot.exists && mode === "remove";
  if (absentRemove) {
    process.stdout.write("absent\n");
  } else {
    // 原子备份：临时文件和备份名都唯一，避免并发 helper 相互覆盖。
    if (raw !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const unique = `${process.pid}-${randomUUID()}`;
    const backupPath = `${settingsPath}.superbrain-${stamp}-${unique}.bak`;
    const backupTemp = `${backupPath}.tmp`;
    writeFileSync(backupTemp, raw, { encoding: "utf8", mode: originalMode });
    renameSync(backupTemp, backupPath);
    process.stdout.write(`backup=${backupPath}\n`);
    }

    const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
  const matchesMarker = (hook) =>
    isPlainObject(hook) && typeof hook.command === "string" && hook.command.includes(marker);

  let outcome;
  if (mode === "remove") {
    const kept = [];
    for (const block of blocks) {
      if (!isPlainObject(block) || !Array.isArray(block.hooks)) {
        kept.push(block);
        continue;
      }
      const remaining = block.hooks.filter((hook) => !matchesMarker(hook));
      if (remaining.length > 0) kept.push({ ...block, hooks: remaining });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
    outcome = "removed";
  } else {
    const timeout = Number.parseInt(timeoutRaw ?? "", 10);
    const entry = { type: "command", command };
    if (Number.isFinite(timeout) && timeout > 0) entry.timeout = timeout;
    if (!command) fail("register-workbuddy-hook: command is required", 2);
    let replaced = false;
    for (const block of blocks) {
      if (!isPlainObject(block) || !Array.isArray(block.hooks)) continue;
      for (let index = 0; index < block.hooks.length; index += 1) {
        if (!matchesMarker(block.hooks[index])) continue;
        block.hooks[index] = { ...block.hooks[index], ...entry };
        replaced = true;
      }
    }
    if (!replaced) blocks.push({ hooks: [entry] });
    hooks[event] = blocks;
    outcome = replaced ? "replaced" : "added";
  }

  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;

  const temporaryPath = `${settingsPath}.superbrain-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: originalMode,
  });
  // 非合作写者无法持有上述锁；提交前再读一次，宁可失败重跑也不覆盖其更新。
  const current = readSnapshot();
  if (current.exists !== snapshot.exists || current.raw !== snapshot.raw) {
    unlinkSync(temporaryPath);
    fail(`${settingsPath} settings changed concurrently; 已中止，未覆盖其他更新，请重试。`, 4);
  }
  renameSync(temporaryPath, settingsPath);
    process.stdout.write(`${outcome}\n`);
  }
} catch (error) {
  if (Number.isInteger(error?.exitCode)) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
} finally {
  closeSync(lockFd);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
SETTINGS_HELPER_EOF
  chmod 600 "$1"
}

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

DETECT_RUNTIME="$SCRIPT_DIR/detect-runtime.sh"

# 卸载不能依赖同目录仍有 detect-runtime.sh：用户常只保存这一份脚本。
# 若探测器不在，优先使用显式覆盖，再尝试 PATH node；两者均没有时仍继续删除
# schedule 和本项目文件，只提示用户手动摘除 settings 中的 hook。
detect_uninstall_runtime() {
  if [ -f "$DETECT_RUNTIME" ]; then
    # shellcheck source=detect-runtime.sh
    . "$DETECT_RUNTIME"
    detect_workbuddy_node
    return
  fi
  if [ -n "${WORKBUDDY_NODE:-}" ] && [ -x "$WORKBUDDY_NODE" ]; then
    case "${WORKBUDDY_NODE_MODE:-plain}" in
      electron | plain) printf '%s\n%s\n' "$WORKBUDDY_NODE" "${WORKBUDDY_NODE_MODE:-plain}"; return ;;
    esac
  fi
  if uninstall_node=$(command -v node 2>/dev/null); then
    printf '%s\nplain\n' "$uninstall_node"
    return
  fi
  return 1
}

if [ "$ACTION" = "uninstall" ]; then
  remove_schedule
  # 先摘掉 hook，再删文件：否则 WorkBuddy 每次 Stop 都会去执行一个不存在的脚本。
  if [ -f "$WORKBUDDY_SETTINGS" ]; then
    if uninstall_runtime=$(detect_uninstall_runtime 2>/dev/null); then
      NODE_PATH=$(printf '%s\n' "$uninstall_runtime" | sed -n 1p)
      NODE_MODE=$(printf '%s\n' "$uninstall_runtime" | sed -n 2p)
      mkdir -p "$INSTALL_ROOT"
      write_settings_helper "$SETTINGS_HELPER"
      if run_node "$SETTINGS_HELPER" \
        "$WORKBUDDY_SETTINGS" "$HOOK_EVENT" "$HOOK_MARKER" remove; then
        echo "Removed the WorkBuddy $HOOK_EVENT hook entry."
      else
        echo "无法自动摘除 hook，请手动编辑 $WORKBUDDY_SETTINGS 删除包含 $HOOK_MARKER 的条目。" >&2
      fi
      rm -f "$SETTINGS_HELPER"
    else
      echo "未找到可用的 Node 运行时，无法自动摘除 hook。" >&2
      echo "请手动编辑 $WORKBUDDY_SETTINGS 删除包含 $HOOK_MARKER 的条目。" >&2
    fi
  fi
  rm -f "$CONNECTOR" "$HOOK_ENTRY" "$HOOK_WRAPPER" "$SKILL_TEMPLATE" "$RUNNER" "$WRAPPER" \
    "$INSTALLED_SKILL" "$SETTINGS_HELPER"
  for module in $CONNECTOR_MODULES $HOOK_MODULES; do
    rm -f "$INSTALL_ROOT/$module"
  done
  rmdir "$WORKBUDDY_SKILL_DIR" 2>/dev/null || true
  rmdir "$WORKBUDDY_ROOT/skills" 2>/dev/null || true
  rmdir "$WORKBUDDY_ROOT" 2>/dev/null || true
  rmdir "$BIN_ROOT" 2>/dev/null || true
  rmdir "$INSTALL_ROOT" 2>/dev/null || true
  echo "Connector program removed. Private queue and configuration were preserved at $STATE_ROOT."
  exit 0
fi

[ -n "$API_URL" ] || { usage; exit 2; }

# 运行时探测（Node 22+）。学员机通常没有装 Node，
# 唯一"装了 WorkBuddy 就必然存在"的运行时是 WorkBuddy 自带的 Electron。
[ -f "$DETECT_RUNTIME" ] || {
  echo "detect-runtime.sh must be downloaded beside this installer." >&2
  exit 1
}
# shellcheck source=detect-runtime.sh
. "$DETECT_RUNTIME"

REQUIRED_MODULES=$CONNECTOR_MODULES
if [ "$NO_HOOK" -eq 0 ]; then
  REQUIRED_MODULES="$REQUIRED_MODULES $HOOK_MODULES"
fi
missing_modules=
for module in $REQUIRED_MODULES; do
  [ -f "$SCRIPT_DIR/$module" ] || missing_modules="$missing_modules $module"
done
[ -z "$missing_modules" ] || {
  echo "以下文件必须与安装脚本一起下载到同一目录：$missing_modules" >&2
  exit 1
}
if [ "$WITH_DOWNSTREAM" -eq 1 ] && [ ! -f "$SCRIPT_DIR/SKILL.md" ]; then
  echo "SKILL.md must be downloaded beside this installer when --with-downstream is used." >&2
  exit 1
fi

if ! RUNTIME=$(detect_workbuddy_node); then
  echo "安装中止：没有可用的 Node 运行时。" >&2
  exit 1
fi
NODE_PATH=$(printf '%s\n' "$RUNTIME" | sed -n 1p)
NODE_MODE=$(printf '%s\n' "$RUNTIME" | sed -n 2p)
case "$NODE_PATH" in
  /*) ;;
  *) echo "Node runtime must resolve to an absolute path (got: $NODE_PATH)." >&2; exit 1 ;;
esac
case "$NODE_MODE" in
  electron | plain) ;;
  *) echo "Unexpected runtime mode: $NODE_MODE" >&2; exit 1 ;;
esac
echo "Runtime: $NODE_PATH ($NODE_MODE)"

mkdir -p "$INSTALL_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$BIN_ROOT" "$WORKBUDDY_ROOT"
chmod 700 "$INSTALL_ROOT" "$STATE_ROOT" "$LOG_ROOT" "$BIN_ROOT" "$WORKBUDDY_ROOT"
for module in $REQUIRED_MODULES; do
  cp "$SCRIPT_DIR/$module" "$INSTALL_ROOT/$module"
  chmod 700 "$INSTALL_ROOT/$module"
done

NODE_QUOTED=$(shell_quote "$NODE_PATH")
CONNECTOR_QUOTED=$(shell_quote "$CONNECTOR")
HOOK_ENTRY_QUOTED=$(shell_quote "$HOOK_ENTRY")
RUNNER_LOG_QUOTED=$(shell_quote "$RUNNER_LOG")
HOOK_LOG_QUOTED=$(shell_quote "$HOOK_LOG")
STATE_HOME_QUOTED=$(shell_quote "$STATE_HOME")

# electron 模式下 WorkBuddy 的二进制只有带 ELECTRON_RUN_AS_NODE=1 才当 node 用。
emit_runtime_env() {
  printf 'XDG_STATE_HOME=%s\n' "$STATE_HOME_QUOTED"
  echo 'export XDG_STATE_HOME'
  printf 'NODE_PATH=%s\n' "$NODE_QUOTED"
  if [ "$NODE_MODE" = electron ]; then
    echo 'ELECTRON_RUN_AS_NODE=1'
    echo 'export ELECTRON_RUN_AS_NODE'
  fi
}

# WorkBuddy 升级可能换掉 Electron 路径：每次运行都校验，宁可报错也不静默不同步。
{
  echo '#!/bin/sh'
  emit_runtime_env
  cat <<'EOF'
if [ ! -x "$NODE_PATH" ]; then
  echo "找不到 WorkBuddy 的 Node 运行时：$NODE_PATH" >&2
  echo "WorkBuddy 可能已升级、移动或被卸载。请重新运行安装脚本以重新探测运行时。" >&2
  exit 1
fi
EOF
  printf 'exec "$NODE_PATH" %s "$@"\n' "$CONNECTOR_QUOTED"
} >"$WRAPPER"
chmod 700 "$WRAPPER"

if [ "$WITH_DOWNSTREAM" -eq 1 ]; then
  mkdir -p "$WORKBUDDY_SKILL_DIR"
  chmod 700 "$WORKBUDDY_ROOT/skills" "$WORKBUDDY_SKILL_DIR"
  cp "$SCRIPT_DIR/SKILL.md" "$SKILL_TEMPLATE"
  chmod 600 "$SKILL_TEMPLATE"
  run_node -e '
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
fi

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
  printf '%s\n' "$token" | "$WRAPPER" configure --api-url "$API_URL" --token-stdin
  token=
fi
chmod 700 "$STATE_ROOT"
chmod 600 "$STATE_ROOT/config.json"

{
  echo '#!/bin/sh'
  printf 'XDG_STATE_HOME=%s\n' "$STATE_HOME_QUOTED"
  echo 'export XDG_STATE_HOME'
  printf 'NODE_PATH=%s\n' "$NODE_QUOTED"
  if [ "$NODE_MODE" = electron ]; then
    echo 'ELECTRON_RUN_AS_NODE=1'
    echo 'export ELECTRON_RUN_AS_NODE'
  fi
  printf 'CONNECTOR=%s\n' "$CONNECTOR_QUOTED"
  printf 'LOG_FILE=%s\n' "$RUNNER_LOG_QUOTED"
  cat <<'EOF'
status=0
printf '%s scheduled sync start\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
if [ ! -x "$NODE_PATH" ]; then
  printf '%s runtime missing: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$NODE_PATH" >>"$LOG_FILE"
  exit 1
fi
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

if [ "$NO_HOOK" -eq 0 ]; then
  # hook 包装脚本用 bash 语法：Windows 上 CodeBuddy 强制用 Git Bash 执行 hook 命令，
  # 两端保持同一种写法更安全。任何异常都只记日志，绝不阻塞 WorkBuddy。
  {
    echo '#!/bin/sh'
    emit_runtime_env
    printf 'HOOK_LOG=%s\n' "$HOOK_LOG_QUOTED"
    cat <<'EOF'
if [ ! -x "$NODE_PATH" ]; then
  message="找不到 WorkBuddy 的 Node 运行时：$NODE_PATH（WorkBuddy 可能已升级或移动，请重跑安装脚本）"
  echo "$message" >&2
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >>"$HOOK_LOG" 2>/dev/null || true
  exit 0
fi
EOF
    printf 'HOOK_ENTRY=%s\n' "$HOOK_ENTRY_QUOTED"
    cat <<'EOF'
if [ ! -f "$HOOK_ENTRY" ]; then
  message="找不到上行 hook 程序：$HOOK_ENTRY（请重跑安装脚本）"
  echo "$message" >&2
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >>"$HOOK_LOG" 2>/dev/null || true
  exit 0
fi
exec "$NODE_PATH" "$HOOK_ENTRY" "$@"
EOF
  } >"$HOOK_WRAPPER"
  chmod 700 "$HOOK_WRAPPER"

  HOOK_COMMAND="bash $(shell_quote "$HOOK_WRAPPER") || true"
  write_settings_helper "$SETTINGS_HELPER"
  if ! run_node "$SETTINGS_HELPER" \
    "$WORKBUDDY_SETTINGS" "$HOOK_EVENT" "$HOOK_MARKER" register "$HOOK_COMMAND" "$HOOK_TIMEOUT"; then
    echo "hook 注册失败：$WORKBUDDY_SETTINGS 未被修改。" >&2
    rm -f "$SETTINGS_HELPER"
    exit 1
  fi
  rm -f "$SETTINGS_HELPER"
fi

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

# 装机时补传近 7 天历史：后台跑，不阻塞安装完成，随时可中断后重跑。
if [ "$NO_IMPORT" -eq 0 ]; then
  nohup "$WRAPPER" import --since 7d </dev/null >>"$IMPORT_LOG" 2>&1 &
  IMPORT_PID=$!
fi

echo "SuperBrain WorkBuddy connector installed for the current user."
echo "Connector command: $WRAPPER"
if [ "$NO_HOOK" -eq 0 ]; then
  echo "Upstream hook registered in: $WORKBUDDY_SETTINGS ($HOOK_EVENT)"
  echo "Hook log: $HOOK_LOG"
fi
if [ "$WITH_DOWNSTREAM" -eq 1 ]; then
  echo "Skill installed at: $INSTALLED_SKILL"
else
  echo "Downstream skill not installed (pass --with-downstream if you need it)."
fi
if [ "$NO_IMPORT" -eq 0 ]; then
  echo "历史补传（近 7 天）已在后台开始（PID ${IMPORT_PID:-?}），不影响安装完成。"
  echo "  进度日志：$IMPORT_LOG"
  echo "  需要重跑：\"$WRAPPER\" import --since 7d"
fi
echo "Run: \"$WRAPPER\" status"
echo "Restart WorkBuddy so it reloads settings.json."
