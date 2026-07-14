from __future__ import annotations

import asyncio
import json
import threading
import time
import warnings
from urllib.parse import parse_qs, urlparse

import copilot.floating_native as floating_native
from copilot.floating_native import (
    CopilotNativeApp,
    _build_float_ws_url,
    _panel_origin_for_icon,
)
from copilot.student_platform.macos import StudentCoordinatorCommandCallback


def test_panel_origin_places_panel_left_of_right_side_icon_and_clamps_to_screen():
    screen_frame = (0.0, 0.0, 1440.0, 900.0)
    panel_size = (380.0, 520.0)
    icon_frame = (1360.0, 760.0, 48.0, 48.0)

    x, y = _panel_origin_for_icon(icon_frame, panel_size, screen_frame)

    assert x + panel_size[0] <= icon_frame[0] - 8.0
    assert x >= screen_frame[0]
    assert y >= screen_frame[1]
    assert y + panel_size[1] <= screen_frame[1] + screen_frame[3]
    assert (x, y) != (
        screen_frame[0] + (screen_frame[2] - panel_size[0]) / 2,
        screen_frame[1] + screen_frame[3] * 0.3,
    )


def test_panel_origin_follows_icon_position_changes():
    screen_frame = (0.0, 0.0, 1440.0, 900.0)
    panel_size = (380.0, 520.0)

    origin_a = _panel_origin_for_icon((900.0, 600.0, 48.0, 48.0), panel_size, screen_frame)
    origin_b = _panel_origin_for_icon((1000.0, 520.0, 48.0, 48.0), panel_size, screen_frame)

    assert origin_a != origin_b
    assert origin_b[0] > origin_a[0]
    assert origin_b[1] < origin_a[1]


def test_float_ws_url_includes_student_token_and_last_seen_without_leaking_when_redacted(monkeypatch):
    monkeypatch.delenv("COPILOT_TOKEN", raising=False)
    cfg = {
        "student_id": "student-a",
        "service": {"host": "127.0.0.1", "port": 8765, "token": "secret-token"},
    }

    raw_url = _build_float_ws_url(cfg, "student-a", 42)
    redacted_url = _build_float_ws_url(cfg, "student-a", 42, redact_token=True)

    raw_query = parse_qs(urlparse(raw_url).query)
    redacted_query = parse_qs(urlparse(redacted_url).query)

    assert raw_query["student_id"] == ["student-a"]
    assert raw_query["token"] == ["secret-token"]
    assert raw_query["last_seen_message_id"] == ["42"]
    assert "secret-token" not in redacted_url
    assert redacted_query["token"] == ["<redacted>"]


def test_float_ws_url_prefers_student_role_token(monkeypatch):
    monkeypatch.delenv("COPILOT_TOKEN", raising=False)
    cfg = {
        "student_id": "student-a",
        "auth": {
            "token": "legacy-token",
            "student_token": "student-token",
            "mentor_token": "mentor-token",
        },
        "service": {"host": "127.0.0.1", "port": 8765},
    }

    raw_url = _build_float_ws_url(cfg, "student-a", 0)
    raw_query = parse_qs(urlparse(raw_url).query)

    assert raw_query["token"] == ["student-token"]


def test_float_urls_use_public_base_url_for_https_and_wss(monkeypatch):
    monkeypatch.delenv("COPILOT_TOKEN", raising=False)
    cfg = {
        "student_id": "student-a",
        "auth": {"student_token": "student-token"},
        "service": {
            "host": "127.0.0.1",
            "port": 8765,
            "public_base_url": "https://copilot.example.com/copilot/",
        },
    }

    ws_url = _build_float_ws_url(cfg, "student-a", 0)

    assert ws_url.startswith("wss://copilot.example.com/copilot/ws?")
    assert parse_qs(urlparse(ws_url).query)["token"] == ["student-token"]


def test_macos_command_callback_hands_non_ui_command_to_student_coordinator():
    class FakeCoordinator:
        def __init__(self):
            self.commands = []

        async def handle_command(self, command):
            self.commands.append(command)
            return True

    coordinator = FakeCoordinator()
    results = []
    callback = StudentCoordinatorCommandCallback(
        coordinator,
        run=lambda awaitable: results.append(asyncio.run(awaitable)),
    )
    command = {"type": "mentor_command", "command": "upload_conversations"}

    assert callback.submit(command, lambda _command: None) is True
    assert coordinator.commands == [command]
    assert results == [None]


def test_macos_command_callback_does_not_claim_async_false_without_result_bridge():
    class FalseCoordinator:
        async def handle_command(self, command):
            return False

    scheduled = []
    callback = StudentCoordinatorCommandCallback(
        FalseCoordinator(), run=lambda awaitable: scheduled.append(awaitable)
    )

    assert callback({"type": "mentor_command", "command": "upload_conversations"}) is False
    assert scheduled == []


def test_macos_command_callback_bridge_runs_legacy_fallback_after_async_false():
    class FalseCoordinator:
        async def handle_command(self, command):
            return False

    fallback = []
    callback = StudentCoordinatorCommandCallback(
        FalseCoordinator(), run=lambda awaitable: asyncio.run(awaitable)
    )
    command = {"type": "mentor_command", "command": "upload_conversations"}

    assert callback.submit(command, fallback.append) is True
    assert fallback == [command]


def test_floating_uses_injected_student_coordinator_callback_before_legacy_worker():
    calls = []

    class FakeApp:
        _handle_mentor_command = CopilotNativeApp._handle_mentor_command

        def _student_coordinator_callback(self, command):
            calls.append(command)
            return True

        def _handle_mentor_command_upload(self, command):
            raise AssertionError("legacy upload worker should not run after coordinator handoff")

    command = {"type": "mentor_command", "command": "upload_conversations", "request_id": "req-1"}

    FakeApp()._handle_mentor_command(command)

    assert calls == [command]


def test_ws_raw_messages_are_dispatched_to_main_thread(monkeypatch):
    calls = []

    def fake_call_after(func, *args):
        calls.append((func, args))

    monkeypatch.setattr(floating_native.AppHelper, "callAfter", fake_call_after)

    class FakeApp:
        _handle_ws_message = CopilotNativeApp._handle_ws_message

    app = FakeApp()

    CopilotNativeApp._dispatch_ws_message(app, '{"type":"analysis"}')

    assert len(calls) == 1
    func, args = calls[0]
    assert func.__self__ is app
    assert func.__func__ is CopilotNativeApp._handle_ws_message
    assert args == ('{"type":"analysis"}',)


def test_mentor_catchup_messages_are_dispatched_to_main_thread(monkeypatch):
    calls = []

    def fake_call_after(func, *args):
        calls.append((func, args))

    class FakeApp:
        _student_id = "student-a"
        _last_seen_mentor_message_id = 6
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message
        _dispatch_mentor_message = CopilotNativeApp._dispatch_mentor_message

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages"
            assert query == {"student_id": "student-a", "since": "6"}
            assert timeout == 5
            return {
                "items": [{
                    "type": "mentor_message",
                    "student_id": "student-a",
                    "message_id": "msg-7",
                    "id": 7,
                    "text": "Try a smaller example",
                }]
            }

    monkeypatch.setattr(floating_native.AppHelper, "callAfter", fake_call_after)

    CopilotNativeApp._fetch_mentor_catchup(FakeApp())

    assert len(calls) == 1
    func, args = calls[0]
    assert func.__func__ is CopilotNativeApp._handle_mentor_message
    assert args[0]["message_id"] == "msg-7"


def test_poll_current_session_prefers_local_workbuddy_detection(monkeypatch):
    refreshed = []
    server_calls = []

    def fake_read_sessions(limit):
        assert limit == 1000
        return [
            {
                "session_id": "sess-current",
                "title": "当前任务",
                "work_dir": "/work/current",
                "last_activity_at": 20.0,
            },
            {
                "session_id": "sess-old",
                "title": "旧任务",
                "work_dir": "/work/old",
                "last_activity_at": 10.0,
            },
        ]

    class FakeApp:
        _read_local_current_session = CopilotNativeApp._read_local_current_session
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_

        def __init__(self):
            self._student_id = "student-a"
            self._current_session_id = None
            self._panel_visible = False
            self._wb_sessions = []
            self._sessions = {}

        def _get_json(self, path, *, timeout):
            server_calls.append(path)
            raise AssertionError("local detection should avoid server current_session")

        def _refresh_data(self):
            refreshed.append(self._current_session_id)

        def _rebuild_session_bar(self):
            raise AssertionError("panel is hidden")

        def _update_icon_state(self):
            raise AssertionError("panel is hidden")

    monkeypatch.setattr(floating_native.wb_sync, "read_sessions", fake_read_sessions)

    app = FakeApp()
    app.pollCurrentSession_(None)

    assert app._current_session_id == "sess-current"
    assert refreshed == ["sess-current"]
    assert server_calls == []
    assert app._wb_sessions[0]["session_id"] == "sess-current"
    assert app._wb_sessions[0]["is_active"] is True


def test_poll_keeps_manual_selection_while_panel_is_open_when_local_active_changes():
    rebuilt = []

    class FakeApp:
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_
        _current_session_id = "manual-session"
        _panel_visible = True
        _wb_sessions = []
        _sessions = {}
        _sessions_list = []

        def _read_local_current_session(self):
            return {
                "session_id": "new-active",
                "items": [
                    {
                        "session_id": "new-active",
                        "session_title": "新活跃任务",
                        "group_type": "task",
                        "last_activity_at": 20,
                        "is_active": True,
                    },
                    {
                        "session_id": "manual-session",
                        "session_title": "学员正在查看",
                        "group_type": "task",
                        "last_activity_at": 10,
                        "is_active": False,
                    },
                ],
            }

        def _get_json(self, path, *, timeout):
            raise AssertionError("有本地会话时不应请求 current_session")

        def _rebuild_session_bar(self):
            rebuilt.append(self._current_session_id)

        def _update_icon_state(self):
            pass

    app = FakeApp()
    app.pollCurrentSession_(None)

    assert app._current_session_id == "manual-session"
    assert [item["session_id"] for item in app._wb_sessions] == [
        "new-active",
        "manual-session",
    ]
    assert rebuilt == ["manual-session"]


