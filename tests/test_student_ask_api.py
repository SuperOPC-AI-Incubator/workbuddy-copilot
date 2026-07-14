from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from copilot import service as service_module
from copilot.app_context import AppContext
from copilot.connections import WSRegistry
from copilot.eventbus import EventBus
from copilot.llm import QuestionAnswerOutcome
from copilot.service import create_app
from copilot.services import AnalysisService, MessageService, SessionQueryService
from copilot.store import Store


async def _unused_llm(config, snap, event, latest_prompt):
    raise AssertionError("analysis LLM is not part of student ask API")


def _line(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _build_app(tmp_path, *, llm_config: dict | None = None):
    store = Store(tmp_path / "copilot.db")
    bus = EventBus()
    registry = WSRegistry(send_timeout=0.05)
    bus.subscribe(registry.handle_event)
    events: list[dict] = []

    async def capture_event(payload: dict):
        events.append(payload)

    bus.subscribe(capture_event)
    config = {
        "student_id": "server",
        "service": {"host": "127.0.0.1", "port": 8765},
        "auth": {"token": "secret"},
        "store": {"db_path": str(tmp_path / "copilot.db")},
        "llm": llm_config or {"enable_llm": True, "timeout": 5},
    }
    context = AppContext(
        config=config,
        store=store,
        analysis_svc=AnalysisService(store, _unused_llm, config, bus),
        session_svc=SessionQueryService(store, config),
        message_svc=MessageService(store, bus),
        bus=bus,
        ws_registry=registry,
    )
    return create_app(context), store, events


@pytest.mark.parametrize(
    ("llm_config", "expected_status", "guidance_required"),
    [
        ({"enable_llm": False}, "disabled", True),
        (
            {
                "enable_llm": True,
                "api_key": "",
                "model": "model",
                "api_base": "https://llm.example/v1",
            },
            "missing_api_key",
            True,
        ),
        (
            {
                "enable_llm": True,
                "api_key": "secret-key",
                "model": "model",
                "api_base": "file:///tmp/provider",
            },
            "misconfigured",
            True,
        ),
        (
            {
                "enable_llm": True,
                "api_key": "secret-key",
                "model": "model",
                "api_base": "https://llm.example/v1",
            },
            "ready",
            False,
        ),
    ],
)
def test_student_capabilities_preflights_llm_without_upstream_network(
    tmp_path,
    monkeypatch,
    llm_config,
    expected_status,
    guidance_required,
):
    class NetworkMustNotStart:
        def __init__(self, *args, **kwargs):
            raise AssertionError("capability preflight must not construct an HTTP client")

    monkeypatch.setattr("copilot.llm.httpx.AsyncClient", NetworkMustNotStart)
    app, _store, _events = _build_app(tmp_path, llm_config=llm_config)

    with TestClient(app) as client:
        response = client.get(
            "/api/student/capabilities?student_id=stu-1",
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert response.json()["llm_status"] == expected_status
    assert bool(response.json()["retry_guidance"]) is guidance_required


def test_student_capabilities_requires_token_and_nonempty_student_id(tmp_path):
    app, _store, _events = _build_app(tmp_path)

    with TestClient(app) as client:
        unauthorized = client.get(
            "/api/student/capabilities?student_id=stu-1",
        )
        missing_student = client.get(
            "/api/student/capabilities",
            headers={"Authorization": "Bearer secret"},
        )
        blank_student = client.get(
            "/api/student/capabilities?student_id=%20%20",
            headers={"Authorization": "Bearer secret"},
        )

    assert unauthorized.status_code == 401
    assert missing_student.status_code == 422
    assert blank_student.status_code == 400


def test_student_ask_uses_llm_context_persists_and_publishes_event(tmp_path, monkeypatch):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["question"] = question
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "固定技术助教答案", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, events = _build_app(tmp_path)
    store.upsert_student("stu-1", "Alice")
    store.upsert_session("sess-1", "stu-1", "/work/alice", "循环调试")
    store.add_raw_transcript(
        "sess-1",
        "stu-1",
        _line({
            "type": "message",
            "role": "user",
            "content": "我的 for 循环最后一个元素没处理到",
            "sessionId": "sess-1",
        })
        + _line({
            "type": "message",
            "role": "assistant",
            "content": "检查 range 的结束边界是否少了 1。",
            "sessionId": "sess-1",
        }),
    )

    with TestClient(app) as client:
        resp = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "sess-1",
                "question": "我应该怎么验证边界？",
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ask_id"] > 0
    assert body["answer"] == "固定技术助教答案"
    assert captured["question"] == "我应该怎么验证边界？"
    assert any("for 循环" in msg["content"] for msg in captured["context_messages"])

    asks = store.list_student_asks("stu-1", "sess-1")
    assert len(asks) == 1
    assert asks[0]["question"] == "我应该怎么验证边界？"
    assert asks[0]["answer"] == "固定技术助教答案"
    assert any(event.get("type") == "student_ask" for event in events)


def test_student_ask_llm_disabled_falls_back_and_still_persists(tmp_path):
    app, store, _events = _build_app(tmp_path, llm_config={"enable_llm": False})

    with TestClient(app) as client:
        resp = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "question": "没有 LLM 会怎样？"},
            headers={"X-Copilot-Token": "secret"},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ask_id"] > 0
    assert "LLM" in body["answer"]
    assert store.list_student_asks("stu-1")[0]["answer"] == body["answer"]


def test_student_ask_rejects_blank_question(tmp_path):
    app, _store, _events = _build_app(tmp_path)

    with TestClient(app) as client:
        resp = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "question": "   "},
            headers={"Authorization": "Bearer secret"},
        )

    assert resp.status_code == 400


