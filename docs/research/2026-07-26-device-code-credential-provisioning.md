# WorkBuddy connector 设备码凭证接入：调研与实施设计

日期：2026-07-26  
范围：只设计 connector 的 `wb_` 凭证接入；不改变 MCP 接入，也不改变导师可见的 timeline 业务语义。

## 结论

**最终建议：先做一次真实 CodeBuddy/WorkBuddy `sensitive userConfig` 验证（P0 spike），此时不要承诺或实现任一正式接入路径；验证通过后，将它作为“手动输入既有 token”的安全过渡/兜底，而将本报告的独立设备配对流程（下文简称 WDP）保留为满足“已登录网页、一键接入、无 token 手输和无剪贴板”的默认方案。**

原因是 `sensitive userConfig` 若按文档工作，能解决最危险的“token 被带入 WorkBuddy 对话、命令参数、插件包或事件文件”问题；但它本身只能向用户收集一个已存在的值，不能让已登录的网页把新凭证直接交给本机。学员仍必须先取得 `wb_`，再输入到插件弹窗（通常仍会倾向使用剪贴板）。因此它不能在严格意义上取代本次目标中的“无 token 手输、无剪贴板”。

它借用设备授权的交互语义：本机持有一个高熵、短时的 `device_code`，网页只处理可读的短 `user_code`，已登录学员明确确认后，本机轮询取得自己的 `wb_` 凭证。但它不是 OAuth Device Authorization Grant，不能也不应当伪装为一个新的 OAuth issuer。

推荐的默认路径：插件/安装器在本机直接执行授权器，打开固定网页 `https://<origin>/workbuddy/connect-device`，显示一个短码；学员在已登录页面手动输入并核对该码后确认。本机通过 HTTPS 的响应体获得 `wb_`，立即以现有 0600/Windows ACL 方式写入私有配置。`wb_` 从不显示在对话、命令行参数、剪贴板、浏览器页面、Skill、事件、日志或数据库明文中。

```text
插件/安装器（本机、无 wb_）
  │  POST /device-authorizations
  │  ← device_code（只进私有临时文件）、user_code（可显示）
  ├─ 打开固定网页；显示：BCDF-GHJK-LMNP
  │
  │                                           学员浏览器（已登录）
  │                                           输入并核对短码、设备信息
  │                                           ──同意/拒绝──► 服务端绑定 student
  │
  └─ POST /poll { device_code } ──► 服务端原子签发/交付
     ← { credential: "wb_…" }       （只在 HTTPS 响应体和本机内存）
     原子写 config.json (0600 / ACL) → POST /ack { device_code } → 删除临时文件
```

## 新发现：插件 `sensitive userConfig` 替代方案

### 已验证事实（本机官方文档）

本机 WorkBuddy bundle 内的官方 `plugins-reference.md:307-331` 明确记载：

- manifest `userConfig` 会在**启用插件时**提示用户输入，文档建议以此替代人工编辑 `settings.json`；
- 字段可标记 `"sensitive": true`；值可在 hook/MCP/LSP 配置用 `${user_config.KEY}` 替换，并会以 `CODEBUDDY_PLUGIN_OPTION_<KEY>` 环境变量导出给插件子进程；
- 只有非敏感值可插入 skill/agent 内容，敏感值不能；
- 敏感值优先存系统 Keychain；Keychain 不可用时回退到 `~/.codebuddy/.credentials.json`。它和 OAuth token 共用、总上限约 2 KB。

`wb_` 约 46 个字符，低于该限额。以上是**文档能力声明**，不是一个真实已启用 userConfig 插件的运行时验证。

### 安全使用形态（设计建议）

若 P0 验证通过，manifest 可声明 `api_endpoint`（非敏感）与 `api_token`（`sensitive:true`）。connector 只在 plugin child process 内读取 `CODEBUDDY_PLUGIN_OPTION_<KEY>`，并在内存中调用现有原子 config 写入。

绝不能把 token 用在 hook command 的 `${user_config.api_token}` substitution 中，例如不得生成 `workbuddy-sync configure --token ${user_config.api_token}`：尽管文档允许 substitution，它会把 token 再次变为命令参数。环境变量名是否会把 `api_token` 规范化成 `API_TOKEN` 也必须在 P0 中实测，不可预先假设。

### `userConfig` 与 WDP 的对比

| 维度 | `sensitive userConfig` | WDP 设备码 / 浏览器确认 |
| --- | --- | --- |
| token 不进 WorkBuddy 对话、Skill、事件文件 | 若平台承诺兑现，可解决。 | 可解决；token 从未交给 WorkBuddy 文本层。 |
| token 不成为命令行参数 | 可解决，但前提是只读子进程环境，绝不用 substitution。 | 可解决；token 只来自 poll HTTPS response。 |
| 本机安全存储 | 文档承诺 Keychain；不可用时回退 `~/.codebuddy/.credentials.json`，当前路径/权限未实测。 | 复用已审计的 connector 0600/Windows ACL config。 |
| 学员须取得并输入 `wb_` | **仍需要。** 它只收集现有值，不创建/转移值。 | **不需要。** 短码不是 credential；最终 `wb_` 直接交给本机。 |
| 严格“不经过剪贴板” | 不满足；从网页复制到弹窗仍经过剪贴板，手打长 token 体验也不可接受。 | 满足，`wb_` 不出现在可复制 UI。 |
| 已登录网页授权、特定设备确认、拒绝/过期/替换 | 不提供。 | 提供。 |
| 服务端增量 | 接近零，但依赖插件真实实现。 | 完整增量见后文。 |

结论：若目标暂时收窄为“先阻断 token 进入 timeline”，验证成功的 `userConfig` 是更小的过渡方案；若目标保持“已登录网页一键接入、不让学员接触/输入/复制 `wb_`”，它不是 WDP 的替代品。

