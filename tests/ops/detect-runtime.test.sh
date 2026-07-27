#!/bin/sh
# connectors/detect-runtime.sh 的行为测试。
#
# 用法：
#   bash tests/ops/detect-runtime.test.sh
#   DETECT_RUNTIME_SH=/path/to/mutant.sh bash tests/ops/detect-runtime.test.sh   # 负控（验红）
#
# 设计要点：
# - 用假的目录结构与假二进制驱动 detect_workbuddy_node，不依赖真机是否装了 WorkBuddy。
# - 假 Electron 只有在收到 ELECTRON_RUN_AS_NODE=1 时才自报版本；漏掉这个环境变量必然变红。
# - 假 node 自报的版本与路径里的数字**故意不一致**，谁靠路径猜版本就会变红。
# - 每个用例都在裁剪过的 PATH 下运行子 shell，确保不会误用真机上的 node。

set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
DETECT=${DETECT_RUNTIME_SH:-$ROOT/connectors/detect-runtime.sh}
[ -f "$DETECT" ] || {
  echo "找不到被测脚本: $DETECT" >&2
  exit 1
}

TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM
EMPTY_BIN="$TEST_ROOT/empty-bin"
mkdir -p "$EMPTY_BIN"

FAILURES=0
CASES=0

pass() {
  CASES=$((CASES + 1))
  echo "ok   - $1"
}

fail() {
  CASES=$((CASES + 1))
  FAILURES=$((FAILURES + 1))
  echo "FAIL - $1" >&2
  shift
  for line in "$@"; do
    echo "       $line" >&2
  done
}

# 假的"普通 node"：无论有没有 ELECTRON_RUN_AS_NODE 都自报版本。
make_plain_node() {
  target=$1
  version=$2
  mkdir -p "$(dirname "$target")"
  cat >"$target" <<EOF
#!/bin/sh
printf '%s\n' "$version"
EOF
  chmod 755 "$target"
}

# 假的 Electron：只有 ELECTRON_RUN_AS_NODE=1 时才当 node 用，否则失败（真机行为）。
make_electron_node() {
  target=$1
  version=$2
  mkdir -p "$(dirname "$target")"
  cat >"$target" <<EOF
#!/bin/sh
if [ "\${ELECTRON_RUN_AS_NODE:-}" != "1" ]; then
  echo "electron: GUI mode, refusing to act as node" >&2
  exit 1
fi
printf '%s\n' "$version"
EOF
  chmod 755 "$target"
}

# 在受控环境里跑一次探测。
# 用法：run_detect <case_dir> [VAR=VALUE ...]
# 结果：$DETECT_STATUS / $DETECT_STDOUT / $DETECT_STDERR
run_detect() {
  case_dir=$1
  shift
  stdout_file="$case_dir/stdout.txt"
  stderr_file="$case_dir/stderr.txt"
  set +e
  env -i \
    HOME="$case_dir/home" \
    PATH="$EMPTY_BIN" \
    "$@" \
    /bin/sh -c '. "$1"; detect_workbuddy_node' sh "$DETECT" \
    >"$stdout_file" 2>"$stderr_file"
  DETECT_STATUS=$?
  set -e
  DETECT_STDOUT=$(cat "$stdout_file")
  DETECT_STDERR=$(cat "$stderr_file")
  DETECT_PATH=$(sed -n 1p "$stdout_file")
  DETECT_MODE=$(sed -n 2p "$stdout_file")
}

new_case() {
  case_dir="$TEST_ROOT/$1"
  mkdir -p "$case_dir/home" "$case_dir/wbhome"
  printf '%s\n' "$case_dir"
}

# ---------------------------------------------------------------------------
# 用例 1：$WORKBUDDY_NODE 覆盖优先生效（即便存在可用的 Electron）
# ---------------------------------------------------------------------------
case_dir=$(new_case override-wins)
make_plain_node "$case_dir/custom/node" "22.21.1"
make_electron_node "$case_dir/App/Contents/MacOS/Electron" "22.21.1"
run_detect "$case_dir" \
  WORKBUDDY_NODE="$case_dir/custom/node" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/App/Contents/MacOS/Electron"
if [ "$DETECT_STATUS" -eq 0 ] &&
  [ "$DETECT_PATH" = "$case_dir/custom/node" ] &&
  [ "$DETECT_MODE" = "plain" ]; then
  pass "WORKBUDDY_NODE 覆盖优先于 Electron 候选，模式为 plain"
else
  fail "WORKBUDDY_NODE 覆盖应优先生效" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 2：假 Electron 存在 → 返回它，且模式为 electron
#         （假 Electron 只在 ELECTRON_RUN_AS_NODE=1 下自报版本）
# ---------------------------------------------------------------------------
case_dir=$(new_case electron-detected)
make_electron_node "$case_dir/App/Contents/MacOS/Electron" "22.21.1"
make_plain_node "$case_dir/wbhome/binaries/node/versions/22.10.1/bin/node" "22.10.1"
run_detect "$case_dir" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/missing/Electron:$case_dir/App/Contents/MacOS/Electron"
if [ "$DETECT_STATUS" -eq 0 ] &&
  [ "$DETECT_PATH" = "$case_dir/App/Contents/MacOS/Electron" ] &&
  [ "$DETECT_MODE" = "electron" ]; then
  pass "Electron 优先于按需下载的 node，模式为 electron（且询问版本时带了 ELECTRON_RUN_AS_NODE=1）"
