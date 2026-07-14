"""FastAPI controller layer for WorkBuddy Copilot."""
from __future__ import annotations

import inspect
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from .app_context import (
    _extract_supplied_token,
    AppContext,
    acquire_worker_lock,
    build_context,
    get_analysis_service,
    get_context,
    get_message_service,
    get_session_service,
    get_store,
    get_upload_service,
    require_mentor_token,
    require_student_token,
    release_worker_lock,
    token_is_valid,
    validate_auth_config,
)
from .connections import WSRegistry
from .llm import (
    QuestionAnswerOutcome,
    answer_question_with_status as llm_answer_question_with_status,
    coerce_analysis_outcome,
    question_llm_capability,
    question_fallback_answer,
)
from .models import AnalysisResult
from .services import (
    EXPLICIT_RAW_TRANSCRIPT_MARKER,
    AnalysisService,
    MessageService,
    SessionQueryService,
)
from .store import Store
from .student_core.diagnostics import (
    diagnostic_summary,
    normalize_diagnostic_bundle,
)
from .upload_service import (
    InvalidStateTransition,
    UploadRequestNotFound,
    UploadRequestService,
    UploadTranscriptNotFound,
)
from .transcript import Message, TranscriptSnapshot, parse_text, parse_turns

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("copilot.service")


class ReportIn(BaseModel):
    student_id: str
    session_id: str | None = None
    event: str
    prompt: str = ""
    transcript_tail: str | None = None
    transcript_full: str | None = None
    cwd: str | None = None


class MentorMessageIn(BaseModel):
    student_id: str
    text: str
    mentor_id: str | None = None


class StudentMessageAckIn(BaseModel):
    student_id: str
    message_id: str


_STUDENT_ASK_ID_MAX_CHARS = 160
_STUDENT_ASK_SESSION_MAX_CHARS = 256
_STUDENT_ASK_QUESTION_MAX_CHARS = 16_000
_STUDENT_ASK_INPUT_DIAGNOSTIC_MAX_BYTES = 64_000
_STUDENT_ASK_INPUT_DIAGNOSTIC_MAX_NODES = 512
_STUDENT_ASK_BODY_MAX_BYTES = 96_000


def _input_node_count(value: Any, *, stop_after: int) -> int:
    stack = [value]
    seen: set[int] = set()
    count = 0
    while stack:
        current = stack.pop()
        count += 1
        if count > stop_after:
            return count
        if isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                continue
            seen.add(identity)
            stack.extend(current.values())
        elif isinstance(current, (list, tuple)):
            identity = id(current)
            if identity in seen:
                continue
            seen.add(identity)
            stack.extend(current)
    return count


