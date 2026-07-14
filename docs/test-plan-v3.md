---
title: WorkBuddy Copilot 测试方案 v3（跨平台学员客户端）
date: 2026-07-10
status: active
audience: both
tags: [testing, cross-platform, student-client, closed-loop]
---

# WorkBuddy Copilot 测试方案 v3（跨平台学员客户端）

本方案是跨平台重构的权威测试方案。它完整保留
[`test-plan-v2.md`](test-plan-v2.md) 的业务判据，并增加平台边界、真实组件、
Windows 实机证据、隔离和防假绿门。v2 保留为历史来源；v3 只能增强判据，不能放宽
或删除 v2 的任何验收要求。

## 1. 运行约定与总门

所有命令从仓库根运行：

```bash
PY=venv/bin/python
```

默认开发机总门：

```bash
$PY -m pytest tests/test_platform_imports.py -q
$PY -m pytest tests/ -q
git diff --check
```

当前已经有测试、可在本工作树返回 0 的精确门如下。业务全量当前只在已安装默认
server + macOS 依赖的开发环境执行；Windows/Linux 本阶段只宣称 Student Core 平台合同，
不把尚未迁移的业务测试伪装成对应平台 lane：

```bash
$PY -m pytest tests/test_platform_imports.py -q
$PY -m pytest tests/test_analysis_service.py tests/test_store.py tests/test_store_mentor.py -q
$PY -m pytest tests/test_connections.py tests/test_message_service.py -q
$PY -m pytest tests/e2e/test_mentor_ui.py -q
$PY -m pytest -q
```

marker 已严格注册，但 `unit/integration/component/server/macos/windows` 会随重构逐 Task
迁移测试；在相应 marker 至少有一个已收集测试且 CI 证明返回 0 前，它们只是未来选择器，
不是当前 gate。

三系统当前平台合同命令如下：

```bash
# Linux server/core
python3 -m venv .venv-linux
.venv-linux/bin/python -m pip install pytest -r requirements-server.txt -r requirements-core.txt
.venv-linux/bin/python -m pytest tests/test_platform_imports.py -q

# macOS client/core
python3 -m venv .venv-macos
.venv-macos/bin/python -m pip install pytest -r requirements-macos.txt
.venv-macos/bin/python -m pytest tests/test_platform_imports.py -q
```

Windows 原生 PowerShell：

```powershell
py -3 -m venv .venv-win
.\.venv-win\Scripts\python.exe -m pip install pytest -r requirements-windows.txt
.\.venv-win\Scripts\python.exe -m pytest tests/test_platform_imports.py -q
```

若 WorkBuddy Hook 的 Git Bash 环境需要复跑同一合同，使用已经由 PowerShell 建好的 venv：

```bash
./.venv-win/Scripts/python.exe -m pytest tests/test_platform_imports.py -q
```

`critical` 用例缺依赖、运行时 skip 或 collection-time `importorskip` 都是失败，输出必须
明确包含 `critical`。普通可选测试仍允许 skip。任何关键 lane 出现未登记 skip，都不能
宣称该 lane 通过。

## 2. 测试层级矩阵

| 层级 | 验证范围 | Linux | macOS | Windows | 允许替身 |
|---|---|:---:|:---:|:---:|---|
| Contract | REST/WS payload、Hook envelope、双轴状态、适配器结果、import 边界 | 必跑 | 必跑 | 必跑 | 仅序列化输入夹具 |
| Unit | 状态机、去重、队列、退避、路径无关逻辑 | 必跑 | 必跑 | 必跑 | fake clock/ID/jitter |
| Integration | 真临时 Store、假 LLM 固定 dict、脱敏 WorkBuddy fixture | server/core | Mac fixture | W0 后 Win fixture | 禁止 mock 被测 service/adapter |
| Component | 真 uvicorn、真 socket/WS、真 Hook 子进程、无头 Agent、真浏览器 | 必跑 | 必跑 | W1 后必跑 | 外部 LLM 可用假实现 |
| Real-machine | WorkBuddy、安装/升级、休眠唤醒、原生 UI/系统行为 | server 发布冒烟 | 发布门 | W0/W1 发布门 | 不允许伪造平台事实 |