else
  fail "应命中 Electron 并输出 electron 模式" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 3：无 Electron，versions/{22.9.0,22.10.1} 都在 → 必须选 22.10.1
#         目录名与自报版本一致，但字典序会选错（"22.9.0" > "22.10.1"）
# ---------------------------------------------------------------------------
case_dir=$(new_case highest-version)
make_plain_node "$case_dir/wbhome/binaries/node/versions/22.9.0/bin/node" "22.9.0"
make_plain_node "$case_dir/wbhome/binaries/node/versions/22.10.1/bin/node" "22.10.1"
run_detect "$case_dir" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/missing/Electron"
if [ "$DETECT_STATUS" -eq 0 ] &&
  [ "$DETECT_PATH" = "$case_dir/wbhome/binaries/node/versions/22.10.1/bin/node" ] &&
  [ "$DETECT_MODE" = "plain" ]; then
  pass "多个 versions/* 时取数值最高版本 22.10.1（不是字典序的 22.9.0）"
else
  fail "应选中 22.10.1" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 3b：版本必须来自二进制自报，而不是路径里的数字
#          目录名写 22.99.0，二进制自报 20.19.0 → 必须拒绝
# ---------------------------------------------------------------------------
case_dir=$(new_case version-from-binary)
make_plain_node "$case_dir/wbhome/binaries/node/versions/22.99.0/bin/node" "20.19.0"
run_detect "$case_dir" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/missing/Electron"
if [ "$DETECT_STATUS" -ne 0 ] &&
  ! printf '%s' "$DETECT_STDOUT" | grep -q "22.99.0"; then
  pass "版本取自二进制自报（目录名 22.99.0 但自报 20.19.0 → 拒绝）"
else
  fail "不得根据路径里的数字判定版本" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 4：只有 major < 22 的候选（Electron 20 + versions/20 + PATH node 18）
#         → 必须失败，不得降级选用
# ---------------------------------------------------------------------------
case_dir=$(new_case rejects-old-majors)
make_electron_node "$case_dir/App/Contents/MacOS/Electron" "20.11.1"
make_plain_node "$case_dir/wbhome/binaries/node/versions/20.19.0/bin/node" "20.19.0"
make_plain_node "$case_dir/pathbin/node" "18.20.4"
run_detect "$case_dir" \
  PATH="$case_dir/pathbin" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/App/Contents/MacOS/Electron"
if [ "$DETECT_STATUS" -ne 0 ] && [ -z "$DETECT_STDOUT" ]; then
  pass "所有候选 major<22 时失败退出且不输出任何候选（不降级）"
else
  fail "major<22 的候选必须被拒绝" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 5：全部不存在 → 非 0 退出，且 stderr 有可操作信息
# ---------------------------------------------------------------------------
case_dir=$(new_case nothing-available)
run_detect "$case_dir" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/missing/Electron"
actionable=1
for needle in "WorkBuddy" "启动" "WORKBUDDY_NODE" "22"; do
  printf '%s' "$DETECT_STDERR" | grep -q "$needle" || actionable=0
done
if [ "$DETECT_STATUS" -ne 0 ] && [ -z "$DETECT_STDOUT" ] && [ "$actionable" -eq 1 ]; then
  pass "全部探测失败 → 非 0 退出 + stderr 含可操作中文指引（安装/首次启动/WORKBUDDY_NODE/版本要求）"
else
  fail "失败路径必须给出可操作错误" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 6：PATH 里的 node（major>=22）作为最后回退可用
# ---------------------------------------------------------------------------
case_dir=$(new_case path-node-fallback)
make_plain_node "$case_dir/pathbin/node" "22.21.1"
run_detect "$case_dir" \
  PATH="$case_dir/pathbin" \
  WORKBUDDY_HOME="$case_dir/wbhome" \
  WORKBUDDY_ELECTRON_CANDIDATES="$case_dir/missing/Electron"
if [ "$DETECT_STATUS" -eq 0 ] &&
  [ "$DETECT_PATH" = "$case_dir/pathbin/node" ] &&
  [ "$DETECT_MODE" = "plain" ]; then
  pass "PATH 中的 node 22+ 作为最后回退可用"
else
  fail "PATH 回退失效" \
    "status=$DETECT_STATUS" "stdout=[$DETECT_STDOUT]" "stderr=[$DETECT_STDERR]"
fi

# ---------------------------------------------------------------------------
# 用例 7：内置默认 Electron 候选列表（不依赖真机是否装了 WorkBuddy）
# ---------------------------------------------------------------------------
case_dir=$(new_case default-candidates)
set +e
default_list=$(
  env -i HOME="/fake-home" PATH="$EMPTY_BIN" \
    /bin/sh -c '. "$1"; _wb_electron_candidates' sh "$DETECT" 2>"$case_dir/stderr.txt"
)
default_status=$?
set -e
expected_list="/Applications/WorkBuddy.app/Contents/MacOS/Electron
/fake-home/Applications/WorkBuddy.app/Contents/MacOS/Electron"
if [ "$default_status" -eq 0 ] &&
  [ "$(printf '%s\n' "$default_list" | sed -n '1,2p')" = "$expected_list" ]; then
  pass "默认候选前两项是 /Applications 与 \$HOME/Applications 下的 WorkBuddy.app Electron"
else
  fail "默认 Electron 候选列表不符" \
    "status=$default_status" "list=[$default_list]"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "detect-runtime: $CASES/$CASES 用例通过"
  exit 0
fi
echo "detect-runtime: $FAILURES/$CASES 用例失败" >&2
exit 1