def test_student_ask_composes_five_context_layers_and_persists_metadata(tmp_path, monkeypatch):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome(
            status="ready",
            answer="根据会话、诊断与营地指南给出的回答",
            retry_guidance="",
        )

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    app.state.context.config["guidance"] = [
        {"version": "camp-tech-v1", "text": "先读原始报错，再做最小验证。"}
    ]
    store.upsert_student("stu-1", "Alice")
    store.upsert_session("sess-1", "stu-1", "/work/alice", "环境排查")
    store.add_raw_transcript(
        "sess-1",
        "stu-1",
        _line({"type": "message", "role": "user", "content": "python 命令不存在"}),
    )
    report_id = store.add_report("stu-1", "sess-1", "Stop", "为什么", "", 1, 0)
    store.add_analysis(
        report_id,
        "stu-1",
        {"topic": "环境配置", "diagnosis": "Python 未安装", "suggestion": "检查 PATH"},
        session_id="sess-1",
    )
    store.add_student_ask("stu-1", "sess-old", "上一问", "上一答")

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "sess-1",
                "question": "请帮我定位",
                "include_diagnostics": True,
                "diagnostic_bundle": {
                    "schema_version": "diagnostic-bundle/v1",
                    "system": {"os": "macOS"},
                    "recent_errors": [
                        {
                            "component": "workbuddy",
                            "timestamp": 1.0,
                            "type": "PermissionError",
                            "message": "Permission denied: /Users/alice/private",
                        }
                    ],
                },
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "ask_id": body["ask_id"],
        "answer": "根据会话、诊断与营地指南给出的回答",
        "context_status": "ready",
        "llm_status": "ready",
        "retry_guidance": "",
        "diagnostics_attached": True,
        "guidance_versions": ["camp-tech-v1"],
    }
    rendered = "\n".join(item["content"] for item in captured["context_messages"])
    assert "python 命令不存在" in rendered
    assert "Python 未安装" in rendered
    assert "上一问" in rendered and "上一答" in rendered
    assert "Permission denied" in rendered
    assert "先读原始报错" in rendered
    persisted = store.list_student_asks("stu-1")[0]
    assert persisted["diagnostics_attached"] == 1
    assert persisted["diagnostics_version"] == "diagnostic-bundle/v1"
    assert json.loads(persisted["diagnostics_summary"])["schema_version"] == (
        "diagnostic-bundle/v1"
    )
    assert json.loads(persisted["guidance_versions"]) == ["camp-tech-v1"]


