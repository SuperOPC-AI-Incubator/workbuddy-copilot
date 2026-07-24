# Supabase 托管 Auth 配置安全对齐

日期：2026-07-24

## 范围

核对 Supabase CLI 2.109.1 对托管项目配置的写入行为，确定团队项目
`hwxbrkvvziqpvsmyllqn` 的最小可审计配置方式。研究和代码变更本身不修改线上项目。

## 已验证事实

- `supabase config push` 会把本地 `supabase/config.toml` 推送到指定或已链接项目；当前
  `config push --help` 只有 `--project-ref`，没有 Auth 配置 dry-run。
- `supabase login` 会优先把 token 保存在原生凭证库；默认 profile 的 Keychain service
  是 `Supabase CLI`、account 是 `supabase`。原生凭证库不可用时才回退到权限为 0600 的
  `<SUPABASE_HOME or ~/.supabase>/access-token` 文件。
- 当前 CLI 会先读取远端 Auth 配置、计算差异，再通过 Management API 更新。其 Auth
  更新体由完整的本地 Auth 结构生成，不只包含本次希望改变的 URL 和注册开关。
- Management API 的
  `PATCH /v1/projects/{ref}/config/auth` 接受字段均为可选的更新体。与本次闭环直接相关的
  远端字段是：
  - `site_url`
  - `uri_allow_list`
  - `disable_signup`
  - `external_email_enabled`
  - `mailer_autoconfirm`
- CLI 映射关系存在两个反向布尔：
  - `auth.enable_signup` → `disable_signup = !enable_signup`
  - `auth.email.enable_confirmations` →
    `mailer_autoconfirm = !enable_confirmations`
- Supabase 建议生产环境使用精确 redirect URL；`SITE_URL` 是没有有效 `redirectTo` 时的
  默认地址，也是邮箱确认与密码重置的重要基础地址。

## 结论与实现约束

以下是基于上述事实作出的项目决策：

1. `supabase/config.toml` 只跟踪团队项目 ref，不在其中补一套不完整的生产 Auth
   默认值，也不把 `supabase config push` 作为生产 Auth 配置入口。
2. `supabase/auth.production.json` 跟踪五项公开意图：
   - Site URL 为 `https://copilot.sg.superbrain-ai.com`
   - 只登记同域精确根路径 redirect
   - 允许项目注册与 Email 注册
   - 暂不要求 Email 确认，让原型注册后立即获得会话
3. `scripts/configure-supabase-auth.mjs` 默认只 GET 并展示这五项的差异。写入必须显式
   提供 `--apply --project-ref <ref>`，且 ref 必须同时匹配两个跟踪配置文件。
4. PATCH 体只允许上述五个字段；SMTP、密码策略、OAuth、短信、令牌等未审阅远端设置
   原样保留。写入后再次 GET，五项未完全一致则失败。
5. macOS 上脚本通过无 shell 的 `/usr/bin/security` 子进程直接读取 CLI 默认 profile
   Keychain item，只在父进程内存中持有 token；CI/非 macOS 继续使用平台 Secret 注入的
   `SUPABASE_ACCESS_TOKEN`。
6. Supabase Auth 的注册开关不能区分“学员自助注册”和“导师注册”。公开注册只成为
   学员仍由现有 UI、Auth trigger 与数据库角色约束保证；导师账号继续只走团队管理员
   创建流程。

## 来源

- Supabase CLI `config push` 官方参考：
  <https://supabase.com/docs/reference/cli/supabase-config-push>
- Supabase CLI 2.109.1 配置更新器：
  <https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/pkg/config/updater.go>
- Supabase CLI 登录与凭证存储：
  <https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/docs/supabase/login.md>
- Supabase CLI 2.109.1 token 读取顺序：
  <https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/internal/utils/access_token.go>
- Supabase CLI 2.109.1 Auth 字段映射：
  <https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/pkg/config/auth.go>
- Supabase CLI 2.109.1 Management API OpenAPI：
  <https://github.com/supabase/cli/blob/v2.109.1/packages/api/src/generated/openapi.json>
- Supabase Auth Redirect URLs：
  <https://supabase.com/docs/guides/auth/redirect-urls>
- Supabase CLI `config.toml` 官方模板：
  <https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/pkg/config/templates/config.toml>
