# WorkBuddy Copilot — 目标架构设计（v3，跨平台学员端修订）

> 定稿日期：2026-07-02
> 修订日期：2026-07-14
> 状态：目标架构重建已完成；本版锁定公网部署、鉴权、跨平台 Student Core、回执可靠性、AI 助教上下文与测试前置要求
> 依据：架构 review + 3 方案判官评审 + YAGNI/数据模型/通信安全三专家评审 + 用户后续拍板的产品决策

---

## 一、背景与目标

为 Pioneers Learning Community (PLC) 构建学习 Copilot：监控学员与 WorkBuddy 的对话，LLM 分析学习状态，学员浮标实时呈现，导师浏览器观察台查看，**并支持导师异步发文字提示到学员浮标**。最终要让每位学员在使用 WorkBuddy Agents 时都有一个持续在场的 AI 助教：结合真实错误、本机能力和营地最佳实践解决技术卡点，并对提问、调研、收敛与验证方式给出适时建议；同时让导师看清学员与 AI 协作的过程和阻塞，用于更有针对性的人工干预。真实规模 45 学生 × 17-18 导师，近期采用**公网服务器**连接，避免依赖局域网互通。

### 用户已拍板的产品与架构决策（本设计硬约束）

| # | 决策 | 影响 |
|---|------|------|
| D1 | **近期就要多机 rollout**（中心服务端 + 学员机 hook 上报 + 导师浏览器）| 单机假设必须拆除 |
| D2 | **导师可异步发文字→学员浮标**（不直接改 AI）| 需要反向事件流，WS 按 student_id 寻址（最深转折点）|
| D3 | **完整对话原文落库**（学员提问 + AI 回答全部轮次）| 新增不截断 `raw_transcripts` 表，与"喂 LLM 的尾部 N 条"解耦 |
| D4 | **每个导师看全部 45 学员** | 不需要导师-学员**可见性**关系表。注意区分两个方向：**读/观察**=正向事件全量广播给导师池（所有导师看所有学员）；**写/下发**=导师消息**逐条定向**到指定 `student_id`（只投该学员浮标，其他学员收不到）。mentor_messages 表记 student_id(收)+mentor_id(发)，即每条消息自带导师↔学员关联，但非"导师固定负责哪些学员"的持久关系 |
| D5 | **隐私/合规 MVP 不考虑**（学员均成年/内部受控）| consent/留存/脱敏/删除权移到正式版；见 §十 |
| D6 | 架构"变轻" = 删推测抽象 + 修数据正确性 + 保留分层，**不换范式** | 删 ports.py、死 DTO、死代码；不引 MVVM/前端框架 |
| D7 | **学员和导师均通过公网服务器连接** | 不再以 LAN IP 为默认部署形态；公网入口必须 HTTPS/WSS；服务端仍保持单 worker |
| D8 | **全量同步不追求严格恢复，但必须容错并提示** | 后台 LLM 失败不要求自动精确重放；导师/学员 UI 必须看到 pending/running/done/failed 状态并可重试 |
| D9 | **改代码前先更新需求、设计、测试方案** | 后续实现必须先补测试方案，再按测试驱动修复；文档源头以本文件 + PRD + test-plan-v2 为准 |
| D10 | **学员端定位为技术助教浮标** | 学员可主动提问；系统可低频提醒低效对话模式；UI 不做复杂 tab |
| D11 | **过程提醒提示词可持续更新** | 当前由配置/管理员更新；架构预留未来导师端更新全员提示词，不做 per-student 策略 |
| D12 | **当前会话自动跟随只服务学员端** | 浮标本地检测 WorkBuddy 当前会话并自动切换；导师台暂不显示“学员当前正在看哪个会话” |
| D13 | **学员提问默认附加诊断信息，且必须先脱敏** | Student Core 组装有界、可版本化的 `DiagnosticBundle`；Hook 不做系统探测；界面允许取消勾选 |
| D14 | **助教上下文可解释，不宣称载入全部对话** | 服务端按五层合并且按消息边界裁剪；返回实际的对话、诊断和 guidance 使用状态 |
| D15 | **本机未同步会话不伪造服务端上下文** | 学员可选 `sync_then_ask` 或 `without_session`；前者先同步最近内容，后者明确不带会话提问 |
| D16 | **LLM 可用性与营地指导上下文必须可观测** | 区分未启用、凭据缺失、上游不可用等 capability；guidance 可版本化、运行时选择并记录实际版本 |