def test_student_ask_local_only_session_requires_explicit_context_mode(tmp_path, monkeypatch):
    captured: list[list[dict]] = []

    async def fake_answer_question(config, question, context_messages):
        captured.append(context_messages)
        return QuestionAnswerOutcome("ready", "纯问答", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    store.add_student_ask(
        "stu-1",
        "other-session",
        "OTHER-SESSION-PRIOR-ASK-TRAP",
        "OTHER-SESSION-PRIOR-ANSWER-TRAP",
    )

    with TestClient(app) as client:
        missing_choice = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "session_id": "local-only", "question": "hi"},
            headers={"Authorization": "Bearer secret"},
        )
        without_session = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "local-only",
                "question": "hi",
                "context_mode": "without_session",
                "include_diagnostics": False,
                "diagnostic_bundle": {
                    "schema_version": "diagnostic-bundle/v1",
                    "recent_errors": ["SHOULD-NOT-BE-ATTACHED"],
                },
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert missing_choice.json()["context_status"] == "not_synced"
    assert without_session.json()["context_status"] == "without_session"
    assert without_session.json()["diagnostics_attached"] is False
    assert all(item.get("session_id") != "local-only" for item in captured[-1])
    assert not any(item.get("source") == "diagnostic_bundle" for item in captured[-1])
    assert not any(
        item.get("source") in {"session", "session_analysis"}
        for item in captured[-1]
    )
    assert "OTHER-SESSION-PRIOR" not in json.dumps(captured[-1], ensure_ascii=False)


def test_student_ask_reports_no_context_and_disabled_llm(tmp_path):
    app, _store, _events = _build_app(tmp_path, llm_config={"enable_llm": False})

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "question": "hi", "include_diagnostics": False},
            headers={"Authorization": "Bearer secret"},
        )

    body = response.json()
    assert body["context_status"] == "no_context"
    assert body["llm_status"] == "disabled"
    assert body["retry_guidance"]


def test_student_ask_context_status_uses_student_scoped_session_existence(
    tmp_path, monkeypatch
):
    captured: list[list[dict]] = []

    async def fake_answer_question(config, question, context_messages):
        captured.append(context_messages)
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    store.upsert_student("stu-1", "Alice")
    store.upsert_student("stu-2", "Bob")
    store.upsert_session("other-owner-session", "stu-2", "/bob", "Bob only")
    store.upsert_session("empty-session", "stu-1", "/alice", "Empty but synced")
    store.add_student_ask(
        "stu-1",
        None,
        "PRIOR-ASK-SHOULD-NOT-CHANGE-SESSION-STATE",
        "prior answer",
    )
    app.state.context.config["guidance"] = {
        "version": "test-guidance-v1",
        "text": "GUIDANCE-SHOULD-NOT-CHANGE-SESSION-STATE",
    }

    def ask(client, session_id):
        return client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": session_id,
                "question": "help",
                "include_diagnostics": True,
                "diagnostic_bundle": {
                    "schema_version": "diagnostic-bundle/v1",
                    "system": {"os": "test-os"},
                },
            },
            headers={"Authorization": "Bearer secret"},
        )

    with TestClient(app) as client:
        other_owner = ask(client, "other-owner-session")
        empty_synced = ask(client, "empty-session")
        store.add_raw_transcript(
            "empty-session",
            "stu-1",
            _line({"type": "message", "role": "user", "content": "REAL-CONTEXT"}),
        )
        ready = ask(client, "empty-session")

    assert other_owner.status_code == 200
    assert other_owner.json()["context_status"] == "not_synced"
    assert empty_synced.json()["context_status"] == "no_context"
    assert ready.json()["context_status"] == "ready"
    assert "REAL-CONTEXT" not in json.dumps(captured[0], ensure_ascii=False)
    assert "REAL-CONTEXT" not in json.dumps(captured[1], ensure_ascii=False)
    assert "REAL-CONTEXT" in json.dumps(captured[2], ensure_ascii=False)


def test_recent_requires_nonempty_student_id_before_querying_store(tmp_path):
    app, store, _events = _build_app(tmp_path)
    report_id = store.add_report(
        "stu-2",
        "sess-2",
        "Stop",
        "hidden from unscoped recent",
        "",
        1,
        0,
    )
    store.add_analysis(
        report_id,
        "stu-2",
        {"topic": "OTHER-STUDENT-TRAP", "diagnosis": "private"},
        session_id="sess-2",
    )

    with TestClient(app) as client:
        missing = client.get(
            "/recent",
            headers={"Authorization": "Bearer secret"},
        )
        blank = client.get(
            "/recent?student_id=%20%20",
            headers={"Authorization": "Bearer secret"},
        )
        scoped = client.get(
            "/recent?student_id=stu-1",
            headers={"Authorization": "Bearer secret"},
        )

    assert missing.status_code == 422
    assert blank.status_code == 400
    assert scoped.status_code == 200
    assert scoped.json() == {"items": []}


