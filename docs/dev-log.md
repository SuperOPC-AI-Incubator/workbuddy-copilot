# 开发验证日志 — 目标架构重建

<!-- 执行阶段每次验证运行后追加 Round 记录。判定标准见 docs/test-plan-v2.md（已锁定）。 -->

---
## Round 0 — 2026-07-02 · 闭环准备与部署

阶段：准备（closed-loop-test skill）
触发原因：计划 STATUS: APPROVED，进入编码闭环

### 环境预检
| 项 | 结果 |
|----|------|
| Python 3.13.12 + pytest/fastapi/uvicorn/httpx/websockets | PASS |
| 现有测试基线（改造前）`venv/bin/python -m pytest tests/ -q` | PASS（112 passed）|
| LLM Key TENCENT_TOKENHUB_API_KEY | PASS（已配置，config 引用一致）|
| 前端验证 Playwright / DevTools MCP | PASS（可用）|
| codex CLI + tcd（worktree 并行）| PASS（可用）|
| 端口 8765 | 被旧服务占用；P0/P1 走 TestClient 不受影响，真机 E2E 前需停旧服务 |

### 前置阻塞项裁决
- session_id 全局唯一性：只读 workbuddy.db → 205/205 去重、随机 UUID（混合格式）→ **用 session_id 单主键，无需复合键**。阻塞解除。

### 部署产物
- 项目 CLAUDE.md 闭环规则段 ✓
- docs/test-plan-v2.md（判定标准已锁定）✓
- docs/dev-log.md（本文件）✓
- 未部署 Hooks（默认关闭）

### 下一步
交接 codex 按 Phase 0→4 执行；主 Agent 负责 P0/P1 验证与集成。

---
<!-- 后续 Round 从此处向下追加 -->

---
## Round 1 — 2026-07-02 · Phase 0 真 bug 修复

阶段：Phase 0（B1/B2/B5/B6/B7）
触发原因：修复与规模无关的确定性 bug，不改 schema、不做架构改动

### 见红记录
| 用例 | 失败原因 |
|------|----------|
| `venv/bin/python -m pytest tests/test_store.py -k "severity or foreign_keys" -q` | 旧 `MAX(severity)` 返回 `info`；FK 未拦孤儿 analysis |
| `venv/bin/python -m pytest tests/test_store_mentor.py -k timeline -q` | timeline analysis 条目缺 `severity` 列 |
| `venv/bin/python -m pytest tests/test_notifier_macos.py -q` | AppleScript 仍含 title/body 字符串拼接 |

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_store.py -k "severity or foreign_keys" -q` | PASS（3 passed, 10 deselected） |
| `venv/bin/python -m pytest tests/test_store_mentor.py -k timeline -q` | PASS（4 passed, 8 deselected） |
| `venv/bin/python -m pytest tests/test_notifier_macos.py -q` | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_mentor_api.py -q` | PASS（6 passed, 1 warning） |
| `venv/bin/python -m pytest tests/ -q` | PASS（117 passed, 1 warning） |
| `grep -rn "_IncludedRouter" copilot/` | PASS（无输出，退出码 1） |

### 备注
- TestClient 仍有既有 StarletteDeprecationWarning，本轮未改依赖。
- 进入任务前已有未跟踪文件 `docs/mentor-ui-fixed.png`，本轮未触碰。

---
## Round 2 — 2026-07-02 · Phase 1 数据模型与 Store 持久层

阶段：Phase 1（copilot.db schema/迁移/Store 方法）
触发原因：新增 sessions/students/mentor_messages/raw_transcripts，reports.analysis_pending，停止 reports.prompt 双存

### 见红记录
| 用例 | 失败原因 |
|------|----------|
| `venv/bin/python -m pytest tests/test_store_phase1.py -q` | 新表/新方法缺失；`reports.prompt` 仍写入截断 prompt；sessions 回填缺失 |
| `venv/bin/python -m pytest tests/test_store_phase1.py::test_upsert_session_existing_row_only_updates_title_and_activity -q` | `upsert_session` 冲突更新会改写 student_id/work_dir，不符合“仅更新 title/last_activity_at” |
| `venv/bin/python -m pytest tests/test_store_phase1.py::test_delete_student_removes_fk_children_even_if_child_student_id_drifted tests/test_store_phase1.py::test_mentor_message_cursor_is_scoped_to_student tests/test_store_phase1.py::test_mark_message_status_can_be_scoped_to_student -q` | reviewer 发现 `delete_student` 只按 child.student_id 删除会被 FK 漂移数据卡住；消息 cursor/status 缺少 student 作用域 |

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_store_phase1.py::test_delete_student_removes_fk_children_even_if_child_student_id_drifted tests/test_store_phase1.py::test_mentor_message_cursor_is_scoped_to_student tests/test_store_phase1.py::test_mark_message_status_can_be_scoped_to_student -q` | PASS（3 passed） |
| `venv/bin/python -m pytest tests/test_store_phase1.py -q` | PASS（13 passed） |
| `venv/bin/python -m pytest tests/test_store_phase1.py tests/test_store.py tests/test_store_mentor.py -q` | PASS（38 passed） |
| `venv/bin/python -m pytest tests/ -q` | PASS（130 passed, 1 warning） |
| `git diff --check` | PASS（无输出） |
| `grep -rn "workbuddy.db\|db_path.parent.parent" copilot/store.py` | 仅旧 `get_sessions_by_student` 路径/注释命中；Phase 1 新方法未引入 workbuddy.db 读取 |

### 备注
- TestClient 仍有既有 StarletteDeprecationWarning，本轮未改依赖。
- 隐私/合规 MVP 延后：未新增 consent 表，未做留存/脱敏。
- 进入任务前已有未跟踪文件 `docs/mentor-ui-fixed.png`，本轮未触碰。

---
## Round 3 — 2026-07-02 · Phase 2 切单机假设 + 服务化

阶段：Phase 2（app_context / 内容上行 / ports 删除 / hook token / `/report` 202）
触发原因：服务器切成纯摄取 + 存储 + 按 student_id 扇出，停止读取学员机本地 FS/DB

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_transcript.py tests/test_app_context.py tests/test_hook.py tests/test_service_routing.py tests/test_mentor_api.py tests/test_store.py tests/test_store_phase1.py tests/test_analysis_service.py -q` | PASS（70 passed, 1 warning） |
| `venv/bin/python -m pytest tests/ -q` | PASS（126 passed, 1 warning） |
| `grep -rn "workbuddy.db\|db_path.parent.parent\|iter_recent_transcripts" copilot/` | PASS（清理 pycache 后无输出，退出码 1） |
| `grep -rn "import.*wb_db\|import.*wb_sessions\|from .ports\|import ports" copilot/` | PASS（无输出，退出码 1） |
| `test -f copilot/ports.py && echo BAD || echo OK` | PASS（OK） |
| `grep -n "import copilot\|from copilot\|from \." copilot/hook.py` | PASS（无输出，退出码 1） |
| `venv/bin/python -c "from copilot.app_context import build_context; print(bool(build_context()))"` | PASS（True） |
| `COPILOT_WORKERS=2 venv/bin/python -c "from copilot.app_context import assert_single_worker; assert_single_worker()"` | PASS（RuntimeError，拒绝多 worker） |

### 备注
- 交付前只读 review 后补修：Stop raw transcript 改为 202 前持久化；hook payload 拆 `transcript_tail`（解析/LLM）与 `transcript_full`（raw 落库）；`upsert_session` 不再用空 title 覆盖已有标题；`current_session` 增加 student 作用域；`install.sh` hook 注入 token/config。
- TestClient 仍有既有 StarletteDeprecationWarning，本轮未改依赖。
- 跑测试会生成 `copilot/__pycache__` 并让原始 grep 命中字节码；验证红线前已清理 pycache。
- 进入任务前已有未跟踪文件 `docs/mentor-ui-fixed.png`，本轮未触碰。

---
## Round 4 — 2026-07-02 · Phase 3 后端反向通道

阶段：Phase 3（WSRegistry / MessageService / 反向消息 API / 原生浮标接收分支）
触发原因：D2 核心功能，导师异步发文字提示到目标学员浮标

### 见红记录
| 用例 | 失败原因 |
|------|----------|
| `venv/bin/python -m pytest tests/test_connections.py tests/test_message_service.py tests/test_mentor_api.py -q` | `copilot.connections`、`MessageService`、`get_message_service` 尚不存在，收集阶段失败 |

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_connections.py tests/test_message_service.py tests/test_mentor_api.py -q` | PASS（17 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py tests/test_connections.py tests/test_message_service.py -q` | PASS（10 passed） |
| `venv/bin/python -m pytest tests/ -q` | PASS（142 passed, 1 warning） |
| `git diff --check -- copilot/connections.py copilot/app_context.py copilot/services.py copilot/service.py copilot/floating_native.py tests/test_connections.py tests/test_message_service.py tests/test_mentor_api.py tests/test_floating_native_phase3.py` | PASS（无输出） |
| `grep -rn "workbuddy.db\|from \.ports\|import ports" copilot/` | PASS（无输出） |
| `COPILOT_WORKERS=2 venv/bin/python -c "from copilot.app_context import assert_single_worker; assert_single_worker()"` | PASS（RuntimeError，拒绝多 worker） |

### 备注
- 新增 `copilot/connections.py`：`floats: dict[student_id,set]` + `mentors:set`，正向事件只投本人浮标并广播导师，反向 `mentor_message` 只投目标浮标，成功后回显 `message_delivered`。
- 新增 `MessageService` 与 `/api/mentor/message`、`/api/student/messages`、`/api/student/messages/ack`、`DELETE /api/admin/students/{student_id}`。
- 原生浮标 WS URL 带 `student_id/token/last_seen_message_id`，导师消息按 `message_id` 去重，渲染面板卡片后 ack，并持久化 last_seen/seen ids；日志中 token 已脱敏。
- 独立 review 发现并修复：WS URL 日志泄露 token、隐藏面板时 ack 早于渲染、浮标进程重启可能重放旧消息；复审结果：No blockers。
- 本轮未修改 `copilot/static/mentor/*`；这些文件已有并行前端改动，提交时需排除。

---
## Round 5 — 2026-07-02 · Phase 3 前端契约字段补齐

阶段：Phase 3（mentor API 契约补齐）
触发原因：前端导师台已接线，需要后端补齐 REST 字段和 transcript 按需读取端点

### 见红记录
| 用例 | 失败原因 |
|------|----------|
| `venv/bin/python -m pytest tests/test_store_mentor.py::TestTimelineAggregation::test_timeline_analysis_items_include_analysis_fields tests/test_mentor_api.py::TestMentorStudentSessions::test_returns_sessions_for_student tests/test_mentor_api.py::TestMentorTimeline::test_returns_timeline tests/test_mentor_api.py::TestMentorTranscript::test_returns_raw_transcript_content -q` | timeline analysis 行缺 `understanding`；mentor sessions 返回 `title` 而非 `session_title`；`/api/mentor/sessions/{session_id}/transcript` 端点不存在 |

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_store_mentor.py::TestTimelineAggregation::test_timeline_analysis_items_include_analysis_fields tests/test_mentor_api.py::TestMentorStudentSessions::test_returns_sessions_for_student tests/test_mentor_api.py::TestMentorTimeline::test_returns_timeline tests/test_mentor_api.py::TestMentorTranscript::test_returns_raw_transcript_content -q` | PASS（4 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_store_mentor.py tests/test_mentor_api.py -q` | PASS（26 passed, 1 warning） |
| `venv/bin/python -m pytest tests/ -q` | PASS（143 passed, 1 warning） |
| `git diff --check -- copilot/mentor/routes.py copilot/models.py copilot/services.py copilot/store.py tests/test_mentor_api.py tests/test_store_mentor.py` | PASS（无输出） |
| `grep -rn "workbuddy.db\|from .ports\|import ports" copilot/` | PASS（无输出） |

### 备注
- `get_timeline_by_session` 的三段 UNION 对齐新增 `understanding` 列，analysis 行透出真实 `a.understanding`。
- mentor sessions API 将 `Conversation.title` 序列化为 `session_title`，不再返回 `title`。
- 新增 `GET /api/mentor/sessions/{session_id}/transcript`，返回 `{content, created_at}`；缺失 transcript 返回 404。
- 本轮未修改 `copilot/static/mentor/*`。

---
## Round 6 — 2026-07-02 · Code-review 缺陷修复

阶段：Phase 0-4 后对抗式 code-review 缺陷修复
触发原因：修复送达回执、启动重扫、主线程 UI、单 worker 锁、config fallback、timeline topic、无分析学员、token 比较、EventBus wiring 测试等 9 条缺陷

### 见红记录
| 用例 | 失败原因 |
|------|----------|
| `venv/bin/python -m pytest tests/test_message_service.py tests/test_service_routing.py tests/test_store.py tests/test_config.py tests/test_app_context.py tests/test_floating_native_phase3.py -q` | 11 failed：ack 不可 await/不发回执；pending 未重扫；worker 锁缺失；未使用 hmac；config fallback 缺失；浮标 WS 未 callAfter；timeline topic/list_students 漏字段 |
| 独立 review 后新增 `test_ack_does_not_republish_receipt_when_message_is_already_delivered`、pending 半成功/同 session 多 raw 测试 | 暴露重复回执、pending 重扫非幂等、raw transcript 错配风险 |

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_message_service.py tests/test_service_routing.py tests/test_store.py tests/test_config.py tests/test_app_context.py tests/test_floating_native_phase3.py -q` | PASS（51 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_store.py tests/test_service_routing.py tests/test_message_service.py -q` | PASS（31 passed, 1 warning） |
| `venv/bin/python -m pytest tests/ -q` | PASS（168 passed, 1 warning） |
| `venv/bin/python -m pytest tests/ -q` | PASS（168 passed, 1 warning，复跑确定性） |
| `git diff --check` | PASS（无输出） |
| `grep -rn "workbuddy.db\|db_path.parent.parent" copilot/` | PASS（无输出） |
| `rg -n "compare_digest|list_pending_reports|flock|worker.lock|message_delivered|callAfter|EXAMPLE_CONFIG_PATH|analysis_exists_for_report|get_raw_transcript_for_report" copilot tests` | PASS（关键修复点均命中预期文件） |

### 备注
- `MessageService.ack()` 改为 async：首次 ack 写库后发布 `message_delivered`；已送达消息重复 ack 只返回成功，不重复回执。
- lifespan 启动阶段获取同库目录 `.worker.lock`，并在 `yield` 前重扫 `analysis_pending=1` 的 Stop report；已有 analysis 的半成功 report 只清 pending，不重复写入。
- raw transcript 恢复按 report 创建时间匹配最近后续 raw，找不到匹配项时不回退到最新 raw，避免同 session 多 pending 错配。
- `floating_native` WS 收到 `analysis` / `mentor_message` 后统一 `AppHelper.callAfter(...)` 进入主线程处理。
- 本轮未修改 `copilot/static/mentor/*`；进入任务前已有未跟踪文件 `docs/mentor-ui-fixed.png`，本轮未触碰且未纳入提交。

---
## 交付摘要 — 2026-07-02 目标架构重建完成

| Phase | 内容 | 提交 |
|-------|------|------|
| 0 | 真bug修复(severity/timeline/osascript/FK/_IncludedRouter) | 7fa724d |
| 1 | 数据模型(sessions/students/mentor_messages/raw_transcripts+迁移) | 5acd511 |
| 2 | 服务化(app_context+parse_text+删ports+hook尾部字节+202/BackgroundTask+归档) | 2b14224 |
| 3 | 反向通道后端(WSRegistry+MessageService)+契约+导师台前端重设计 | 9fa0792/7bb96ae/e8e3861 |
| 4 | 可测化(handle_stop集成/多学员隔离/反向E2E)+前端Playwright | 6eca503/df2d12f |
| review | 对抗式 code-review 9 缺陷全修(2H送达回执/启动重扫 +4M+3L) | b71710f |

- 测试：**168 passed**（含 7 前端 Playwright，均带负控见过红），P0-1~6 全绿。
- 分工：后端+原生浮标=Codex；Web 前端页面/视觉=Claude 子代理。
- 编码者：Codex + Claude 子代理；验证/集成/审查：主 Agent（独立复核，非照单全收）。

---
## 真实 UI 验证 — 2026-07-02（起真服务器+浏览器截图+场景E2E）

