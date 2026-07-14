# Student Assistant Current Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the camp AI teaching assistant usable now: truthful LLM status, useful redacted diagnostics, complete session selection, copyable answers, and reliable mentor-triggered synchronization.

**Architecture:** Student Core owns bounded local diagnostics and sends a versioned diagnostic bundle with each opted-in ask. The server composes session transcript, prior asks, diagnostics, and versioned guidance into the LLM context and returns a structured capability result. The native client renders explicit states and a synchronized full selector plus three recent shortcuts; the WorkBuddy adapter resolves transcripts without a global aggregate-content budget that makes large installations unusable.

**Tech Stack:** Python 3.11, FastAPI/Pydantic, SQLite Store, PyObjC/AppKit, pytest, Playwright.

---

### Task 1: Product contract and locked acceptance

**Files:**
- Modify: `docs/prd.md`
- Modify: `docs/target-architecture.md`
- Modify: `docs/test-plan-v3.md`
- Modify: `docs/dev-log.md`

- [ ] **Step 1: Record the final product goal and accepted UX decisions in the PRD**

Document the AI teaching-assistant goal, mentor visibility goal, default-on redacted diagnostics, runtime guidance, full selector plus recent three, WorkBuddy ordering, local-only session choices, copy behavior, and truthful LLM states.

- [ ] **Step 2: Add architecture ownership**

Declare that Student Core creates a versioned `diagnostic_bundle`, the server creates the final LLM context, and Hook remains uninvolved.

- [ ] **Step 3: Add v3-only stronger acceptance cases**

Add test IDs for session ordering/synchronization, local-only asks, diagnostic redaction/defaults, capability errors, copy behavior, large transcript sets, and mentor offline feedback. Do not alter any v2 criterion.

- [ ] **Step 4: Verify documentation consistency**

Run:

```bash
rg -n "最终目标|附加诊断信息|最近 3|LLM|全量同步" docs/prd.md docs/target-architecture.md docs/test-plan-v3.md
git diff --check
```

Expected: every accepted decision appears in the PRD and has an architecture owner and an automated acceptance case.

### Task 2: Student session selector, explicit states, and copy

**Files:**
- Modify: `copilot/floating_native.py`
- Modify: `tests/test_floating_native_phase3.py`

- [ ] **Step 1: Write failing policy tests**

Add pure-policy tests proving that tasks precede workspaces, each group is sorted by descending `last_activity_at`, and the recent shortcuts equal the first three items from the same ordered collection.

- [ ] **Step 2: Run the focused tests and capture RED**

```bash
venv/bin/python -m pytest tests/test_floating_native_phase3.py -k "session_selector or recent_shortcuts" -q
```

Expected: FAIL because the full selector and shared ordering policy do not exist.

- [ ] **Step 3: Implement the shared selector policy and AppKit controls**

Expose a pure helper returning the ordered session list and recent three. Bind a popup selector and three shortcut buttons to one `_select_session(session_id)` path so both controls remain synchronized.

- [ ] **Step 4: Add failing state and copy tests**

Cover `no_local_sessions`, `not_synced`, `synced_no_analysis`, `service_unavailable`, and `llm_unavailable`. Prove that an answer remains selectable and that the copy action writes the complete answer to the pasteboard.

- [ ] **Step 5: Implement explicit states and copy behavior**

Keep the answer text view selectable after a request completes, add a copy button/action, and replace the generic empty-state string with the state-specific message selected by a pure helper.

- [ ] **Step 6: Run focused GREEN and regression**

```bash
venv/bin/python -m pytest tests/test_floating_native_phase3.py -q
```

Expected: all native client tests pass.

### Task 3: Diagnostic bundle, context composition, and LLM capability

**Files:**
- Create: `copilot/student_core/diagnostics.py`
- Modify: `copilot/floating_native.py`
- Modify: `copilot/service.py`
- Modify: `copilot/llm.py`
- Modify: `copilot/store.py`
- Modify: `tests/test_student_ask_api.py`
- Create: `tests/test_student_diagnostics.py`
- Modify: `tests/test_llm.py`

- [ ] **Step 1: Write failing diagnostic contract and redaction tests**

Use deterministic inputs containing an API key, Authorization header, email, home path, error stack, missing executable, denied permission, and failed endpoint. Assert the bundle is versioned and bounded, useful error facts remain, and secret values do not.

- [ ] **Step 2: Run the diagnostic tests and capture RED**

```bash
venv/bin/python -m pytest tests/test_student_diagnostics.py -q
```