### 已知短板与 P0 实机验证

目前没有已启用的 `userConfig` 插件样本可审计，不能仅凭文档把它当作安全边界。必须用**随机测试值、非生产 token**验证：

1. 当前 WorkBuddy 版本启用插件时是否真的出现 sensitive 输入弹窗；取消、空值、修改、升级的行为；
2. 值是否真的进入 Keychain；Keychain 不可用时，回退文件的实际路径、权限、所有者、格式和是否加密。文档写 `~/.codebuddy`，但当前产品/connector 的实际工作目录主要为 `~/.workbuddy`，存在不一致；
3. hook 是否确属 plugin child process、是否收到变量；变量名大小写、子孙进程继承、debug/crash log 是否泄漏；
4. settings、插件包、Skill、事件、日志、命令参数中均没有测试值；
5. 禁用、卸载、重装、重新启用后敏感值的保留/删除/重新提示语义；
6. 与 OAuth token 共用的 2 KB 限额耗尽时的明确失败行为。

P0 只应记录“变量存在/长度/哈希”，绝不记录原值，并产出启用截图、存储定位与权限、卸载重装行为矩阵。预计 0.5–1 人日；它是验证工作，不在本次报告中执行。

### 互补关系与最终决策门槛

- `userConfig` 可以作为 WDP 不可用时的受控恢复路径：安全地把**已有** token 给 connector，但不经过对话或命令行。
- WDP 覆盖 userConfig 无法覆盖的情况：网页已有登录态、希望直接连接这台机器、不能/不应复制长 token、需要明确批准或拒绝一台设备、需要处理 active credential 替换。
- 不要把 `device_code` 放到 userConfig：会把短期授权状态变成平台长期配置，且没有减少 WDP 所需的服务端确认。

**推荐顺序：先做 P0 实机 spike；在结果出来前不要实施任一正式方案。** 若 spike 失败、回退权限不可接受或环境变量会泄漏，直接走 WDP；若 spike 成功且产品接受学员手输/粘贴 token，可先上 userConfig 作为过渡；若仍坚持原始“一键、无 token 手输/复制”目标，则实施 WDP 为默认、userConfig 仅为受控兜底。

## 已验证事实（现有仓库）

以下为读代码得到的事实，不是本报告的设计建议。

| 事实 | 证据 | 对设计的含义 |
| --- | --- | --- |
| `wb_` 凭证由 32 个随机字节生成，数据库只接收 SHA-256 hash 和短前缀。 | `src/lib/workbuddy/credentials.server.ts:175-227` | 新流程应继续复用 token 格式、hash-only 存储和前缀展示。 |
| `workbuddy_credentials` 只允许 service role 访问；解析 RPC 只返回状态和 `student_id`，并不返回明文。 | `supabase/migrations/20260723090100_cloud_integration.sql:185-216,943-992` | 设备配对表须采用同一权限模型；不能让浏览器或 anon 直读凭证表。 |
| 当前每名学员最多一个 active credential；现有签发 RPC 在 `_rotate=true` 时会撤销旧凭证，并使用学员级 advisory lock。 | `supabase/migrations/20260723090300_reliable_delivery.sql:21-23,480-585` | 网页确认必须在替换现有连接时明确提示；消费短码的事务也必须复用该锁语义。 |
| `/workbuddy` 目前会把新 token 显示、复制，并提示粘贴到安装器。 | `src/routes/_authenticated/workbuddy.tsx:254-361` | 这是要替换的常规 UX；新 UI 不应再渲染 `wb_`。 |
| connector 的 `configure` 将 `{version, api_url, token}` 原子写入 config；POSIX state 目录为 0700、文件为 0600，Windows 安装器收紧为当前用户 ACL。 | `connectors/workbuddy-sync.mjs:71-141,798-910`；`docs/workbuddy-connector.md:21-25,59-65` | 最终凭证仍落在同一受保护位置；短时配对状态应使用同等级但独立的临时文件。 |
| 现有 connector HTTP 路径先读取本地 token 并固定发送 bearer；已有 HTTPS 校验、拒绝重定向、限长响应、超时和抖动重试。 | `connectors/workbuddy-sync.mjs:226-290,799-895` | 新增无 bearer 的设备授权请求 helper；复用 TLS、URL 校验、无重定向、限长和重试模式，不能复用“自动附 bearer”的 helper。 |
| 现有安装器在凭证配置后才注册 Stop hook、定时任务和导入。 | `connectors/install-macos.sh` 与 `public/downloads/install-windows.ps1` 的 configure/注册顺序；`docs/workbuddy-connector.md:52-57,76-82` | 设备授权应位于“程序文件已安装”之后、“注册 hook/定时任务/导入”之前。授权失败时不启动未配置的后台任务。 |
| Stop hook 会把完整 turn 的 prompt/reply 入队；服务端最终写入 `timeline_items`。 | `connectors/workbuddy-hook.mjs:95-270`；`src/lib/workbuddy/events.server.ts:73-99`；`20260723090100_cloud_integration.sql:1143-1173` | 将 `wb_` 放进 WorkBuddy 提问确会使它进入学员 timeline，导师可见；设备流程必须完全绕开对话文本。 |
| 现有公共 WorkBuddy API 都需要 bearer credential；项目未发现可复用的通用公开 API 限流器。 | `src/routes/api/public/workbuddy/ingest.ts:109-151`；`mentor-messages.ts:69-115`；`src/lib/workbuddy/public-route.ts` | 新端点必须另加“授权前”的认证和限流，不能复制现有 `Access-Control-Allow-Origin: *`。 |

## OAuth 是否能直接复用

### 判断：不能直接复用；只复用网页登录态和 UI 模式