测试 marker 必须使用严格注册：`critical`、`contract`、`unit`、`integration`、
`component`、`real_machine`、`server`、`core`、`macos`、`windows`。平台无关
Student Core 的完整导入树不得加载 `AppKit`、`Foundation`、`objc` 或 `fcntl`。

## 3. 隔离与确定性规则

1. 每个测试使用独立临时 `HOME`、`USERPROFILE`、`APPDATA`、SQLite、spool 和配置；
   服务端测试把真实用户目录设为 forbidden sentinel，访问即失败。
2. 组件测试使用预绑定端口 `0` 并把实际地址注入客户端，禁止固定占用 8765/18765。
3. 自动化默认禁止外网，只允许 in-process 或 loopback；真 DeepSeek 和公网域名只在发布
   冒烟使用。
4. 时间、重试和排序注入 fake clock/sleeper/ID；禁止用固定 `sleep` 证明正确性。
5. fixture 必须有确定性内容，并断言具体内容；禁止仅断言非空、无异常或某函数被调用。
6. Service 集成必须使用真临时 Store + 假 LLM 固定 dict 驱动真业务链，禁止 patch 被测
   Service。
7. 每个临时探针使用独立临时子目录，由自己的 context/finalizer 清理；禁止扫描或删除
   其他并发测试的探针命名空间。
8. 诊断测试使用注入的假探针和脱敏系统 fixture，禁止扫描开发机的真实环境、凭据或
   用户目录。环境变量只断言“已配置/未配置”，测试输出不得包含其值。
9. 学员问答集成测试必须用真临时 Store + 确定性假 LLM 验证完整上下文组合和持久化；
   只断言“调用了 LLM”或 patch 掉上下文组装层不算通过。
10. 自动化默认无外网；LLM capability 的凭据缺失、上游失败和重试分支由确定性假输入驱动，
    不把真 TokenHub/DeepSeek 调用作为自动验收前置。

推荐的本地隔离总门：

```bash
TMP_HOME="$(mktemp -d)"
HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" APPDATA="$TMP_HOME/AppData" \
  $PY -m pytest -m "not real_machine" -q
rm -rf "$TMP_HOME"
```

## 4. Breaker（负控）登记

每个关键验收项在宣布通过前必须“见过红”。breaker 只用于证明测试有效，最终实现中
必须撤销，并在 `docs/dev-log.md` 记录 RED/GREEN 命令和摘要。

| 领域 | 必备 breaker | 预期失败 |
|---|---|---|
| 服务端本地 FS 红线 | fixture 中加入读取 WorkBuddy HOME 的坏 server 模块；另用 forbidden HOME 运行 | P0-6/S3 红 |
| Student Core 隔离 | 临时加入 AppKit 或 fcntl import | 平台 contract 红 |
| critical skip | critical 用例运行时 skip；critical 模块 collection importorskip | 测试进程非零且含 `critical` |
| WorkBuddy schema | 缺表/缺列/新增列/locked/corrupt fixture | 返回 typed failure，不能 silent empty |
| Hook | 坏 stdin、文件消失/无权限/超大/UTF-8 截断、网络不可用 | 2 秒内 exit 0，事件安全落 spool |
| spool/WS | 重复、乱序、半开、断在“落库后 publish 前” | 不丢、不重、不错投 |
| 鉴权 | student token 访问 mentor、public 空 token、日志泄 token | 请求或日志门失败 |
| 双轴状态 | 传输 stored 后令诊断失败；同 SHA 重试诊断 | transfer 保持 stored，analysis=failed 后可重试 |
| UI | 移除主线程 dispatch、状态来源改为本地猜测、使用 innerHTML、断 WS | component/E2E 红 |
| 诊断脱敏 | 暂时跳过 token/Authorization/邮箱/主目录替换，或改为返回环境变量值 | SA-4 红，且确定性秘密字符串出现在输出断言中 |
| 问答上下文 | 移除五层任一层，把消息从中间截断，或让未同步 session 回退到其他会话 | SA-5/SA-6 红，假 LLM 收到的确定性标记缺失或串话 |
| LLM capability | 把 `disabled/missing_api_key/misconfigured/timeout/upstream_error` 合并为“LLM 未启动” | SA-7 红，结构化状态和自检建议不匹配 |
| 会话选择 | 让快捷项使用独立数据源，或去掉“任务在前”分组 | SA-1 红，下拉框与最近 3 项顺序/选中值不同步 |
| 大型本地对话集 | 恢复“把全部 transcript 正文读入单一聚合索引” | SA-9 红，无关文件超过固定总预算后目标会话不可读 |