### 架构定性（纠正）

现有代码/文档称"MVC"是**误导**。真实形态是 **分层（Controller-Service-Repository）+ 局部六边形（Ports & Adapters）+ 进程内 EventBus + 跨进程独立前端客户端**。服务端没有 MVC 意义上的统一 View。目标架构保留分层，删掉半套投机六边形，文档统一改称 **"分层 + 事件驱动"**。

### 实施状态（2026-07-12）

服务端唯一权威、stdlib Hook、本地 spool、共享 Student Core、macOS 适配与导师消息可靠回执均已落地并经自动回归验证。Windows 只交付了不猜测本机路径的适配器骨架和平台合同：缺少真实 Windows WorkBuddy 的 W0 证据，状态必须保持 **`BLOCKED: real-machine evidence missing`**；即使日后 W0 manifest 完整，仍须完成 W1 与实机发布验证，不能据此宣称可 rollout。

---

## 二、目标架构总图

```
学员机 ×45                                              导师 ×17-18
┌────────────────────────┐                        ┌──────────────────────┐
│ hook.py (stdlib 零依赖)  │  原子写本地 spool      │ 浏览器 /mentor 静态页  │
│   读 transcript 尾部字节 │──▶ Student Core ───────│  WSS /ws/mentor       │
│ macOS NSPanel / Win Core │  HTTPS / WSS (student) │  HTTPS /api/mentor/*  │
│   ▲ 收 mentor_message    │◀────────────────────────│  mentor token         │
└────────────────────────┘                        └──────────────────────┘
             │                                                  │
┌────────────┴──────── 公网入口(HTTPS/WSS, TLS 终止) ────────┴──────────────┐
│ 反向代理 / 托管入口：负责 TLS、域名、基础限流；应用层负责 token 鉴权        │
└────────────┬───────────────────────────────────────────────┬──────────────┘
             │                                               │
┌────────────┴──────────────── 应用服务器（单 uvicorn worker）┴───────────────┐
│ Controller (service.py / mentor/routes.py)                                      │
│   /report→202+BackgroundTask · /api/mentor/message · /api/student/messages(补拉)│
│   /api/student/messages/pending-receipts · /api/student/messages/ack             │
│   /api/mentor/* · /api/student/ask · /api/student/upload-requests               │
│   DELETE /api/admin/students/{id}                                                │
│                              │ 依赖注入(Depends/app.state)                       │
│ app_context（组合根：唯一构建 CONFIG/STORE/Services/EventBus/WSRegistry 处）      │
│                              │                                                   │
│ Service: AnalysisService · SessionQueryService · MessageService · StudentAssist │
│                              │ 发布/订阅            │ 端口消失，直接调 Store        │
│ EventBus(单向 pub/sub) ──▶ WSRegistry(订阅者)        Store (Repository)           │
│   floats: dict[sid,set[ws]]  mentors: set[ws]        │                            │
│   扇出用 asyncio.gather + 每发 wait_for 超时剔除       ▼                            │
│                                              copilot.db（唯一权威源）              │
└──────────────────────────────────────────────────────────────────────────────────┘
   服务器绝不读学员机 workbuddy.db / JSONL / FS —— 一切学员状态经 hook 上报入库
```

**部署铁律**：**单 uvicorn worker**（`--workers 1`）。进程内 EventBus + WSRegistry 是内存态，多 worker 会各持一份→广播分裂、反向消息路由到空注册表静默丢失。公网入口只负责 TLS/域名/基础限流，不改变单 worker 应用约束。

**公网铁律**：
- 生产环境必须配置 token；空 token 只允许本地开发。
- 公网传输必须是 HTTPS/WSS；不得让学员机通过明文 HTTP 上传原文。
- 学员 token 与导师 token 分离。学员 token 只能访问 `/report`、学员 WS、学员补拉/上传接口；导师 token 只能访问导师台、导师 API、导师 WS。
- `student_id` 仍由客户端上报，但所有写入必须做 session owner 校验；读路径能带 `student_id` 的都必须带上，不能只依赖全局 session_id。

### 当前 MVP 学员身份边界

