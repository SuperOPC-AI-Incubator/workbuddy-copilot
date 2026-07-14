from __future__ import annotations

import json
import sqlite3

from copilot.student_core import diagnostics
from copilot.student_core.diagnostics import (
    DIAGNOSTIC_BUNDLE_VERSION,
    collect_diagnostic_bundle,
    diagnostic_summary,
    redact_diagnostic_bundle,
)
from copilot.store import Store


def _fake_provider_token() -> str:
    """Build a realistic token at runtime without committing a secret-like literal."""
    return "".join(("s", "k", "-", "abcdefghijklmnopqrstuvwxyz123456"))


def test_redaction_removes_secrets_email_and_home_username_but_keeps_error_facts():
    bundle = redact_diagnostic_bundle(
        {
            "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
            "headers": {"Authorization": "Bearer top-secret"},
            "config": {
                "api_key": "sk-do-not-send",
                "client_secret": "oauth-secret",
                "ssh_key": "private-key",
                "note": "TOKENHUB_API_KEY=hidden-value",
            },
            "Set-Cookie": "session=another-secret",
            "recent_errors": [
                "Permission denied for alice@example.com at /Users/alice/project/.env; "
                "Cookie: session-cookie; SSH_KEY=\"quoted secret\"; "
                "C:\\Users\\alice\\project\\.env"
            ],
        }
    )

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert bundle["schema_version"] == DIAGNOSTIC_BUNDLE_VERSION
    assert "Permission denied" in rendered
    assert "top-secret" not in rendered
    assert "sk-do-not-send" not in rendered
    assert "hidden-value" not in rendered
    assert "session-cookie" not in rendered
    assert "another-secret" not in rendered
    assert "oauth-secret" not in rendered
    assert "private-key" not in rendered
    assert "quoted secret" not in rendered
    assert "alice@example.com" not in rendered
    assert "/Users/alice" not in rendered
    assert "C:\\Users\\alice" not in rendered
    assert "[REDACTED]" in rendered


def test_redaction_breaker_catches_bare_and_camel_case_credentials():
    useful_error = "ModuleNotFoundError: httpx"
    provider_token = _fake_provider_token()
    bundle = redact_diagnostic_bundle(
        {
            "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
            "apiKey": "camel-api-secret",
            "accessToken": "camel-token-secret",
            "key": "generic-key-secret",
            "recent_errors": [
                useful_error,
                f"provider rejected {provider_token}",
                "opaque ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef",
                "alpha abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
                "Cookie: session=first-secret; csrf=second-secret; Path=/",
                "apiKey=named-secret accessToken=other-named-secret key=third-secret",
            ],
        }
    )

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert useful_error in rendered
    for secret in (
        "camel-api-secret",
        "camel-token-secret",
        "generic-key-secret",
        provider_token,
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef",
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
        "first-secret",
        "second-secret",
        "named-secret",
        "other-named-secret",
        "third-secret",
    ):
        assert secret not in rendered


def test_redaction_removes_complete_basic_and_aws_authorization_values():
    bundle = redact_diagnostic_bundle(
        {
            "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
            "recent_errors": [
                "Authorization: Basic dXNlcjpwYXNzd29yZA==\n"
                "NEXT-USEFUL-ERROR PermissionError",
                "Authorization: AWS4-HMAC-SHA256 "
                "Credential=AKIAEXAMPLE/20260714/cn/service/aws4_request, "
                "SignedHeaders=host;x-amz-date, Signature=deadbeefcafebabe\n"
                "SECOND-USEFUL-ERROR TimeoutError",
            ],
        }
    )

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert "Basic" not in rendered
    assert "dXNlcjpwYXNzd29yZA" not in rendered
    assert "AKIAEXAMPLE" not in rendered
    assert "SignedHeaders" not in rendered
    assert "deadbeefcafebabe" not in rendered
    assert "NEXT-USEFUL-ERROR" in rendered
    assert "SECOND-USEFUL-ERROR" in rendered


