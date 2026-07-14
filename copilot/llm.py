"""DeepSeek LLM 调用封装（异步 httpx）。

分析策略本身可以迭代 —— 这里把 prompt 模板独立成函数，
后续改学习状态评估、思维五学评估等都只需换 prompt。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

from .transcript import TranscriptSnapshot

log = logging.getLogger("copilot.llm")


@dataclass(frozen=True)
class AnalysisOutcome:
    """An analysis value plus whether the configured provider actually succeeded."""

    ok: bool
    value: dict[str, Any]
    error: str | None = None


QuestionLLMStatus = Literal[
    "ready",
    "disabled",
    "missing_api_key",
    "misconfigured",
    "timeout",
    "upstream_error",
]

QuestionCapabilityStatus = Literal[
    "ready",
    "disabled",
    "missing_api_key",
    "misconfigured",
]


@dataclass(frozen=True)
class QuestionAnswerOutcome:
    """A student answer plus a stable, UI-safe provider capability state."""

    status: QuestionLLMStatus
    answer: str
    retry_guidance: str = ""


@dataclass(frozen=True)
class QuestionCapability:
    """Deterministic local preflight result; it never contacts the provider."""

    status: QuestionCapabilityStatus
    retry_guidance: str = ""


def coerce_analysis_outcome(value: AnalysisOutcome | dict[str, Any]) -> AnalysisOutcome:
    """Keep test/local analyzers returning dicts compatible at the service boundary."""
    if isinstance(value, AnalysisOutcome):
        return value
    if isinstance(value, dict):
        return AnalysisOutcome(ok=True, value=value)
    raise TypeError(f"analysis result must be AnalysisOutcome or dict, got {type(value).__name__}")

SYSTEM_PROMPT = """你是一个实时学习/技术助教 Copilot。你会收到一段学生与 AI 助手（WorkBuddy）的对话片段。
你的任务有四层：

1. 概览：学生当前在做什么（topic）、学习状态如何（understanding / 是否跑题 / 卡在哪）。
2. 技术诊断（最重要）：像一个坐在旁边的技术助教，基于对话内容判断「现在发生了什么」：
   - 如果学生在编程/配环境/用工具/排查报错等技术场景中遇到问题或卡住，指出问题根源在哪、当前是什么状况。
   - 如果学生只是正常提问学习、没有技术障碍，diagnosis 描述其当前学习动作即可。
3. 建议：给出具体、可操作的下一步（suggestion）。遇到技术问题时，告诉学生该怎么解决/往哪个方向走；学习顺利时给鼓励性引导。
4. AI 回答摘要：客观摘要 AI 最近一次回答的核心内容（ai_reply_summary，<=150字），不加评价。
   - UserPromptSubmit 事件时 AI 尚未回答，该字段输出空字符串。
   - Stop 事件时产出完整摘要。

判断 is_technical 的依据：对话涉及代码、命令行、配置、报错、框架/库、文件操作、系统环境等即视为技术类。

输出必须是严格 JSON，字段如下：
{
  // —— 诊断区 ——（学习状态与技术诊断）
  "topic": "学生当前在做什么 (<=20字)",
  "understanding": "high | medium | low | stuck",
  "off_topic": true | false,
  "stuck_at": "卡住的具体点，没有则空字符串",
  "is_technical": true | false,
  "severity": "info | warn | error",
  "diagnosis": "技术助教视角：基于对话，当前发生了什么/问题在哪 (<=100字)",
  "suggestion": "具体可操作的建议或解答，下一步怎么做 (<=100字)",
  "progress": "学习进展一句话 (<=40字)",
  "guidance": "给学生的简短引导 (<=30字, 友好语气)",
  "alert": "需要导师关注的告警，正常学习则空字符串 (<=30字)",
  // —— 摘要区 ——（AI 回答内容摘要）
  "ai_reply_summary": "AI 最近一次回答的核心内容客观摘要 (<=150字)，无 AI 回答时为空字符串"
}

