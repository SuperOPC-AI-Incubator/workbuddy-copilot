# WorkBuddy Copilot 仓库血缘分析

> 分析日期：2026-07-23
>
> 比较快照：原项目 `feat/target-arch-rebuild@b4f6917`；同事仓库 `main@f86c689`
>
> 结论口径：Git 血缘、源码同一性与产品语义来源是三个不同问题，不能相互替代。

## 结论

在上述比较快照及分析时可见的全部 refs 范围内，两个仓库**不是同一分支，也没有共同 Git 祖先**。同事仓库从 Lovable 的 TanStack 模板独立起根，和原项目历史之间没有相同的 commit、tree 或 blob；因此不能把它当作原项目的分支直接 merge、rebase 或按共同祖先比较。

但同事仓库的导师观察台与原项目存在**高置信度的语义复刻关系**：提交信息直接写明“复刻了导师观察台前端 UI”，源码又明确说明 mock 数据用于复现 `workbuddy-copilot` 导师 API 的数据形状，并保留了一组高度独特的功能和文案组合。更准确的描述是：

> 同事仓库很可能基于原项目某个产品、UI 或 API 契约快照，在另一套技术栈中重新实现；现有证据不支持“原样复制 Git 历史或文件”，也不足以判断输入介质究竟是源码、文档、截图还是提示词。

## Git 血缘事实

