# SuperBrain 云端集成与双向闭环设计

## 状态

- 日期：2026-07-23
- 状态：APPROVED
- 目标分支：`codex/superbrain-cloud-integration`
- 推送目标：`SuperOPC-AI-Incubator/workbuddy-copilot`（公开仓库）
- 产品基线：`Jonas1mposter/superbrain-copilot@f86c689`

## 一、目标

以同事已经跑通的 TanStack/Supabase 版本作为新的云端产品主线，在团队可控制的 GitHub、Supabase 和腾讯云环境中完成以下闭环：

1. 学员在 Windows 或 macOS 的 WorkBuddy 中学习。
2. 学员提问、AI 回复和诊断可靠同步到云端。
3. 导师观察台实时展示学员、会话、时间线和告警。
4. 导师回复后，消息不仅出现在网页，还会可靠回到学员正在使用的 WorkBuddy。
5. 多位导师使用独立用户名登录，团队管理员可以创建和停用导师账号。
6. 任何一个原作者或云平台暂时不可用，都不阻塞团队继续开发和发布。

开发工作量不作为方案裁剪依据；优先考虑功能完整、稳定性、可验证性和团队接管能力。运行时组件数量仍保持克制，因为额外运维面会直接降低稳定性。

## 二、明确不做

- 不迁移同事 Lovable/Supabase 中的旧账号、旧会话或旧数据。
- 不依赖同事的 Lovable workspace、部署密钥或在线协助。
- 不把两个没有共同祖先的 Git 历史强行合并到现有 `main`。
- 不在当前 2 核 4 GB 腾讯云服务器上完整自建 Supabase。
- 本轮不以注册提权和跨学员 session owner 校验为交付阻塞项；但密钥不得进入浏览器、日志或 Git。
- 不把“网页能打开”或“消息写进数据库”当成导师—学员闭环完成。

## 三、总体架构

```text
Windows / macOS WorkBuddy
  ├─ 首选：OAuth MCP 工具
  └─ 降级：每学员 Token + 跨平台 Skill/连接器
             │
             ▼
Tencent Singapore
  TanStack Start + Node/Nitro
  ├─ Web 学员端
  ├─ Web 导师端
  ├─ 公共 ingest / mentor-message API
  ├─ MCP server
  └─ 管理员账号管理 API
             │
             ▼
Team-owned Supabase Cloud
  ├─ Auth
  ├─ PostgreSQL
  ├─ RLS
  └─ Realtime
```

### 3.1 代码与发布所有权

- 同事仓库 `f86c689` 是新分支的 Git 起点，保留其 129 个提交历史。
- 新分支推送到公开团队仓库 `SuperOPC-AI-Incubator/workbuddy-copilot`，不覆盖现有 `main` 和 `feat/target-arch-rebuild`。
- GitHub 是代码权威源。Lovable 上的旧站点仅作行为参考，不作为开发、数据或发布依赖。
- 团队成员以后从该集成分支派生功能分支，通过 PR、测试和 review 合入。

### 3.2 应用托管

- 应用部署到腾讯云新加坡服务器，使用 Node/Nitro 运行。
- 服务只监听本机回环地址，由 Nginx 暴露 HTTPS。
- 计划域名：`copilot.sg.superbrain-ai.com`。
- 使用独立 systemd/PM2 进程、独立目录和独立日志，不改动现有其他服务。
- 采用 release 目录 + 当前版本软链接或等价原子切换，保留上一版用于快速回滚。

### 3.3 数据托管

- 新建团队控制的 Supabase 项目。
- 使用仓库 migrations 初始化 Auth 相关表、students、sessions、timeline_items 及新增的送达状态表。
- Supabase 继续提供数据库、认证和 Realtime；腾讯云不运行自建 Supabase。

## 四、账号与角色

### 4.1 学员

- 学员保留自主注册。
- 注册入口固定创建 `student`，页面不再允许用户自选 `mentor`。
- 学员继续获得 per-student WorkBuddy token 和可复制的接入配置。

### 4.2 导师