### 4.1 当前 MVP 学员身份负控

当前共享 `student_token` 只证明“学员端”角色；HTTP 请求体、查询参数和 `/ws` 的
`student_id` 仍由客户端提供。持有共享 token 的客户端可冒充其他学员，读取或确认其
消息，或以其身份连接 WebSocket；按 `student_id` 存储查询不是授权隔离，当前部署不得
称为学员级或租户级数据隔离。

`auth.student_tokens` 与 `student_id_for_token()` 本期仅是未接线路由的迁移接缝。测试须
证明唯一匹配可解析，缺失、格式异常、空、未知及重复 token 歧义均 fail closed，同时
共享 token 和现有 HTTP/WS 行为不变。只有未来路由从认证 principal 派生 `student_id`
并拒绝客户端不匹配值后，才能缓解上述风险。

## 5. 上传请求双轴状态

内容传输和 LLM 诊断必须独立持久化、独立展示：

| 状态轴 | 合法状态 | 终态与重试 |
|---|---|---|
| 内容传输 | `pending -> running -> stored` 或 `failed` | `stored` 内容可复用；`failed` 可重新传输 |
| LLM 诊断 | `not_requested -> pending -> running -> done` 或 `failed` | `failed` 可只重跑诊断，不重传同 SHA 内容 |

服务端拒绝非法状态回退。导师台必须展示两轴真实状态、错误原因和重试结果；客户端只
上报进度，不把“内容已存”伪装成“诊断完成”。相应合同、Store 集成、Service 集成、
浏览器 component 和系统 E2E 均须覆盖。

## 6. Windows 实机门

### W0：事实发现门

在真实 Windows WorkBuddy 上只读采集并脱敏：版本/build、configDir、Hook 配置位置与
格式、Git Bash/Python 调用、DB schema/WAL/锁、transcript 映射、Unicode/空格/盘符/
UNC/长路径、当前会话可靠信号、登录自启、休眠唤醒与杀软行为。

通过物：脱敏 fixture、manifest、版本、探测日志和确认记录。缺任一项时，所有依赖
Windows WorkBuddy 事实的结果必须标为 `BLOCKED: real-machine evidence missing`，
不得 skip 后宣称支持。

### W1：适配器验收门

在 W0 的真实临时副本上完成：sessions/workspaces/transcript 读取、typed failure、Hook
幂等注册/升级/恢复、真 Hook 子进程 deadline、无头 Agent spool 消费/loopback 上传/
断线续传/接收导师命令，以及中文用户名、文件锁、休眠唤醒和登录自启验证。

本期 Windows 正式浮标 UI 不在范围；无头 Agent 只回执 `received`，不得伪造
`displayed`。

## 7. v2 逐项迁移映射

下表中“保留”表示原命令和判据继续是最低门；“增强”表示在不改变原判据的前提下追加
跨平台或真实组件证据。

### P0 生存测试