class StudentAskIn(BaseModel):
    student_id: str = Field(max_length=_STUDENT_ASK_ID_MAX_CHARS)
    question: str = Field(max_length=_STUDENT_ASK_QUESTION_MAX_CHARS)
    session_id: str | None = Field(
        default=None,
        max_length=_STUDENT_ASK_SESSION_MAX_CHARS,
    )
    include_diagnostics: bool = True
    diagnostic_bundle: dict[str, Any] | None = None
    context_mode: Literal["sync_then_ask", "without_session"] | None = None

    @model_validator(mode="after")
    def validate_diagnostic_input_bounds(self):
        bundle = self.diagnostic_bundle
        if bundle is None:
            return self
        if _input_node_count(
            bundle,
            stop_after=_STUDENT_ASK_INPUT_DIAGNOSTIC_MAX_NODES,
        ) > _STUDENT_ASK_INPUT_DIAGNOSTIC_MAX_NODES:
            raise ValueError("diagnostic_bundle has too many nodes")
        try:
            serialized_size = len(
                json.dumps(bundle, ensure_ascii=False).encode("utf-8")
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("diagnostic_bundle is not JSON serializable") from exc
        if serialized_size > _STUDENT_ASK_INPUT_DIAGNOSTIC_MAX_BYTES:
            raise ValueError("diagnostic_bundle is too large")
        return self


class SyncSessionIn(BaseModel):
    session_id: str
    title: str = ""
    work_dir: str = ""
    group_type: Literal["space", "task"] | None = None
    space_name: str = ""
    created_at: float | None = None
    last_activity_at: float | None = None


class SessionsSyncIn(BaseModel):
    student_id: str
    sessions: list[SyncSessionIn]


class TranscriptUploadIn(BaseModel):
    student_id: str
    filtered_content: Any
    sha: str
    request_id: str | None = None


class MentorUploadRequestIn(BaseModel):
    mentor_id: str | None = None
    session_id: str | None = None


class UploadRequestStatusIn(BaseModel):
    student_id: str
    status: Literal["pending", "running", "done", "failed"]
    error_message: str | None = None
    result: dict[str, Any] | None = None


_STUDENT_ASK_DIAGNOSTIC_MAX_CHARS = 3_000
_STUDENT_RAW_PARSE_MAX_CHARS = 256_000


def _complete_line_tail(
    content: str | bytes,
    max_chars: int,
    *,
    head_may_be_partial: bool = False,
) -> str:
    """Return bounded content proven complete by both newline boundaries."""
    if isinstance(content, bytes):
        bounded = content
        if len(bounded) > max_chars:
            boundary = bounded.find(b"\n", len(bounded) - max_chars)
            if boundary < 0:
                return ""
            bounded = bounded[boundary + 1 :]
        elif head_may_be_partial:
            boundary = bounded.find(b"\n")
            if boundary < 0:
                return ""
            bounded = bounded[boundary + 1 :]
        last_boundary = bounded.rfind(b"\n")
        if last_boundary < 0:
            return ""
        return bounded[: last_boundary + 1].decode("utf-8", errors="replace")
    raw = str(content)
    if len(raw) > max_chars:
        boundary = raw.find("\n", len(raw) - max_chars)
        if boundary < 0:
            return ""
        raw = raw[boundary + 1 :]
    elif head_may_be_partial:
        boundary = raw.find("\n")
        if boundary < 0:
            return ""
        raw = raw[boundary + 1 :]
    last_boundary = raw.rfind("\n")
    if last_boundary < 0:
        return ""
    return raw[: last_boundary + 1]


def _question_context_from_raw(
    content: str | bytes | None,
    *,
    session_id: str = "",
    head_may_be_partial: bool = False,
) -> list[dict[str, str]]:
    if not content:
        return []
    bounded = _complete_line_tail(
        content,
        _STUDENT_RAW_PARSE_MAX_CHARS,
        head_may_be_partial=head_may_be_partial,
    )
    if not bounded:
        return []
    snap = parse_text(bounded)
    messages = [
        {
            "role": msg.role,
            "content": msg.text,
            "source": "session",
            "session_id": session_id,
        }
        for msg in snap.messages[-8:]
        if msg.text
    ]
    if messages:
        return messages
    return []


def _question_context_from_recent(
    rows: list[dict],
    *,
    session_id: str = "",
) -> list[dict[str, str]]:
    context: list[dict[str, str]] = []
    for row in reversed(rows):
        parts: list[str] = []
        topic = row.get("topic") or ""
        diagnosis = row.get("diagnosis") or ""
        suggestion = row.get("suggestion") or ""
        progress = row.get("progress") or ""
        if topic:
            parts.append(f"主题：{topic}")
        if diagnosis:
            parts.append(f"诊断：{diagnosis}")
        if suggestion:
            parts.append(f"建议：{suggestion}")
        if progress:
            parts.append(f"进展：{progress}")
        if parts:
            context.append({
                "role": "analysis",
                "content": "；".join(parts),
                "source": "session_analysis",
                "session_id": session_id,
            })
    return context


def _question_context_from_prior_asks(
    rows: list[dict],
    *,
    sessionless_only: bool = False,
) -> list[dict[str, str]]:
    context: list[dict[str, str]] = []
    for row in reversed(rows[:3]):
        if sessionless_only and str(row.get("session_id") or ""):
            continue
        question = str(row.get("question") or "").strip()[-800:]
        answer = str(row.get("answer") or "").strip()[-1_400:]
        if not question and not answer:
            continue
        content = f"学员曾问：{question}\n助教回答：{answer}"
        context.append({
            "role": "prior_copilot",
            "content": content,
            "source": "student_asks",
            "session_id": str(row.get("session_id") or ""),
        })
    return context


def _runtime_guidance(config: dict[str, Any]) -> list[dict[str, str]]:
    """Normalize runtime-customizable guidance into versioned prompt entries."""
    raw: Any = config.get("guidance")
    if raw is None:
        raw = (config.get("student_assistant", {}) or {}).get("guidance")
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    result: list[dict[str, str]] = []
    for index, item in enumerate(items):
        if isinstance(item, str):
            text = item.strip()
            version = str(config.get("guidance_version") or f"runtime-guidance-{index + 1}")
            enabled = True
        elif isinstance(item, dict):
            text = str(item.get("text") or item.get("prompt") or "").strip()
            version = str(item.get("version") or f"runtime-guidance-{index + 1}").strip()
            enabled = item.get("enabled", True) is not False
        else:
            continue
        if enabled and text and version:
            result.append({"version": version[:120], "text": text[-800:]})
    return result[:2]


def _build_student_question_context(
    store: Store,
    student_id: str,
    session_id: str | None,
    *,
    context_mode: Literal["sync_then_ask", "without_session"] | None,
    diagnostic_bundle: dict[str, Any] | None,
    guidance: list[dict[str, str]],
) -> tuple[list[dict[str, str]], str]:
    context: list[dict[str, str]] = []
    session_context: list[dict[str, str]] = []
    session_exists = False
    if session_id and context_mode != "without_session":
        session_exists = store.session_exists_for_student(student_id, session_id)
        if session_exists:
            raw = store.get_raw_transcript_tail_for_student_session(
                student_id,
                session_id,
                max_chars=_STUDENT_RAW_PARSE_MAX_CHARS,
            )
            session_context.extend(
                _question_context_from_raw(
                    (raw or {}).get("content"),
                    session_id=session_id,
                    head_may_be_partial=bool((raw or {}).get("content_truncated")),
                )
            )
            recent = store.recent_analyses(student_id, limit=3, session_id=session_id)
            session_context.extend(
                _question_context_from_recent(recent, session_id=session_id)
            )
            context.extend(session_context)

    context.extend(_question_context_from_prior_asks(
        store.list_student_asks(student_id, limit=3),
        sessionless_only=context_mode == "without_session",
    ))
    if diagnostic_bundle is not None:
        context.append({
            "role": "diagnostics",
            "content": json.dumps(diagnostic_bundle, ensure_ascii=False),
            "source": "diagnostic_bundle",
            "session_id": "",
        })
    for item in guidance:
        context.append({
            "role": "runtime_guidance",
            "content": f"指导版本 {item['version']}：{item['text']}",
            "source": "runtime_guidance",
            "session_id": "",
        })

    if context_mode == "without_session":
        context_status = "without_session"
    elif session_id and not session_exists:
        context_status = "not_synced"
    elif session_id and not session_context:
        context_status = "no_context"
    elif context:
        context_status = "ready"
    else:
        context_status = "no_context"
    return context, context_status


def _student_ask_timeout(config: dict[str, Any]) -> float:
    try:
        base = float(config.get("llm", {}).get("timeout", 30))
    except (TypeError, ValueError):
        base = 30.0
    return min(max(base + 5.0, 5.0), 45.0)


async def _handle_stop_background(
    analysis_svc: AnalysisService,
    student_id: str,
    session_id: str,
    prompt: str,
    transcript_content: str,
    report_id: int,
) -> None:
    try:
        await analysis_svc.handle_stop(
            student_id=student_id,
            session_id=session_id,
            prompt_text=prompt,
            transcript_content=transcript_content,
            report_id=report_id,
        )
    except Exception as exc:
        log.exception("background Stop analysis failed report_id=%s: %s", report_id, exc)


def _filtered_content_to_raw(filtered_content: Any) -> str:
    """Normalize already-filtered uploaded message content into JSONL text."""
    if filtered_content is None:
        return ""
    if isinstance(filtered_content, str):
        return filtered_content
    if isinstance(filtered_content, (bytes, bytearray)):
        return bytes(filtered_content).decode("utf-8", errors="replace")
    if isinstance(filtered_content, dict):
        for key in ("messages", "items", "lines"):
            value = filtered_content.get(key)
            if isinstance(value, list):
                return _filtered_content_to_raw(value)
        return json.dumps(filtered_content, ensure_ascii=False)
    if isinstance(filtered_content, list):
        lines: list[str] = []
        for item in filtered_content:
            if isinstance(item, (dict, list)):
                lines.append(json.dumps(item, ensure_ascii=False))
            else:
                lines.append(str(item))
        return "\n".join(lines)
    return str(filtered_content)


def _bulk_upload_llm_enabled(config: dict[str, Any]) -> bool:
    analysis_cfg = config.get("analysis", {}) or {}
    if not analysis_cfg.get("enable_llm", True):
        return False
    llm_cfg = config.get("llm", {}) or {}
    if not llm_cfg.get("enable_llm", True):
        return False
    return bool(
        llm_cfg.get("api_key")
        and llm_cfg.get("model")
        and llm_cfg.get("api_base")
    )


def _upload_request_to_response(row: dict[str, Any]) -> dict[str, Any]:
    result = None
    result_json = row.get("result_json")
    if result_json:
        try:
            result = json.loads(str(result_json))
        except json.JSONDecodeError:
            result = None
    transfer_status = str(row.get("transfer_status") or {
        "done": "stored",
    }.get(str(row.get("status") or "pending"), row.get("status") or "pending"))
    legacy_status = {
        "pending": "pending",
        "running": "running",
        "stored": "done",
        "failed": "failed",
    }.get(transfer_status, str(row.get("status") or "pending"))
    analysis_status = str(row.get("analysis_status") or "not_requested")
    transfer_error = str(row.get("transfer_error") or "")
    analysis_error = str(row.get("analysis_error") or "")
    if transfer_status == "failed":
        compatibility_error = transfer_error
    elif analysis_status == "failed":
        compatibility_error = analysis_error
    else:
        compatibility_error = str(row.get("error_message") or "")
    return {
        "request_id": row.get("request_id"),
        "mentor_id": row.get("mentor_id"),
        "student_id": row.get("student_id"),
        "session_id": row.get("session_id") or "",
        "status": legacy_status,
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at") or row.get("created_at"),
        "error_message": compatibility_error,
        "result": result,
        "transfer_status": transfer_status,
        "analysis_status": analysis_status,
        "transfer_error": transfer_error,
        "analysis_error": analysis_error,
    }


def _mentor_upload_request_to_response(
    row: dict[str, Any],
    registry: WSRegistry,
) -> dict[str, Any]:
    """Add an ephemeral student connection hint to a mentor-only snapshot."""
    response = _upload_request_to_response(row)
    response["student_online"] = registry.is_float_connected(
        str(row.get("student_id") or "")
    )
    return response


def _snapshot_from_turns(turns: list[dict[str, Any]]) -> TranscriptSnapshot:
    snap = TranscriptSnapshot()
    for turn in turns:
        role = str(turn.get("role") or "")
        text = str(turn.get("text") or "")
        if role not in {"user", "assistant"} or not text:
            continue
        snap.messages.append(
            Message(role=role, text=text, timestamp=turn.get("ts"))
        )
    return snap


def _latest_user_prompt(turns: list[dict[str, Any]]) -> str:
    for turn in reversed(turns):
        if turn.get("role") == "user" and turn.get("text"):
            return str(turn["text"])
    return ""


async def _analyze_uploaded_session_background(
    context: AppContext,
    student_id: str,
    session_id: str,
    turns: list[dict[str, Any]],
    sha: str,
    request_id: str | None = None,
) -> tuple[bool, str]:
    """Run bounded LLM analysis for an uploaded historical session."""
    try:
        if request_id:
            await _mark_upload_child_and_publish(
                context, request_id, student_id, session_id, "running", sha=sha
            )
        context.store.set_raw_transcript_analysis_status(
            session_id,
            student_id,
            status="running",
            content_sha256=sha,
        )
        snap = _snapshot_from_turns(turns)
        latest_prompt = _latest_user_prompt(turns)
        llm_config = (
            context.analysis_svc._config_with_prompt_overrides()
            if hasattr(context.analysis_svc, "_config_with_prompt_overrides")
            else context.config
        )
        async with context.analysis_svc.analysis_semaphore:
            raw_outcome = await context.analysis_svc.llm(
                llm_config,
                snap,
                "Stop",
                latest_prompt,
            )
        outcome = coerce_analysis_outcome(raw_outcome)
        if not outcome.ok:
            raise RuntimeError(outcome.error or "LLM provider analysis failed")
        result = AnalysisResult.from_dict(outcome.value)
        session_title = context.store.get_session_title(session_id)
        report_id = context.store.commit_bulk_analysis_if_current(
            student_id=student_id,
            session_id=session_id,
            content_sha256=sha,
            result=result.to_dict(),
            session_title=session_title,
            msg_count=len(snap.messages),
        )
        if report_id is None:
            log.info(
                "bulk analysis discarded stale_sha student=%s session=%s sha=%s",
                student_id,
                session_id[:8],
                sha[:12],
            )
            if request_id:
                await _mark_upload_child_and_publish(
                    context, request_id, student_id, session_id, "failed",
                    error="analysis stale transcript", sha=sha,
                )
            return False, "analysis stale transcript"
        await context.bus.publish({
            "type": "analysis",
            "student_id": student_id,
            "session_id": session_id,
            "session_title": session_title,
            "report_id": report_id,
            "event": "BulkUpload",
            "prompt": latest_prompt[:120],
            "result": result.to_dict(),
            "timestamp": time.time(),
        })
        log.info(
            "bulk upload analysis complete student=%s session=%s report_id=%s",
            student_id,
            session_id[:8],
            report_id,
        )
        if request_id:
            await _mark_upload_child_and_publish(
                context, request_id, student_id, session_id, "done", sha=sha
            )
        return True, ""
    except Exception as exc:
        error_code = _stable_background_analysis_error(exc)
        context.store.set_raw_transcript_analysis_status(
            session_id,
            student_id,
            status="failed",
            error_message=error_code,
            content_sha256=sha,
        )
        log.error(
            "bulk upload analysis failed student=%s session=%s error=%s type=%s",
            student_id,
            session_id[:8],
            error_code,
            type(exc).__name__,
        )
        if request_id:
            await _mark_upload_child_and_publish(
                context, request_id, student_id, session_id, "failed",
                error=error_code, sha=sha,
            )
        return False, error_code


def _stable_background_analysis_error(exc: Exception) -> str:
    """Return a bounded error code without provider response or exception details."""
    message = str(exc)
    if message.startswith("LLM provider HTTP "):
        return " ".join(message.split()[:4])[:80]
    if message.startswith("LLM provider "):
        return " ".join(message.split()[:3])[:80]
    if message.startswith("LLM response JSON invalid"):
        return "LLM response JSON invalid"
    return f"analysis {type(exc).__name__}"


async def _publish_upload_request_status(
    context: AppContext,
    row: dict[str, Any],
) -> None:
    """Publish a persisted request snapshot to mentor sockets only."""
    snapshot = _mentor_upload_request_to_response(row, context.ws_registry)
    snapshot["result"] = _sanitize_upload_event_result(snapshot.get("result"))
    await context.bus.publish({
        "type": "upload_request_status",
        **snapshot,
        "timestamp": time.time(),
    })


async def _publish_upload_parent_rows(
    context: AppContext,
    rows: list[dict[str, Any]],
) -> None:
    for row in rows:
        await _publish_upload_request_status(context, row)


async def _mark_upload_child_and_publish(
    context: AppContext,
    request_id: str,
    student_id: str,
    session_id: str,
    status: str,
    *,
    error: str = "",
    sha: str | None = None,
) -> None:
    _child, rows = context.upload_svc.mark_session_analysis(
        request_id,
        student_id,
        session_id,
        status,
        error=error,
        sha=sha,
    )
    await _publish_upload_parent_rows(context, rows)


def _sanitize_upload_event_result(value: Any) -> Any:
    """Return only bounded aggregate counters from a client-controlled result."""
    if not isinstance(value, dict):
        return None
    sanitized: dict[str, int] = {}
    for key in ("total", "synced", "skipped", "failed"):
        item = value.get(key)
        if isinstance(item, int) and not isinstance(item, bool) and 0 <= item <= 1_000_000:
            sanitized[key] = item
    return sanitized


async def _retry_upload_request_analysis_background(
    context: AppContext,
    request_id: str,
    student_id: str,
    session_id: str,
    raw: str,
    sha: str,
) -> None:
    """Analyze the already-persisted raw transcript and mirror request status."""
    try:
        children = context.store.list_upload_request_sessions(request_id)
        has_child = any(child.get("session_id") == session_id for child in children)
        if has_child:
            await _mark_upload_child_and_publish(
                context, request_id, student_id, session_id, "running", sha=sha
            )
        else:
            running = context.upload_svc.mark_analysis(
                request_id, student_id, "running", error=""
            )
            await _publish_upload_request_status(context, running)
        turns = parse_turns(parse_text(raw).messages)
        ok, error = await _analyze_uploaded_session_background(
            context,
            student_id,
            session_id,
            turns,
            sha,
        )
        if has_child:
            await _mark_upload_child_and_publish(
                context,
                request_id,
                student_id,
                session_id,
                "done" if ok else "failed",
                error="" if ok else error,
                sha=sha,
            )
        elif ok:
            final = context.upload_svc.mark_analysis(
                request_id, student_id, "done", error=""
            )
        else:
            final = context.upload_svc.mark_analysis(
                request_id, student_id, "failed", error=error
            )
        if not has_child:
            await _publish_upload_request_status(context, final)
    except (InvalidStateTransition, UploadRequestNotFound) as exc:
        log.warning(
            "upload request retry state changed request_id=%s error=%s",
            request_id,
            exc,
        )


async def _recover_pending_reports(ctx: AppContext) -> None:
    pending_reports = ctx.store.list_pending_reports()
    if not pending_reports:
        return

    stop_reports = [row for row in pending_reports if row.get("event") == "Stop"]
    log.warning(
        "recovering %d pending Stop reports from previous process",
        len(stop_reports),
    )
    for row in stop_reports:
        report_id = int(row["id"])
        student_id = str(row.get("student_id") or "")
        session_id = str(row.get("session_id") or "")
        if ctx.store.analysis_exists_for_report(report_id):
            log.warning(
                "pending Stop report_id=%s already has analysis; clearing pending flag",
                report_id,
            )
            ctx.store.set_analysis_pending(report_id, False)
            continue

        transcript_content = ""
        if (
            session_id
            and row.get("transcript_path") == EXPLICIT_RAW_TRANSCRIPT_MARKER
        ):
            raw = ctx.store.get_raw_transcript_for_report(session_id, row.get("created_at"))
            transcript_content = (raw or {}).get("content") or ""
        log.info(
            "requeue pending Stop report_id=%s student=%s session=%s transcript_bytes=%d",
            report_id,
            student_id,
            (session_id or "?")[:8],
            len(transcript_content.encode("utf-8")),
        )
        await _handle_stop_background(
            ctx.analysis_svc,
            student_id,
            session_id,
            str(row.get("prompt") or ""),
            transcript_content,
            report_id,
        )


def create_app(context: AppContext | None = None) -> FastAPI:
    ctx = context or build_context()
    startup_upload_svc = ctx.upload_svc or UploadRequestService(ctx.store)
    if ctx.upload_svc is None:
        ctx.upload_svc = startup_upload_svc
    validate_auth_config(ctx.config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        log.info("Copilot service starting, student=%s", ctx.config.get("student_id", ""))
        try:
            acquire_worker_lock(ctx)
            recovered_uploads = startup_upload_svc.recover_interrupted_analysis()
            if recovered_uploads:
                log.warning(
                    "recovered %d interrupted upload analyses",
                    len(recovered_uploads),
                )
            await _recover_pending_reports(ctx)
            yield
        finally:
            release_worker_lock(ctx)
            log.info("Copilot service stopped")

    app = FastAPI(title="WorkBuddy Copilot", version="0.2.0", lifespan=lifespan)
    app.state.context = ctx

    @app.middleware("http")
    async def reject_oversized_student_ask(request: Request, call_next):
        if request.method == "POST" and request.url.path == "/api/student/ask":
            raw_length = request.headers.get("content-length")
            if raw_length:
                try:
                    content_length = int(raw_length)
                except ValueError:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "invalid Content-Length"},
                    )
                if content_length > _STUDENT_ASK_BODY_MAX_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "student ask request is too large"},
                    )
            chunks: list[bytes] = []
            received = 0
            async for chunk in request.stream():
                received += len(chunk)
                if received > _STUDENT_ASK_BODY_MAX_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "student ask request is too large"},
                    )
                chunks.append(chunk)
            # Starlette replays a cached body to the downstream parser. This
            # enforces the same limit for chunked/missing/incorrect lengths.
            request._body = b"".join(chunks)
        return await call_next(request)

    from .mentor.routes import router as mentor_router

    app.include_router(mentor_router, dependencies=[Depends(require_mentor_token)])

    static_dir = Path(__file__).parent / "static" / "mentor"
    if static_dir.exists():
        from fastapi.staticfiles import StaticFiles

        app.mount(
            "/mentor",
            StaticFiles(directory=str(static_dir), html=True),
            name="mentor-static",
        )

    @app.get("/health")
    async def health(context: AppContext = Depends(get_context)):
        return {"status": "UP", "student": context.config.get("student_id", "")}

    @app.post("/report", status_code=202)
    async def report(
        data: ReportIn,
        background_tasks: BackgroundTasks,
        _: None = Depends(require_student_token),
        analysis_svc: AnalysisService = Depends(get_analysis_service),
    ):
        transcript_content = data.transcript_tail or ""
        try:
            report_id, session_id, snap = analysis_svc.accept_report(
                student_id=data.student_id,
                session_id=data.session_id,
                event=data.event,
                prompt_text=data.prompt,
                transcript_content=transcript_content,
                raw_transcript_content=data.transcript_full,
                cwd=data.cwd,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        log.info(
            "report accepted student=%s session=%s event=%s msgs=%d tools=%d",
            data.student_id,
            (session_id or "?")[:8],
            data.event,
            len(snap.messages),
            snap.tool_calls,
        )

        body: dict[str, Any] = {"status": "accepted", "report_id": report_id}
        if data.event == "UserPromptSubmit":
            body["prompt_id"] = await analysis_svc.handle_user_prompt_submit(
                data.student_id,
                session_id,
                data.prompt,
            )
        elif data.event == "Stop":
            background_tasks.add_task(
                _handle_stop_background,
                analysis_svc,
                data.student_id,
                session_id,
                data.prompt,
                transcript_content,
                report_id,
            )
        return body

    @app.get("/recent")
    async def recent(
        student_id: str,
        limit: int = 20,
        session_id: str | None = None,
        _: None = Depends(require_student_token),
        store: Store = Depends(get_store),
    ):
        scoped_student_id = student_id.strip()
        if not scoped_student_id:
            raise HTTPException(status_code=400, detail="student_id is required")
        return {
            "items": store.recent_analyses(
                scoped_student_id,
                limit=limit,
                session_id=session_id,
            )
        }

    @app.get("/api/student/capabilities")
    async def get_student_capabilities(
        student_id: str,
        _: None = Depends(require_student_token),
        context: AppContext = Depends(get_context),
    ):
        if not student_id.strip():
            raise HTTPException(status_code=400, detail="student_id is required")
        capability = question_llm_capability(context.config)
        return {
            "llm_status": capability.status,
            "retry_guidance": capability.retry_guidance,
        }

    @app.post("/api/sessions/sync")
    async def sync_sessions(
        data: SessionsSyncIn,
        _: None = Depends(require_student_token),
        store: Store = Depends(get_store),
    ):
        """Accept student-machine session inventory and upsert it into copilot.db."""
        store.upsert_student(data.student_id)
        synced = 0
        for session in data.sessions:
            if not session.session_id:
                log.warning("skip sync session with empty session_id student=%s", data.student_id)
                continue
            try:
                store.upsert_session(
                    session_id=session.session_id,
                    student_id=data.student_id,
                    work_dir=session.work_dir,
                    title=session.title,
                    created_at=session.created_at,
                    last_activity_at=session.last_activity_at,
                    group_type=session.group_type,
                    space_name=session.space_name,
                )
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            synced += 1
        log.info("sessions sync accepted student=%s synced=%d", data.student_id, synced)
        return {"ok": True, "synced": synced}

    @app.post("/api/student/sessions/{session_id}/transcript")
    async def upload_session_transcript(
        session_id: str,
        data: TranscriptUploadIn,
        background_tasks: BackgroundTasks,
        _: None = Depends(require_student_token),
        context: AppContext = Depends(get_context),
        store: Store = Depends(get_store),
        upload_svc: UploadRequestService = Depends(get_upload_service),
    ):
        """Accept one already-filtered session transcript from a student client."""
        student_id = data.student_id.strip()
        sha = data.sha.strip()
        if not student_id:
            raise HTTPException(status_code=400, detail="student_id is required")
        if not sha:
            raise HTTPException(status_code=400, detail="sha is required")

        request_id = (data.request_id or "").strip() or None
        analysis_scheduled = _bulk_upload_llm_enabled(context.config)

        known = store.get_known_session_shas(student_id)
        known_entry = known.get(session_id) or {}
        raw_row = store.get_raw_transcript_for_student_session_sha(
            student_id, session_id, sha
        )
        if request_id:
            raw_status = str((raw_row or {}).get("analysis_status") or "")
            if not analysis_scheduled:
                child_status = "not_requested"
            else:
                child_status = "done" if raw_status == "done" else "pending"
            try:
                _child, parent_rows = upload_svc.register_session(
                    request_id,
                    student_id,
                    session_id,
                    sha,
                    analysis_status=child_status,
                )
            except UploadRequestNotFound as exc:
                raise HTTPException(status_code=404, detail="upload request not found") from exc
            except InvalidStateTransition as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            await _publish_upload_parent_rows(context, parent_rows)
        if known_entry.get("sha") == sha:
            retry_analysis = (
                bool(raw_row)
                and raw_row.get("analysis_status") != "done"
                and analysis_scheduled
            )
            if retry_analysis:
                raw = str((raw_row or {}).get("content") or "")
                turns = parse_turns(parse_text(raw).messages)
                store.set_raw_transcript_analysis_status(
                    session_id,
                    student_id,
                    status="pending",
                    error_message="",
                    content_sha256=sha,
                )
                background_tasks.add_task(
                    _analyze_uploaded_session_background,
                    context,
                    student_id,
                    session_id,
                    turns,
                    sha,
                    request_id,
                )
                log.info(
                    "bulk transcript unchanged; retrying failed analysis student=%s session=%s sha=%s",
                    student_id,
                    session_id[:8],
                    sha[:12],
                )
                return {
                    "ok": True,
                    "skipped": True,
                    "session_id": session_id,
                    "sha": sha,
                    "stored": 0,
                    "analysis_scheduled": True,
                    "retry_analysis": True,
                }
            log.info(
                "bulk transcript skipped unchanged student=%s session=%s sha=%s",
                student_id,
                session_id[:8],
                sha[:12],
            )
            return {
                "ok": True,
                "skipped": True,
                "session_id": session_id,
                "sha": sha,
                "stored": 0,
                "analysis_scheduled": False,
                "retry_analysis": False,
            }

        raw = _filtered_content_to_raw(data.filtered_content)
        snap = parse_text(raw)
        turns = parse_turns(snap.messages)
        try:
            stored = store.replace_session_messages(
                session_id=session_id,
                student_id=student_id,
                turns=turns,
                raw=raw,
                sha=sha,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        store.set_raw_transcript_analysis_status(
            session_id,
            student_id,
            status="pending" if analysis_scheduled else "skipped",
            error_message="",
            content_sha256=sha,
        )
        if analysis_scheduled:
            background_tasks.add_task(
                _analyze_uploaded_session_background,
                context,
                student_id,
                session_id,
                turns,
                sha,
                request_id,
            )
        log.info(
            "bulk transcript accepted student=%s session=%s messages=%d sha=%s llm=%s",
            student_id,
            session_id[:8],
            stored,
            sha[:12],
            analysis_scheduled,
        )
        return {
            "ok": True,
            "skipped": False,
            "session_id": session_id,
            "sha": sha,
            "stored": stored,
            "analysis_scheduled": analysis_scheduled,
            "retry_analysis": False,
        }

    @app.get("/api/transcripts/known")
    async def known_transcript_shas(
        student_id: str,
        manifest_version: int = 1,
        _: None = Depends(require_student_token),
        store: Store = Depends(get_store),
    ):
        manifest = store.get_known_session_shas(student_id)
        if manifest_version >= 2:
            return manifest
        return {session_id: entry["sha"] for session_id, entry in manifest.items()}

    @app.post("/api/mentor/students/{student_id}/request-upload")
    async def request_student_upload(
        student_id: str,
        data: MentorUploadRequestIn | None = None,
        _: None = Depends(require_mentor_token),
        context: AppContext = Depends(get_context),
        upload_svc: UploadRequestService = Depends(get_upload_service),
    ):
        body = data or MentorUploadRequestIn()
        mentor_id = (body.mentor_id or "mentor").strip() or "mentor"
        session_id = (body.session_id or "").strip() or None
        request_id = upload_svc.create(
            mentor_id=mentor_id,
            student_id=student_id,
            session_id=session_id,
        )
        payload = {
            "type": "mentor_command",
            "student_id": student_id,
            "command": "upload_conversations",
            "request_id": request_id,
            "session_id": session_id or "",
            "mentor_id": mentor_id,
            "timestamp": time.time(),
        }
        await context.bus.publish(payload)
        log.info(
            "upload requested mentor=%s student=%s session=%s request_id=%s",
            mentor_id,
            student_id,
            session_id or "*",
            request_id,
        )
        return {
            "request_id": request_id,
            "status": "pending",
            "student_id": student_id,
            "session_id": session_id or "",
            "transfer_status": "pending",
            "analysis_status": "not_requested",
            "student_online": context.ws_registry.is_float_connected(student_id),
        }

    @app.get("/api/mentor/upload-requests/{request_id}")
    async def get_mentor_upload_request(
        request_id: str,
        _: None = Depends(require_mentor_token),
        context: AppContext = Depends(get_context),
        upload_svc: UploadRequestService = Depends(get_upload_service),
    ):
        try:
            row = upload_svc.get(request_id)
        except UploadRequestNotFound as exc:
            raise HTTPException(status_code=404, detail="upload request not found") from exc
        return _mentor_upload_request_to_response(row, context.ws_registry)

    @app.post(
        "/api/mentor/upload-requests/{request_id}/retry-analysis",
        status_code=202,
    )
    async def retry_mentor_upload_analysis(
        request_id: str,
        background_tasks: BackgroundTasks,
        _: None = Depends(require_mentor_token),
        context: AppContext = Depends(get_context),
        upload_svc: UploadRequestService = Depends(get_upload_service),
    ):
        try:
            pending, work_items = upload_svc.prepare_analysis_retry(request_id)
        except UploadRequestNotFound as exc:
            raise HTTPException(status_code=404, detail="upload request not found") from exc
        except UploadTranscriptNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except InvalidStateTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        response = _mentor_upload_request_to_response(pending, context.ws_registry)
        await _publish_upload_request_status(context, pending)
        for item in work_items:
            raw_row = item["raw"]
            background_tasks.add_task(
                _retry_upload_request_analysis_background,
                context,
                request_id,
                str(pending.get("student_id") or ""),
                str(item.get("session_id") or ""),
                str(raw_row.get("content") or ""),
                str(item.get("sha") or ""),
            )
        return response

    @app.get("/api/student/upload-requests")
    async def list_student_upload_requests(
        student_id: str,
        status: Literal["pending", "running", "done", "failed", "all"] = "pending",
        _: None = Depends(require_student_token),
        upload_svc: UploadRequestService = Depends(get_upload_service),
    ):
        scoped_student_id = student_id.strip()
        if not scoped_student_id:
            raise HTTPException(status_code=400, detail="student_id is required")
        status_value = None if status == "all" else status
        return {"items": [
            _upload_request_to_response(row)
            for row in upload_svc.list(
                student_id=scoped_student_id,
                status=status_value,
            )
        ]}

    @app.post("/api/student/upload-requests/{request_id}/status")
    async def update_student_upload_request_status(
        request_id: str,
        data: UploadRequestStatusIn,
        _: None = Depends(require_student_token),
        context: AppContext = Depends(get_context),
        upload_svc: UploadRequestService = Depends(get_upload_service),
    ):
        transfer_status = "stored" if data.status == "done" else data.status
        try:
            row = upload_svc.mark_transfer(
                request_id,
                data.student_id,
                transfer_status,
                error=data.error_message,
                result=data.result,
            )
        except UploadRequestNotFound as exc:
            raise HTTPException(status_code=404, detail="upload request not found")
        except InvalidStateTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        await _publish_upload_request_status(context, row)
        parent_rows = upload_svc.refresh_parent_analysis(request_id, data.student_id)
        await _publish_upload_parent_rows(context, parent_rows)
        latest = parent_rows[-1] if parent_rows else row
        return _upload_request_to_response(latest)

    @app.get("/sessions")
    async def list_sessions(
        student_id: str,
        limit: int = 10,
        _: None = Depends(require_student_token),
        session_svc: SessionQueryService = Depends(get_session_service),
    ):
        sid = student_id.strip()
        if not sid:
            raise HTTPException(status_code=400, detail="student_id is required")
        conversations = session_svc.list_sessions(sid, limit=limit)
        return {"items": [c.__dict__ for c in conversations]}

    @app.get("/current_session")
    async def current_session(
        student_id: str,
        work_dir: str | None = None,
        _: None = Depends(require_student_token),
        session_svc: SessionQueryService = Depends(get_session_service),
    ):
        sid = student_id.strip()
        if not sid:
            raise HTTPException(status_code=400, detail="student_id is required")
        active = session_svc.get_active_session(work_dir, student_id=sid)
        if not active:
            return {"session_id": None, "items": []}
        all_sessions = session_svc.list_all_sessions_with_title(work_dir, student_id=sid, limit=8)
        items = [{
            "session_id": s["session_id"],
            "work_dir": s["work_dir"],
            "resumed_at": s["resumed_at"],
            "session_title": s.get("title", ""),
            "is_active": s["session_id"] == active["session_id"],
        } for s in all_sessions]
        return {
            "session_id": active["session_id"],
            "work_dir": active["work_dir"],
            "resumed_at": active["resumed_at"],
            "items": items,
        }

    @app.get("/alerts/unread")
    async def unread_alerts(
        student_id: str,
        since: float = 0.0,
        _: None = Depends(require_student_token),
        store: Store = Depends(get_store),
    ):
        scoped_student_id = student_id.strip()
        if not scoped_student_id:
            raise HTTPException(status_code=400, detail="student_id is required")
        return {"items": store.unread_alerts(since, scoped_student_id)}

    @app.post("/api/mentor/message")
    async def send_mentor_message(
        data: MentorMessageIn,
        _: None = Depends(require_mentor_token),
        message_svc: MessageService = Depends(get_message_service),
    ):
        return await message_svc.send(
            student_id=data.student_id,
            mentor_id=data.mentor_id,
            text=data.text,
        )

    @app.get("/api/student/messages")
    async def get_student_messages(
        student_id: str,
        since: int = 0,
        limit: int | None = None,
        _: None = Depends(require_student_token),
        message_svc: MessageService = Depends(get_message_service),
    ):
        return {"items": message_svc.get_catchup(student_id, since, limit=limit)}

    @app.get("/api/student/messages/pending-receipts")
    async def get_pending_student_message_receipts(
        student_id: str,
        limit: int = 64,
        after_id: int = 0,
        _: None = Depends(require_student_token),
        message_svc: MessageService = Depends(get_message_service),
    ):
        return {
            "items": message_svc.get_pending_receipts(
                student_id,
                limit=limit,
                after_id=after_id,
            )
        }

    @app.post("/api/student/messages/ack")
    async def ack_student_message(
        data: StudentMessageAckIn,
        _: None = Depends(require_student_token),
        message_svc: MessageService = Depends(get_message_service),
    ):
        result = message_svc.ack(data.message_id, data.student_id)
        ok = await result if inspect.isawaitable(result) else result
        if not ok:
            raise HTTPException(status_code=404, detail="message not found")
        return {"ok": True}

    @app.post("/api/student/ask")
    async def ask_copilot(
        data: StudentAskIn,
        _: None = Depends(require_student_token),
        context: AppContext = Depends(get_context),
        store: Store = Depends(get_store),
    ):
        student_id = data.student_id.strip()
        question = data.question.strip()
        session_id = (data.session_id or "").strip() or None
        if not student_id:
            raise HTTPException(status_code=400, detail="student_id is required")
        if not question:
            raise HTTPException(status_code=400, detail="question is required")

        sanitized_diagnostics = None
        if data.include_diagnostics and data.diagnostic_bundle is not None:
            candidate_diagnostics = normalize_diagnostic_bundle(
                data.diagnostic_bundle,
                max_chars=_STUDENT_ASK_DIAGNOSTIC_MAX_CHARS,
            )
            if candidate_diagnostics is not None:
                sanitized_diagnostics = candidate_diagnostics
            else:
                log.info("student diagnostic bundle ignored: unsupported schema")
        guidance = _runtime_guidance(context.config)
        guidance_versions = [item["version"] for item in guidance]
        context_messages, context_status = _build_student_question_context(
            store,
            student_id,
            session_id,
            context_mode=data.context_mode,
            diagnostic_bundle=sanitized_diagnostics,
            guidance=guidance,
        )
        try:
            llm_outcome = await asyncio.wait_for(
                llm_answer_question_with_status(context.config, question, context_messages),
                timeout=_student_ask_timeout(context.config),
            )
        except asyncio.TimeoutError:
            log.warning("student ask LLM timed out, using fallback")
            llm_outcome = QuestionAnswerOutcome(
                "timeout",
                question_fallback_answer(),
                "LLM 响应超时，请稍后重试；问题已保存。",
            )
        except Exception as exc:
            log.warning(
                "student ask LLM failed, using fallback type=%s",
                type(exc).__name__,
            )
            llm_outcome = QuestionAnswerOutcome(
                "upstream_error",
                question_fallback_answer(),
                "LLM 服务暂时不可用，请检查网络或稍后重试；问题已保存。",
            )

        ask_id = store.add_student_ask(
            student_id=student_id,
            session_id=session_id,
            question=question,
            answer=llm_outcome.answer,
            diagnostics_attached=sanitized_diagnostics is not None,
            diagnostics_summary=(
                diagnostic_summary(sanitized_diagnostics)
                if sanitized_diagnostics is not None
                else None
            ),
            diagnostics_version=(
                str(sanitized_diagnostics.get("schema_version") or "")
                if sanitized_diagnostics is not None
                else ""
            ),
            guidance_versions=guidance_versions,
            context_status=context_status,
            llm_status=llm_outcome.status,
        )
        await context.bus.publish({
            "type": "student_ask",
            "student_id": student_id,
            "session_id": session_id or "",
            "ask_id": ask_id,
            "question": question[:300],
            "context_status": context_status,
            "llm_status": llm_outcome.status,
            "timestamp": time.time(),
        })
        return {
            "ask_id": ask_id,
            "answer": llm_outcome.answer,
            "context_status": context_status,
            "llm_status": llm_outcome.status,
            "retry_guidance": llm_outcome.retry_guidance,
            "diagnostics_attached": sanitized_diagnostics is not None,
            "guidance_versions": guidance_versions,
        }

    @app.delete("/api/admin/students/{student_id}")
    async def delete_student(
        student_id: str,
        _: None = Depends(require_mentor_token),
        store: Store = Depends(get_store),
    ):
        return {"deleted": store.delete_student(student_id)}

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        context: AppContext = ws.app.state.context
        registry = context.ws_registry
        student_id = ws.query_params.get("student_id") or ""
        token = _extract_supplied_token(
            ws.headers.get("authorization"),
            ws.headers.get("x-copilot-token"),
        ) or ws.query_params.get("token")
        if not student_id or not token_is_valid(context.config, token, role="student"):
            await ws.close(code=1008)
            return
        await ws.accept()
        registry.register_float(student_id, ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.warning("float WS error: %s", exc)
        finally:
            registry.unregister_float(student_id, ws)

    @app.websocket("/ws/mentor")
    async def mentor_ws(ws: WebSocket):
        context: AppContext = ws.app.state.context
        registry = context.ws_registry
        token = ws.query_params.get("token")
        if not token_is_valid(context.config, token, role="mentor"):
            await ws.close(code=1008)
            return
        await ws.accept()
        registry.register_mentor(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.warning("mentor WS error: %s", exc)
        finally:
            registry.unregister_mentor(ws)

    return app


app = create_app()
ws_clients = app.state.context.ws_registry.floats
mentor_ws_clients = app.state.context.ws_registry.mentors
