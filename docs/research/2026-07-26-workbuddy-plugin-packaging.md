# 将学员端接入封装为 WorkBuddy（CodeBuddy）插件：可行性调研

日期：2026-07-26  
范围：仅核对本机 WorkBuddy 自带官方文档、内置插件、桌面端已打包代码与当前
`connectors/` 实现；未联网、未改代码、未写入任何配置或 Git 状态。

## 结论

**应该改走插件，但不能把 `tencent-pptx` 原样搬过去就宣称 Windows 已解决。**

插件能以包内 `hooks/hooks.json` 声明主会话 `Stop` 与 `UserPromptSubmit`，启用时由
平台加载和合并；因此能消除当前安装器自行合并 `~/.workbuddy/settings.json` 的锁、备份、
并发检查和保留既有 hook 的整套逻辑。插件市场安装也会把随包的 `.mjs` 文件复制到平台
管理的插件目录，故不再需要手工复制到 `~/.local/share/`。

Windows 的关键不是 Electron 的 exe 名称，而是桌面端向 Agent CLI 注入的
`WORKBUDDY_EXTRA_PATHS`：该变量包含 WorkBuddy 受管 Node 的 bin 目录，Windows 用
`;` 分隔。**为插件专门写一个兼容 Git Bash 和 Windows `node.exe` 的 runner 后，未知
Electron 路径这个死结可以消失。**不过官方 `tencent-pptx/bin/run-node` 的 POSIX 实现按
`:` 和无扩展名 `node` 查找，`.cmd` 又只有 `node %*`；它不能作为 Windows hook 已打通
的证据。应先通过一个干净 Windows WorkBuddy 实机验证，再替换现网安装器。

本机证据也显示插件化**不自动替代**当前的周期 `flush/fetch`、首次 7 天历史补传和
下行 Skill 安装；这些必须在迁移设计中保留或另行实现，不能默默降级。

## 证据记号

下列记号均为本机绝对路径，后续每个“已验证事实”均以记号和行号标注。