- 导师不开放公开注册。
- 登录页面接收用户名和密码，不要求真实邮箱。
- 服务端把规范化用户名映射为带版本号的不可逆内部 Supabase Auth 标识；内部标识不显示给导师，也不作为管理 API 响应字段。
- 首批预置 4 个已确认的导师用户名。初始密码只在建号时提交给 Supabase Auth，不写入设计文档、代码、migration、日志或项目环境文件。
- 顶部导航和消息作者显示导师用户名，而不是内部邮箱标识。

### 4.3 团队管理员

- 增加 `team_admin` 角色。
- 初始管理员同时可以是导师。
- 团队管理页支持：
  - 创建导师；
  - 停用/启用导师；
  - 重置临时密码；
  - 查看账号状态和最后登录时间。
- 创建账号必须由可信服务端调用 Supabase Admin API；管理密钥只存在于服务器部署环境。
- 普通导师不能创建其他导师。

## 五、学习数据正向链路

### 5.1 统一事件模型

每次同步带：

- `event_id`：客户端生成、全局唯一；
- `student_id`；
- `session_id` 或稳定的 source session key；
- `kind`：prompt / reply / diagnosis；
- `text`；
- `severity`；
- `created_at`；
- `source`：mcp / skill / connector；
- 可选的重试次数和客户端时间。

服务端使用独立 ingest ledger 和原子数据库函数处理 `event_id`。同一个 `event_id` 与相同 payload 重试时返回第一次结果；同一个 `event_id` 搭配不同 payload 时返回冲突，不重复写时间线。

### 5.2 接入方式

1. **OAuth MCP 为首选**
   - `log_turn` 一次写入 prompt、reply 和可选 diagnosis。
   - 新增拉取未读导师消息和确认已读工具。
   - 工具行为不依赖操作系统 shell。

2. **Token Skill/连接器为降级**
   - 保留同事版一键接入体验。
   - 提供 Windows PowerShell 与 macOS/Linux 两套明确命令。
   - 网络失败进行有限重试；仍失败时先写入项目目录外的本地原子待发送队列，由后续轮次补传。
   - token 不嵌入 SKILL.md；连接器只从当前用户的受限配置读取。
   - 本地队列不进入项目目录，不被 Git 跟踪。

### 5.3 会话稳定性

- 优先使用 WorkBuddy 提供的真实 session identifier。
- 无稳定 identifier 时使用服务端返回的 session id，并由客户端本地状态记住。
- 不再仅靠“标题相同”合并会话。
- 同一学员并发多个会话时不得串线。

## 六、导师回复反向链路

### 6.1 状态模型

每条导师消息至少具有：

- `pending`：已写入云端，学员端尚未获取；
- `fetched`：WorkBuddy 已拉取；
- `acknowledged`：WorkBuddy 已向学员呈现并确认；
- `failed`：多次拉取或确认失败，保留原因和重试计数。

状态以单独的 delivery 记录表示，不把网页浏览等同于 WorkBuddy 送达。

### 6.2 MCP 链路

- 新增 `get_unread_mentor_messages`：按学员和会话返回未确认消息及稳定 cursor。
- 新增 `ack_mentor_messages`：批量确认已经呈现的 message id。
- WorkBuddy 每轮在 `log_turn` 后调用拉取工具。
- 存在新消息时，AI 必须在当前回复中明确展示导师消息；展示成功后再 ack。
- 网络中断时消息保持 pending，下轮继续返回。

### 6.3 Token/Skill 链路

- 新增 Bearer token 保护的未读消息查询与 ack API。
- token 明文只在创建或轮换时显示一次；服务端只保存 hash、前缀、状态和最近使用时间。
- Windows/macOS 接入脚本使用相同协议。
- API 返回结构化 JSON，不要求客户端解析网页。
- 多次 GET 或 ACK 都必须幂等。

### 6.4 网页链路

- 学员网页继续通过 Supabase Realtime 即时展示导师消息。
- 网页展示记录为 `web_seen`，与 WorkBuddy `acknowledged` 分开。
- 导师端展示每条消息的“网页已看 / WorkBuddy 已送达 / 待送达”状态。

## 七、体验与功能范围

### 7.1 导师端保留

- 三栏学员、会话、时间线；
- SOS / warn / error 告警；
- 浏览器通知和声音；
- 漏传提醒；
- AI 导师草稿；
- 导师回复；
- 新增真实送达状态和团队账号管理入口。

