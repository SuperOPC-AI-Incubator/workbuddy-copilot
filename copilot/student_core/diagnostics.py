"""Bounded, redacted diagnostics assembled by the resident Student Core.

The collector deliberately accepts injectable probes. Unit tests and callers
can provide already-known reachability results without causing hidden network
traffic, while the default local probes are limited to platform, executable,
path, and environment *presence* checks.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import threading
import time
import traceback
from collections import deque
from collections.abc import Callable, Iterable, Mapping, Sequence
from importlib import metadata
from itertools import islice
from pathlib import Path
from typing import Any

DIAGNOSTIC_BUNDLE_VERSION = "diagnostic-bundle/v1"
DEFAULT_MAX_DIAGNOSTIC_CHARS = 16_000
DEFAULT_REQUIRED_ENV_NAMES = ("TENCENT_TOKENHUB_API_KEY",)
DEFAULT_REQUIRED_TOOLS = ("python3", "git")
DEFAULT_RELEVANT_PATHS = (
    "~/.workbuddy/workbuddy.db",
    "~/.workbuddy/projects",
    "~/.workbuddy",
)
_MAX_DEPTH = 6
_MAX_ITEMS = 24
_MAX_TEXT_CHARS = 1_600
_MAX_SANITIZE_NODES = 512
_MAX_NORMALIZED_ITEMS = 24
_RECENT_ERRORS: deque[dict[str, Any]] = deque(maxlen=24)
_RECENT_ERRORS_LOCK = threading.Lock()

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$")
_PROBE_ERROR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,119}$")
_SAFE_PLATFORM_TEXT_RE = re.compile(r"^[A-Za-z0-9 ._()+/:-]{1,120}$")
_SAFE_PERMISSION_STATES = {
    "granted",
    "denied",
    "restricted",
    "not_probed",
    "unknown",
}
_SAFE_REACHABILITY_STATES = {
    "ready",
    "blocked",
    "unreachable",
    "error",
    "not_probed",
    "unknown",
}
_PERMISSION_PATH_KEYS = {"home", "cwd"}
_PERMISSION_STATE_KEYS = {
    "automation",
    "filesystem",
    "microphone",
    "screen_recording",
}

_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_HOME_RE = re.compile(r"(?:/Users|/home)/[^/\s;:,\"]+")
_WINDOWS_HOME_RE = re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\s;:,\"]+")
_URL_CREDENTIAL_RE = re.compile(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@")
_AUTH_VALUE_RE = re.compile(r"(?im)\b(authorization)\s*[:=]\s*[^\r\n]*")
_COOKIE_HEADER_RE = re.compile(r"(?im)\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]+")
_NAMED_SECRET_RE = re.compile(
    r"(?i)\b((?:[A-Z0-9]+[_-])+(?:key|token|password|secret)|"
    r"api[_-]?key|apiKey|accessToken|refreshToken|token|key|password|secret)"
    r"\s*[:=]\s*"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_BARE_SK_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}")
_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"(?:\.[A-Za-z0-9_-]{10,})?\b"
)
_LONG_TOKEN_RE = re.compile(
    r"\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])"
    r"(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+\b"
)
_LONG_ALPHA_TOKEN_RE = re.compile(r"\b[A-Za-z]{40,}\b")


def _redact_probable_alpha_token(match: re.Match[str]) -> str:
    token = match.group(0)
    return "[REDACTED_TOKEN]" if len(set(token.lower())) >= 10 else token


def _sensitive_key(key: str) -> bool:
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key)
    normalized = re.sub(r"[^a-z0-9]+", "_", snake.lower()).strip("_")
    segments = set(normalized.split("_"))
    return (
        normalized in {
            "authorization",
            "cookie",
            "key",
            "password",
            "secret",
            "api_key",
        }
        or normalized.endswith("_api_key")
        or normalized.endswith("_token")
        or normalized.endswith("_key")
        or normalized.startswith("token_")
        or bool(segments.intersection({"authorization", "cookie", "password", "secret"}))
    )


def redact_text(value: Any) -> str:
    """Redact common credentials and direct personal identifiers in text."""
    text = str(value or "")
    text = _URL_CREDENTIAL_RE.sub(r"\1[REDACTED]@", text)
    text = _COOKIE_HEADER_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
    text = _AUTH_VALUE_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
    text = _NAMED_SECRET_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
    text = _JWT_RE.sub("[REDACTED_TOKEN]", text)
    text = _BARE_SK_TOKEN_RE.sub("[REDACTED_TOKEN]", text)
    text = _LONG_TOKEN_RE.sub("[REDACTED_TOKEN]", text)
    text = _LONG_ALPHA_TOKEN_RE.sub(_redact_probable_alpha_token, text)
    text = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    text = _HOME_RE.sub("~", text)
    text = _WINDOWS_HOME_RE.sub("%USERPROFILE%", text)
    if len(text) > _MAX_TEXT_CHARS:
        return text[-_MAX_TEXT_CHARS:]
    return text


def _sanitize(
    value: Any,
    *,
    depth: int = 0,
    parent_key: str = "",
    budget: list[int] | None = None,
    truncated: list[bool] | None = None,
) -> Any:
    budget = [_MAX_SANITIZE_NODES] if budget is None else budget
    truncated = [False] if truncated is None else truncated
    if budget[0] <= 0:
        truncated[0] = True
        return "[TRUNCATED]"
    budget[0] -= 1
    if depth >= _MAX_DEPTH:
        truncated[0] = True
        return "[TRUNCATED]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        if len(value) > _MAX_ITEMS:
            truncated[0] = True
        for raw_key, raw_value in islice(value.items(), _MAX_ITEMS):
            key = redact_text(raw_key)[:120]
            # Environment diagnostics intentionally use secret-looking names
            # with a boolean configured flag. Preserve the status, never a
            # string value supplied under such a key.
            is_presence_fact = (
                isinstance(raw_value, Mapping)
                and set(raw_value) == {"configured"}
                and isinstance(raw_value.get("configured"), bool)
            )
            if _sensitive_key(key) and not isinstance(raw_value, bool) and not is_presence_fact:
                result[key] = "[REDACTED]"
            else:
                result[key] = _sanitize(
                    raw_value,
                    depth=depth + 1,
                    parent_key=key,
                    budget=budget,
                    truncated=truncated,
                )
        return result
    if isinstance(value, (list, tuple, set, frozenset)):
        if len(value) > _MAX_ITEMS:
            truncated[0] = True
        if parent_key == "recent_errors" and isinstance(value, (list, tuple)):
            items = value[-_MAX_ITEMS:]
        else:
            items = list(islice(value, _MAX_ITEMS))
        return [
            _sanitize(
                item,
                depth=depth + 1,
                parent_key=parent_key,
                budget=budget,
                truncated=truncated,
            )
            for item in items
        ]
    if len(str(value)) > _MAX_TEXT_CHARS:
        truncated[0] = True
    return redact_text(value)


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False))


def redact_diagnostic_bundle(
    bundle: Mapping[str, Any] | None,
    *,
    max_chars: int = DEFAULT_MAX_DIAGNOSTIC_CHARS,
) -> dict[str, Any]:
    """Redact and bound a bundle without inventing a client schema version."""
    limit = max(512, int(max_chars))
    source = bundle or {}
    truncation = [False]
    sanitized = _sanitize(source, truncated=truncation)
    if not isinstance(sanitized, dict):
        sanitized = {}
    # ``version`` was never a supported wire-contract field. Drop it instead
    # of silently upgrading it to the formal ``schema_version`` contract.
    sanitized.pop("version", None)
    sanitized["truncated"] = bool(sanitized.get("truncated", False) or truncation[0])
    if _json_size(sanitized) <= limit:
        return sanitized

    sanitized["truncated"] = True
    # Prefer retaining the newest error evidence; discard unrelated large
    # optional categories first, then oldest error entries one by one.
    for key in sorted(
        (
            key
            for key in sanitized
            if key not in {"schema_version", "truncated", "recent_errors"}
        ),
        key=lambda key: _json_size(sanitized.get(key)),
        reverse=True,
    ):
        if _json_size(sanitized) <= limit:
            break
        sanitized.pop(key, None)

    errors = sanitized.get("recent_errors")
    if isinstance(errors, list):
        while len(errors) > 1 and _json_size(sanitized) > limit:
            errors.pop(0)
    if _json_size(sanitized) <= limit:
        return sanitized

    # An individual error can exceed the requested envelope. Keep its tail,
    # because exception names and final causes normally live there.
    if isinstance(errors, list) and errors:
        overhead = _json_size({**sanitized, "recent_errors": [""]})
        available = max(80, limit - overhead)
        errors[-1] = redact_text(errors[-1])[-available:]
    if _json_size(sanitized) <= limit:
        return sanitized
    return {
        **(
            {"schema_version": sanitized["schema_version"]}
            if sanitized.get("schema_version")
            else {}
        ),
        "truncated": True,
        "recent_errors": ["[TRUNCATED]"] if errors else [],
    }


def _bounded_string(
    value: Any,
    *,
    max_chars: int,
    pattern: re.Pattern[str] | None = None,
) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > max_chars:
        return None
    if pattern is not None and pattern.fullmatch(text) is None:
        return None
    return redact_text(text)[:max_chars]


def _probe_error(value: Any) -> str | None:
    return _bounded_string(value, max_chars=120, pattern=_PROBE_ERROR_RE)


def _normalize_named_presence(value: Any) -> dict[str, dict[str, bool]]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, dict[str, bool]] = {}
    for raw_name, raw_facts in islice(value.items(), _MAX_NORMALIZED_ITEMS):
        name = _bounded_string(raw_name, max_chars=64, pattern=_IDENTIFIER_RE)
        if (
            name is None
            or not isinstance(raw_facts, Mapping)
            or not isinstance(raw_facts.get("configured"), bool)
        ):
            continue
        result[name] = {"configured": raw_facts["configured"]}
    return result


def _normalize_platform_facts(
    value: Any,
    *,
    allowed: tuple[str, ...],
) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, str] = {}
    for key in allowed:
        text = _bounded_string(
            value.get(key),
            max_chars=120,
            pattern=_SAFE_PLATFORM_TEXT_RE,
        )
        if text is not None:
            result[key] = text
    error = _probe_error(value.get("probe_error"))
    if error is not None:
        result["probe_error"] = error
    return result


def _normalize_tools(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for raw_name, raw_facts in islice(value.items(), _MAX_NORMALIZED_ITEMS):
        name = _bounded_string(raw_name, max_chars=64, pattern=_TOOL_NAME_RE)
        if name is None or not isinstance(raw_facts, Mapping):
            continue
        facts: dict[str, Any] = {}
        if isinstance(raw_facts.get("available"), bool):
            facts["available"] = raw_facts["available"]
        path = _bounded_string(raw_facts.get("path"), max_chars=320)
        if path is not None and "\n" not in path and "\x00" not in path:
            facts["path"] = path
        error = _probe_error(raw_facts.get("probe_error"))
        if error is not None:
            facts["probe_error"] = error
        if facts:
            result[name] = facts
    return result


def _normalize_paths(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, (list, tuple)):
        return []
    result: list[dict[str, Any]] = []
    for raw_facts in value[:_MAX_NORMALIZED_ITEMS]:
        if not isinstance(raw_facts, Mapping):
            continue
        path = _bounded_string(raw_facts.get("path"), max_chars=320)
        if path is None or "\n" in path or "\x00" in path:
            continue
        facts: dict[str, Any] = {"path": path}
        for key in ("exists", "readable", "writable"):
            if isinstance(raw_facts.get(key), bool):
                facts[key] = raw_facts[key]
        error = _probe_error(raw_facts.get("probe_error"))
        if error is not None:
            facts["probe_error"] = error
        result.append(facts)
    return result


def _normalize_permissions(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Any] = {}
    for key in _PERMISSION_PATH_KEYS:
        raw_facts = value.get(key)
        if not isinstance(raw_facts, Mapping):
            continue
        facts: dict[str, Any] = {}
        for fact_key in ("readable", "writable"):
            if isinstance(raw_facts.get(fact_key), bool):
                facts[fact_key] = raw_facts[fact_key]
        error = _probe_error(raw_facts.get("probe_error"))
        if error is not None:
            facts["probe_error"] = error
        if facts:
            result[key] = facts
    for key in _PERMISSION_STATE_KEYS:
        state = value.get(key)
        if isinstance(state, str) and state in _SAFE_PERMISSION_STATES:
            result[key] = state
    return result


def _normalize_reachability(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, str] = {}
    for key in ("loopback", "upstream"):
        state = value.get(key)
        if isinstance(state, str) and state in _SAFE_REACHABILITY_STATES:
            result[key] = state
    return result


def _normalize_recent_errors(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, (list, tuple)):
        return []
    result: list[dict[str, Any]] = []
    for raw_error in value[-_MAX_NORMALIZED_ITEMS:]:
        if not isinstance(raw_error, Mapping):
            continue
        error: dict[str, Any] = {}
        component = _bounded_string(raw_error.get("component"), max_chars=120)
        if component is not None:
            error["component"] = component
        timestamp = raw_error.get("timestamp")
        if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
            error["timestamp"] = timestamp
        error_type = _bounded_string(
            raw_error.get("type"),
            max_chars=120,
            pattern=_PROBE_ERROR_RE,
        )
        if error_type is not None:
            error["type"] = error_type
        message = _bounded_string(raw_error.get("message"), max_chars=800)
        if message is not None:
            error["message"] = message
        stack_tail = _bounded_string(raw_error.get("stack_tail"), max_chars=1_600)
        if stack_tail is not None:
            error["stack_tail"] = stack_tail
        if error:
            result.append(error)
    return result


def normalize_diagnostic_bundle(
    bundle: Mapping[str, Any] | None,
    *,
    max_chars: int = DEFAULT_MAX_DIAGNOSTIC_CHARS,
) -> dict[str, Any] | None:
    """Validate the v1 wire schema and keep only typed, bounded facts.

    Unknown categories and unknown fields are intentionally ignored. This is
    the server-side trust boundary before student diagnostics may enter an LLM
    prompt; redaction alone is not a substitute for structural validation.
    """
    if not isinstance(bundle, Mapping):
        return None
    if bundle.get("schema_version") != DIAGNOSTIC_BUNDLE_VERSION:
        return None

    normalized: dict[str, Any] = {
        "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
    }
    categories = (
        (
            "system",
            _normalize_platform_facts(
                bundle.get("system"), allowed=("os", "arch")
            ),
        ),
        (
            "versions",
            _normalize_platform_facts(
                bundle.get("versions"),
                allowed=("python", "copilot", "workbuddy", "student_core"),
            ),
        ),
        ("environment", _normalize_named_presence(bundle.get("environment"))),
        ("proxy", _normalize_named_presence(bundle.get("proxy"))),
        ("tools", _normalize_tools(bundle.get("tools"))),
        ("paths", _normalize_paths(bundle.get("paths"))),
        ("permissions", _normalize_permissions(bundle.get("permissions"))),
        ("reachability", _normalize_reachability(bundle.get("reachability"))),
        ("recent_errors", _normalize_recent_errors(bundle.get("recent_errors"))),
    )
    for category, facts in categories:
        if facts:
            normalized[category] = facts
    normalized["truncated"] = (
        bundle.get("truncated") if isinstance(bundle.get("truncated"), bool) else False
    )
    return redact_diagnostic_bundle(normalized, max_chars=max_chars)


def record_recent_error(
    component: str,
    error: BaseException | str,
    *,
    timestamp: float | None = None,
    stack_tail: str | None = None,
) -> dict[str, Any]:
    """Record one bounded, already-redacted process-local diagnostic error."""
    if isinstance(error, BaseException):
        error_type = type(error).__name__
        message = str(error)
        if stack_tail is None:
            stack_tail = "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )
    else:
        error_type = "Error"
        message = str(error)
    entry = {
        "component": redact_text(component)[:120],
        "timestamp": float(time.time() if timestamp is None else timestamp),
        "type": redact_text(error_type)[:120],
        "message": redact_text(message[-6_400:])[-800:],
        "stack_tail": redact_text((stack_tail or "")[-8_000:])[-2_400:],
    }
    with _RECENT_ERRORS_LOCK:
        _RECENT_ERRORS.append(entry)
    return dict(entry)


def clear_recent_errors() -> None:
    """Clear the in-process error ring (used at lifecycle/test boundaries)."""
    with _RECENT_ERRORS_LOCK:
        _RECENT_ERRORS.clear()


def _recent_error_snapshot() -> list[dict[str, Any]]:
    with _RECENT_ERRORS_LOCK:
        return [dict(item) for item in _RECENT_ERRORS]


def _default_system() -> dict[str, str]:
    result: dict[str, str] = {}
    errors: list[str] = []
    for name, probe in (("os", platform.system), ("arch", platform.machine)):
        try:
            value = str(probe() or "unknown")
        except Exception as exc:
            value = "unknown"
            errors.append(type(exc).__name__)
        result[name] = value
    if errors:
        result["probe_error"] = errors[0]
    return result


def _default_versions() -> dict[str, str]:
    errors: list[str] = []
    try:
        python_version = str(platform.python_version() or "unknown")
    except Exception as exc:
        python_version = "unknown"
        errors.append(type(exc).__name__)
    try:
        copilot_version = metadata.version("workbuddy-copilot")
    except metadata.PackageNotFoundError:
        copilot_version = "development"
    except Exception as exc:
        copilot_version = "unknown"
        errors.append(type(exc).__name__)
    result = {
        "python": python_version,
        "copilot": copilot_version,
    }
    if errors:
        result["probe_error"] = errors[0]
    return result


def _default_path_probe(path: str) -> dict[str, bool]:
    candidate = Path(path).expanduser()
    return {
        "exists": candidate.exists(),
        "readable": os.access(candidate, os.R_OK),
    }


def _default_permissions() -> dict[str, Any]:
    result: dict[str, Any] = {"automation": "not_probed"}
    for name, path_probe in (("home", Path.home), ("cwd", Path.cwd)):
        facts: dict[str, Any] = {"readable": False, "writable": False}
        try:
            path = path_probe()
            facts["readable"] = bool(os.access(path, os.R_OK))
            facts["writable"] = bool(os.access(path, os.W_OK))
        except Exception as exc:
            facts["probe_error"] = type(exc).__name__
        result[name] = facts
    return result


def collect_diagnostic_bundle(
    *,
    environ: Mapping[str, str] | None = None,
    system_info: Mapping[str, Any] | None = None,
    versions: Mapping[str, Any] | None = None,
    required_env_names: Sequence[str] | None = None,
    required_tools: Sequence[str] | None = None,
    relevant_paths: Sequence[str] | None = None,
    tool_probe: Callable[[str], str | None] | None = None,
    path_probe: Callable[[str], Mapping[str, Any]] | None = None,
    permissions: Mapping[str, Any] | None = None,
    reachability: Mapping[str, Any] | None = None,
    recent_errors: Iterable[Any] | None = None,
    max_chars: int = DEFAULT_MAX_DIAGNOSTIC_CHARS,
) -> dict[str, Any]:
    """Collect safe local facts without performing any external network I/O."""
    environment = os.environ if environ is None else environ
    find_tool = tool_probe or shutil.which
    inspect_path = path_probe or _default_path_probe
    system = dict(_default_system() if system_info is None else system_info)
    version_facts = dict(_default_versions() if versions is None else versions)
    env_names = (
        DEFAULT_REQUIRED_ENV_NAMES
        if required_env_names is None
        else required_env_names
    )
    tool_names = DEFAULT_REQUIRED_TOOLS if required_tools is None else required_tools
    paths = DEFAULT_RELEVANT_PATHS if relevant_paths is None else relevant_paths
    permission_facts = _default_permissions() if permissions is None else dict(permissions)
    reachability_facts = (
        {"loopback": "not_probed", "upstream": "not_probed"}
        if reachability is None
        else dict(reachability)
    )
    error_facts = _recent_error_snapshot() if recent_errors is None else list(recent_errors)

    raw: dict[str, Any] = {
        "schema_version": DIAGNOSTIC_BUNDLE_VERSION,
        "system": system,
        "versions": version_facts,
        "environment": {
            str(name): {"configured": bool(environment.get(str(name), ""))}
            for name in env_names
        },
        "proxy": {
            name: {"configured": bool(environment.get(name, ""))}
            for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")
        },
        "tools": {},
        "paths": [],
        "permissions": permission_facts,
        "reachability": reachability_facts,
        "recent_errors": error_facts,
    }
    for name in tool_names:
        try:
            location = find_tool(str(name))
            probe_error = ""
        except Exception as exc:
            location = None
            probe_error = type(exc).__name__
        raw["tools"][str(name)] = {
            "available": bool(location),
            "path": location or "",
            **({"probe_error": probe_error} if probe_error else {}),
        }
    for path in paths:
        try:
            facts = dict(inspect_path(str(path)) or {})
        except Exception as exc:
            facts = {
                "exists": False,
                "readable": False,
                "probe_error": type(exc).__name__,
            }
        raw["paths"].append({"path": str(path), **facts})
    return redact_diagnostic_bundle(raw, max_chars=max_chars)


def diagnostic_summary(bundle: Mapping[str, Any] | None) -> dict[str, Any]:
    """Build the non-sensitive metadata persisted with a student ask."""
    value = bundle or {}
    errors = value.get("recent_errors")
    return {
        "schema_version": str(value.get("schema_version") or ""),
        "categories": sorted(
            str(key)
            for key in value
            if key not in {"schema_version", "truncated"}
        ),
        "recent_error_count": len(errors) if isinstance(errors, list) else 0,
        "truncated": bool(value.get("truncated", False)),
    }