- 当前共享 `student_token` 只认证“学员端”角色，不认证具体 `student_id`。HTTP 请求体、查询参数和 `/ws` 的 `student_id` 仍由客户端提供。
- 因此，任何持有共享 token 的客户端目前都可冒充其他学员，读取或确认其消息，或以其身份连接 WebSocket。按 `student_id` 存储、查询及 session owner 校验是数据一致性/纵深防御，不构成授权隔离。
- `auth.student_tokens: {student_id: token}` 和纯函数 `student_id_for_token()` 仅作为未来安全迁移接缝，本次发布不接入任何 HTTP/WS 路由，也不改变共享 token 授权行为。
- 只有路由从已认证 principal 派生 `student_id`，并拒绝客户端提供的不匹配值后，才能缓解该冒充风险。在此之前，当前部署不得称为学员级或租户级数据隔离。

---

## 三、分层职责

| 层 | 文件 | 职责 | 硬规则 |
|----|------|------|--------|
| Controller | service.py, mentor/routes.py | HTTP/WS 编解码 + 鉴权 + 调 Service | 不直连 Store、不 import parse、不反向依赖 service 全局 |
| 组合根 | **app_context.py（新增）** | 唯一构建依赖处；Depends/app.state 注入 | 消除 mentor/routes→service 反向依赖；使 handle_stop 可注入真 Store+假 LLM 做真实测试 |
| Service | services.py | 业务编排，无 I/O 细节，可被路由/后台任务复用 | 事件走 EventBus；不含 HTTP |
| 事件/推送 | eventbus.py, **connections.py（新增 WSRegistry）** | 进程内单向 pub/sub + 按 student_id 寻址扇出 | EventBus 不做对称双向 |
| Repository | store.py | copilot.db 唯一读写 | 只做单库读写，不越层、不猜路径、不读 workbuddy.db |
| 学员共享核心 | student_core/{spool,transport,coordinator,agent,diagnostics}.py | 本地事件、HTTP/WS、重连、去重、持久回执；提问时组装有界且脱敏的 `DiagnosticBundle` | 不 import WorkBuddy、AppKit、Foundation、objc 或 fcntl；不采集环境变量值和任意文件内容 |
| 平台适配 | student_platform/{macos,windows,workbuddy}.py | 把显式已知本机数据目录交给共享 reader | 不把本机路径/文件读取迁移到服务端；Windows 必须先过 W0 |

### EventBus 方向性（关键）
总线保持**单向** pub/sub，"双向"由**两个事件族 + 订阅者按 `payload.student_id` 路由**实现，总线本身不知方向：
- **正向** `{type: analysis|prompt|ai_summary, student_id}`：WSRegistry → 广播全体 mentors（D4） + 定向 `floats[student_id]`（停止向所有浮标广播他人事件）。
- **反向** `{type: mentor_message, student_id(目标), text, message_id}`：WSRegistry → 定向 `floats[target]` + 回显 mentors（导师 UI 看"已送达"）。

---

## 四、数据模型（copilot.db，唯一权威源）

> 数据决策"现在必须做对"，落盘后改需迁移历史。采用增量迁移（ALTER ADD COLUMN + CREATE IF NOT EXISTS + 回填），纯加列加表、无 rebuild、不破坏历史。

### 目标表

| 表 | 用途 | 关键点 |
|----|------|--------|
| reports | 每次 hook 上报 | 新增 `analysis_pending` 标记（BackgroundTask 崩溃后启动重扫）；**停止** `prompt[:2000]` 双存（prompts.content 为权威全文，此列留空/仅预览）|
| analyses | LLM 学习分析 | severity 修法见下 |
| prompts | 学员提问全文 | 权威全文源（不截断）|
| ai_summaries | AI 回答摘要 | 时间线/浮标展示用 |
| **raw_transcripts（新）** | **完整对话原文（D3）** | 不截断，Stop 时整篇落盘；与"喂 LLM 的尾部 N 条"**解耦**（不同目的不可共用截断数据）|
| **sessions（新）** | 会话权威表（替代读 workbuddy.db）| session_id, student_id, work_dir, title, created_at, last_activity_at；/report UPSERT |
| **students（新）** | 学员名册（记名 D4/D2）| student_id PK, display_name, token_hash（预留公网升级）, created_at |
| **mentor_messages（新）** | 反向消息（D2）| id, student_id, mentor_id, session_id, text, message_id, created_at, delivered_at, read_at（预留）；FK→students |
| **upload_requests（新增/已实现需补强）** | 导师触发全量同步的命令与状态 | request_id, student_id, mentor_id, session_id, status(pending/running/done/failed), error_message, created_at, updated_at；浮标离线后可补拉 |
| **messages（新增/已实现需补强）** | 全量上传后的逐轮对话内容 | 只保存客户端过滤后的 message 行；工具输出不上传；重传按 sha 幂等 |
| **student_asks（已实现需纳入架构）** | 学员主动问技术助教的问答记录 | student_id, session_id, question, answer, created_at；同时持久化 `context_status`、`diagnostics_attached/diagnostics_version/diagnostics_summary`、`guidance_versions` 与 `llm_status`。`diagnostics_version` 仅保存已验证的 bundle `schema_version`；不持久化原始诊断包 |
| **prompt_configs（已实现）** | 分析服务的过程提醒 | 本期只支持 `process_reminder` 的 key/prompt/updated_by/时间戳，不宣称已支持学员问答 guidance 的 version/enabled 选择 |
| **guidance 管理（未来）** | 技术排障与 AI 协作指导 | 待管理界面实现时再扩展 Store 合同；本期运行时只读取 config 中的 version/enabled/text |