| v2 ID | v3 处理 |
|---|---|
| P0-1 | 保留依赖可导入；增强为 server/core/macos/windows 各自安装与 import 门。 |
| P0-2 | 保留 FastAPI app 构建；在 Linux server lane 必跑。 |
| P0-3 | 保留组合根构建；增强为组合根不得把 fcntl/PyObjC 泄漏到 core/windows。 |
| P0-4 | 保留全量 `pytest tests/ -q`；增加按 marker/OS 发布的 lane 清单，critical skip 失败。 |
| P0-5 | 原样保留多 worker 拒绝启动。 |
| P0-6 | 保留 server 不读学员 FS；增强为全 server import graph、拼接绕过 breaker、forbidden-HOME runtime sentinel。 |
| P0-7 | 原样保留 public/prod 空 token 拒绝与 local/dev 兼容。 |
| P0-8 | 保留公网参数判据；增加 macOS/Windows 安装与 URL 构建的可执行行为验证。 |

### P1 核心、反向通道与公网补强

| v2 ID | v3 处理 |
|---|---|
| P1-1 | 保留字节 transcript 解析与坏行跳过；增加尾部 UTF-8 截断 breaker。 |
| P1-2 | 原样保留 Store CRUD、新表、全文、FK cascade。 |
| P1-3 | 原样保留 worst severity 与 last diagnosis 双语义。 |
| P1-4 | 原样保留 timeline 补列与排序。 |
| P1-5 | 原样保留真 Store + 假 LLM 的 handle_stop 集成和三事件；禁止 mock 被测 Service。 |
| P1-6 | 保留 LLM 解析/降级；增强为失败必须显式持久化，不得吞异常后标 done。 |
| P1-7 | 原样保留 `/report` 分流、202、BackgroundTask 和 Service 边界。 |
| P1-8 | 原样保留导师 API 与 DI、禁止 service 反向依赖。 |
| P1-9 | 保留尾部字节、student_id/token、异常 exit 0；增强为真子进程、有界尾读、本地 spool、无网络、2 秒 deadline。 |
| P1-10 | 保留内存 state、textContent、补拉和发消息；增强为真实浏览器行为证据。 |
| P1-11 | 原样保留 WSRegistry 双池、定向与隔离。 |
| P1-12 | 原样保留超时剔除且不影响健康连接。 |
| P1-13 | 原样保留先落库、送达、补拉和 message_id 幂等。 |
| P1-14 | 原样保留 6 表单事务级联与 FK。 |
| P1-15 | 原样保留双角色 token 权限边界。 |
| P1-16 | 保留前端 REST/WS token 与 401 提示；增强为真浏览器请求验证。 |
| P1-17 | 保留 pending/running/done/failed；增强为内容传输与诊断双轴状态和非法回退拒绝。 |
| P1-18 | 原样保留 session owner 防串号。 |
| P1-19 | 保留内容入库、诊断失败可见、同 SHA 可重试；增强为只重跑 analysis 不重传 stored 内容。 |
| P1-20 | 原样保留旧 mentor WS 不在 runtime tree 且不可误用。 |
| P1-21 | 原样保留过程提醒提示词可更新及“少而准”。 |
| P1-22 | 原样保留学员问答当前会话优先、最近分析回退和 LLM 降级。 |
| P1-23 | 保留当前会话跟随语义；抽为共享 policy + OS adapter contract；未知时返回 unknown，不猜 active。 |
| P1-24 | 保留未接线身份 resolver 的 fail-closed 单测、共享 token 回归和示例配置合同；不得把 resolver 存在误报为路由已隔离。 |

### 前端 FE 与视觉 V

| v2 ID | v3 处理 |
|---|---|
| FE-1 | 保留三栏和真实学员数据；route-mock 仅算 component，不单独称 E2E。 |
| FE-2 | 保留会话/时间线/三类型颜色和 B3 状态不被刷绿。 |
| FE-3 | 保留实时三事件；增强为真 uvicorn/WS/Store/浏览器系统 E2E。 |
| FE-4 | 保留消息仅目标学员收到及已送达；增强为真实无头 Student Core 客户端。 |
| FE-5 | 原样保留 textContent/XSS 回归。 |
| FE-6 | 保留断线补拉无缺口无重复；增强为真 socket 与进程重连。 |
| FE-7 | 保留 mentor token 和认证失败提示；增强为浏览器发出的真实 REST/WS 请求。 |
| FE-8 | 保留离线 pending→重连执行→done/failed+重试；展示双轴真实状态。 |
| FE-9 | 保留学员端布局语义；macOS 做自动化+真机，Windows 正式 UI 后置且不伪造。 |
| V-1 | 保留三栏、状态点、类型色和已见红取色负控；仍属 mentor UI component。 |
| V-2 | 原样保留 mentor_message 气泡样式及移除样式负控。 |