def test_poll_with_unchanged_local_inventory_does_not_rebuild_large_selector():
    sessions = [{
        "session_id": "session-1",
        "session_title": "同一任务",
        "group_type": "task",
        "space_name": "",
        "last_activity_at": 20,
        "is_active": True,
    }]

    class FakeApp:
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_
        _current_session_id = "session-1"
        _panel_visible = True
        _wb_sessions = list(sessions)
        _sessions_list = list(sessions)
        _rendered_session_signature = floating_native._session_selector_render_signature(
            sessions,
            {"session-1": {"title": "同一任务", "unread": 0}},
            "session-1",
        )
        _sessions = {"session-1": {"title": "同一任务", "unread": 0}}

        def _read_local_current_session(self):
            return {"session_id": "session-1", "items": list(sessions)}

        def _get_json(self, path, *, timeout):
            raise AssertionError("不应请求服务端")

        def _rebuild_session_bar(self):
            raise AssertionError("会话签名未变，不应重建 1000 项下拉框")

        def _update_icon_state(self):
            raise AssertionError("无状态变化时不应重算图标")

    FakeApp().pollCurrentSession_(None)


def test_poll_timestamp_changes_without_order_change_does_not_rebuild_selector():
    rendered_sessions = [
        {
            "session_id": "session-newer",
            "session_title": "新任务",
            "group_type": "task",
            "space_name": "",
            "last_activity_at": 20,
            "is_active": True,
        },
        {
            "session_id": "session-older",
            "session_title": "旧任务",
            "group_type": "task",
            "space_name": "",
            "last_activity_at": 10,
            "is_active": False,
        },
    ]
    polled_sessions = [
        {**rendered_sessions[0], "last_activity_at": 22},
        {**rendered_sessions[1], "last_activity_at": 11},
    ]

    class FakeApp:
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_
        _current_session_id = "session-newer"
        _panel_visible = True
        _wb_sessions = list(rendered_sessions)
        _sessions_list = list(rendered_sessions)
        _rendered_session_signature = (
            ("session-newer", "新任务", "任务", "", True, 0, True),
            ("session-older", "旧任务", "任务", "", False, 0, False),
        )
        _sessions = {
            "session-newer": {"title": "新任务", "unread": 0},
            "session-older": {"title": "旧任务", "unread": 0},
        }

        def _read_local_current_session(self):
            return {"session_id": "session-newer", "items": list(polled_sessions)}

        def _rebuild_session_bar(self):
            raise AssertionError("时间戳变化未改变排序时不应重建选择器")

        def _update_icon_state(self):
            raise AssertionError("菜单呈现未变时不应重算图标")

    FakeApp().pollCurrentSession_(None)


def test_poll_timestamp_change_that_reorders_sessions_rebuilds_selector():
    rendered_sessions = [
        {
            "session_id": "session-first",
            "session_title": "任务一",
            "group_type": "task",
            "space_name": "",
            "last_activity_at": 20,
            "is_active": True,
        },
        {
            "session_id": "session-second",
            "session_title": "任务二",
            "group_type": "task",
            "space_name": "",
            "last_activity_at": 10,
            "is_active": False,
        },
    ]
    polled_sessions = [
        dict(rendered_sessions[0]),
        {**rendered_sessions[1], "last_activity_at": 30},
    ]
    rebuilt = []

    class FakeApp:
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_
        _current_session_id = "session-first"
        _panel_visible = True
        _wb_sessions = list(rendered_sessions)
        _sessions_list = list(rendered_sessions)
        _rendered_session_signature = (
            ("session-first", "任务一", "任务", "", True, 0, True),
            ("session-second", "任务二", "任务", "", False, 0, False),
        )
        _sessions = {
            "session-first": {"title": "任务一", "unread": 0},
            "session-second": {"title": "任务二", "unread": 0},
        }

        def _read_local_current_session(self):
            # Keep the active marker stable so this test isolates ordering only.
            return {"session_id": "session-first", "items": list(polled_sessions)}

        def _rebuild_session_bar(self):
            rebuilt.append([item["session_id"] for item in self._sessions_list])

        def _update_icon_state(self):
            pass

    FakeApp().pollCurrentSession_(None)

    assert rebuilt == [["session-second", "session-first"]]


def test_server_current_session_fallback_never_becomes_local_selector_inventory(
    monkeypatch,
):
    requests = []
    server_history = [{
        "session_id": "server-history",
        "session_title": "服务端历史",
        "group_type": "task",
        "last_activity_at": 99,
        "is_active": True,
    }]

    class FakeApp:
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_
        _current_session_id = "manual-session"
        _panel_visible = True
        _wb_sessions = []
        _sessions = {}
        _sessions_list = []
        _student_id = "student-a"
        _poll_fallback_inflight = False
        _poll_fallback_generation = 0

        def _read_local_current_session(self):
            return None

        def _get_json(self, path, *, query, timeout):
            assert path == "/current_session"
            requests.append(dict(query))
            return {"session_id": "server-history", "items": server_history}

        def _rebuild_session_bar(self):
            pass

        def _update_icon_state(self):
            pass

    class ImmediateThread:
        def __init__(self, *, target, args, daemon):
            self.target = target
            self.args = args

        def start(self):
            self.target(*self.args)

    monkeypatch.setattr(floating_native.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: func(*args),
    )

    app = FakeApp()
    app.pollCurrentSession_(None)

    assert requests == [{"student_id": "student-a"}]
    assert app._current_session_id == "manual-session"
    assert app._wb_sessions == []
    assert app._sessions_list == []
    assert floating_native._analysis_empty_state(
        app._wb_sessions,
        app._current_session_id,
        {"server-history"},
        True,
        "ready",
    ) == "no_local_sessions"


def test_server_current_session_fallback_is_singleflight_and_never_blocks_timer(monkeypatch):
    main_thread_id = threading.get_ident()
    network_thread_ids = []
    callbacks = []
    callback_ready = threading.Event()
    refreshed = []

    class FakeApp:
        pollCurrentSession_ = CopilotNativeApp.pollCurrentSession_
        _current_session_id = None
        _panel_visible = False
        _wb_sessions = []
        _sessions_list = []
        _sessions = {}
        _poll_fallback_inflight = False
        _poll_fallback_generation = 0
        _student_id = "student-a"

        def _read_local_current_session(self):
            return None

        def _get_json(self, path, *, query, timeout):
            assert path == "/current_session"
            assert query == {"student_id": "student-a"}
            network_thread_ids.append(threading.get_ident())
            time.sleep(0.12)
            return {
                "session_id": "server-active",
                "items": [{"session_id": "server-active"}],
            }

        def _refresh_data(self):
            refreshed.append(self._current_session_id)

        def _rebuild_session_bar(self):
            pass

        def _update_icon_state(self):
            pass

    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: (callbacks.append((func, args)), callback_ready.set()),
    )

    app = FakeApp()
    started = time.monotonic()
    app.pollCurrentSession_(None)
    app.pollCurrentSession_(None)
    elapsed = time.monotonic() - started

    assert elapsed < 0.05
    assert callback_ready.wait(1.0)
    assert network_thread_ids == [network_thread_ids[0]]
    assert network_thread_ids[0] != main_thread_id

    func, args = callbacks.pop(0)
    func(*args)
    assert app._current_session_id == "server-active"
    assert refreshed == ["server-active"]
    assert app._poll_fallback_inflight is False


def test_server_current_session_request_is_scoped_and_fails_closed_without_identity():
    requests = []

    class FakeApp:
        _student_id = "student-a"

        def _get_json(self, path, *, query, timeout):
            requests.append((path, dict(query), timeout))
            return {"session_id": "session-a", "items": []}

    assert CopilotNativeApp._get_scoped_server_current_session(FakeApp()) == {
        "session_id": "session-a",
        "items": [],
    }
    assert requests == [
        ("/current_session", {"student_id": "student-a"}, 3)
    ]

    requests.clear()
    empty = FakeApp()
    empty._student_id = "  "
    assert CopilotNativeApp._get_scoped_server_current_session(empty) is None
    assert requests == []


def test_refresh_does_not_fill_local_selector_from_server_history(monkeypatch):
    rebuilt = []
    callbacks = []
    ready = threading.Event()

    class FakeApp:
        _student_id = "student-a"
        _current_session_id = "server-history"
        _wb_sessions = []
        _sessions = {}
        _items = []
        _mentor_items = []
        _llm_status = "ready"

        def _get_json(self, path, *, query, timeout):
            if path == "/sessions":
                return {"items": [{
                    "session_id": "server-history",
                    "session_title": "仅服务端存在",
                    "group_type": "task",
                    "last_activity_at": 99,
                }]}
            if path == "/recent":
                return {"items": []}
            raise AssertionError(path)

        def _rebuild_session_bar(self):
            rebuilt.append(list(self._sessions_list))

        def _rebuild_cards(self):
            pass

        def _update_icon_state(self):
            pass

    app = FakeApp()
    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: (callbacks.append((func, args)), ready.set()),
    )
    CopilotNativeApp._refresh_data(app)
    assert ready.wait(1.0)
    func, args = callbacks.pop(0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", floating_native.objc.ObjCPointerWarning)
        func(*args)

    assert app._synced_session_ids == {"server-history"}
    assert app._sessions_list == []
    assert rebuilt == []


def test_refresh_consumes_real_student_capability_status_and_guidance(monkeypatch):
    callbacks = []
    requests = []

    class FakeApp:
        def _get_json(self, path, *, query, timeout):
            requests.append((path, dict(query)))
            if path == "/sessions":
                return {"items": [{"session_id": "session-1"}]}
            if path == "/recent":
                return {"items": [], "context_status": "ready"}
            if path == "/api/student/capabilities":
                return {
                    "llm_status": "missing_api_key",
                    "retry_guidance": "请配置模型密钥后重试。",
                }
            raise AssertionError(path)

    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: callbacks.append((func, args)),
    )

    app = FakeApp()
    CopilotNativeApp._refresh_data_worker(
        app,
        3,
        "student-a",
        "session-1",
        [{"session_id": "session-1"}],
        "unknown",
    )

    assert [path for path, _query in requests] == [
        "/api/student/capabilities",
        "/sessions",
        "/recent",
    ]
    assert all(query["student_id"] == "student-a" for _path, query in requests)
    _func, args = callbacks[0]
    result = args[1]
    assert result["llm_status"] == "missing_api_key"
    assert result["llm_retry_guidance"] == "请配置模型密钥后重试。"


def test_legacy_refresh_without_capability_fields_is_unknown_not_ready(monkeypatch):
    callbacks = []

    class FakeApp:
        def _get_json(self, path, *, query, timeout):
            if path == "/sessions":
                return {"items": []}
            if path == "/recent":
                return {"items": []}
            if path == "/api/student/capabilities":
                return {}
            raise AssertionError(path)

    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: callbacks.append((func, args)),
    )

    CopilotNativeApp._refresh_data_worker(
        FakeApp(), 1, "student-a", "", [], "unknown"
    )

    _func, args = callbacks[0]
    assert args[1]["llm_status"] == "unknown"
    assert "未报告" in args[1]["llm_retry_guidance"]