### severity 语义修复（真 bug）
现状 `MAX(severity)` 取字典序（error<info<warn），**error 被吞**、有 error 的会话可能显示绿灯。拆两语义：
- **面板/会话圆点 = 最坏严重度**：`MAX(CASE severity WHEN 'error' THEN 3 WHEN 'warn' THEN 2 ELSE 1 END)` 再映射回字符串。
- **last_topic / last_diagnosis = 最新值**：`ORDER BY created_at DESC LIMIT 1` 子查询。（不可与最坏严重度混用同一聚合）

### 其他数据正确性
- **timeline UNION 补列**：analysis 分支补 SELECT `severity/suggestion/is_technical/topic`，其余分支 NULL 对齐（修时间线分析条目字段恒空）。
- **FK 生效**：每连接 `PRAGMA foreign_keys=ON`；新表加 CHECK 枚举 + FK ON DELETE CASCADE；旧表走应用层校验（SQLite 不能对既有表加约束）。
- **插入顺序**：/report 先 `upsert students` 再插 mentor_messages/analyses（否则 FK 违约丢数据）。
- **级联删除**：单事务、子表先行（analyses/prompts/summaries/messages/raw_transcripts → reports/sessions），返回删除行数供审计。启动时扫一次既有孤儿行。
- **session_id 唯一性（已核实 2026-07-02）**：只读 workbuddy.db 得 205/205 去重、均为随机 UUID（混合格式），非每机递增。→ **用 `session_id` 单主键，无需复合键**；关联表仍带 student_id 作隔离查询的 defense-in-depth。混合格式仅展示层归一化。
- **owner 防线（v2 必补）**：`sessions.session_id` 仍保持单主键，但 `upsert_session` 等冲突写入必须拒绝或忽略跨 student_id 更新；timeline/transcript/reply 等读接口能传 student_id 时必须加作用域。公网部署下不能把"UUID 碰撞概率低"当作唯一隔离措施。

### sessions 回填（迁移）
从 analyses 回填：title 用 `ORDER BY created_at DESC LIMIT 1`（**不用 MAX(text)**，那是本次要修的反模式重现）、created_at 用 `MIN`、last_activity_at 用 `MAX`。或不回填、由后续上报向前自然填充。

---

## 五、反向通道机制（D2，最深转折点）

1. 浮标连 `ws://SERVER/ws?student_id=S&token=T` → `WSRegistry.register_float(S, ws)`（用 **set** 容纳重连竞态/多连接）；断开 unregister。
2. 导师发消息 → `POST /api/mentor/message {student_id, text, mentor_id}`（**HTTP，非双向 WS**，KISS）。
3. `MessageService.send()`：先写 `mentor_messages(delivered_at=NULL)` **落盘**（离线不丢）→ 再 `bus.publish(mentor_message)`。
4. WSRegistry 订阅者向 `floats[student_id]` 低延迟 `send_text`，但 **WS 发送成功不改变** `delivered_at`；离线和在线的真相都保留在数据库。
5. 学员端（macOS 浮标或共享无头 Core）成功处理消息后，先把 `rendered` 写入本地 ReceiptLedger/状态，再以 student token 调 `POST /api/student/messages/ack`。只有该 REST ack 成功，`MessageService.ack()` 才置 `delivered_at=now` 并回显导师"已送达"。
6. **掉线、重启与响应丢失恢复**：常规 catchup 处理展示；独立 `GET /api/student/messages/pending-receipts` 只返回 `delivered_at IS NULL` 的消息，按 `id ASC`、每页最多 64 条，支持 `after_id`。Core/浮标持久化“已渲染、待 ack”而不是只保存展示去重窗口，分页重试时只 ack 已渲染项；未知或未渲染消息绝不确认。该协议是 at-least-once 投递。

