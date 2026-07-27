#!/bin/sh
# WorkBuddy 运行时探测（POSIX sh，可被 install-macos.sh 用 `.` source）。
#
# detect_workbuddy_node()
#   成功：stdout 打印两行 —— 第 1 行是 node 可执行文件的绝对路径，
#         第 2 行是 "electron"（须带 ELECTRON_RUN_AS_NODE=1 调用）或 "plain"。
#   失败：返回非 0，并向 stderr 打印可操作的中文错误。绝不静默降级。
#
# 探测顺序（先命中先用）：
#   1) $WORKBUDDY_NODE                     显式覆盖
#   2) WorkBuddy 自带的 Electron 二进制    "装了 WorkBuddy 就必然存在"的运行时
#   3) $HOME/.workbuddy/binaries/node/versions/*/bin/node（按需下载，只能作回退）
#   4) PATH 里的 node
#
# 环境变量（供测试与非默认安装位置使用）：
#   WORKBUDDY_NODE                 显式指定运行时（最高优先级）
#   WORKBUDDY_NODE_MODE            配合 WORKBUDDY_NODE 显式声明 electron|plain
#   WORKBUDDY_ELECTRON_CANDIDATES  ":" 分隔的 Electron 候选路径，覆盖内置默认列表
#   WORKBUDDY_HOME                 WorkBuddy 数据目录，默认 $HOME/.workbuddy
#
# 版本判定一律**实际询问二进制**（`-p 'process.versions.node'`），
# 绝不从路径里的数字字符串推断。

WORKBUDDY_NODE_MINIMUM_MAJOR=22
_WB_NEWLINE='
'
_WB_CARRIAGE_RETURN=$(printf '\r')

# 把可能的相对路径变成绝对路径（只用内建展开，不依赖 dirname/basename，
# 以便在被裁剪过的 PATH 下仍可工作）。
_wb_absolute_path() {
  case $1 in
    /*)
      printf '%s\n' "$1"
      return 0
      ;;
  esac
  case $1 in
    */*)
      _wb_abs_dir=${1%/*}
      _wb_abs_base=${1##*/}
      ;;
    *)
      _wb_abs_dir=.
      _wb_abs_base=$1
      ;;
  esac
  _wb_abs_resolved=$(CDPATH= cd "$_wb_abs_dir" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "${_wb_abs_resolved%/}" "$_wb_abs_base"
}

# 把 "22.10.1" 变成可数值比较的键；非法输入返回非 0。
# 注意：22.9.0 < 22.10.1，所以必须数值比较，不能按字典序。
_wb_version_key() {
  _wb_vk_value=${1%%[-+]*}
  case $_wb_vk_value in
    "" | *[!0-9.]* | .* | *.)
      return 1
      ;;
  esac
  _wb_vk_major=${_wb_vk_value%%.*}
  _wb_vk_rest=${_wb_vk_value#*.}
  if [ "$_wb_vk_rest" = "$_wb_vk_value" ]; then
    _wb_vk_minor=0
    _wb_vk_patch=0
  else
    _wb_vk_minor=${_wb_vk_rest%%.*}
    _wb_vk_patch=${_wb_vk_rest#*.}
    if [ "$_wb_vk_patch" = "$_wb_vk_rest" ]; then
      _wb_vk_patch=0
    else
      _wb_vk_patch=${_wb_vk_patch%%.*}
    fi
  fi
  [ -n "$_wb_vk_major" ] || return 1
  [ -n "$_wb_vk_minor" ] || _wb_vk_minor=0
  [ -n "$_wb_vk_patch" ] || _wb_vk_patch=0
  printf '%s\n' "$((_wb_vk_major * 1000000 + _wb_vk_minor * 1000 + _wb_vk_patch))"
}

_wb_version_major() {
  _wb_vm_value=${1%%[-+]*}
  _wb_vm_major=${_wb_vm_value%%.*}
  case $_wb_vm_major in
    "" | *[!0-9]*)
      return 1
      ;;
  esac
  printf '%s\n' "$_wb_vm_major"
}

