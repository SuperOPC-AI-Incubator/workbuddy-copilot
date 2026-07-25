#!/bin/sh
# connectors/install-macos.sh 的端到端冒烟：真的跑安装器，真的注册 hook，真的让 hook 产出一条 outbox 事件。
#
# 用法：
#   bash tests/ops/install-macos.test.sh
#   WORKBUDDY_NODE=$(command -v node) bash tests/ops/install-macos.test.sh   # 用普通 node 跑（CI 覆盖 plain 模式）
#   INSTALLER_SRC=/path/to/mutant.sh bash tests/ops/install-macos.test.sh    # 负控（验红）
#   KEEP_SANDBOX=1 bash tests/ops/install-macos.test.sh                      # 失败排障时保留沙箱
#
# 环境要求：一个 Node 22+ 运行时。优先用 $WORKBUDDY_NODE，其次是本机 WorkBuddy 自带的 Electron，
# 再其次是 PATH 里的 node。**一个都探测不到就明确 skip 并退出 0**（CI 上没有 WorkBuddy 属于正常情况），
# 绝不假装通过。
#
# 隔离：所有安装都在 mktemp 沙箱里进行（HOME/XDG_STATE_HOME/WORKBUDDY_HOME 全部改指沙箱），
# 绝不读写真实的 ~/.workbuddy、~/.local 或 ~/Library/LaunchAgents。
set -u

ROOT=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
SB=$(mktemp -d "${TMPDIR:-/tmp}/workbuddy-install-smoke.XXXXXX")
FAILED=0
CASES=0

cleanup() {
  if [ "$FAILED" -eq 0 ] && [ "${KEEP_SANDBOX:-0}" != "1" ]; then
    rm -rf "$SB"
  else
    echo "沙箱保留在：$SB" >&2
  fi
}
trap cleanup EXIT HUP INT TERM

check() {
  CASES=$((CASES + 1))
  if [ "$1" = "0" ]; then
    echo "ok   - $2"
  else
    echo "FAIL - $2"
    FAILED=$((FAILED + 1))
  fi
}

skip() {
  echo "SKIP - install-macos 冒烟未执行：$1"
  echo "       （这是明确跳过，不是通过；需要 Node 22+ 运行时才能跑本用例。）"
  exit 0
}

# ---------------------------------------------------------------------------
# 0) 运行时探测：探不到就 skip（退出 0），并打印原因
# ---------------------------------------------------------------------------
mkdir -p "$SB/probe-home/.workbuddy"
if RUNTIME=$(
  env HOME="$SB/probe-home" WORKBUDDY_HOME="$SB/probe-home/.workbuddy" \
    sh "$ROOT/connectors/detect-runtime.sh" 2>"$SB/detect.err"
); then
  NODE=$(printf '%s\n' "$RUNTIME" | sed -n 1p)
  MODE=$(printf '%s\n' "$RUNTIME" | sed -n 2p)
else
  skip "探测不到 Node 22+ 运行时（没有 WorkBuddy 也没有 \$WORKBUDDY_NODE / PATH node）。
       detect-runtime.sh 的原始输出：
$(sed 's/^/         /' "$SB/detect.err")"
fi
case "$MODE" in
  electron | plain) ;;
  *) skip "detect-runtime.sh 返回了意外的模式：$MODE" ;;
esac
echo "== 运行时：$NODE ($MODE)"

HOOK_SHELL=$(command -v bash 2>/dev/null || command -v sh)
[ -n "$HOOK_SHELL" ] || skip "找不到 bash/sh，无法按 WorkBuddy 的方式调用 hook 包装脚本。"

run_node() {
  if [ "$MODE" = electron ]; then
    ELECTRON_RUN_AS_NODE=1 "$NODE" "$@"
  else
    "$NODE" "$@"
  fi
}

# ---------------------------------------------------------------------------
# 下载目录：public/downloads 的副本（顺带证明学员实际下载到的那份可用）
# ---------------------------------------------------------------------------
mkdir -p "$SB/dl" "$SB/home/.workbuddy" "$SB/state"
cp "${INSTALLER_SRC:-$ROOT/public/downloads/install-macos.sh}" "$SB/dl/install-macos.sh"
cp "$ROOT/public/downloads/detect-runtime.sh" "$SB/dl/"
cp "$ROOT/public/downloads/SKILL.md" \
  "$ROOT/public/downloads/workbuddy-sync.mjs" \
  "$ROOT/public/downloads/workbuddy-hook.mjs" \
  "$ROOT/public/downloads/workbuddy-transcript.mjs" \
  "$ROOT/public/downloads/workbuddy-event-id.mjs" \
  "$SB/dl/"