def test_refresh_with_empty_student_id_fails_closed_without_any_network_request(monkeypatch):
    network_calls = []
    callbacks = []

    class FakeApp:
        def _get_json(self, *args, **kwargs):
            network_calls.append((args, kwargs))
            raise AssertionError("缺少 student_id 时不得发起请求")

    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: callbacks.append((func, args)),
    )

    CopilotNativeApp._refresh_data_worker(FakeApp(), 1, "", "", [], "ready")

    assert network_calls == []
    assert len(callbacks) == 1
    func, args = callbacks[0]
    assert func.__func__ is CopilotNativeApp._apply_refresh_failure
    assert args[1] == "MissingStudentId"


def test_refresh_failure_clears_stale_analysis_and_renders_service_unavailable(monkeypatch):
    container = floating_native.NSView.alloc().initWithFrame_(
        floating_native.NSMakeRect(0, 0, 356, 240)
    )

    class FakeApp:
        _student_id = "student-a"
        _current_session_id = "session-1"
        _wb_sessions = [{"session_id": "session-1"}]
        _synced_session_ids = {"session-1"}
        _sessions = {"session-1": {"unread": 0}}
        _items = [{
            "event": "Stop",
            "created_at": 1,
            "raw": json.dumps({"topic": "过期分析", "understanding": "low"}),
        }]
        _mentor_items = []
        _llm_status = "ready"
        card_container = container
        _rebuild_cards = CopilotNativeApp._rebuild_cards
        _add_panel_card = CopilotNativeApp._add_panel_card

        def _get_json(self, path, *, query, timeout):
            raise ConnectionError("服务已断开")

    app = FakeApp()
    callbacks = []
    ready = threading.Event()
    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: (callbacks.append((func, args)), ready.set()),
    )
    CopilotNativeApp._refresh_data(app)
    assert ready.wait(1.0)
    func, args = callbacks.pop(0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", floating_native.objc.ObjCPointerWarning)
        func(*args)

    rendered_text = []
    pending = list(container.subviews())
    while pending:
        view = pending.pop()
        pending.extend(list(view.subviews()))
        try:
            rendered_text.append(str(view.stringValue()))
        except Exception:
            pass

    assert app._items == []
    assert app._service_available is False
    assert any("Copilot 服务暂时不可用" in text for text in rendered_text)


def test_refresh_returns_immediately_fetches_in_worker_and_applies_on_main_thread(monkeypatch):
    main_thread_id = threading.get_ident()
    network_thread_ids = []
    apply_thread_ids = []
    callbacks = []
    callback_ready = threading.Event()

    class FakeApp:
        _refresh_data = CopilotNativeApp._refresh_data
        _student_id = "student-a"
        _current_session_id = "session-1"
        _wb_sessions = [{
            "session_id": "session-1",
            "session_title": "本地任务",
            "group_type": "task",
            "last_activity_at": 20,
        }]
        _sessions_list = []
        _sessions = {}
        _items = [{"raw": "old"}]
        _mentor_items = []
        _llm_status = "ready"
        _refresh_inflight = False
        _refresh_request_generation = 0
        _refresh_pending = False

        def _get_json(self, path, *, query, timeout):
            network_thread_ids.append(threading.get_ident())
            time.sleep(0.08)
            if path == "/sessions":
                return {"items": [{"session_id": "session-1"}]}
            return {"items": [{"raw": "new"}], "context_status": "ready"}

        def _rebuild_session_bar(self):
            apply_thread_ids.append(threading.get_ident())

        def _rebuild_cards(self):
            apply_thread_ids.append(threading.get_ident())

        def _update_icon_state(self):
            apply_thread_ids.append(threading.get_ident())

    def capture_call_after(func, *args):
        callbacks.append((func, args))
        callback_ready.set()

    monkeypatch.setattr(floating_native.AppHelper, "callAfter", capture_call_after)

    app = FakeApp()
    started = time.monotonic()
    app._refresh_data()
    elapsed = time.monotonic() - started

    assert elapsed < 0.05
    assert callback_ready.wait(1.0)
    assert network_thread_ids and all(tid != main_thread_id for tid in network_thread_ids)
    assert app._items == [{"raw": "old"}]

    func, args = callbacks.pop(0)
    assert func.__self__ is app
    assert func.__func__ is CopilotNativeApp._apply_refresh_result
    func(*args)

    assert app._items == [{"raw": "new"}]
    assert app._refresh_inflight is False
    assert apply_thread_ids and all(tid == main_thread_id for tid in apply_thread_ids)


def test_refresh_apply_preserves_newer_local_inventory_from_poll(monkeypatch):
    fetch_started = threading.Event()
    release_fetch = threading.Event()
    callback_ready = threading.Event()
    callbacks = []
    rebuilt = []
    original = {
        "session_id": "session-1",
        "session_title": "原任务",
        "group_type": "task",
        "last_activity_at": 10,
    }
    newly_seen = {
        "session_id": "session-new",
        "session_title": "轮询新发现",
        "group_type": "task",
        "last_activity_at": 20,
    }

    class FakeApp:
        _student_id = "student-a"
        _current_session_id = "session-1"
        _wb_sessions = [original]
        _sessions_list = [original]
        _sessions = {"session-1": {"title": "原任务", "unread": 0}}
        _items = []
        _mentor_items = []
        _llm_status = "ready"
        _refresh_inflight = False
        _refresh_pending = False
        _refresh_request_generation = 0
        _rendered_session_signature = floating_native._session_selector_render_signature(
            [original],
            {"session-1": {"title": "原任务", "unread": 0}},
            "session-1",
        )

        def _get_json(self, path, *, query, timeout):
            if path == "/sessions":
                fetch_started.set()
                assert release_fetch.wait(1.0)
                return {"items": [{"session_id": "session-1"}]}
            return {"items": []}

        def _rebuild_session_bar(self):
            rebuilt.append([item["session_id"] for item in self._sessions_list])

        def _rebuild_cards(self):
            pass

        def _update_icon_state(self):
            pass

    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: (callbacks.append((func, args)), callback_ready.set()),
    )

    app = FakeApp()
    CopilotNativeApp._refresh_data(app)
    assert fetch_started.wait(1.0)

    # 模拟 worker 期间 pollCurrentSession_ 发现了新的真实本地会话。
    app._wb_sessions = [newly_seen, original]
    app._sessions_list = floating_native._sort_sessions_for_selector(app._wb_sessions)
    release_fetch.set()

    assert callback_ready.wait(1.0)
    func, args = callbacks.pop(0)
    func(*args)

    assert [item["session_id"] for item in app._sessions_list] == [
        "session-new",
        "session-1",
    ]
    assert rebuilt == [["session-new", "session-1"]]


def test_refresh_for_old_session_is_discarded_after_hidden_ws_switch(monkeypatch):
    fetch_started = threading.Event()
    release_fetch = threading.Event()
    callback_ready = threading.Event()
    callbacks = []

    class FakeApp:
        _student_id = "student-a"
        _current_session_id = "session-a"
        _panel_visible = False
        _wb_sessions = [{"session_id": "session-a", "group_type": "task"}]
        _sessions_list = list(_wb_sessions)
        _sessions = {}
        _items = [{"raw": "session-b-existing"}]
        _mentor_items = []
        _context_status = "ready"
        _llm_status = "ready"
        _refresh_inflight = False
        _refresh_pending = False
        _refresh_request_generation = 0

        def _get_json(self, path, *, query, timeout):
            if path == "/sessions":
                fetch_started.set()
                assert release_fetch.wait(1.0)
                return {"items": [{"session_id": "session-a"}]}
            return {
                "items": [{"raw": "stale-session-a"}],
                "context_status": "not_synced",
                "llm_status": "missing_api_key",
            }

        def _update_icon_state(self):
            pass

        def _show_notification(self, result, session_title):
            pass

        def _rebuild_session_bar(self):
            raise AssertionError("过期快照不应重建选择器")

        def _rebuild_cards(self):
            raise AssertionError("过期快照不应重建卡片")

    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: (callbacks.append((func, args)), callback_ready.set()),
    )

    app = FakeApp()
    CopilotNativeApp._refresh_data(app)
    assert fetch_started.wait(1.0)

    CopilotNativeApp._handle_ws_message(app, json.dumps({
        "type": "analysis",
        "session_id": "session-b",
        "session_title": "B",
        "result": {"severity": "info"},
    }))
    assert app._current_session_id == "session-b"

    release_fetch.set()
    assert callback_ready.wait(1.0)
    func, args = callbacks.pop(0)
    func(*args)

    assert app._items == [{"raw": "session-b-existing"}]
    assert app._context_status == "ready"
    assert app._llm_status == "ready"
    assert app._refresh_inflight is False


def test_service_unavailable_keeps_rendered_mentor_message_visible():
    container = floating_native.NSView.alloc().initWithFrame_(
        floating_native.NSMakeRect(0, 0, 356, 240)
    )

    class FakeApp:
        _service_available = False
        _context_status = "service_unavailable"
        _llm_status = "ready"
        _current_session_id = "session-1"
        _wb_sessions = [{"session_id": "session-1"}]
        _synced_session_ids = {"session-1"}
        _items = []
        _mentor_items = [{
            "type": "mentor_message",
            "message_id": "mentor-1",
            "mentor_id": "mentor",
            "text": "已 ACK 的导师建议不能丢",
            "timestamp": 10,
        }]
        card_container = container
        _add_panel_card = CopilotNativeApp._add_panel_card

    app = FakeApp()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", floating_native.objc.ObjCPointerWarning)
        CopilotNativeApp._rebuild_cards(app)

    rendered_text = []
    pending = list(container.subviews())
    while pending:
        view = pending.pop()
        pending.extend(list(view.subviews()))
        try:
            rendered_text.append(str(view.stringValue()))
        except Exception:
            pass

    assert any("服务暂时不可用" in text for text in rendered_text)
    assert any("已 ACK 的导师建议不能丢" in text for text in rendered_text)


