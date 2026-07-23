# Supabase RPC、RLS 与 pgTAP 实现核对

日期：2026-07-23

## 范围

Task 3B 的技术方案已经锁定。本次只核对 PostgreSQL/Supabase 的函数安全、并发幂等与数据库测试语法，不重新做架构选型。

## 已验证事实

- Supabase 建议 `SECURITY DEFINER` 函数显式设置空 `search_path`，并对引用对象使用完整 schema 名称，避免对象解析落入不可信 schema。
- PostgreSQL 函数默认可能由 `PUBLIC` 执行；迁移应先显式撤销 `PUBLIC`、`anon`、`authenticated` 的执行权限，再只向需要的角色授权。
- PostgreSQL `INSERT ... ON CONFLICT` 提供并发下的原子冲突处理，可用唯一索引作为会话键和事件 ID 的仲裁边界。
- 应用应按 SQLSTATE 而不是本地化错误文本映射冲突；自定义五位 SQLSTATE 可以为事件哈希冲突提供稳定的 HTTP 409 映射。
- Supabase 的数据库测试由 `supabase test db` 运行 pgTAP；官方示例使用 `BEGIN`、`plan()`、`finish()`、`ROLLBACK`，并通过 `SET LOCAL ROLE authenticated` 与 `request.jwt.claim.sub` 验证 RLS。

## 对 Task 3B 的约束

1. 只有绕过调用者 RLS/权限确有必要的 helper、Auth trigger 和受控 web-seen 写入口使用 `SECURITY DEFINER`。
2. 所有函数使用 `SET search_path = ''`，表、类型和跨 schema 函数均完整限定。
3. 事件 ID 先写入幂等 ledger；唯一事件冲突等待并读取已提交结果，同 ID 不同哈希抛出固定 SQLSTATE。
4. `(student_id, source, source_session_key)` 使用唯一索引和 `ON CONFLICT` 原子解析，不使用按标题或最近会话查询。
5. pgTAP 文件是真实 SQL 测试，但本机没有 PostgreSQL、Supabase CLI 或 Docker，因此只能在后续 CI/可用数据库环境执行。

## 迁移与兼容边界

- 认证客户端不再拥有 `students` 的表级 `SELECT`；只授予当前导师列表需要的安全列。学员配置页暂时通过仅返回当前学员记录的 `get_my_legacy_workbuddy_setup()` 读取旧 token，该 RPC 会拒绝 staff 身份，并在 Task 6 与旧列一起删除。
- `students` 的 Realtime 订阅也显式使用 `select` 限制为 UI 所需的四列，避免变更流重新暴露未授权字段。
- 旧 token 以 pgcrypto SHA-256 写入 `workbuddy_credentials`，展示前缀同样从 hash 派生，因此短 token 或带空白 token 不会破坏约束；`source='legacy_token_backfill'` 明确标注过渡来源，重复执行以 token hash 冲突为幂等边界。
- 已有 mentor/team_admin 只接受 `auth.users.raw_app_meta_data` 中同时存在的 `account_kind='staff'` 与显式 `staff_username`。迁移绝不从邮箱或用户可编辑 metadata 猜用户名。
- 导师用户名映射出的 Supabase Auth 邮箱是 opaque 实现标识，不是秘密；标准 Supabase session/JWT 与客户端 `user` 对象仍会携带该邮箱 claim。本项目不承诺把它从浏览器 session/JWT 中移除，但禁止将其作为一等字段返回到登录 DTO、显示在 UI、写入日志或暴露在账号管理响应中。公开显示身份只取 `staff_accounts.username` 或学员 profile。
- 首次改密由携带当前 Supabase bearer token 的 POST serverFn 编排：服务端只采用认证中间件给出的 `userId`，先通过 Auth Admin 更新密码，再以 `service_role` 调用显式目标的完成函数。浏览器角色无权执行完成函数；Auth 更新失败时绝不清除 `must_change_password`，完成步骤支持同一激活导师幂等重试。
- 若已有特权角色无法映射到 `staff_accounts`，迁移以 SQLSTATE `PST01`、消息 `unresolved_staff_accounts` 中止。管理员应先用可信 Auth Admin 路径补齐上述 app metadata，再重跑迁移；空白/新项目没有既有特权角色，因此不受影响。
- 认证端会话写入只允许 `source='web'` 且无 source key；timeline 客户端列权限不包含 connector provenance。导师直写与 service RPC 都经过同一 BEFORE/AFTER trigger 链，统一派生用户名并原子创建待投递记录。
- 原有 timeline 聚合触发器函数改为最小权限 `SECURITY DEFINER`，在收紧客户端 UPDATE 权限后仍能更新 session/student 的严重度与活跃时间。
- 跨表复合外键保证 event、session、student、timeline 与 delivery 属于同一条所有权链；delivery 触发器拒绝引用非 mentor timeline，并与 timeline kind 更新守卫共同加锁，防止已投递消息被改成其他 kind。
- 两客户端并发集成测试只在设置专用测试项目 URL、service key、student ID 且显式 `CLOUD_INTEGRATION_TEST_ALLOW_WRITES=true` 时运行。本机缺少配置时标记为 skipped，不计为数据库通过。测试包含三轮客户端发射屏障和精确行数断言，但客户端屏障本身不能证明数据库事务真实重叠；该证据仍需专用 Supabase CI 实际运行后确认。

## 来源

- Supabase Database Functions — Security definer 与函数权限：<https://supabase.com/docs/guides/database/functions>
- Supabase Database Testing — pgTAP 与 RLS 测试：<https://supabase.com/docs/guides/local-development/testing/overview>
- PostgreSQL `INSERT` — `ON CONFLICT` 原子语义：<https://www.postgresql.org/docs/current/sql-insert.html>
- PostgreSQL Error Codes — SQLSTATE 稳定错误分类：<https://www.postgresql.org/docs/current/errcodes-appendix.html>