chmod +x "$SB/dl/install-macos.sh"
INSTALLER="$SB/dl/install-macos.sh"
WRAPPER="$SB/home/.local/bin/workbuddy-sync"
HOOK_WRAPPER="$SB/home/.local/share/superbrain-copilot/workbuddy-hook.sh"

# 学员机上 settings.json 里通常已经有自己的 hook 与其他配置：升级/卸载都不许动它们。
cat >"$SB/home/.workbuddy/settings.json" <<'EOF'
{
    "enabledPlugins": { "demo@x": true },
    "hooks": {
        "Stop": [
            { "hooks": [ { "type": "command", "command": "echo student-own-hook || true", "timeout": 30 } ] }
        ],
        "UserPromptSubmit": [
            { "hooks": [ { "type": "command", "command": "echo keep-me", "timeout": 5 } ] }
        ]
    }
}
EOF

# 所有安装都跑在沙箱里：HOME/XDG_STATE_HOME/WORKBUDDY_HOME 全部改指沙箱。
install_sandbox() {
  sandbox_home=$1
  sandbox_state=$2
  shift 2
  env -u ELECTRON_RUN_AS_NODE \
    HOME="$sandbox_home" XDG_STATE_HOME="$sandbox_state" \
    WORKBUDDY_HOME="$sandbox_home/.workbuddy" \
    "$INSTALLER" "$@"
}

# 直接从安装器提取其实际会落地的 settings helper；不复制实现，确保并发
# 回归测试运行的就是 install-macos.sh 内嵌的真实 payload。
extract_settings_helper() {
  sed -n '/^  cat >"\$1" <<'"'"'SETTINGS_HELPER_EOF'"'"'$/,/^SETTINGS_HELPER_EOF$/p' "$INSTALLER" |
    sed '1d;$d' >"$1"
}

# 本机没有 PowerShell 时，仍从 Windows 安装器的真实 here-string 模板生成
# bash 文件，并以 Windows 的同一 POSIX 单引号规则填入值。两项一起能防止
# 重新引入未转义的路径；有 pwsh 的 Windows CI 还会跑完整的 test-windows.ps1。
generate_windows_hook_fixture() {
  fixture_path=$1
  run_node - "$ROOT/connectors/install-windows.ps1" "$fixture_path" <<'NODE'
const fs = require("node:fs");
const [sourcePath, outputPath] = process.argv.slice(2);
const source = fs.readFileSync(sourcePath, "utf8");
const start = source.indexOf('$hookScript = @"');
const end = source.indexOf('"@\n  Write-TextFileLf -Path $HookWrapper', start);
if (start < 0 || end < 0) throw new Error("cannot find Windows hook template");
const template = source.slice(start, end).split("\n").slice(1).join("\n");
const bashQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const values = {
  hookNodePath: bashQuote("C:/Users/O'Neil/AppData/Local/WorkBuddy.exe"),
  hookEntryPath: bashQuote("C:/Users/O'Neil/AppData/Local/SuperBrainCopilot/app/workbuddy-hook.mjs"),
  hookLogPath: bashQuote("C:/Users/O'Neil/AppData/Local/SuperBrainCopilot/logs/hook.log"),
  localAppData: bashQuote("C:/Users/O'Neil/AppData/Local"),
};
const rendered = template
  .replace(/\$hookNodePath/g, values.hookNodePath)
  .replace(/\$hookEntryPath/g, values.hookEntryPath)
  .replace(/\$hookLogPath/g, values.hookLogPath)
  .replace(/\$localAppData/g, values.localAppData)
  .replace(/\$\(if \(\$runtimeMode -eq "electron"\) \{ "ELECTRON_RUN_AS_NODE=1`nexport ELECTRON_RUN_AS_NODE" \} else \{ "" \}\)/, "")
  // PowerShell's backtick escapes literal shell variables in the here-string.
  .replaceAll("`$", "$");
if (rendered.includes("$hookNodePath") || rendered.includes("$hookEntryPath")) {
  throw new Error("Windows hook template placeholders were not rendered");
}
fs.writeFileSync(outputPath, rendered, "utf8");
NODE
}