def test_redactor_preserves_client_schema_contract_without_inventing_v1():
    unsupported = redact_diagnostic_bundle({"schema_version": "diagnostic-bundle/v999"})
    missing = redact_diagnostic_bundle({"recent_errors": ["ValueError: useful"]})
    legacy = redact_diagnostic_bundle({"version": DIAGNOSTIC_BUNDLE_VERSION})

    assert unsupported["schema_version"] == "diagnostic-bundle/v999"
    assert "schema_version" not in missing
    assert "version" not in unsupported
    assert "version" not in missing
    assert "version" not in legacy
    assert "schema_version" not in legacy


def test_collection_uses_injected_probes_and_never_includes_environment_values():
    environ = {
        "TENCENT_TOKENHUB_API_KEY": "super-secret",
        "HTTP_PROXY": "http://user:pass@proxy.example",
    }

    def tool_probe(name: str):
        return "/usr/bin/python3" if name == "python3" else None

    def path_probe(path: str):
        return {"exists": path.endswith("config.json"), "readable": False}

    bundle = collect_diagnostic_bundle(
        environ=environ,
        system_info={"os": "Darwin", "arch": "arm64"},
        versions={"python": "3.13", "copilot": "0.1"},
        required_env_names=["TENCENT_TOKENHUB_API_KEY", "MISSING_ENV"],
        required_tools=["python3", "git"],
        relevant_paths=["/Users/alice/project/config.json", "/missing/.env"],
        tool_probe=tool_probe,
        path_probe=path_probe,
        permissions={"automation": "denied"},
        reachability={"loopback": "ready", "upstream": "blocked"},
        recent_errors=["ModuleNotFoundError: httpx"],
    )

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert bundle["schema_version"] == DIAGNOSTIC_BUNDLE_VERSION
    assert bundle["environment"] == {
        "TENCENT_TOKENHUB_API_KEY": {"configured": True},
        "MISSING_ENV": {"configured": False},
    }
    assert bundle["tools"]["python3"]["available"] is True
    assert bundle["tools"]["git"]["available"] is False
    assert bundle["paths"][0]["exists"] is True
    assert bundle["permissions"]["automation"] == "denied"
    assert bundle["reachability"]["upstream"] == "blocked"
    assert "ModuleNotFoundError" in rendered
    assert "super-secret" not in rendered
    assert "user:pass" not in rendered


def test_probe_failures_are_reported_by_type_without_aborting_collection():
    def broken_tool(_name: str):
        raise PermissionError("private tool path")

    def broken_path(_path: str):
        raise OSError("private filesystem details")

    bundle = collect_diagnostic_bundle(
        environ={},
        system_info={"os": "test", "arch": "test"},
        versions={"python": "test", "copilot": "test"},
        required_tools=["python3"],
        relevant_paths=["/Users/alice/private"],
        tool_probe=broken_tool,
        path_probe=broken_path,
    )

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert bundle["tools"]["python3"] == {
        "available": False,
        "path": "",
        "probe_error": "PermissionError",
    }
    assert bundle["paths"][0]["probe_error"] == "OSError"
    assert "private tool path" not in rendered
    assert "private filesystem details" not in rendered


def test_default_collector_has_useful_local_facts_and_recent_error_ring():
    provider_token = _fake_provider_token()
    diagnostics.clear_recent_errors()
    try:
        try:
            raise RuntimeError(
                "install failed for alice@example.com with "
                f"{provider_token}"
            )
        except RuntimeError as exc:
            diagnostics.record_recent_error("student_ask", exc, timestamp=123.0)

        bundle = collect_diagnostic_bundle(environ={})
    finally:
        diagnostics.clear_recent_errors()

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert bundle["schema_version"] == DIAGNOSTIC_BUNDLE_VERSION
    assert bundle["system"]["os"]
    assert bundle["system"]["arch"]
    assert set(bundle["tools"]) >= {"python3", "git"}
    assert len(bundle["paths"]) >= 2
    assert bundle["permissions"]
    assert bundle["reachability"] == {
        "loopback": "not_probed",
        "upstream": "not_probed",
    }
    error = bundle["recent_errors"][-1]
    assert error["component"] == "student_ask"
    assert error["timestamp"] == 123.0
    assert error["type"] == "RuntimeError"
    assert "install failed" in error["message"]
    assert "stack_tail" in error
    assert "alice@example.com" not in rendered
    assert provider_token not in rendered