### 7.2 学员端保留和增强

- 自己的时间线；
- 主动呼叫导师；
- WorkBuddy 一键接入；
- 导师回复在网页和 WorkBuddy 内可见；
- 接入状态、最后同步时间、失败与补传状态可见；
- Windows 和 macOS 分平台安装说明。

### 7.3 领域内容

- 把工业自动化提示词从硬编码默认值改为可替换 domain pack。
- 默认提供“通用 AI 学习营”配置；工业自动化 PLC 作为一个可选 pack 保留。

## 八、错误处理与可观测性

- 所有写操作返回结构化错误码、request id 和是否可重试。
- 服务端记录入口、身份、分支、event id、session id、结果和异常，但不记录密码、token、完整 secret。
- ingest、导师消息 fetch/ack、Realtime 订阅和 AI 调用分别统计成功率与延迟。
- 导师端显示学员最后成功同步时间和未送达消息数量。
- DeepSeek 不可用时，基础同步、导师查看和人工回复仍可工作；只降级 AI 草稿/诊断。
- Supabase Realtime 不可用时，页面退化为有界定时刷新，不影响写入。
- 腾讯云应用重启后，未读导师消息和已写入事件不丢失。

## 九、验证方案

### 9.1 自动化

- 纯函数单测：用户名规范化、内部 Auth 标识映射、event id、cursor、状态转换。
- API 集成测试：注册、登录、ingest 幂等、导师发送、未读拉取、重复拉取、ack、重复 ack、离线补取。
- 数据隔离测试暂不作为安全发布门，但至少覆盖正常的 student/session 归属路径，避免功能串线。
- 浏览器 E2E：
  - 学员注册和登录；
  - 导师用户名登录；
  - 导师看到新对话和告警；
  - 导师发送回复；
  - 学员网页实时收到；
  - 管理员创建/停用导师。
- GitHub Actions 在 Linux、Windows、macOS 验证生成的接入配置、命令和本地队列逻辑。

### 9.2 防假绿

- 每条关键自动化用例在交付前做一次负控，证明被测功能被断开时测试会失败。
- 不 mock 掉被测状态机、数据库唯一约束或消息送达协议。
- 断言具体消息内容、状态和 event id，不只断言 HTTP 200 或结果非空。

### 9.3 线上闭环验收

使用独立测试学员和导师完成：

1. 学员创建会话并连续同步多轮。
2. 人为重复发送同一 event，时间线只出现一次。
3. 学员离线时导师发送两条消息。
4. 学员恢复后 WorkBuddy 获取两条消息，呈现并 ack。
5. 导师端显示 WorkBuddy 已送达。
6. 重启腾讯云应用后重复验证。
7. Windows/macOS 至少通过 CI；能取得真实 WorkBuddy 设备时补真机验证，不能把 CI 冒充真机结果。

## 十、部署与回滚

1. 在团队 Supabase 新项目执行 migrations。
2. 通过可信管理通道创建初始管理员、导师和测试学员。
3. 在腾讯云创建独立 release 目录、进程和 Nginx 站点。
4. 配置 HTTPS、Supabase、DeepSeek 和应用运行时 secrets。
5. 先用测试域名运行 smoke/E2E，通过后启用正式域名。
6. 发布失败时切回上一 release；数据库 migration 采用向前兼容设计，不依赖破坏性回滚。
7. 完成后将分支推送到个人 GitHub，并提供提交、验证结果、部署地址和遗留限制。

## 十一、完成标准

- 新分支完整保留同事版历史并可由团队继续开发。
- 代码不依赖同事 Lovable 权限或旧 Supabase 数据。
- 4 个导师用户名可以登录，公开页面不能创建导师。
- 团队管理员可以自行创建、停用和重置导师账号。
- 学员对话可靠进入导师台；重复上报不重复写入。
- 导师回复能在网页和 WorkBuddy 中送达，离线后可补取，状态可追踪。
- 自动化测试、构建、lint 和线上 smoke/E2E 达到交付判据。
- 应用部署到腾讯云并可回滚。
- 分支成功推送到 `SuperOPC-AI-Incubator/workbuddy-copilot`。