echo "== A) 全新安装（$MODE 运行时）"
printf 'wb_smoke_token_123\n' |
  install_sandbox "$SB/home" "$SB/state" \
    --api-url "https://copilot.example.test" --no-schedule --no-import \
    >"$SB/install-a.log" 2>&1
check $? "安装成功退出"
grep -F "Runtime: $NODE ($MODE)" "$SB/install-a.log" >/dev/null
check $? "安装器报告了探测到的运行时与模式（${MODE}）"
grep -F "Downstream skill not installed" "$SB/install-a.log" >/dev/null
check $? "默认不安装下行 SKILL"
test ! -e "$SB/home/.workbuddy/skills/superbrain-sync/SKILL.md"
check $? "SKILL.md 确实没有落地"
if grep -F "wb_smoke_token_123" "$SB/install-a.log" >/dev/null 2>&1; then
  check 1 "安装输出泄露凭证"
else
  check 0 "安装输出不含凭证"
fi
ls "$SB/home/.workbuddy"/settings.json.superbrain-*.bak >/dev/null 2>&1
check $? "改动 settings.json 前留了备份"
if [ "$MODE" = electron ]; then
  grep -F "ELECTRON_RUN_AS_NODE=1" "$WRAPPER" >/dev/null
  check $? "electron 模式 wrapper 导出 ELECTRON_RUN_AS_NODE=1"
else
  if grep -F "ELECTRON_RUN_AS_NODE" "$WRAPPER" >/dev/null 2>&1; then
    check 1 "plain 模式 wrapper 误加了 ELECTRON_RUN_AS_NODE"
  else
    check 0 "plain 模式 wrapper 不含 ELECTRON_RUN_AS_NODE"
  fi
fi
grep -F 'if [ ! -x "$NODE_PATH" ]' "$WRAPPER" >/dev/null
check $? "wrapper 每次运行都校验运行时路径"
for module in workbuddy-sync.mjs workbuddy-hook.mjs workbuddy-transcript.mjs workbuddy-event-id.mjs; do
  cmp "$ROOT/connectors/$module" "$SB/home/.local/share/superbrain-copilot/$module" || break
done
check $? "hook 需要的四个模块都被装到了本机（缺一个就 ERR_MODULE_NOT_FOUND）"

echo "== B) 连接器与 hook 在没有 PATH node 的环境下真跑"
env -i PATH=/usr/bin:/bin HOME="$SB/home" "$WRAPPER" status >"$SB/status.json" 2>&1
check $? "wrapper status 退出 0"
grep -F '"configured":true' "$SB/status.json" >/dev/null
check $? "status 报告已配置"
mkdir -p "$SB/home/.workbuddy/projects/demo"
{
  printf '%s\n' '{"id":"c1faf8f1-0000-4000-8000-000000000001","type":"message","role":"user","timestamp":1784160224762,"content":[{"type":"text","text":"<user_query>hello smoke</user_query>"}]}'
  printf '%s\n' '{"id":"c1faf8f1-0000-4000-8000-000000000002","type":"message","role":"assistant","timestamp":1784160225762,"content":[{"type":"text","text":"hi there"}]}'
} >"$SB/home/.workbuddy/projects/demo/sess-smoke-1.jsonl"
printf '{"hook_event_name":"Stop","session_id":"sess-smoke-1","transcript_path":"%s","cwd":"%s"}' \
  "$SB/home/.workbuddy/projects/demo/sess-smoke-1.jsonl" "$SB" |
  env -i PATH=/usr/bin:/bin HOME="$SB/home" \
    "$HOOK_SHELL" "$HOOK_WRAPPER" >"$SB/hook.log" 2>&1