# 询问候选二进制自报的 node 版本。$1=模式(electron|plain) $2=路径
# electron 模式必须带 ELECTRON_RUN_AS_NODE=1，否则 Electron 会当 GUI 启动。
_wb_probe_node_version() {
  _wb_probe_mode=$1
  _wb_probe_path=$2
  [ -n "$_wb_probe_path" ] || return 1
  [ -f "$_wb_probe_path" ] || return 1
  [ -x "$_wb_probe_path" ] || return 1
  if [ "$_wb_probe_mode" = electron ]; then
    _wb_probe_output=$(
      ELECTRON_RUN_AS_NODE=1 "$_wb_probe_path" -p 'process.versions.node' 2>/dev/null
    ) || return 1
  else
    _wb_probe_output=$("$_wb_probe_path" -p 'process.versions.node' 2>/dev/null) || return 1
  fi
  # 只取第一行并去掉可能的 CR（Windows 换行）与首尾空格
  _wb_probe_output=${_wb_probe_output%%"$_WB_NEWLINE"*}
  _wb_probe_output=${_wb_probe_output%"$_WB_CARRIAGE_RETURN"}
  _wb_probe_output=${_wb_probe_output# }
  _wb_probe_output=${_wb_probe_output% }
  [ -n "$_wb_probe_output" ] || return 1
  _wb_version_key "$_wb_probe_output" >/dev/null || return 1
  printf '%s\n' "$_wb_probe_output"
}

# 候选是否满足最低 major 版本
_wb_version_is_supported() {
  _wb_vis_major=$(_wb_version_major "$1") || return 1
  [ "$_wb_vis_major" -ge "$WORKBUDDY_NODE_MINIMUM_MAJOR" ] || return 1
}

_wb_electron_candidates() {
  if [ -n "${WORKBUDDY_ELECTRON_CANDIDATES:-}" ]; then
    # 只用内建展开切分 ":"，本文件因此不依赖任何外部命令（PATH 被裁剪也能跑）。
    _wb_candidate_list=$WORKBUDDY_ELECTRON_CANDIDATES
    while [ -n "$_wb_candidate_list" ]; do
      case $_wb_candidate_list in
        *:*)
          printf '%s\n' "${_wb_candidate_list%%:*}"
          _wb_candidate_list=${_wb_candidate_list#*:}
          ;;
        *)
          printf '%s\n' "$_wb_candidate_list"
          _wb_candidate_list=
          ;;
      esac
    done
    return 0
  fi
  # 已实测：WorkBuddy 是腾讯 CodeBuddy 的 Electron 应用，mac 上二进制名就是 `Electron`。
  printf '%s\n' "/Applications/WorkBuddy.app/Contents/MacOS/Electron"
  [ -n "${HOME:-}" ] && printf '%s\n' "$HOME/Applications/WorkBuddy.app/Contents/MacOS/Electron"
  # 以下候选未实测，仅作为改名安装的兜底。
  printf '%s\n' "/Applications/CodeBuddy.app/Contents/MacOS/Electron"
  [ -n "${HOME:-}" ] && printf '%s\n' "$HOME/Applications/CodeBuddy.app/Contents/MacOS/Electron"
  return 0
}

_wb_workbuddy_home() {
  if [ -n "${WORKBUDDY_HOME:-}" ]; then
    printf '%s\n' "${WORKBUDDY_HOME%/}"
  else
    printf '%s\n' "${HOME:-}/.workbuddy"
  fi
}

detect_workbuddy_node() {
  _wb_home=$(_wb_workbuddy_home)

  # 1) 显式覆盖
  if [ -n "${WORKBUDDY_NODE:-}" ]; then
    _wb_override=$(_wb_absolute_path "$WORKBUDDY_NODE") || _wb_override=$WORKBUDDY_NODE
    case "${WORKBUDDY_NODE_MODE:-}" in
      electron | plain)
        _wb_override_mode=$WORKBUDDY_NODE_MODE
        if _wb_override_version=$(_wb_probe_node_version "$_wb_override_mode" "$_wb_override"); then
          if _wb_version_is_supported "$_wb_override_version"; then
            printf '%s\n%s\n' "$_wb_override" "$_wb_override_mode"
            return 0
          fi
          _wb_fail "WORKBUDDY_NODE=$_wb_override 自报版本 $_wb_override_version，低于要求的 ${WORKBUDDY_NODE_MINIMUM_MAJOR}。"
          return 1
        fi
        _wb_fail "WORKBUDDY_NODE=$_wb_override 无法以 $_wb_override_mode 模式运行（不可执行或不是 Node 运行时）。"
        return 1
        ;;
    esac
    # 未声明模式：按文件名猜先试哪一种（只是试探顺序，版本仍由二进制自报）。
    # 名字不是 node 的候选先按 electron 试，避免把 Electron 当普通 node 启动出 GUI。
    case "${_wb_override##*/}" in
      node | node.exe) _wb_override_order="plain electron" ;;
      *) _wb_override_order="electron plain" ;;
    esac
    for _wb_override_mode in $_wb_override_order; do
      if _wb_override_version=$(_wb_probe_node_version "$_wb_override_mode" "$_wb_override"); then
        if _wb_version_is_supported "$_wb_override_version"; then
          printf '%s\n%s\n' "$_wb_override" "$_wb_override_mode"
          return 0
        fi
        _wb_fail "WORKBUDDY_NODE=$_wb_override 自报版本 $_wb_override_version，低于要求的 ${WORKBUDDY_NODE_MINIMUM_MAJOR}。"
        return 1
      fi
    done
    _wb_fail "WORKBUDDY_NODE=$_wb_override 不可用（不存在、不可执行，或不是 Node/Electron 运行时）。"
    return 1
  fi

  # 2) WorkBuddy 自带的 Electron 运行时（唯一"装了 WorkBuddy 就必然存在"的运行时）
  _wb_electron_seen=
  # 用 heredoc 而不是管道，逐行读取以容忍路径里的空格，且保持在当前 shell 里（可 return）。
  while IFS= read -r _wb_candidate; do
    [ -n "$_wb_candidate" ] || continue
    _wb_electron_seen="${_wb_electron_seen}     $_wb_candidate
