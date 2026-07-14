"""llm.py 单元测试：prompt 构建 + JSON 解析 + 降级逻辑。

不实际调用 LLM API，只测试本地逻辑。
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from copilot.llm import (
    AnalysisOutcome,
    QuestionAnswerOutcome,
    build_system_prompt,
    build_user_prompt,
    _parse_json_content,
    _fallback,
    analyze,
    answer_question,
    answer_question_with_status,
    summarize_reply,
)
from copilot.transcript import TranscriptSnapshot, Message


class TestBuildUserPrompt:
    def test_includes_event_and_prompt(self):
        snap = TranscriptSnapshot(messages=[Message("user", "学 Python")])
        prompt = build_user_prompt(snap, "Stop", "学 Python asyncio")
        assert "Stop" in prompt
        assert "学 Python asyncio" in prompt
        assert "学 Python" in prompt

    def test_includes_tool_and_reasoning_counts(self):
        snap = TranscriptSnapshot(
            messages=[Message("user", "hi")],
            tool_calls=5,
            reasoning_steps=3,
        )
        prompt = build_user_prompt(snap, "Stop", "hi")
        assert "5" in prompt
        assert "3" in prompt

    def test_empty_prompt_shown_as_none(self):
        snap = TranscriptSnapshot()
        prompt = build_user_prompt(snap, "UserPromptSubmit", "")
        assert "(无)" in prompt


class TestBuildSystemPrompt:
    def test_includes_process_reminder_prompt_and_frequency_guardrail(self):
        cfg = {
            "analysis": {
                "process_reminder_prompt": "如果学员反复试错、没验证结果，只给轻提醒。",
            }
        }

        prompt = build_system_prompt(cfg)

        assert "如果学员反复试错、没验证结果，只给轻提醒。" in prompt
        assert "少而准" in prompt
        assert "不要频繁打断" in prompt


class TestParseJsonContent:
    def test_valid_json(self):
        content = json.dumps({
            "topic": "学 Python",
            "understanding": "high",
            "off_topic": False,
            "stuck_at": "",
            "progress": "顺利",
            "guidance": "继续",
            "alert": "",
        })
        result = _parse_json_content(content)
        assert result["topic"] == "学 Python"
        assert result["understanding"] == "high"

    def test_json_with_code_fence(self):
        content = '```json\n{"topic": "test", "understanding": "medium"}\n```'
        result = _parse_json_content(content)
        assert result["topic"] == "test"

    def test_invalid_json_returns_fallback(self):
        result = _parse_json_content("不是 JSON")
        assert result["understanding"] == "unknown"
        assert result["topic"] == "解析失败"

    def test_missing_fields_filled(self):
        result = _parse_json_content('{"topic": "partial"}')
        assert result["understanding"] == "unknown"
        assert result["off_topic"] is False

    def test_long_fields_truncated(self):
        result = _parse_json_content(json.dumps({
            "topic": "x" * 200,
            "guidance": "y" * 200,
        }))
        assert len(result["topic"]) <= 40
        assert len(result["guidance"]) <= 60


class TestFallback:
    def test_fallback_with_title(self):
        snap = TranscriptSnapshot(ai_title="Python 课")
        result = _fallback(snap, "Stop")
        assert result["topic"] == "Python 课"
        assert result["understanding"] == "unknown"

    def test_fallback_without_title(self):
        snap = TranscriptSnapshot(messages=[Message("user", "hi")])
        result = _fallback(snap, "Stop")
        assert "未命名" in result["topic"]
        assert "1 条对话" in result["progress"]


class TestAnalyze:
    @pytest.mark.asyncio
    async def test_no_api_key_returns_fallback(self):
        cfg = {"llm": {"enable_llm": True, "api_key": "", "model": "x", "api_base": "x"}}
        snap = TranscriptSnapshot(ai_title="测试")
        result = await analyze(cfg, snap, "Stop", "hi")
        assert isinstance(result, AnalysisOutcome)
        assert result.ok is True
        assert result.value["understanding"] == "unknown"
        assert result.error is None

    @pytest.mark.asyncio
    async def test_llm_disabled_returns_fallback(self):
        cfg = {"llm": {"enable_llm": False, "api_key": "sk-x", "model": "x", "api_base": "x"}}
        snap = TranscriptSnapshot()
        result = await analyze(cfg, snap, "Stop", "hi")
        assert result.ok is True
        assert result.value["understanding"] == "unknown"
        assert result.error is None

    @pytest.mark.asyncio
    async def test_provider_network_failure_returns_stable_error_without_exception_body(
        self, monkeypatch, caplog
    ):
        class FailingClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                raise TimeoutError("provider timed out")

            async def __aexit__(self, exc_type, exc, tb):
                return False

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", FailingClient)
        cfg = {
            "llm": {
                "enable_llm": True,
                "api_key": "sk-test",
                "model": "model",
                "api_base": "https://llm.example/v1",
            }
        }

        with caplog.at_level("ERROR", logger="copilot.llm"):
            result = await analyze(cfg, TranscriptSnapshot(ai_title="网络失败"), "Stop", "hi")

        assert isinstance(result, AnalysisOutcome)
        assert result.ok is False
        assert result.value["topic"] == "网络失败"
        assert result.error == "LLM provider TimeoutError"
        assert "provider timed out" not in caplog.text

    @pytest.mark.asyncio
    async def test_provider_http_failure_returns_failed_outcome_without_response_body(self, monkeypatch):
        request = httpx.Request("POST", "https://llm.example/v1/chat/completions")
        response = httpx.Response(503, request=request, text="secret provider response")

        class FakeResponse:
            def raise_for_status(self):
                raise httpx.HTTPStatusError(
                    "provider unavailable",
                    request=request,
                    response=response,
                )

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                return FakeResponse()

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", FakeClient)
        cfg = {
            "llm": {
                "enable_llm": True,
                "api_key": "sk-test",
                "model": "model",
                "api_base": "https://llm.example/v1",
            }
        }

        result = await analyze(cfg, TranscriptSnapshot(), "Stop", "hi")

        assert result.ok is False
        assert result.error == "LLM provider HTTP 503"
        assert "secret provider response" not in (result.error or "")

    @pytest.mark.asyncio
    async def test_malformed_provider_json_returns_failed_outcome_but_keeps_display_fallback(self, monkeypatch):
        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"choices": [{"message": {"content": "not-json"}}]}

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                return FakeResponse()

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", FakeClient)
        cfg = {
            "llm": {
                "enable_llm": True,
                "api_key": "sk-test",
                "model": "model",
                "api_base": "https://llm.example/v1",
            }
        }

        result = await analyze(cfg, TranscriptSnapshot(), "Stop", "hi")

        assert result.ok is False
        assert result.value["topic"] == "解析失败"
        assert "JSON" in (result.error or "")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("content", "expected_topic"),
        [
            ('{"topic":"valid","understanding":"high","diagnosis":"kept"}', "valid"),
            (
                '```json\n{"topic":"fenced","understanding":"medium","diagnosis":"kept"}\n```',
                "fenced",
            ),
        ],
    )
    async def test_valid_provider_json_returns_success_outcome_with_fields(
        self, monkeypatch, content, expected_topic
    ):
        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"choices": [{"message": {"content": content}}]}

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                return FakeResponse()

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", FakeClient)
        cfg = {
            "llm": {
                "enable_llm": True,
                "api_key": "sk-test",
                "model": "model",
                "api_base": "https://llm.example/v1",
            }
        }

        result = await analyze(cfg, TranscriptSnapshot(), "Stop", "hi")

        assert result.ok is True
        assert result.value["topic"] == expected_topic
        assert result.value["diagnosis"] == "kept"
        assert result.error is None


class TestAnswerQuestion:
    @pytest.mark.asyncio
    async def test_llm_disabled_returns_student_help_fallback(self):
        cfg = {"llm": {"enable_llm": False, "api_key": "sk-x", "model": "x", "api_base": "x"}}
        answer = await answer_question(cfg, "pytest 为什么失败？", [])
        assert "LLM" in answer
        assert "问题" in answer

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("llm_config", "expected_status"),
        [
            ({"enable_llm": False, "api_key": "sk-x", "model": "x", "api_base": "x"}, "disabled"),
            ({"enable_llm": True, "api_key": "", "model": "x", "api_base": "x"}, "missing_api_key"),
            ({"enable_llm": True, "api_key": "sk-x", "model": "", "api_base": "x"}, "misconfigured"),
        ],
    )
    async def test_structured_capability_status_before_provider_call(
        self, llm_config, expected_status
    ):
        result = await answer_question_with_status(
            {"llm": llm_config}, "怎么排查？", []
        )

        assert isinstance(result, QuestionAnswerOutcome)
        assert result.status == expected_status
        assert result.answer
        assert result.retry_guidance

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "api_base",
        [
            pytest.param("not-a-url", id="missing-scheme-and-host"),
            pytest.param("https:///v1", id="missing-host"),
            pytest.param("ftp://llm.example/v1", id="non-http-scheme"),
            pytest.param(
                "https://llm.example:abc/v1",
                id="non-numeric-port",
            ),
            pytest.param(
                "https://llm.example:70000/v1",
                id="out-of-range-port",
            ),
        ],
    )
    async def test_invalid_api_base_is_misconfigured_before_provider_call(
        self, monkeypatch, api_base
    ):
        class UnexpectedClient:
            def __init__(self, timeout):
                raise AssertionError("invalid api_base must not reach the provider")

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", UnexpectedClient)

        result = await answer_question_with_status(
            {
                "llm": {
                    "enable_llm": True,
                    "api_key": "sk-test",
                    "model": "model",
                    "api_base": api_base,
                }
            },
            "怎么排查？",
            [],
        )

        assert result.status == "misconfigured"
        assert result.answer
        assert result.retry_guidance

    @pytest.mark.asyncio
    @pytest.mark.parametrize("api_base", ["http://llm.example/v1", "https://llm.example/v1"])
    async def test_provider_success_returns_ready_status(self, monkeypatch, api_base):
        captured = {}

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"choices": [{"message": {"content": "先检查 Python 版本。"}}]}

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                captured["url"] = url
                return FakeResponse()

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", FakeClient)
        result = await answer_question_with_status(
            {
                "llm": {
                    "enable_llm": True,
                    "api_key": "sk-test",
                    "model": "model",
                    "api_base": api_base,
                }
            },
            "怎么排查？",
            [],
        )

        assert result.status == "ready"
        assert result.answer == "先检查 Python 版本。"
        assert result.retry_guidance == ""
        assert captured["url"] == api_base + "/chat/completions"

    @pytest.mark.asyncio
    async def test_timeout_and_upstream_error_are_distinct(self, monkeypatch):
        config = {
            "llm": {
                "enable_llm": True,
                "api_key": "sk-test",
                "model": "model",
                "api_base": "https://llm.example/v1",
            }
        }

        class TimeoutClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                raise httpx.ReadTimeout("late")

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", TimeoutClient)
        timeout_result = await answer_question_with_status(config, "hi", [])
        assert timeout_result.status == "timeout"

        class ErrorClient(TimeoutClient):
            async def post(self, url, json, headers):
                raise httpx.ConnectError("offline")

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", ErrorClient)
        upstream_result = await answer_question_with_status(config, "hi", [])
        assert upstream_result.status == "upstream_error"

    def test_question_context_drops_whole_old_messages_instead_of_slicing_them(self):
        from copilot.llm import _format_question_context

        context = [
            {"role": "user", "content": "OLD-" + "x" * 80},
            {"role": "assistant", "content": "LATEST-COMPLETE"},
        ]

        rendered = _format_question_context(context, max_chars=40)

        assert "LATEST-COMPLETE" in rendered
        assert "OLD-" not in rendered

    def test_question_prompt_keeps_every_context_layer_within_normal_budgets(self):
        from copilot.llm import build_question_prompt

        prompt = build_question_prompt(
            "help",
            [
                {"role": "user", "content": "SESSION-" + "s" * 2_500},
                {"role": "analysis", "content": "ANALYSIS-" + "a" * 500},
                {"role": "prior_copilot", "content": "PRIOR-" + "p" * 1_000},
                {"role": "diagnostics", "content": "DIAGNOSTIC-" + "d" * 3_000},
                {"role": "runtime_guidance", "content": "GUIDANCE-" + "g" * 800},
            ],
        )

        for marker in ("SESSION-", "ANALYSIS-", "PRIOR-", "DIAGNOSTIC-", "GUIDANCE-"):
            assert marker in prompt


class TestSummarizeReply:
    @pytest.mark.asyncio
    async def test_uses_summary_model_and_returns_content(self, monkeypatch):
        captured = {}

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "AI 先解释了报错原因，再给出最小复现和验证步骤。"
                            }
                        }
                    ]
                }

        class FakeClient:
            def __init__(self, timeout):
                captured["timeout"] = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                captured["url"] = url
                captured["payload"] = json
                captured["headers"] = headers
                return FakeResponse()

        monkeypatch.setattr("copilot.llm.httpx.AsyncClient", FakeClient)

        cfg = {
            "llm": {
                "enable_llm": True,
                "api_key": "sk-test",
                "api_base": "https://llm.example/v1",
                "model": "expensive-model",
                "summary_model": "cheap-summary-model",
                "timeout": 12,
            }
        }

        result = await summarize_reply(cfg, "怎么定位边界？", "先打印 i。\n再检查 len(xs)。")

        assert result == "AI 先解释了报错原因，再给出最小复现和验证步骤。"
        assert captured["payload"]["model"] == "cheap-summary-model"
        system_prompt = captured["payload"]["messages"][0]["content"]
        assert "50-300字" in system_prompt
        assert "平均100字左右" in system_prompt
        assert "简单的回复就一两句话" in system_prompt
        assert "怎么定位边界？" in captured["payload"]["messages"][1]["content"]
        assert "先打印 i。" in captured["payload"]["messages"][1]["content"]
        assert captured["url"] == "https://llm.example/v1/chat/completions"
        assert captured["headers"]["Authorization"] == "Bearer sk-test"

    @pytest.mark.asyncio
    async def test_disabled_llm_returns_empty_summary(self):
        cfg = {"llm": {"enable_llm": False, "api_key": "sk-test", "api_base": "x"}}

        result = await summarize_reply(cfg, "问题", "回复")

        assert result == ""