def test_mentor_message_coexists_with_every_analysis_empty_state_and_not_synced_actions():
    cases = (
        (
            "no_local_sessions",
            {"_wb_sessions": [], "_synced_session_ids": set(), "_service_available": True, "_llm_status": "ready"},
            "还没有发现 WorkBuddy 对话",
        ),
        (
            "not_synced",
            {"_wb_sessions": [{"session_id": "session-1"}], "_synced_session_ids": set(), "_service_available": True, "_llm_status": "ready"},
            "当前对话尚未同步",
        ),
        (
            "synced_no_analysis",
            {"_wb_sessions": [{"session_id": "session-1"}], "_synced_session_ids": {"session-1"}, "_service_available": True, "_llm_status": "ready"},
            "当前对话已同步",
        ),
        (
            "service_unavailable",
            {"_wb_sessions": [{"session_id": "session-1"}], "_synced_session_ids": {"session-1"}, "_service_available": False, "_llm_status": "ready"},
            "Copilot 服务暂时不可用",
        ),
        (
            "llm_unavailable",
            {"_wb_sessions": [{"session_id": "session-1"}], "_synced_session_ids": {"session-1"}, "_service_available": True, "_llm_status": "missing_api_key"},
            "LLM 暂不可用",
        ),
    )

    for state, state_values, expected_status in cases:
        container = floating_native.NSView.alloc().initWithFrame_(
            floating_native.NSMakeRect(0, 0, 356, 280)
        )

        class FakeApp:
            _context_status = state
            _current_session_id = "session-1"
            _items = []
            _mentor_items = [{
                "type": "mentor_message",
                "message_id": "mentor-1",
                "mentor_id": "mentor",
                "text": "导师卡始终可见",
                "timestamp": 10,
            }]
            _ask_inflight_generation = None
            card_container = container
            _add_panel_card = CopilotNativeApp._add_panel_card

        app = FakeApp()
        for name, value in state_values.items():
            setattr(app, name, value)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", floating_native.objc.ObjCPointerWarning)
            CopilotNativeApp._rebuild_cards(app)

        rendered_text = []
        pending = list(container.subviews())
        while pending:
            view = pending.pop()
            pending.extend(list(view.subviews()))
            try:
                rendered_text.append(str(view.stringValue()))
            except Exception:
                pass

        assert any(expected_status in text for text in rendered_text), state
        assert any("导师卡始终可见" in text for text in rendered_text), state
        if state == "not_synced":
            assert app.sync_then_ask_button is not None
            assert app.ask_without_context_button is not None
            assert app.sync_then_ask_button.title() == "同步最近内容并提问"
            assert app.ask_without_context_button.title() == "不带对话上下文提问"


def test_session_selector_orders_tasks_then_spaces_then_unknown_by_recent_activity():
    sessions = [
        {"session_id": "unknown-new", "group_type": "", "last_activity_at": 99},
        {"session_id": "space-new", "group_type": "space", "last_activity_at": 50},
        {"session_id": "task-old", "group_type": "task", "last_activity_at": 10},
        {"session_id": "task-new", "group_type": "task", "last_activity_at": 60},
        {"session_id": "space-old", "group_type": "space", "last_activity_at": 20},
    ]

    ordered = floating_native._sort_sessions_for_selector(sessions)

    assert [item["session_id"] for item in ordered] == [
        "task-new",
        "task-old",
        "space-new",
        "space-old",
        "unknown-new",
    ]
    assert [item["session_id"] for item in ordered[:3]] == [
        "task-new",
        "task-old",
        "space-new",
    ]


def test_dropdown_and_recent_shortcut_use_the_same_session_selection_path():
    selected = []

    class FakePopup:
        def indexOfSelectedItem(self):
            return 1

    class FakeButton:
        def tag(self):
            return 0

    class FakeApp:
        sessionDropdownChanged_ = CopilotNativeApp.sessionDropdownChanged_
        sessionButtonClicked_ = CopilotNativeApp.sessionButtonClicked_
        _session_popup_ids = ["task-new", "task-old", "space-new"]
        _recent_session_ids = ["task-new", "task-old", "space-new"]

        def _select_session(self, session_id):
            selected.append(session_id)

    app = FakeApp()
    app.sessionDropdownChanged_(FakePopup())
    app.sessionButtonClicked_(FakeButton())

    assert selected == ["task-old", "task-new"]


def test_select_session_keeps_manual_choice_and_refreshes_through_one_method():
    refreshed = []

    class FakeApp:
        _current_session_id = "before"
        _panel_visible = True

        def _sync_session_controls(self):
            refreshed.append(("controls", self._current_session_id))

        def _refresh_data(self):
            refreshed.append(("data", self._current_session_id))

    app = FakeApp()
    CopilotNativeApp._select_session(app, "chosen")

    assert app._current_session_id == "chosen"
    assert refreshed == [("controls", "chosen"), ("data", "chosen")]


def test_select_session_immediately_updates_real_popup_and_recent_button_selection_offline():
    floating_native.NSApplication.sharedApplication()
    session_bar = floating_native.NSView.alloc().initWithFrame_(
        floating_native.NSMakeRect(0, 0, 356, 72)
    )
    sessions = [
        {
            "session_id": "task-a",
            "session_title": "A",
            "group_type": "task",
            "last_activity_at": 20,
        },
        {
            "session_id": "task-b",
            "session_title": "B",
            "group_type": "task",
            "last_activity_at": 10,
        },
    ]

    class FakeApp:
        _rebuild_session_bar = CopilotNativeApp._rebuild_session_bar
        _sync_session_controls = CopilotNativeApp._sync_session_controls
        _sessions_list = sessions
        _sessions = {
            "task-a": {"unread": 0},
            "task-b": {"unread": 0},
        }
        _current_session_id = "task-a"
        _ask_generation = 0

        def _refresh_data(self):
            # 离线时刷新无法启动，但本地选中反馈不能回滚或等待。
            return False

    app = FakeApp()
    app.session_bar = session_bar
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", floating_native.objc.ObjCPointerWarning)
        CopilotNativeApp._rebuild_session_bar(app)
        CopilotNativeApp._select_session(app, "task-b")

    assert app.session_popup.indexOfSelectedItem() == 1
    assert [int(button.state()) for button in app._recent_session_buttons] == [0, 1]


def test_analysis_empty_state_distinguishes_local_sync_service_and_llm_states():
    synced = {"session-1"}

    assert floating_native._analysis_empty_state([], None, synced, True, "ready") == "no_local_sessions"
    assert floating_native._analysis_empty_state(
        [{"session_id": "session-1"}], "session-1", set(), True, "ready"
    ) == "not_synced"
    assert floating_native._analysis_empty_state(
        [{"session_id": "session-1"}], "session-1", synced, True, "ready"
    ) == "synced_no_analysis"
    assert floating_native._analysis_empty_state(
        [{"session_id": "session-1"}], "session-1", synced, False, "ready"
    ) == "service_unavailable"
    assert floating_native._analysis_empty_state(
        [{"session_id": "session-1"}], "session-1", synced, True, "missing_api_key"
    ) == "llm_unavailable"

    for state in (
        "no_local_sessions",
        "not_synced",
        "synced_no_analysis",
        "service_unavailable",
        "llm_unavailable",
    ):
        message = floating_native._empty_state_message(state)
        assert message
        assert "当前对话暂无分析记录" not in message


def test_structured_student_ask_response_explains_context_and_llm_status():
    text, context_status, llm_status = floating_native._format_student_ask_response({
        "answer": "先检查环境。",
        "context_status": "not_synced",
        "llm_status": "missing_api_key",
        "retry_guidance": "请启用 LLM 后重试。",
    })

    assert context_status == "not_synced"
    assert llm_status == "missing_api_key"
    assert "尚未同步" in text
    assert "LLM" in text
    assert "先检查环境。" in text
    assert "请启用 LLM 后重试。" in text


def test_structured_student_ask_response_reports_diagnostics_actually_attached():
    text, _context_status, _llm_status = floating_native._format_student_ask_response({
        "answer": "先检查权限。",
        "context_status": "ready",
        "llm_status": "ready",
        "diagnostics_attached": True,
    })

    assert "本次已附加脱敏诊断信息" in text


def test_structured_student_ask_response_reports_collector_failure_as_not_attached():
    text, _context_status, _llm_status = floating_native._format_student_ask_response({
        "answer": "诊断收集失败后仍然继续回答。",
        "context_status": "ready",
        "llm_status": "ready",
        "diagnostics_attached": False,
    })

    assert "本次未附加诊断信息" in text


def test_structured_student_ask_response_reports_rejected_diagnostic_schema_as_not_attached():
    text, _context_status, _llm_status = floating_native._format_student_ask_response({
        "answer": "诊断包 schema 无效，已忽略诊断包并继续回答。",
        "context_status": "ready",
        "llm_status": "ready",
        "diagnostics_attached": False,
    })

    assert "本次未附加诊断信息" in text


def test_legacy_student_ask_response_remains_compatible():
    text, context_status, llm_status = floating_native._format_student_ask_response({
        "answer": "旧服务返回的答案",
    })

    assert "旧服务返回的答案" in text
    assert "unknown" in text
    assert "未报告 LLM 状态" in text
    assert context_status == "ready"
    assert llm_status == "unknown"


def test_all_context_status_values_are_preserved_and_explained():
    expected_phrases = {
        "ready": None,
        "not_synced": "尚未同步",
        "without_session": "没有选择对话",
        "no_context": "没有可用的对话上下文",
    }

    for status, phrase in expected_phrases.items():
        text, context_status, llm_status = floating_native._format_student_ask_response({
            "answer": "可读回答",
            "context_status": status,
            "llm_status": "ready",
        })
        assert context_status == status
        assert llm_status == "ready"
        assert "可读回答" in text
        if phrase:
            assert phrase in text
        else:
            assert text == "可读回答"


def test_all_llm_status_values_are_preserved_and_nonready_values_are_explained():
    statuses = (
        "ready",
        "disabled",
        "missing_api_key",
        "misconfigured",
        "timeout",
        "upstream_error",
    )

    for status in statuses:
        text, context_status, llm_status = floating_native._format_student_ask_response({
            "answer": "回退答案",
            "context_status": "ready",
            "llm_status": status,
        })
        assert context_status == "ready"
        assert llm_status == status
        assert "回退答案" in text
        if status == "ready":
            assert text == "回退答案"
        else:
            assert f"（{status}）" in text
            assert "LLM 暂不可用" in text


