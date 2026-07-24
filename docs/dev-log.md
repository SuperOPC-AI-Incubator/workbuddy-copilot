# 开发验证日志

## 2026-07-24 — Supabase CI 启动可诊断性

- 范围：固定 Supabase CLI 版本；安全保留失败诊断；仅为明确瞬态错误提供一次有界重试。
- RED：`bunx vitest run tests/unit/supabase-start-ci.test.ts tests/unit/ci-contracts.test.ts`
  - 新启动策略模块不存在。
  - workflow 仍使用 `latest` 且将 `supabase start` 输出重定向到 `/dev/null`。
- 首轮 GREEN：定向 10 个测试通过；随后补充永久 `manifest unknown` 不重试和 URL query 凭据脱敏，定向 11 个测试通过。
- 首轮全量：格式与 lint 通过，TypeScript 因 `.mjs` 测试导入缺声明失败；增加同名 `.d.mts`，未改变运行逻辑和判据。
- 独立 review：发现 Bearer、`SUPABASE_*_KEY`、JSON token 三种脱敏遗漏，以及 start/stop 子进程缺命令级超时。补充负控后均先见 RED，再修复。
- timeout 负控：验证挂起进程先收 `SIGTERM`，5 秒后仍未退出则收 `SIGKILL`；另验证 timeout 后即使进程以 0 关闭也必须保持失败。检查过程中还捕获并修复了普通 close code 0 被误转为 1 的问题。
- 最终定向：`bunx vitest run tests/unit/supabase-start-ci.test.ts tests/unit/ci-contracts.test.ts`，14 个测试通过。
- 最终全量：`bun run check` 通过；39 个测试文件通过、1 个跳过，380 个测试通过、6 个既有跳过；生产构建通过。
- 最终独立复审：No findings；此前所有 Critical/Important 均已关闭。
- 判定：PASS。真实 GitHub hosted runner 的 Supabase 启动仍需提交后的 CI 验证；本地未连接或修改任何托管/生产 Supabase。

## 2026-07-24 — ACK migration 事务边界

- 精确根因：[CI run 30062353821](https://github.com/SuperOPC-AI-Incubator/workbuddy-copilot/actions/runs/30062353821) 的安全诊断显示 `LOCK TABLE can only be used in transaction blocks (SQLSTATE 25P01)`；其他 jobs 全绿，启动脚本正确地没有把该确定性错误当作瞬态重试。
- 真实 runner RED：Supabase CLI 2.109.1 的 `supabase start` 在本地复现同一 `25P01`。仅为避开另一项目占用的默认端口使用过临时本地端口，验证后已完全恢复；未连接托管项目。
- 静态 RED：`bunx vitest run tests/unit/workbuddy-task6-contracts.test.ts` 在缺少 migration `BEGIN` 时失败。
- 最小修复：ACK migration 显式以 `BEGIN` 开始、文件末尾 `COMMIT`，原 `LOCK → repair → validated CHECK → RPC replacement → grants` 顺序保持不变。
- Fixture RED：原 forward-upgrade fixture 用外层事务包住 migration；migration 新增的 `COMMIT` 会结束外层事务并删除 `ON COMMIT DROP` 临时表。fixture 改为同一 psql 会话内的自提交阶段和 `ON COMMIT PRESERVE ROWS`。
- 独立 review 发现 fixture 失败可能发生在尾部清理前，留下已提交的 constraint drop 和测试数据。runner 现每次先向 migration transaction 注入一个确定性缺表错误，要求真实 RED；`finally` 再用独立 psql cleanup transaction 锁表、删除固定账号、重排异常 ACK，并恢复且断言 validated CHECK，随后才运行真实 migration。
- 数据库 GREEN：
  - `supabase db start`：从空数据库由真实 CLI runner 成功应用全部 migrations。
  - `supabase db reset`：PASS。
  - `supabase test db`：135 项 PASS。
  - `bun run test:db:upgrade`：RED control + 7 项 PASS；连续重复运行和 reset 后运行均通过。
  - cleanup 后数据库实查：CHECK `convalidated = true`、固定测试账号为 0、acknowledged-without-fetch 行为 0。
- 应用全量：`bun run check` PASS；39 个测试文件通过、1 个跳过，380 个测试通过、6 个既有跳过；生产构建通过。
- 完整本地服务栈未能启动：Colima 在创建 vector 容器时无法挂载其 Docker socket（`operation not supported`），因此并发/API/E2E 按“环境允许”规则未执行；未通过排除服务或放宽判据制造通过。
- 最终独立复审：No findings；migration 事务边界和 fixture failure self-heal 的 Important 均已关闭。

## 2026-07-24 — Connector ACK 并发测试去墙钟竞速

- 真实 runner RED：[CI run 30063520488 attempt 1](https://github.com/SuperOPC-AI-Incubator/workbuddy-copilot/actions/runs/30063520488/attempts/1) 的 Quality job 在 `workbuddy-connector.test.ts:728` 将 `blocked` 误判为持锁；同一 SHA 的 Ubuntu/macOS/Windows connector jobs 均通过，独立 Supabase job 的 reset、pgTAP、upgrade、concurrency 和 browser loop 也全部通过。
- 本地复现：connector 单测连续 30 轮和普通全量连续 12 轮均通过；8 份全量并发时 8/8 复现同一 `expected resolved, received blocked`。失败断言前 `.ack.lock` 与 `.ledger.lock` 的 lease 数始终为 `[0, 0]`，证明 ACK 网络期间未持本地锁。
- 根因：测试用 `Promise.race` 要求受控 concurrent fetch 在 100ms 内完成，把 runner 负载和临时文件系统调度时间错误地当成锁状态；同一 SHA 未改代码重跑的 [attempt 2](https://github.com/SuperOPC-AI-Incubator/workbuddy-copilot/actions/runs/30063520488/attempts/2) 全绿，进一步确认时序抖动。
- 最小修复：删除 100ms 墙钟分支；在测试已注入立即返回的 fetch 和零等待锁重试条件下，直接等待 concurrent fetch 在 ACK gate 释放前完成，再验证 ACK 与 fetch 合并后的 ledger。
- 防假绿负控：临时让 ACK 请求持有 ledger lock，新测试稳定 RED，捕获 lease `[0, 1]`；负控代码随后恢复。
- 定向 GREEN：`bun run test:connectors`，2 个文件、32 项通过；修复后的目标用例 8 份并发压力运行 8/8 通过。
- 最终全量：`bun run check` PASS；格式、lint、TypeScript、39 个测试文件（380 项通过、6 项既有跳过）和生产构建全部通过。
- 最终独立复审：No findings；确认 gate 顺序确定性覆盖无跨网络持锁及 latest-ledger merge，真实持锁回归会超时判红。