现有 MCP 接入是由 `@lovable.dev/mcp-js` 把 `/mcp` 声明为**资源服务器**，配置的是 Supabase issuer 与 audience，而不是本项目实现的授权服务器：`src/lib/mcp/index.ts:36-39`。`/.well-known/oauth-protected-resource` 只发布该 MCP 资源的 metadata（`src/routes/[.well-known]/oauth-protected-resource.ts:12-16`），`/mcp` 也只交给 MCP handler（`src/routes/mcp.ts:12-16`）。

现有 consent 页仅接受 Supabase OAuth 的 `authorization_id`，读取 OAuth client 信息，批准/拒绝后跳转到注册的 redirect URL（`src/routes/[.]lovable.oauth.consent.tsx:27-84`）。它没有短码、没有无凭证 polling、没有为 connector 签发 `wb_`，而且已有 grant 时可能直接跳转，不满足“每一台设备均显式确认”的要求。

Supabase 现行 OAuth Server 文档只列出 Authorization Code with PKCE 和 Refresh Token 两种 grant；并未提供设备授权 grant。[Supabase OAuth 2.1 Flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows) 因而支持“不能把现有 OAuth 接入直接当作 RFC 8628 设备流”的判断。

也不建议让 connector 改拿 Supabase access/refresh token：这会把一个只可调用 WorkBuddy 公有 API 的专用 `wb_` bearer，扩大为可按该学员 RLS 权限访问项目资源的 OAuth JWT，且需要 localhost redirect、PKCE、注册 client 和 refresh-token 保存。它既不能满足跨设备短码，也改变了权限边界。

### 可复用项与不复用项

| 组件 | 策略 | 原因 |
| --- | --- | --- |
| 浏览器 Supabase 登录态、`requireSupabaseAuth` | 🟢 直接复用 | 只用来确认“哪个已登录学员批准这次配对”；身份从服务端 context 取得。 |
| consent 页的“对象信息 + 同意/拒绝”交互 | 🟡 借鉴 | 新页面必须每次确认、显示短码与本机信息，不复用 OAuth authorization_id。 |
| `createFirst/rotate/revoke` 的 hash-only 规则、student lock、凭证 resolver | 🟢 复用/抽取 | 保持 credential 生命周期和 public API 鉴权不变。 |
| `/.well-known/oauth-protected-resource`、`/mcp`、`supabase.auth.oauth.*` | ⚪ 不用 | 都属于 MCP/OAuth authorization-code 的协议面，不解决配对。 |
| OAuth access/refresh token | ⚪ 不用 | 不能替代 `wb_`，且权限过宽。 |

## 推荐协议：WDP v1

### 名称和协议边界

命名为 **WorkBuddy Device Pairing v1 (WDP)**。端点使用 JSON REST，不新增 OAuth discovery、不注册 OAuth client、不发送 `scope`、不发送 `grant_type`、不签发 refresh token。这样可借鉴 [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) 的成熟交互和安全要求，却不会错误宣称 Supabase 支持 Device Authorization Grant。

RFC 8628 的关键可复用原则是：设备显示 `user_code`，设备持有不可展示的 `device_code` 来轮询；浏览器登录后批准或拒绝；默认轮询间隔为 5 秒，`slow_down` 后加长间隔。[§3.2–3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.2)

### 码、密钥与持久化规则

以下为**设计建议**。

| 材料 | 生成与长度 | 能出现的位置 | 服务器持久化 | 生命周期 |
| --- | --- | --- | --- | --- |
| `user_code` | CSPRNG；12 位 base20（`BCDFGHJKLMNPQRSTVWXZ`），显示为 `BCDF-GHJK-LMNP`，约 52 bit | 安装器/插件配对面板、学员确认页；不可复制为默认动作 | 只存 `HMAC-SHA-256(K, "user-code:v1" || normalized_code)` | 10 分钟 |
| `device_code` | CSPRNG 32 bytes (256 bit)，base64url | 仅首次 start 的 HTTPS 响应体、connector 内存和 0600/ACL 临时文件；**绝不显示**、不进 URL/日志 | 只存 `HMAC-SHA-256(K, "device-code:v1" || value)` | 至 ack；最长 10 分钟 |
| `wb_` credential | `wb_` + base64url(`HMAC-SHA-256(K, "credential:v1" || device_code)`) | poll 的 HTTPS 响应体、本机内存、最终私有 config；绝不显示或复制 | 仍只存既有 SHA-256 hash 与前缀 | 有效至撤销/轮换 |
| `K` | 新环境密钥 `WORKBUDDY_DEVICE_PROVISIONING_KEY`，至少 32 random bytes | 仅 application server secret store | 不入数据库、不入 bundle | 依部署密钥轮换策略 |

`HMAC` 的 label 做 domain separation。`device_code` 由 CSPRNG 生成且为 256 bit；由服务端 secret 派生的 `wb_` 同样不可预测。这个确定性派生解决了一个重要的可靠性问题：若服务端已签发但 HTTPS 成功响应在途中丢失，同一持有 `device_code` 的 connector 可以在短暂交付窗口内取回**同一个** `wb_`，无需让数据库保存明文 token。