| 检查项 | 已验证结果 | 含义 |
|---|---|---|
| 共同祖先 | 同事 `f86c689` 与原项目 `b4f6917`、原项目 `main` 均无 merge-base | 不是原项目分支，也不是可按共同祖先合并的 fork |
| 根提交 | 同事仓库唯一根提交是 [b54a9d2](https://github.com/Jonas1mposter/superbrain-copilot/commit/b54a9d2b21df269aa84c49da7925cb3ecf72f4cc)，内容为 Lovable TanStack 模板；[模板元数据](https://github.com/Jonas1mposter/superbrain-copilot/blob/b54a9d2b21df269aa84c49da7925cb3ecf72f4cc/.lovable/project.json)也明确记录该模板 | 同事仓库不是从 WorkBuddy commit 起根 |
| Git 对象交集 | 同事 HEAD 可达 667 个对象与原项目全部 refs 可达 1463 个对象的 SHA 交集为 0 | 没有完全相同的 commit、目录树或未改写文件内容 |
| 文件树 | 两个 HEAD 分别有 117、148 个文件，仅 `.gitignore`、`AGENTS.md` 路径同名；导师台源码路径和技术栈完全不同 | 源码结构相似度低，不是目录级搬运 |
| 同事历史 | `f86c689` 可达 129 个提交：1 个 Lovable 根提交、128 个 `gpt-engineer-app[bot]` 提交，其中 32 个 merge | 历史形态符合 Lovable 生成、分支合并后同步到 GitHub |

GitHub API 显示该仓库 [`fork=false`](https://api.github.com/repos/Jonas1mposter/superbrain-copilot)。这只表示 GitHub 没有登记 fork-network 关系；GitHub 的 [`fork` 字段](https://docs.github.com/en/rest/repos/repos#get-a-repository)不能证明代码或产品设计没有从外部仓库、文件或提示中导入。

## 语义复刻证据

以下证据共同支持“产品/UI/API 契约来自原项目”的判断：

1. 同事仓库首个导师台功能合并提交直接命名为[“复刻了导师观察台前端 UI”](https://github.com/Jonas1mposter/superbrain-copilot/commit/343f93d97b64845edb96a4fcc185524b41c0eb62)。
2. 同一版本的 [`src/lib/mock-data.ts`](https://github.com/Jonas1mposter/superbrain-copilot/blob/343f93d97b64845edb96a4fcc185524b41c0eb62/src/lib/mock-data.ts#L1-L2) 写明：数据用于复现 `workbuddy-copilot mentor APIs` 的数据形状，并作为前端 replica 的临时真相源。
3. 两边同时出现一组非通用、组合后辨识度很高的交互契约：
   - 三栏“学员—对话—时间线”；
   - “⟳ 同步该学员全部对话”；
   - 会话级“查看完整对话原文”入口；
   - 学员提问、AI 回复、学习诊断、导师提示四类时间线；
   - 导师提示“**不改 AI，仅提示学员**”；
   - `student_id`、`session_title`、`analysis_count`、`alert_count`、`last_severity` 及空间/任务分组等相同领域字段。
4. 同事 UI 中的[全量同步与空间/任务分组](https://github.com/Jonas1mposter/superbrain-copilot/blob/343f93d97b64845edb96a4fcc185524b41c0eb62/src/routes/index.tsx#L243-L275)、[完整原文入口](https://github.com/Jonas1mposter/superbrain-copilot/blob/343f93d97b64845edb96a4fcc185524b41c0eb62/src/routes/index.tsx#L378-L385)和[导师提示输入框](https://github.com/Jonas1mposter/superbrain-copilot/blob/343f93d97b64845edb96a4fcc185524b41c0eb62/src/routes/index.tsx#L402-L427)，能与原项目候选快照中的[导师台结构和文案](https://github.com/wangjialiang678/workbuddy-copilot/blob/adf05fed163d69e3304ef7d1de8df46f305f8dc8/copilot/static/mentor/index.html#L15-L55)逐项对应。原项目链接需要该仓库权限；本地可用 `git show adf05fe:copilot/static/mentor/index.html` 复核。

这组证据**高置信度支持语义复刻或来源关系**，但不能排除中间材料或未发现的共同上游；它也不等于逐行源码复制。两边分别采用 TanStack/React/TypeScript/Supabase 与 Python/FastAPI/SQLite/原生 HTML/JS，且没有相同 blob。

## 最可能的语义基线

无法锁定唯一基线。当前证据最集中于原项目的以下候选窗口：

`adf05fe`（2026-07-03）至 `220db52`（2026-07-10）

这不是排他性的法证上界：`adf05fe` 是已识别到的最早完整特征组合，`220db52` 是同事复刻前包含同一契约的后续检查点。此后的多个后代提交继续保留这些特征，也可能成为输入，但仅凭现有语义签名无法进一步区分。

| 本地提交 | 作用 | 判断 |
|---|---|---|
| [`e8e3861`](https://github.com/wangjialiang678/workbuddy-copilot/commit/e8e3861067ca5e0cfbd0abad9e1f9df57690dc64)¹ | 已具备三栏、四类时间线、导师出站消息和“不改 AI，仅提示学员” | 奠定导师台核心语义，但尚未覆盖全部独特签名 |
| [`adf05fe`](https://github.com/wangjialiang678/workbuddy-copilot/commit/adf05fed163d69e3304ef7d1de8df46f305f8dc8)¹ | 增加“同步该学员全部对话”，并保留会话级完整原文入口 | **目前最佳单点候选**：最早覆盖同事 UI 的完整特征组合 |
| [`220db52`](https://github.com/wangjialiang678/workbuddy-copilot/commit/220db5226f37d221d823598287e0d61cb49fd4e8)¹ | 包含上述完整契约的后续客户端检查点 | 同事复刻前的较晚候选快照，但不是排他性上界 |

¹ 原项目 GitHub 链接需要仓库权限；本地分别运行 `git show e8e3861`、`git show adf05fe`、`git show 220db52` 可复核。

原分析时本地 HEAD `b4f6917` 包含这些历史，但其作者时间晚于同事“复刻 UI”提交，因此不是首选基线；同时，Lovable/GitHub 同步可能回填提交时间，时间顺序只能作为辅助证据。

## 不确定性

- 没有 Lovable 编辑提示、上传记录、私聊或账号审计日志，无法区分输入是源码、设计文档、截图、录屏、口述需求，还是它们的组合。
- Git 对象交集为 0 能排除未改写文件和直接接续历史，不能排除经过改写、翻译或重新生成后的复制。
- 同一功能契约在多个后续提交和分支中持续存在，因此只能给出基线范围，不能把 `adf05fe` 认定为唯一来源。
- 同事仓库的提交作者时间早于 GitHub 仓库创建时间，这与后续同步或导入相容，但不能单独证明 Lovable 项目的真实创建时间。

## 对整合策略的影响

1. **不要做历史级合并。** 两仓无共同祖先，强行 merge 会把两个完整项目历史拼成一个仓库，制造大量无意义冲突，也不能回答功能优劣。
2. **按能力和契约整合。** 以用户路径、API 输入输出、数据模型和失败语义建立功能矩阵；选中能力后，在主仓目标架构内手工移植或重写，并为每项保留来源提交链接。
3. **原项目继续作为架构基线。** 这是基于项目已批准的目标架构和红线作出的策略选择，而不是由 Git 血缘本身推出。服务器不读学员本地文件、单 worker、权威数据入 `copilot.db`、hook stdlib-only/fire-and-forget 等红线不能因为同事实现采用 Supabase 或另一套运行模型而放宽。
4. **同事仓库作为独立实现参考。** 可重点评估其 React UI、Supabase 实时能力、MCP 工具和部署体验；复用的是产品设计或经过验证的实现思路，不是整树覆盖。
5. **采用小步 cross-port。** 每次只迁移一个功能切片，先锁契约和负控测试，再实现、验证、记录差异；不要按目录同步，也不要用文件相似度代替行为验证。
6. **保留溯源记录。** 若采用同事仓库中的界面、文案或实现，应在设计/提交中链接对应 GitHub commit，避免日后再次把语义复刻误判为独立起源或同一 Git 分支。