### 端到端场景与发布门

| v2 ID | v3 处理 |
|---|---|
| S1 | 原样保留多学员数据、API 和 session owner 隔离。 |
| S2 | 保留定向/回显/离线补拉/去重；增强为真 socket + 无头客户端。 |
| S3 | 保留服务端不读 FS、解析和全文落库；明确 tail 实时字段与 full 归档字段并用真 Hook 子进程上行。 |
| S4 | 原样保留公网鉴权、角色隔离与 UI 明示。 |
| S5 | 保留离线请求、状态闭环、错误和幂等；增强为传输/诊断双轴与只重跑诊断。 |
| S6 | 保留当前会话、问答上下文和提示词；共享 core 契约 + macOS 真机，Windows 当前会话证据受 W0 阻塞。 |
| P3 | 所有原 P3 清单继续保留；拆为 Linux server、macOS client、Windows W0/W1 三份发布证据，记录版本、域名/TLS、真机和回滚结果。 |

## 8. AI 助教当前问题补强验收（v3-only）

下表只增强 v3，不修改、替换或放宽 v2 的任何判定标准。自动化默认无外网，每项在
宣布通过前都必须按 §4 登记并撤销 breaker，在 `docs/dev-log.md` 保留 RED/GREEN 证据。

| ID | 验收范围 | 确定性判定 |
|---|---|---|
| SA-1 | 完整会话下拉框 + 最近 3 个快捷项 | 任务在前、工作空间在后，组内按 `last_activity_at` 倒序；快捷项等于同一有序列表的前 3 项；任一控件切换后两处选中 session_id 一致。 |
| SA-2 | 学员端明确空状态 | `no_local_sessions`、`not_synced`、`synced_no_analysis`、`service_unavailable`、`llm_unavailable` 使用不同文案/状态码，不得都映射为“暂无分析记录”。 |
| SA-3 | Copilot 回答可复制 | 请求完成后文本视图仍可选中；复制操作写入的内容与完整回答字节等价，不丢换行。 |
| SA-4 | `DiagnosticBundle` 合同、默认与脱敏 | 客户端默认 `include_diagnostics=true`，取消勾选后即使传 bundle 也不入上下文且入库为 false；正式字段为 `schema_version=diagnostic-bundle/v1`，缺失/非法版本不入 LLM 且不伪记 v1；服务端只允许 `system/versions/environment/proxy/tools/paths/permissions/reachability/recent_errors/truncated`，对每类字段做类型/枚举/长度规范化，`environment/proxy` 只保留 `{name:{configured: bool}}`，未知类别、原始字符串环境值和任意文件内容不入 LLM；条目/单条/总体积有界；裸 `sk-*`、长 token、camelCase/named key/token、Basic/Bearer/AWS4 等完整 Authorization、Cookie 全部字段、邮箱和主目录被替换，有用错误类型/组件/堆栈尾部保留；无参数 collector 默认有工具/路径/权限/代理/`not_probed` 连接状态与最近错误环，且不访问外网；platform/version/`Path.home/cwd`/`os.access` 任一默认探针抛错时返回 `unknown/probe_error`且其余采集继续。`/api/student/ask` 对请求体、标识字段、question、诊断字节和节点数均有上限；超限在 LLM/Store 副作用前返回 413/422，无 Content-Length 与 chunked 也不得绕过。 |
| SA-5 | 五层问答上下文 | 用真临时 Store + 确定性假 LLM 验证其收到：所选会话完整消息边界、该会话 analyses、该学员近期 asks、本次脱敏诊断、启用的 config runtime guidance；另一学员/另一 session trap 不出现；`list_student_asks(limit=3)` 在 SQL 层限量；raw 由 Store 在 SQL 层只选必要列并用 `substr` 返回有界尾部，不调用旧全量方法；只解析经头尾换行边界证明完整的 JSONL 行，短无换行片段、头尾半行和 parse 失败纯文本均不进上下文。预算内五层全部保留；超预算按当前 session、analysis、prior asks、diagnostic、guidance 顺序保留完整 block，不切半消息。 |
| SA-6 | 本机未同步会话 | 服务端缺少所选 session 时返回 `context_status=not_synced`；`sync_then_ask` 在未入库时仍为 `not_synced`、入库后才为 `ready`；`without_session` 不含任何 session 消息/分析，不回退到其他会话。 |
| SA-7 | LLM capability 可观测与降级 | 确定性分支分别返回 `ready`、`disabled`、`missing_api_key`、`misconfigured`、`timeout`、`upstream_error`，并带与状态相符的可执行自检/重试建议；非 URL、缺 host 或非 `http/https` 的 `api_base` 在调用 provider 前返回 `misconfigured`；不统一降级为“LLM 未启动”。`context_status` 仅允许 `ready`、`not_synced`、`without_session`、`no_context`。 |
| SA-8 | runtime guidance 选择与可追溯性 | 本期只从 config 读取；启用版本被加入假 LLM 上下文，禁用版本不加入且不记录；`student_asks` 持久化实际 guidance version，同时持久化已验证诊断 `schema_version`、是否附加和 `llm_status`。 |
| SA-9 | 大型本地对话集全量同步 | fixture 含超过 8 MiB 的无关 transcripts 与一个目标 session；适配器仅索引有界元数据，按需读目标正文，目标不因无关文件的聚合字节总量而失败；模糊、symlink、描述符竞态和 typed failure 防线仍通过。 |
| SA-10 | 导师发起同步的离线与双轴反馈 | 学员离线时立即显示“未连接，已排队”且请求入库；重连后转为领取/传输状态；内容传输与 LLM 诊断独立展示，失败显示可执行原因和重试，不从按钮点击或 WS 猜测成功。 |