def test_default_collector_isolates_every_local_probe_failure(monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("private probe detail")

    real_path = diagnostics.Path

    class FailingPath:
        def __new__(cls, *args, **kwargs):
            return real_path(*args, **kwargs)

        @classmethod
        def home(cls):
            return fail()

        @classmethod
        def cwd(cls):
            return fail()

    class FailingOS:
        environ = diagnostics.os.environ
        R_OK = diagnostics.os.R_OK
        W_OK = diagnostics.os.W_OK

        @staticmethod
        def access(*args, **kwargs):
            return fail(*args, **kwargs)

    monkeypatch.setattr(diagnostics.platform, "system", fail)
    monkeypatch.setattr(diagnostics.platform, "machine", fail)
    monkeypatch.setattr(diagnostics.platform, "python_version", fail)
    monkeypatch.setattr(diagnostics.metadata, "version", fail)
    monkeypatch.setattr(diagnostics, "Path", FailingPath)
    monkeypatch.setattr(diagnostics, "os", FailingOS)

    bundle = collect_diagnostic_bundle(environ={})

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert bundle["schema_version"] == DIAGNOSTIC_BUNDLE_VERSION
    assert bundle["system"]["os"] == "unknown"
    assert bundle["system"]["arch"] == "unknown"
    assert bundle["system"]["probe_error"] == "RuntimeError"
    assert bundle["versions"]["python"] == "unknown"
    assert bundle["versions"]["copilot"] == "unknown"
    assert bundle["versions"]["probe_error"] == "RuntimeError"
    assert bundle["permissions"]["home"]["probe_error"] == "RuntimeError"
    assert bundle["permissions"]["cwd"]["probe_error"] == "RuntimeError"
    assert all(item["probe_error"] == "RuntimeError" for item in bundle["paths"])
    assert "private probe detail" not in rendered


def test_bundle_is_bounded_and_keeps_recent_error_tail():
    bundle = redact_diagnostic_bundle(
        {
            "recent_errors": [f"old-{index}-" + "x" * 600 for index in range(100)]
            + ["LATEST-ERROR Permission denied"],
            "extra": "y" * 100_000,
        },
        max_chars=4_000,
    )

    rendered = json.dumps(bundle, ensure_ascii=False)
    assert len(rendered) <= 4_000
    assert bundle.get("truncated") is True
    assert "LATEST-ERROR" in rendered


def test_summary_contains_only_version_categories_and_error_count():
    summary = diagnostic_summary(
        {
            "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
            "system": {"os": "Darwin"},
            "recent_errors": ["one", "two"],
            "headers": {"Authorization": "should never persist"},
        }
    )

    assert summary == {
        "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
        "categories": ["headers", "recent_errors", "system"],
        "recent_error_count": 2,
        "truncated": False,
    }


def test_student_ask_diagnostic_metadata_migrates_legacy_database(tmp_path):
    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """CREATE TABLE student_asks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL,
                session_id TEXT,
                question TEXT,
                answer TEXT,
                created_at REAL NOT NULL
            )"""
        )

    store = Store(db_path)
    ask_id = store.add_student_ask(
        student_id="alice",
        session_id="sess-1",
        question="why",
        answer="because",
        diagnostics_attached=True,
        diagnostics_summary={"schema_version": DIAGNOSTIC_BUNDLE_VERSION},
        diagnostics_version=DIAGNOSTIC_BUNDLE_VERSION,
        guidance_versions=["camp-v1"],
        context_status="ready",
        llm_status="ready",
    )

    row = store.list_student_asks("alice")[0]
    assert row["id"] == ask_id
    assert row["diagnostics_attached"] == 1
    assert (
        json.loads(row["diagnostics_summary"])["schema_version"]
        == DIAGNOSTIC_BUNDLE_VERSION
    )
    assert json.loads(row["guidance_versions"]) == ["camp-v1"]
    assert row["context_status"] == "ready"
    assert row["llm_status"] == "ready"


def test_list_student_asks_applies_optional_sql_limit(tmp_path):
    store = Store(tmp_path / "copilot.db")
    for index in range(6):
        store.add_student_ask(
            student_id="alice",
            session_id=f"sess-{index}",
            question=f"question-{index}",
            answer=f"answer-{index}",
        )

    rows = store.list_student_asks("alice", limit=3)

    assert len(rows) == 3
    assert [row["question"] for row in rows] == [
        "question-5",
        "question-4",
        "question-3",
    ]