### 导师触发全量同步命令（v2 补强）
导师点击"同步该学员全部对话"后，服务端先写 `upload_requests(status='pending')`，再实时投递 `mentor_command`。浮标在线时立即执行；浮标离线时，重连后必须通过学员接口补拉 pending request，再执行上传。执行过程更新状态：
- `pending`：导师已发起，等待学员浮标领取。
- `running`：浮标已领取，正在上传。
- `done`：上传结束；返回 total/synced/skipped/failed 统计。
- `failed`：客户端读库、网络、服务端解析或后台诊断失败；记录可展示错误，导师可重试。

不要求为历史 LLM 诊断做严格 exactly-once 恢复；要求是**内容上传不丢、状态可见、失败可重试**。后台 LLM 失败时，导师台显示"内容已上传，诊断失败/待重试"，而不是静默灰显。

**WS 扇出隔离**（三专家共同补漏）：扇出改 `asyncio.gather` + 每发 `asyncio.wait_for(timeout)`，超时即剔除该 socket——防单个半开 TCP（学员机休眠/断网未 FIN）阻塞对所有人的推送。

---

## 六、学员端技术助教体验（v2 新增）

### 浮标面板信息架构
学员端不做复杂功能 tab。面板分三块：
1. **顶部：完整对话下拉框 + 最近 3 个快捷项**。这是会话切换，不是功能 tab。两处共用同一有序数据和同一选中状态：任一位置切换后另一处立即同步。排序与 WorkBuddy 一致：任务在前、工作空间在后，组内按最后问答/活动时间倒序；快捷项取该列表的前 3 项。
2. **主体：当前建议 + 导师提示**。展示当前会话最近的学习诊断、可优化提醒、导师提示。提醒必须短、轻、少。
3. **底部：向技术助教提问**。学员输入问题，“附加诊断信息”默认选中且可取消；回答文本保持可选中，并提供明确的复制操作。

空状态不再统一显示“当前对话暂无分析记录”，必须区分：本机没有对话、所选对话未同步、已同步但尚无分析、服务不可达、LLM 不可用。

### 当前会话自动跟随
浮标客户端负责本地检测 WorkBuddy 当前会话，并默认把面板切到当前会话。该能力只影响学员端体验，不要求同步到导师台展示。规则：
- 面板关闭时：检测到 WorkBuddy 切换会话后静默跟随。
- 面板打开时：如果学员正在查看其他会话，不强制切走；只更新顶部当前会话标记。
- 面板重新打开或学员点击当前会话按钮时，回到 WorkBuddy 当前会话。

### 技术助教问答
`/api/student/ask` 使用 `student_id + session_id + context_mode` 组装上下文。服务端严格按以下五层组合，每层独立有界，对话只能按完整消息边界裁剪，不能在字符中间截断后宣称是“全部对话”：

1. **所选会话的最近有效消息**：服务端已入库的 `messages/raw_transcripts`，只取完整消息。
2. **所选会话的最近分析**：用于补充已识别的阻塞、建议和风险。
3. **该学员最近的 Copilot asks**：保留连续追问所需的少量问答，不混入其他学员。
4. **本次 `DiagnosticBundle`**：仅当 `include_diagnostics=true` 且结构、版本、大小合法时加入。
5. **运行时 guidance**：当前启用版本的技术排障知识和 AI 协作最佳实践。

字符预算不按“后加入的内容优先”截取，而是按上述层级优先级选择完整 block：当前 session 消息最高，然后是当前分析、近期 asks、诊断、guidance。同层优先最新内容，任何消息都不从中间切断。

所选会话仅存在学员本机时，服务端返回 `context_status=not_synced`，不回退到不明来源的其他会话。客户端提供两个显式模式：

