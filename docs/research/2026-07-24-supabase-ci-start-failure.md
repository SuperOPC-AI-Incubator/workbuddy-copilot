# Supabase CI 启动失败诊断

日期：2026-07-24

## 结论

能确定的直接失败点是本地 Supabase 启动，而不是本轮业务代码：

- [失败 run 30061128457](https://github.com/SuperOPC-AI-Incubator/workbuddy-copilot/actions/runs/30061128457) 两个 attempt 都停在 `supabase start`，分别约 100 秒、85 秒；迁移、pgTAP、集成测试和浏览器测试尚未运行。
- [成功基线 run 30057810153](https://github.com/SuperOPC-AI-Incubator/workbuddy-copilot/actions/runs/30057810153) 的同一步约耗时 97 秒，随后 126 个 pgTAP 通过。
- 失败 attempt 1 与成功基线使用同一 Ubuntu runner image；`supabase/setup-cli` action commit 也相同。失败 attempt 2 才切换到更新的 runner image，因此 runner image 变更不能单独解释两次失败。
- 两个提交之间没有改 `supabase/config.toml` 或原 `supabase start` 命令。当前稳定版仍是 [Supabase CLI v2.109.1](https://github.com/supabase/cli/releases/tag/v2.109.1)。

历史 workflow 使用 `>/dev/null 2>&1` 丢弃了 CLI 在失败时产生的全部证据。因此，仅凭 run 30061128457 无法可靠地区分镜像仓库网络错误、runner 资源抖动、容器健康检查或 migration 错误。

加入安全诊断后的 [run 30062353821](https://github.com/SuperOPC-AI-Incubator/workbuddy-copilot/actions/runs/30062353821) 给出了精确根因：

```text
ERROR: LOCK TABLE can only be used in transaction blocks (SQLSTATE 25P01)
```

失败发生在 `supabase start` 自动应用 `20260724010000_require_fetch_before_ack.sql` 时。该 migration 直接执行 `LOCK TABLE`，但文件自身没有 `BEGIN`/`COMMIT`；Supabase CLI migration runner 也没有为整份文件隐式提供事务块。PostgreSQL 官方文档明确说明，`LOCK TABLE` 在事务块之外会报错，并要求用 `BEGIN` 与 `COMMIT`/`ROLLBACK` 定义事务块：[PostgreSQL LOCK](https://www.postgresql.org/docs/current/sql-lock.html)。

## 官方实现证据

Supabase CLI v2.109.1 的源码显示：

- 完整服务栈启动后的健康检查窗口固定为 30 秒，并在失败时返回错误：[start.go](https://github.com/supabase/cli/blob/6d4c19870ed213ba7f682f117d0345c8a40bfa94/apps/cli-go/internal/start/start.go#L154-L185)、[启动末尾健康检查](https://github.com/supabase/cli/blob/6d4c19870ed213ba7f682f117d0345c8a40bfa94/apps/cli-go/internal/start/start.go#L1264-L1274)。
- 健康检查失败时，CLI 会把未就绪容器的日志写到 stderr，正是原 workflow 丢弃的内容：[WaitForHealthyService](https://github.com/supabase/cli/blob/6d4c19870ed213ba7f682f117d0345c8a40bfa94/apps/cli-go/internal/db/start/start.go#L192-L224)。
- 普通启动失败返回前，CLI 会清理该项目的本地 Docker 资源：[Run](https://github.com/supabase/cli/blob/6d4c19870ed213ba7f682f117d0345c8a40bfa94/apps/cli-go/internal/start/start.go#L73-L80)。

## 修复边界

本次只修复 CI 可复现性与可诊断性，不改变被测 Supabase 服务或测试判据：

1. CLI 固定为已验证的 `2.109.1`，消除 `latest` 漂移。
2. 启动输出只在失败时经过 allowlist 和凭据脱敏后显示；成功输出中的本地密钥不进入日志。
3. 只对明确的 registry 限流、网络错误或容器健康超时清理后重试一次。
4. 单次 start 限时 8 分钟、cleanup 限时 2 分钟；超时进程先 TERM，5 秒后仍未关闭则 KILL。
5. 配置错误、镜像不存在、命令超时以及第二次失败保持非零退出，后续数据库和浏览器测试不会被伪造为通过。

## Migration 修复

ACK forward migration 现在显式以 `BEGIN` 开始、以文件末尾的 `COMMIT` 结束。`ACCESS EXCLUSIVE` 锁继续覆盖以下完整原子区间：

1. 重排历史 acknowledged-without-fetch 行；
2. 添加并验证 fetch-before-ack CHECK；
3. 替换 ACK RPC；
4. 恢复 service-role-only 权限。

防回归测试锁定 `BEGIN < LOCK < repair < constraint < RPC grant < COMMIT` 的顺序。真实 Supabase CLI 2.109.1 migration runner 已从空数据库成功应用全部 migrations；`supabase db reset` 和 135 个 pgTAP 均通过。Forward-upgrade runner 每次先在 migration transaction 内注入一个确定性 SQL 错误，验证失败后的独立 cleanup 能恢复 validated CHECK 和测试数据，再运行真实 migration 的 7 项语义断言。