Expected: FAIL because the diagnostic contract does not exist.

- [ ] **Step 3: Implement bounded local diagnostic collection**

Implement pure redaction plus injected probes for platform, versions, executable presence, relevant paths, permission status, proxy presence, loopback/upstream reachability, and recent error-ring entries. Never include environment-variable values.

- [ ] **Step 4: Write failing ask-context tests**

Assert that opted-in asks contain session messages, recent Copilot asks, diagnostics, and enabled guidance version; opted-out asks contain no diagnostics; a local-only session returns a structured `context_status=not_synced`; LLM configuration and upstream failures return distinct `llm_status` codes.

- [ ] **Step 5: Implement the versioned request/response and persistence**

Extend `StudentAskIn` with diagnostic and context intent fields. Compose context on the server with deterministic section labels and message-boundary limits. Persist which diagnostic/guidance versions were used. Return `answer`, `context_status`, `llm_status`, and retry guidance.

- [ ] **Step 6: Implement runtime guidance selection**

Read enabled/versioned technical and AI-collaboration guidance from current configuration or Store, append it to later asks, and record the applied versions without adding a mentor editing UI.

- [ ] **Step 7: Run focused GREEN and integration regression**

```bash
venv/bin/python -m pytest tests/test_student_diagnostics.py tests/test_student_ask_api.py tests/test_llm.py -q
```

Expected: all tests pass with real temporary Store and deterministic fake LLM behavior.

### Task 4: Reliable full synchronization and mentor feedback

**Files:**
- Modify: `copilot/student_platform/workbuddy.py`
- Modify: `copilot/wb_upload.py`
- Modify: `copilot/service.py`
- Modify: `copilot/static/mentor/app.js`
- Modify: `tests/test_workbuddy_adapter.py`
- Modify: `tests/test_upload_requests.py`
- Modify: `tests/e2e/test_mentor_ui.py`

- [ ] **Step 1: Write a failing large-installation adapter test**

Materialize more than 8 MiB of unrelated transcripts plus a target session and assert the target remains readable without loading every transcript body into one in-memory index.

- [ ] **Step 2: Run the focused test and capture RED**

```bash
venv/bin/python -m pytest tests/test_workbuddy_adapter.py -k "large_installation" -q
```

Expected: FAIL with `transcript_index_incomplete` under the current aggregate byte budget.

- [ ] **Step 3: Implement metadata-first bounded lookup**

Index only bounded metadata/session identifiers and read/filter the selected transcript on demand. Preserve candidate-count, malformed-data, ambiguity, symlink, descriptor-race, and typed-failure protections.

- [ ] **Step 4: Add mentor feedback tests**

Prove that creating a request for an offline learner immediately renders “学员端未连接，已排队”; reconnect changes it to receiving/running; transfer and diagnosis remain separate; failed states show actionable reasons and retry.

- [ ] **Step 5: Implement truthful status rendering**

Use server-provided online and dual-axis state only. Do not infer success from button clicks or websocket availability.

- [ ] **Step 6: Run focused GREEN and regression**

```bash
venv/bin/python -m pytest tests/test_workbuddy_adapter.py tests/test_upload_requests.py tests/e2e/test_mentor_ui.py -q
```

Expected: all adapter, request-state, and mentor UI tests pass.

### Task 5: Closed-loop verification and live service

**Files:**
- Modify: `docs/dev-log.md`

- [ ] **Step 1: Run P0/P1 and full suite**

```bash
venv/bin/python -m pytest tests/test_platform_imports.py -q
venv/bin/python -m pytest tests/ -q
git diff --check
```

Expected: zero failures and no critical skip.

- [ ] **Step 2: Run registered negative controls**

Temporarily break one assertion target per new critical path, record the expected RED, revert the breaker, and rerun GREEN. Never commit breaker changes.

- [ ] **Step 3: Perform spec and code-quality review**

Independently verify PRD coverage first, then implementation quality, isolation, security redlines, and regression risk. Resolve all P0/P1 findings before continuing.

- [ ] **Step 4: Restart the 8765 service through the Vault-aware launcher**

Start with `start_service.sh`, which loads the configured environment without printing secret values. Confirm `/health` and the LLM capability endpoint show the expected state.

- [ ] **Step 5: Run live smoke tests**

Verify a real student ask, response copy, local-only choice, mentor offline sync feedback, reconnect/sync completion, and at least one large local conversation transfer. Append commands and redacted results to `docs/dev-log.md`.