`user_code` 不是凭证、不能兑换 token、不能用于 poll；数据库使用 keyed HMAC 是为了在数据库泄漏时也不能低成本离线穷举短码。RFC 的 base20 设计避开易混淆字符并允许分隔符；它给出的 8 位 base20 示例只有 `20^8` 熵。[RFC 8628 §6.1](https://www.rfc-editor.org/rfc/rfc8628.html#section-6.1) 本设计使用 12 位，再叠加限流。

> 新增的 `K` 是一项新的高价值安全边界。泄漏它会使未过期 `device_code` 可派生 token；不会反推已有只存 hash 的 `wb_`。轮换 `K` 前须先让所有 `delivering` 会话过期/撤销，轮换不会影响已 ack 的既有凭证。

### 数据库 schema

最小新增为 **1 张 service-role-only 表 + 2 个 service-role RPC + 1 个每分钟清理任务**；不改变 `workbuddy_credentials` 的公开结构或 resolver。下列 SQL 是实施用目标 schema（migration 中沿用项目的 `extensions`、`public` 和 grant 风格）：

```sql
CREATE TABLE public.workbuddy_device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HMAC hex；明文 device_code / user_code / wb_ 永不入库。
  device_code_hmac text NOT NULL UNIQUE,
  user_code_hmac text NOT NULL UNIQUE,

  -- 仅展示给学员的非敏感、受 schema 限制的信息。
  client_platform text NOT NULL,
  connector_version text NOT NULL,
  device_label text NOT NULL,

  status text NOT NULL DEFAULT 'pending',
  student_id uuid REFERENCES public.students(id) ON DELETE SET NULL,
  replace_active_credential boolean NOT NULL DEFAULT false,
  credential_id uuid REFERENCES public.workbuddy_credentials(id) ON DELETE SET NULL,

  poll_not_before timestamptz NOT NULL DEFAULT now(),
  poll_violation_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  denied_at timestamptz,
  delivery_expires_at timestamptz,
  acknowledged_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workbuddy_device_authorizations_device_code_hmac_check
    CHECK (device_code_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workbuddy_device_authorizations_user_code_hmac_check
    CHECK (user_code_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workbuddy_device_authorizations_platform_check
    CHECK (client_platform IN ('macos', 'linux', 'windows')),
  CONSTRAINT workbuddy_device_authorizations_version_check
    CHECK (connector_version = btrim(connector_version)
       AND char_length(connector_version) BETWEEN 1 AND 32),
  CONSTRAINT workbuddy_device_authorizations_label_check
    CHECK (device_label = btrim(device_label)
       AND char_length(device_label) BETWEEN 4 AND 64),
  CONSTRAINT workbuddy_device_authorizations_status_check
    CHECK (status IN (
      'pending', 'approved', 'delivering', 'consumed',
      'denied', 'expired', 'conflicted'
    )),
  CONSTRAINT workbuddy_device_authorizations_poll_violation_check
    CHECK (poll_violation_count >= 0),
  CONSTRAINT workbuddy_device_authorizations_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT workbuddy_device_authorizations_approved_identity_check
    CHECK (
      status NOT IN ('approved', 'delivering', 'consumed')
      OR student_id IS NOT NULL
    ),
  CONSTRAINT workbuddy_device_authorizations_delivery_check
    CHECK (
      status NOT IN ('delivering', 'consumed')
      OR (credential_id IS NOT NULL AND delivery_expires_at IS NOT NULL)
    )
);

CREATE INDEX workbuddy_device_authorizations_expiry_idx
  ON public.workbuddy_device_authorizations (expires_at)
  WHERE status IN ('pending', 'approved', 'delivering');
CREATE INDEX workbuddy_device_authorizations_student_idx
  ON public.workbuddy_device_authorizations (student_id, created_at DESC)
  WHERE student_id IS NOT NULL;

ALTER TABLE public.workbuddy_device_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workbuddy_device_authorizations
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.workbuddy_device_authorizations TO service_role;
```

`device_label` 由服务端从校验后的 platform 和随机展示后缀生成，例如 `macOS connector · MNPQ`；**不用 hostname**，避免把学员机器名上传到云端。它只帮助学员辨认，不能被当成可信设备身份。

### RPC 与事务边界

**RPC 1：批准，service-role-only**

```sql
public.approve_workbuddy_device_authorization(
  _user_id uuid,
  _user_code_hmac text,
  _replace_active_credential boolean
) RETURNS jsonb
```

实现要求：

1. 调用已有 `private.workbuddy_student_for_user(_user_id)`；绝不接收浏览器提交的 `student_id`。
2. `SELECT ... FOR UPDATE` 锁定对应 pending、未过期的授权行；过期时置 `expired` 并返回统一安全错误。
3. 检查该 student 是否已有 active credential。若有且 `_replace_active_credential=false`，返回安全的 `ACTIVE_CREDENTIAL_EXISTS`，由 UI 要求学员勾选“替换现有连接”后再次确认。
4. 置 `student_id`、`replace_active_credential`、`approved_at` 与 `status='approved'`；拒绝、过期或已完成均不可重新批准。
5. 返回仅含 `device_label`、`user_code`、状态和到期时间的 sanitized JSON，不含 hash、device code 或 token。

**RPC 2：poll + 原子签发，service-role-only**

```sql
public.poll_workbuddy_device_authorization(
  _device_code_hmac text,
  _credential_hash text,
  _credential_prefix text
) RETURNS jsonb
```

该函数是最关键的事务边界，必须使用 `SECURITY DEFINER`、`SET search_path = ''`，并只 `GRANT EXECUTE` 给 `service_role`，风格与现有 credential RPC 一致。它的行为：

1. 以 `_device_code_hmac` 找行并 `FOR UPDATE`；不存在时返回不区分的 `invalid_request`。检查 `expires_at`，过期则置 `expired`。
2. 比较 `poll_not_before`。过早时增加 `poll_violation_count`，将下一次允许时间至少推迟 5 秒，返回 `slow_down`；正常 poll 更新为 `now()+5s`。
3. `pending` 返回 `authorization_pending`；`denied`/`conflicted`/`expired` 返回终止状态；`consumed` 不再交付 credential。
4. 对 `approved`：以现有 `workbuddy-credential:<student_id>` advisory lock 串行化；若有 active credential 且未同意替换，置 `conflicted`；否则撤销旧 active（若适用），插入新 `workbuddy_credentials` 行（`source='issued'`、只存 `_credential_hash/_credential_prefix`），保存 `credential_id`，并置 `status='delivering'`、`delivery_expires_at=now()+interval '10 minutes'`。
5. 对仍在 `delivery_expires_at` 内的 `delivering`：不再签发第二条 credential，仍返回 `delivering`。路由层可凭同一个 device code 再派生同一个 `wb_` 后返回。

**确认 ack：不需要第三个复杂 RPC。** `POST /ack` 通过 service role 做条件更新：只有匹配的 HMAC、`status='delivering'` 且未过期时，才置 `status='consumed'`、`acknowledged_at/consumed_at=now()`。重复 ack 返回 204，不能重新交付。

**清理任务：** 每分钟以 service role 运行。它将过期的 `pending/approved` 置 `expired`；对于 `delivering` 先撤销其关联、尚未 ack 的 credential，再置 `expired`。这避免“服务端成功但客户端崩溃”留下无人持有的 active token。poll/start/confirm 也应先做同一清理，以降低调度延迟的影响。terminal 行保留 30 天做无密钥审计后再清理。

### 端点定义

新增 **3 个 connector 公共端点**，再新增一个已认证网页路由和 3 个同源 server function（或等价的已认证 API）。它们与 MCP OAuth 无耦合。

| 接口 | 鉴权 | 请求 / 响应 | 行为 |
| --- | --- | --- | --- |
| `POST /api/public/workbuddy/device-authorizations` | 无 bearer；WAF/IP 限流 | 请求：`{platform, connector_version}`。响应 200：`{device_code, user_code, verification_uri, expires_in:600, interval:5, device_label}` | start。服务器生成两种 code 和 label；`verification_uri` 固定为 `/workbuddy/connect-device`，不包含 code 或 secret。 |
| `POST /api/public/workbuddy/device-authorizations/poll` | `device_code` 是短时 bearer proof；只允许 JSON POST body | 请求：`{device_code}`。响应：202 `authorization_pending`；429 `slow_down` + `Retry-After`；200 `{credential:"wb_…", token_type:"WorkBuddy"}`；终止错误 `access_denied` / `expired_token` / `invalid_request` | 路由层先 HMAC raw code，再调用 RPC 2。仅 `delivering` 时将确定性派生 token 放进响应；不记录请求体。 |
| `POST /api/public/workbuddy/device-authorizations/ack` | 同上 | 请求：`{device_code}`；响应 204 | connector 的 config 已原子落盘后调用；关闭可重取窗口。 |
| `GET /workbuddy/connect-device` | 正常网页登录 | HTML/React 页面 | 未登录先到 `/auth`，登录后回同一路径；无 code query。 |
| `previewDeviceAuthorization({user_code})` | `requireSupabaseAuth` 同源 ServerFn | 返回有限的设备摘要与是否存在 active credential | 输入页验证短码，展示确认页；无效/过期统一文案。 |
| `approveDeviceAuthorization({user_code, replace_active_credential, confirmed:true})` | 同上 | 调 RPC 1 | 必须显式确认；绝不接受 `student_id`。 |
| `denyDeviceAuthorization({user_code})` | 同上 | 状态置 `denied` | 终态；connector 停止 poll 并删除临时文件。 |

所有三条公开端点均设置 `Cache-Control: no-store`、`Pragma: no-cache`、JSON `Content-Type`、`X-Content-Type-Options: nosniff`，不设置 `Access-Control-Allow-Origin: *`。配对页面设置 `Referrer-Policy: no-referrer`、`Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY`，不加载第三方脚本/图片/分析像素。`Cache-Control: no-store` 可避免敏感 API 响应进入浏览器或共享缓存；这是 OWASP 的明确建议。[OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)

## connector 与安装器状态机

### 新命令/程序接口

新增一个不接受 token 的内部操作：`authorize-device --api-url <origin>`。对于插件化安装，优先导出等价 JavaScript 函数 `authorizeDevice({apiUrl, platform, onPairing})` 供插件直接调用；这使“让 WorkBuddy 自己执行安装”不必把任何敏感文本作为 shell 参数或对话内容。

该操作不能把 `device_code`、HTTP response 或 `wb_` 输出到 stdout/stderr。允许显示的仅是 non-secret `user_code`、固定 URL、到期倒计时和安全状态。例如：

```text
请在已登录的浏览器确认这台设备：
https://copilot.example.com/workbuddy/connect-device
代码：BCDF-GHJK-LMNP（10 分钟内有效）
```

短码是一次性、限时、只能在登录确认后绑定的配对标识，不是 credential；它可以显示在插件原生安装面板或终端 UI，但不提供“复制凭证”动作。

### 本地文件和状态转换

不要放宽或扩展现有 `config.json` 的严格 v1 schema。新增独立的 `device-authorization.json`，在同一个私有 state root 下以现有 `atomicWrite`、POSIX 0600 和 Windows current-user ACL 保存：

```json
{
  "version": 1,
  "api_url": "https://copilot.example.com",
  "device_code": "<short-lived secret>",
  "expires_at": "2026-07-26T...Z",
  "poll_interval_seconds": 5
}
```

它在成功 ack 后安全删除；绝不写入 settings、Skill、outbox、render ledger 或 scheduled log。

```text
UNCONFIGURED
  └─ install files → STARTED
STARTED
  ├─ start 成功；原子写 device-authorization.json → WAITING
  └─ 网络失败 → RETRYABLE_START（用户点“重试”，不自动无限创建会话）
WAITING
  ├─ pending / slow_down / 网络超时 → WAITING（保留临时文件、退避）
  ├─ denied / expired / conflicted → TERMINAL（删除临时文件；不注册 hook）
  └─ delivering + wb_ 响应 → CONFIG_WRITING
CONFIG_WRITING
  ├─ config.json 原子写成功 → ACKING
  └─ 本地写失败 → WAITING（不 ack，可在交付窗口重取同一 token）
ACKING
  ├─ ack 204；删除临时文件 → CONFIGURED → 注册 hook/schedule/import
  └─ 网络失败 → CONFIG_DURABLE_NEEDS_ACK（仅重试 ack；不重新展示或读取 wb_）
```

connector 需新增一个**无 bearer** `requestDeviceJson`，复用现有：HTTPS/localhost URL 校验、禁止 redirect、15 秒超时、限长响应、指数退避加 jitter。它不得调用当前会从 config 自动拼 `Authorization: Bearer ${token}` 的请求函数。轮询严格遵守 `interval=5`；收到 `slow_down` 后每次至少增加 5 秒；网络超时指数退避但不低于当前 interval；除 `authorization_pending`、`slow_down` 和可恢复网络错误外，所有状态都停止轮询。这与 RFC 8628 的轮询要求一致。[RFC 8628 §3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.5)

安装器/插件的顺序应为：**下载/校验并安装程序文件 → 设备授权并 ack → 注册 Stop hook、计划任务和一次历史导入**。拒绝、过期或失败时保留程序文件以便重试，但不注册 hook/schedule/import，避免未配置 connector 产生无意义日志。

## 网页 UI 设计

### `/workbuddy` 的变化

1. 默认卡片从“生成凭证 / 复制凭证”替换为“连接这台设备”。它仅解释：安装器会打开浏览器、显示短码；凭证不会显示给学员。
2. 删除正常路径上的 `oneTimeToken` 状态、token `<code>`、复制 token 按钮和“粘贴到遮罩输入框”的说明。
3. 保留“当前连接状态、最近使用、撤销/替换连接”，只显示既有安全前缀而非 token。
4. 设备确认页显示：短码、`macOS/Linux/Windows connector · XXXX`、connector version、请求开始/到期时间、会发生的效果（“此设备会得到一个可上传你的 WorkBuddy turn 的专用凭证”）。
5. 用户必须输入或在打开页面后再次勾选“网页显示的码与安装器当前显示的码一致，且设备在我身边”，然后按“确认连接”。若已有 active credential，则额外勾选“替换现有连接”；按钮文案明确说明旧设备会立即失效。
6. 拒绝后显示“未连接任何设备”，而非泛称错误；无效、过期和次数过多对外统一为“代码无效或已过期，请回到安装器重新开始”。

即使未来加 QR 或 `verification_uri_complete` 自动带入短码，也不能跳过显示和核对。RFC 明确指出完整 URI 优化时仍应显示 code 并让用户核对正在设置的设备；同时应显示设备信息并提示用户确认设备在身边，以降低远程钓鱼。[RFC 8628 §3.3.1、§5.4](https://www.rfc-editor.org/rfc/rfc8628.html#section-5.4)

## 安全要求与逐项落实

| 要求/威胁 | 设计控制 | 验证要点 |
| --- | --- | --- |
| 短码熵与有效期 | 12 位 base20（约 52 bit）、10 分钟、规范化为大写且忽略分隔符；唯一索引碰撞时重生。 | 单测生成字符集/长度/碰撞重试；时钟测试过期。 |
| 一次性消费 | `approved → delivering → consumed`；RPC 2 锁行并仅在 `approved` 插入一条 credential；ack 后永不再返回 token。 | 并发 20 poll 只新增一条 credential；ack 后 poll 无 token。 |
| 响应丢失但不存明文 | `delivering` 的有限窗口内，由同一 `device_code` + server HMAC 派生相同 `wb_`；config 成功后 ack 关闭窗口；未 ack 的 credential 由每分钟清理任务撤销。 | 模拟 RPC 成功/响应断开/重试，得到同一 token；DB 查不到明文。 |
| 暴力枚举与资源耗尽 | 强制 WAF/edge policy：start 每 IP 10/15min；poll 每 IP 60/min；确认输入每 IP 10/min、每已登录账号 5/10min。RPC 另按 `poll_not_before` 强制单会话最少 5 秒，违例 `slow_down`。 | 429/Retry-After、WAF 配置验收、数据库时间竞争测试。 |
| 未授权 connector 如何轮询 | 不使用静态 client secret，也不使用短码；`device_code` 是短时 256-bit bearer proof，放 JSON POST body。设备客户端按 public client 对待。 | 请求 headers、URL、日志、临时文件权限审计。 |
| device code 重放 | HMAC 存库而非明文；只有 `delivering` 的未 ack 窗口可同码重取同一 token，ack/过期后拒绝；不可能用短码重放。 | ack 后/过期后均无 token；随机错误不泄露会话存在。 |
| 误确认别人的设备/钓鱼 | 固定 URL + 手工输入短码；页面展示并要求核对短码、本机 platform/version/label、到期时间和“设备在身边”确认；直接 URL/QR 也强制二次核对。 | UI 测试：预填码不能直接批准；错误码、旧码、不同码均不能批准。 |
| 学员身份绑定 | 确认 action 从 `requireSupabaseAuth` 的服务端 `context.userId` 映射 student；客户端不传/不信任 `student_id`。 | 用 A 的 browser token 尝试绑定 B 的 ID 必须无效；staff 账户被拒绝。 |
| 已存在连接 | UI 先显示安全前缀并要求显式替换；消费 RPC 再次在事务内检查 active 行并锁定，防止并发批准双发。 | 不勾选替换时旧 token 连续可用；勾选后原子轮换。 |
| 缓存、Referer、CORS、日志泄漏 | no-store/no-cache；固定确认 URL；无 `*` CORS；页面 no-referrer、禁止 frame、无第三方资源；log allowlist 只记授权行 UUID、状态、时间、request id，绝不记 body/header/code/token。 | 端到端搜 `wb_`、`device_code`、request body；检查响应头与 access/APM scrubber。 |
| 本机恶意软件 | 0600/ACL、短时临时文件、完成后删除、无静态 client secret；不声称可抵御拥有当前用户权限的恶意软件。 | POSIX mode/Windows ACL 自动化测试。 |

RFC 8628 将 device client 视为不能保守静态 client credential 的 public client，并要求 device code 有很高熵；本设计因此没有“藏在插件里的 client_secret”。[RFC 8628 §5.2、§5.6](https://www.rfc-editor.org/rfc/rfc8628.html#section-5.6)

### 日志与审计的硬规则

允许的审计字段：`authorization_id`（UUID）、状态转换、平台、connector version、student UUID（仅 server audit）、request id、时间、限流决策。禁止字段：`device_code`、`user_code`、`wb_`、`Authorization`、请求/响应 body、token hash/HMAC。错误对象也必须被映射为 allowlisted code，不能 `console.error(error)` 或在 debug 模式 dump response。

## 失败、恢复与降级

| 场景 | 学员体验 | connector/服务端行为 |
| --- | --- | --- |
| 浏览器无法自动打开 | 配对面板保留固定 URL 和短码；可在同机或手机浏览器打开 URL、手输短码。 | 自动打开失败不是失败；不把 `device_code` 放 URL。 |
| 短码过期 | 网页提示回到安装器重试。 | poll 返回 `expired_token`；删除临时文件；仅在用户点击“重试”后创建新会话，禁止自动无限循环。 |
| 学员点击拒绝 | 网页显示已拒绝。 | poll 返回 `access_denied`；删除临时文件、不写 config、不注册 hook。 |
| start/poll 网络中断 | 安装面板显示“等待网络/继续重试”。 | 保留 0600 pending 文件；指数退避；恢复后从同一会话继续，未过期不生成新短码。 |
| token 响应到达但本地 config 写失败 | 不要求学员重新确认。 | 不 ack；在 `delivering` 窗口内同一 device code 重取确定性的同一 token；重试原子写。 |
| config 已写、ack 网络失败/进程崩溃 | 显示“本地已连接，正在完成确认”；下次启动可继续。 | 保留 pending 文件，仅重试 ack；完成前不注册 hook/schedule。超过窗口未 ack 的 cleanup 会撤销 orphan credential，随后须重新配对。 |
| 同时/之后出现另一 active credential | 网页明确提示替换；不能静默抢占。 | 消费事务检测冲突，置 `conflicted`，要求重新发起并重新确认。 |

## 与插件化安装的协作契约（WDP 路径）

插件化安装的具体下载/校验方案由并行调研决定；本方案只规定它与 WDP 的边界：

1. 插件把安装器和 connector 文件放好后，**直接调用** connector 的 `authorizeDevice` 程序接口。不得让 WorkBuddy 把“含 token 的命令”当作模型提问，也不得把 HTTP response 作为会话消息显示。
2. 插件面板可显示短码、倒计时、固定浏览器 URL 和非敏感状态；可调用 OS 打开固定 URL。它不展示、复制、缓存或记录 `device_code`/`wb_`。
3. 授权并 ack 成功后，插件调用既有“注册 Stop hook、计划任务、可选导入”的 finalize 步骤；在此之前 connector 程序文件虽已安装，但不接管 WorkBuddy turn。
4. 插件若只能经子进程调用，参数只能含安装路径和 API origin；stdout/stderr 仅传回 allowlisted 状态。不要通过 WorkBuddy 对话、命令文本或剪贴板传任何 credential。WDP 路径也不需要以环境变量传 credential。
5. 安装升级检测到 `device-authorization.json` 时优先 resume/ack，不另建会话；检测到有效 config 时不重复授权。

这使“WorkBuddy 自己执行安装”成为一个本机插件动作，而不是模型生成并回显的 shell 操作。即使插件执行过程被呈现在 WorkBuddy UI，呈现内容也最多是短码和状态，绝不会包含可用于上传 timeline 的 `wb_`。

若 P0 证明 `sensitive userConfig` 可用，插件另可有一条**过渡**路径：平台弹窗收集已有 `wb_`，child process 只读其环境变量、在内存中写入 connector 私有 config。该路径的 hook command 仍不得 substitution token；其 stdout/stderr/事件同样只能输出 allowlisted 状态。它不改变上述 WDP 默认路径的需求，也不应该让 token 留在 plugin manifest、Skill 或 command argument。

## 安全边界变化

| 边界 | 当前手动粘贴 | WDP 后 | 为什么仍安全 |
| --- | --- | --- | --- |
| 学员对话/timeline | 学员可能把 `wb_` 粘进 WorkBuddy prompt，Stop hook 采集并上传。 | token 不经模型或对话；hook 注册也在授权成功后。 | 根因路径被移除，而非依赖提示学员“不要粘贴”。 |
| 浏览器 | 页面一次性显示并可复制长期 token。 | 页面只批准短时、不可兑换的短码；不渲染 `wb_`。 | 身份来自已登录 session，确认操作与设备绑定独立。 |
| 服务器数据库 | 仅 credential hash/prefix。 | 新增最多 10 分钟的 pairing metadata/HMAC/学生绑定/设备摘要。 | 不新增明文 credential；表仍 service-role-only，且不关联 timeline 读取路径。 |
| 未授权 connector | 无身份，必须向用户索要 token。 | 持有临时 `device_code` bearer proof。 | 256 bit、短时、私有临时文件、只 POST、ack 后失效；它不是静态 credential。 |
| 服务端密钥 | 只依赖服务 role 与 CSPRNG 签发。 | 多一个 device provisioning HMAC key。 | key 仅在 secret store；影响限于未完成交付；轮换流程明确。 |
| 已授权 connector | config 内保存长期 `wb_`。 | 不变。 | 继续使用现有 0600/ACL，现有 resolver/public API scope 不变。 |

不能消除的边界：拥有该学员本机当前用户权限的恶意软件能读 config 或窃取内存中的短时 device code；同样也可直接操纵 WorkBuddy。本设计缩短并收紧了授权前窗口，但不声称防御本机已失陷。若未来必须防御该类威胁，应另做每安装实例密钥对、证明持有（PoP）和 token 加密交付，成本明显更高，超出本次最小增量。

## 手动粘贴是否保留

**不保留“网页复制 token → 命令/对话粘贴”为学员默认兜底；短期保留底层 create/rotate/revoke 能力作为受控回滚路径。**

理由：设备授权的失败路径已经覆盖浏览器打不开、过期、拒绝、网络中断和响应丢失。继续在正常 UI 露出“生成/复制 `wb_` 并粘贴”会重新引入最初的泄漏路径，尤其在“让 WorkBuddy 代执行”的场景中很容易被当成对话内容。

过渡建议：一个发布周期内保留现有 server-side credential API，供管理员/支持人员在 feature flag 下处理灾难恢复；普通学员 `/workbuddy` 不显示 token。若 P0 验证通过，`sensitive userConfig` 可成为这条恢复路径的安全输入通道（仍不满足无剪贴板目标）；否则仅限受控人工恢复。完成设备流稳定性与迁移监控后，再删除用户可见的长期 token 展示。

## 实施切分、验收与工作量

### 实施顺序

1. **P0：先完成 `sensitive userConfig` 实机 spike**，按本报告的六项验证取得证据；在此之前不将它写入产品安全承诺。
2. 若坚持无 token 手输/复制，或 P0 失败：加 migration、两条 RPC、每分钟清理任务、server secret 和 WAF/edge 限流规则；以 pgTAP/集成测试证明权限、锁、过期和一次性消费。
3. 再加 public start/poll/ack handlers、secret scrubber 与响应头；更新 connector：pending 文件、无 bearer helper、状态机、确定性重取、ack、redaction；同步更新下载副本（仓库测试要求 downloads 与 `connectors/` 资产一致）。
4. 更新网页与安装器/插件接点；删除默认 token 展示；最后接入 Stop hook 的 finalize 顺序。若 P0 成功，可在此阶段另加 userConfig 恢复路径，但不得把它误标为一键授权。
5. 灰度：feature flag 按学员开启，观察配对成功率、过期率、ack 延迟、rate-limit 命中；审计采样中必须验证无 `wb_`/code/body。

### 必须覆盖的测试

- 并发 poll、重复 poll、ack 重放、start/user-code 碰撞、过期、拒绝、冲突替换。
- RPC 只能被 service role 执行；authenticated/anon 无法读表、无法传任意 `student_id`。
- 200 响应丢失后重取相同 credential；ack 后/过期后不能重取；cleanup 撤销未 ack credential。
- rate limit、`slow_down`、`Retry-After`、通用错误不泄露有效 code。
- POSIX mode、Windows ACL、pending 文件删除、crash recovery；对 connector stdout/stderr/log/outbox/Skill/settings 做 `wb_`、`device_code`、request body 搜索。
- 浏览器未登录跳转返回、已登录身份绑定、active credential 显式替换、点击劫持/缓存/Referrer/CORS 头。
- 端到端：模拟 WorkBuddy Stop hook 后的第一条 turn 中不存在 token，导师 timeline 也没有 token。

### 估算（1 名熟悉本仓库的工程师）

| 范围 | 内容 | 估算 |
| --- | --- | --- |
| P0 userConfig 验证 | 临时测试插件、启用/环境/Keychain-or-fallback/卸载重装验证、无值泄漏审计 | 0.5–1 人日 |
| userConfig 过渡路径（仅 P0 成功且产品接受手输） | manifest、仅环境变量读取、connector 适配、平台行为回归和泄漏测试 | 1.5–3 人日 |
| 服务端 | migration、2 RPC、清理任务、3 public handlers、auth server functions、限流/headers/secret scrubber、pgTAP/集成测试 | 4–5 人日 |
| connector / 安装器 | pending 文件、无 bearer helper、状态机、platform opener、ack/recovery、三平台测试与下载资产同步 | 3–4 人日 |
| 网页 | connect-device 页面、确认/拒绝/替换 UI、移除默认 token 展示、端到端测试 | 1.5–2 人日 |
| 插件对接 | 调用程序接口、非对话安装面板、finalize 顺序；取决于并行插件调研结论 | 1–2 人日 |
| 安全/发布验证 | WAF 配置、密钥轮换演练、日志审计、灰度与回滚演练 | 1.5–2 人日 |

P0 后若仅交付 userConfig 过渡路径，约 **2–4 人日**（但不满足无剪贴板一键目标）。P0 后交付完整 WDP 约 **11–15 人日**，服务端、connector、网页可部分并行，完整可灰度版本预计 **6–8 个工作日**；两条都做则在 WDP 基础上增加约 **1.5–3 人日**。

## 参考来源

- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628.html)：设备/用户码角色、轮询、短码可用性、远程钓鱼和 public client 的安全要求。
- [RFC 8628 §3.3.1 — complete verification URI 仍应核对设备码](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.3.1)
- [RFC 8628 §5.1–5.6 — 短码暴力枚举、高熵 device code、钓鱼与 public client](https://www.rfc-editor.org/rfc/rfc8628.html#section-5.1)
- [Supabase OAuth 2.1 Flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)：当前支持的 grant types 与 PKCE 流程。
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)：`Cache-Control: no-store`、通用错误、响应安全 headers。
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)：认证 token 与 session 标识的日志处理原则。
- 本机随 WorkBuddy bundle 分发的 `plugins-reference.md:307-331`：`userConfig`、`sensitive`、Keychain/fallback 与 plugin-child 环境变量声明（本地官方文档，须以 P0 实机验证其当前版本行为）。