主 Agent 起临时库服务(8781)+Playwright 驱动，**逐张肉眼核验截图**（存 docs/design/ui-verification/）：
- 01 学员列表 / 03 时间线四类型徽章卡片 / 04 AI回复摘要点开真实 lazy-fetch transcript / 05 导师发消息出站粉气泡。0 控制台错误。
- 场景 S2 反向消息 WebSocket 端到端：在线送达+学员隔离+导师回显；离线→重连补拉→ack→**导师池收 message_delivered 回执(review#1 修复闭合)**。
- **实测发现并修复真 bug**：导师台学员列表显示原始 student_id 而非 students 表 display_name（list_students 忽略表值）→ df82d33 修复，复验 student-2→张三/student-1→王佳梁/student-3→李四。
- 未测（人类残留）：PyObjC 浮标真机（跨 Space/提示气泡/脉冲）需真机冒烟。

测试总数：**169 passed**。

---
## 用户真实数据自测 → 缺陷修复 — 2026-07-02（第二轮 UI）

用户用真实历史库自测，发现 seeded 干净数据掩盖的缺陷（教训：UI 测试须用真实数据形态）：
- 空会话标题露原始 session_id → 前端显示"未命名对话"（542fbbc）
- AI回复"查看完整"全404加载失败（历史无raw_transcripts）→ 后端 /transcript 用 prompts+ai_summaries 重建返回200；前端区分404友好提示（59f25f5/542fbbc）。真实会话 c2f479aa 复验 200+重建原文✓
- 时间线配色改版：学员提问黄/AI回复浅绿/学习诊断浅蓝+左缩进（542fbbc）
- 浮标分析面板屏幕居中→跟随图标定位；对比度提高（59f25f5）
- 新增测试用例覆盖：空标题/transcript404/新配色/浮标定位（防再漏）。全量 176 passed。

---
## 功能 B 后端 — 2026-07-02 · WorkBuddy 全量会话同步

阶段：导师台显示学员机 WorkBuddy 全部会话（空间/任务分组）后端
触发原因：导师台旧路径只能看到已有 Copilot 分析的会话；需要由学员机同步本地 sessions/workspaces 结构，服务端只读 copilot.db。

### 见红记录
| 用例 | 失败原因 |
|------|----------|
| `venv/bin/python -m pytest tests/test_wb_sync.py -q` | `copilot.wb_sync` 模块不存在 |
| `venv/bin/python -m pytest tests/test_sessions_sync_api.py -q` | `POST /api/sessions/sync` 404 |
| `venv/bin/python -m pytest tests/test_store_phase1.py -k group_columns -q` | 旧 `sessions` 表没有 `group_type` / `space_name` |

### 修复验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_wb_sync.py -q` | PASS（2 passed） |
| `venv/bin/python -m pytest tests/test_sessions_sync_api.py -q` | PASS（2 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_store_phase1.py -k 'group_columns or get_sessions_by_student_from_table_reads_sessions_table or upsert_session' -q` | PASS（4 passed, 11 deselected） |
| `venv/bin/python -m pytest tests/test_store.py tests/test_store_phase1.py tests/test_mentor_api.py tests/test_sessions_sync_api.py tests/test_wb_sync.py -q` | PASS（53 passed, 1 warning） |
| `venv/bin/python -m copilot.wb_sync --help` | PASS（CLI help 正常输出） |
| `rg -n "workbuddy\\.db|db_path\\.parent\\.parent|iter_recent_transcripts" copilot --glob '*.py'` | PASS（无输出） |
| `venv/bin/python -m pytest tests/ -q` | PASS（182 passed, 1 warning） |

### 备注
- 新增学员机侧 `copilot/wb_sync.py`：只读本机 WorkBuddy SQLite，读取 sessions + workspaces，按 `cwd in workspaces.path` 判定 `space`，否则判定 `task`。
- 新增服务端 `POST /api/sessions/sync`：共享 token 鉴权，按顶层 `student_id` upsert `students` 和 `sessions`，不触碰学员机文件系统。
- `sessions` 表新增 `group_type` / `space_name` 可重入迁移；`Conversation` 与导师 sessions API 透出这两个字段。
- 独立 review 发现导师 sessions 默认 `limit=20` 会截断真实 65 组会话，已改为默认 1000，并新增 25 条同步会话回归测试。
- 同步 payload 已透传 WorkBuddy `created_at`，服务端落库不再用接收时间代替会话创建时间。
- 本轮未修改 `copilot/static/mentor/*`；进入任务前已有前端文件和截图工作树变更，未由本轮后端实现产生。

---
## 第二步·新功能 — 2026-07-02（功能A 学员提问 + 功能B 全量对话）

- 功能B｜导师台全量对话：copilot/wb_sync.py（学员机自读本地workbuddy.db→上报，服务端仍不读学员机FS）+ /api/sessions/sync + sessions.group_type/space_name + 导师台空间/任务分组显示（可折叠/未分析灰显）。真机 wb_sync synced 78 → 导师台84会话（空间23/任务55）✓（6349d88/7847adc）
- 功能A｜学员浮标主动提问：student_asks表 + llm.answer_question（技术助教，带会话上下文）+ POST /api/student/ask + 浮标AskTextField输入（点击才临时抢焦点，不打断WorkBuddy）。真机真LLM实测：提问→上下文相关的助教答案+落库✓（d46db51）
- 全量 193 passed。

---
## 导师触发全量对话上传 — 2026-07-03（设计→实现→真机）

设计调研见 docs/design/mentor-upload-feature.md（3方案评审+真实数据实测+用户3决策：工具输出不传/历史补LLM/单学员）。
- 后端核心(60f4ad8)：messages表+upload_requests表 + transcript.extract_user_query(带回退)/parse_turns + POST /api/student/sessions/{sid}/transcript(存内容+BackgroundTask限并发跑历史LLM诊断) + GET /api/transcripts/known(sha增量) + POST /api/mentor/students/{sid}/request-upload + connections mentor_command定向。208 passed。
- 客户端(011c203)：copilot/wb_upload.py(读本地workbuddy.db+只传type==message行[剥离工具输出11×压缩]+sha增量+逐会话POST) + 浮标接收mentor_command→后台线程调wb_upload。216 passed。
- 前端(adf05fe)：导师台"同步该学员全部对话"按钮 + 修point1(每轮AI回复独立"截断默认+展开该轮全文"，不再都一样)。17 e2e passed。
- 真机：wb_upload synced 78/78、messages 1663行/78会话、之前灰显会话timeline点亮34条内容；历史LLM诊断后台跑(Semaphore2)陆续去灰。红线守住：客户端读自己FS，服务端只解析上传内容。

---
## Point 2：AI 回复摘要重定义 — 2026-07-03

- 后端改为每个学员提问只对应一条 `ai_summaries.prompt_id` 摘要；`Store.add_ai_summary` 走 upsert，重跑不会为同一 prompt 追加重复行。
- 新增 `llm.summarize_reply(config, prompt_text, full_reply_text)`，默认使用可配置 `llm.summary_model=deepseek-v3-0324`，输出一段中文概述；LLM 未启用或配置不全时返回空字符串降级。
- `Store.get_prompt_reply(session_id, prompt_seq)` 按 `messages` 中 user 边界切片，拼接该提问后、下一个 user 前的所有 assistant 文本；导师端新增 `GET /api/mentor/prompts/{prompt_id}/reply` 供"显示详情"热加载原文。
- `get_timeline_by_session` 不再把每条 assistant message 当一张 `ai_summary` 卡；有 prompt rows 时只返回 prompt-scoped LLM summary，并带 `prompt_id` / `has_full_reply`。
- 新增 `python -m copilot.resummarize --latest 2`，仅对最近 N 个会话的 prompts 生成摘要，带 Semaphore 并发限制。
- 验证：`venv/bin/python -m pytest tests/ -q` → **226 passed, 1 warning**。

---
## 公网 MVP 文档前置 — 2026-07-06

阶段：代码前需求/设计/测试方案修订
触发原因：用户确认学员与导师均通过公网服务器连接，并要求改代码前先更新设计文档、需求文档、测试方案。

### 文档修订
- `docs/target-architecture.md` 升级为 v2：公网 HTTPS/WSS、双角色 token、同步状态闭环、owner 防线、测试前置。
- `docs/prd.md` 重写为公网 MVP PRD：导师不再只是观察，可发送提示与触发上传；生产 token、角色隔离、失败提示进入当前范围。
- `docs/test-plan-v2.md` 增补 P0/P1/P2 验收：public auth、mentor UI token、upload_requests 离线补拉、session owner、防假绿 redline、bulk 诊断失败提示。
- `docs/design/mentor-upload-feature.md` 标记基础链路已实现、离线补拉待补；历史诊断不要求严格恢复，但必须失败可见并可重试。

### 备注
- 本轮只改文档，未改业务代码。
- 后续编码必须先为新增测试项写测试并见红，再实现。

---
## 学员端技术助教体验文档修订 — 2026-07-06

阶段：代码前场景/体验确认
触发原因：用户确认学员端定位为“技术助教浮标”，过程提醒提示词需可自定义，当前会话自动跟随只服务学员端。

### 文档修订
- `docs/prd.md` 新增学员端过程提醒、技术助教面板、当前会话自动跟随需求；导师台不展示学员当前查看会话。
- `docs/target-architecture.md` 新增 D10-D12、学员端技术助教体验章节、`prompt_configs` 扩展点；当前由配置/管理员更新过程提醒提示词，未来导师端可编辑全员提示词。
- `docs/design/frontend-spec.md` 将学员端从“分析卡”修订为“技术助教面板”：顶部会话切换、主体当前建议/导师提示、底部助教问答。
- `docs/test-plan-v2.md` 增补 P1-21~23、FE-9、S6：提示词可更新、助教问答上下文优先级、当前会话跟随、无复杂 tab 结构。

### 备注
- 本轮只改文档，未改业务代码。
- 后续实现前必须先补对应测试并见红。

---
## 公网 MVP + 学员技术助教补强实现 — 2026-07-08

阶段：按已更新 PRD/架构/测试方案进入实现。
范围：公网双角色鉴权、upload_requests 状态闭环、session owner 防线、bulk 诊断失败可见与同 sha 重试、过程提醒提示词配置、学员端本地当前会话跟随、导师台 token 携带、部署脚本公网参数。

### 见红记录
| 用例 | 初始失败 |
|------|----------|
| `venv/bin/python -m pytest tests/test_public_auth.py tests/test_upload_requests.py tests/test_server_redlines.py ... -q` | 11 failed：单 token 鉴权、upload_requests 状态接口、owner 防线、bulk failed retry、浮标状态回写、旧 mentor/ws.py 均未实现 |
| `venv/bin/python -m pytest tests/test_prompt_config.py tests/test_deploy_config.py tests/test_llm.py::TestBuildSystemPrompt -q` | ImportError/缺 prompt_configs/启动脚本 hard-code host |
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py::test_poll_current_session_prefers_local_workbuddy_detection -q` | 浮标无本地当前会话检测方法 |
| `venv/bin/python -m pytest -q` | 裸 pytest 误收集根目录旧调试脚本 `sync_test.py` |

### 实现摘要
- 鉴权：新增 public 模式校验；`student_token` 仅用于 `/report`、学员 WS、学员上传/补拉/提问；`mentor_token` 仅用于导师 REST/WS。旧 `auth.token` 在 local/dev 模式继续兼容。
- upload_requests：表增加 `updated_at/error_message/result_json`；新增学生端 pending 补拉和状态回写接口；浮标离线重连后补拉 pending，请求执行时回写 running/done/failed。
- 隔离：`sessions.session_id` owner 固定；跨学员 upsert/report/upload 返回错误，不再更新 title/group/activity 或混入 timeline。
- bulk 上传：`raw_transcripts` 增加 `analysis_status/analysis_error`；后台 LLM 失败标 failed；相同 sha 若上次诊断 failed，会复用已存 raw 重试分析，不重新解析上传体。
- 学员端：浮标优先读取本机 WorkBuddy sessions 识别当前会话；面板关闭时自动跟随，打开时只更新顶部激活标记。
- 过程提醒：新增 `prompt_configs`，`process_reminder_prompt` 可由 Store 更新；LLM system prompt 合并“少而准/不要频繁打断”守则。
- 部署/前端：`start_service.sh` 支持 `COPILOT_HOST/COPILOT_PORT/COPILOT_PUBLIC`；hook/install/浮标优先使用 `COPILOT_STUDENT_TOKEN`；导师台 401 后提示输入 mentor token，并在 fetch/WS 中携带。
- 测试入口：新增 `pytest.ini` 限定 `testpaths = tests`，避免根目录旧手动调试脚本被裸 pytest 收集。

### 验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_public_auth.py tests/test_upload_requests.py tests/test_server_redlines.py tests/test_prompt_config.py tests/test_deploy_config.py tests/test_mentor_frontend.py::TestFrontendStructure::test_app_js_sends_mentor_token_for_public_mode tests/test_llm.py::TestBuildSystemPrompt tests/test_store.py::TestStore::test_upsert_session_rejects_cross_student_owner_change tests/test_transcript_upload_api.py::test_same_sha_retries_background_analysis_after_previous_failure tests/test_floating_native_phase3.py::test_float_ws_url_prefers_student_role_token tests/test_floating_native_phase3.py::test_upload_mentor_command_reports_running_and_failed_status tests/test_floating_native_phase3.py::test_poll_current_session_prefers_local_workbuddy_detection -q` | PASS（23 passed, 1 warning） |
| `venv/bin/python -m pytest tests -q` | PASS（257 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（257 passed, 1 warning） |

### 备注
- warning 来自 FastAPI/TestClient 依赖的 StarletteDeprecationWarning，不影响本轮行为。
- 真机公网部署仍需外部 HTTPS/WSS 反向代理和真实 token 注入；本轮已完成应用侧配置、鉴权和测试覆盖。

---
## public_base_url HTTPS/WSS 客户端补强 — 2026-07-09

阶段：安装测试路径优化。
触发原因：公网正式给学生安装时，不能要求学生端继续按 `host + port` 拼 `http://` / `ws://`，需要直接配置 `https://域名` 并自动使用 `wss://`。

### 实现摘要
- `copilot.config.service_url/ws_url` 支持 `service.public_base_url`；`https://...` 自动映射为 `wss://...`。
- `hook.py` 使用 `public_base_url` 或 `COPILOT_SERVER_URL` 上报 `/report`，仍保持 stdlib-only。
- `floating_native.py` 的 REST/WS 均复用统一 URL 构造，学生浮标可直接连 HTTPS/WSS 域名。
- `wb_sync.py` / `wb_upload.py` 的 server URL 解析支持 `public_base_url`，env `COPILOT_SERVER_URL` 仍最高优先级。
- `register_hook.py` 对齐 `COPILOT_STUDENT_TOKEN`，并可把 `COPILOT_SERVER_URL` 写入 hook 命令。
- README 补充公网服务端/学生端配置示例。

### 验证
| 命令 | 判定 |
|------|------|
| `venv/bin/python -m pytest tests/test_config.py::TestUrlBuilders tests/test_hook.py::TestLoadConfig::test_service_base_url_prefers_public_base_url tests/test_hook.py::TestMain::test_main_posts_to_public_base_url tests/test_floating_native_phase3.py::test_float_urls_use_public_base_url_for_https_and_wss tests/test_wb_sync.py::test_server_url_prefers_public_base_url tests/test_wb_sync.py::test_server_url_env_override_wins_over_public_base_url -q` | PASS（10 passed） |
| `venv/bin/python -m pytest -q` | PASS（264 passed, 1 warning） |

---
## 跨平台测试 lane 与 test-plan-v3 — 2026-07-10

阶段：Phase 0，建立 Student Core 平台隔离、依赖分层和防 critical-skip 假绿门。

### 见红与修复

| 尝试 | 命令 | 结果与原因 | 修复 |
|---|---|---|---|
| 1 | `venv/bin/python -m pytest tests/test_platform_imports.py -q` | RED：1 failed, 5 passed；critical module-level `importorskip` 虽非零退出，但输出只有 `1 skipped`，未清楚说明 critical gate | 将 collection 检查放到 `pytest_collect_file`，在模块进入 importorskip 前对 critical 模块抛出含 `Critical` 的 UsageError；普通 optional skip 保持成功 |

### 验证

| 命令 | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_platform_imports.py -q` | PASS（6 passed） |
| 内联文档合同检查（frontmatter、49 个 v2 ID、矩阵/breaker/W0/W1/双轴关键词） | PASS（49 v2 IDs mapped） |
| `venv/bin/python -m pytest -q` | PASS（270 passed, 1 warning in 47.85s） |
| `git diff --check` | PASS |

### Task 8 最终复审补强：SQLite completion ledger — 2026-07-10

复审进一步指出同目录 hard-link 发布虽避免覆盖，但不能跨平台可靠地 fsync 父目录；断电可能令
final `.done` 消失并重跑 upload。为避免引入 Windows 不可移植的目录 fsync，completion 真相
统一收敛到已存在的 state-dir SQLite。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_completion_commit_failure_leaves_no_durable_completion_and_allows_retry tests/test_student_coordinator.py::test_legacy_done_file_is_not_completion_authority_after_sqlite_migration -q` | 2 failed：旧实现没有 completion commit 失败回滚语义，且 legacy `.done` 仍阻止执行 |

`.claim-locks.sqlite3` 现包含 `completed_commands(request_key PRIMARY KEY, completed_at_ns)`：claim 在
同一 `BEGIN IMMEDIATE` mutex 内查表；uploader 成功后只有 `INSERT + COMMIT` 成功才写入内存
handled 状态。commit 失败 rollback 后 claim 被释放，下一次可以重传；旧 `.done` 作为非权威残留
完全忽略，不读取也不迁移，避免把历史未确认 marker 误判为完成。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_completion_commit_failure_leaves_no_durable_completion_and_allows_retry tests/test_student_coordinator.py::test_legacy_done_file_is_not_completion_authority_after_sqlite_migration tests/test_student_coordinator.py::test_completed_upload_command_is_deduplicated_after_coordinator_restart tests/test_student_coordinator.py::test_concurrent_upload_commands_complete_once_in_shared_sqlite_ledger tests/test_student_coordinator.py::test_failed_upload_command_releases_durable_claim_for_retry -q` | PASS（5 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（100 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（420 passed, 1 warning in 19.67s） |
| `git diff --check` | PASS |

### Task 8 最终复审补强：原子发布 completion marker — 2026-07-10

复审指出即使 direct `.done` 使用 inode 安全清理，若清理本身失败，未确认内容仍位于 final path，
下一次 claim 会把它当作完成。完成语义需要“先确认写入、后发布”，不能依赖失败后的删除。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_done_temp_cleanup_failure_never_creates_final_done_and_retry_succeeds -q` | FAIL：direct done fsync+cleanup 失败仍留下 final `.done`，重试被拒绝 |

完成标记改为先在同目录唯一 `.tmp` 写入 `done\n` 并 fsync；仅写入确认后才在已有 SQLite
`BEGIN IMMEDIATE` mutex 内以 `os.link(temp, done)` 安装最终名称。hard link 是不覆盖的原子创建：
已有 done 不会被重写；任何 temp 写入/清理/安装异常都不会产生 final done，重试使用新的 temp。
temp 的最终清理也复用 inode identity 检查，错配文件保留而不误删。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_done_temp_cleanup_failure_never_creates_final_done_and_retry_succeeds tests/test_student_coordinator.py::test_failed_done_marker_fsync_cleans_and_allows_upload_command_retry tests/test_student_coordinator.py::test_failed_done_marker_cleanup_preserves_inode_mismatch tests/test_student_coordinator.py::test_failed_marker_cleanup_never_unlinks_an_inode_mismatch -q` | PASS（4 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（100 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（420 passed, 1 warning in 20.11s） |
| `git diff --check` | PASS |

### Task 8 最终复审补强：done marker fsync 失败 — 2026-07-10

对称审查发现 `.done` 的手写写入未复用 claim marker 的异常清理：完成标记 fsync 失败后仍存在，
调用方 finally 删除 claim，随后重试因看到 done 永久拒绝，形成假完成。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_failed_done_marker_fsync_cleans_and_allows_upload_command_retry tests/test_student_coordinator.py::test_failed_done_marker_cleanup_preserves_inode_mismatch -q` | 1 failed：done fsync 失败后 `.done` 残留，无法重试 |

`_mark_upload_request_complete()` 现复用 `_write_marker(done_path, "done\\n")`，因此获得同样的
O_EXCL inode identity 清理：失败只删除自建且未被替换的 done 文件；成功内容仍严格为 `done\n`。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_failed_done_marker_fsync_cleans_and_allows_upload_command_retry tests/test_student_coordinator.py::test_failed_done_marker_cleanup_preserves_inode_mismatch tests/test_student_coordinator.py::test_failed_claim_marker_fsync_cleans_only_its_claim_and_allows_retry -q` | PASS（3 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（99 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（419 passed, 1 warning in 20.14s） |
| `git diff --check` | PASS |

### Task 8 最终复审补强：marker fsync 失败重试 — 2026-07-10

复审复现 `_write_marker()` 在 write/flush/fsync 失败后遗留刚创建的 `.claim`：同一进程重试会将
自己的残留 PID 当作活 owner，永久返回 false。清理时也不能无条件 unlink，否则路径若被外部替换会
误删非本次创建的文件。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_failed_claim_marker_fsync_cleans_only_its_claim_and_allows_retry -q` | FAIL：第一次 fsync 失败后 `.claim` 仍在，重试无法领取 |

`_write_marker()` 现在在 `O_EXCL` 后保留 fd 的 inode identity；异常时仅当当前 `lstat` 与该
identity 相同才删除，身份不一致或清理异常都保留路径并重新抛出。这样既清除自建半写 marker，又不
删除其他 owner 的替换文件。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_failed_claim_marker_fsync_cleans_only_its_claim_and_allows_retry tests/test_student_coordinator.py::test_failed_marker_cleanup_never_unlinks_an_inode_mismatch tests/test_student_coordinator.py::test_concurrent_stale_claim_recovery_allows_only_one_new_owner tests/test_student_coordinator.py::test_claim_mutex_does_not_leave_a_persistent_gate_after_owner_closes -q` | PASS（4 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（97 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（417 passed, 1 warning in 19.29s） |
| `git diff --check` | PASS |

### Task 8 最终复审补强：recovery mutex 崩溃释放 — 2026-07-10

对 recovery gate 的进一步审查表明，固定 `.recover` 文件即使只在临界区持有，进程恰在临界区
崩溃时仍会永久阻塞后续上传；同时对 stale gate 再做文件 rename 会引入递归的同类竞争。

修复为 spool 安全状态目录中的 stdlib SQLite `BEGIN IMMEDIATE` 短事务作为跨进程 claim mutex：
SQLite 锁由内核在连接/进程退出时释放，不留下业务 gate 文件。持锁者独占执行 stale 复验、原子
`os.replace` 归档旧 claim 与 `O_EXCL` 新建；事务在所有返回/异常路径 rollback+close。锁数据库与
其父 state 目录均拒绝 symlink。该锁只保护微小 claim 临界区，不覆盖 uploader 执行。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_concurrent_stale_claim_recovery_allows_only_one_new_owner tests/test_student_coordinator.py::test_claim_mutex_does_not_leave_a_persistent_gate_after_owner_closes tests/test_student_coordinator.py::test_crash_stale_upload_claim_is_recovered_after_restart tests/test_student_coordinator.py::test_live_upload_claim_stays_exclusive_after_restart tests/test_student_coordinator.py::test_expired_upload_claim_recovers_when_process_liveness_is_unavailable -q` | PASS（5 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（95 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（415 passed, 1 warning in 19.35s） |
| `git diff --check` | PASS |

### Task 8 最终复审补强：stale claim 并发接管 — 2026-07-10

复审继续发现：两个进程同时判定旧 claim stale 时，先到者若直接 unlink 并重建，后到者可能把
新 claim 当旧路径删除，最终两者都拿到 claim。该问题不能用重试掩盖，必须使 stale 接管本身
串行且旧 marker 的移除为原子改名。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_concurrent_stale_claim_recovery_allows_only_one_new_owner -q` | FAIL：可控两线程交错得到 2 个 non-None claim，复现路径复用删除 |

每个 request 现在先用独立 `O_EXCL` recovery gate 串行所有 claim 创建者；gate 获胜者在 gate
内复验 stale，把旧 `.claim` 用同目录 `os.replace` 原子移入唯一 `.stale-*` 文件，再创建新 claim。
非获胜者不会执行 stale 清理或创建；活 claim、损坏 marker、symlink 和既有 done 语义保持不变。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_concurrent_stale_claim_recovery_allows_only_one_new_owner tests/test_student_coordinator.py::test_crash_stale_upload_claim_is_recovered_after_restart tests/test_student_coordinator.py::test_live_upload_claim_stays_exclusive_after_restart tests/test_student_coordinator.py::test_expired_upload_claim_recovers_when_process_liveness_is_unavailable tests/test_student_coordinator.py::test_completed_upload_command_is_deduplicated_after_coordinator_restart tests/test_student_coordinator.py::test_failed_upload_command_releases_durable_claim_for_retry -q` | PASS（6 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（93 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（413 passed, 1 warning in 19.60s） |
| `git diff --check` | PASS |

### 实现摘要

- Student Core 建立最小平台中立包，并用 AST + 运行时 import probe 禁止 AppKit/Foundation/objc/fcntl 泄漏。
- 依赖拆为 core/server/macos/windows 四层；默认 requirements 继续兼容 server + macOS 开发环境。
- pytest 启用 strict markers；critical 的运行时 skip 和 collection importorskip 均失败，普通可选 skip 不受影响。
- 新增 active `docs/test-plan-v3.md`，完整保留并逐项映射 v2 的 P0/P1/FE/V/S/P3 判据，补充三系统 lane、隔离、breaker、双轴状态和 Windows W0/W1 门。
- 本轮修复次数 1；无振荡、无 P0 连续失败。

### Task 1 质量审查修复

独立质量审查指出 critical collection AST、探针并发隔离/超时和 v3 空 marker 命令存在
假绿或误杀风险。逐项补负控后确认问题成立：

| RED | 结果 |
|---|---|
| pytest alias 的 module-level critical importorskip | `from pytest import importorskip as ...` 未被拦截，输出仅 `1 skipped` |
| critical 正常测试 + 普通测试函数内 optional importorskip | 整个模块被错误拒绝为 UsageError |
| probe `timeout_seconds=0.1` | 未超时失败，等待慢探针完成 |
| v3 当前 gate 合同 | 发现 6 条尚无收集项的 marker 命令被写成当前精确 gate |

修复后，collection AST 只检查模块导入期会执行的 importorskip，支持 `pytest` alias 和
`from pytest import importorskip` alias；函数体内普通 optional skip 不再误伤 critical peer。
每个 probe 使用 `tests/` 下独立临时子目录并只清理自己的 namespace，子进程有明确 timeout。
v3 当前命令改成已实际返回 0 的路径组合，空 marker 标为逐 Task 迁移的未来选择器，并分别
给出 Windows 原生 venv 与 Git Bash 命令。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_platform_imports.py -q` | PASS（12 passed） |
| v3 当前 Store/Service/WS 路径组合 | PASS（52 passed） |
| `venv/bin/python -m pytest tests/e2e/test_mentor_ui.py -q` | PASS（21 passed） |
| `venv/bin/python -m pytest -q` | PASS（276 passed, 1 warning in 60.58s） |

本轮新增修复计数 4，累计 Task 1 修复计数 5；无振荡、无 P0 连续失败。

### Task 1 并发 collection 隔离补强

第二轮质量复审确认：probe 虽有独立目录，但文件仍叫 `test_probe.py`；另一个并发执行的
`pytest tests/` 会递归发现它，并被 critical collection policy 中断。新增 live-probe +
并发 `--collect-only tests` 负控后见 RED（277 tests collected, 1 UsageError）。同时文档合同
见 RED：PowerShell 当前目录下的 venv 命令缺少 `./` 的 Windows 形式 `.\`。

修复：probe 改用不匹配默认 `test*.py` 的 `_pytest_gate_probe.py`；collection hook 只检查
`python_files` 匹配项或命令行显式文件。递归收集忽略 live probe，显式传入同一 probe 时
仍执行真实 `tests/conftest.py` policy 并清晰失败。PowerShell 命令统一使用
`.\.venv-win\Scripts\python.exe`，不再与 cmd 混称。

| GREEN | 判定 |
|---|---|
| 新增并发收集 + PowerShell 合同回归 | PASS（2 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py -q` | PASS（13 passed） |
| `venv/bin/python -m pytest -q` | PASS（277 passed, 1 warning in 60.32s） |

本轮新增修复计数 2，累计 Task 1 修复计数 7；无振荡、无 P0 连续失败。

---
## Task 2 — 2026-07-10 · LLM 失败可见与同 SHA 可重试

阶段：Phase 1，关闭生产 LLM 失败被降级 dict 伪装成分析完成的假绿路径。

### 见红与修复

| 尝试 | 命令 | 结果与原因 | 修复 |
|---|---|---|---|
| 1 | `venv/bin/python -m pytest tests/test_llm.py tests/test_analysis_service.py tests/test_transcript_upload_api.py tests/test_wb_upload.py -q` | RED：3 个收集错误；`AnalysisOutcome` 尚不存在，生产失败无法和成功降级区分 | 新增结构化 outcome；Service/bulk 边界兼容旧 dict fake，并在 provider failure 时保留 pending 或标 failed |

### 验证

| 命令 | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_llm.py tests/test_analysis_service.py tests/test_transcript_upload_api.py tests/test_wb_upload.py -q` | PASS（34 passed, 1 warning in 3.25s） |
| `venv/bin/python -m pytest -q` | PASS（284 passed, 1 warning in 52.03s） |
| `git diff --check` | PASS |

### 实现摘要

- 生产分析返回 `AnalysisOutcome`：禁用/无 key 是成功降级；网络、HTTP、响应 JSON 失败是明确失败，同时保留仅供展示的 fallback value。
- live Stop 的 provider failure 不写 analysis/AI summary、不发布 analysis complete，report 继续 pending 等待现有恢复流程。
- bulk failure 不写伪 analysis，raw transcript 标记 `failed` 并保存 `analysis_error`；同 SHA 重试只复用服务端已有 raw，`stored=0`，不解析或重写客户端 body/messages/raw。
- known manifest 现在返回每个 session 的 `sha + analysis_status`；学员上传器兼容旧字符串 manifest，并在同 SHA、status=failed 时重发以触发服务端分析重试。
- 日志只记录流程标识、失败类型/状态和截断 session 标识，不记录 transcript 或 token。

本轮修复尝试 1；无振荡、无 P0 连续失败。

### Task 2 质量审查修复

独立质量审查发现 4 个 Important：same-SHA retry 读取 latest-any raw、pending Stop
重试重复写 prompt、旧 SHA 的后台结果可污染新 SHA、manifest v2 直接替换旧格式；另有
provider 通用异常正文进入日志/状态和 `analyze()` 成功路径覆盖不足。

| RED | 结果 |
|---|---|
| SHA 对齐 + stale CAS + prompt 幂等 + 双版本 manifest + 稳定错误码 | 7 failed, 58 passed；分别暴露缺 SHA 精确读取、A 结果写入 B、prompts 无 report_id、默认 manifest 已破坏旧客户端、通用异常正文泄漏 |

修复后，same-SHA retry 按 `student_id + session_id + sha` 读取原始 bulk 行；Stop prompt
使用 nullable `prompts.report_id` 和 partial unique index 持久化幂等，恢复时复用原 prompt/
seq/summary 关联。bulk 分析结果在 `BEGIN IMMEDIATE` 事务内完成“最新 bulk SHA 校验 +
report + analysis + done”原子提交，stale 结果直接丢弃且不发布事件。manifest 默认保留旧
字符串格式，新客户端显式请求 v2；生产 provider 通用错误只保留类型/HTTP 状态码。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_llm.py tests/test_analysis_service.py tests/test_transcript_upload_api.py tests/test_wb_upload.py tests/test_store.py -q` | PASS（65 passed, 1 warning in 0.62s） |
| `venv/bin/python -m pytest -q` | PASS（289 passed, 1 warning in 10.34s） |
| `git diff --check` | PASS |

本轮新增修复计数 5，累计 Task 2 修复计数 6；无振荡、无 P0 连续失败。

### Task 2 最终兼容性修复

最终复审确认两个恢复/滚动升级缺口：新 report 仍未持久化 prompt，导致 hook 在
`accept_report` 后崩溃时 lifespan 无法恢复原始 prompt；新客户端仍把旧服务端的字符串
manifest 当作 done，从而无法触发旧服务端自身的 same-SHA retry 路由。

| RED | 结果 |
|---|---|
| 真进程恢复 + legacy pending prompt 迁移 + legacy manifest unknown probe | 7 failed, 83 passed；恢复 LLM 收到空 prompt，近邻旧 prompt 未关联，legacy same-SHA 被客户端直接 skip |

修复后，`Store.add_report` 持久化 recovery prompt，bulk connection helper 仍默认空 prompt。
旧库只对 pending Stop 做保守回填：非空 report prompt 必须 student/session/content 相同；
历史空 report prompt 必须同 student/session 且在 report 后 30 秒内；所有匹配按最近距离
一对一分配，无法安全匹配的行保持 NULL。真实测试重建 Store 模拟进程重启，验证 prompt、
summary、pending 全链路恢复。

旧字符串 manifest 显式归一为 `analysis_status=unknown`；同 SHA 会发一次只含空
`filtered_content` 的兼容 probe，让旧服务端在解析 body 前自行 skip/retry，不重传原文。
v2 的 done/pending/running/skipped/空状态仍按原语义跳过。prompt 数据库行是权威源，
EventBus 仅承担瞬时通知；UI 漏收时通过持久化查询补拉，本阶段不引入 outbox。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_llm.py tests/test_analysis_service.py tests/test_service_routing.py tests/test_transcript_upload_api.py tests/test_wb_upload.py tests/test_store.py tests/test_store_phase1.py -q` | PASS（90 passed, 1 warning in 0.89s） |
| `venv/bin/python -m pytest -q` | PASS（290 passed, 1 warning in 10.81s） |
| `git diff --check` | PASS |

本轮新增修复计数 3，累计 Task 2 修复计数 9；无振荡、无 P0 连续失败。Task 2 修复轮已结束。

### Task 2 旧库迁移歧义修复（停止线重置后）

用户已批准越过原“总修复 ≥15”停止线继续开发；本轮闭环修复计数重新从 1 记录。

最终复审证实，旧库回填在同一 student/session 的多个 pending reports 与多个 NULL
prompts 都落入 30 秒窗口时，会按全局最小时间差贪心交叉绑定。负控构造 reports
`t=10/11` 与 prompts `t=12/12.5`，见 RED：实际 `report_id=[2,1]`，预期都为 NULL。

修复后先构造完整候选关系，只在 report 侧恰有一个候选、且该 prompt 侧也恰有一个
候选时回填。非空 `reports.prompt` 仍必须 content 完全相同；任一侧歧义均不猜测。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_store.py -k 'legacy and prompt' -q` | PASS（2 passed, 26 deselected） |
| `venv/bin/python -m pytest tests/test_llm.py tests/test_analysis_service.py tests/test_service_routing.py tests/test_transcript_upload_api.py tests/test_wb_upload.py tests/test_store.py tests/test_store_phase1.py -q` | PASS（91 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（291 passed, 1 warning in 10.72s） |

重置后新增修复计数 1；无振荡、无 P0 连续失败。

### Task 2 旧库部分迁移重启与时间窗修复

独立复审补充发现两个 Important。其一，旧库若已存在 `prompts.report_id` 且只完成部分
绑定，迁移仍会把已占用 report 纳入 NULL prompt 候选，随后创建 partial unique index 时
因重复 `report_id` 失败。其二，非空 `reports.prompt` 的精确内容回填错误地受 30 秒窗口
限制，丢失了内容足以唯一配对的旧数据。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_store.py -k 'legacy and prompt' -q` | 2 failed, 2 passed, 26 deselected；分别复现 unique constraint 失败和窗口外 exact prompt 未回填 |

修复后，候选 report 查询排除任何已被非空 `prompts.report_id` 占用的 report，使迁移可在
部分完成状态安全重启并成功创建唯一索引。非空 `reports.prompt` 走 student/session/content
精确匹配且不受时间窗限制，仍要求双侧唯一；空 report prompt 继续只接受 report 后
0..30 秒内的同 student/session 候选。既有空 prompt 单对单与多对多全 NULL 语义保持不变。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_store.py -k 'legacy and prompt' -q` | PASS（4 passed, 26 deselected） |
| `venv/bin/python -m pytest tests/test_store.py tests/test_store_phase1.py -k 'legacy or prompt or migration' -q` | PASS（9 passed, 36 deselected） |
| `venv/bin/python -m pytest tests/test_llm.py tests/test_analysis_service.py tests/test_service_routing.py tests/test_transcript_upload_api.py tests/test_wb_upload.py tests/test_store.py tests/test_store_phase1.py -q` | PASS（93 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（293 passed, 1 warning in 10.55s） |

本轮一次实现关闭 2 个复审项，重置后新增修复计数 2，累计 3；无振荡、无 P0 连续失败。

---
## Task 3 — 2026-07-10 · 上传请求双轴状态与统一状态机

阶段：Phase 1，拆分内容传输与 LLM 诊断状态，保留旧客户端的单轴协议。

### 测试方案与见红

先以真临时 SQLite Store 覆盖：旧 schema 重启迁移、transfer/analysis 独立错误、终态禁止
回退、failed 重试、同状态幂等、过期 expected CAS 不覆盖、跨 student not-found，以及旧 Store/
HTTP payload 兼容。控制器用注入的 recording service 证明状态更新不再直接写 Store。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py -q` | 收集期 2 errors：`copilot.upload_service` 不存在，双轴 Service 能力尚未实现 |

### 实现与验证

- `upload_requests` 增量增加 `transfer_status/analysis_status` 与两轴 error；旧
  pending/running/done/failed 映射为 pending/running/stored/failed，legacy error 保守迁入
  transfer error，迁移可重复启动。
- `UploadRequestService` 锁定两张转换表；同状态是无写入幂等，stored/done 终态不可回退，
  failed 可重试。
- Store 用 allowlist 选择轴，并以单条带 `expected old status` 的 UPDATE 完成 CAS；竞争失败
  重新读当前状态并返回明确冲突，不做过期覆盖。
- legacy `status/error_message/result` 继续输出；`status` 始终由 transfer 派生，响应同时输出
  双轴字段。transfer 失败错误优先，否则展示 analysis 失败错误。
- AppContext 生产组合根显式注入 Service，手工测试 context 保留 lazy 兼容；控制器创建和状态
  更新统一经 Service。日志只记录 request_id、轴、状态变化和是否有错误，不记录 token/正文。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py -q` | PASS（17 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_transcript_upload_api.py -q` | PASS（22 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（306 passed, 1 warning in 10.78s） |
| `git diff --check` | PASS |

本轮为新功能首轮 RED→GREEN，无审查缺陷修复；重置后累计修复计数仍为 3；无振荡、无
P0 连续失败。

### 提交前自审修复

自审构造“旧库已添加 `transfer_status=stored`、但 legacy `status` 仍为 pending”的部分迁移
状态，见 RED：重启后 `status` 仍为 pending，旧 pending 列表会误收已存储请求。迁移现在在
回填 transfer 后统一反向派生 legacy status；响应也从 transfer 计算 legacy status，避免部分
升级状态短暂对外不一致。

| 最终 GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py -k partial_axis -q` | PASS（1 passed, 9 deselected） |
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_transcript_upload_api.py -q` | PASS（23 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（307 passed, 1 warning in 10.81s） |
| `git diff --check` | PASS |

重置后新增修复计数 1，累计 4；无振荡、无 P0 连续失败。

### Task 3 规格审查修复

规格审查发现两条上传请求 controller 仍直接注入 Store：列表直接查询 Store，状态更新在
Service CAS 后又从 Store 读取最新行，边界没有真正收口；同时 legacy 错误优先级用例只覆盖
analysis 单独失败，没有锁定 transfer/analysis 同时失败时的优先级。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py -q` | 2 failed, 17 passed；注入 fake UploadRequestService 并让 Store 读取抛错后，列表和更新 route 都暴露了直接 Store 调用 |

修复后 `UploadRequestService.list` 封装筛选读取；列表 route 只依赖 Service，更新 route 直接
序列化 `mark_transfer` 返回的 CAS 后最新行。not-found/ownership 仍由 Service 抛出并映射
404。错误优先级用合法转换同时构造 transfer failed(`upload offline`) 和 analysis failed
(`llm timeout`)，断言 legacy `error_message` 选择 transfer error，两个新字段各自保留。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py -q` | PASS（19 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_transcript_upload_api.py -q` | PASS（25 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（309 passed, 1 warning in 10.92s） |
| `git diff --check` | PASS |

本轮关闭 4 个规格审查项，重置后新增修复计数 4，累计 8；无振荡、无 P0 连续失败。

### Task 3 质量审查修复

质量审查发现两个状态顺序缺口：transfer failed 的结果在 retry running/stored 未携带 result
时会残留；macOS 浮标在 running 回写失败后仍继续上传，随后会尝试从服务端 pending 直接
写 done/stored。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_floating_native_phase3.py -q` | 3 failed, 34 passed；真 Store 与 API 均残留 `{"failed": 1}`，running 回写 breaker 后 uploader 仍被调用 |

修复后，每次实际 transfer CAS 都显式写 `result_json`：有 result 时序列化，没有时清 NULL；
analysis CAS 不触碰 transfer result，同状态幂等仍不写。macOS worker 必须先成功回写 running
才调用 uploader；running 回写异常进入既有 outer failure 路径，可尝试上报 failed，二次网络
异常仍被捕获并清理 inflight，不阻塞线程。成功路径继续 running→done。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_floating_native_phase3.py -q` | PASS（37 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_floating_native_phase3.py tests/test_transcript_upload_api.py tests/test_wb_upload.py -q` | PASS（52 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（312 passed, 1 warning in 11.04s） |
| `git diff --check` | PASS |

本轮关闭 2 个 Important，重置后新增修复计数 2，累计 10；无振荡、无 P0 连续失败。

---
## Task 4 — 2026-07-10 · 导师台真实上传与诊断状态闭环

阶段：Phase 1，导师台移除固定延迟伪完成，改为 upload request 双轴持久状态。

### 测试方案与见红

后端以真临时 Store 覆盖导师 GET、诊断 retry、raw/messages/transfer 不变、LLM 成败、非法
状态及 mentor-only WS；前端以真实 `app.js` + Playwright 覆盖 WS→轮询、诊断失败仅重试、
AbortController 换学员竞态和服务端错误 XSS。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_requests.py tests/test_mentor_frontend.py tests/e2e/test_mentor_ui.py -q` | 8 failed, 40 passed；导师 GET/retry/WS 与前端 request 状态机尚未实现 |

### 实现与验证

- `UploadRequestService` 封装 mentor get 与原子 failed→pending retry 准备；仅具体 session、
  transfer=stored、analysis=failed 且当前 raw 有 SHA 时接受。
- retry 后台复用服务端 raw，状态 pending→running→done/failed；不重写 raw 内容、bulk messages、
  transfer/result。LLM 错误使用既有稳定错误码。
- 每次 transfer/retry 状态变化发布持久化快照；WSRegistry 仅向导师池广播。WS result 只保留
  聚合非文本值，剔除 token/transcript/raw/content，正文不会进入状态事件。
- 前端以 `state.uploadRequest` 为唯一业务状态源；WS 加速、可取消 REST 轮询补漏，request_id、
  student_id 与 generation 三重校验阻止旧响应覆盖。真实显示双轴状态，analysis failed 仅调用
  retry-analysis，错误通过 `textContent` 渲染。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_requests.py tests/test_mentor_frontend.py tests/e2e/test_mentor_ui.py -q` | PASS（48 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_connections.py tests/test_transcript_upload_api.py tests/test_service_routing.py -q` | PASS（19 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（320 passed, 1 warning in 14.83s） |

### 自审修复

自审发现上传 result 为客户端可控 dict，直接随 WS 快照广播时可夹带 transcript/token 字段。
新增负控先见 RED（1 failed），再将 WS result 收紧为仅聚合非文本值并递归剔除敏感键，定向
用例 GREEN（1 passed）。此真实规格缺陷计入 1 次修复：重置后累计修复计数 11；无振荡、
无 P0 连续失败。

### Task 4 质量审查闭环 — 真实请求诊断链与前端时序

质量审查指出五个 Important：真实上传没有关联 analysis 轴；WS/轮询缺少快照顺序；A→B→A
会让旧 POST 覆盖新请求；服务重启遗留 pending/running；WS result 仍可用数组/嵌套绕过过滤。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_wb_upload.py tests/test_floating_native_phase3.py tests/test_transcript_upload_api.py tests/test_upload_requests.py tests/test_mentor_frontend.py tests/e2e/test_mentor_ui.py -q` | 10 failed, 76 passed；五组负控分别命中缺口 |

修复后 `request_id` 从 macOS worker 贯穿每个 transcript POST；同 SHA 的导师请求发送空正文
probe，仍计 skipped。新增幂等 `upload_request_sessions`，服务验证 owner/具体 session，child
pending→running→done/failed 驱动 parent 聚合；transfer 未 stored 时不提前终结，stored 后按
failed、running、pending、all-done 优先级沿合法状态图推进。具体 session 命令同时在客户端
过滤其它本地会话。

导师前端保存 `updatedAt` 并拒绝旧快照；每次 POST 使用独立 attempt generation，切学员和新
请求均使旧生命周期失效。启动时 Service 以 CAS 将遗留 parent/child 标为
`analysis interrupted; retry`，transfer 不变且 retry 可恢复。WS result 改为严格四键
`total/synced/skipped/failed` allowlist，仅接受 0..1,000,000 的非 bool 整数。

| GREEN | 判定 |
|---|---|
| 上述六文件目标集 | PASS（86 passed, 1 warning） |
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_transcript_upload_api.py tests/test_wb_upload.py tests/test_floating_native_phase3.py tests/test_connections.py tests/test_service_routing.py -q` | PASS（77 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（329 passed, 1 warning in 21.88s） |
| `git diff --check` | PASS |

自审另以负控关闭两项：具体 session 客户端过滤（1 RED→GREEN）；旧 WS 在非终态不得取消仍
有效的权威轮询（1 RED→GREEN）。用户已批准本轮计数重置且不再以总阈值中断；新计数 2，
无振荡、无 P0 连续失败。

### Task 4 最终质量闭环 — 聚合重试、禁用诊断与精确 SHA

最终质量复审指出三个 Important：全量请求无法批量重试 failed children；LLM 禁用仍把 child/
parent 推进 pending；child 更新缺少 SHA 条件，旧背景任务可能覆盖新 SHA。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_requests.py -k 'batch_retry or child_new_sha or specific_retry_uses_child' -q` | 4 failed；批量 prepare 与 child SHA CAS 尚未实现 |
| `venv/bin/python -m pytest tests/test_transcript_upload_api.py::test_requested_transcript_with_llm_disabled_keeps_analysis_not_requested -q` | 1 failed；child 实际为 pending |

修复后，空 `session_id` 的 retry 会先收集所有 failed children，并用各 child 记录的精确 SHA
一次性验证 raw；任一缺失返回 409，parent/children 均不变。验证通过后只把 failed children
置 pending，done children 不重跑；后台逐个复用各自 raw，父聚合等待所有 child 终结。具体
session 优先使用 child SHA；无 child 的旧请求才基于当前 raw 保守创建 child。

LLM 是否启用在注册 child 前确定；禁用时 child 使用 `not_requested`，不启动后台且 parent 在
transfer stored 后仍为 `not_requested`。child upsert 在 SHA 变化时原子替换 SHA、重置初始状态
并清 error；同 SHA 完全幂等。所有背景 child CAS 带精确 SHA，旧任务只能得到 stale no-op。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_service.py tests/test_upload_requests.py tests/test_transcript_upload_api.py tests/test_wb_upload.py tests/test_floating_native_phase3.py tests/test_mentor_frontend.py tests/e2e/test_mentor_ui.py -q` | PASS（104 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（334 passed, 1 warning in 18.88s） |
| `git diff --check` | PASS |

按本轮约定关闭 3 个 Important 后新计数为 5；无振荡、无 P0 连续失败。

### Task 4 并发重试 claim 原子化

最终 follow-up 发现 batch/specific retry 的验证、child 更新与 parent claim 分属多个事务，两个
并发请求都可能成功并重复调度背景诊断。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_requests.py::test_concurrent_retry_claim_allows_exactly_one_store_winner tests/test_upload_requests.py::test_retry_api_duplicate_schedules_background_once -q` | 1 failed, 1 passed；两个线程均返回 ok |

Store 新增单一 `BEGIN IMMEDIATE` claim：事务内读取并验证 parent transfer=stored、
analysis=failed，确定具体或全部 failed children，验证 owner 与每个精确 SHA raw；全部通过后用
严格 `WHERE analysis_status='failed'` 更新 parent pending 且要求 rowcount=1，再将目标 children
failed→pending 并清错。legacy 具体请求无 child 时也只在同一事务内基于当前 raw 创建。任一
校验或 CAS 失败整笔回滚并转为 409。UploadRequestService prepare 仅委托该 Store claim。

真 SQLite 两线程/两 Service 负控现在恰好一个成功、一个冲突；并发 API 两请求也恰好返回
202/409，LLM spy 证明背景只调度一次。

| GREEN | 判定 |
|---|---|
| 相关目标集 | PASS（106 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（336 passed, 1 warning in 19.00s） |
| `git diff --check` | PASS |

关闭 1 个 Important，当前新计数 6；无振荡、无 P0 连续失败。

---
## Task 5 — 2026-07-10 · 服务端学员文件系统红线强化与旧 WS 归档

阶段：Phase 1，强化 P0-6 的自动化证据，不改变 `docs/test-plan-v2.md` 判定标准。

### 测试方案与见红

以服务端组合根 `copilot.service`、`copilot.app_context`、`copilot.mentor.routes` 为入口，解析
项目内相对/绝对 import 图并扫描所有可达 `copilot` Python 模块。AST breaker 覆盖
`Path.home()`、拆分字符串、`Path /` 组合、`.workbuddy/workbuddy.db`、projects/JSONL、
`db_path.parent.parent`、本地 transcript 读取 API 与服务端误导入学生客户端。独立 subprocess
把 HOME/USERPROFILE 指到临时目录，以真 Store、`build_context` 和 `create_app` smoke mentor/
student/report API；拦截器内置一次负控，证明访问 `.workbuddy` 会立即失败且测试不读真实 HOME。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_server_redlines.py tests/test_server_home_sentinel.py -q` | 3 failed, 1 passed；旧扫描器漏掉 6 类 breaker，server import 图为空，旧 mentor WS 尚未归档 |
| `venv/bin/python -m pytest tests/test_server_redlines.py::test_old_mentor_ws_is_archived_outside_runtime_import_graph -q` | 1 failed；归档头的额外字符串令历史文件 `from __future__` 位置非法 |

### 实现与验证

- `resolve_server_graph` 实际覆盖 12 个可达 runtime 模块；学生客户端入口 allowlist 默认不进入
  server 图，服务端一旦 import 则同时触发 `student-client-import`。
- 静态表达式折叠识别字符串 `+`、Path `/`、`joinpath`/`os.path.join` 和简单变量传播；仅精确
  `.workbuddy` 组件触发，允许服务端自身 `~/.workbuddy-copilot/copilot.db`，并允许 config 基于
  `__file__.parent.parent` 定位项目配置。
- 本地读取 API 只检查服务端调用点，不把 `copilot.transcript` 内函数定义误报为调用；
  `db_path.parent.parent` 旧技巧单独设红线。
- `26ce25c:copilot/mentor/ws.py` 原文增加三行注释式 archive header 后归档到
  `legacy/copilot/mentor_ws.py`；runtime 文件和 import spec 均不存在，归档可编译且不在图中。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_server_redlines.py tests/test_server_home_sentinel.py -q` | PASS（4 passed） |
| server graph 诊断 | PASS（12 个可达模块，0 violations） |
| 历史源与归档正文 diff | PASS（除三行 archive header 外原文一致） |
| `venv/bin/python -m pytest -q` | PASS（336 passed, 1 warning in 19.55s） |
| `git diff --check` | PASS |

自审关闭 1 个归档可编译性问题，当前新计数 7；无振荡、无 P0 连续失败。按用户本轮明确
授权，累计计数仅记录、不再作为中断剩余开发的确认门槛。

### Task 5 规格/质量复审补强 — 2026-07-10

复审发现原 import 图只收显式模块，未将 `copilot` 与 `copilot.mentor` 隐式父包纳入扫描；
同时缺少对所有 `copilot/*.py` 非学生客户端模块的全树红线断言。

| RED | 结果 |
|---|---|
| 父包负控 + 不可达非 allowlist breaker | `2 failed`：`copilot`/`copilot.mentor` 未入图；全树扫描占位漏报临时 `.workbuddy/workbuddy.db` |
| `venv/bin/python -m pytest tests/test_server_redlines.py -q` | 修复后 PASS（6 passed） |
| `venv/bin/python -m pytest tests/test_server_redlines.py tests/test_server_home_sentinel.py -q` | PASS（7 passed） |
| `venv/bin/python -m pytest -q` | 当前共享工作树在收集阶段被另一单元未实现的 `copilot.student_core.models` 阻断（2 errors；非 Task 5 变更） |

`resolve_server_graph` 现在将每个可达模块的全部 ancestor package 纳入图并扫描；新增
`scan_server_tree` 遍历整个 `copilot/`，仅跳过四个明确学生客户端入口 allowlist，临时写入的
任意非 allowlist breaker 会被捕获。当前图覆盖 14 个模块，树扫描 0 violations；未修改共享
工作树中其他代理留下的 `tests/test_student_*.py`。

---
## Task 6 — 2026-07-10 · Student Core 契约、事件 spool 与传输边界

阶段：Phase 2，新增平台无关的学员端核心原语；不引入 AppKit/Foundation/objc/fcntl，
不依赖服务端 Store，也不改变旧 Hook/服务端链路。

### 测试方案与见红

先写 `tests/test_student_spool.py` 与 `tests/test_student_transport.py`，覆盖 typed
HookEvent/SpoolEntry 序列化、原子临时文件+`os.replace`、确定性 pending 顺序、ack 删除、坏
JSON quarantine、非法 event id/路径穿越拒绝、临时/永久 HTTP 失败分类、WS 发送边界和
token 不出错误文本。实现前运行目标测试，确认新模块尚不存在：

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py -q` | 收集阶段失败（2 errors）：`ModuleNotFoundError: copilot.student_core.models` |

该负控证明测试不是“只要 import 成功就绿”：Student Core 缺失时整个目标 lane 会失败。

### 实现与验证

- `models.py` 定义冻结 dataclass `HookEvent`/`SpoolEntry`，做字段类型与 event id 校验，并
  提供 JSON-safe `to_dict`/`from_dict`。
- `spool.py` 使用同目录临时文件、flush+fsync、`os.replace` 原子入队；只按文件名排序
  pending；坏 JSON/结构或文件名不一致的条目移动至 `quarantine/`；ack 仅删除合法 id，
  `consume_one` 只在 `Accepted` 后删除。
- `transport.py` 提供可注入 opener/WS connector 的 `StudentTransport`；REST `/report` 与
  `wss/ws` 鉴权头由 token 生成但异常文本不携带 token；HTTP/WS 失败映射到
  `TemporaryNetworkError`/`PermanentTransportError`，成功返回 `Accepted`。
- 额外防线：重复 event id 不覆盖已有 spool 条目；模型层和路径层均拒绝分隔符、`.`、`..`
  与空 id。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py -q` | PASS（29 passed） |
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py -q` | PASS（42 passed） |
| `venv/bin/python -m pytest -q` | PASS（368 passed, 1 warning in 23.51s） |
| `git diff --check` | PASS |

未修改服务端、旧测试或无关 `michael-portfolio/`；`venv` 为既有未跟踪环境，不纳入提交。

### Task 6 质量复审补强 — 2026-07-10

质量复审提出两类并发/兼容性风险，先增加负控再修复：旧版 websockets 可能把错误的
`additional_headers` 延迟到 async enter 才抛错；spool 的 exists+replace 存在并发覆盖，
重复 consumer 可能重复发送，且 pending/存储目录可能跟随符号链接越界。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py -q` | 6 failed：legacy header spelling、并发 enqueue/consume、spool/quarantine/event symlink 均被旧实现复现 |

修复内容：

- transport 通过 `inspect.signature`/版本回退在创建 connector 时选择 `additional_headers`
  或 legacy `extra_headers`；新增旧版延迟失败负控与当前安装 websockets connector 参数检查，
  不建立公网连接。
- enqueue 先写入并 fsync 临时文件，再以 `O_CREAT|O_EXCL` 保留目标名并 `os.replace`，避免
  多进程同 event id 覆盖；重复消费通过独占 `.claim` 文件，失败/未分类异常都会释放 claim，
  Accepted 才 ack。
- root/quarantine 拒绝符号链接；pending 在读取前拒绝 event symlink/非普通文件，坏条目移至
  安全 quarantine，绝不读取 spool 外部目标。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py -q` | PASS（37 passed） |
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py -q` | PASS（50 passed） |
| `venv/bin/python -m pytest -q` | PASS（375 passed, 1 warning in 19.29s） |
| `git diff --check` | PASS |

共享工作树中另有 Task 7 的 Hook/安装器未提交改动；本次只提交 Student Core、其测试和本日志。

### Task 6 规格复审补强（二）— 2026-07-10

发现 `pending()` 对 `.json`、`a.b.json`、带空格的无效文件名先调用 claim 校验，异常会越过
quarantine 并阻断后续事件消费。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_spool.py::test_malformed_spool_filename_is_quarantined -q` | 3 failed：三个无效文件名均复现 `ValueError` 泄漏 |

修复：读取事件前先验证 `path.stem`；无效 stem 直接移动到安全 quarantine，不进入 claim
路径；正常 UUID/合法 event id、claim、symlink 语义保持不变。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py -q` | PASS（40 passed） |
| `venv/bin/python -m pytest tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py -q` | PASS（53 passed） |
| `venv/bin/python -m pytest -q` | PASS（381 passed, 1 warning in 19.67s） |
| `git diff --check` | PASS |

## Task 7 — 2026-07-10 · Hook 本地 spool 与安装路径

阶段：Phase 2，Hook 已从同步网络上报切换为 stdlib-only 的有界本地事件写入；Student Core
Agent 负责后续网络投递。保留 `student_id`/token/service URL 的配置兼容读取，但 Hook 不会
把 token 写入事件、日志或网络请求。

### 测试方案与见红

先重写 Hook 测试为新契约并新增真实子进程测试：`Stop` 只能读取 transcript 尾部，事件必须
使用 `event_id` + `payload` 协议原子落盘，环境变量 `COPILOT_SPOOL_DIR` 优先于
`student.spool_dir`，坏 stdin/缺字段/磁盘错误始终返回 0；子进程必须在 2 秒内结束。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_hook.py tests/test_hook_subprocess.py -q` | 收集失败（`ImportError: _spool_dir`），证明旧 Hook 尚未实现本地 spool 契约 |

### 实现与验证

- `copilot/hook.py` 仅依赖 Python 标准库；移除 urllib 网络调用和 Stop 全文读取，最大尾部为
  256 KiB，并通过临时文件 + flush/fsync + `os.replace` 写入与 Student Core 相同的 JSON
  envelope。
- spool 路径优先级为 `COPILOT_SPOOL_DIR` → `config.student.spool_dir` → Hook 所在目录的
  `spool/`；安装器和注册器注入绝对路径并保持 settings 幂等合并，Hook timeout 调整为 2 秒。
- 所有输入、文件和 JSON 异常统一降级为 return 0；日志只写异常类型，不写 token、transcript
  正文或用户目录。
- `tests/test_hook_subprocess.py` 通过真实 Python 子进程验证坏 stdin、超大 transcript 和
  无网络情况下的截止；静态门确认 Hook 不 import `copilot.student_core`/urllib。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_hook.py tests/test_hook_subprocess.py tests/test_deploy_config.py -q` | PASS（17 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_hook.py tests/test_hook_subprocess.py tests/test_deploy_config.py -q` | PASS（66 passed） |
| `venv/bin/python -m pytest -q` | PASS（378 passed, 1 warning in 19.69s） |
| `bash -n install.sh` | PASS |
| `git diff --check` | PASS |

负控覆盖：旧实现会在目标测试收集阶段失败；若恢复 `_post`/`_read_transcript_full`，静态无网络门、
`transcript_full` 断言和真实子进程边界用例均会变红。注册器升级测试会捕获旧的同步网络命令未被
替换或重复追加。Windows 真机 W0 仍未完成，安装脚本的 WorkBuddy 事实（Hook 位置、Python 命令、
settings 格式）尚待实机验证。

### Task 7 规格复审补强 — 2026-07-10

复审发现 Hook 原本把学员机的 `transcript_path` 原样写入 spool，Student Core 发送后会把本地
路径带到服务端；这违反服务端绝不接触学员文件系统的红线。另发现非法 UTF-8 字节用 U+FFFD
替换会把 1 个原始字节膨胀为 3 个 UTF-8 字节，导致序列化后超过尾读上限。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_hook.py::test_spool_never_contains_local_transcript_path tests/test_hook.py::test_invalid_utf8_tail_stays_bounded_after_json_serialization -q` | 2 failed：原路径出现在 payload；非法字节尾部序列化为 786426 bytes |

修复为 Hook 只读取并写入尾部内容，`transcript_path` 字段保留为空字符串以兼容 HookEvent
协议；完整 transcript 由 Agent 侧 WorkBuddyData 负责，服务端永远看不到本地路径。尾读采用
UTF-8 `errors="ignore"` 丢弃不完整/非法前缀，保留最新合法后缀，保证编码后不超过 256 KiB。
配置错误日志也不再打印完整用户路径，只记录异常类型。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_hook.py::test_spool_never_contains_local_transcript_path tests/test_hook.py::test_invalid_utf8_tail_stays_bounded_after_json_serialization -q` | PASS（2 passed） |
| `venv/bin/python -m pytest tests/test_hook.py tests/test_hook_subprocess.py tests/test_deploy_config.py tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py -q` | PASS（72 passed） |
| `venv/bin/python -m pytest -q` | PASS（383 passed, 1 warning in 19.77s） |
| `git diff --check` | PASS |

### Task 7 质量复审补强：序列化预算 — 2026-07-10

复审进一步发现原始尾部按 UTF-8 字节有界仍不足以约束 spool JSON：引号和反斜杠在
`ensure_ascii=False` 下各自转义为两个字节，262144 个字符可膨胀到约 524 KiB。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_hook.py::test_escaped_tail_stays_bounded_in_serialized_json -q` | 1 failed：转义后的 transcript_tail 为 524287 bytes |

`_read_transcript_tail` 现在在读取有界原始尾部后，按 JSON 字符串实际编码大小对最新后缀做
二分截断；预算同时覆盖 UTF-8、多字节、控制字符、引号和反斜杠转义，保留合法最新后缀且
不阻塞 Hook。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_hook.py::test_escaped_tail_stays_bounded_in_serialized_json tests/test_hook.py::test_invalid_utf8_tail_stays_bounded_after_json_serialization tests/test_hook.py::test_reads_only_bounded_tail_bytes -q` | PASS（3 passed） |
| `venv/bin/python -m pytest tests/test_hook.py tests/test_hook_subprocess.py tests/test_deploy_config.py tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py -q` | PASS（73 passed） |
| `venv/bin/python -m pytest -q` | PASS（394 passed, 1 warning in 22.24s） |
| `git diff --check` | PASS |

## Task 8 — 2026-07-10 · Student Coordinator 与无头 Agent

阶段：Phase 2。Student Core 新增平台无关的 `StudentCoordinator`、`StudentAgent` 和命令行
入口；Coordinator 负责 spool claim/Accepted ack、导师消息去重与 `received` 回执、上传命令
幂等和可注入重连退避。Agent 只编排一周期和启动/停止，不导入 UI、WorkBuddy 或平台模块。

### 测试方案与见红

先新增 coordinator/agent 行为用例，再在实现前运行目标 lane：

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py -q` | 收集失败（2 errors）：`ModuleNotFoundError: copilot.student_core.coordinator/agent` |

该负控证明测试确实覆盖了尚不存在的运行时，而不是只断言静态文件存在。

### 实现与验证

- `flush_spool_once()` 使用安全 claim，只有 `Accepted` 才 ack；临时、永久或未知适配器异常
  都释放 claim 并保留事件，下一周期可以重试。
- `mentor_message` 先调用可注入 handler，再发送带 `status=received` 的回执；按
  `message_id` 去重，并拒绝不匹配的 `student_id`。`upload_conversations` 仅触发可注入
  uploader，重复 `request_id` 不重复执行，未知命令安全忽略。
- 重连退避通过注入的 sleeper/clock 边界设计，退避从 1s 指数增长并封顶 30s；Agent 的
  `one_cycle()`、`start()`、`stop()` 可确定性测试。顶层避免导入 asyncio，保证平台导入探针不
  加载 Unix 专属 `fcntl`。
- `start_student_agent.py` 只读取环境变量/参数构造 Core，WorkBuddy 数据读取留给后续平台适配器；
  不记录 token、消息正文或本地路径。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py -q` | PASS（10 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py -q` | PASS（63 passed） |
| `venv/bin/python -m pytest -q` | PASS（394 passed, 1 warning in 21.60s） |
| `git diff --check` | PASS |

负控覆盖：删除 coordinator/agent 会使目标 lane 在收集阶段失败；将 ack 改为无条件删除会使
`test_coordinator_keeps_spool_entry_when_post_is_not_accepted` 变红；恢复顶层 asyncio 导入会使
`test_student_core_import_tree_is_platform_neutral` 重新捕获 `fcntl`。Windows W0/W1 与真实
WorkBuddy 上传 handler 尚未在本任务实现，留待平台适配器阶段。

### Task 8 规格复审补强 — 2026-07-10

复审发现导师消息去重只使用 `message_id`，不同学员可能互相吞消息；同时 handler/回执等待
期间没有 inflight guard，并发 live/catch-up 会重复处理。两项都先用并发与跨学员 breaker
复现后修复。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_same_message_id_for_two_students_is_not_cross_deduplicated tests/test_student_coordinator.py::test_concurrent_duplicate_mentor_message_runs_handler_and_receipt_once -q` | 2 failed：跨学员第二条被误去重，并发 handler/回执各执行两次 |

修复为 `(student_id, message_id)` 复合键；缺少 student_id 且 transport 无默认学员时拒绝处理；
进入 handler/receipt 前以无 await 间隔的 inflight set 原子占位，成功后写入 seen，异常/回执
失败在 finally 释放以便后续重试。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py -q` | PASS（67 passed） |
| `venv/bin/python -m pytest -q` | PASS（398 passed, 1 warning in 19.83s） |
| `git diff --check` | PASS |

### Task 8 双审查协议闭环补强 — 2026-07-10

双审查继续发现学生端协议未真正闭环：WS 只接受 query token，而 Transport 使用 header；导师
消息回执被伪造成 WS 帧；scope 校验允许缺失 student_id；无头 Agent 只 flush spool 不保持收包；
upload request 去重只在内存中，重启后会重复执行。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_public_auth.py::test_student_websocket_accepts_rest_auth_headers_and_keeps_query_compatibility tests/test_student_transport.py::test_ack_message_posts_to_existing_student_ack_api_with_rest_auth tests/test_student_coordinator.py::test_message_requires_exact_transport_student_scope tests/test_student_coordinator.py::test_upload_command_requires_exact_transport_student_scope tests/test_student_coordinator.py::test_completed_upload_command_is_deduplicated_after_coordinator_restart tests/test_student_coordinator.py::test_failed_upload_command_releases_durable_claim_for_retry tests/test_student_agent.py::test_agent_keeps_one_persistent_ws_and_dispatches_received_event tests/test_student_agent.py::test_agent_stop_cancels_a_blocking_sleeper_with_bounded_wait -q` | 7 failed：header WS 被 1008 拒绝、缺 `ack_message`、无 scope 命令/消息被接收、重启重复 upload、Agent 未收 WS、blocked sleeper 停不下来 |

修复内容：

- `/ws` 现在优先接受与 REST 一致的 `Authorization: Bearer` / `X-Copilot-Token`，同时保留
  query token 兼容；`StudentTransport.open_ws()` 对长连接只发送 header。
- `StudentTransport.ack_message()` 调用既有 `/api/student/messages/ack`；Coordinator 只接受
  这个持久 API 的 `Accepted`，不再向服务器发送无消费者的伪 receipt frame。
- Coordinator 的 message/command 均要求非空 `transport.student_id` 与 payload `student_id`
  精确匹配；message 保持同进程复合去重/inflight，upload 使用 spool 下 `O_EXCL` claim +
  fsync done marker，成功后跨 Coordinator/重启不重复，异常释放 claim 可重试。
- Agent 并行运行 spool loop 与一个持久 WS receive loop，JSON frame 交给 `handle_event`；断线
  使用注入的 Coordinator 退避，`stop()` cancel 阻塞 socket/sleeper 并有界等待。无 transport 的
  unit coordinator 仍只运行 spool loop。CLI 明确不注入 Noop uploader，平台上传仍是 disabled。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（89 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（409 passed, 1 warning in 18.83s） |
| `git diff --check` | PASS |

ASGI WebSocket 正/负控覆盖 header、X header、错误 header 和旧 query；Agent 额外覆盖无 WS
connector、真实持久收包、断线后 1s fake backoff 续连以及阻塞 sleeper 的 cancel。Windows W0/W1
和真实 WorkBuddy 上传 adapter 仍未在本任务声称完成。

### Task 8 最终复审补强：崩溃遗留 upload claim — 2026-07-10

最终复审发现 `O_EXCL` claim 在正常失败会释放，但 uploader 执行期间进程被 kill 时会永久留下
claim，重启后同 request 始终返回 false。该路径需要区分死亡、活跃和无法判定的 owner，不能为了
恢复而破坏运行中进程的互斥。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_crash_stale_upload_claim_is_recovered_after_restart tests/test_student_coordinator.py::test_live_upload_claim_stays_exclusive_after_restart -q` | 1 failed：模拟已死亡 PID 的重启仍返回 false；活 PID 保持 false |

claim 现读取已 fsync 的 `pid time_ns`：`os.kill(pid, 0)` 明确为不存在时回收；权限拒绝或仍存活时
严格保留；平台无法判定 liveness 时只有超过 `stale_claim_after`（默认 300s）的合法 marker 才回收；
损坏/符号链接 marker 一律不猜测、不回收。回收后仍通过 O_EXCL 重新竞争，避免两个重启进程同时上传。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_crash_stale_upload_claim_is_recovered_after_restart tests/test_student_coordinator.py::test_live_upload_claim_stays_exclusive_after_restart tests/test_student_coordinator.py::test_expired_upload_claim_recovers_when_process_liveness_is_unavailable -q` | PASS（3 passed） |
| `venv/bin/python -m pytest tests/test_student_coordinator.py tests/test_student_agent.py tests/test_student_spool.py tests/test_student_transport.py tests/test_platform_imports.py tests/test_public_auth.py tests/test_e2e_reverse_message.py tests/test_message_service.py -q` | PASS（92 passed, 1 warning） |
| `venv/bin/python -m pytest -q` | PASS（412 passed, 1 warning in 19.11s） |
| `git diff --check` | PASS |

## Task 9 — 2026-07-10 · WorkBuddyData 与 macOS 客户端边界

阶段：Phase 3。新增学生机平台层 `copilot.student_platform`；共享 Student Core 未导入
WorkBuddy、PyObjC 或任何平台 UI。适配器仅接受调用方显式传入的 `config_dir`，不会猜测
Windows 路径或宣称 Windows 已支持。

### 测试方案与见红

先新增脱敏 manifest 驱动的真实 SQLite + JSONL fixture。JSONL 文件名和目录均故意不使用
cwd 编码，必须以内容中的 `session_id` 建索引；数据库缺表不能伪装成空会话成功。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py tests/test_wb_sync.py tests/test_wb_upload.py -q` | 收集失败：`ModuleNotFoundError: copilot.student_platform`，证明统一适配器不存在时目标 lane 会红。 |
| 同命令（加入兼容包装负控后） | 2 failed：旧 `wb_sync` 直接泄漏 SQLite `OperationalError`，旧 `wb_upload` 不接受 `db_path`，只能猜 cwd 编码。 |
| `venv/bin/python -m pytest tests/test_wb_upload.py::test_filter_jsonl_keeps_legacy_user_home_expansion -q` | 1 failed：抽取后的 JSONL 过滤器没有保持旧 CLI 的 `~` 展开。 |
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py -q` | 收集失败：`StudentCoordinatorCommandCallback` 不存在，证明浮标尚无可测的 Core 命令交接点。 |
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py::test_probe_classifies_corrupt_database_instead_of_temporary_empty_state -q`（将 `corrupt` 故意改为 `temporarily_unavailable`） | 1 failed：明确命中错误分类，恢复实现后通过。 |
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py -q`（规格复审补充缺列 schema） | 1 failed：仅验证表名时，`sessions` 缺 `custom_title` 等字段仍错误报告 ready。 |

### 实现与验证

- `WorkBuddyDataAdapter` 以只读 SQLite URI 检查 `sessions`/`workspaces` schema，提供标准化
  session、probe、JSONL transcript 与 active-session 结果。失败明确区分
  `not_installed`、`schema_mismatch`、`busy`、`permission_denied`、`corrupt`、
  `temporarily_unavailable`；probe 同时验证每张表的必需列，避免稍后查询才暴露 schema 假绿。
  没有可靠 active 信号时固定返回 `unknown_active_session`，不把最新 activity 猜成当前会话。
- transcript 索引仅接受 JSONL 内已验证的 `session_id`/`sessionId`，不依赖 cwd 或精确文件名
  猜测。公开 helper 在没有 DB 上下文时仍保留历史 CLI 路径计算兼容；正常 upload 使用验证映射。
- `wb_sync`/`wb_upload` 保留现有公开 API 和 CLI 参数，读会话、工作区和 JSONL 过滤都委托平台层。
- macOS 仅新增可注入的 `StudentCoordinatorCommandCallback`。`floating_native` 优先调用它处理
  非 UI mentor command；未注入或回调拒绝时维持既有 PyObjC/NSPanel 和上传线程路径，不重写 UI。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py tests/test_wb_sync.py tests/test_wb_upload.py tests/test_floating_native_phase3.py tests/test_platform_imports.py -q` | PASS（57 passed） |
| `venv/bin/python -m pytest -q` | PASS（433 passed, 1 warning in 19.72s） |
| `git diff --check` | PASS |

负控涵盖：移除平台包会造成 adapter lane 收集失败；缺表不会返回空成功；恢复 cwd 目录猜测会让
opaque JSONL fixture 找不到 transcript；把 active session 退化为最新记录会破坏 typed unknown
契约；删掉 coordinator callback 会让浮标交接测试收集失败。Windows W0/W1 仍无真机证据，本任务
没有声称 Windows WorkBuddy adapter 可 rollout。

### Task 9 质量审查闭环 — 2026-07-10

独立质量审查发现 probe 的权限路径可泄漏异常，transcript 扫描可跟随 symlink 或依赖 rglob 顺序，
同名错误 JSONL 会抢占正确 metadata，且一次 upload 会为每个 session 重建无界扫描；异步
Coordinator callback 也会把最终 false 误报成已处理。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py tests/test_floating_native_phase3.py -q` | 7 failed, 26 passed：依次命中 raw `PermissionError`、外部 file symlink、错误 exact filename、重复 metadata、无候选上限、async false 假处理和缺少结果桥接。 |
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py::test_malformed_jsonl_makes_transcript_index_typed_incomplete -q`（将坏 JSON 分支故意改为 continue） | 1 failed：坏 JSON 被静默跳过后会错误读取其它 transcript；恢复 typed incomplete 后通过。 |

修复：

- probe 将 config/db 的 `stat` 放入 typed guard；POSIX `chmod(0)` 真权限 breaker 只有在当前
  账户确实不受权限位约束时 skip，否则必须返回 `permission_denied`。
- transcript 在每个 adapter 生命周期内建立一次有界 metadata index（512 candidates/8 MiB），
  以 JSONL 内唯一 session_id 映射；候选/字节超限、无效 UTF-8、坏 JSON、冲突 metadata 均返回
  `transcript_index_incomplete`，重复匹配返回 `transcript_ambiguous`。
- projects root、目录和文件均拒绝 symlink；metadata 与全文读取使用 `O_NOFOLLOW` descriptor、
  `fstat`/path inode 比对和读取后复核，避免 TOCTOU 读到目录外内容。
- `wb_upload` 每次 operation 只构造一个显式 adapter 并复用该 index，不再在每个 session 做
  rglob；原有测试 fixture 也改为写入真实 session metadata。
- `StudentCoordinatorCommandCallback.__call__` 只接受同步已知 true；`submit()` 对 async outcome
  运行结果桥接，false/异常才调用 legacy fallback，避免吞掉命令。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py tests/test_floating_native_phase3.py tests/test_wb_upload.py tests/test_wb_sync.py -q` | PASS（53 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_workbuddy_adapter.py tests/test_wb_sync.py tests/test_wb_upload.py tests/test_floating_native_phase3.py -q` | PASS（66 passed） |
| `venv/bin/python -m pytest -q` | PASS（442 passed, 1 warning in 19.85s） |
| `git diff --check` | PASS |

坏 JSON 行在 adapter index 中按不确定状态处理（不静默跳过）；JSONL 过滤函数本身仍保持旧 CLI 的
容错行为。Windows W0/W1 没有新增证据，仍不可 rollout。

### Task 9 最终质量复审：父目录 TOCTOU — 2026-07-10

复审发现先检查父目录、仅对最后一个 JSONL 文件使用 `O_NOFOLLOW` 仍不够：检查之后可把父目录
替换成指向外部真实目录的 symlink；末端文件本身不是 symlink，旧实现会在事后 path 检查前读取
外部内容。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py::test_transcript_read_keeps_open_parent_descriptor_when_path_parent_is_swapped -q` | FAIL：`secret_was_read == [True]`，证明外部 transcript 字节已被读取。 |

修复为从已打开的非 symlink projects root descriptor 开始，使用 `dir_fd` +
`O_DIRECTORY|O_NOFOLLOW` 逐级打开父目录，最后以 `O_NOFOLLOW` 打开常规文件并以 fstat inode
验证；索引时已读取的数据在 8 MiB 总预算内随 candidate 缓存，随后不重开可变 pathname。root
在 `_projects_root()` 以 lstat 捕获预期 dev/inode，实际 root fd 必须匹配；root 被换成外部真实目录
也返回 `transcript_index_incomplete`。缺少 descriptor 功能时明确失败关闭，不回退 `Path.open`。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_workbuddy_adapter.py tests/test_wb_sync.py tests/test_wb_upload.py tests/test_floating_native_phase3.py -q` | PASS（68 passed） |
| `venv/bin/python -m pytest -q` | PASS（444 passed, 1 warning in 19.67s） |
| `git diff --check` | PASS |

两个 POSIX breaker 分别覆盖子目录替换和 projects root 快照后替换；两者均断言没有读取外部 secret。
Windows W0/W1 仍未获得实机证据，未声明 rollout。

### Task 9 安全复审：禁止 transcript path capability — 2026-07-10

复审指出 descriptor scan 虽在当次读取中安全，若把随后可变的 `TranscriptReadResult.path` 或
adapter-derived path 交给调用者，调用者仍可在 root/parent 被替换后重新打开它，绕过已验证内容。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_workbuddy_adapter.py tests/test_wb_upload.py -q` | 5 failed：成功 transcript 和带 DB 的兼容 helper 仍暴露可重开的本地 `Path`。 |

修复为成功的 `TranscriptReadResult` 只包含已在 descriptor scan 中验证并缓存的 content，`path`
固定为 `None`；adapter 的旧 path 方法也不再导出已验证路径。`wb_upload.upload_conversations()`
继续直接消费缓存内容；`transcript_path_for_session(db_path=...)` 返回 `None`，只有无 DB 上下文的
历史 CLI helper 保留未验证的路径计算。新增 index 后替换 projects root 的回归，断言后续读取仍为
缓存安全内容且不提供路径能力。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_workbuddy_adapter.py tests/test_wb_sync.py tests/test_wb_upload.py tests/test_floating_native_phase3.py -q` | PASS（69 passed） |
| `venv/bin/python -m pytest -q` | PASS（445 passed, 1 warning in 19.84s） |
| `git diff --check` | PASS |

正常 adapter/upload 路径现在没有可重开的 transcript 本地路径；Windows W0/W1 仍无 rollout 证据。

## Task 10 — 2026-07-10 · Windows W0 探测、适配框架与安装契约

阶段：Phase 3。此项只交付 Windows 的“发现并阻断”框架，绝不把静态调研或
macOS 结果冒充为 Windows WorkBuddy 实机支持。

### 测试先行与见红

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_windows_adapter.py tests/test_windows_install_contract.py -q` | 收集失败：`ModuleNotFoundError: copilot.student_platform.windows`，证明 W0 adapter 和 PowerShell 产物缺失时该 lane 不能假绿。 |
| `venv/bin/python -m pytest tests/test_windows_install_contract.py::test_windows_probe_is_read_only_and_outputs_only_redacted_metadata -q` | FAIL：探测报告缺少 `cwd_redacted`，不能把 projects 目录名与脱敏工作目录映射证据关联起来。 |
| `venv/bin/python -m pytest tests/test_windows_adapter.py::test_missing_real_machine_manifest_is_explicitly_blocked -q` | FAIL：结果缺少可记录的 `BLOCKED: real-machine evidence missing` verdict；补齐 typed outcome 后恢复。 |

### 实现与验证

- `WindowsWorkBuddyProbe` 只认可显式 `WORKBUDDY_CONFIG_DIR`、已存在的
  `%USERPROFILE%\\.workbuddy` 和 `%ProgramData%\\WorkBuddy\\users\\*\\.workbuddy`；它不猜
  安装目录、`encode_cwd`、当前会话或 Hook 内可执行的 Python 命令。
- 缺 `tests/fixtures/workbuddy/windows/manifest.json` 时返回 typed
  `BLOCKED: real-machine evidence missing`。即使未来 W0 manifest 完整，结果也明确
  `rollout_ready=False`，W1 与真实安装/Hook/锁验证仍是发布前置条件。
- `probe_windows_workbuddy.ps1` 只输出经脱敏的版本/安装登记、候选根元数据、settings 顶层
  key 与 hook 类型、DB schema、JSONL 的字段/type/cwd 形状、命令发现与登录启动线索；不输出
  settings 值、转录正文、token 或 cookie，也没有写盘/联网命令。
- `install_windows.ps1` 仅接受显式 `ProjectRoot`、已确认 `ConfigDir`、`StudentId`、`BaseUrl`
  和已由 W0 真机验证的 `GitBashHookCommand`。它创建独立 `.venv-win`、同目录临时文件后原子
  备份 settings，并对每个 Python 子进程的非零退出立即失败，再用显式环境变量注册 hook 并启动无头
  Agent；不拼装未知 Git Bash/Python/WorkBuddy 路径。`register_hook.py` 因此支持显式 config root
  和经验证的 hook command；未设置 `WORKBUDDY_CONFIG_DIR` 时仍严格保留 macOS 的
  `Path.home() / '.workbuddy' / 'settings.json'` 默认行为。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_windows_adapter.py tests/test_windows_install_contract.py tests/test_platform_imports.py tests/test_deploy_config.py tests/test_workbuddy_adapter.py tests/test_wb_sync.py tests/test_wb_upload.py tests/test_floating_native_phase3.py -q` | PASS（86 passed） |
| `venv/bin/python -m pytest -q` | PASS（456 passed, 1 warning in 19.14s） |
| `git diff --check` | PASS |

本开发机没有 Windows WorkBuddy 实机，也没有可用的 PowerShell runtime，因此没有执行 W0
脚本或安装器。Windows 发布状态保持 **BLOCKED: real-machine evidence missing**；后续只能在
真实 Windows 机器运行 `powershell -ExecutionPolicy Bypass -File .\\probe_windows_workbuddy.ps1`，
审查脱敏输出并落 manifest 后，才能进入 W1。

### Task 10 复审修复：Windows 发现边界与脱敏 cwd — 2026-07-11

复审要求补齐三项保守性约束：环境变量大小写兼容、只枚举现存的
`SystemDrive/WorkBuddy-env/*/.workbuddy` 候选根，以及完整 W0 manifest 不能掩盖显式配置目录
缺失。PowerShell probe 同时改为只报告 cwd 形状（路径种类、分隔符、段数、是否含空白），不再
报告可关联的 cwd 脱敏文本。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_windows_install_contract.py::test_windows_probe_is_read_only_and_outputs_only_redacted_metadata -q` | FAIL：脚本缺少 `SystemDrive` 存在性保护；空变量会被无条件传给路径拼接，不能证明不会从当前目录派生候选路径。 |

修复只在 `$env:SystemDrive` 非空时才构造 `WorkBuddy-env` 路径；没有环境变量时不会把 cwd 当作
候选根。Python probe 同样只从已有目录枚举，并在 W0 manifest 完整但显式 config 不存在时返回
`blocked`。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_windows_install_contract.py::test_windows_probe_is_read_only_and_outputs_only_redacted_metadata -q` | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_windows_adapter.py tests/test_windows_install_contract.py tests/test_platform_imports.py -q` | PASS（26 passed） |

本机仍无 Windows PowerShell/WorkBuddy 实机，未执行脚本；W0/W1 发布状态继续为
**BLOCKED: real-machine evidence missing**。

### Task 10 最终复审修复：规范化 W0 阻断 verdict — 2026-07-11

权威测试方案把缺失实机证据的可见输出锁定为
`BLOCKED: real-machine evidence missing`；此前 typed `status` 正确为小写 `blocked`，但
`verdict` 直接拼接该内部状态，导致对外文本与发布门不一致。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_windows_adapter.py::test_missing_real_machine_manifest_is_explicitly_blocked -q` | FAIL：实际为 `blocked: real-machine evidence missing`，与锁定的 `BLOCKED:` 前缀不符。 |

保留 typed `status` 的小写值以维持程序状态机契约，仅在对外 `verdict` 上规范化为大写状态。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/test_windows_adapter.py::test_missing_real_machine_manifest_is_explicitly_blocked -q` | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_windows_adapter.py tests/test_windows_install_contract.py tests/test_platform_imports.py -q` | PASS（26 passed） |

Windows W0/W1 仍是 **BLOCKED: real-machine evidence missing**；该变更没有把静态合同测试
冒充为实机证据。

## Task 11 — 2026-07-11 · 真 Hook → Student Agent → Server → Mentor UI E2E

阶段：Phase 4。新增 `tests/e2e/test_student_agent_system.py`，每例都使用独立临时
HOME/USERPROFILE/APPDATA、SQLite、spool、预绑定 loopback 随机端口和浏览器 context；不使用
FastAPI TestClient、路由 mock、伪 WS 或伪 StudentAgent。唯一替身是确定性 LLM 输出。

### 测试先行与见红

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/e2e/test_student_agent_system.py -q`（临时 HOME 尚未保留已安装浏览器 runtime） | 3 failed：Chromium 被错误地解析到临时 HOME 的空 Playwright cache，关键 browser lane 明确失败，没有 skip。将已安装 runtime 的绝对 cache 根显式传给测试，同时保留所有学生应用 HOME 隔离。 |
| `venv/bin/python -m pytest tests/e2e/test_mentor_ui.py tests/e2e/test_student_agent_system.py::test_hook_agent_server_browser_round_trip -q`（原导师 UI browser fixture 为 session scope） | 1 failed：第二套同步 Playwright 进入前一套仍在运行的 asyncio loop。根因是测试夹具生命周期，不是服务器/Agent 伪通过；将旧 fixture 收窄为 module scope，避免两套真实 Chromium runtime 重叠。 |
| `PLAYWRIGHT_BROWSERS_PATH=$(mktemp -d) venv/bin/python -m pytest tests/e2e/test_student_agent_system.py::test_hook_agent_server_browser_round_trip -q` | 1 failed，`BrowserType.launch` 明确找不到 Chromium；验证 `critical` E2E lane 缺浏览器时会失败而非 skip。临时目录随后删除。 |

### 实现与验证

- `test_hook_agent_server_browser_round_trip`：真 hook 子进程写 spool，真常驻 Agent 通过 HTTP
  投递到真 uvicorn/SQLite，后台真 AnalysisService 发布事件；真实导师浏览器从同一服务读取并显示
  确定性诊断和 AI 摘要。
- `test_offline_spool_recovers_after_server_and_agent_restart`：服务停止时 hook 事件保留在本地；以
  新随机端口启动服务、重启 Agent 后才清空 spool，并在导师 DOM 验证精确 prompt。
- `test_mentor_message_reaches_real_agent_and_browser_receives_delivery_receipt`：导师 DOM 发消息，
  服务经真实持久 WS 定向 StudentAgent；Agent 用真实 REST receipt 回执，导师浏览器经真实 mentor WS
  显示“✓ 已送达”。
- 新 E2E runtime 在结束前取消并等待全部 websocket keepalive 任务，避免 test teardown 留后台 task。

| GREEN | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/e2e/test_student_agent_system.py -q` | PASS（3 passed，0 skip；仅 uvicorn/websockets 上游弃用 warning） |
| `venv/bin/python -m pytest tests/e2e -q` | PASS（28 passed，0 skip；同上游 warning） |
| `venv/bin/python -m pytest tests/test_student_agent.py tests/test_student_coordinator.py tests/test_student_spool.py tests/test_student_transport.py tests/test_hook.py -q` | PASS（87 passed） |
| `git diff --check` | PASS |

### Task 11 复审修复：真实 REST 回执才可标记送达 — 2026-07-11

复审发现 `WSRegistry._route_mentor_message()` 把 server→student socket 写入成功直接视为学员
送达：它会调用 `store.mark_message_delivered()`，并立即向导师 WS 广播 `message_delivered`。这样即使
StudentAgent 随后的 `StudentTransport.ack_message()` 失败，导师 DOM 和数据库仍会假绿。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_connections.py::test_mentor_message_targets_one_student_without_claiming_delivery_before_receipt tests/test_message_service.py::test_send_persists_before_live_push_and_waits_for_student_rest_receipt tests/test_e2e_reverse_message.py::test_online_send_targets_one_float_but_waits_for_student_receipt tests/e2e/test_student_agent_system.py::test_failed_student_transport_receipt_never_marks_message_delivered -q` | 4 failed：在线 socket 写入后已有 `message_delivered`、`delivered_at` 和导师 DOM“✓ 已送达”；最后一例的真实 StudentTransport 收到 loopback 503 后日志为 `TemporaryNetworkError`，但仍被旧 WSRegistry 提前标绿。 |

修复为 WSRegistry 只定向发送 `mentor_message`，不再接受/持有 delivered callback，不再写
`delivered_at` 或广播 receipt。唯一状态转换点为 `MessageService.ack()`：StudentAgent 的真实
`POST /api/student/messages/ack` 成功后，它才持久化并发布 `message_delivered`。导师前端继续兼容
即时真实 ack 返回和 WS receipt，并明确普通 socket 写入保持“发送中”。

负向 E2E 没有替换 StudentTransport/Agent/WSRegistry/Service：维持真实 student WS，在收到消息
后仅把该 Transport 的 REST base URL 指向真实 loopback 503 端点。测试等待该端点实际收到 POST，再断言
`delivered_at IS NULL`、DOM 包含“发送中…”且没有“✓ 已送达”。

| GREEN | 判定 |
|---|---|
| 同一条定向命令 + 正常真实 Agent receipt E2E | PASS（5 passed；负向 503 不送达、正向 REST ack 送达） |
| `venv/bin/python -m pytest tests/test_connections.py tests/test_message_service.py tests/test_e2e_reverse_message.py tests/test_public_auth.py tests/test_sessions_sync_api.py tests/test_transcript_upload_api.py tests/test_upload_requests.py tests/e2e/test_student_agent_system.py tests/e2e/test_mentor_ui.py -q` | PASS（80 passed） |
| `venv/bin/python -m pytest -q` | PASS（462 passed，13 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 最终复审修复：503 回执后的补拉与幂等恢复 — 2026-07-11

上一轮已经禁止 WS 写入直接标记送达，但仅保留 pending 不足：收到 `503` 后没有新的 WS frame 时，
headless Agent 不会再次 REST ack；而 macOS 浮标已经把 message_id 记为 seen，重复消息又会直接返回，
导致已渲染消息永远无法确认送达。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_transport.py::test_get_pending_messages_uses_authenticated_student_backlog_contract tests/test_student_coordinator.py::test_failed_receipt_retries_backlog_without_rendering_duplicate tests/test_student_agent.py::test_agent_one_cycle_pulls_pending_receipts_without_waiting_for_new_ws_frame tests/test_floating_native_phase3.py::test_duplicate_rendered_mentor_message_retries_ack_without_rendering_again tests/e2e/test_student_agent_system.py::test_failed_student_transport_receipt_recovers_from_real_backlog_without_false_delivery -q` | 5 failed：缺 GET backlog 合同、协调器没有 pull/渲染与 ack 分离、Agent safe cycle 不拉取、浮标重复 id 不重试 ack；真实 503 后恢复真实 server 仍在 5 秒内超时，证明 pending 会永久滞留。 |
| `venv/bin/python -m pytest tests/test_student_agent.py::test_agent_pulls_pending_receipts_immediately_after_websocket_connect -q`（临时移除 WS connect 后的 pull） | 1 failed：等待 connect 后的 backlog pull 超时；恢复调用后该负控转绿。 |

修复内容：

- `StudentTransport.get_pending_messages()` 以 student token 调用真实
  `GET /api/student/messages?student_id=...&since=0&limit=64`，服务端 SQLite 也以 LIMIT 截断，
  只返回 mapping items，不记录 token。
- `StudentCoordinator` 区分 `rendered_message_ids` 与 ack-confirmed 的 `seen_message_ids`：handler
  成功后先记 rendered；ack 失败保留 rendered 以供重复/backlog 只重试 REST ack；handler 自身失败
  不记 rendered，下一次仍会重渲染。每次 pull 最多处理 64 条，异常仅记录类型并在下轮重试。
- `StudentAgent` 在每个安全循环、以及持久 WS 建连后立即执行 bounded pull；拉取/ack 异常不杀死
  spool 或 WS loop。
- macOS `floating_native` 对已 seen 的 mentor message 只重新调用 `_ack_mentor_message`，不重复渲染。

系统 E2E 使用真实 Agent/WS/SQLite/浏览器：先把 Agent 的 REST base URL 指向真实 loopback 503
端点，确认 DB/DOM 均 pending；恢复真实 service URL 后等待 Agent 自动补拉，最终 DB `delivered_at`
落库、导师 DOM 显示“✓ 已送达”。同一 E2E 注入的真实 platform handler 只记录一次渲染，证明恢复
没有重复 handler/render。

| GREEN | 判定 |
|---|---|
| 上述 5 条定向恢复测试 | PASS（5 passed） |
| `venv/bin/python -m pytest tests/test_student_agent.py::test_agent_pulls_pending_receipts_immediately_after_websocket_connect -q` | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/e2e/test_student_agent_system.py -q` | PASS（94 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_message_service.py tests/test_e2e_reverse_message.py tests/test_mentor_api.py tests/e2e/test_student_agent_system.py -q` | PASS（124 passed；含 SQLite LIMIT 合同） |
| `venv/bin/python -m pytest -q` | PASS（468 passed，13 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 P1/P2 最终修复：独立回执 backlog 与跨重启 ledger — 2026-07-12

复审继续收紧两点：通用 `/api/student/messages?since=` 会返回已送达历史，不能作为 receipt
恢复真相；此前 Core 的 `rendered_message_ids` 只在内存，Agent 重启后会再次调用平台 handler。
浮标虽持久化 seen id，却只补拉 `since=last_seen`，因此 failed ack 的旧 id 不会在 reconnect 后重试。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_student_transport.py::test_get_pending_messages_uses_authenticated_student_backlog_contract tests/test_student_spool.py::test_receipt_ledger_persists_rendered_and_acked_state_across_spool_restart tests/test_student_coordinator.py::test_receipt_ledger_skips_handler_after_agent_restart_and_retries_only_ack tests/test_e2e_reverse_message.py::test_pending_receipt_endpoint_omits_64_delivered_messages_and_returns_one_pending tests/test_floating_native_phase3.py::test_pending_receipt_catchup_retries_503_then_recovers_without_duplicate_render tests/e2e/test_student_agent_system.py::test_failed_student_transport_receipt_recovers_from_real_backlog_without_false_delivery -q` | 6 failed：新 endpoint 为 404、transport 仍打通用 catchup、没有 spool ledger、Coordinator/Agent 重启后确有第二次 handler/render、floating 没有 pending receipt fetch。64 delivered + 1 pending 的 breaker 也证明旧接口不可区分。 |

修复：

- 新增严格 student-token 的 `GET /api/student/messages/pending-receipts`；`Store` 使用
  `delivered_at IS NULL ORDER BY id ASC LIMIT ?`，`MessageService` 与 transport 均把上限约束为 64。
  64 条已送达加 1 条未确认的 API breaker 仅返回并 ack 最后一条。
- `EventSpool` 新增同目录、拒绝 symlink 的 `.copilot-receipts.sqlite3`。其原子 SQLite 状态为
  `(student_id,message_id) -> rendered|acked`；Coordinator 可显式注入，默认由 spool 提供。
  handler 成功后先持久化 rendered，REST ack 成功后持久化 acked。新 Coordinator 进程加载 rendered
  时只重试 ack，加载 acked 时不再处理；handler 本身失败则不写 rendered，仍可完整重试。
- macOS reconnect 现在额外调用 pending-receipts：只对已持久化 seen 的 id 重新 POST ack，绝不重建
  卡片。503→恢复的 contract 断言两次 ack、零次 render。
- 真系统 E2E 在 503 后停止并重启 Agent；新的 Agent 仅从 ledger/独立 backlog ack，最终 DB 与导师
  DOM 送达，测试 platform handler 计数保持 1。

| GREEN | 判定 |
|---|---|
| 上述 6 条 P1/P2 定向测试 | PASS（6 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/test_message_service.py tests/test_mentor_api.py tests/e2e -q` | PASS（176 passed） |
| `venv/bin/python -m pytest -q` | PASS（472 passed，14 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 P1 浮标回执饥饿修复：持久 pending 集合与分页恢复 — 2026-07-12

独立 pending-receipts endpoint 修复后，浮标仍把“曾显示”当作回执恢复凭据，并把它持久化为最多
200 条。这会让第 201 条及更早的 failed receipt 在重启后被遗忘；同时 endpoint 单页至多 64 条，
一次 fetch 只处理首屏会让更后的回执无法前进。另一个边界是已成功确认的 duplicate 仍会多发一次 ack。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py -k 'mentor_message_acks_only_after_render or duplicate_acknowledged_mentor_message or duplicate_pending_mentor_message or pending_receipt_catchup_retries or mentor_message_state_persists or persisted_pending_receipts_survive or pending_receipt_recovery_pages' -q` | 6 failed / 1 passed：render 后没有独立 pending 状态；state 不保存/读取 pending；已确认 duplicate 仍 POST；503 成功后不清 pending；201 条 failed receipt 重启后旧 ID 丢失；首个 64 条之外不会补 ack。 |
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py::test_ack_does_not_post_unknown_unrendered_message -q` | 1 failed：直接调用 ack 仍会 POST 一个不在已渲染 pending 集合中的未知 ID。 |

修复：

- 初始化、读取和保存状态均维护独立的 `pending_receipt_message_ids`；它是已成功渲染、尚未收到
  REST ack 成功的唯一恢复记录，保存时从不按 200 条截断。显示去重则改为有序、最多 200 条的
  `seen_message_ids`，不再承担回执可靠性职责。
- 渲染成功后先将 ID 放入 pending 并保存，再发 ack；ack 成功才移除 pending 并再次保存。已确认
  duplicate 不再写网络；pending duplicate（包括已从 seen 淘汰的旧 ID）只重试 ack，绝不重建卡片。
- pending endpoint 每页 64 条，浮标在一次 reconnect 内最多连续请求 8 页；只有本地持久 pending
  命中的 ID 才会 ack，成功移除后继续下一页。无法处理的未知/失败首屏不会被越权确认，留待下一轮。
- 增加 201 条 render+503 后重启，仅返回最老（已淘汰 seen）的 ID 仍 ack 且零 render 的 breaker；
  以及 201 条 >64 分页回收、unknown direct ack 防线和成功清理 pending 的 contract。

| GREEN | 判定 |
|---|---|
| 上述浮标定向测试 | PASS（8 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/e2e/test_student_agent_system.py -q` | PASS（47 passed；含跨平台导入门禁、反向 API、真实 Agent/WS/SQLite/浏览器系统链路） |
| `venv/bin/python -m pytest -q` | PASS（476 passed，14 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 P1/P2 收口：cursor、稳定连接续跑与原子浮标状态 — 2026-07-12

独立复审确认上一轮仍有三个恢复根因：pending endpoint 只有无 cursor 的最老 64 条，未渲染旧消息会
遮蔽第 65 条本机已渲染回执；一次同步最多 8 页而稳定 WS 无后续调度；浮标主线程与 WS 线程会并发
read-modify-write 普通 JSON，从而丢失 pending 状态或重复 POST。还补充了两个网络边界：服务端已完成
ack 但响应丢失时 endpoint 不再返回该 id，以及稳定 WS 中新发生的 ack 失败不能只等下一次重连。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_e2e_reverse_message.py::test_pending_receipt_endpoint_uses_cursor_to_page_past_unknown_messages tests/test_floating_native_phase3.py::test_pending_receipt_cursor_scans_past_unknown_first_page_without_rendering tests/test_floating_native_phase3.py::test_pending_receipt_retry_continues_past_single_sync_budget_without_busy_loop tests/test_floating_native_phase3.py::test_state_replace_failure_keeps_last_complete_pending_receipt_ledger tests/test_floating_native_phase3.py::test_parallel_duplicate_receipt_retry_posts_once_and_persists_empty_pending -q` | 5 failed：route/Store 忽略 `after_id`；64 unknown 遮蔽 known；没有 513+ 受控续跑；`os.replace` 失败仍覆盖旧 JSON；两个线程会 POST 同一回执。 |
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py::test_empty_cursor_scan_retries_persisted_receipt_after_lost_ack_response tests/test_floating_native_phase3.py::test_failed_stable_ws_ack_wakes_the_single_throttled_retry_task -q` | 2 failed：空的完整 cursor scan 不会重试本地 rendered pending；稳定 WS 的失败 ack 不会通过 loop 线程安全唤醒重试。 |
| `venv/bin/python -m pytest tests/test_student_transport.py::test_get_pending_messages_uses_authenticated_student_backlog_contract tests/test_student_coordinator.py::test_pending_receipt_cursor_reaches_later_rendered_message_after_failed_first_page -q` | 2 failed：跨平台 Transport 缺 `after_id`，Coordinator 被 64 个 handler-failed 项阻塞。 |
| `venv/bin/python -m pytest tests/test_student_coordinator.py::test_empty_pending_page_retries_durable_rendered_receipt_after_lost_ack_response tests/test_floating_native_phase3.py::test_parallel_live_message_render_is_claimed_once_before_pending_is_persisted -q` | 2 failed：Core 空页不重试 SQLite `rendered` receipt；浮标渲染前窗口可重复建卡。 |

修复：

- pending-receipts 从 Store/Service/route/StudentTransport 到两个客户端统一支持认证后的 `after_id`
  cursor，仍严格使用 `delivered_at IS NULL`、升序 SQL `LIMIT 64`。Core 每次最多 8 页，失败首页仍会
  前进到后续可处理项；完整空页时只对本地 SQLite ledger 中 `rendered` 的最多 64 条做幂等 ack。
- 浮标的 cursor 为 transient；每次最多 8 页，未完成则由同一 WS event loop 的唯一 task 在 2 秒固定
  间隔后从 cursor 续跑，避免 busy-loop 和稳定连接下的第 513 条饥饿。完整 scan 仍未见到的本地 pending
  会取有界快照直接幂等 ack，覆盖“服务端成功但响应丢失”；未知/未渲染 ID 从不确认。
- 浮标状态使用 stdlib `threading.RLock` 保护主线程/WS 线程的 read-modify-write；保存改为同目录临时
  文件、flush+fsync、`os.replace` 原子发布。rendering 与 ack 各有内存 in-flight claim；网络请求在锁外，
  成功 ack 才在锁内移除 pending 并保存。稳定 WS 内失败 ack 通过 `call_soon_threadsafe` 唤醒唯一节流任务。

| GREEN | 判定 |
|---|---|
| 上述 cursor/续跑/原子状态/并发/丢响应/Core 定向用例 | PASS（12 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/test_message_service.py tests/test_mentor_api.py tests/e2e/test_student_agent_system.py -q` | PASS（171 passed） |
| `venv/bin/python -m pytest -q` | PASS（492 passed，14 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 最终 gate 修复：连续浮标 state 发布失败的同进程恢复 — 2026-07-12

第三次只读 gate 发现：连续两次原子 state publish 均失败时，若仅丢弃 pending，会造成内存 `seen/last_seen`
已推进而没有可重试记录；同进程磁盘恢复后 catchup 与 pending recovery 都会错过该消息，导师端将永久
“发送中”。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py::test_permanent_state_publish_failure_keeps_in_memory_render_recoverable_without_rerender -q` | FAIL：首次两次 replace 失败后 `last_seen=1`、pending 为空；磁盘恢复后的 fetch 既不保存也不 ack。 |

修复：

- render 成功后先进入仅内存的 `unpersisted_rendered_message_ids`。提交 pending+seen+last_seen 的原子状态
  成功前不推进任何 catchup 条件，也不发送 ack；两次保存均失败时回滚这些状态但保留该队列。
- 现有唯一、节流的 retry task 把这类未持久消息也视为待恢复：磁盘恢复后先持久化，再 REST ack；live
  replay 同样只触发持久化/ack，不会再建卡。

| GREEN | 判定 |
|---|---|
| 上述连续失败→恢复→零重复 render 用例 | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/test_message_service.py tests/test_mentor_api.py tests/e2e/test_student_agent_system.py -q` | PASS（172 passed） |
| `venv/bin/python -m pytest -q` | PASS（493 passed，14 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 最终顺序 gate：未持久消息不能被后续 cursor 跨越 — 2026-07-12

对“未持久化渲染”恢复队列的独立复审发现顺序问题：m1 连续落盘失败后，m2 可以成功落盘并把持久
`last_seen_message_id` 写到 2。若此时崩溃，重启 catchup 从 2 开始，m1 又不在 pending ledger，导致
m1 永远未展示、未确认。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py::test_persisted_cursor_does_not_skip_earlier_unpersisted_render_after_restart -q` | FAIL：m1 的两次 replace 失败、m2 成功后 state cursor 为 2；重启后 m1 因 `id <= last_seen` 被跳过。 |

修复：

- 每次保存 JSON 时，持久 cursor 被钳制到最小未持久渲染 numeric id 的前一位；内存 cursor 可继续用于
  当前 UI，但重启后的 generic catchup 必定重新取得最早未持久的消息。m2 的 seen 状态仍可避免重复渲染，
  m1 则正常重新渲染并 ack。

| GREEN | 判定 |
|---|---|
| m1 失败、m2 成功、重启仍拉回 m1 的 breaker | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/test_message_service.py tests/test_mentor_api.py tests/e2e/test_student_agent_system.py -q` | PASS（173 passed） |
| `venv/bin/python -m pytest -q` | PASS（494 passed，14 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 终审收口：旧 replay、落盘失败与 Core 韧性 — 2026-07-12

二次终审发现剩余边界：浮标 `seen` 仅保留 200 条，已 ack 的旧 WS replay 会被当新卡片；首次原子
state publish 失败时旧代码仍继续 REST ack，若随后响应失败并崩溃则无 pending ledger；Core 的 spool
filesystem 异常可冒出 `one_cycle`；SQLite ack 状态无界增长；以及旧适配器兼容通过捕获任意
`TypeError`，会把 Transport 自身 bug 再调用一次。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_floating_native_phase3.py::test_old_acknowledged_ws_replay_after_seen_window_trim_does_not_render_or_ack tests/test_floating_native_phase3.py::test_first_state_publish_failure_retries_before_failed_ack_preserves_restart_dedup tests/test_student_agent.py::test_agent_one_cycle_keeps_running_after_spool_filesystem_failure tests/test_student_spool.py::test_receipt_ledger_bounds_acked_history_without_pruning_unacknowledged_rendered tests/test_student_coordinator.py::test_pending_transport_internal_type_error_is_not_retried_as_legacy_signature -q` | 4 failed / 1 假绿：旧 replay 重渲染；首次 replace 失败后重启重渲染；spool OSError 冒出；acked 行增长到 300。TypeError 用例初版未触发 fallback，修正为接受 optional cursor 后，临时恢复旧 `except TypeError` 行为也明确 RED（calls=2）。 |

修复：

- pending 之外的 WS message 若 `id <= last_seen_message_id`，即使已从 200 条 seen cache 淘汰也直接忽略；
  rendered/pending 的旧 ID 仍可只重试 receipt。
- `_save_mentor_message_state()` 现在返回 bool，并以新临时文件最多重试一次原子 publish。render 后必须先
  成功保存 pending 才会 ack；永久失败不发网络 receipt。ack 成功后的清理保存失败则把内存 pending 放回，
  让已落盘的旧 pending 继续在重启后幂等恢复。
- `StudentAgent.one_cycle()` 记录并吞掉 spool/filesystem `Exception`，仍执行 receipt recovery；receipt
  ledger 每 student 只保留最近 256 条 `acked`，从不删除 `rendered` 未确认行。
- Coordinator 以 `inspect.signature` 检测 `after_id` 能力；仅真正 legacy adapter 走无参分支，内部
  TypeError 只记录一次并等待下一轮。

| GREEN | 判定 |
|---|---|
| 上述终审 blocker + TypeError 临时负控恢复后 | PASS（5 passed；负控确实 calls=2 后恢复实现 calls=1） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/test_message_service.py tests/test_mentor_api.py tests/e2e/test_student_agent_system.py -q` | PASS（171 passed） |
| `venv/bin/python -m pytest -q` | PASS（492 passed，14 个既有/上游弃用 warning） |
| `git diff --check` | PASS |

### Task 11 终审修复：cursor 回退不得重放已确认导师消息 — 2026-07-12

终审发现浮标为恢复一次“已渲染但本地 state 未持久化”的早期消息时，会把持久
`last_seen_message_id` 回退。常规 `/api/student/messages?since=` 原先没有过滤
`delivered_at`；若重启后 cursor 回到 0，超过 200 条的已确认历史会绕过浮标有界的
`seen_message_ids` 并被再次渲染/ack。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_e2e_reverse_message.py::test_generic_catchup_omits_301_delivered_rows_after_recovery_cursor_rolls_back -q` | FAIL：1 条仍未确认的恢复消息 + 300 条已确认消息通过真实 FastAPI catchup 一并返回（301 条），证明 cursor 回退会重放已确认历史。 |

修复：`MessageService.get_catchup()` 改用 Store 的 `list_undelivered_messages()`；该查询保持
student-scoped cursor 与可选 limit，但严格要求 `delivered_at IS NULL`。已确认记录仍保留在
`mentor_messages` 供导师审计，不能再作为学员端展示恢复 backlog；早期未持久渲染消息则仍由
未确认的 generic/pending-receipts 路径恢复。

| GREEN | 判定 |
|---|---|
| 上述 301 条真实 FastAPI breaker + `tests/test_message_service.py tests/test_store_phase1.py` | PASS（22 passed） |
| `venv/bin/python -m pytest tests/test_platform_imports.py tests/test_student_spool.py tests/test_student_transport.py tests/test_student_coordinator.py tests/test_student_agent.py tests/test_floating_native_phase3.py tests/test_e2e_reverse_message.py tests/test_message_service.py tests/test_mentor_api.py tests/e2e/test_student_agent_system.py -q` | PASS（174 passed，14 个既有/上游弃用 warning） |
| `venv/bin/python -m pytest -q` | PASS（495 passed，14 个既有/上游弃用 warning） |
| P0-1~P0-8（P0-5 以 `COPILOT_WORKERS=2` 非零拒绝为预期） | PASS：server redline 6 passed、public auth 4 passed、deploy/config 11 passed；`git diff --check` PASS。 |

### 项目说明页：内部同步版 — 2026-07-13

产出：`docs/project-overview.html`，以非技术同事可读的方式说明项目背景、闭环、三块架构、数据边界、导师消息送达语义、当前状态和协作入口；同步保存设计说明到 `docs/superpowers/specs/2026-07-13-project-overview-design.md`。

| 验证项 | 判定 |
|---|---|
| `git diff --check` | PASS |
| 桌面浏览器预览（Playwright，完整页面截图） | PASS：页面完整渲染，架构图、消息送达链路、状态表和术语展开区域可见 |
| 移动浏览器预览（Playwright，iPhone 13，完整页面截图） | PASS：窄屏转为单列，无明显横向布局溢出 |
| 页面事实与 `README.md` / `docs/target-architecture.md` 对照 | PASS：`copilot.db` 唯一权威源、单 worker、Student Core、导师消息回执、Windows BLOCKED 状态保持一致 |

### 项目说明页：浅色简化版与界面占位 — 2026-07-13

根据内部同步场景反馈，页面做了内容和视觉收敛：技术细节默认折叠；整体改为浅色底并放大标题与正文；增加线性图标、数据流箭头、导师观察台截图和学员端受控演示占位。

| 验证项 | 判定 |
|---|---|
| `git diff --check` | PASS |
| 桌面 viewport 预览（Playwright） | PASS：浅色主题、放大排版、导师截图和学员端文本占位均正常渲染 |
| 移动 viewport 预览（Playwright，iPhone 13） | PASS：导航收敛、内容单列、文本占位可读 |
| 技术细节默认状态 | PASS：`details.tech-details` 默认收起，按需展开后保留原 04–06 内容 |
| 媒体资源 | PASS：项目内导师截图使用相对路径；学员端使用无图片的文本占位 |

### 项目说明页：紧凑排版与分主题技术展开 — 2026-07-13

根据同步阅读反馈，减少首屏和各章节留白；将 04–06 从一个总折叠区改为三个可见的摘要卡，分别展开模块分工、数据边界和消息送达详情；新增规模条形图与事件/反馈路线图。

| 验证项 | 判定 |
|---|---|
| `git diff --check` | PASS |
| 桌面完整页面预览（Playwright） | PASS：整体高度收敛，规模图、路线图、技术摘要卡可见 |
| 技术摘要卡默认状态 | PASS：三张摘要卡可见，详细内容未默认展开 |
| 移动端预览（Playwright，iPhone 13） | PASS：规模图和路线图转为单列，摘要卡保持可读 |

### 隐私清理验证 — 2026-07-13

- macOS adapter fixture 已替换为合成会话、相对 fixture 路径和中性 JSONL 内容；新增 guard 拒绝用户目录、手机号和邮箱模式。
- 学员端界面资产已移除，项目说明页改为受控演示环境的静态占位；旧工作流状态文件已删除并忽略整个工作流目录。

| 验证项 | 判定 |
|---|---|
| fixture 隐私 guard（`HEAD` 旧 manifest，仅内存读取） | RED：guard 拒绝遗留 fixture，未将旧内容写回工作区 |
| fixture 隐私 guard（当前 manifest） | PASS（1 passed） |
| adapter + 服务端红线回归 | PASS（25 passed） |
| `git diff --check` | PASS |

### Task 2：完整原文边界与共享分析并发门 — 2026-07-13

- `transcript_tail` 只作为 Stop 分析输入；`AnalysisService.accept_report()` 不再把未显式提供的 tail 回退写入 `raw_transcripts`。显式 `transcript_full` 与学员完整 transcript 上传仍按原文精确落库。
- Stop 与完整 transcript 上传后的批量 LLM 分析共用 `AnalysisService` 上的单个进程内 semaphore；并发上限由 `service.analysis_max_concurrency` 配置，默认值为 2，非法非正整数会在服务构建时拒绝。
- 独立 review 发现 pending Stop 重启时可能把稍后上传的完整原文误当成本次 tail；report 现在只为显式全文记录非路径 marker，tail-only 失败不进入重启恢复队列，也不会读取无关原文。
- 测试使用真临时 `Store` 与固定 fake LLM；没有 mock 被测 Service。首次直接运行因默认示例库展开到沙箱外用户目录而在收集阶段报只读数据库错误，随后按测试隔离规则将 `HOME` 调整到 `/tmp/workbuddy-copilot-test-home`，判定标准未变。

| 阶段 | 命令 | 判定 |
|---|---|---|
| RED | `HOME=/tmp/workbuddy-copilot-test-home <repo-root>/venv/bin/python -m pytest tests/test_analysis_service.py::test_stop_tail_is_analysis_input_not_raw_transcript tests/test_service_routing.py::test_normal_stop_uses_configured_bounded_concurrency tests/test_transcript_upload_api.py::test_stop_and_full_upload_share_configured_analysis_gate tests/test_config.py::TestLoadConfig::test_load_valid_config -q` | FAIL（4 failed）：tail 被误写 raw、缺少默认配置、两个 Stop 同时进入 LLM、Stop 与上传分析未共享门。 |
| GREEN | 同上 | PASS（4 passed，1 个既有 Starlette 弃用 warning）。 |
| Review RED | `HOME=<临时目录> <repo-root>/venv/bin/python -m pytest tests/test_service_routing.py::test_lifespan_tail_only_pending_report_ignores_later_full_upload -q` | FAIL（1 failed）：恢复分析实际读到 `later unrelated full upload`。 |
| Review GREEN | `HOME=<临时目录> <repo-root>/venv/bin/python -m pytest tests/test_service_routing.py -k lifespan -q` | PASS（4 passed，10 deselected，1 个既有 Starlette 弃用 warning）。 |
| 回归 | `HOME=<临时目录> <repo-root>/venv/bin/python -m pytest tests/test_analysis_service.py tests/test_service_routing.py tests/test_transcript_upload_api.py tests/test_config.py -q` | PASS（53 passed，1 个既有 Starlette 弃用 warning）。 |

### Task 2 独立 Review 二次整改：恢复边界、严格配置与 semaphore 作用域 — 2026-07-13

- 测试方案：真临时 `Store` + 固定 fake LLM，不 mock `AnalysisService`；tail-only 通过重开同一 SQLite 文件模拟进程重启；bulk 测试保留真实 SQLite commit，仅在真实调用入口观察 semaphore 状态。
- 命令调整：worktree 内不存在 `venv/bin/python`，首次命令退出 127；随后使用项目既有 venv `<repo-root>/venv/bin/python`。仅调整解释器路径，测试选择与判据未变。

| 阶段 | 命令 | 结果与判定 |
|---|---|---|
| RED | `HOME=/tmp/workbuddy-copilot-test-home <repo-root>/venv/bin/python -m pytest tests/test_service_routing.py::test_tail_only_stop_is_not_recoverable_after_restart tests/test_config.py::TestLoadConfig::test_analysis_max_concurrency_rejects_non_positive_integers tests/test_config.py::TestLoadConfig::test_analysis_max_concurrency_preserves_explicit_positive_integer tests/test_transcript_upload_api.py::test_bulk_analysis_gate_covers_only_llm_invocation tests/test_service_routing.py::test_normal_stop_uses_configured_bounded_concurrency tests/test_transcript_upload_api.py::test_stop_and_full_upload_share_configured_analysis_gate -q` | FAIL（8 failed, 3 passed）：tail-only report 仍为 pending；`True`/`False`/`1.0`/`1.5`/`0`/`-1` 均未在配置加载时拒绝；bulk DB commit 与事件发布时 semaphore 仍 locked。两条加强后的并发完成性断言通过。 |
| GREEN（聚焦） | 同上 | PASS（11 passed，1 个既有 Starlette 弃用 warning）。 |
| 首轮四文件回归 | `HOME=/tmp/workbuddy-copilot-test-home <repo-root>/venv/bin/python -m pytest tests/test_analysis_service.py tests/test_service_routing.py tests/test_transcript_upload_api.py tests/test_config.py -q` | FAIL（2 failed, 51 passed）：两条旧断言仍要求无 durable full transcript 的 Stop 可恢复，与新边界冲突；分别改为“显式全文失败保持 pending”和“tail-only 不借用后来全文恢复”。 |
| GREEN（四文件回归） | 同上 | PASS（53 passed，1 个既有 Starlette 弃用 warning）。 |
| 最终 Review RED | `HOME=<临时目录> <项目虚拟环境>/bin/python -m pytest tests/test_analysis_service.py::test_stop_analysis_gate_covers_only_llm_invocation -q` | FAIL（1 failed）：Stop prompt 配置准备与 LLM 调用均观察到 semaphore locked。 |
| 最终 Review GREEN | 同上 | PASS（1 passed）；配置准备观察到 unlocked，fake LLM 观察到 locked。 |
| 最终四文件回归 | `HOME=<临时目录> <项目虚拟环境>/bin/python -m pytest tests/test_analysis_service.py tests/test_service_routing.py tests/test_transcript_upload_api.py tests/test_config.py -q` | PASS（54 passed，1 个既有 Starlette 弃用 warning）；最终独立 re-review 无发现。 |
| Diff | `git diff --check` | PASS（无输出）。 |

### Task 3：真实 Uvicorn 多 worker 启动失败关闭 — 2026-07-13

- 保留既有 worker 环境变量检查与数据库 advisory lock；新增 Uvicorn CLI `--workers` 预检，直接多 worker 命令在 supervisor 导入应用时即非零失败。
- 若已识别的 Uvicorn multiprocessing child 仍发生 worker lock 冲突，只向其 parent supervisor 发送 `SIGTERM`；普通独立进程和无 Uvicorn CLI 特征的 multiprocessing parent 不会被信号影响。
- `start_service.sh` 拒绝三个 worker 环境变量中任何非空且不严格等于 `1` 的值，并显式固定 `--workers 1`。
- 真实进程测试使用临时 HOME、空闲 loopback 端口与独立进程组；supervisor 退出后继续探测 `/health` 0.5 秒，再对整个进程组执行 TERM/KILL 清理，防止孤儿 worker 造成假绿或泄漏。

| 阶段 | 命令 | 结果与判定 |
|---|---|---|
| 真实进程 RED（HEAD 隔离快照） | `git archive HEAD` 到临时目录，复制新增真实进程测试后执行 `HOME=<临时目录> <项目虚拟环境>/bin/python -m pytest <临时目录>/tests/test_single_worker_startup.py -q` | FAIL（1 failed）：一个 child 取得 `.worker.lock` 并返回 `/health` 200，另一个 child 因锁冲突退出；证明旧实现没有 fail closed。pytest 后清理脚本使用 zsh 保留名 `status`，另报 `read-only variable: status`，但 pytest 的功能性 FAIL 与进程日志完整、判定不受影响。 |
| parent supervisor 单测 RED | `<项目虚拟环境>/bin/python -m pytest tests/test_app_context.py -k 'lock_collision_signals_only or lock_collision_does_not_signal' -q` | FAIL（2 failed）：尚无 multiprocessing parent 识别与定向终止实现。 |
| parent supervisor 单测 GREEN | 同上 | PASS（2 passed，10 deselected，1 个既有 Starlette 弃用 warning）。 |
| 真实进程 GREEN | `<项目虚拟环境>/bin/python -m pytest tests/test_single_worker_startup.py -q` | PASS（1 passed）；未观察到 `/health`，supervisor 自然非零退出，退出后探测窗口仍无孤儿服务。 |
| 协调性重跑 | `HOME=<临时目录> <项目虚拟环境>/bin/python -m pytest tests/test_app_context.py tests/test_deploy_config.py tests/test_single_worker_startup.py -q` | 首次因独立 privacy worker 创建 worktree 的自动 stash 窗口暂时隐藏未跟踪测试文件而退出 4；`git stash pop` 恢复全部原有 diff 与该测试后，原命令 PASS（26 passed，1 个既有 Starlette 弃用 warning）。判据与业务代码未调整。 |
| 规格/质量检查 | 逐条检查 `copilot/app_context.py`、`start_service.sh` 与三份聚焦测试 | PASS：无缺项、无误伤普通 parent、无计划外依赖或架构变化；只读子代理超时后按用户要求中止，由主线程完成检查。 |
| 最终验证 | 临时 HOME 下重跑上述三文件；`bash -n start_service.sh`；P0-5 `COPILOT_WORKERS=2 ... assert_single_worker()`；`git diff --check`；确认 index diff 为空 | PASS：26 passed、1 个既有 warning；shell 语法通过；P0-5 按预期抛 `RuntimeError`；diff check 无输出；没有 staged 文件。 |

### Task 4：MVP 学员身份迁移接缝（未接线）— 2026-07-13

- 新增纯函数 `student_id_for_token(config, supplied_token)`，只读取可选的
  `auth.student_tokens`，以 `hmac.compare_digest` 比较非空字符串 token 的 UTF-8 bytes。恰好一个匹配才
  返回 `student_id`；缺失、格式异常、空、未知或重复 token 歧义均返回 `None`。
- resolver 未接入 HTTP/WS 路由，也不回退共享 `student_token`；`_role_token()`、
  `validate_auth_config()`、`token_is_valid()` 及现有授权路径没有修改。示例配置只增加空的
  `student_tokens` 映射。
- 当前共享 `student_token` 只证明“学员端”角色。请求体、查询参数和 `/ws` 的
  `student_id` 仍由客户端提供；持 token 者可冒充其他学员，读取或确认其消息，或以其
  身份连接 WebSocket。按 `student_id` 存储查询不是授权隔离；只有路由从认证 principal
  派生 `student_id` 并拒绝不匹配值后才能缓解。当前部署不得称为学员级或租户级数据隔离。
- worktree 没有 `venv/bin/python`，首次命令退出 127、未进入 pytest；随后将 `$PY` 调整为
  `<项目虚拟环境>/bin/python`。仅调整解释器位置，测试选择和判据不变。

| 阶段 | 命令 | 结果与判定 |
|---|---|---|
| RED：resolver | `$PY -m pytest tests/test_app_context.py -k 'student_token_mapping' -q` | FAIL（12 failed）：均因函数尚不存在；共享 token 原有行为断言先通过，失败只发生在新接缝调用。 |
| RED：示例配置 | `$PY -m pytest tests/test_deploy_config.py::test_example_config_documents_public_auth_shape -q` | FAIL（1 failed）：`auth.student_tokens` 缺失。 |
| GREEN：初始聚焦 | 上述两条命令 | PASS（resolver 12 passed；示例配置 1 passed）。 |
| 自审 RED：Unicode token | `$PY -m pytest tests/test_app_context.py::test_student_token_mapping_compares_non_ascii_string_tokens -q` | FAIL（1 failed）：`hmac.compare_digest(str, str)` 对非 ASCII token 抛 `TypeError`。 |
| 自审 GREEN：UTF-8 bytes | `$PY -m pytest tests/test_app_context.py -k 'student_token_mapping' -q` | PASS（13 passed）：双方 token 编码为 UTF-8 bytes 后使用 `hmac.compare_digest`，Unicode 与原有边界用例均通过。 |
| 最终授权回归 | `$PY -m pytest tests/test_app_context.py tests/test_public_auth.py tests/test_deploy_config.py -q` | PASS（42 passed，1 个既有 Starlette 弃用 warning）；共享 token 及 HTTP/WS 双角色授权保持不变。 |
| 全量首轮命令调整 | 临时 `HOME` 下执行 `$PY -m pytest -q` | 非功能回归：504 passed、25 skipped、10 failed；6 项既有上传测试因临时 HOME 无 WorkBuddy 安装环境失败，4 项 Playwright E2E 因临时 HOME 无浏览器缓存失败。未修改相关代码或测试，按项目既有默认开发机 lane 重跑。 |
| 全量 GREEN（Unicode 边界修复前） | `$PY -m pytest -q` | PASS（539 passed，14 个既有/上游弃用 warning）；UTF-8 bytes 修复后以 42 项最终聚焦回归重新验证相关路径。 |
| P0 | P0-1~P0-3；P0-5；`tests/test_server_redlines.py`；`tests/test_public_auth.py`；`tests/test_deploy_config.py tests/test_config.py::TestUrlBuilders` | PASS：导入/应用/组合根正常；P0-5 按预期拒绝多 worker；其余分别 6、4、18 passed。 |
| 未接线与隐私门 | 运行时 caller 扫描；文档增量个人绝对路径扫描；`git diff --check` | PASS：resolver 在 `copilot/` 中只有定义、无路由调用；文档 diff 未新增个人绝对路径；diff check 无输出。 |

### 发布前安全快照门禁 — 2026-07-13

| 阶段 | 命令 | 结果与判定 |
|---|---|---|
| 全量回归 | `<项目虚拟环境>/bin/python -m pytest -q` | PASS（542 passed，14 个既有/上游弃用 warning）。 |
| P0-1~P0-3、P0-5~P0-8 | 测试方案 v2 对应命令 | PASS：导入、FastAPI app、组合根正常；多 worker 按预期拒绝；server redlines 6 passed、public auth 4 passed、部署/URL 配置 18 passed。 |
| 当前树隐私门 | `<项目虚拟环境>/bin/python -m pytest tests/test_repository_privacy.py tests/test_wb_upload.py -q` | PASS（15 passed）：两张敏感导师截图不在 Git 索引，受跟踪内容不含个人主目录路径。 |
| 文本与差异检查 | `git grep` 个人路径扫描；`git diff --check` | PASS：无命中、无格式错误。 |

### 项目说明页：白底紧凑重设计、双向架构与 Get 会议共识 — 2026-07-13

根据内部汇报与协作开发场景，页面重构为白底项目简报：收敛字级和段落留白；增加“从信号到回应”的双向架构图；保留历史单机原型仅作演进背景，当前目标架构作为实施依据；将下载目录导出的 Get 会议笔记浓缩为可公开同步的团队共识卡片，不展示会议转写原文。

| 验证项 | 判定 |
|---|---|
| 下载目录 Get 导出笔记核对 | PASS：`Workbuddy copilot-AI助教支持工具项目需求讨论与开发安排-2026年07月13日-来自【Get 笔记】.md` 与页面所用的双目标、赛马协作、分组测试、任务卡/问卷整合方向一致 |
| 历史架构资料复核 | PASS：当前目标架构可用于概览；`docs/architecture.md` 的旧本地读取假设仅作为演进背景，不作为实施图 |
| 静态资源请求 | PASS：本地 HTTP 下页面、导师端截图、学员端截图均返回 200 |
| 桌面完整页面预览（Playwright，Desktop Chrome HiDPI） | PASS：白底紧凑布局、双向架构图、两端截图、Get 共识卡、默认收起的三项技术细节均正常渲染 |
| 窄屏完整页面预览（Playwright，Chromium 390×844） | PASS：页面转为单列；架构图保留横向查看并明确提示左右滑动；技术摘要与展开入口可读 |
| `git diff --check` | PASS |

命令调整：`--device='iPhone 13'` 会拉起本机 WebKit，浏览器进程被环境以 SIGKILL 终止，未产生页面错误或截图文件；改用 Chromium 的 390×844 等效窄屏 viewport 后稳定完成预览，故以该命令作为本次移动端验证依据。

### 项目说明页：开发资料网页化与章节详情补充 — 2026-07-13

将原先直接打开 Markdown 的三项入口改为 `docs/developer-guide.html` 中的三个网页章节（目标架构 / 复用地图 / 测试判据）；概览页 01–05 新增默认收起的背景、原型能力、分层动机、双端职责和协作方式说明，06 保持三个技术主题的独立展开。公开发布包不再提供原始 Markdown 入口。

| 验证项 | 判定 |
|---|---|
| 本地静态资源与锚点 | PASS：概览、开发手册、三项章节锚点、两张截图均返回 200；概览三入口均指向 `developer-guide.html` |
| 默认折叠状态 | PASS：概览和开发手册的 `details` 没有 `open` 属性，初始只显示摘要 |
| 桌面 / 窄屏视觉验证（Playwright，Chromium） | PASS：概览页桌面完整截图、开发手册桌面与 390×844 窄屏截图均完成；窄屏阅读顺序为架构→复用→测试 |
| 发布包验证 | PASS：发布包只含概览页、开发手册和两张截图；不包含原始 Markdown 入口 |
| 公网验收 | PASS：`https://workbuddy-copilot.superbrain-ai.com` 与 `/developer-guide.html`、两张截图均为 200；旧 `/resources/target-architecture.md` 为 404；三个锚点存在 |
| `git diff --check` | PASS |

发布排障记录：首次部署后主页返回 403。原因是 `mktemp -d` 生成的发布包顶层目录权限为 `700`，rsync 创建远端同名目录时继承该权限，Nginx 无法进入；将发布包顶层目录改为 `755` 后重新同步，公网主页与资源恢复 200。后续静态发布包创建后需显式校正顶层目录为可读取权限。

### 导师发起同步时学员客户端离线无反馈 — 2026-07-13

根因：离线同步请求已正确持久化为 `pending`，学员端上线后也能补拉；但导师端
POST/GET 快照没有暴露 `WSRegistry` 中的瞬时学员连接态，前端因而把所有 `pending`
统一渲染为“等待学员端接收”并无限轮询。

| RED | 结果 |
|---|---|
| `venv/bin/python -m pytest tests/test_upload_requests.py::test_offline_upload_request_is_visible_to_student_and_can_complete tests/test_upload_requests.py::test_mentor_upload_snapshot_reflects_live_float_connection -q` | FAIL（2 failed）：POST/GET 均缺少 `student_online` |
| `venv/bin/python -m pytest tests/e2e/test_mentor_ui.py::test_sync_feedback_shows_offline_then_refreshes_when_student_connects -q` | FAIL（1 failed）：`student_online=false` 仍显示“已请求同步，等待学员端接收…” |

修复：

- `WSRegistry.is_float_connected(student_id)` 封装学员浮标当前连接态。导师专用的
  request-upload POST、请求状态 GET、诊断重试响应与导师 WS 状态快照加入
  `student_online`；学员补拉 API 契约不变。该值每次从内存连接表即时计算，不入库，
  避免将过期在线态当成持久事实。
- 前端在 `pending + student_online=false` 时明确显示“学员端未启动；同步请求已保存，
  客户端启动后将自动接收。”；继续轮询，在线态变为 true 后恢复“等待接收”。
  真值或旧服务缺字段时保持旧文案兼容。

| GREEN | 判定 |
|---|---|
| 新增后端离线/在线瞬时快照、离线补拉、FakeWebSocket 真实收到 `mentor_command` | PASS（2 passed） |
| 新增 Playwright 离线文案→轮询刷新为在线文案；精确离线文案作为负控 | PASS（1 passed） |
| `venv/bin/python -m pytest tests/test_upload_requests.py -q` | PASS（23 passed） |
| `venv/bin/python -m pytest tests/e2e/test_mentor_ui.py -q` | PASS（26 passed） |
| `venv/bin/python -m pytest tests/ -q` | PASS（497 passed，14 个既有/上游弃用 warning） |
| P0-1~P0-8（P0-5 以 `COPILOT_WORKERS=2` 非零拒绝为预期） | PASS：server redline 6 passed、public auth 4 passed、deploy/config 11 passed |

现场验收：重启 8765 后 `/health` 返回 `UP`，导师静态资源已包含新的离线提示文案；
8766 的 Paper Edit Studio 监听进程保持不变。原请求
`bff25ab926f9441aaa80201d286c9da0` 的真实导师 GET 已返回 `student_online=true`，
证明客户端重连后的瞬时状态已进入接口。该请求随后暴露出独立的既有上传问题：92 个本地
会话全部失败，客户端适配器统一返回 `transcript_index_incomplete: transcript byte limit exceeded`；
现场共有 259 个 JSONL、约 66.2 MB，超过当前 8 MiB 聚合索引预算。此问题未通过放宽安全
边界猜测性修复，留作后续单独设计与验证。

### 学员 AI 助教当前问题闭环 — 2026-07-14

本轮把产品最终目标写入 `docs/prd.md`，并同步更新目标架构、实施计划与增量测试方案：
AI 助教在学员使用 WorkBuddy Agents 的过程中持续解决技术卡点并提供交互方法建议；导师
能够看清学员与 AI 的协作过程并给出针对性干预。此次只实现当前明确需求，不扩展新的调研
范围。

实现结果：

- 学员端改为“完整下拉框 + 最近 3 个快捷入口”，两处选择保持同步；会话按任务、空间分组，
  每组按最后问答/活动时间倒序排列。
- 明确区分本地无会话、尚未同步、已同步但暂无分析、服务不可用、LLM 不可用五类状态；
  未同步时可选择“同步后提问”或“不带当前会话提问”。
- 诊断信息默认附加；客户端采集操作系统、工具安装、WorkBuddy 路径/权限、代理配置存在性和
  最近错误环，客户端与服务端双重脱敏。服务端只接收上传后的结构化诊断，不读取学员本地
  文件系统。
- 提问上下文严格按当前会话、同会话分析、有限历史提问、诊断、运行时提示词组装，并保持
  学员/会话隔离；无会话模式不会误带其他对话。
- 回答区可选择并提供复制按钮；LLM 和上下文返回结构化真实状态，不再把配置错误、缺密钥、
  超时或上游错误统一显示为“LLM 未启动”。
- 学员端打开/刷新时通过 `/api/student/capabilities` 获取本地配置预检结果，未提问前也能
  如实区分 ready/disabled/missing_api_key/misconfigured；旧服务不报告时显示 unknown，
  不虚报 ready。每次回答同时明确显示诊断信息实际“已附加”或“未附加”。
- 下拉框与最近 3 个按钮在本地切换时立即同步真实控件选中态，不依赖服务刷新；服务离线时
  仍保持一致。已同步但内容为空的会话返回 `no_context`，不存在的会话才返回 `not_synced`。
- 大规模 transcript 索引改为元数据优先、只在选中会话时安全打开单文件；保留单文件 8 MiB
  安全上限，不再把整个 projects 目录的聚合大小误判为单文件超限。真实本机 92/92 个会话
  均可读取。
- 导师同步的离线提示、在线连接态和 pending/running/stored/done/failed 状态反馈已闭环。
- 完整审计 15 个 student-token 路由；`/recent`、`/sessions`、`/current_session`、
  `/alerts/unread` 与 `/api/student/upload-requests` 均对缺失/空白学员身份 fail closed，
  并用双学员 trap 证明不会因空值退化为无条件查询。

防假绿与边界负控包括：敏感 Authorization/Cookie/JWT/长令牌、非法与越界 LLM 端口、
超过 96 KiB 的问答请求、超量诊断节点、大 transcript SQL 尾部读取、上下文预算挤压、
跨学员/跨会话串数据、陈旧异步 UI 结果、文件替换/符号链接、导师离线后上线等；均先证明
原实现会失败再修复。

| 最终验证 | 判定 |
|---|---|
| `venv/bin/python -m pytest tests/ -q` | PASS（598 passed，14 个既有/上游弃用 warning） |
| P0-1~P0-3 | PASS（FastAPI 可构建；组合根返回 True） |
| P0-5 | PASS（`COPILOT_WORKERS=2` 被 RuntimeError 拒绝） |
| P0-6~P0-8 | PASS（server redline/public auth/deploy config 共 21 passed） |
| 本轮核心学员/导师路径定向回归 | PASS（175 passed） |
| 最终 15 个学员接口隔离复审 | PASS（132 passed；无 Critical / Important） |
| `py_compile` + `git diff --check` | PASS |
| 独立组件与最终集成审查 | Approved（学员 UI、诊断后端、大规模同步、导师离线反馈、身份隔离均无阻塞项） |

真机验收：8765 服务 `/health` 返回 `UP`；学员浮标通过 WS 在线。真实问答返回
`context_status=without_session`、`llm_status=ready`、`diagnostics_attached=true`，回答
“LLM 已连接”。导师定向请求同步一个真实会话后，接口即时返回 `student_online=true`，
随后 `transfer_status=stored`、`analysis_status=done`、无错误；LLM 分析请求返回 200。
最终重启后 `/api/student/capabilities` 返回 `llm_status=ready`；缺身份的学员接口返回
422、空白身份返回 400。Paper Edit Studio 的 8766 监听保持不变。