- `sync_then_ask`：先上传所选会话的最近内容，服务端确认后再提问。
- `without_session`：明确不带对话上下文，仍可按用户选择带入脱敏诊断和 guidance。

### 诊断信息责任边界

`DiagnosticBundle` 由 Student Core 在学员发起提问时组装，不由 Hook 采集。正式合同字段仅使用 `schema_version=diagnostic-bundle/v1`；服务端对缺失或不支持的版本不附加、不入 LLM 上下文、不伪记为 v1。版本正确也不等于可信：服务端按 `system/versions/environment/proxy/tools/paths/permissions/reachability/recent_errors/truncated` 严格白名单重建 bundle，未知类别和未知字段直接丢弃，且所有保留字段必须通过类型、状态枚举、条目数、单条长度和总体积约束。当前 MVP 允许默认选中以优先功能与体验，但发送前仍必须完成基础脱敏：

- 保留错误类型、发生时间、所属组件、脱敏消息、有界堆栈尾部与 capability 状态。
- 工具/运行时、必要目录/配置、权限、代理与目标服务可达性仅报告结构化状态和脱敏摘要。
- 环境变量只报告“是否已配置”，永不报告值；密钥、token、Authorization（包括 Basic、Bearer、AWS4 等多段认证值）、用户主目录和邮箱等使用占位符。
- 不上传完整环境、任意文件内容、浏览器历史或无关用户数据。

Student Core 无参数采集默认就应包含 OS/架构、Python/Copilot 版本、`python3/git` 存在性、WorkBuddy DB/projects 等关键路径的 exists/readable、基础读写权限、代理是否配置，以及明确的 `loopback/upstream=not_probed`。进程内有界错误环保留 component/time/type/脱敏 message/stack tail。每个默认本地探针独立隔离：任一 platform、版本、`Path.home/cwd`、路径或权限检查异常时，只把该事实降级为 `unknown/probe_error`，不中断整个采集，也不携带异常详情。默认采集不发起任何外网请求。

会话原文也不能用“字符数小于上限”推断为完整。Store 必须在 SQLite 查询层用 `substr` 只返回有界尾部和必要元数据，禁止先 `SELECT *` 将全量 `content` 载入进程再截断。服务端只解析可以由换行边界证明完整的 JSONL 行，同时丢弃被字节截断的头部和没有结束换行的尾部；解析失败时不再把纯文本片段降级塞进 LLM 上下文。

`POST /api/student/ask` 同时限制请求体总字节、`student_id/session_id/question` 字段长度、诊断序列化字节与节点数。服务在路由解析前对 Content-Length 和实际流量同时计数，因此缺失/伪造 Content-Length 或 chunked 传输也不能绕过上限；超限请求不得进入 LLM 或 Store。

服务端验证合同后才把诊断加入 LLM 上下文，并在 `student_asks` 中保存实际使用的脱敏摘要与版本。未勾选时不上传、不入上下文，并持久化 `diagnostics_attached=false`。

### LLM capability 与降级

服务端在每次学员问答响应中暴露结构化 `llm_status`，合同固定为 `ready | disabled | missing_api_key | misconfigured | timeout | upstream_error`，不再统一显示“LLM 未启动”。响应返回对应的可执行自检/重试建议，并记录 `llm_status`。`api_base` 必须是带 host 的 `http/https` URL，非 URL、缺 host 或其他 scheme 在调用上游前就归类为 `misconfigured`。LLM 本身不可用时，降级建议必须来自确定性能力判断，不能再调用同一 LLM “诊断自己”。`context_status` 合同固定为 `ready | not_synced | without_session | no_context`。

### 过程提醒与提示词配置
过程提醒用于发现低效学习/对话模式，例如反复试错、上下文描述不清、未经验证直接让 AI 改代码、偏离目标、长时间卡在同类错误上。它不是聊天回复，而是轻量提示。

提醒策略由可更新提示词控制：
- 当前版本：分析过程提醒可从 config 或 `prompt_configs.process_reminder` 读取；学员问答的技术排障 / AI 协作 guidance **仅从 config** 读取 version/enabled/text。
- 更新方式：管理员/开发者可更新；立即影响后续分析，不要求重跑历史。
- 未来扩展：导师端可编辑全员生效提示词；仍不做单导师/单学员差异化策略。
- 防打扰：提醒输出必须有节流规则，例如同会话短时间内不重复提醒同一类问题；低置信度不提示。
- 可追溯：本期 `student_asks.guidance_versions` 记录学员问答实际应用版本；导师诊断复用同一知识源与版本追溯属后续扩展，不宣称本期已实现。