def test_default_diagnostic_collector_calls_student_core_implementation(monkeypatch):
    import copilot.student_core.diagnostics as diagnostics

    calls = []

    def fake_collect():
        calls.append(True)
        return {"version": "diagnostic-bundle/v1", "system": {"os": "test"}}

    monkeypatch.setattr(diagnostics, "collect_diagnostic_bundle", fake_collect)

    assert floating_native._collect_diagnostic_bundle() == {
        "version": "diagnostic-bundle/v1",
        "system": {"os": "test"},
    }
    assert calls == [True]


def test_local_workbuddy_failure_is_recorded_in_real_redacted_diagnostic_ring(monkeypatch):
    import copilot.student_core.diagnostics as diagnostics

    diagnostics.clear_recent_errors()
    monkeypatch.setattr(
        floating_native.wb_sync,
        "read_sessions",
        lambda limit: (_ for _ in ()).throw(
            RuntimeError("token=raw-secret-value /Users/alice/private")
        ),
    )
    try:
        class FakeApp:
            pass

        assert CopilotNativeApp._read_local_current_session(FakeApp()) is None
        bundle = diagnostics.collect_diagnostic_bundle(
            required_env_names=(),
            required_tools=(),
            relevant_paths=(),
        )
        recent = bundle["recent_errors"]
        assert recent[-1]["component"] == "workbuddy_read"
        assert recent[-1]["type"] == "RuntimeError"
        assert "raw-secret-value" not in json.dumps(recent, ensure_ascii=False)
        assert "[REDACTED]" in json.dumps(recent, ensure_ascii=False)
    finally:
        diagnostics.clear_recent_errors()


def test_analysis_panel_diagnostics_checkbox_defaults_on():
    class FakeIconPanel:
        def frame(self):
            return floating_native.NSMakeRect(100, 100, 48, 48)

    floating_native.NSApplication.sharedApplication()
    app = CopilotNativeApp.alloc().init()
    app.icon_panel = FakeIconPanel()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", floating_native.objc.ObjCPointerWarning)
        app._create_analysis_panel()
    try:
        assert app.diagnostics_checkbox.state() == floating_native.NSControlStateValueOn
    finally:
        app.analysis_panel.orderOut_(None)


def test_student_ask_worker_posts_context_and_dispatches_answer(monkeypatch):
    calls = []

    def fake_call_after(func, *args):
        calls.append((func, args))

    class FakeApp:
        _handle_ask_answer = CopilotNativeApp._handle_ask_answer
        _handle_ask_error = CopilotNativeApp._handle_ask_error

        def __init__(self):
            self._student_id = "student-a"

        def _post_json(self, path, payload, *, timeout):
            assert path == "/api/student/ask"
            assert payload == {
                "student_id": "student-a",
                "session_id": "sess-1",
                "question": "怎么定位循环边界？",
                "include_diagnostics": True,
                "diagnostic_bundle": {"environment": {"token": "<redacted>"}},
            }
            assert timeout >= 10
            return {
                "ask_id": 12,
                "answer": "先打印最后一次循环的 index。",
                "context_status": "ready",
                "llm_status": "ready",
            }

    monkeypatch.setattr(floating_native.AppHelper, "callAfter", fake_call_after)
    monkeypatch.setattr(
        floating_native,
        "_collect_diagnostic_bundle",
        lambda: {"environment": {"token": "<redacted>"}},
    )

    app = FakeApp()
    CopilotNativeApp._send_student_ask_worker(app, "怎么定位循环边界？", "sess-1", True)

    assert len(calls) == 1
    func, args = calls[0]
    assert func.__self__ is app
    assert func.__func__ is CopilotNativeApp._handle_ask_answer
    assert args == (
        "怎么定位循环边界？",
        "先打印最后一次循环的 index。",
        12,
        "ready",
        "ready",
    )


def test_student_ask_worker_omits_diagnostic_bundle_when_checkbox_is_off(monkeypatch):
    posted = []
    calls = []

    class FakeApp:
        _student_id = "student-a"
        _handle_ask_answer = CopilotNativeApp._handle_ask_answer
        _handle_ask_error = CopilotNativeApp._handle_ask_error

        def _post_json(self, path, payload, *, timeout):
            posted.append(payload)
            return {"ask_id": 3, "answer": "不带诊断也可以回答。"}

    monkeypatch.setattr(
        floating_native,
        "_collect_diagnostic_bundle",
        lambda: (_ for _ in ()).throw(AssertionError("不应收集诊断")),
    )
    monkeypatch.setattr(
        floating_native.AppHelper,
        "callAfter",
        lambda func, *args: calls.append((func, args)),
    )

    CopilotNativeApp._send_student_ask_worker(FakeApp(), "hi", "sess-1", False)

    assert posted == [{
        "student_id": "student-a",
        "question": "hi",
        "session_id": "sess-1",
        "include_diagnostics": False,
    }]
    assert "不带诊断也可以回答。" in calls[0][1][1]
    assert "unknown" in calls[0][1][1]


def test_sync_then_ask_worker_uploads_selected_session_before_asking(monkeypatch):
    events = []

    def fake_upload(cfg, student_id, mode, *, session_id):
        events.append(("upload", cfg, student_id, mode, session_id))
        return {"total": 1, "synced": 1, "skipped": 0, "failed": 0}

    class FakeApp:
        cfg = {"student_id": "student-a"}
        _student_id = "student-a"

        def _send_student_ask_worker(
            self, question, session_id, include_diagnostics, context_mode=None
        ):
            events.append((
                "ask", question, session_id, include_diagnostics, context_mode
            ))

    monkeypatch.setattr(floating_native.wb_upload, "upload_conversations", fake_upload)

    app = FakeApp()
    CopilotNativeApp._sync_then_send_student_ask_worker(
        app, "为什么失败？", "sess-1", True
    )

    assert events == [
        ("upload", app.cfg, "student-a", "missing", "sess-1"),
        ("ask", "为什么失败？", "sess-1", True, "sync_then_ask"),
    ]


def test_without_session_context_mode_is_explicit_and_omits_session(monkeypatch):
    posted = []

    class FakeApp:
        _student_id = "student-a"
        _handle_ask_answer = CopilotNativeApp._handle_ask_answer
        _handle_ask_error = CopilotNativeApp._handle_ask_error

        def _post_json(self, path, payload, *, timeout):
            posted.append(payload)
            return {"answer": "已不带对话回答。", "context_status": "without_session"}

    monkeypatch.setattr(
        floating_native.AppHelper, "callAfter", lambda func, *args: None
    )

    CopilotNativeApp._send_student_ask_worker(
        FakeApp(), "hi", None, False, "without_session"
    )

    assert posted == [{
        "student_id": "student-a",
        "question": "hi",
        "include_diagnostics": False,
        "context_mode": "without_session",
    }]


def test_copy_answer_action_writes_the_complete_visible_answer(monkeypatch):
    copied = []

    class FakeAnswerView:
        def string(self):
            return "你问：hi\n\nCopilot：完整回答"

    class FakeApp:
        copyAnswerClicked_ = CopilotNativeApp.copyAnswerClicked_
        ask_answer_view = FakeAnswerView()

    monkeypatch.setattr(
        floating_native,
        "_copy_text_to_pasteboard",
        lambda text, pasteboard=None: copied.append(text) or True,
    )

    FakeApp().copyAnswerClicked_(None)

    assert copied == ["你问：hi\n\nCopilot：完整回答"]


def test_single_inflight_guard_blocks_second_ask_across_all_entry_paths(monkeypatch):
    threads = []

    class FakeThread:
        def __init__(self, *, target, args, daemon):
            threads.append((target, args, daemon))

        def start(self):
            pass

    class FakeApp:
        _student_id = "student-a"
        _current_session_id = "session-1"
        _ask_generation = 0
        _ask_inflight_generation = None
        controls = []
        answers = []

        def _diagnostics_enabled(self):
            return True

        def _set_ask_controls_enabled(self, enabled):
            self.controls.append(enabled)

        def _set_ask_answer_text(self, text):
            self.answers.append(text)

        def _send_student_ask_worker(self, *args):
            raise AssertionError("fake thread must not execute")

    monkeypatch.setattr(floating_native.threading, "Thread", FakeThread)

    app = FakeApp()
    first = CopilotNativeApp._start_student_ask(app, "first", "session-1")
    second = CopilotNativeApp._start_student_ask(
        app, "second", None, context_mode="without_session"
    )

    assert first is True
    assert second is False
    assert len(threads) == 1
    assert app._ask_inflight_generation == 1
    assert app.controls == [False]
    assert any("正在处理" in text for text in app.answers)


def test_student_ask_start_with_empty_student_id_fails_closed_before_thread_or_http(monkeypatch):
    threads = []

    class FakeThread:
        def __init__(self, **kwargs):
            threads.append(kwargs)

        def start(self):
            raise AssertionError("缺少 student_id 时不得启动请求线程")

    class FakeApp:
        _student_id = ""
        _ask_generation = 0
        _ask_inflight_generation = None
        answers = []

        def _set_ask_answer_text(self, text):
            self.answers.append(text)

        def _set_ask_controls_enabled(self, enabled):
            raise AssertionError("不应进入请求中状态")

    monkeypatch.setattr(floating_native.threading, "Thread", FakeThread)

    app = FakeApp()
    assert CopilotNativeApp._start_student_ask(app, "hi", None) is False
    assert threads == []
    assert app._ask_inflight_generation is None
    assert any("student_id" in text for text in app.answers)


def test_late_ask_callback_cannot_overwrite_new_session_answer_or_status():
    rendered = []
    controls = []

    class FakeApp:
        _current_session_id = "session-2"
        _ask_generation = 2
        _ask_inflight_generation = 2
        _items = [{"raw": "keep cards stable"}]
        _service_available = True
        _context_status = "ready"
        _llm_status = "ready"

        def _set_ask_controls_enabled(self, enabled):
            controls.append(enabled)

        def _set_ask_answer_text(self, text):
            rendered.append(text)

        def _end_ask_focus(self):
            pass

    app = FakeApp()
    CopilotNativeApp._handle_ask_answer(
        app,
        "new question",
        "new answer",
        2,
        "ready",
        "ready",
        2,
        "session-2",
    )
    assert rendered[-1].endswith("new answer")

    app._ask_inflight_generation = 1
    CopilotNativeApp._handle_ask_answer(
        app,
        "old question",
        "old answer",
        1,
        "not_synced",
        "missing_api_key",
        1,
        "session-1",
    )

    assert rendered == ["你问：new question\n\nCopilot：new answer"]
    assert app._context_status == "ready"
    assert app._llm_status == "ready"
    assert controls == [True, True]