| 记号          | 绝对路径                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRef`        | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/en/cli/plugins-reference.md`                           |
| `Hooks`       | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/en/cli/hooks.md`                                       |
| `Plugins`     | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/en/cli/plugins.md`                                     |
| `Market`      | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/en/cli/plugin-marketplaces.md`                         |
| `SettingsDoc` | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/en/cli/settings.md`                                    |
| `TP`          | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/resources/builtin-plugins/tencent-pptx`                                     |
| `WP`          | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/resources/builtin-plugins/weixinpay`                                        |
| `Desktop`     | `/Applications/WorkBuddy.app/Contents/Resources/app.asar!/main/initialize.js`（桌面端 app.asar 内源码）                                       |
| `CLI`         | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy.js`（压缩 bundle；行号为 bundle 逻辑行）                 |
| `Conn`        | `/private/tmp/claude-502/-Users-michael-projects------workbuddy-copilot/da0a7aa8-eb5c-46d4-a330-5d3159ce5398/scratchpad/wt-plugin/connectors` |

`app.asar` 源码与 `codebuddy.js` 都是随当前 WorkBuddy 安装包交付的本机文件；后者压缩为
少数超长行，故同时摘录原文关键片段，避免行号误读。

## 已验证事实

### 1. 插件可以声明 `Stop`，也可以声明 `UserPromptSubmit`

- 插件 hook 的位置可以是插件根目录 `hooks/hooks.json`，也可以在 `plugin.json` 内联；
  可用事件表同时列出 `UserPromptSubmit`（用户提交 prompt、AI 处理前）和 `Stop`（AI 完成
  回复时）。【`PRef:29-35,57-88`】
- 这两个事件不使用 matcher；官方结构说明明确说可省略 matcher，并给出了
  `UserPromptSubmit` 的 command hook JSON 示例。【`Hooks:22-77`】
- `Stop` 的触发时机是“primary CodeBuddy agent finishes responding”，用户手动中断则跳过。
  现有上行逻辑正是等回复完成后读取 transcript，因此语义匹配。【`Hooks:393-401`；
  `Conn/workbuddy-hook.mjs:4-12,178-196`】
- WorkBuddy Desktop 会把 `CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS` 设为 `1`；CLI loader
  在此值为真时拒绝插件 hook 的非 `command` 类型（原文：
  `areExtendedPluginHooksDisabled()&&"command"!==el.type)return!1`）。所以本方案必须用
  `type: "command"`；不能在桌面端依赖文档列出的插件 `prompt`、`agent` 或 `http` hook。
  【`Desktop:8766-8768`；`CLI:678`】

### 2. `WORKBUDDY_EXTRA_PATHS`：含义、设置者、hook 可见性与 Node

- 它是**额外可执行文件目录列表**。桌面端构建 Agent CLI 环境时将
  `managedNodeBinDirs`、`managedPythonBinDirs` 和 connector bin 目录加入
  `extraPathParts`，再赋值：
  `env.WORKBUDDY_EXTRA_PATHS = ...join(process.platform === "win32" ? ";" : ":")`。
  因此设置者是 WorkBuddy Desktop 主进程/host 的 CLI 环境构建逻辑，而不是插件。
  【`Desktop:8740-8789,10028-10085`，关键原文如上】
- 桌面端以该 `cliEnv` 启动 Agent CLI `--serve`，所以这是 CLI 进程自己的环境。
  【`Desktop:9775-9800`】
- hook 的执行说明是“with CodeBuddy's environment”；插件 hook 启用后与用户/项目 hooks
  自动合并。因此正常桌面端执行路径下，插件 command hook 会继承该变量。
  【`Hooks:106-115,772-783`】CLI 的 Bash 代码还直接读取该变量并把目录前置到命令 PATH：
  `let ed=process.env.WORKBUDDY_EXTRA_PATHS`、`export PATH=...:"$PATH"`。
  【`CLI:1354`】
- 本机当前受管 Node 的实际路径为
  `/Users/michael/.workbuddy/binaries/node/versions/22.22.2/bin/node`；只读执行其
  `--version` 返回 `v22.22.2`。随附头文件也声明 major/minor/patch 为 `22/22/2`，并标记
  LTS。【`/Users/michael/.workbuddy/binaries/node/versions/22.22.2/include/node/node_version.h:25-32`】
- Desktop 枚举 `~/.workbuddy/binaries/<type>/versions`，跳过安装中目录，按版本倒序选 bin。
  这证明它是 WorkBuddy 管理和选择的本地 Node；本机资料**未**给出该 Node 的下载 URL、
  签名或 checksum，不能把“受管”进一步表述为“已验证的签名来源”。【`Desktop:8844-8866`】

### 3. 官方 `run-node` / `run-node.cmd` 的完整逻辑与 Windows 结论

#### `tencent-pptx` 已验证实现

- manifest 将 hooks 指向 `./hooks/hooks.json`；其唯一示例 hook 是 `PreToolUse` + `Skill`，
  command 为 `"${CODEBUDDY_PLUGIN_ROOT}/bin/run-node"
"${CODEBUDDY_PLUGIN_ROOT}/scripts/ensure-runtime.mjs"`，timeout 120 秒。
  【`TP/.codebuddy-plugin/plugin.json:13-14`；`TP/hooks/hooks.json:1-15`】
- POSIX `bin/run-node` 的解析顺序是：
  1. 遍历**冒号**分隔的 `WORKBUDDY_EXTRA_PATHS`，取第一个可执行的 `<dir>/node`；
  2. 取 `WORKBUDDY_CONFIG_DIR`，否则 `CODEBUDDY_CONFIG_DIR`，否则 `$HOME/.workbuddy`；
     在 `binaries/node/versions` 中排除 `*.installing.*` / `*.__extract_temp__*`，按
     `sort -Vr` 取最高版本的 `bin/node`；
  3. `command -v node`；
  4. 仍没有就报错并 exit 127。

  命中后会将 Node 所在目录前置至 `PATH`，再 `exec "$NODE_BIN" "$@"`，以使 npm 的
  `#!/usr/bin/env node` shebang 可继续找到 Node。【`TP/bin/run-node:6-71`】