@pytest.mark.parametrize("path", ["/sessions", "/current_session"])
def test_student_session_read_endpoints_require_explicit_scoped_student_id(
    tmp_path, path
):
    app, store, _events = _build_app(tmp_path)
    app.state.context.config["student_id"] = "stu-2"
    store.upsert_student("stu-1", "Alice")
    store.upsert_student("stu-2", "Bob")
    store.upsert_session(
        "alice-session",
        "stu-1",
        "/alice",
        "ALICE-ONLY",
        last_activity_at=10,
    )
    store.upsert_session(
        "bob-session",
        "stu-2",
        "/bob",
        "OTHER-STUDENT-TRAP",
        last_activity_at=20,
    )

    with TestClient(app) as client:
        missing = client.get(
            path,
            headers={"Authorization": "Bearer secret"},
        )
        blank = client.get(
            path + "?student_id=%20%20",
            headers={"Authorization": "Bearer secret"},
        )
        scoped = client.get(
            path + "?student_id=stu-1",
            headers={"Authorization": "Bearer secret"},
        )

    assert missing.status_code == 422
    assert blank.status_code == 400
    assert scoped.status_code == 200
    rendered = json.dumps(scoped.json(), ensure_ascii=False)
    assert "alice-session" in rendered
    assert "OTHER-STUDENT-TRAP" not in rendered
    assert "bob-session" not in rendered


def test_unread_alerts_requires_explicit_student_and_never_returns_another_student(
    tmp_path,
):
    app, store, _events = _build_app(tmp_path)
    alice_report = store.add_report(
        "stu-1", "alice-session", "Stop", "alice prompt", "", 1, 0
    )
    store.add_analysis(
        alice_report,
        "stu-1",
        {
            "topic": "ALICE-ALERT",
            "understanding": "stuck",
            "alert": "alice needs help",
        },
        session_id="alice-session",
    )
    bob_report = store.add_report(
        "stu-2", "bob-session", "Stop", "bob prompt", "", 1, 0
    )
    store.add_analysis(
        bob_report,
        "stu-2",
        {
            "topic": "OTHER-STUDENT-ALERT-TRAP",
            "understanding": "stuck",
            "alert": "bob private alert",
        },
        session_id="bob-session",
    )

    with TestClient(app) as client:
        missing = client.get(
            "/alerts/unread",
            headers={"Authorization": "Bearer secret"},
        )
        blank = client.get(
            "/alerts/unread?student_id=%20%20",
            headers={"Authorization": "Bearer secret"},
        )
        scoped = client.get(
            "/alerts/unread?student_id=stu-1",
            headers={"Authorization": "Bearer secret"},
        )

    assert missing.status_code == 422
    assert blank.status_code == 400
    assert scoped.status_code == 200
    rendered = json.dumps(scoped.json(), ensure_ascii=False)
    assert "ALICE-ALERT" in rendered
    assert "OTHER-STUDENT-ALERT-TRAP" not in rendered
    assert "bob private alert" not in rendered


def test_student_upload_request_list_rejects_blank_identity_and_is_scoped(tmp_path):
    app, store, _events = _build_app(tmp_path)
    store.add_upload_request(
        mentor_id="mentor",
        student_id="stu-1",
        request_id="alice-request",
    )
    store.add_upload_request(
        mentor_id="mentor",
        student_id="stu-2",
        request_id="OTHER-STUDENT-UPLOAD-TRAP",
    )

    with TestClient(app) as client:
        missing = client.get(
            "/api/student/upload-requests",
            headers={"Authorization": "Bearer secret"},
        )
        blank = client.get(
            "/api/student/upload-requests?student_id=%20%20&status=all",
            headers={"Authorization": "Bearer secret"},
        )
        empty = client.get(
            "/api/student/upload-requests?student_id=&status=all",
            headers={"Authorization": "Bearer secret"},
        )
        scoped = client.get(
            "/api/student/upload-requests?student_id=stu-1&status=all",
            headers={"Authorization": "Bearer secret"},
        )

    assert missing.status_code == 422
    assert blank.status_code == 400
    assert empty.status_code == 400
    assert scoped.status_code == 200
    rendered = json.dumps(scoped.json(), ensure_ascii=False)
    assert "alice-request" in rendered
    assert "OTHER-STUDENT-UPLOAD-TRAP" not in rendered