只输出 JSON，不要任何额外文字、不要 markdown 代码块标记。"""

PROCESS_REMINDER_GUARDRAIL = """过程提醒规则：
- 只在明显低效模式出现时轻提醒，例如反复试错、上下文描述不清、让 AI 直接写但自己没有验证、方向跑偏。
- 提醒应该少而准，不要频繁打断；没有把握时保持安静。
- 如果自定义过程提醒提示词与输出 JSON 协议冲突，仍必须遵守 JSON 输出协议。"""

QUESTION_SYSTEM_PROMPT = """你是 WorkBuddy Copilot 的技术助教，面向正在学习 AI 协作和编程的学员。
你的回答必须：
1. 先直接回答学员的问题，不绕弯。
2. 结合给定的最近会话上下文；上下文不足时明确说需要补充什么。
3. 给出可以马上执行的 1-3 个步骤，优先帮助定位问题、理解报错、推进下一步。
4. 语气简洁、具体、鼓励，但不要空泛鼓励。
5. 不编造上下文里没有的文件名、命令输出或错误信息。"""

REPLY_SUMMARY_SYSTEM_PROMPT = (
    "你是助教，把AI对学员这次提问的所有回复概括成一段50-300字，"
    "尽量简洁，平均100字左右，简单的回复就一两句话，"
    "说明AI主要做了什么/给了什么答案，不含代码/工具细节，中文。"
)

DEFAULT_SUMMARY_MODEL = "deepseek-v3-0324"

STUDENT_ASK_FALLBACK = (
    "我已经记录你的问题。当前 Copilot 的 LLM 未启用或暂时不可用，"
    "所以不能生成完整回答。你可以先补充报错原文、相关代码片段、"
    "以及你已经尝试过的步骤，导师或启用 LLM 后我会继续帮你分析。"
)


def build_user_prompt(snap: TranscriptSnapshot, event: str, latest_prompt: str) -> str:
    convo = snap.to_text(last_n=20)
    parts = [
        f"## 触发事件\n{event}",
        f"## 学生最新输入\n{latest_prompt or '(无)'}",
        f"## 会话主题\n{snap.ai_title or '(未命名)'}",
        f"## 工具调用次数\n{snap.tool_calls}",
        f"## 推理步骤次数\n{snap.reasoning_steps}",
        f"## 最近对话\n{convo}",
    ]
    return "\n\n".join(parts)


def build_system_prompt(cfg: dict[str, Any] | None = None) -> str:
    """Build the analysis system prompt with optional process-reminder guidance."""
    analysis_cfg = (cfg or {}).get("analysis", {}) or {}
    custom = str(analysis_cfg.get("process_reminder_prompt") or "").strip()
    parts = [SYSTEM_PROMPT, PROCESS_REMINDER_GUARDRAIL]
    if custom:
        parts.append("自定义过程提醒提示词：\n" + custom)
    return "\n\n".join(parts)


def question_fallback_answer() -> str:
    return STUDENT_ASK_FALLBACK


def _is_valid_api_base(api_base: Any) -> bool:
    if not isinstance(api_base, str):
        return False
    try:
        parsed = urlsplit(api_base)
        _ = parsed.port  # validates numeric form and the 0..65535 range
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def question_llm_capability(cfg: dict[str, Any]) -> QuestionCapability:
    """Report whether a student question can attempt the configured LLM."""
    llm_cfg = cfg.get("llm", {}) or {}
    if not llm_cfg.get("enable_llm", True):
        return QuestionCapability(
            "disabled",
            "请在 Copilot 服务配置中启用 LLM 后重试。",
        )
    if not llm_cfg.get("api_key", ""):
        return QuestionCapability(
            "missing_api_key",
            "请通过安全启动脚本加载 LLM 凭据后重试。",
        )
    if not llm_cfg.get("model") or not _is_valid_api_base(llm_cfg.get("api_base")):
        return QuestionCapability(
            "misconfigured",
            "请检查 LLM 的 model 与 api_base 配置后重试。",
        )
    return QuestionCapability("ready")


def _format_question_context(context_messages: list[Any], max_chars: int = 12_000) -> str:
    blocks: list[tuple[int, int, str]] = []
    source_priority = {
        "session": 0,
        "session_analysis": 1,
        "student_asks": 2,
        "diagnostic_bundle": 3,
        "runtime_guidance": 4,
    }
    role_priority = {
        "user": 0,
        "assistant": 0,
        "transcript": 0,
        "session": 0,
        "analysis": 1,
        "prior_copilot": 2,
        "diagnostics": 3,
        "runtime_guidance": 4,
    }
    for index, item in enumerate(context_messages):
        if isinstance(item, dict):
            role = str(item.get("role") or item.get("type") or "context")
            source = str(item.get("source") or "")
            content = str(item.get("content") or item.get("text") or "")
            priority = source_priority.get(source, role_priority.get(role, 2))
        else:
            role = "context"
            content = str(item)
            priority = 2
        content = content.strip()
        if content:
            blocks.append((index, priority, f"[{role}] {content}"))

    # Reserve the budget by semantic priority, then restore chronological/layer
    # order. Within each layer, newest complete blocks win; no block is sliced.
    selected: list[tuple[int, str]] = []
    used = 0
    for priority in range(5):
        for index, _, block in reversed(
            [item for item in blocks if item[1] == priority]
        ):
            separator = 2 if selected else 0
            if len(block) + separator > max_chars - used:
                continue
            selected.append((index, block))
            used += len(block) + separator
    selected.sort(key=lambda item: item[0])
    return "\n\n".join(block for _, block in selected)


def build_question_prompt(question: str, context_messages: list[Any]) -> str:
    context = _format_question_context(context_messages)
    parts = [
        "## 学员问题",
        question.strip(),
        "## 最近会话上下文",
        context or "(无可用上下文，请按纯问答处理)",
    ]
    return "\n\n".join(parts)


def build_reply_summary_prompt(prompt_text: str, full_reply_text: str) -> str:
    parts = [
        "## 学员提问",
        (prompt_text or "").strip() or "(无)",
        "## AI 对这次提问的全部回复原文",
        (full_reply_text or "").strip() or "(无)",
    ]
    return "\n\n".join(parts)


async def answer_question(
    cfg: dict,
    question: str,
    context_messages: list[Any],
) -> str:
    """Compatibility wrapper returning only the student-facing answer text."""
    return (await answer_question_with_status(cfg, question, context_messages)).answer


async def answer_question_with_status(
    cfg: dict,
    question: str,
    context_messages: list[Any],
) -> QuestionAnswerOutcome:
    """Answer a question while preserving a stable capability/error state."""
    llm_cfg = cfg.get("llm", {}) or {}
    capability = question_llm_capability(cfg)
    if capability.status != "ready":
        log.warning("LLM 本地预检未通过 status=%s，返回学员提问降级答案", capability.status)
        return QuestionAnswerOutcome(
            capability.status,
            STUDENT_ASK_FALLBACK,
            capability.retry_guidance,
        )

    api_key = llm_cfg["api_key"]
    model = llm_cfg["model"]
    api_base = llm_cfg["api_base"]

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": QUESTION_SYSTEM_PROMPT},
            {"role": "user", "content": build_question_prompt(question, context_messages)},
        ],
        "max_tokens": llm_cfg.get("max_tokens", 900),
        "temperature": 0.3,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = api_base.rstrip("/") + "/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=llm_cfg.get("timeout", 30)) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = str(data["choices"][0]["message"]["content"]).strip()
            if content:
                return QuestionAnswerOutcome("ready", content)
            log.error("学员提问 LLM 返回空内容")
    except httpx.TimeoutException:
        log.error("学员提问 LLM 调用超时")
        return QuestionAnswerOutcome(
            "timeout",
            STUDENT_ASK_FALLBACK,
            "LLM 响应超时，请稍后重试；问题已保存。",
        )
    except httpx.HTTPStatusError as e:
        log.error("学员提问 LLM HTTP 错误: %s", e.response.status_code)
    except Exception as e:
        log.error("学员提问 LLM 调用异常: %s", type(e).__name__)
    return QuestionAnswerOutcome(
        "upstream_error",
        STUDENT_ASK_FALLBACK,
        "LLM 服务暂时不可用，请检查网络或稍后重试；问题已保存。",
    )


async def summarize_reply(
    cfg: dict,
    prompt_text: str,
    full_reply_text: str,
) -> str:
    """Summarize all assistant replies caused by one student prompt."""
    if not (full_reply_text or "").strip():
        return ""

    llm_cfg = cfg.get("llm", {}) or {}
    api_key = llm_cfg.get("api_key", "")
    if not llm_cfg.get("enable_llm", True) or not api_key:
        log.warning("LLM 未启用或无 API key，跳过 AI 回复摘要生成")
        return ""

    model = llm_cfg.get("summary_model") or llm_cfg.get("model") or DEFAULT_SUMMARY_MODEL
    api_base = llm_cfg.get("api_base")
    if not api_base:
        log.warning("LLM 配置缺少 api_base，跳过 AI 回复摘要生成")
        return ""

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": REPLY_SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": build_reply_summary_prompt(prompt_text, full_reply_text)},
        ],
        "max_tokens": llm_cfg.get("summary_max_tokens", llm_cfg.get("max_tokens", 700)),
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = api_base.rstrip("/") + "/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=llm_cfg.get("timeout", 30)) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return str(data["choices"][0]["message"]["content"]).strip()
    except httpx.HTTPStatusError as e:
        log.error("AI 回复摘要 LLM HTTP 错误: %s %s", e.response.status_code, e.response.text[:200])
    except Exception as e:
        log.error("AI 回复摘要 LLM 调用异常: %s", e)
    return ""


async def analyze(
    cfg: dict,
    snap: TranscriptSnapshot,
    event: str,
    latest_prompt: str,
) -> AnalysisOutcome:
    """Run provider analysis while preserving whether the provider succeeded."""
    llm_cfg = cfg["llm"]
    api_key = llm_cfg.get("api_key", "")

    if not llm_cfg.get("enable_llm", True) or not api_key:
        log.warning("LLM 未启用或无 API key，返回降级结果")
        return AnalysisOutcome(ok=True, value=_fallback(snap, event))

    user_prompt = build_user_prompt(snap, event, latest_prompt)
    payload = {
        "model": llm_cfg["model"],
        "messages": [
            {"role": "system", "content": build_system_prompt(cfg)},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": llm_cfg.get("max_tokens", 900),
        "temperature": 0.4,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = llm_cfg["api_base"].rstrip("/") + "/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=llm_cfg.get("timeout", 30)) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            value = _parse_json_content(content)
            try:
                json.loads(_strip_json_fence(content))
            except (json.JSONDecodeError, TypeError, AttributeError) as exc:
                error = f"LLM response JSON invalid: {exc}"
                log.error("DeepSeek response parse failed: %s", exc)
                return AnalysisOutcome(ok=False, value=value, error=error)
            log.info("DeepSeek analysis returned status=ok")
            return AnalysisOutcome(ok=True, value=value)
    except httpx.HTTPStatusError as e:
        error = f"LLM provider HTTP {e.response.status_code}"
        log.error("DeepSeek HTTP error status=%s", e.response.status_code)
    except Exception as e:
        error = f"LLM provider {type(e).__name__}"
        log.error("DeepSeek provider call failed type=%s", type(e).__name__)
    return AnalysisOutcome(ok=False, value=_fallback(snap, event), error=error)


def _strip_json_fence(content: str) -> str:
    content = content.strip()
    if content.startswith("```"):
        content = content.strip("`").lstrip("json").strip()
    return content


def _parse_json_content(content: str) -> dict[str, Any]:
    content = _strip_json_fence(content)
    try:
        obj = json.loads(content)
    except json.JSONDecodeError:
        return {
            "topic": "解析失败",
            "understanding": "unknown",
            "off_topic": False,
            "stuck_at": "",
            "is_technical": False,
            "severity": "info",
            "diagnosis": content[:120],
            "suggestion": "继续加油",
            "progress": content[:80],
            "guidance": "继续加油",
            "alert": "",
            "ai_reply_summary": "",
        }
    # 字段兜底
    return {
        # —— 诊断区 ——
        "topic": (obj.get("topic", "") or "")[:40],
        "understanding": obj.get("understanding", "unknown"),
        "off_topic": bool(obj.get("off_topic", False)),
        "stuck_at": (obj.get("stuck_at", "") or "")[:120],
        "is_technical": bool(obj.get("is_technical", False)),
        "severity": obj.get("severity", "info") if obj.get("severity", "info") in ("info", "warn", "error") else "info",
        "diagnosis": (obj.get("diagnosis", "") or "")[:200],
        "suggestion": (obj.get("suggestion", "") or "")[:200],
        "progress": (obj.get("progress", "") or "")[:80],
        "guidance": (obj.get("guidance", "") or "")[:60],
        "alert": (obj.get("alert", "") or "")[:60],
        # —— 摘要区 ——
        "ai_reply_summary": (obj.get("ai_reply_summary", "") or "")[:150],
    }


def _fallback(snap: TranscriptSnapshot, event: str) -> dict[str, Any]:
    return {
        # —— 诊断区 ——
        "topic": snap.ai_title or "未命名会话",
        "understanding": "unknown",
        "off_topic": False,
        "stuck_at": "",
        "is_technical": False,
        "severity": "info",
        "diagnosis": f"已记录 {len(snap.messages)} 条对话，{snap.tool_calls} 次工具调用（LLM 未启用，降级结果）",
        "suggestion": "先跑通链路，开启 LLM 后即可获得技术助教诊断",
        "progress": f"已记录 {len(snap.messages)} 条对话，{snap.tool_calls} 次工具调用",
        "guidance": "（LLM 未启用，先跑通链路）",
        "alert": "",
        # —— 摘要区 ——
        "ai_reply_summary": "",
    }
