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