def test_end_ask_focus_keeps_panel_keyboard_focus_available_for_text_selection():
    focus_values = []

    class FakePanel:
        def makeFirstResponder_(self, responder):
            assert responder is None

        def setAllowsKeyboardFocus_(self, value):
            focus_values.append(value)

    class FakeApp:
        analysis_panel = FakePanel()

    CopilotNativeApp._end_ask_focus(FakeApp())

    assert focus_values == [True]


def test_student_ask_worker_dispatches_friendly_error(monkeypatch):
    calls = []

    def fake_call_after(func, *args):
        calls.append((func, args))

    class FakeApp:
        _handle_ask_answer = CopilotNativeApp._handle_ask_answer
        _handle_ask_error = CopilotNativeApp._handle_ask_error

        def __init__(self):
            self._student_id = "student-a"

        def _post_json(self, path, payload, *, timeout):
            raise TimeoutError("too slow")

    monkeypatch.setattr(floating_native.AppHelper, "callAfter", fake_call_after)

    app = FakeApp()
    CopilotNativeApp._send_student_ask_worker(app, "为什么失败？", "sess-1")

    assert len(calls) == 1
    func, args = calls[0]
    assert func.__self__ is app
    assert func.__func__ is CopilotNativeApp._handle_ask_error
    assert "暂时没能连接" in args[0]


def test_mentor_message_acks_only_after_render_and_state_save():
    class FakeApp:
        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._pending_receipt_message_ids = set()
            self._last_seen_mentor_message_id = 0
            self.rendered = []
            self.saved = []
            self.acked = []

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _save_mentor_message_state(self):
            self.saved.append(self._last_seen_mentor_message_id)

        def _ack_mentor_message(self, message_id):
            self.acked.append((message_id, list(self.rendered), list(self.saved)))

    app = FakeApp()

    CopilotNativeApp._handle_mentor_message(app, {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "msg-1",
        "id": 7,
        "text": "Try a smaller example",
        "mentor_id": "mentor-1",
        "timestamp": 12.0,
    })

    assert app.rendered == ["msg-1"]
    assert app.saved == [7]
    assert app.acked == [("msg-1", ["msg-1"], [7])]
    assert app._seen_mentor_message_ids == {"msg-1"}
    assert app._pending_receipt_message_ids == {"msg-1"}
    assert app._last_seen_mentor_message_id == 7


def test_duplicate_acknowledged_mentor_message_does_not_retry_receipt_or_render():
    class FakeApp:
        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = {"msg-1"}
            self._pending_receipt_message_ids = set()
            self._last_seen_mentor_message_id = 7
            self.rendered: list[str] = []
            self.acked: list[str] = []

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _ack_mentor_message(self, message_id):
            self.acked.append(message_id)

    app = FakeApp()
    CopilotNativeApp._handle_mentor_message(app, {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "msg-1",
        "id": 7,
        "text": "Retry only the receipt",
    })

    assert app.rendered == []
    assert app.acked == []


def test_duplicate_pending_mentor_message_retries_only_receipt_without_rendering_again():
    class FakeApp:
        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = {"msg-1"}
            self._pending_receipt_message_ids = {"msg-1"}
            self._last_seen_mentor_message_id = 7
            self.rendered: list[str] = []
            self.acked: list[str] = []

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _ack_mentor_message(self, message_id):
            self.acked.append(message_id)

    app = FakeApp()
    CopilotNativeApp._handle_mentor_message(app, {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "msg-1",
        "id": 7,
        "text": "Retry only the pending receipt",
    })

    assert app.rendered == []
    assert app.acked == ["msg-1"]


def test_ack_does_not_post_unknown_unrendered_message():
    class FakeApp:
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._pending_receipt_message_ids = {"known-message"}
            self.posted: list[str] = []
            self.saves = 0

        def _post_json(self, path, payload, *, timeout):
            self.posted.append(payload["message_id"])
            return {"ok": True}

        def _save_mentor_message_state(self):
            self.saves += 1

    app = FakeApp()

    assert app._ack_mentor_message("unknown-message") is False
    assert app.posted == []
    assert app._pending_receipt_message_ids == {"known-message"}
    assert app.saves == 0


def test_pending_receipt_catchup_retries_503_then_recovers_without_duplicate_render():
    class FakeApp:
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = {"msg-7"}
            self._pending_receipt_message_ids = {"msg-7"}
            self._last_seen_mentor_message_id = 7
            self.post_attempts = 0
            self.rendered: list[str] = []
            self.saved = 0

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages/pending-receipts"
            assert query == {
                "student_id": "student-a",
                "limit": "64",
                "after_id": "0",
            }
            assert timeout == 5
            return {"items": [{
                "type": "mentor_message",
                "student_id": "student-a",
                "message_id": "msg-7",
                "id": 7,
                "text": "Retry the persisted receipt",
            }]}

        def _post_json(self, path, payload, *, timeout):
            assert path == "/api/student/messages/ack"
            assert payload == {"student_id": "student-a", "message_id": "msg-7"}
            assert timeout == 3
            self.post_attempts += 1
            if self.post_attempts == 1:
                raise TimeoutError("503 while offline")
            return {"ok": True}

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _save_mentor_message_state(self):
            self.saved += 1

    app = FakeApp()
    CopilotNativeApp._fetch_pending_mentor_receipts(app)
    CopilotNativeApp._fetch_pending_mentor_receipts(app)

    assert app.post_attempts == 2
    assert app.rendered == []
    assert app._seen_mentor_message_ids == {"msg-7"}
    assert app._pending_receipt_message_ids == set()
    assert app.saved == 1


def test_mentor_message_no_ack_when_render_fails():
    class FakeApp:
        _student_id = "student-a"
        _seen_mentor_message_ids = set()
        _pending_receipt_message_ids = set()
        _last_seen_mentor_message_id = 0

        def __init__(self):
            self.acked = []

        def _render_mentor_message(self, item):
            return False

        def _save_mentor_message_state(self):
            raise AssertionError("state should not save before render")

        def _ack_mentor_message(self, message_id):
            self.acked.append(message_id)

    app = FakeApp()

    CopilotNativeApp._handle_mentor_message(app, {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "msg-1",
        "id": 7,
        "text": "Try a smaller example",
        "mentor_id": "mentor-1",
        "timestamp": 12.0,
    })

    assert app.acked == []
    assert app._seen_mentor_message_ids == set()
    assert app._last_seen_mentor_message_id == 0


def test_upload_mentor_command_starts_background_upload_without_rendering(monkeypatch):
    started = []
    rendered = []
    notices = []

    class FakeThread:
        def __init__(self, *, target, daemon):
            self.target = target
            self.daemon = daemon

        def start(self):
            started.append(self.daemon)
            self.target()

    def fake_upload(cfg, student_id, *, mode, request_id=None):
        started.append((cfg, student_id, mode, request_id))
        return {"total": 1, "synced": 1, "skipped": 0, "failed": 0}

    def fake_call_after(func, *args):
        notices.append((func.__name__, args))
        func(*args)

    class FakeApp:
        _handle_ws_message = CopilotNativeApp._handle_ws_message
        _handle_mentor_command = CopilotNativeApp._handle_mentor_command
        _handle_mentor_command_upload = CopilotNativeApp._handle_mentor_command_upload
        _show_upload_sync_notice = CopilotNativeApp._show_upload_sync_notice
        _upload_conversations_worker = CopilotNativeApp._upload_conversations_worker

        def __init__(self):
            self.cfg = {"student_id": "student-a"}
            self._student_id = "student-a"

        def _render_mentor_message(self, item):
            rendered.append(item)
            return True

        def _set_ask_answer_text(self, text):
            notices.append(("text", text))

        def _post_upload_request_status(self, request_id, status, **kwargs):
            started.append(("status", request_id, status))

    monkeypatch.setattr(floating_native.threading, "Thread", FakeThread)
    monkeypatch.setattr(floating_native.wb_upload, "upload_conversations", fake_upload)
    monkeypatch.setattr(floating_native.AppHelper, "callAfter", fake_call_after)

    app = FakeApp()
    app._handle_ws_message(
        '{"type":"mentor_command","student_id":"student-a","command":"upload_conversations",'
        '"request_id":"req-real"}'
    )

    assert rendered == []
    assert True in started
    assert ({"student_id": "student-a"}, "student-a", "missing", "req-real") in started
    assert ("text", "导师请求同步对话中...") in notices


def test_upload_mentor_command_reports_running_and_failed_status(monkeypatch):
    posts = []
    notices = []

    class FakeThread:
        def __init__(self, *, target, daemon):
            self.target = target
            self.daemon = daemon

        def start(self):
            self.target()

    def fail_upload(cfg, student_id, *, mode, request_id=None):
        assert request_id == "req-1"
        raise RuntimeError("network unavailable")

    def fake_call_after(func, *args):
        notices.append((func.__name__, args))
        func(*args)

    class FakeApp:
        _handle_mentor_command_upload = CopilotNativeApp._handle_mentor_command_upload
        _show_upload_sync_notice = CopilotNativeApp._show_upload_sync_notice
        _upload_conversations_worker = CopilotNativeApp._upload_conversations_worker
        _post_upload_request_status = CopilotNativeApp._post_upload_request_status

        def __init__(self):
            self.cfg = {"student_id": "student-a"}
            self._student_id = "student-a"

        def _post_json(self, path, payload, *, timeout):
            posts.append((path, payload, timeout))
            return {"ok": True}

        def _set_ask_answer_text(self, text):
            notices.append(("text", text))

    monkeypatch.setattr(floating_native.threading, "Thread", FakeThread)
    monkeypatch.setattr(floating_native.wb_upload, "upload_conversations", fail_upload)
    monkeypatch.setattr(floating_native.AppHelper, "callAfter", fake_call_after)

    app = FakeApp()
    app._handle_mentor_command_upload({
        "type": "mentor_command",
        "student_id": "student-a",
        "command": "upload_conversations",
        "request_id": "req-1",
    })

    assert posts[0] == (
        "/api/student/upload-requests/req-1/status",
        {"student_id": "student-a", "status": "running"},
        5,
    )
    assert posts[1][0] == "/api/student/upload-requests/req-1/status"
    assert posts[1][1]["student_id"] == "student-a"
    assert posts[1][1]["status"] == "failed"
    assert "network unavailable" in posts[1][1]["error_message"]
    assert ("text", "导师请求同步对话中...") in notices