def test_student_ask_bounds_and_redacts_diagnostic_context(tmp_path, monkeypatch):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, _store, _events = _build_app(tmp_path)
    errors = [
        {
            "component": "workbuddy",
            "timestamp": float(index),
            "type": "RuntimeError",
            "message": f"old-{index}-" + "x" * 600,
        }
        for index in range(60)
    ]
    errors.append(
        {
            "component": "workbuddy",
            "timestamp": 61.0,
            "type": "RuntimeError",
            "message": (
                "LATEST-ERROR Authorization: Bearer secret-value "
                "at /Users/alice/project"
            ),
        }
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "question": "help",
                "diagnostic_bundle": {
                    "schema_version": "diagnostic-bundle/v1",
                    "recent_errors": errors,
                },
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    diagnostic = next(
        item for item in captured["context_messages"] if item["role"] == "diagnostics"
    )
    assert len(diagnostic["content"]) <= 3_200
    assert "LATEST-ERROR" in diagnostic["content"]
    assert "secret-value" not in diagnostic["content"]
    assert "/Users/alice" not in diagnostic["content"]


@pytest.mark.parametrize(
    "diagnostic_bundle",
    [
        {"recent_errors": ["MISSING-SCHEMA-TRAP"]},
        {
            "schema_version": "diagnostic-bundle/v999",
            "recent_errors": ["UNSUPPORTED-SCHEMA-TRAP"],
        },
    ],
)
def test_student_ask_rejects_unsupported_diagnostic_schema_from_context_and_metadata(
    tmp_path, monkeypatch, diagnostic_bundle
):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "question": "help",
                "diagnostic_bundle": diagnostic_bundle,
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert response.json()["diagnostics_attached"] is False
    assert not any(
        item.get("source") == "diagnostic_bundle"
        for item in captured["context_messages"]
    )
    persisted = store.list_student_asks("stu-1")[0]
    assert persisted["diagnostics_attached"] == 0
    assert persisted["diagnostics_version"] == ""
    assert json.loads(persisted["diagnostics_summary"]) == {}


def test_sync_then_ask_is_isolated_and_becomes_ready_only_after_selected_session_sync(
    tmp_path, monkeypatch
):
    captured: list[list[dict]] = []

    async def fake_answer_question(config, question, context_messages):
        captured.append(context_messages)
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    store.upsert_student("stu-1", "Alice")
    store.upsert_student("stu-2", "Bob")
    store.upsert_session("other-session", "stu-1", "/other", "other")
    store.add_raw_transcript(
        "other-session",
        "stu-1",
        _line({"type": "message", "role": "user", "content": "OTHER-SESSION-TRAP"}),
    )
    store.add_raw_transcript(
        "selected-session",
        "stu-2",
        _line({"type": "message", "role": "user", "content": "OTHER-STUDENT-TRAP"}),
    )

    with TestClient(app) as client:
        before = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "selected-session",
                "question": "before sync",
                "context_mode": "sync_then_ask",
                "include_diagnostics": False,
            },
            headers={"Authorization": "Bearer secret"},
        )
        store.upsert_session("selected-session", "stu-1", "/target", "target")
        store.add_raw_transcript(
            "selected-session",
            "stu-1",
            _line({"type": "message", "role": "user", "content": "TARGET-CONTEXT"}),
        )
        after = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "selected-session",
                "question": "after sync",
                "context_mode": "sync_then_ask",
                "include_diagnostics": False,
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert before.json()["context_status"] == "not_synced"
    assert after.json()["context_status"] == "ready"
    before_text = json.dumps(captured[0], ensure_ascii=False)
    after_text = json.dumps(captured[1], ensure_ascii=False)
    assert "OTHER-SESSION-TRAP" not in before_text + after_text
    assert "OTHER-STUDENT-TRAP" not in before_text + after_text
    assert "TARGET-CONTEXT" in after_text