- `scripts/ensure-runtime.mjs` 只对 `Skill`/`UseSkill` 且 skill 名为 `tencent-pptx` 工作；
  它第二次解析 Node 的优先级是 `NODE_BIN_DIR`（注释标为 WorkBuddy 注入）→
  `~/.workbuddy/binaries/node/versions/<最高版本>/bin` → PATH。它把插件携带的
  `vendor/tencent-slidep-5.4.1.tar.gz` 用该受管 npm 的 `--prefix=<nodeRoot>` 安装；失败
  fail-open，只输出 `systemMessage`。【`TP/scripts/ensure-runtime.mjs:3-16,61-115,119-195,234-265`】
- `bin/run-node.cmd` 的全部内容仅为 `@echo off` 与 `node %*`；它不读取
  `WORKBUDDY_EXTRA_PATHS`、不探测受管 Node 目录，也没有报错或 fallback。
  【`TP/bin/run-node.cmd:1-2`】

#### Windows 判断（事实与推论分开）

**事实：** Windows hook 仍强制 Git Bash，`cmd.exe` 和 PowerShell 不被该 hook executor
支持。【`Hooks:54-58,772-781`】而 `tencent-pptx` 的 hook command 无后缀地指向 POSIX
`bin/run-node`，并未指向 `.cmd`。【`TP/hooks/hooks.json:8-10`】官方 `weixinpay` 的
Windows runner 则明确将 `WORKBUDDY_EXTRA_PATHS` 作为 `;` 分隔、每项直接含
`node.exe` 的目录依次解析，再 fallback 到 PATH；其 POSIX runner 注释还说明
WorkBuddy 不把受管 Node 直接放进 PATH，而是通过该变量导出目录。
【`WP/bin/run-node:4-39`；`WP/bin/run-node.cmd:2-31`】

**推论：** 在 Windows 的 Git Bash hook 路径里，`tencent-pptx/bin/run-node` 的 `IFS=:`
及 `<dir>/node` 与 Windows 的 `;` / `node.exe` 语义不匹配；`.cmd` 裸 `node %*` 又依赖
PATH 已可解析。因此**原样复用 tencent-pptx 不能证明 Windows 已解决**。

**可行方案（推论）：** 为本插件实现一个 Windows-aware POSIX runner：读取 Windows 的
`;` 分隔 `WORKBUDDY_EXTRA_PATHS`，在 Git Bash 中将每项规范化并查找 `node.exe`，最后
`exec`；同时提供 `.cmd` 给 MCP/stdio 等经 `PATHEXT` 启动的路径。这样无需知道 Electron
的安装目录或 exe 名，利用的是 Desktop 已管理的 Node 注入。前提仍是下一节所列实机验证。

### 4. hook 是否还写进 `~/.workbuddy/settings.json`

- 插件 hook 定义留在包内 `hooks/hooks.json`（或 manifest `hooks` 字段）；“When you
  enable a plugin, its hooks are merged automatically”。【`Hooks:106-115`；`PRef:29-35`】
- `enabledPlugins` 只是启用状态，格式为 `plugin-name@marketplace-name: true/false`。当前
  本机 `~/.workbuddy/settings.json` 第 2–11 行含 9 项启用插件，其中包括
  `tencent-pptx@workbuddy-builtin`，但没有把其 hook 命令复制进去。
  【`SettingsDoc:456-490`；`/Users/michael/.workbuddy/settings.json:2-11`】
- 插件安装目录的 hook 会与用户/项目 hook 合并，多个来源同一事件并行执行。
  【`Hooks:108-115,774-776`】