def test_upload_worker_does_not_upload_when_running_status_post_fails(monkeypatch):
    status_calls = []
    upload_calls = []

    class FakeApp:
        _upload_conversations_worker = CopilotNativeApp._upload_conversations_worker

        def __init__(self):
            self.cfg = {"student_id": "student-a"}
            self._student_id = "student-a"
            self._upload_requests_inflight = {"req-weak-network"}

        def _post_upload_request_status(self, request_id, status, **kwargs):
            status_calls.append((request_id, status, kwargs))
            raise ConnectionError(f"cannot post {status}")

    def forbidden_upload(*args, **kwargs):
        upload_calls.append((args, kwargs))
        raise AssertionError("uploader must not run before server accepts running")

    monkeypatch.setattr(floating_native.wb_upload, "upload_conversations", forbidden_upload)

    app = FakeApp()
    app._upload_conversations_worker("req-weak-network")

    assert upload_calls == []
    assert [status for _request_id, status, _kwargs in status_calls] == ["running", "failed"]
    assert app._upload_requests_inflight == set()


def test_mentor_message_state_persists_seen_ids_and_last_seen(tmp_path):
    state_path = tmp_path / "float_state.json"

    class FakeApp:
        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = {"msg-1", "msg-2"}
            self._pending_receipt_message_ids = {"msg-1"}
            self._last_seen_mentor_message_id = 9

        def _mentor_message_state_path(self):
            return str(state_path)

    writer = FakeApp()
    CopilotNativeApp._save_mentor_message_state(writer)

    reader = FakeApp()
    reader._seen_mentor_message_ids = set()
    reader._pending_receipt_message_ids = set()
    reader._last_seen_mentor_message_id = 0
    CopilotNativeApp._load_mentor_message_state(reader)

    assert reader._last_seen_mentor_message_id == 9
    assert reader._seen_mentor_message_ids == {"msg-1", "msg-2"}
    assert reader._pending_receipt_message_ids == {"msg-1"}


def test_persisted_pending_receipts_survive_seen_limit_restart_and_ack_oldest_without_rendering(tmp_path):
    state_path = tmp_path / "float_state.json"
    message_ids = [f"msg-{index:03d}" for index in range(201)]

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message
        _load_mentor_message_state = CopilotNativeApp._load_mentor_message_state
        _save_mentor_message_state = CopilotNativeApp._save_mentor_message_state

        def __init__(self, *, fail_ack: bool):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order: list[str] = []
            self._pending_receipt_message_ids: set[str] = set()
            self._last_seen_mentor_message_id = 0
            self.fail_ack = fail_ack
            self.rendered: list[str] = []
            self.posted: list[str] = []

        def _mentor_message_state_path(self):
            return str(state_path)

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _post_json(self, path, payload, *, timeout):
            assert path == "/api/student/messages/ack"
            assert timeout == 3
            self.posted.append(payload["message_id"])
            if self.fail_ack:
                raise TimeoutError("503 while offline")
            return {"ok": True}

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages/pending-receipts"
            assert query["student_id"] == "student-a"
            assert query["limit"] == "64"
            assert timeout == 5
            if query.get("after_id", "0") == "0":
                return {"items": [{"message_id": message_ids[0], "id": 1}]}
            return {"items": []}

    writer = FakeApp(fail_ack=True)
    for numeric_id, message_id in enumerate(message_ids, start=1):
        writer._handle_mentor_message({
            "type": "mentor_message",
            "student_id": "student-a",
            "message_id": message_id,
            "id": numeric_id,
        })

    restarted = FakeApp(fail_ack=False)
    restarted._load_mentor_message_state()

    assert restarted._pending_receipt_message_ids == set(message_ids)
    assert message_ids[0] not in restarted._seen_mentor_message_ids

    restarted._fetch_pending_mentor_receipts()

    assert restarted.rendered == []
    assert restarted.posted == message_ids[:65]
    assert restarted._pending_receipt_message_ids == set(message_ids[65:])


def test_pending_receipt_recovery_pages_past_64_messages_without_rendering():
    message_ids = [f"msg-{index:03d}" for index in range(201)]

    class FakeApp:
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._pending_receipt_message_ids = set(message_ids)
            self._last_seen_mentor_message_id = 201
            self.server_pending = [
                {"message_id": message_id, "id": index}
                for index, message_id in enumerate(message_ids, start=1)
            ]
            self.fetches = 0
            self.posted: list[str] = []
            self.rendered: list[str] = []
            self.saves = 0

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages/pending-receipts"
            assert query["student_id"] == "student-a"
            assert query["limit"] == "64"
            assert timeout == 5
            self.fetches += 1
            after_id = int(query.get("after_id", "0"))
            return {
                "items": [
                    dict(item)
                    for item in self.server_pending
                    if item["id"] > after_id
                ][:64]
            }

        def _post_json(self, path, payload, *, timeout):
            assert path == "/api/student/messages/ack"
            assert timeout == 3
            message_id = payload["message_id"]
            self.posted.append(message_id)
            self.server_pending = [
                item for item in self.server_pending if item["message_id"] != message_id
            ]
            return {"ok": True}

        def _save_mentor_message_state(self):
            self.saves += 1

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

    app = FakeApp()
    app._fetch_pending_mentor_receipts()

    assert app.posted == message_ids
    assert app.server_pending == []
    assert app._pending_receipt_message_ids == set()
    assert app.fetches == 4
    assert app.rendered == []
    assert app.saves == 201


def test_pending_receipt_cursor_scans_past_unknown_first_page_without_rendering():
    unknown_items = [
        {"message_id": f"unknown-{index}", "id": index}
        for index in range(1, 65)
    ]
    known_item = {"message_id": "rendered-65", "id": 65}

    class FakeApp:
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._pending_receipt_message_ids = {"rendered-65"}
            self._pending_receipt_after_id = 0
            self._receipt_ack_inflight_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self.fetch_after_ids: list[int] = []
            self.posted: list[str] = []
            self.rendered: list[str] = []

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages/pending-receipts"
            assert timeout == 5
            after_id = int(query["after_id"])
            self.fetch_after_ids.append(after_id)
            all_items = unknown_items + [known_item]
            return {"items": [item for item in all_items if item["id"] > after_id][:64]}

        def _post_json(self, path, payload, *, timeout):
            assert path == "/api/student/messages/ack"
            assert payload["message_id"] == "rendered-65"
            self.posted.append(payload["message_id"])
            return {"ok": True}

        def _save_mentor_message_state(self):
            return None

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

    app = FakeApp()
    app._fetch_pending_mentor_receipts()

    assert app.fetch_after_ids[:2] == [0, 64]
    assert app.posted == ["rendered-65"]
    assert app._pending_receipt_message_ids == set()
    assert app.rendered == []


def test_empty_cursor_scan_retries_persisted_receipt_after_lost_ack_response():
    class FakeApp:
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._pending_receipt_message_ids = {"rendered-message"}
            self._pending_receipt_after_id = 0
            self._receipt_ack_inflight_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self.posted: list[str] = []
            self.saves = 0

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages/pending-receipts"
            assert query["after_id"] == "0"
            return {"items": []}

        def _post_json(self, path, payload, *, timeout):
            assert path == "/api/student/messages/ack"
            self.posted.append(payload["message_id"])
            return {"ok": True}

        def _save_mentor_message_state(self):
            self.saves += 1

    app = FakeApp()

    assert app._fetch_pending_mentor_receipts() is False
    assert app.posted == ["rendered-message"]
    assert app._pending_receipt_message_ids == set()
    assert app.saves == 1


def test_failed_stable_ws_ack_wakes_the_single_throttled_retry_task():
    class RunningLoop:
        def __init__(self):
            self.callbacks = []

        def is_running(self):
            return True

        def call_soon_threadsafe(self, callback):
            self.callbacks.append(callback)

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order = []
            self._pending_receipt_message_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 0
            self._ws_asyncio_loop = RunningLoop()
            self._pending_receipt_retry_task = None
            self.rendered: list[str] = []

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _save_mentor_message_state(self):
            return None

        def _ack_mentor_message(self, message_id):
            assert message_id == "message-1"
            return False

    app = FakeApp()
    app._handle_mentor_message({
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    })

    assert app.rendered == ["message-1"]
    assert app._pending_receipt_message_ids == {"message-1"}
    assert len(app._ws_asyncio_loop.callbacks) == 1


def test_pending_receipt_retry_continues_past_single_sync_budget_without_busy_loop(monkeypatch):
    message_ids = [f"message-{index}" for index in range(513)]
    monkeypatch.setattr(floating_native, "PENDING_RECEIPT_RETRY_DELAY_SECONDS", 0, raising=False)

    class FakeApp:
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._pending_receipt_message_ids = set(message_ids)
            self._pending_receipt_after_id = 0
            self._receipt_ack_inflight_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self.server_pending = [
                {"message_id": message_id, "id": index}
                for index, message_id in enumerate(message_ids, start=1)
            ]
            self.posted: list[str] = []
            self.saves = 0

        def _get_json(self, path, *, query, timeout):
            after_id = int(query["after_id"])
            return {
                "items": [
                    dict(item)
                    for item in self.server_pending
                    if item["id"] > after_id
                ][:64]
            }

        def _post_json(self, path, payload, *, timeout):
            message_id = payload["message_id"]
            self.posted.append(message_id)
            self.server_pending = [
                item for item in self.server_pending if item["message_id"] != message_id
            ]
            return {"ok": True}

        def _save_mentor_message_state(self):
            self.saves += 1

    assert hasattr(CopilotNativeApp, "_retry_pending_receipts_until_settled")
    FakeApp._retry_pending_receipts_until_settled = CopilotNativeApp._retry_pending_receipts_until_settled
    app = FakeApp()
    asyncio.run(app._retry_pending_receipts_until_settled())

    assert app.posted == message_ids
    assert app._pending_receipt_message_ids == set()
    assert app.server_pending == []


def test_pending_receipt_continuation_waits_once_per_bounded_retry_round(monkeypatch):
    waits: list[float] = []

    async def fake_sleep(delay):
        waits.append(delay)

    monkeypatch.setattr(floating_native.asyncio, "sleep", fake_sleep)

    class FakeApp:
        _retry_pending_receipts_until_settled = CopilotNativeApp._retry_pending_receipts_until_settled

        def __init__(self):
            self._pending_receipt_message_ids = {"message-1"}
            self._mentor_message_state_lock = threading.RLock()
            self.calls = 0

        def _fetch_pending_mentor_receipts(self):
            self.calls += 1
            if self.calls == 2:
                self._pending_receipt_message_ids.clear()
                return False
            return True

    app = FakeApp()
    asyncio.run(app._retry_pending_receipts_until_settled())

    assert app.calls == 2
    assert waits == [floating_native.PENDING_RECEIPT_RETRY_DELAY_SECONDS] * 2