def test_disabled_guidance_is_not_sent_or_recorded(tmp_path, monkeypatch):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    app.state.context.config["guidance"] = [
        {"version": "enabled-v1", "text": "ENABLED-GUIDANCE"},
        {"version": "disabled-v1", "text": "DISABLED-GUIDANCE", "enabled": False},
    ]

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "question": "help", "include_diagnostics": False},
            headers={"Authorization": "Bearer secret"},
        )

    rendered = json.dumps(captured["context_messages"], ensure_ascii=False)
    assert "ENABLED-GUIDANCE" in rendered
    assert "DISABLED-GUIDANCE" not in rendered
    assert response.json()["guidance_versions"] == ["enabled-v1"]
    assert json.loads(store.list_student_asks("stu-1")[0]["guidance_versions"]) == [
        "enabled-v1"
    ]


def test_student_ask_queries_only_three_prior_asks(tmp_path, monkeypatch):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    original = store.list_student_asks

    def tracked(student_id, session_id=None, limit=None):
        captured["limit"] = limit
        if limit is None:
            return original(student_id, session_id)
        return original(student_id, session_id, limit=limit)

    store.list_student_asks = tracked

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "question": "help", "include_diagnostics": False},
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert captured["limit"] == 3


def test_unparseable_single_oversize_line_reports_no_usable_session_context(
    tmp_path, monkeypatch
):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    store.upsert_student("stu-1", "Alice")
    store.upsert_session("bad-session", "stu-1", "/target", "bad")
    store.add_raw_transcript("bad-session", "stu-1", "PARTIAL-TRAP-" + "x" * 400_000)

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "bad-session",
                "question": "help",
                "context_mode": "sync_then_ask",
                "include_diagnostics": False,
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert response.json()["context_status"] == "no_context"
    assert "PARTIAL-TRAP" not in json.dumps(
        captured["context_messages"], ensure_ascii=False
    )


def test_raw_parser_receives_only_bounded_complete_line_tail(monkeypatch):
    seen: dict = {}
    real_parse = service_module.parse_text

    def capture_parse(content):
        seen["content"] = content
        return real_parse(content)

    monkeypatch.setattr(service_module, "parse_text", capture_parse)
    valid = _line(
        {"type": "message", "role": "user", "content": "LATEST-COMPLETE-MESSAGE"}
    )
    raw = "PARTIAL-TRAP-" + "x" * 400_000 + "\n" + valid

    context = service_module._question_context_from_raw(raw, session_id="sess-1")

    assert len(seen["content"]) <= 256_000
    assert not str(seen["content"]).startswith("x")
    assert "PARTIAL-TRAP" not in str(seen["content"])
    assert any("LATEST-COMPLETE-MESSAGE" in item["content"] for item in context)