**结论：** 可以删除当前“把 Stop command 合并/摘除到 `settings.json`”的自维护逻辑，包括
锁、备份、冲突检测和 marker 替换；平台仍会维护一条 `enabledPlugins` 状态，这不是 hook
配置内容。注意 settings 外部改动不会当前会话热加载，仍需重新加载/重启并经过 hooks
面板确认。【`Hooks:763-770`】

### 5. 面向 45 位学员的分发与 `cb_teams_marketplace`

- marketplace 支持 GitHub、任意 Git URL、本地目录和 HTTP(S) `marketplace.json`；自建
  marketplace 的前提仅为 Git 仓库（或本地开发环境）和一个以上插件，根目录放
  `.codebuddy-plugin/marketplace.json`。【`Market:21-59,116-207,305-343,394-401`】
- 团队项目可在 `.codebuddy/settings.json` 写 `extraKnownMarketplaces` 与
  `enabledPlugins`。`Market` 称启动会自动安装；但 `SettingsDoc` 说信任目录后会提示且
  用户可跳过。两份同机文档对此存在冲突，不能承诺 45 人“静默强制安装”。
  【`Market:77-114`；`SettingsDoc:504-513`】
- `--plugin-dir` 仅当前 session 的开发/测试路径，不能当持续分发方案；marketplace 安装
  才在后续 sessions 有效。【`PRef:453-460`】
- 本机 `cb_teams_marketplace` 是产品标记 `isBuiltIn: true` 的 ZIP marketplace，来源为
  `download.codebuddy.cn`；其描述为 “CodeBuddy Teams Marketplace - 团队协作与文档处理
  插件集合”，manifest owner 是腾讯邮箱，内部以相对路径列插件。它是内置团队市场实例，
  **不是**本机文档定义的“用户自建私有市场”的别名。
  【`/Users/michael/.workbuddy/plugins/known_marketplaces.json:2-16`；
  `/Users/michael/.workbuddy/plugins/marketplaces/cb_teams_marketplace/.codebuddy-plugin/marketplace.json:1-25`】

**无法确认：** 本机资料没有腾讯官方 marketplace 的提交入口、资质、审核、SLA 或上架
标准；“approval/security review”只被写成组织自行建立的治理建议。因此不应把“提交官方
marketplace”纳入当前可交付计划。优先用私有 Git/HTTP marketplace；本地目录仅开发测试。
【`Market:522-526`】

### 6. 每学员 token / 用户配置

- manifest `userConfig` 会在启用插件时提示用户输入，官方明确建议它替代人工编辑
  settings；`sensitive: true` 用于 token。【`PRef:296-331`】
- 配置键必须是标识符；值可在 hook command、MCP/LSP 配置写为 `${user_config.KEY}`，并会
  向插件子进程导出 `CODEBUDDY_PLUGIN_OPTION_<KEY>`。敏感值不能插入 skill/agent 内容。
  【`PRef:329`】
- 非敏感值存入 `pluginConfigs[<plugin-id>].options`；敏感值存系统 Keychain，Keychain
  不可用时才落 `~/.codebuddy/.credentials.json`，并且这块共享凭证总上限约 2 KB。
  【`PRef:331`】

**结论：** 每位学员的一枚短 token 可声明为 `userConfig.api_token` +
`"sensitive": true`；runner/Node 代码从 `CODEBUDDY_PLUGIN_OPTION_API_TOKEN` 读取，避免把
token 置入插件包、hook command 字符串或 event 文件。

**无法确认：** 当前 WorkBuddy settings 没有已启用 `userConfig` 插件的样本；文档路径写
`~/.codebuddy` 而产品现用 `~/.workbuddy`。必须在 WorkBuddy GUI 实机确认提示是否出现、
敏感值的实际存储位置及卸载/重新启用时的行为。

### 7. 已文档化的能力边界

下表是**文档明确的限制**；“没有 UI”是从完整 schema/component 清单的缺口得出的有限
结论，并不声称不存在未公开 API。