check $? "hook 包装脚本（bash 调用）退出 0"
ls "$SB/state/superbrain-copilot/outbox"/*.json >/dev/null 2>&1
check $? "hook 真的把一轮对话写进了 outbox"
run_node -e '
  const fs = require("node:fs");
  const dir = process.argv[1];
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const events = files.map((name) => JSON.parse(fs.readFileSync(dir + "/" + name, "utf8")));
  const match = events.find((event) => JSON.stringify(event).includes("hello smoke"));
  if (!match) { console.error("outbox 里没有本轮对话: " + JSON.stringify(events)); process.exit(1); }
  if (!JSON.stringify(match).includes("hi there")) { console.error("assistant 回复没上报"); process.exit(1); }
' "$SB/state/superbrain-copilot/outbox" >"$SB/outbox-check.log" 2>&1
check $? "outbox 事件带着真实的 prompt 与 reply 文本"

echo "== C) 升级重跑：hook 就地替换，学员自己的 hook 保留"
install_sandbox "$SB/home" "$SB/state" upgrade \
  --api-url "https://copilot.example.test" --no-schedule --no-import \
  >"$SB/install-c.log" 2>&1
check $? "升级成功退出"
grep -qx "replaced" "$SB/install-c.log"
check $? "hook 条目是就地替换（不是又追加一条）"
run_node -e '
  const fs = require("node:fs");
  const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const commands = settings.hooks.Stop.flatMap((block) => block.hooks).map((hook) => hook.command);
  const mine = commands.filter((command) => command.includes("workbuddy-hook.sh"));
  if (mine.length !== 1) { console.error("本项目 hook 条目数 = " + mine.length + ": " + JSON.stringify(commands)); process.exit(1); }
  if (!commands.some((command) => command.includes("student-own-hook"))) { console.error("学员自己的 Stop hook 被弄丢了"); process.exit(1); }
  if (settings.hooks.UserPromptSubmit[0].hooks[0].command !== "echo keep-me") { console.error("UserPromptSubmit 被改动"); process.exit(1); }
  if (JSON.stringify(settings.enabledPlugins) !== JSON.stringify({ "demo@x": true })) { console.error("enabledPlugins 被改动"); process.exit(1); }
  const ownHook = settings.hooks.Stop.flatMap((block) => block.hooks).find((hook) => hook.command.includes("workbuddy-hook.sh"));
  if (!ownHook || ownHook.timeout !== 15) { console.error("hook timeout 必须为 15 秒，实际：" + JSON.stringify(ownHook)); process.exit(1); }
' "$SB/home/.workbuddy/settings.json" >"$SB/settings-check.log" 2>&1
check $? "Stop 里本项目 hook 只有一条、学员 hook 与其他配置未被动，且 timeout 为 15 秒"

echo "== C2) settings helper：并发注册不覆盖已有内容"
HELPER="$SB/settings-helper.mjs"
extract_settings_helper "$HELPER"
run_node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ existing: "keep", padding: "x".repeat(8 * 1024 * 1024) }));
' "$SB/concurrent-settings.json"
run_node "$HELPER" "$SB/concurrent-settings.json" Stop workbuddy-hook-a register "bash hook-a" 15 >"$SB/concurrent-a.log" 2>&1 &
HELPER_A=$!
run_node "$HELPER" "$SB/concurrent-settings.json" UserPromptSubmit workbuddy-hook-b register "bash hook-b" 15 >"$SB/concurrent-b.log" 2>&1 &
HELPER_B=$!
wait "$HELPER_A" && status_a=0 || status_a=$?
wait "$HELPER_B" && status_b=0 || status_b=$?
run_node -e '
  const fs = require("node:fs");
  const [settingsPath, a, b] = process.argv.slice(1);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = Object.values(settings.hooks ?? {}).flatMap((blocks) => blocks.flatMap((block) => block.hooks)).map((hook) => hook.command);
  if (a !== "0" || b !== "0" || settings.existing !== "keep" || !commands.includes("bash hook-a") || !commands.includes("bash hook-b")) {
    console.error(JSON.stringify({ a, b, existing: settings.existing, commands })); process.exit(1);
  }
' "$SB/concurrent-settings.json" "$status_a" "$status_b" >"$SB/concurrent-check.log" 2>&1
check $? "两个并发 helper 都合并成功，既有字段与两个 hook 均未丢失"
if find "$SB" -name '*.superbrain.tmp' -o -name '*.superbrain-*.tmp' | grep -q .; then
  check 1 "settings helper 留下了固定或孤立的临时文件"
else
  check 0 "settings helper 的唯一临时文件均已清理"
fi

echo "== C2b) settings helper：崩溃残留的 lock 不会永久阻塞升级"
STALE_SETTINGS="$SB/stale-lock-settings.json"
printf '%s\n' '{"existing":"keep-after-crash"}' >"$STALE_SETTINGS"
printf '%s\n' '{"pid":99999999,"createdAt":0}' >"$STALE_SETTINGS.superbrain.lock"
run_node "$HELPER" "$STALE_SETTINGS" Stop workbuddy-hook-stale register "bash hook-after-crash" 15 \
  >"$SB/stale-lock.log" 2>&1
check $? "死进程遗留的 settings lock 会被安全回收，升级可继续"
run_node -e '
  const fs = require("node:fs");
  const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const commands = settings.hooks.Stop.flatMap((block) => block.hooks).map((hook) => hook.command);
  if (settings.existing !== "keep-after-crash" || !commands.includes("bash hook-after-crash") || fs.existsSync(`${process.argv[1]}.superbrain.lock`)) process.exit(1);
' "$STALE_SETTINGS" >"$SB/stale-lock-check.log" 2>&1
check $? "回收 stale lock 后既有 settings 与新 hook 保留，lock 被清理"

echo "== C3) Windows hook 包装：单引号路径仍能通过 bash -n"
WINDOWS_HOOK_FIXTURE="$SB/windows-hook-with-apostrophe.sh"
generate_windows_hook_fixture "$WINDOWS_HOOK_FIXTURE" >"$SB/windows-hook-generate.log" 2>&1
bash -n "$WINDOWS_HOOK_FIXTURE" >"$SB/windows-hook-syntax.log" 2>&1
check $? "Windows 真实 hook 模板填入 O'Neil 路径后可通过 bash -n"
run_node -e '
  const fs = require("node:fs");
  const source = fs.readFileSync(process.argv[1], "utf8");
  const required = [
    "function ConvertTo-BashSingleQuoted",
    "Get-GitBash",
    "[IO.Path]::GetFullPath($env:WORKBUDDY_NODE)",
    "$HookTimeoutSeconds = 15",
    "randomUUID",
    "settings changed concurrently",
    "$WorkBuddyRoot = Get-WorkBuddyHome",
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length) { console.error("Windows installer missing: " + missing.join(", ")); process.exit(1); }
' "$ROOT/connectors/install-windows.ps1" >"$SB/windows-installer-contract.log" 2>&1
check $? "Windows 安装器验证 Git Bash、绝对 runtime、唯一临时文件/提交前校验、15 秒 timeout 与 WORKBUDDY_HOME"

echo "== D) 运行时消失（模拟 WorkBuddy 升级换路径）"
for target in "$WRAPPER" "$HOOK_WRAPPER"; do
  sed -i.bak "s|^NODE_PATH=.*|NODE_PATH='$SB/gone-away/Electron'|" "$target"
done
env -i PATH=/usr/bin:/bin HOME="$SB/home" "$WRAPPER" status >"$SB/missing.log" 2>&1
test $? -ne 0
check $? "wrapper 在运行时缺失时非 0 退出（不静默）"
grep -F "找不到 WorkBuddy 的 Node 运行时" "$SB/missing.log" >/dev/null
check $? "wrapper 报出可操作错误"
printf '{"hook_event_name":"Stop"}' | env -i PATH=/usr/bin:/bin HOME="$SB/home" \
  "$HOOK_SHELL" "$HOOK_WRAPPER" >"$SB/hook-missing.log" 2>&1
check $? "hook 在运行时缺失时仍退出 0（不阻塞 WorkBuddy）"
grep -F "找不到 WorkBuddy 的 Node 运行时" "$SB/state/superbrain-copilot/logs/hook.log" >/dev/null
check $? "hook 把失败写进了 hook.log（不静默）"
mv "$WRAPPER.bak" "$WRAPPER"
mv "$HOOK_WRAPPER.bak" "$HOOK_WRAPPER"
chmod 700 "$WRAPPER" "$HOOK_WRAPPER"

echo "== E) 不加 --no-import：装机补传在后台，不阻塞安装"
START=$(date +%s)
install_sandbox "$SB/home" "$SB/state" upgrade \
  --api-url "https://copilot.example.test" --no-schedule \
  >"$SB/install-e.log" 2>&1
ELAPSED=$(($(date +%s) - START))
check $? "安装成功退出"
test "$ELAPSED" -le 20
check $? "安装墙钟 ${ELAPSED}s（补传没有阻塞安装）"
grep -F "历史补传（近 7 天）已在后台开始" "$SB/install-e.log" >/dev/null
check $? "提示学员补传在后台、可重跑"
i=0
while [ $i -lt 20 ]; do
  grep -F '"window":"7d"' "$SB/state/superbrain-copilot/logs/import.log" >/dev/null 2>&1 && break
  sleep 1
  i=$((i + 1))
done
grep -F '"window":"7d"' "$SB/state/superbrain-copilot/logs/import.log" >/dev/null
check $? "后台补传按 7d 窗口真的跑了（import.log 有结果）"

echo "== F) 无可用运行时：安装中止"
# 造一个连 node 都没有的 PATH：只把安装器在中止前会用到的外部命令软链进来，不含 node。
NONODE_BIN="$SB/nonode-bin"
mkdir -p "$NONODE_BIN"
for tool in dirname basename sed cat chmod mkdir rm rmdir cp ls uname id date grep awk stty; do
  tool_path=$(command -v "$tool" 2>/dev/null) || continue
  ln -sf "$tool_path" "$NONODE_BIN/$tool"
done
if [ -x "$NONODE_BIN/dirname" ]; then
  rm -rf "$SB/home2" "$SB/state2"
  mkdir -p "$SB/home2"
  printf 'wb_x\n' | env -i PATH="$NONODE_BIN" HOME="$SB/home2" XDG_STATE_HOME="$SB/state2" \
    WORKBUDDY_ELECTRON_CANDIDATES="$SB/home2/nope/Electron" WORKBUDDY_HOME="$SB/home2/.workbuddy" \
    "$INSTALLER" --api-url "https://copilot.example.test" --no-schedule --no-import \
    >"$SB/install-f.log" 2>&1
  test $? -ne 0
  check $? "探测失败时安装非 0 退出"
  grep -F "安装中止：没有可用的 Node 运行时" "$SB/install-f.log" >/dev/null
  check $? "给出中止原因"
  grep -F "是否已至少完整启动过一次 WorkBuddy" "$SB/install-f.log" >/dev/null
  check $? "错误文案可操作（提示确认安装/首次启动）"
  test ! -e "$SB/home2/.local"
  check $? "失败时不留半成品安装"
else
  echo "note - 无法构造无 node 的 PATH（缺 dirname），F 段未执行"
fi

echo "== G) --with-downstream 才安装下行 SKILL"
rm -rf "$SB/home3" "$SB/state3"
mkdir -p "$SB/home3"
printf 'wb_downstream_token_456\n' |
  install_sandbox "$SB/home3" "$SB/state3" \
    --api-url "https://copilot.example.test" --no-schedule --no-import --with-downstream \
    >"$SB/install-g.log" 2>&1
check $? "带 --with-downstream 安装成功"
grep -F "Skill installed at:" "$SB/install-g.log" >/dev/null
check $? "安装器报告了 SKILL 落地位置"
test -f "$SB/home3/.workbuddy/skills/superbrain-sync/SKILL.md"
check $? "--with-downstream 时 SKILL.md 才安装"
if grep -F "__WORKBUDDY_CONNECTOR_ENTRYPOINT__" \
  "$SB/home3/.workbuddy/skills/superbrain-sync/SKILL.md" >/dev/null 2>&1; then
  check 1 "SKILL 占位符未替换"
else
  check 0 "SKILL 占位符已替换"
fi
grep -F "$SB/home3/.local/bin/workbuddy-sync" \
  "$SB/home3/.workbuddy/skills/superbrain-sync/SKILL.md" >/dev/null
check $? "SKILL 指向本机 wrapper 的绝对路径"

# plain 运行时覆盖（只有 PATH 里真有 node 才跑；electron 模式下这段才有额外信息量）
PLAIN_NODE=$(command -v node 2>/dev/null || true)
if [ -n "$PLAIN_NODE" ]; then
  rm -rf "$SB/home4" "$SB/state4"
  mkdir -p "$SB/home4"
  printf 'wb_plain_token_789\n' | env -u ELECTRON_RUN_AS_NODE \
    HOME="$SB/home4" XDG_STATE_HOME="$SB/state4" WORKBUDDY_HOME="$SB/home4/.workbuddy" \
    WORKBUDDY_NODE="$PLAIN_NODE" \
    "$INSTALLER" --api-url "https://copilot.example.test" --no-schedule --no-import \
    >"$SB/install-plain.log" 2>&1
  check $? "WORKBUDDY_NODE 覆盖下安装成功"
  grep -F "(plain)" "$SB/install-plain.log" >/dev/null
  check $? "WORKBUDDY_NODE 覆盖被识别为 plain"
  if grep -F "ELECTRON_RUN_AS_NODE" "$SB/home4/.local/bin/workbuddy-sync" >/dev/null 2>&1; then
    check 1 "plain 模式误加 electron 变量"
  else
    check 0 "plain 模式 wrapper 不含 ELECTRON_RUN_AS_NODE"
  fi
else
  echo "note - PATH 里没有 node，plain 覆盖那一段未执行"
fi

echo "== G2) WORKBUDDY_HOME 覆盖贯穿 settings 与 Skill 安装位置"
rm -rf "$SB/home5" "$SB/state5" "$SB/alternate-workbuddy"
mkdir -p "$SB/home5" "$SB/alternate-workbuddy"
cat >"$SB/alternate-workbuddy/settings.json" <<'EOF'
{"existing":"custom-workbuddy-home"}
EOF
printf 'wb_home_override_token_012\n' | env -u ELECTRON_RUN_AS_NODE \
  HOME="$SB/home5" XDG_STATE_HOME="$SB/state5" WORKBUDDY_HOME="$SB/alternate-workbuddy" \
  "$INSTALLER" --api-url "https://copilot.example.test" --no-schedule --no-import --with-downstream \
  >"$SB/install-home-override.log" 2>&1
check $? "非默认 WORKBUDDY_HOME 下安装成功"
run_node -e '
  const fs = require("node:fs");
  const [settingsPath, skillPath, defaultSettings] = process.argv.slice(1);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const hooks = settings.hooks?.Stop ?? [];
  const hasMine = hooks.flatMap((block) => block.hooks ?? []).some((hook) => hook.command?.includes("workbuddy-hook.sh"));
  if (settings.existing !== "custom-workbuddy-home" || !hasMine || !fs.existsSync(skillPath) || fs.existsSync(defaultSettings)) {
    console.error(JSON.stringify({ settings, skillPath, defaultSettings })); process.exit(1);
  }
' "$SB/alternate-workbuddy/settings.json" "$SB/alternate-workbuddy/skills/superbrain-sync/SKILL.md" \
  "$SB/home5/.workbuddy/settings.json" >"$SB/home-override-check.log" 2>&1
check $? "settings 与下行 Skill 都落在 WORKBUDDY_HOME，默认目录未被误写"

echo "== H) uninstall：摘 hook、留学员 hook、删文件"
SOLO_UNINSTALL_DIR="$SB/solo-uninstall"
mkdir -p "$SOLO_UNINSTALL_DIR"
cp "$INSTALLER" "$SOLO_UNINSTALL_DIR/install-macos.sh"
chmod 700 "$SOLO_UNINSTALL_DIR/install-macos.sh"
test ! -e "$SOLO_UNINSTALL_DIR/detect-runtime.sh"
check $? "卸载用的目录刻意不含 detect-runtime.sh"
env HOME="$SB/home" XDG_STATE_HOME="$SB/state" WORKBUDDY_HOME="$SB/home/.workbuddy" \
  "$SOLO_UNINSTALL_DIR/install-macos.sh" uninstall >"$SB/uninstall.log" 2>&1
check $? "卸载成功退出"
run_node -e '
  const fs = require("node:fs");
  const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const commands = settings.hooks.Stop.flatMap((block) => block.hooks).map((hook) => hook.command);
  if (commands.some((command) => command.includes("workbuddy-hook.sh"))) { console.error("本项目 hook 没摘干净: " + JSON.stringify(commands)); process.exit(1); }
  if (!commands.some((command) => command.includes("student-own-hook"))) { console.error("学员自己的 Stop hook 被弄丢了"); process.exit(1); }
' "$SB/home/.workbuddy/settings.json" >"$SB/uninstall-check.log" 2>&1
check $? "本项目 hook 已摘除、学员 hook 保留"
test ! -d "$SB/home/.local/share/superbrain-copilot"
check $? "程序文件已删除"
test -f "$SB/state/superbrain-copilot/config.json"
check $? "队列与配置保留"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "install-macos 冒烟：$CASES/$CASES 项通过（运行时 ${MODE}）"
  exit 0
fi
echo "install-macos 冒烟：$FAILED/$CASES 项失败（运行时 ${MODE}）" >&2
exit 1