---

## 七、多机部署与跨机 transcript

- **形态**：1 台公网可访问中心服务器（HTTPS/WSS 域名，唯一 copilot.db，应用单 worker）；45 学员机 hook + 浮标连公网域名；17-18 导师浏览器打开公网 /mentor。
- **跨机 transcript（头号阻断的解法）**：hook 用 **stdlib 读 transcript 文件尾部原始字节**（按字节封顶，如末 256KB）写入兼容 `EventSpool` 的本地 JSON envelope；常驻 `Student Core` 再将其 POST 到 `/report`。服务器 `parse_text(content)` 集中解析，绝不碰学员机 FS。
  - hook 保持 **stdlib-only 零依赖 + fire-and-forget**：尾读用内建 open/seek，本地落盘采用临时文件+原子 replace；不联网、不上传本地路径。若读取或落盘失败，try/except 降级且**始终 return 0**，绝不拖垮 WorkBuddy。
  - 完整对话读取属于学员端显式 `WorkBuddyDataAdapter` 的职责；服务器只处理已上报内容。实时 tail 与完整归档/分析用途分开，不能以服务端文件读取替代。
  - 系统、权限、工具、网络和错误环形等诊断只由常驻 Student Core 在学员提问时按需探测；不得为了自动诊断把系统探测、网络请求或第三方依赖塞进 Hook。
- **时序修复**：Stop 的 30s LLM 改 `BackgroundTask` 异步执行，/report 立即返回 **202**（hook 自身 urlopen 超时 5s、WorkBuddy 注册超时 30s 都不再被 LLM 阻塞）。加小 `asyncio.Semaphore` 限 LLM 并发。
- **认证（公网 MVP）**：从单一共享 token 升级为**双角色 token**：`student_token` 用于 hook/浮标/学员上传；`mentor_token` 用于导师台/导师 API/导师 WS。前端导师台首次打开时输入 mentor token，保存在浏览器 sessionStorage，并在 fetch Authorization 与 WS query 中携带。空 token 只允许本地开发，不允许公网启动。
- **config 分发**：学员机配置必须写入公网 service URL、student_id、student_token。导师 token 不下发到学员机。install/register_hook 脚本必须支持通过 env 或参数写入这些配置。

---

## 八、需修复的真 bug 清单（与规模无关，Phase 0 先修）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| B1 | store.py:332/381 | `MAX(severity)` 吞掉最高危 error | 拆最坏严重度 vs 最新值（§四）|
| B2 | store.py:300-308 | timeline UNION 漏 severity/suggestion/is_technical/topic | 补列 NULL 对齐 |
| B3 | app.js:100 | selectSession 从 DOM 反读重建→伪状态（圆点全绿、计数清零）| 引入 ~15 行内存 state 单一数据源 |
| B4 | app.js:49/88 | innerHTML 拼学员可控标题=存储型 XSS | 改 textContent/转义 |
| B5 | notifier_macos.py:21 | osascript f-string 未转义 | 改 `on run argv` 传参 |
| B6 | store.py FK | 声明 FK 但从不 PRAGMA foreign_keys=ON | 每连接开启 + 新表 CHECK/CASCADE |
| B7 | service.py:129-136 | `_IncludedRouter` 私有 API hack（升级即碎）| 改标准 include_router |
| B8 | services.py:76 | handle_stop 核心编排零真实测试 | 真 Store+假 LLM 集成测试（§见测试计划）|
| B9 | service.py Stop | 同步 await 30s LLM，hook 5s 超时刷假错误 | 202 + BackgroundTask |

---

## 九、明确不做（MVP 边界，避免过度设计）

对称双向总线、Redis/MQ broker、多 worker、全面字段级合规策略/at-rest 加密/E2E、前端框架、导师-学员可见性关系表（D4 全量广播）、复杂重试队列/死信/断路器、Windows **正式 rollout/UI**、Cursor/Claude-Code 适配器（第二 Agent 框架真来了再加，属扩展点非转折点）。`DiagnosticBundle` 的基础密钥/身份脱敏属于当前 MVP 功能正确性，不在本“不做”列表中。