| 限制                             | 已验证事实与证据                                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无自定义 UI/面板组件类型         | 组件清单只有 Skills、Agents、Hooks、MCP、LSP；manifest 的组件字段为 commands/agents/skills/hooks/mcpServers/outputStyles/lspServers/userConfig/channels。`channels` 只能绑定插件 MCP server 向会话注入内容，并非 UI 扩展点。【`PRef:5,296-351,479-535`】 |
| 包内 settings 不能通用改平台设置 | 插件根 `settings.json` “Currently only agent settings are supported”；未知键静默忽略。【`PRef:534-535`；`Plugins:330-342`】                                                                                                                              |
| Agent 元数据受限                 | `isolation` 只有 `worktree`；plugin agent 不支持 hooks、mcpServers、permissionMode frontmatter。【`PRef:18`】                                                                                                                                            |
| hook 类型受 Desktop 限制         | 当前 Desktop 禁掉 extended plugin hooks，故本方案只可用 `command`。【`Desktop:8766-8768`；`CLI:678`】                                                                                                                                                    |
| 无法依赖插件根以外文件           | marketplace 安装会复制至 plugin cache；`../` 根外引用失效，路径必须是以 `./` 开头的相对路径。【`PRef:453-475,353-360`】                                                                                                                                  |
| 目录扫描不是追加语义             | custom commands/agents/skills/outputStyles 替换默认目录；组件须在 plugin root，不能放入 `.codebuddy-plugin/`。【`PRef:353-360,520-535`】                                                                                                                 |
| 卸载可能删持久状态               | 从最后 scope 卸载时 `${CODEBUDDY_PLUGIN_DATA}` 默认被删；需 `--keep-data` 才保留。【`PRef:406-449,577-599`】                                                                                                                                             |
| Windows hook 仍依赖 Git Bash     | 插件化不会改变 Windows hook 的 shell 强制约束。【`Hooks:54-58,772-781`】                                                                                                                                                                                 |

## 对当前 `connectors/` 的迁移影响（推论）

### 必须保留并打包的运行时代码

| 现有文件                                             | 处置                                         | 理由                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workbuddy-sync.mjs`                                 | 保留                                         | durable outbox、发送、重试、flush/fetch、凭证配置与数据契约仍是业务能力。                                               |
| `workbuddy-hook.mjs`                                 | 保留                                         | `Stop` stdin → transcript → event → 本地入队的关键路径；当前明确只处理 Stop。【`Conn/workbuddy-hook.mjs:4-12,178-241`】 |
| `workbuddy-transcript.mjs`、`workbuddy-event-id.mjs` | 保留                                         | 上述 hook 和历史导入的直接依赖，保证 event id/内容一致。                                                                |
| `*.d.mts`                                            | 保留在源码与测试中；无需作为 Node 运行时入口 | 它们是类型声明，不是当前 `.mjs` 的执行依赖。                                                                            |
| `SKILL.md`                                           | 视下行功能而定                               | 若仍需导师回信，下沉为插件 `skills/superbrain-sync/SKILL.md`；若该功能继续不默认启用，可不随首个上行插件安装。          |

### 可淘汰的当前安装机制，但不能现在删除文件

| 现有文件/机制                                                | 插件化后                                | 删除前提                                                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect-runtime.sh`                                          | 用新的插件 runner 取代                  | Windows 实机已证实 `WORKBUDDY_EXTRA_PATHS` 在 Stop hook 内可见且能定位 `node.exe`。                                                                                                       |
| `install-macos.sh` 中的 settings helper、hook 注册、模块复制 | 平台 hook 加载与 marketplace cache 取代 | 已另行保住其 scheduler、首次历史导入、token 初始化、下行 Skill 的行为。当前脚本确实复制模块、写 wrapper、注册 Stop hook、建立 scheduler/导入。【`Conn/install-macos.sh:440-498,557-633`】 |
| `install-windows.ps1` 中同类逻辑                             | 同上                                    | 同时完成 Windows 兼容 runner 与 Windows scheduler/补传替代；现脚本自己也承认 Windows Electron 路径未经真机核对。【`Conn/install-windows.ps1:55-67,611-620,739-806`】                      |