def test_state_replace_failure_keeps_last_complete_pending_receipt_ledger(tmp_path, monkeypatch):
    state_path = tmp_path / "float_state.json"

    class FakeApp:
        _save_mentor_message_state = CopilotNativeApp._save_mentor_message_state

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = {"seen"}
            self._seen_mentor_message_order = ["seen"]
            self._pending_receipt_message_ids = {"old-pending"}
            self._last_seen_mentor_message_id = 1
            self._mentor_message_state_lock = threading.RLock()

        def _mentor_message_state_path(self):
            return str(state_path)

    app = FakeApp()
    app._save_mentor_message_state()
    before = json.loads(state_path.read_text(encoding="utf-8"))
    app._pending_receipt_message_ids = {"new-pending"}

    def fail_replace(source, destination):
        raise OSError("simulated interrupted state publish")

    monkeypatch.setattr(floating_native.os, "replace", fail_replace)
    app._save_mentor_message_state()

    assert json.loads(state_path.read_text(encoding="utf-8")) == before


def test_parallel_duplicate_receipt_retry_posts_once_and_persists_empty_pending(tmp_path):
    state_path = tmp_path / "float_state.json"
    first_post_started = threading.Event()
    allow_first_post = threading.Event()
    post_lock = threading.Lock()

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message
        _load_mentor_message_state = CopilotNativeApp._load_mentor_message_state
        _save_mentor_message_state = CopilotNativeApp._save_mentor_message_state

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order: list[str] = []
            self._pending_receipt_message_ids: set[str] = set()
            self._pending_receipt_after_id = 0
            self._receipt_ack_inflight_ids: set[str] = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 0
            self.posted: list[str] = []

        def _mentor_message_state_path(self):
            return str(state_path)

        def _render_mentor_message(self, item):
            return True

        def _get_json(self, path, *, query, timeout):
            return {"items": [{"message_id": "message-1", "id": 1}]}

        def _post_json(self, path, payload, *, timeout):
            with post_lock:
                self.posted.append(payload["message_id"])
                first = len(self.posted) == 1
            if first:
                first_post_started.set()
                assert allow_first_post.wait(timeout=2)
            return {"ok": True}

    app = FakeApp()
    render_thread = threading.Thread(target=app._handle_mentor_message, args=({
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    },))
    render_thread.start()
    assert first_post_started.wait(timeout=2)
    retry_thread = threading.Thread(target=app._fetch_pending_mentor_receipts)
    retry_thread.start()
    allow_first_post.set()
    render_thread.join(timeout=2)
    retry_thread.join(timeout=2)

    assert app.posted == ["message-1"]
    assert app._pending_receipt_message_ids == set()

    restarted = FakeApp()
    restarted._load_mentor_message_state()
    assert restarted._pending_receipt_message_ids == set()


def test_parallel_live_message_render_is_claimed_once_before_pending_is_persisted():
    first_render_started = threading.Event()
    allow_first_render = threading.Event()
    render_lock = threading.Lock()

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order = []
            self._pending_receipt_message_ids = set()
            self._rendering_mentor_message_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 0
            self.rendered: list[str] = []
            self.acked: list[str] = []

        def _render_mentor_message(self, item):
            with render_lock:
                self.rendered.append(item["message_id"])
                is_first = len(self.rendered) == 1
            if is_first:
                first_render_started.set()
                assert allow_first_render.wait(timeout=2)
            return True

        def _save_mentor_message_state(self):
            return None

        def _ack_mentor_message(self, message_id):
            self.acked.append(message_id)
            return True

    app = FakeApp()
    payload = {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    }
    first = threading.Thread(target=app._handle_mentor_message, args=(payload,))
    second = threading.Thread(target=app._handle_mentor_message, args=(payload,))
    first.start()
    assert first_render_started.wait(timeout=2)
    second.start()
    allow_first_render.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert app.rendered == ["message-1"]
    assert app.acked == ["message-1"]


def test_old_acknowledged_ws_replay_after_seen_window_trim_does_not_render_or_ack():
    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = {f"message-{index}" for index in range(2, 202)}
            self._seen_mentor_message_order = [f"message-{index}" for index in range(2, 202)]
            self._pending_receipt_message_ids = set()
            self._rendering_mentor_message_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 201
            self.rendered: list[str] = []
            self.acked: list[str] = []

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _save_mentor_message_state(self):
            return True

        def _ack_mentor_message(self, message_id):
            self.acked.append(message_id)
            return True

    app = FakeApp()
    app._handle_mentor_message({
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    })

    assert app.rendered == []
    assert app.acked == []


def test_first_state_publish_failure_retries_before_failed_ack_preserves_restart_dedup(tmp_path, monkeypatch):
    state_path = tmp_path / "float_state.json"
    real_replace = floating_native.os.replace
    replacements = 0

    def fail_once_replace(source, destination):
        nonlocal replacements
        replacements += 1
        if replacements == 1:
            raise OSError("first state publish interrupted")
        return real_replace(source, destination)

    monkeypatch.setattr(floating_native.os, "replace", fail_once_replace)

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message
        _load_mentor_message_state = CopilotNativeApp._load_mentor_message_state
        _save_mentor_message_state = CopilotNativeApp._save_mentor_message_state

        def __init__(self, *, fail_ack: bool):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order = []
            self._pending_receipt_message_ids = set()
            self._rendering_mentor_message_ids = set()
            self._receipt_ack_inflight_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 0
            self.fail_ack = fail_ack
            self.rendered: list[str] = []
            self.posted: list[str] = []

        def _mentor_message_state_path(self):
            return str(state_path)

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _post_json(self, path, payload, *, timeout):
            self.posted.append(payload["message_id"])
            if self.fail_ack:
                raise TimeoutError("ack response unavailable")
            return {"ok": True}

    writer = FakeApp(fail_ack=True)
    payload = {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    }
    writer._handle_mentor_message(payload)

    restarted = FakeApp(fail_ack=False)
    restarted._load_mentor_message_state()
    restarted._handle_mentor_message(payload)

    assert replacements >= 2
    assert writer.rendered == ["message-1"]
    assert restarted.rendered == []
    assert restarted.posted == ["message-1"]


def test_permanent_state_publish_failure_keeps_in_memory_render_recoverable_without_rerender(tmp_path, monkeypatch):
    state_path = tmp_path / "float_state.json"
    real_replace = floating_native.os.replace
    replacements = 0

    def fail_first_two_replaces(source, destination):
        nonlocal replacements
        replacements += 1
        if replacements <= 2:
            raise OSError("state storage temporarily unavailable")
        return real_replace(source, destination)

    monkeypatch.setattr(floating_native.os, "replace", fail_first_two_replaces)

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message
        _fetch_pending_mentor_receipts = CopilotNativeApp._fetch_pending_mentor_receipts
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message
        _save_mentor_message_state = CopilotNativeApp._save_mentor_message_state

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order = []
            self._pending_receipt_message_ids = set()
            self._unpersisted_rendered_message_ids: dict[str, int] = {}
            self._rendering_mentor_message_ids = set()
            self._receipt_ack_inflight_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 0
            self._pending_receipt_after_id = 0
            self.rendered: list[str] = []
            self.posted: list[str] = []

        def _mentor_message_state_path(self):
            return str(state_path)

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _get_json(self, path, *, query, timeout):
            assert path == "/api/student/messages/pending-receipts"
            return {"items": []}

        def _post_json(self, path, payload, *, timeout):
            self.posted.append(payload["message_id"])
            return {"ok": True}

    app = FakeApp()
    payload = {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    }
    app._handle_mentor_message(payload)

    assert app.rendered == ["message-1"]
    assert app.posted == []
    assert app._last_seen_mentor_message_id == 0
    assert app._pending_receipt_message_ids == set()
    assert app._unpersisted_rendered_message_ids == {"message-1": 1}

    assert app._fetch_pending_mentor_receipts() is False
    assert app.rendered == ["message-1"]
    assert app.posted == ["message-1"]
    assert app._unpersisted_rendered_message_ids == {}
    assert app._last_seen_mentor_message_id == 1


def test_persisted_cursor_does_not_skip_earlier_unpersisted_render_after_restart(tmp_path, monkeypatch):
    state_path = tmp_path / "float_state.json"
    real_replace = floating_native.os.replace
    replacements = 0

    def fail_first_two_replaces(source, destination):
        nonlocal replacements
        replacements += 1
        if replacements <= 2:
            raise OSError("m1 state unavailable")
        return real_replace(source, destination)

    monkeypatch.setattr(floating_native.os, "replace", fail_first_two_replaces)

    class FakeApp:
        _handle_mentor_message = CopilotNativeApp._handle_mentor_message
        _ack_mentor_message = CopilotNativeApp._ack_mentor_message
        _load_mentor_message_state = CopilotNativeApp._load_mentor_message_state
        _save_mentor_message_state = CopilotNativeApp._save_mentor_message_state

        def __init__(self):
            self._student_id = "student-a"
            self._seen_mentor_message_ids = set()
            self._seen_mentor_message_order = []
            self._pending_receipt_message_ids = set()
            self._unpersisted_rendered_message_ids: dict[str, int] = {}
            self._rendering_mentor_message_ids = set()
            self._receipt_ack_inflight_ids = set()
            self._mentor_message_state_lock = threading.RLock()
            self._last_seen_mentor_message_id = 0
            self.rendered: list[str] = []
            self.posted: list[str] = []

        def _mentor_message_state_path(self):
            return str(state_path)

        def _render_mentor_message(self, item):
            self.rendered.append(item["message_id"])
            return True

        def _post_json(self, path, payload, *, timeout):
            self.posted.append(payload["message_id"])
            return {"ok": True}

    first = FakeApp()
    m1 = {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-1",
        "id": 1,
    }
    m2 = {
        "type": "mentor_message",
        "student_id": "student-a",
        "message_id": "message-2",
        "id": 2,
    }
    first._handle_mentor_message(m1)
    first._handle_mentor_message(m2)

    persisted = json.loads(state_path.read_text(encoding="utf-8"))["student-a"]
    assert persisted["last_seen_message_id"] == 0

    restarted = FakeApp()
    restarted._load_mentor_message_state()
    restarted._handle_mentor_message(m1)

    assert restarted._last_seen_mentor_message_id == 1
    assert restarted.rendered == ["message-1"]
    assert restarted.posted == ["message-1"]