Windows 的平台无关 Core 和受 W0 证据门控的探测/数据绑定已实现；这不是对 Windows WorkBuddy 私有路径、Hook 配置或实机行为的支持承诺。相关事实必须由 W0 真机采集后再进入 W1 适配与 P3 发布门。

v2 调整：公网部署下，**双角色 token、HTTPS/WSS、同步状态提示、owner 防线**不再属于"未来正式版"，而是进入当前实现范围。per-student token 强制授权仍延后；本期仅增加未接线的 `student_tokens` / `student_id_for_token()` 迁移接缝，不能据此宣称已有学员级隔离。

**删除/归档的现有代码**：ports.py（4 端口 + 2 工厂全删，TranscriptParser 降为服务端模块函数 `parse_text`）；models 死 DTO（Analysis/Prompt/AISummary 零实例化）；mentor/timeline.py（merge_timeline 死代码）；floating.py + menubar.py（PyQt6 历史遗留）。测试缝用普通 fake + 依赖注入，**不需要 ABC**。

---

## 十、未来正式版待设计（MVP 延后，D5）

> 用户决策：隐私/合规 MVP 不考虑（学员均成年/内部受控）。以下为正式版上线前必须补的设计，**现在仅注明、不实现**。届时可能需调整数据模型/流程：

| 领域 | 待设计内容 | 触发条件 |
|------|-----------|---------|
| 知情同意 | consent 表（status/version/consented_at/revoked_at/consent_by）；同意书点名 DeepSeek 为第三方处理者、披露跨境/留存；未成年人需监护人同意 | 面向未成年学员 / 对外正式上线 |
| 同意门控 | 无有效同意则跳过 LLM（不外发 DeepSeek）、只存派生指标 | 同上 |
| 数据留存 | retention_days / 按营期 retention_until；定时/惰性清理**含 reports 表**（否则截断 PII 逃过清理）| 长期运行 / 合规 |
| 被遗忘权 | 删除接口已留级联删除接缝（本 MVP 已含），需补前端/流程与审计 | 合规 |
| 第三方处理 | DELETE 只清本地库、触及不到 DeepSeek 侧日志；考虑本地模型或零留存协议 | 合规 |
| 数据最小化 | 脱敏/匿名化展示选项；raw_transcripts 全文 PII 面控制 | 合规 |
| 访问控制 | per-student token、导师账号体系、审计日志 | 多租户 / 长期运行 |
| 传输/存储加密 | at-rest 加密；TLS 已进入公网 MVP | 正式版 / 合规 |

> ⚠ 数据决策提示：`raw_transcripts`（完整对话原文）**MVP 即落盘**（D3，避免历史缺失），但其隐私处理（同意/留存/脱敏）延后。上线正式版前需就"已积累的历史原文如何合规化"做一次性处理。

---

## 十一、重建迁移阶段（先修真 bug → 加表 → 切单机 → 反向流）

> 每阶段独立可回滚（feature flag）、可上线；灰度先 2-3 台再全推 45。详细任务拆解见实施计划。

- **Phase 0**：修与规模无关的真 bug（B1-B9），无 schema 变更、可单文件 revert。
- **Phase 1**：数据模型（新表 + FK + severity/UNION 修 + 停双存 + analysis_pending）；空表向前填、不碰旧读路径。**先核实 session_id 是否全局 UUID**。
- **Phase 2**：切单机假设（内容上行 + 服务端 parse_text + 单 worker 断言 + 共享 token + config 分发 + Store 退回 copilot.db + app_context 组合根）。
- **Phase 3**：反向通道（WSRegistry + mentor_messages + POST /api/mentor/message + 浮标接收分支 + 幂等补拉 + WS 扇出超时）。
- **Phase 4**：可测化补强（handle_stop 集成测试 + WS 扇出/剔除测试 + 多学员隔离测试）。

跨平台实施在上述阶段后增加并已完成：Hook 本地 spool、Student Core、macOS 非 UI 适配、回执持久化与系统 E2E。遗留发布证据为 macOS P3 真机验证，以及 Windows W0/W1/P3；后者当前 blocked，不得用自动导入测试替代。

---

## 附：技术栈（不变）
Python 3.13 + FastAPI + uvicorn（单 worker）· PyObjC NSPanel 浮标 · 纯静态 HTML/JS 导师台（+15 行 state）· 腾讯云 TokenHub/DeepSeek · SQLite copilot.db · 进程内 EventBus + WSRegistry。