建议聚焦命令（实际用例名可随实现调整，判定标准不得放宽）：

```bash
$PY -m pytest tests/test_student_diagnostics.py tests/test_student_ask_api.py tests/test_llm.py -q
$PY -m pytest tests/test_floating_native_phase3.py -q
$PY -m pytest tests/test_workbuddy_adapter.py tests/test_upload_requests.py tests/e2e/test_mentor_ui.py -q
```

## 9. 交付判定

只有以下条件全部满足，才能宣称跨平台重构完成：

1. v2 P0/P1/FE/V/S/P3 的业务判据按上表全部保留并有可复现结果。
2. Contract/Unit/Integration/Component 自动 lane 无 failed、error 或 critical skip。
3. Student Core 在 Linux/macOS/Windows 安装、import、collect 均不依赖平台 UI/锁模块。
4. Hook 不联网、不读整篇、2 秒内 exit 0；spool 在服务端 2xx 前不删除。
5. 双轴状态、同 SHA 诊断重试、导师台真实展示通过合同到系统 E2E。
6. 服务器 FS 红线的静态扫描、runtime sentinel 和 breaker 均有 RED/GREEN 证据。
7. macOS 自动回归和真机冒烟通过；Windows W0/W1 有真实证据。W0 未完成时只能交付
   Windows 框架，并明确 rollout blocked。
8. 在路由从认证 principal 派生 `student_id` 并拒绝不匹配值前，发布材料不得宣称学员级
   或租户级数据隔离。
9. SA-1~SA-10 全部有自动化与 breaker RED/GREEN 证据；诊断与问答集成使用真临时 Store +
   确定性假 LLM，且自动化过程中没有使用外网或泄露环境变量值。

每轮验证把命令、输出摘要、判定、失败分析与修复次数追加到
[`dev-log.md`](dev-log.md)。继承停止条件：单项失败 5 次、振荡 2 次、总修复 15 次或
P0 连续 3 轮失败即停止并报告。