换言之，**现在不应删除仓库中的任何 connector 文件**。第一版插件只应淘汰学员机上由
安装器生成的文件；仓库安装器应保留到新插件完成等价验证、且旧学员迁移完毕后才考虑删。

### 需要新写的最小集合（推论）

1. `superbrain-workbuddy/.codebuddy-plugin/plugin.json`：name/version、`userConfig`（API URL
   非敏感、token 敏感）、hooks 路径。
2. `hooks/hooks.json`：`Stop` 的 `type: command`，调用包内 runner 与
   `workbuddy-hook.mjs`；可选 `UserPromptSubmit` 仅在确有下行语义时加入。
3. `bin/run-node` + `bin/run-node.cmd`：基于 `WORKBUDDY_EXTRA_PATHS` 的跨平台解析；不能
   复制 `tencent-pptx` 的 `.cmd` 两行实现。
4. 包内 `scripts/`：从 `CODEBUDDY_PLUGIN_OPTION_*` 初始化/更新 connector 私有配置，且不将
   token 写到命令行、日志或 event。
5. marketplace 仓库的 `.codebuddy-plugin/marketplace.json`、版本策略和给 45 人的安装入口。
6. 一个对等方案保存目前 scheduler + 7 天 `import` + `flush/fetch` 行为；官方插件 schema
   没有声明式 cron/scheduler 组件，不能假定它会由平台代劳。

**迁移代价估计（推论）：中等，约 4–6 个工程日 + 两台实机验收。**其中并非把四个 `.mjs`
塞进目录即可；最大不确定性是 Windows hook/Node 路径和如何无损保留后台同步。

## 必须实机验证的清单

1. Windows 干净 WorkBuddy：`Stop` 插件 command hook 是否继承
   `WORKBUDDY_EXTRA_PATHS`，其值是否含可执行 `node.exe`，并确认实际 Git Bash 路径。
2. Windows Git Bash 中，无后缀 `bin/run-node` 的解析是否执行 POSIX 文件还是经 `PATHEXT`
   命中 `.cmd`；新的 runner 应分别验证两条路径。
3. Windows 受管 Node 的真实目录布局、升级后的目录变化及 runner 的重新选择行为。
4. `userConfig` 的启用弹窗、敏感 token 实际落点、更新/禁用/卸载（含 `--keep-data`）语义。
5. 45 人私有 marketplace 的首次信任流程：究竟自动装、提示可跳过，还是受组织策略强制；
   文档对此互相矛盾。
6. 插件启用后 Stop hook 的触发次数、stdin `transcript_path` 形状、4 秒本地入队预算，以及
   与既有用户 Stop hooks 的并行运行是否保持当前“失败不阻塞”的性质。
7. 新插件如何等价执行当前每 5 分钟 `flush/fetch` 与首次 `import --since 7d`；这不是
   marketplace 复制文件或 hook 注册自动提供的能力。
8. 若计划上腾讯官方 marketplace，必须向腾讯确认上架渠道、资质、审核与发布权限；本机
   文档不足以确认。

## 最终决策建议（推论）

采用两阶段迁移：先制作**仅内部/私有 marketplace**的插件 PoC，保留现有安装器为回退；
在 macOS 与 Windows 各一台干净机器通过上列 1–7 后，再把 45 名学员迁到 marketplace。
PoC 的验收门槛应是“Stop 后成功入队、token 不落日志/命令行、升级后仍可找到受管 Node、
旧用户 hook 不丢、后台同步不降级”。满足后，插件化能真正消除 settings 合并与 Electron
路径探测两类维护负担；不满足 Windows runner 条件前，不应停用现有 Windows 安装器。