def test_student_ask_reads_bounded_sql_tail_without_calling_full_raw_method(
    tmp_path, monkeypatch
):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    store.upsert_student("stu-1", "Alice")
    store.upsert_session("sess-large", "stu-1", "/target", "large")
    store.add_raw_transcript(
        "sess-large",
        "stu-1",
        "MID-LINE-TRAP-"
        + "x" * 600_000
        + "\n"
        + _line(
            {
                "type": "message",
                "role": "user",
                "content": "LATEST-SQL-TAIL-MESSAGE",
            }
        ),
    )

    def forbid_full_read(*_args, **_kwargs):
        raise AssertionError("student ask must not materialize the full transcript")

    monkeypatch.setattr(
        store,
        "get_raw_transcript_for_student_session",
        forbid_full_read,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "sess-large",
                "question": "help",
                "context_mode": "sync_then_ask",
                "include_diagnostics": False,
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    rendered = json.dumps(captured["context_messages"], ensure_ascii=False)
    assert "LATEST-SQL-TAIL-MESSAGE" in rendered
    assert "MID-LINE-TRAP" not in rendered


def test_short_fragment_without_newline_never_becomes_session_context():
    fragment = "MID-MESSAGE secret file content that is not a complete JSONL line"

    assert service_module._question_context_from_raw(
        fragment, session_id="sess-1"
    ) == []

    complete = _line(
        {"type": "message", "role": "user", "content": "COMPLETE-JSONL"}
    )
    context = service_module._question_context_from_raw(complete, session_id="sess-1")
    assert any(item["content"] == "COMPLETE-JSONL" for item in context)


def test_supported_diagnostic_schema_drops_malicious_unknown_structure(
    tmp_path, monkeypatch
):
    captured: dict = {}

    async def fake_answer_question(config, question, context_messages):
        captured["context_messages"] = context_messages
        return QuestionAnswerOutcome("ready", "ok", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, _store, _events = _build_app(tmp_path)
    malicious = {
        "schema_version": "diagnostic-bundle/v1",
        "system": {
            "os": "Darwin",
            "arch": "arm64",
            "hostname": "HOST-CONTENT-TRAP",
            "nested": {"file": "SYSTEM-FILE-CONTENT-TRAP"},
        },
        "versions": {"python": "3.13", "unknown": "VERSION-TRAP"},
        "environment": {
            "SAFE_ENV": {"configured": True, "value": "ENV-VALUE-TRAP"},
            "RAW_ENV": "RAW-ENV-VALUE-TRAP",
        },
        "proxy": {
            "HTTP_PROXY": {"configured": False, "url": "PROXY-URL-TRAP"},
            "RAW_PROXY": "RAW-PROXY-TRAP",
        },
        "tools": {
            "python3": {
                "available": True,
                "path": "/Users/alice/bin/python3",
                "file_content": "TOOL-FILE-CONTENT-TRAP",
            },
            "bad": "RAW-TOOL-TRAP",
        },
        "paths": [
            {
                "path": "/Users/alice/.workbuddy/workbuddy.db",
                "exists": "yes",
                "readable": True,
                "content": "DB-FILE-CONTENT-TRAP",
            }
        ],
        "permissions": {
            "home": {"readable": True, "secret": "PERMISSION-TRAP"},
            "unknown": "UNKNOWN-PERMISSION-TRAP",
        },
        "reachability": {
            "loopback": "ready",
            "upstream": {"response": "UPSTREAM-BODY-TRAP"},
            "other": "OTHER-REACHABILITY-TRAP",
        },
        "recent_errors": [
            {
                "component": "student_core",
                "timestamp": 123.0,
                "type": "PermissionError",
                "message": "USEFUL-ERROR-MESSAGE",
                "stack_tail": "USEFUL-STACK-TAIL",
                "file_content": "ERROR-FILE-CONTENT-TRAP",
            },
            "RAW-ERROR-STRING-TRAP",
        ],
        "unknown_category": {"file_content": "UNKNOWN-CATEGORY-TRAP"},
        "truncated": "false",
    }

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "question": "help",
                "diagnostic_bundle": malicious,
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert response.status_code == 200
    assert response.json()["diagnostics_attached"] is True
    diagnostic_item = next(
        item
        for item in captured["context_messages"]
        if item.get("source") == "diagnostic_bundle"
    )
    normalized = json.loads(diagnostic_item["content"])
    assert set(normalized) <= {
        "schema_version",
        "system",
        "versions",
        "environment",
        "proxy",
        "tools",
        "paths",
        "permissions",
        "reachability",
        "recent_errors",
        "truncated",
    }
    assert normalized["system"] == {"os": "Darwin", "arch": "arm64"}
    assert normalized["versions"] == {"python": "3.13"}
    assert normalized["environment"] == {"SAFE_ENV": {"configured": True}}
    assert normalized["proxy"] == {"HTTP_PROXY": {"configured": False}}
    assert normalized["tools"]["python3"] == {
        "available": True,
        "path": "~/bin/python3",
    }
    assert normalized["paths"] == [
        {"path": "~/.workbuddy/workbuddy.db", "readable": True}
    ]
    assert normalized["permissions"] == {"home": {"readable": True}}
    assert normalized["reachability"] == {"loopback": "ready"}
    assert normalized["recent_errors"] == [
        {
            "component": "student_core",
            "timestamp": 123.0,
            "type": "PermissionError",
            "message": "USEFUL-ERROR-MESSAGE",
            "stack_tail": "USEFUL-STACK-TAIL",
        }
    ]
    assert normalized["truncated"] is False
    rendered = json.dumps(normalized, ensure_ascii=False)
    for trap in (
        "HOST-CONTENT-TRAP",
        "SYSTEM-FILE-CONTENT-TRAP",
        "VERSION-TRAP",
        "ENV-VALUE-TRAP",
        "RAW-ENV-VALUE-TRAP",
        "PROXY-URL-TRAP",
        "RAW-PROXY-TRAP",
        "TOOL-FILE-CONTENT-TRAP",
        "RAW-TOOL-TRAP",
        "DB-FILE-CONTENT-TRAP",
        "PERMISSION-TRAP",
        "UNKNOWN-PERMISSION-TRAP",
        "UPSTREAM-BODY-TRAP",
        "OTHER-REACHABILITY-TRAP",
        "ERROR-FILE-CONTENT-TRAP",
        "RAW-ERROR-STRING-TRAP",
        "UNKNOWN-CATEGORY-TRAP",
    ):
        assert trap not in rendered


def test_question_context_budget_prioritizes_current_session_over_large_later_layers():
    from copilot.llm import _format_question_context

    rendered = _format_question_context(
        [
            {
                "role": "user",
                "source": "session",
                "content": "CURRENT-SESSION-" + "s" * 3_000,
            },
            {
                "role": "analysis",
                "source": "session_analysis",
                "content": "CURRENT-ANALYSIS",
            },
            {
                "role": "prior_copilot",
                "source": "student_asks",
                "content": "RECENT-PRIOR-ASK",
            },
            {
                "role": "diagnostics",
                "source": "diagnostic_bundle",
                "content": "HUGE-DIAGNOSTIC-" + "d" * 10_000,
            },
            {
                "role": "runtime_guidance",
                "source": "runtime_guidance",
                "content": "HUGE-GUIDANCE-" + "g" * 10_000,
            },
        ],
        max_chars=12_000,
    )

    assert "CURRENT-SESSION-" in rendered
    assert "CURRENT-ANALYSIS" in rendered
    assert "RECENT-PRIOR-ASK" in rendered


def test_student_ask_rejects_oversized_fields_and_diagnostics_before_side_effects(
    tmp_path, monkeypatch
):
    calls = 0

    async def fake_answer_question(config, question, context_messages):
        nonlocal calls
        calls += 1
        return QuestionAnswerOutcome("ready", "must not run", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)

    with TestClient(app) as client:
        oversized_student = client.post(
            "/api/student/ask",
            json={"student_id": "s" * 1_000, "question": "hi"},
            headers={"Authorization": "Bearer secret"},
        )
        oversized_session = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "session_id": "session-" + "x" * 1_000,
                "question": "hi",
            },
            headers={"Authorization": "Bearer secret"},
        )
        million_question = client.post(
            "/api/student/ask",
            json={"student_id": "stu-1", "question": "q" * 1_000_000},
            headers={"Authorization": "Bearer secret"},
        )
        excessive_nodes = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "question": "hi",
                "diagnostic_bundle": {
                    "schema_version": "diagnostic-bundle/v1",
                    "recent_errors": [{} for _ in range(1_000)],
                },
            },
            headers={"Authorization": "Bearer secret"},
        )
        excessive_diagnostic_bytes = client.post(
            "/api/student/ask",
            json={
                "student_id": "stu-1",
                "question": "hi",
                "diagnostic_bundle": {
                    "schema_version": "diagnostic-bundle/v1",
                    "system": {"os": "x" * 70_000},
                },
            },
            headers={"Authorization": "Bearer secret"},
        )

    assert oversized_student.status_code == 422
    assert oversized_session.status_code == 422
    assert million_question.status_code == 413
    assert excessive_nodes.status_code == 422
    assert excessive_diagnostic_bytes.status_code == 422
    assert calls == 0
    assert store.list_student_asks("stu-1") == []


def test_student_ask_stream_without_content_length_is_still_body_bounded(
    tmp_path, monkeypatch
):
    calls = 0

    async def fake_answer_question(config, question, context_messages):
        nonlocal calls
        calls += 1
        return QuestionAnswerOutcome("ready", "must not run", "")

    monkeypatch.setattr(
        service_module,
        "llm_answer_question_with_status",
        fake_answer_question,
        raising=False,
    )
    app, store, _events = _build_app(tmp_path)
    body = json.dumps(
        {
            "student_id": "stu-1",
            "question": "hi",
            "ignored_padding": "x" * 200_000,
        }
    ).encode("utf-8")

    def body_chunks():
        for offset in range(0, len(body), 16_384):
            yield body[offset : offset + 16_384]

    with TestClient(app) as client:
        response = client.post(
            "/api/student/ask",
            content=body_chunks(),
            headers={
                "Authorization": "Bearer secret",
                "Content-Type": "application/json",
                "Transfer-Encoding": "chunked",
            },
        )

    assert response.status_code == 413
    assert calls == 0
    assert store.list_student_asks("stu-1") == []