"
    _wb_candidate_version=$(_wb_probe_node_version electron "$_wb_candidate") || continue
    _wb_version_is_supported "$_wb_candidate_version" || continue
    printf '%s\n%s\n' "$_wb_candidate" "electron"
    return 0
  done <<WORKBUDDY_ELECTRON_CANDIDATE_LIST
$(_wb_electron_candidates)
WORKBUDDY_ELECTRON_CANDIDATE_LIST

  # 3) WorkBuddy 按需下载的 node（可能不存在）：取 major >= 22 的最高版本
  _wb_best_path=
  _wb_best_version=
  _wb_best_key=
  for _wb_candidate in \
    "$_wb_home"/binaries/node/versions/*/bin/node \
    "$_wb_home"/binaries/node/versions/*/node; do
    [ -f "$_wb_candidate" ] || continue
    _wb_candidate_version=$(_wb_probe_node_version plain "$_wb_candidate") || continue
    _wb_version_is_supported "$_wb_candidate_version" || continue
    _wb_candidate_key=$(_wb_version_key "$_wb_candidate_version") || continue
    if [ -z "$_wb_best_key" ] || [ "$_wb_candidate_key" -gt "$_wb_best_key" ]; then
      _wb_best_key=$_wb_candidate_key
      _wb_best_path=$_wb_candidate
      _wb_best_version=$_wb_candidate_version
    fi
  done
  if [ -n "$_wb_best_path" ]; then
    printf '%s\n%s\n' "$_wb_best_path" "plain"
    return 0
  fi

  # 4) PATH 里的 node
  if _wb_path_node=$(command -v node 2>/dev/null); then
    if _wb_path_node=$(_wb_absolute_path "$_wb_path_node"); then
      if _wb_path_version=$(_wb_probe_node_version plain "$_wb_path_node"); then
        if _wb_version_is_supported "$_wb_path_version"; then
          printf '%s\n%s\n' "$_wb_path_node" "plain"
          return 0
        fi
      fi
    fi
  fi

  _wb_fail "未找到可用的 Node 运行时（需要 ${WORKBUDDY_NODE_MINIMUM_MAJOR} 或更高版本）。
已按顺序检查：
  1) \$WORKBUDDY_NODE（未设置或不可用）
  2) WorkBuddy 自带的 Electron 运行时：
${_wb_electron_seen}  3) $_wb_home/binaries/node/versions/*/bin/node（WorkBuddy 按需下载，可能尚未下载）
  4) PATH 中的 node（缺失或低于 ${WORKBUDDY_NODE_MINIMUM_MAJOR}）
请确认：
  - WorkBuddy 是否已安装（macOS 默认位置：/Applications/WorkBuddy.app）
  - 是否已至少完整启动过一次 WorkBuddy（首次启动才会创建 $_wb_home）
  - 若装在非默认位置，可显式指定：WORKBUDDY_NODE=/绝对路径/到/运行时 再重跑本安装脚本
（未探测到运行时时不会继续安装，以免装出一个永远不同步的 hook。）"
  return 1
}

_wb_fail() {
  printf '%s\n' "$1" >&2
}

# 直接执行（而非被 source）时，输出探测结果，便于排障：sh detect-runtime.sh
case "${0##*/}" in
  detect-runtime.sh)
    detect_workbuddy_node
    ;;
esac
