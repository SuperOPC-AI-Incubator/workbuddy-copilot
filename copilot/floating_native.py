"""桌面浮动图标 — 原生 NSPanel 实现（PyObjC）。

放弃 PyQt6，直接用 macOS 原生 NSPanel，确保跨 Space（含全屏应用）显示。

核心配置（4 要素，来自 ClaudeLauncher/SpacePin 等成熟方案）：
  1. 窗口类型: NSPanel + styleMask = [.borderless, .nonactivatingPanel]
  2. collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
  3. level = .floating
  4. isMovableByWindowBackground = true

启动:
  python3 -m copilot.floating_native
"""
from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import time
import threading
import urllib.parse
import urllib.request
from typing import Any, Optional

import asyncio
import websockets

from . import wb_sync, wb_upload
from .config import load_config, service_url, ws_url

log = logging.getLogger("copilot.floating_native")

# ── pyobjc imports ──

import objc
from AppKit import (
    NSApplication,
    NSApp,
    NSPanel,
    NSWindow,
    NSView,
    NSColor,
    NSImage,
    NSGradient,
    NSCompositingOperationSourceOver,
    NSBezierPath,
    NSGraphicsContext,
    NSVisualEffectView,
    NSBackingStoreBuffered,
    NSWindowStyleMaskBorderless,
    NSWindowStyleMaskNonactivatingPanel,
    NSWindowStyleMaskTitled,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskUtilityWindow,
    NSWindowCollectionBehaviorCanJoinAllSpaces,
    NSWindowCollectionBehaviorFullScreenAuxiliary,
    NSWindowCollectionBehaviorStationary,
    NSWindowCollectionBehaviorIgnoresCycle,
    NSFloatingWindowLevel,
    NSApplicationActivationPolicyAccessory,
    NSMenu,
    NSMenuItem,
    NSScreen,
    NSRunLoop,
    NSTimer,
    NSStatusBar,
    NSStatusItem,
    NSVariableStatusItemLength,
    NSScrollView,
    NSTextField,
    NSTextView,
    NSButton,
    NSPopUpButton,
    NSPasteboard,
    NSPasteboardTypeString,
    NSSwitchButton,
    NSControlStateValueOn,
    NSAttributedString,
    NSFont,
    NSForegroundColorAttributeName,
    NSFontAttributeName,
    NSTrackingArea,
    NSTrackingAreaOptions,
    NSEvent,
)
from Foundation import (
    NSObject,
    NSMutableAttributedString,
    NSRect,
    NSPoint,
    NSSize,
    NSMakeRect,
    NSMakePoint,
    NSMakeSize,
    NSMakeRange,
)
from CoreFoundation import CFRunLoopRunInMode, kCFRunLoopDefaultMode
from PyObjCTools import AppHelper

# ── 常量 ──

ICON_SIZE = 40.0           # 圆形图标直径（pt），在 48pt 窗口中留出边距，更像豆包
WINDOW_SIZE = 48.0         # 浮动窗口尺寸（pt）
PANEL_WIDTH = 380
PANEL_MAX_HEIGHT = 520
PANEL_GAP = 8.0
PANEL_BACKGROUND_COLOR_RGB = (27 / 255, 33 / 255, 48 / 255)  # #1b2130
PANEL_SESSION_BAR_COLOR_RGB = (31 / 255, 41 / 255, 55 / 255)  # #1f2937
PANEL_CARD_COLOR_RGB = (37 / 255, 44 / 255, 58 / 255)  # #252c3a
PANEL_TEXT_COLOR_RGB = (229 / 255, 231 / 255, 235 / 255)  # #e5e7eb
PANEL_HEADING_TEXT_COLOR_RGB = (249 / 255, 250 / 255, 251 / 255)  # #f9fafb
PANEL_SECONDARY_TEXT_COLOR_RGB = (156 / 255, 163 / 255, 175 / 255)  # #9ca3af
PANEL_INPUT_TEXT_COLOR_RGB = (31 / 255, 41 / 255, 55 / 255)  # #1f2937
PANEL_INFO_MARKER_RGB = (96 / 255, 165 / 255, 250 / 255)  # #60a5fa
PANEL_WARN_MARKER_RGB = (251 / 255, 191 / 255, 36 / 255)  # #fbbf24
PANEL_ERROR_MARKER_RGB = (248 / 255, 113 / 255, 113 / 255)  # #f87171
PANEL_MENTOR_MARKER_RGB = (244 / 255, 114 / 255, 182 / 255)  # #f472b6
MAX_PERSISTED_SEEN_MENTOR_MESSAGE_IDS = 200
PENDING_RECEIPT_PAGE_LIMIT = 64
MAX_PENDING_RECEIPT_PAGES_PER_SYNC = 8
PENDING_RECEIPT_RETRY_DELAY_SECONDS = 2.0
PENDING_RECEIPT_DIRECT_ACK_LIMIT = 64
SESSION_SELECTOR_LIMIT = 1000

_EMPTY_STATE_MESSAGES = {
    "no_local_sessions": "还没有发现 WorkBuddy 对话。先在 WorkBuddy 中开始一个对话吧。",
    "not_synced": "当前对话尚未同步。请先同步最近内容，或不带对话上下文直接提问。",
    "synced_no_analysis": "当前对话已同步，但还没有分析记录。你仍可以直接向 Copilot 提问。",
    "service_unavailable": "Copilot 服务暂时不可用。请确认服务已启动后重试。",
    "llm_unavailable": "Copilot 已连接，但 LLM 暂不可用。请检查模型配置或稍后重试。",
}


def _session_activity_ts(session: dict[str, Any]) -> float:
    for key in ("last_activity_at", "last_activity", "last_ts", "resumed_at", "updated_at", "created_at"):
        value = session.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return 0.0


def _sort_sessions_for_selector(sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the shared dropdown/shortcut order without mutating callers."""
    group_rank = {"task": 0, "space": 1}
    return sorted(
        (dict(session) for session in sessions if session.get("session_id")),
        key=lambda session: (
            group_rank.get(str(session.get("group_type") or ""), 2),
            -_session_activity_ts(session),
            str(session.get("session_id") or ""),
        ),
    )


def _session_inventory_signature(sessions: list[dict[str, Any]]) -> tuple[tuple[Any, ...], ...]:
    """Capture raw inventory and sort inputs for worker-snapshot freshness checks."""
    return tuple(
        (
            str(session.get("session_id") or ""),
            str(session.get("session_title") or session.get("title") or ""),
            str(session.get("group_type") or ""),
            str(session.get("space_name") or ""),
            _session_activity_ts(session),
            bool(session.get("is_active")),
        )
        for session in sessions
    )


def _session_selector_render_signature(
    sessions: list[dict[str, Any]],
    session_state: dict[str, dict[str, Any]],
    current_session_id: str | None,
) -> tuple[tuple[Any, ...], ...]:
    """Capture only values that affect the already-sorted native selector UI."""
    group_labels = {"task": "任务", "space": "空间"}
    current = str(current_session_id or "")
    return tuple(
        (
            session_id,
            str(
                session.get("session_title")
                or session.get("title")
                or session_id[:8]
                or "?"
            ),
            group_labels.get(str(session.get("group_type") or ""), "其他"),
            str(session.get("space_name") or ""),
            bool(session.get("is_active")),
            session_state.get(session_id, {}).get("unread", 0),
            session_id == current,
        )
        for session in sessions
        if (session_id := str(session.get("session_id") or ""))
    )


def _empty_state_message(state: str) -> str:
    return _EMPTY_STATE_MESSAGES.get(state, _EMPTY_STATE_MESSAGES["synced_no_analysis"])


def _analysis_empty_state(
    local_sessions: list[dict[str, Any]],
    current_session_id: str | None,
    synced_session_ids: set[str],
    service_available: bool,
    llm_status: str,
) -> str:
    if not service_available:
        return "service_unavailable"
    if llm_status and llm_status != "ready":
        return "llm_unavailable"
    if not local_sessions:
        return "no_local_sessions"
    if current_session_id and current_session_id not in synced_session_ids:
        return "not_synced"
    return "synced_no_analysis"


def _format_student_ask_response(data: dict[str, Any]) -> tuple[str, str, str]:
    """Turn the structured ask contract into readable, legacy-safe text."""
    answer = str(data.get("answer") or "Copilot 暂时没有返回答案。")
    context_status = str(data.get("context_status") or "ready")
    # Missing status means an older service did not report capability.  It is
    # not evidence that the configured upstream LLM is usable.
    llm_status = str(data.get("llm_status") or "unknown")
    retry_guidance = str(data.get("retry_guidance") or "").strip()

    notes: list[str] = []
    if context_status == "not_synced":
        notes.append("当前对话尚未同步，这次回答未使用该对话的完整上下文。")
    elif context_status == "without_session":
        notes.append("这次提问没有选择对话，回答未带对话上下文。")
    elif context_status == "no_context":
        notes.append("已选择对话，但暂时没有可用的对话上下文。")
    if llm_status == "unknown":
        notes.append("当前服务未报告 LLM 状态（unknown），无法确认模型是否可用。")
    elif llm_status != "ready":
        notes.append(f"LLM 暂不可用（{llm_status}），下方是 Copilot 的降级指引。")
    diagnostics_attached = data.get("diagnostics_attached")
    if diagnostics_attached is True:
        notes.append("本次已附加脱敏诊断信息。")
    elif diagnostics_attached is False:
        notes.append("本次未附加诊断信息。")

    if not notes and not retry_guidance:
        return answer, context_status, llm_status
    parts = notes + [answer]
    if retry_guidance and retry_guidance not in answer:
        parts.append(retry_guidance)
    return "\n\n".join(part for part in parts if part), context_status, llm_status


def _collect_diagnostic_bundle() -> dict[str, Any] | None:
    try:
        from .student_core.diagnostics import collect_diagnostic_bundle
    except (ImportError, AttributeError):
        return None
    try:
        bundle = collect_diagnostic_bundle()
    except Exception as exc:
        log.debug("收集诊断信息失败: %s", exc)
        return None
    return bundle if isinstance(bundle, dict) else None


def _record_recent_error(component: str, error: BaseException | str) -> None:
    """Best-effort bridge to the bounded, redacted Student Core error ring."""
    try:
        from .student_core.diagnostics import record_recent_error

        record_recent_error(component, error)
    except Exception:
        # Diagnostics must never turn a recoverable student-side failure into a new failure.
        log.debug("诊断错误环写入失败 component=%s", component)


def _copy_text_to_pasteboard(text: str, pasteboard=None) -> bool:
    if not text:
        return False
    board = pasteboard or NSPasteboard.generalPasteboard()
    board.clearContents()
    return bool(board.setString_forType_(text, NSPasteboardTypeString))


def _rect_xywh(rect) -> tuple[float, float, float, float]:
    """Return x/y/width/height for NSRect-like objects or plain tuples."""
    if isinstance(rect, (tuple, list)):
        return float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3])
    return (
        float(rect.origin.x),
        float(rect.origin.y),
        float(rect.size.width),
        float(rect.size.height),
    )


def _size_wh(size) -> tuple[float, float]:
    if isinstance(size, (tuple, list)):
        return float(size[0]), float(size[1])
    return float(size.width), float(size.height)


def _clamp(value: float, lower: float, upper: float) -> float:
    if upper < lower:
        return lower
    return min(max(value, lower), upper)


def _panel_origin_for_icon(icon_frame, panel_size, screen_frame, gap: float = PANEL_GAP) -> tuple[float, float]:
    """Place the analysis panel near the floating icon while staying on screen."""
    icon_x, icon_y, icon_w, icon_h = _rect_xywh(icon_frame)
    panel_w, panel_h = _size_wh(panel_size)
    screen_x, screen_y, screen_w, screen_h = _rect_xywh(screen_frame)
    screen_right = screen_x + screen_w
    screen_top = screen_y + screen_h

    y_centered = icon_y + (icon_h - panel_h) / 2
    y = _clamp(y_centered, screen_y, screen_top - panel_h)

    left_x = icon_x - gap - panel_w
    if left_x >= screen_x:
        return left_x, y

    right_x = icon_x + icon_w + gap
    if right_x + panel_w <= screen_right:
        return right_x, y

    below_y = icon_y - gap - panel_h
    above_y = icon_y + icon_h + gap
    x = _clamp(icon_x + (icon_w - panel_w) / 2, screen_x, screen_right - panel_w)
    if below_y >= screen_y:
        return x, below_y
    if above_y + panel_h <= screen_top:
        return x, above_y
    return x, y


def _panel_text_color():
    return NSColor.colorWithRed_green_blue_alpha_(*PANEL_TEXT_COLOR_RGB, 1.0)


def _panel_color(rgb, alpha: float = 1.0):
    return NSColor.colorWithRed_green_blue_alpha_(*rgb, alpha)


def _panel_background_color():
    return _panel_color(PANEL_BACKGROUND_COLOR_RGB)


def _panel_session_bar_color():
    return _panel_color(PANEL_SESSION_BAR_COLOR_RGB)


def _panel_card_color():
    return _panel_color(PANEL_CARD_COLOR_RGB)


def _panel_heading_text_color():
    return _panel_color(PANEL_HEADING_TEXT_COLOR_RGB)


def _panel_secondary_text_color():
    return _panel_color(PANEL_SECONDARY_TEXT_COLOR_RGB)


def _panel_input_text_color():
    return _panel_color(PANEL_INPUT_TEXT_COLOR_RGB)


def _panel_marker_color(severity: str = "info", *, alert: bool = False, mentor: bool = False, tech: bool = False):
    if mentor:
        return _panel_color(PANEL_MENTOR_MARKER_RGB)
    if severity == "error" or alert:
        return _panel_color(PANEL_ERROR_MARKER_RGB)
    if severity == "warn":
        return _panel_color(PANEL_WARN_MARKER_RGB)
    if tech:
        return _panel_color(PANEL_INFO_MARKER_RGB)
    return _panel_color(PANEL_SECONDARY_TEXT_COLOR_RGB)


def _line_attributes(kind: str, font_size: float = 12.0) -> dict:
    if kind == "heading":
        return {
            NSForegroundColorAttributeName: _panel_heading_text_color(),
            NSFontAttributeName: NSFont.boldSystemFontOfSize_(font_size),
        }
    if kind == "secondary":
        return {
            NSForegroundColorAttributeName: _panel_secondary_text_color(),
            NSFontAttributeName: NSFont.systemFontOfSize_(font_size),
        }
    if kind == "alert":
        return {
            NSForegroundColorAttributeName: _panel_color(PANEL_ERROR_MARKER_RGB),
            NSFontAttributeName: NSFont.systemFontOfSize_(font_size),
        }
    return {
        NSForegroundColorAttributeName: _panel_text_color(),
        NSFontAttributeName: NSFont.systemFontOfSize_(font_size),
    }


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _attributed_panel_lines(lines: list[tuple[str, str]], font_size: float = 12.0):
    text = "\n".join(line for line, _kind in lines)
    attributed = NSMutableAttributedString.alloc().initWithString_attributes_(
        text,
        _line_attributes("body", font_size),
    )
    offset = 0
    for line, kind in lines:
        length = _utf16_len(line)
        if length:
            for attr, value in _line_attributes(kind, font_size).items():
                attributed.addAttribute_value_range_(attr, value, NSMakeRange(offset, length))
        offset += length + 1
    return attributed


def _set_button_title(button, title: str, color, font_size: float = 10.0):
    attrs = {
        NSForegroundColorAttributeName: color,
        NSFontAttributeName: NSFont.systemFontOfSize_(font_size),
    }
    button.setAttributedTitle_(NSAttributedString.alloc().initWithString_attributes_(title, attrs))


def _resolve_icon_path():
    """解析 data/assets/icon.png 的绝对路径（支持模块化运行）。"""
    candidates = [
        # 模块运行 (python3 -m copilot.floating_native)
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "assets", "icon.png"),
        # 直接运行 (python3 copilot/floating_native.py)
        os.path.join(os.path.dirname(__file__), "..", "data", "assets", "icon.png"),
        # 工作目录
        os.path.join(os.getcwd(), "data", "assets", "icon.png"),
    ]
    for c in candidates:
        p = os.path.abspath(c)
        if os.path.isfile(p):
            log.info("找到图标: %s", p)
            return p
    log.warning("未找到图标文件，将回退到内置绘制")
    return None


def _configured_token(cfg: dict[str, Any]) -> str:
    auth = cfg.get("auth", {}) or {}
    return (
        os.environ.get("COPILOT_STUDENT_TOKEN")
        or os.environ.get("COPILOT_TOKEN")
        or str(auth.get("student_token", "") or "")
        or str(cfg.get("auth", {}).get("token", "") or "")
        or str(cfg.get("service", {}).get("token", "") or "")
        or str(cfg.get("token", "") or "")
    )


def _build_float_ws_url(
    cfg: dict[str, Any],
    student_id: str,
    last_seen_message_id: int = 0,
    *,
    redact_token: bool = False,
) -> str:
    query = {}
    if student_id:
        query["student_id"] = student_id
    token = _configured_token(cfg)
    if token:
        query["token"] = "<redacted>" if redact_token else token
    if last_seen_message_id:
        query["last_seen_message_id"] = str(last_seen_message_id)
    base = ws_url(cfg)
    return base + ("?" + urllib.parse.urlencode(query) if query else "")

# ── 浮动图标 View（纯 CoreGraphics 绘制）──


class IconView(NSView):
    """自定义 NSView：绘制 AI 生成的图标（icon.png）+ 未读角标 + 脉冲光晕。"""

    def init_with_state(self, state_holder):
        self = objc.super(IconView, self).init()
        if self is None:
            return None
        self._state_holder = state_holder
        self._unread = 0
        self._state = "idle"
        self._pulse_phase = 0.0
        self._is_dragging = False
        return self

    def set_state_(self, state, unread=0):
        self._state = state
        self._unread = unread
        self.setNeedsDisplay_(True)

    def drawRect_(self, rect):
        ctx = NSGraphicsContext.currentContext()
        ctx.saveGraphicsState()

        w = self.frame().size.width
        h = self.frame().size.height
        cx = w / 2
        cy = h / 2
        r = ICON_SIZE / 2

        # ── 完全透明背景 ──
        NSColor.clearColor().set()
        NSBezierPath.fillRect_(self.bounds())

        # ── 光晕（仅在 alert 状态，且更克制）──
        # 普通 unread 状态不再画光晕，避免浅蓝色外框感
        if self._state == "alert":
            alpha = 0.25 + 0.10 * (0.5 + 0.5 * self._pulse_phase)
            glow_color = NSColor.colorWithRed_green_blue_alpha_(1.0, 0.42, 0.42, alpha)
            glow_color.set()
            # 光晕在图标圆内，不超过 circle 边界，避免被窗口裁出奇怪形状
            glow_rect = NSMakeRect(cx - r - 1, cy - r - 1, (r + 1) * 2, (r + 1) * 2)
            NSBezierPath.bezierPathWithOvalInRect_(glow_rect).fill()

        # ── 蓝紫渐变圆形（主图标）──
        circle_rect = NSMakeRect(cx - r, cy - r, r * 2, r * 2)
        circle_path = NSBezierPath.bezierPathWithOvalInRect_(circle_rect)

        # 用 NSGradient 画线性渐变（蓝 → 紫）
        blue = NSColor.colorWithRed_green_blue_alpha_(0.29, 0.42, 0.97, 1.0)    # #4A6CF7
        purple = NSColor.colorWithRed_green_blue_alpha_(0.61, 0.36, 0.90, 1.0)  # #9B5DE5
        gradient = NSGradient.alloc().initWithColors_([blue, purple])
        if gradient is not None:
            # 从左下到右上
            gradient.drawInBezierPath_angle_(circle_path, 45.0)
        else:
            # 回退：纯色
            blue.set()
            circle_path.fill()

        # ── 白色毕业帽图标（帽子占圆的比例放大到 0.72）──
        self._draw_graduation_cap(cx, cy, r * 0.72)

        # ── 未读提示：小红点（仅在 alert 状态显示，unread 不显示避免视觉干扰）──
        if self._state == "alert":
            dot_r = 5.0
            # 放在圆边缘右上
            dot_x = cx + r * 0.85
            dot_y = cy + r * 0.85
            dot_rect = NSMakeRect(dot_x - dot_r, dot_y - dot_r, dot_r * 2, dot_r * 2)
            NSColor.colorWithRed_green_blue_alpha_(1.0, 0.30, 0.30, 1.0).set()
            NSBezierPath.bezierPathWithOvalInRect_(dot_rect).fill()
            # 小白边
            white_ring = NSBezierPath.bezierPathWithOvalInRect_(
                NSMakeRect(dot_x - dot_r - 0.6, dot_y - dot_r - 0.6, (dot_r + 0.6) * 2, (dot_r + 0.6) * 2)
            )
            white_ring.setLineWidth_(1.0)
            NSColor.whiteColor().set()
            white_ring.stroke()

    def _draw_graduation_cap(self, cx, cy, r):
        """绘制白色毕业帽图标，比例适配 40pt 圆内。"""
        white = NSColor.whiteColor()
        white.set()

        # 帽顶：菱形，比原来更饱满
        cap_r = r * 0.85
        diamond = NSBezierPath.bezierPath()
        diamond.moveToPoint_(NSMakePoint(cx, cy + cap_r * 0.9))    # 上顶点
        diamond.lineToPoint_(NSMakePoint(cx + cap_r * 1.2, cy + cap_r * 0.1))  # 右
        diamond.lineToPoint_(NSMakePoint(cx, cy - cap_r * 0.7))    # 下
        diamond.lineToPoint_(NSMakePoint(cx - cap_r * 1.2, cy + cap_r * 0.1))  # 左
        diamond.closePath()
        diamond.fill()

        # 帽底：梯形，更宽一些，增加稳重感
        base_w = cap_r * 0.9
        base_h = cap_r * 0.45
        base_y = cy - cap_r * 0.7
        base = NSBezierPath.bezierPath()
        base.moveToPoint_(NSMakePoint(cx - base_w, base_y + base_h * 0.5))
        base.lineToPoint_(NSMakePoint(cx + base_w, base_y + base_h * 0.5))
        base.lineToPoint_(NSMakePoint(cx + base_w * 0.75, base_y - base_h))
        base.lineToPoint_(NSMakePoint(cx - base_w * 0.75, base_y - base_h))
        base.closePath()
        base.fill()

        # 穗：从右侧帽顶边缘向右下延伸
        tassel_start = NSMakePoint(cx + cap_r * 1.2, cy + cap_r * 0.1)
        tassel_end = NSMakePoint(cx + cap_r * 1.55, cy - cap_r * 0.6)
        tassel = NSBezierPath.bezierPath()
        tassel.moveToPoint_(tassel_start)
        tassel.lineToPoint_(tassel_end)
        tassel.setLineWidth_(1.8)
        tassel.stroke()

        # 穗头小圆
        dot_r = r * 0.13
        dot_rect = NSMakeRect(tassel_end.x - dot_r, tassel_end.y - dot_r, dot_r * 2, dot_r * 2)
        NSBezierPath.bezierPathWithOvalInRect_(dot_rect).fill()

    def mouseDown_(self, event):
        # 记录拖动起点（用屏幕坐标，避免坐标系转换问题）
        self._drag_start = self.window().convertBaseToScreen_(event.locationInWindow())
        self._win_origin = self.window().frame().origin
        self._is_dragging = False
        # 拖动开始时暂停脉冲动画，避免重绘干扰移动
        self._state_holder.pause_pulse()

    def mouseDragged_(self, event):
        current = self.window().convertBaseToScreen_(event.locationInWindow())
        dx = current.x - self._drag_start.x
        dy = current.y - self._drag_start.y

        # 超过阈值才算拖动（避免误触点击）
        if not self._is_dragging and (abs(dx) > 2 or abs(dy) > 2):
            self._is_dragging = True

        if self._is_dragging:
            # setFrameOrigin_ 是最轻量的移动方式
            new_x = self._win_origin.x + dx
            new_y = self._win_origin.y + dy
            self.window().setFrameOrigin_(NSMakePoint(new_x, new_y))

    def mouseUp_(self, event):
        was_dragging = self._is_dragging
        self._is_dragging = False
        # 恢复脉冲动画
        self._state_holder.resume_pulse()
        # 判断点击（移动距离小且未被判定为拖动）
        current = self.window().convertBaseToScreen_(event.locationInWindow())
        moved = abs(current.x - self._drag_start.x) + abs(current.y - self._drag_start.y)
        if moved < 5 and not was_dragging:
            self._state_holder.toggle_panel()

    def acceptsFirstMouse_(self, event):
        return True


# ── 浮动图标 Panel（NSPanel 子类）──


class FloatingIconPanel(NSPanel):

    def canBecomeKey(self):
        return False

    def canBecomeMain(self):
        return False

    def acceptsFirstResponder(self):
        return False


# ── 分析面板（弹出窗口）──


class AnalysisPanelWindow(NSPanel):

    def canBecomeKey(self):
        # 默认不抢键盘焦点；只有提问输入框被点击时临时允许。
        return bool(getattr(self, "_allows_keyboard_focus", False))

    def canBecomeMain(self):
        return False

    def acceptsFirstResponder(self):
        return bool(getattr(self, "_allows_keyboard_focus", False))

    def setAllowsKeyboardFocus_(self, allow):
        self._allows_keyboard_focus = bool(allow)


class AskTextField(NSTextField):
    """Question input that can opt the nonactivating panel into keyboard focus."""

    def init_with_owner(self, owner):
        self = objc.super(AskTextField, self).init()
        if self is None:
            return None
        self._owner = owner
        return self

    def mouseDown_(self, event):
        owner = getattr(self, "_owner", None)
        if owner is not None:
            owner._begin_ask_focus()
        objc.super(AskTextField, self).mouseDown_(event)

    def becomeFirstResponder(self):
        owner = getattr(self, "_owner", None)
        if owner is not None:
            owner._enable_panel_keyboard_focus()
        return objc.super(AskTextField, self).becomeFirstResponder()

    def acceptsFirstMouse_(self, event):
        return True


# ── 主控制器 ──


class CopilotNativeApp(NSObject):
    """主控制器：管理浮动图标 + 分析面板 + WS 连接。"""

    def init_app(self):
        self = objc.super(CopilotNativeApp, self).init()
        if self is None:
            return None

        self.cfg = load_config()
        self._unread_count = 0
        self._panel_visible = False
        self._items = []
        self._mentor_items = []
        self._seen_mentor_message_ids = set()
        self._seen_mentor_message_order = []
        self._pending_receipt_message_ids = set()
        self._unpersisted_rendered_message_ids = {}
        self._rendering_mentor_message_ids = set()
        self._pending_receipt_after_id = 0
        self._receipt_ack_inflight_ids = set()
        self._mentor_message_state_lock = threading.RLock()
        self._pending_receipt_retry_task = None
        self._ws_asyncio_loop = None
        self._last_seen_mentor_message_id = 0
        self._mentor_unread = 0
        self._student_id = self.cfg.get("student_id") or os.environ.get("COPILOT_STUDENT_ID", "")
        self._upload_requests_inflight = set()
        self._load_mentor_message_state()
        # 多对话状态
        self._sessions = {}            # session_id -> {title, last_ts, unread, last_result}
        self._sessions_list = []       # 切换栏显示的有序列表
        self._current_session_id = None
        self._wb_sessions = []         # WorkBuddy 侧会话列表（/current_session 返回）
        self._synced_session_ids: set[str] = set()
        self._service_available = True
        self._context_status = "ready"
        self._llm_status = "unknown"
        self._llm_retry_guidance = "正在确认 LLM 配置状态。"
        self._session_popup_ids: list[str] = []
        self._recent_session_ids: list[str] = []
        self._rendered_session_signature: tuple[tuple[Any, ...], ...] = ()
        self._refresh_inflight = False
        self._refresh_pending = False
        self._refresh_request_generation = 0
        self._poll_fallback_inflight = False
        self._poll_fallback_generation = 0
        self._ask_generation = 0
        self._ask_inflight_generation: int | None = None

        # 创建应用
        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)  # 无 Dock 图标

        # 创建浮动图标
        self._create_floating_icon()

        # 创建分析面板（初始隐藏）
        self._create_analysis_panel()

        # 启动 WS 客户端线程
        self._start_ws_thread()

        # 定时器：脉冲动画
        self._pulse_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            0.03, self, "pulseTick:", None, True
        )
        NSRunLoop.currentRunLoop().addTimer_forMode_(self._pulse_timer, "NSDefaultRunLoopMode")

        # 定时器：轮询 WorkBuddy 当前激活对话（自动跟随）
        self._follow_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            2.5, self, "pollCurrentSession:", None, True
        )
        NSRunLoop.currentRunLoop().addTimer_forMode_(self._follow_timer, "NSDefaultRunLoopMode")

        # 启动时立即同步拉一次当前对话（不等 2.5s 定时器）
        try:
            local_data = self._read_local_current_session()
            if local_data:
                cdata = local_data
                self._wb_sessions = list(local_data.get("items", []) or [])
            else:
                # 服务端 current_session 只用于回退定位，不能冒充本地完整对话清单。
                self._wb_sessions = []
                cdata = CopilotNativeApp._get_scoped_server_current_session(self) or {}
            active = cdata.get("session_id")
            if active:
                self._current_session_id = active
                log.info("初始当前对话: %s", active[:8])
        except Exception as e:
            log.warning("启动拉取当前对话失败: %s", e)

        return self

    def _create_floating_icon(self):
        """创建原生 NSPanel 浮动图标。"""
        screen = NSScreen.mainScreen().visibleFrame()

        # 窗口尺寸 = WINDOW_SIZE（48pt），图标圆 = ICON_SIZE（40pt）居中
        x = screen.origin.x + (screen.size.width - WINDOW_SIZE) / 2
        y = screen.origin.y + screen.size.height - WINDOW_SIZE - 80  # 距顶部 80pt

        content_rect = NSMakeRect(x, y, WINDOW_SIZE, WINDOW_SIZE)

        # 关键配置 4 要素
        style = NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        self.icon_panel = FloatingIconPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            content_rect,
            style,
            NSBackingStoreBuffered,
            False
        )

        # collectionBehavior — 跨所有 Space（含全屏）
        cb = (
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorIgnoresCycle
        )
        self.icon_panel.setCollectionBehavior_(cb)

        # level — floating
        self.icon_panel.setLevel_(NSFloatingWindowLevel)

        # 关键：完全透明背景 + 无阴影（像豆包）
        self.icon_panel.setOpaque_(False)
        self.icon_panel.setBackgroundColor_(NSColor.clearColor())
        self.icon_panel.setHasShadow_(False)
        # 注意：setMovableByWindowBackground_ 必须设 False！
        # 否则系统自动拖动会与自定义 mouseDragged_ 冲突，产生"拉扯感"
        self.icon_panel.setMovableByWindowBackground_(False)
        self.icon_panel.setHidesOnDeactivate_(False)

        # 创建自定义 view（尺寸与窗口一致）
        self.icon_view = IconView.alloc().init_with_state(self)
        self.icon_view.setFrame_(NSMakeRect(0, 0, WINDOW_SIZE, WINDOW_SIZE))
        self.icon_panel.setContentView_(self.icon_view)

        # 显示
        self.icon_panel.orderFrontRegardless()
        log.info("浮动图标已创建: pos=%s, cb=%s, level=%s",
                 self.icon_panel.frame(), self.icon_panel.collectionBehavior(), self.icon_panel.level())

    def _create_analysis_panel(self):
        """创建分析卡片面板（初始隐藏）。顶部为对话切换栏，下方为分析卡片。"""
        screen = NSScreen.mainScreen().visibleFrame()
        icon_frame = self.icon_panel.frame()
        x, y = _panel_origin_for_icon(icon_frame, (PANEL_WIDTH, PANEL_MAX_HEIGHT), screen)

        content_rect = NSMakeRect(x, y, PANEL_WIDTH, PANEL_MAX_HEIGHT)
        # nonactivatingPanel：面板显示在最前但不抢 App 焦点/键盘
        # titled + closable 保留标题栏和关闭按钮，utility 让它浮在普通窗口上面
        style = (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                 | NSWindowStyleMaskUtilityWindow | NSWindowStyleMaskNonactivatingPanel)
        self.analysis_panel = AnalysisPanelWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            content_rect,
            style,
            NSBackingStoreBuffered,
            False
        )
        self.analysis_panel.setTitle_("Copilot 技术助教")
        self.analysis_panel.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        self.analysis_panel.setLevel_(NSFloatingWindowLevel)
        self.analysis_panel.setHidesOnDeactivate_(False)
        # 非激活面板：不抢 App 焦点，不需要时也不成为 key window
        self.analysis_panel.setBecomesKeyOnlyIfNeeded_(False)
        self.analysis_panel.setOpaque_(True)
        self.analysis_panel.setBackgroundColor_(_panel_background_color())

        content_view = self.analysis_panel.contentView()
        content_view.setWantsLayer_(True)
        content_view.layer().setBackgroundColor_(_panel_background_color().CGColor())

        from AppKit import NSView as _NSView

        # 布局常量（NSPanel contentView 坐标系：左下原点）
        margin = 12.0
        titlebar_reserve = 60.0      # titlebar + 顶部边距
        bar_h = 72.0                 # 完整下拉选择器 + 最近 3 个快捷项
        gap = 8.0
        ask_input_h = 30.0
        ask_answer_h = 92.0
        ask_gap = 6.0
        diagnostics_h = 20.0
        ask_area_h = ask_input_h + ask_gap + diagnostics_h + ask_gap + ask_answer_h
        scroll_y = margin + ask_area_h + gap
        scroll_h = PANEL_MAX_HEIGHT - titlebar_reserve - bar_h - gap - ask_area_h - gap
        inner_w = PANEL_WIDTH - margin * 2

        # 对话切换栏容器（顶部）
        bar_y = scroll_y + scroll_h + gap
        self.session_bar = _NSView.alloc().initWithFrame_(
            NSMakeRect(margin, bar_y, inner_w, bar_h)
        )
        self.session_bar.setWantsLayer_(True)
        self.session_bar.layer().setCornerRadius_(8)
        self.session_bar.layer().setBackgroundColor_(
            _panel_session_bar_color().CGColor()
        )
        content_view.addSubview_(self.session_bar)

        # 滚动视图 + 卡片容器（下方）
        self.scroll_view = NSScrollView.alloc().initWithFrame_(
            NSMakeRect(margin, scroll_y, inner_w, scroll_h)
        )
        self.scroll_view.setHasVerticalScroller_(True)
        self.scroll_view.setAutohidesScrollers_(True)
        self.scroll_view.setDrawsBackground_(True)
        self.scroll_view.setBackgroundColor_(_panel_background_color())
        self.scroll_view.contentView().setBackgroundColor_(_panel_background_color())

        self.card_container = _NSView.alloc().initWithFrame_(
            NSMakeRect(0, 0, inner_w, scroll_h)
        )
        self.card_container.setWantsLayer_(True)
        self.card_container.layer().setBackgroundColor_(_panel_background_color().CGColor())
        self.scroll_view.setDocumentView_(self.card_container)
        content_view.addSubview_(self.scroll_view)

        # Copilot 回答区（底部，可滚动）
        answer_y = margin + ask_input_h + ask_gap + diagnostics_h + ask_gap
        copy_w = 52.0
        self.ask_answer_scroll = NSScrollView.alloc().initWithFrame_(
            NSMakeRect(margin, answer_y, inner_w - copy_w - 6, ask_answer_h)
        )
        self.ask_answer_scroll.setHasVerticalScroller_(True)
        self.ask_answer_scroll.setAutohidesScrollers_(True)
        self.ask_answer_scroll.setDrawsBackground_(True)
        self.ask_answer_scroll.setBackgroundColor_(_panel_card_color())
        self.ask_answer_scroll.contentView().setBackgroundColor_(_panel_card_color())
        self.ask_answer_view = NSTextView.alloc().initWithFrame_(
            NSMakeRect(0, 0, inner_w - copy_w - 6, ask_answer_h)
        )
        self.ask_answer_view.setEditable_(False)
        self.ask_answer_view.setSelectable_(True)
        self.ask_answer_view.setDrawsBackground_(True)
        self.ask_answer_view.setBackgroundColor_(_panel_card_color())
        self.ask_answer_view.setFont_(NSFont.systemFontOfSize_(12))
        self.ask_answer_view.setTextColor_(_panel_text_color())
        self.ask_answer_view.setString_("有问题可以直接问 Copilot。")
        self.ask_answer_scroll.setDocumentView_(self.ask_answer_view)
        content_view.addSubview_(self.ask_answer_scroll)

        self.copy_answer_button = NSButton.alloc().initWithFrame_(
            NSMakeRect(margin + inner_w - copy_w, answer_y + ask_answer_h - 28, copy_w, 26)
        )
        self.copy_answer_button.setTitle_("复制")
        self.copy_answer_button.setTarget_(self)
        self.copy_answer_button.setAction_("copyAnswerClicked:")
        content_view.addSubview_(self.copy_answer_button)

        self.diagnostics_checkbox = NSButton.alloc().initWithFrame_(
            NSMakeRect(margin, margin + ask_input_h + ask_gap, 190, diagnostics_h)
        )
        self.diagnostics_checkbox.setButtonType_(NSSwitchButton)
        self.diagnostics_checkbox.setTitle_("附加诊断信息（自动脱敏）")
        self.diagnostics_checkbox.setState_(NSControlStateValueOn)
        self.diagnostics_checkbox.setFont_(NSFont.systemFontOfSize_(11))
        content_view.addSubview_(self.diagnostics_checkbox)

        # 提问输入框 + 发送按钮
        send_w = 68.0
        self.ask_input = AskTextField.alloc().init_with_owner(self)
        self.ask_input.setFrame_(NSMakeRect(margin, margin, inner_w - send_w - 8, ask_input_h))
        self.ask_input.setPlaceholderString_("向 Copilot 提问...")
        self.ask_input.setTarget_(self)
        self.ask_input.setAction_("sendAskClicked:")
        self.ask_input.setFont_(NSFont.systemFontOfSize_(12))
        self.ask_input.setDrawsBackground_(True)
        self.ask_input.setBackgroundColor_(NSColor.whiteColor())
        self.ask_input.setTextColor_(_panel_input_text_color())
        content_view.addSubview_(self.ask_input)

        self.ask_send_button = NSButton.alloc().initWithFrame_(
            NSMakeRect(margin + inner_w - send_w, margin, send_w, ask_input_h)
        )
        self.ask_send_button.setTitle_("发送")
        self.ask_send_button.setTarget_(self)
        self.ask_send_button.setAction_("sendAskClicked:")
        content_view.addSubview_(self.ask_send_button)

    def _position_analysis_panel_near_icon(self):
        """Move the analysis panel next to the current floating icon position."""
        screen = NSScreen.mainScreen().visibleFrame()
        icon_frame = self.icon_panel.frame()
        panel_size = self.analysis_panel.frame().size
        x, y = _panel_origin_for_icon(icon_frame, panel_size, screen)
        self.analysis_panel.setFrameOrigin_(NSMakePoint(x, y))
        log.debug("分析面板跟随浮标定位: icon=%s panel_origin=(%.1f, %.1f)", icon_frame, x, y)

    def toggle_panel(self):
        log.info("toggle_panel 调用, 当前 visible=%s", self._panel_visible)
        if self._panel_visible:
            self.analysis_panel.orderOut_(None)
            self._panel_visible = False
            log.info("面板已关闭")
        else:
            log.info("开始拉取数据...")
            self._mentor_unread = 0
            self._refresh_data()
            log.info("数据拉取完成, items=%d, 显示面板", len(self._items))
            # 用 orderFrontRegardless_ 确保即使 App 非激活也能显示
            self._position_analysis_panel_near_icon()
            self.analysis_panel.orderFrontRegardless()
            self.analysis_panel.setLevel_(NSFloatingWindowLevel)
            self._panel_visible = True
            log.info("面板已显示, visible=%s", self._panel_visible)

    def pollCurrentSession_(self, timer):
        """轮询 WorkBuddy 当前激活对话，自动跟随。

        读本机 WorkBuddy 会话库中 last_activity_at 最新的对话。
        - 面板不可见时：自动切换 current_session_id（无打扰）
        - 面板可见时：不切走对话（用户可能在看别的），只更新切换栏的"激活"标记
        """
        try:
            data = self._read_local_current_session()
        except Exception:
            return

        if data:
            # A local snapshot is authoritative and invalidates any outstanding
            # server fallback result without waiting for its network timeout.
            self._poll_fallback_generation = int(
                getattr(self, "_poll_fallback_generation", 0)
            ) + 1
            CopilotNativeApp._apply_current_session_poll(self, data, local_source=True)
            return

        self._wb_sessions = []
        self._sessions_list = []
        if not str(getattr(self, "_student_id", "") or ""):
            self._service_available = False
            self._context_status = "missing_student_id"
            self._llm_status = "unknown"
            return
        if bool(getattr(self, "_poll_fallback_inflight", False)):
            return

        generation = int(getattr(self, "_poll_fallback_generation", 0)) + 1
        self._poll_fallback_generation = generation
        self._poll_fallback_inflight = True
        threading.Thread(
            target=CopilotNativeApp._poll_server_current_session_worker,
            args=(self, generation),
            daemon=True,
        ).start()

    def _poll_server_current_session_worker(self, generation: int):
        """Fetch the server fallback without blocking the AppKit timer thread."""
        try:
            data = CopilotNativeApp._get_scoped_server_current_session(self)
            callback = CopilotNativeApp._apply_server_current_session.__get__(self, type(self))
            if data is None:
                AppHelper.callAfter(callback, generation, None, "MissingStudentId")
                return
            AppHelper.callAfter(callback, generation, data, "")
        except Exception as exc:
            _record_recent_error("current_session_fallback", exc)
            callback = CopilotNativeApp._apply_server_current_session.__get__(self, type(self))
            AppHelper.callAfter(callback, generation, None, type(exc).__name__)

    def _get_scoped_server_current_session(self) -> dict[str, Any] | None:
        """Fetch fallback state only when an explicit student identity is present."""
        student_id = str(getattr(self, "_student_id", "") or "").strip()
        if not student_id:
            return None
        return self._get_json(
            "/current_session",
            query={"student_id": student_id},
            timeout=3,
        )

    def _apply_server_current_session(
        self,
        generation: int,
        data: dict[str, Any] | None,
        error_type: str,
    ):
        """Apply a server fallback only while it is the latest poll request."""
        if generation != int(getattr(self, "_poll_fallback_generation", 0)):
            self._poll_fallback_inflight = False
            return
        self._poll_fallback_inflight = False
        if error_type:
            log.debug("读取服务端当前对话失败 type=%s", error_type)
            return
        if data:
            CopilotNativeApp._apply_current_session_poll(self, data, local_source=False)

    def _apply_current_session_poll(self, data: dict[str, Any], *, local_source: bool):
        """Apply one local or server current-session snapshot on the AppKit thread."""
        active_sid = data.get("session_id")
        if not active_sid:
            return

        # 用 /current_session 返回的完整列表更新切换栏数据（包含 WorkBuddy 所有对话）
        items = list(data.get("items", []) or []) if local_source else []
        if local_source:
            self._wb_sessions = items
            self._sessions_list = _sort_sessions_for_selector(items)
        # 同步 session 标题到内存
        for it in items:
            sid = it.get("session_id")
            title = it.get("session_title") or ""
            if sid:
                if sid not in self._sessions:
                    self._sessions[sid] = {"title": title, "unread": 0}
                elif title:
                    self._sessions[sid]["title"] = title

        selector_changed = (
            _session_selector_render_signature(
                list(getattr(self, "_sessions_list", []) or []),
                getattr(self, "_sessions", {}),
                getattr(self, "_current_session_id", None),
            )
            != tuple(getattr(self, "_rendered_session_signature", ()) or ())
        )

        changed = (active_sid != self._current_session_id)
        if changed:
            log.info("检测到当前对话切换: %s -> %s", (self._current_session_id or "?")[:8], active_sid[:8])
            if not self._panel_visible:
                # 面板不可见 → 静默跟随
                self._current_session_id = active_sid
                self._refresh_data()
            else:
                # 面板可见 → 不切走，只更新切换栏标记 + 图标
                if selector_changed:
                    self._rebuild_session_bar()
                    self._update_icon_state()
        elif self._panel_visible and selector_changed:
            # 最终排序或可见菜单状态变化时才重建大下拉框。
            self._rebuild_session_bar()
            self._update_icon_state()

    def _read_local_current_session(self) -> dict[str, Any] | None:
        """Read WorkBuddy's local session list and infer the current session."""
        try:
            sessions = wb_sync.read_sessions(limit=SESSION_SELECTOR_LIMIT)
        except Exception as exc:
            _record_recent_error("workbuddy_read", exc)
            log.debug("读取本地 WorkBuddy 当前会话失败 type=%s", type(exc).__name__)
            return None
        items: list[dict[str, Any]] = []
        for idx, session in enumerate(sessions):
            session_id = str(session.get("session_id") or session.get("id") or "")
            if not session_id:
                continue
            last_ts = float(session.get("last_activity_at") or 0.0)
            items.append({
                "session_id": session_id,
                "work_dir": str(session.get("work_dir") or session.get("cwd") or ""),
                "resumed_at": last_ts,
                "last_activity_at": last_ts,
                "session_title": str(session.get("title") or session.get("session_title") or ""),
                "group_type": str(session.get("group_type") or ""),
                "space_name": str(session.get("space_name") or ""),
                "is_active": False,
            })
        if not items:
            return None
        active_sid = max(items, key=_session_activity_ts)["session_id"]
        items = _sort_sessions_for_selector(items)
        for item in items:
            item["is_active"] = item["session_id"] == active_sid
        return {
            "session_id": active_sid,
            "work_dir": next(item["work_dir"] for item in items if item["session_id"] == active_sid),
            "resumed_at": next(item["resumed_at"] for item in items if item["session_id"] == active_sid),
            "items": items,
        }

    def _refresh_data(self):
        """调度后台刷新；AppKit 主线程不执行网络 I/O。"""
        generation = int(getattr(self, "_refresh_request_generation", 0)) + 1
        self._refresh_request_generation = generation
        if bool(getattr(self, "_refresh_inflight", False)):
            self._refresh_pending = True
            return False

        self._refresh_inflight = True
        self._refresh_pending = False
        student = str(getattr(self, "_student_id", "") or "")
        if not student:
            # Every server-side student collection requires an explicit
            # identity.  Never degrade into an unfiltered request.
            self._refresh_inflight = False
            self._service_available = False
            self._context_status = "missing_student_id"
            self._llm_status = "unknown"
            self._llm_retry_guidance = "缺少 student_id，已停止学员数据请求。"
            try:
                self._rebuild_cards()
            except Exception:
                log.exception("显示缺少学员标识状态失败")
            return False
        current_session_id = str(getattr(self, "_current_session_id", "") or "")
        local_sessions = list(getattr(self, "_wb_sessions", []) or [])
        llm_status = str(getattr(self, "_llm_status", "unknown") or "unknown")
        threading.Thread(
            target=CopilotNativeApp._refresh_data_worker,
            args=(self, generation, student, current_session_id, local_sessions, llm_status),
            daemon=True,
        ).start()
        return True

    def _refresh_data_worker(
        self,
        generation: int,
        student: str,
        current_session_id: str,
        local_sessions: list[dict[str, Any]],
        llm_status: str,
    ):
        if not student:
            callback = CopilotNativeApp._apply_refresh_failure.__get__(self, type(self))
            AppHelper.callAfter(callback, generation, "MissingStudentId", "")
            return
        try:
            local_snapshot = _sort_sessions_for_selector(local_sessions)
            capability_query = {"student_id": student}
            try:
                capability_data = self._get_json(
                    "/api/student/capabilities",
                    query=capability_query,
                    timeout=5,
                )
                if not isinstance(capability_data, dict):
                    capability_data = {}
            except Exception as exc:
                # An older otherwise-healthy service may not expose this
                # endpoint. Keep the UI usable, but never claim LLM readiness.
                log.debug("获取 LLM 能力状态失败 type=%s", type(exc).__name__)
                capability_data = {}

            query = {
                "limit": str(SESSION_SELECTOR_LIMIT),
                "student_id": student,
            }
            sdata = self._get_json("/sessions", query=query, timeout=5)
            server_sessions = list(sdata.get("items", []) or [])
            synced_session_ids = {
                str(session.get("session_id"))
                for session in server_sessions
                if session.get("session_id")
            }
            recent_query = {"limit": "20", "student_id": student}
            if current_session_id:
                recent_query["session_id"] = current_session_id
            data = self._get_json("/recent", query=recent_query, timeout=5)
            reported_llm_status = (
                capability_data.get("llm_status")
                or data.get("llm_status")
                or "unknown"
            )
            supported_llm_statuses = {
                "ready",
                "disabled",
                "missing_api_key",
                "misconfigured",
                "timeout",
                "upstream_error",
                "unknown",
            }
            llm_status = str(reported_llm_status)
            if llm_status not in supported_llm_statuses:
                llm_status = "unknown"
            llm_retry_guidance = str(
                capability_data.get("retry_guidance")
                or data.get("retry_guidance")
                or (
                    "当前服务版本未报告 LLM 配置状态，请确认服务配置后重试。"
                    if llm_status == "unknown"
                    else ""
                )
            ).strip()
            result = {
                "local_sessions": local_snapshot,
                "local_inventory_signature": _session_inventory_signature(local_snapshot),
                "synced_session_ids": synced_session_ids,
                "items": list(data.get("items", []) or []),
                "context_status": str(data.get("context_status") or (
                    "ready"
                    if not current_session_id or current_session_id in synced_session_ids
                    else "not_synced"
                )),
                "llm_status": llm_status,
                "llm_retry_guidance": llm_retry_guidance,
                "current_session_id": current_session_id,
            }
            callback = CopilotNativeApp._apply_refresh_result.__get__(self, type(self))
            AppHelper.callAfter(callback, generation, result)
        except Exception as exc:
            _record_recent_error("refresh_network", exc)
            callback = CopilotNativeApp._apply_refresh_failure.__get__(self, type(self))
            AppHelper.callAfter(callback, generation, type(exc).__name__, "")

    def _settle_refresh_generation(self, generation: int) -> bool:
        current = int(getattr(self, "_refresh_request_generation", 0))
        if generation == current:
            self._refresh_inflight = False
            self._refresh_pending = False
            return True

        self._refresh_inflight = False
        pending = bool(getattr(self, "_refresh_pending", False))
        self._refresh_pending = False
        if pending:
            CopilotNativeApp._refresh_data(self)
        return False

    def _apply_refresh_result(self, generation: int, result: dict[str, Any]):
        """Apply one worker snapshot on the AppKit thread if it is still current."""
        if not CopilotNativeApp._settle_refresh_generation(self, generation):
            return
        snapshot_session_id = str(result.get("current_session_id") or "")
        live_session_id = str(getattr(self, "_current_session_id", "") or "")
        if snapshot_session_id != live_session_id:
            log.info(
                "忽略过期对话刷新: snapshot=%s current=%s",
                (snapshot_session_id or "?")[:8],
                (live_session_id or "?")[:8],
            )
            return
        self._service_available = True
        self._synced_session_ids = set(result.get("synced_session_ids", set()) or set())
        worker_local_sessions = list(result.get("local_sessions", []) or [])
        worker_local_signature = tuple(result.get("local_inventory_signature", ()) or ())
        latest_local_sessions = _sort_sessions_for_selector(
            list(getattr(self, "_wb_sessions", []) or [])
        )
        latest_local_signature = _session_inventory_signature(latest_local_sessions)
        self._sessions_list = (
            latest_local_sessions
            if latest_local_signature != worker_local_signature
            else worker_local_sessions
        )
        self._items = list(result.get("items", []) or [])
        self._context_status = str(result.get("context_status") or "ready")
        self._llm_status = str(result.get("llm_status") or "unknown")
        self._llm_retry_guidance = str(result.get("llm_retry_guidance") or "")

        sessions_state = getattr(self, "_sessions", {})
        for session in self._sessions_list:
            sid = session.get("session_id")
            if sid and sid not in sessions_state:
                sessions_state[sid] = {
                    "title": session.get("session_title") or "",
                    "unread": 0,
                }
            elif sid:
                sessions_state[sid]["title"] = (
                    session.get("session_title") or sessions_state[sid].get("title", "")
                )
        self._sessions = sessions_state
        current_session_id = str(result.get("current_session_id") or "")
        if current_session_id and current_session_id in self._sessions:
            self._sessions[current_session_id]["unread"] = 0

        if _session_selector_render_signature(
            self._sessions_list,
            self._sessions,
            getattr(self, "_current_session_id", None),
        ) != tuple(getattr(self, "_rendered_session_signature", ()) or ()):
            try:
                self._rebuild_session_bar()
            except Exception:
                log.exception("重建会话切换栏失败")
        try:
            self._rebuild_cards()
        except Exception:
            log.exception("重建分析卡片失败")
        self._update_icon_state()
        log.info(
            "_refresh_data 完成: sessions=%d, items=%d, current=%s",
            len(self._sessions_list),
            len(self._items),
            (current_session_id or "?")[:8],
        )

    def _apply_refresh_failure(
        self,
        generation: int,
        error_message: str,
        traceback_text: str = "",
    ):
        if not CopilotNativeApp._settle_refresh_generation(self, generation):
            return
        self._service_available = False
        self._context_status = "service_unavailable"
        self._items = []
        log.error("拉取数据失败 type=%s", error_message)
        try:
            self._rebuild_cards()
        except Exception:
            log.exception("显示服务不可用状态失败")

    def _rebuild_session_bar(self):
        """重建完整下拉选择器和同源的最近 3 个快捷项。"""
        for sub in list(self.session_bar.subviews()):
            sub.removeFromSuperview()

        bar_w = self.session_bar.frame().size.width
        bar_h = self.session_bar.frame().size.height
        sessions = _sort_sessions_for_selector(list(self._sessions_list))
        self._sessions_list = sessions
        self._session_popup_ids = [str(item.get("session_id")) for item in sessions]
        self._recent_session_ids = self._session_popup_ids[:3]
        self._recent_session_buttons = []
        if not sessions:
            label = NSTextField.alloc().initWithFrame_(NSMakeRect(8, (bar_h - 16) / 2, bar_w - 16, 16))
            label.setStringValue_("暂无对话记录，在 WorkBuddy 中对话试试")
            label.setEditable_(False)
            label.setBezeled_(False)
            label.setDrawsBackground_(False)
            label.setFont_(NSFont.systemFontOfSize_(11))
            label.setTextColor_(_panel_secondary_text_color())
            self.session_bar.addSubview_(label)
            self._rendered_session_signature = _session_selector_render_signature(
                sessions,
                getattr(self, "_sessions", {}),
                getattr(self, "_current_session_id", None),
            )
            return

        self.session_popup = NSPopUpButton.alloc().initWithFrame_pullsDown_(
            NSMakeRect(6, bar_h - 34, bar_w - 12, 28), False
        )
        self.session_popup.setTarget_(self)
        self.session_popup.setAction_("sessionDropdownChanged:")
        for session in sessions:
            sid = str(session.get("session_id") or "")
            title = str(session.get("session_title") or session.get("title") or sid[:8] or "?")
            group_type = str(session.get("group_type") or "")
            if group_type == "task":
                group_label = "任务"
            elif group_type == "space":
                group_label = "空间"
            else:
                group_label = "其他"
            self.session_popup.addItemWithTitle_(f"{group_label} · {title}")
        self.session_bar.addSubview_(self.session_popup)

        gap = 6.0
        recent_sessions = sessions[:3]
        n = len(recent_sessions)
        btn_w = (bar_w - gap * (n - 1)) / n
        # 查 WorkBuddy 当前激活的对话（用于在切换栏标记）
        active_sid = None
        for s in sessions:
            if s.get("is_active"):
                active_sid = s.get("session_id")
                break
        for i, s in enumerate(recent_sessions):
            sid = s.get("session_id")
            title = s.get("session_title") or (sid[:8] if sid else "?")
            # 截断长标题
            if len(title) > 10:
                title = title[:9] + "…"
            is_current = (sid == self._current_session_id)
            is_active_wb = (sid == active_sid)  # WorkBuddy 侧当前激活
            unread = self._sessions.get(sid, {}).get("unread", 0)

            # 标签：激活标记 ● + 标题 + 未读数
            prefix = "● " if is_active_wb else "  "
            label_text = f"{prefix}{title}"
            if unread:
                label_text = f"{prefix}{title} ({unread})"

            btn = NSButton.alloc().initWithFrame_(
                NSMakeRect(i * (btn_w + gap), 4, btn_w, 26)
            )
            btn.setTitle_(label_text)
            btn.setTarget_(self)
            btn.setAction_("sessionButtonClicked:")
            btn.setTag_(i)
            btn.setFont_(NSFont.systemFontOfSize_(10))
            btn.setBordered_(False)  # 无边框，用背景色区分
            btn.setWantsLayer_(True)
            # 当前查看的对话 → 蓝底；WorkBuddy 激活的 → 浅蓝底；其他 → 透明
            if is_current:
                btn.layer().setBackgroundColor_(
                    NSColor.colorWithRed_green_blue_alpha_(0.23, 0.51, 0.96, 0.42).CGColor()
                )
                title_color = _panel_heading_text_color()
            elif is_active_wb:
                btn.layer().setBackgroundColor_(
                    NSColor.colorWithRed_green_blue_alpha_(0.23, 0.51, 0.96, 0.18).CGColor()
                )
                title_color = _panel_text_color()
            else:
                btn.layer().setBackgroundColor_(NSColor.clearColor().CGColor())
                title_color = _panel_secondary_text_color()
            _set_button_title(btn, label_text, title_color)
            self.session_bar.addSubview_(btn)
            self._recent_session_buttons.append(btn)
        self._sync_session_controls()
        self._rendered_session_signature = _session_selector_render_signature(
            sessions,
            getattr(self, "_sessions", {}),
            getattr(self, "_current_session_id", None),
        )

    def _sync_session_controls(self):
        current = self._current_session_id
        if hasattr(self, "session_popup") and current in getattr(self, "_session_popup_ids", []):
            self.session_popup.selectItemAtIndex_(self._session_popup_ids.index(current))
        active_sid = next(
            (
                str(session.get("session_id") or "")
                for session in getattr(self, "_sessions_list", [])
                if session.get("is_active")
            ),
            "",
        )
        recent_ids = list(getattr(self, "_recent_session_ids", []) or [])
        for index, button in enumerate(
            getattr(self, "_recent_session_buttons", []) or []
        ):
            if index >= len(recent_ids):
                break
            sid = recent_ids[index]
            is_current = sid == current
            is_active_wb = sid == active_sid
            button.setState_(NSControlStateValueOn if is_current else 0)
            if is_current:
                background = NSColor.colorWithRed_green_blue_alpha_(
                    0.23, 0.51, 0.96, 0.42
                )
                title_color = _panel_heading_text_color()
            elif is_active_wb:
                background = NSColor.colorWithRed_green_blue_alpha_(
                    0.23, 0.51, 0.96, 0.18
                )
                title_color = _panel_text_color()
            else:
                background = NSColor.clearColor()
                title_color = _panel_secondary_text_color()
            button.layer().setBackgroundColor_(background.CGColor())
            _set_button_title(button, str(button.title()), title_color)

    def _select_session(self, session_id: str | None):
        if not session_id:
            return
        selected = str(session_id)
        if selected != getattr(self, "_current_session_id", None):
            # 使已发出请求的展示令牌失效；网络请求仍收尾并恢复控件。
            self._ask_generation = int(getattr(self, "_ask_generation", 0)) + 1
        self._current_session_id = selected
        log.info("切换对话: %s", session_id)
        self._sync_session_controls()
        self._rendered_session_signature = _session_selector_render_signature(
            list(getattr(self, "_sessions_list", []) or []),
            getattr(self, "_sessions", {}),
            self._current_session_id,
        )
        self._refresh_data()

    def sessionDropdownChanged_(self, sender):
        idx = int(sender.indexOfSelectedItem())
        if 0 <= idx < len(self._session_popup_ids):
            self._select_session(self._session_popup_ids[idx])

    def sessionButtonClicked_(self, sender):
        """点击最近对话快捷项。"""
        idx = int(sender.tag())
        if 0 <= idx < len(self._recent_session_ids):
            self._select_session(self._recent_session_ids[idx])

    def _add_panel_card(self, x, y, w, h, marker_color, attributed_text):
        """Create a dark card surface with a severity marker and transparent text."""
        card = NSView.alloc().initWithFrame_(NSMakeRect(x, y, w, h))
        card.setWantsLayer_(True)
        card.layer().setCornerRadius_(6)
        card.layer().setMasksToBounds_(True)
        card.layer().setBackgroundColor_(_panel_card_color().CGColor())

        marker = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 4, h))
        marker.setWantsLayer_(True)
        marker.layer().setBackgroundColor_(marker_color.CGColor())
        card.addSubview_(marker)

        text_view = NSTextField.alloc().initWithFrame_(NSMakeRect(12, 8, w - 20, h - 16))
        text_view.setEditable_(False)
        text_view.setBezeled_(False)
        text_view.setDrawsBackground_(False)
        text_view.setSelectable_(True)
        text_view.setTextColor_(_panel_text_color())
        text_view.setAttributedStringValue_(attributed_text)
        try:
            text_view.cell().setWraps_(True)
            text_view.cell().setScrollable_(False)
            text_view.cell().setUsesSingleLineMode_(False)
        except Exception:
            pass
        card.addSubview_(text_view)
        self.card_container.addSubview_(card)

    def _rebuild_cards(self):
        """重建分析卡片（增强：诊断 + 建议 + 严重程度）。"""
        for sub in list(self.card_container.subviews()):
            sub.removeFromSuperview()
        self.sync_then_ask_button = None
        self.ask_without_context_button = None

        card_w = self.card_container.frame().size.width - 16  # 左右各 8 边距

        service_unavailable = not bool(getattr(self, "_service_available", True))
        analysis_items = [] if service_unavailable else list(self._items)
        # 导师消息已经渲染并 ACK，不隶属于本次分析刷新，服务失联时仍必须保留。
        items = sorted(
            analysis_items + list(self._mentor_items),
            key=lambda item: item.get("created_at") or item.get("timestamp") or 0,
        )

        empty_analysis_state: str | None = None
        if not analysis_items:
            empty_analysis_state = _analysis_empty_state(
                list(getattr(self, "_wb_sessions", []) or []),
                getattr(self, "_current_session_id", None),
                set(getattr(self, "_synced_session_ids", set()) or set()),
                bool(getattr(self, "_service_available", True)),
                str(getattr(self, "_llm_status", "unknown") or "unknown"),
            )
            if getattr(self, "_context_status", "") == "not_synced":
                empty_analysis_state = "not_synced"

        y_offset = 4.0
        if empty_analysis_state:
            state_titles = {
                "no_local_sessions": "暂无本地对话",
                "not_synced": "当前对话未同步",
                "synced_no_analysis": "当前对话待分析",
                "service_unavailable": "Copilot 服务不可用",
                "llm_unavailable": "LLM 暂不可用",
            }
            state_kind = "alert" if empty_analysis_state == "service_unavailable" else "heading"
            state_lines = [
                (state_titles.get(empty_analysis_state, "Copilot 状态"), state_kind),
                (_empty_state_message(empty_analysis_state), "body"),
            ]
            if empty_analysis_state == "llm_unavailable":
                llm_status = str(getattr(self, "_llm_status", "unknown") or "unknown")
                if llm_status == "unknown":
                    state_lines[1] = (
                        "Copilot 已连接，但当前服务未报告 LLM 配置状态。",
                        "body",
                    )
                retry_guidance = str(
                    getattr(self, "_llm_retry_guidance", "") or ""
                ).strip()
                if retry_guidance:
                    state_lines.append((retry_guidance, "secondary"))
            state_card_h = 88.0 if len(state_lines) > 2 else 72.0
            self._add_panel_card(
                8,
                y_offset,
                card_w,
                state_card_h,
                _panel_marker_color(
                    "error" if empty_analysis_state == "service_unavailable" else "info"
                ),
                _attributed_panel_lines(state_lines),
            )
            y_offset += state_card_h + 8
            if empty_analysis_state == "not_synced":
                self.sync_then_ask_button = NSButton.alloc().initWithFrame_(
                    NSMakeRect(8, y_offset, 164, 30)
                )
                self.sync_then_ask_button.setTitle_("同步最近内容并提问")
                self.sync_then_ask_button.setTarget_(self)
                self.sync_then_ask_button.setAction_("syncThenAskClicked:")
                self.card_container.addSubview_(self.sync_then_ask_button)

                self.ask_without_context_button = NSButton.alloc().initWithFrame_(
                    NSMakeRect(180, y_offset, 164, 30)
                )
                self.ask_without_context_button.setTitle_("不带对话上下文提问")
                self.ask_without_context_button.setTarget_(self)
                self.ask_without_context_button.setAction_("askWithoutContextClicked:")
                self.card_container.addSubview_(self.ask_without_context_button)
                y_offset += 38
            CopilotNativeApp._set_ask_controls_enabled(
                self,
                getattr(self, "_ask_inflight_generation", None) is None,
            )
        for item in reversed(items):  # 时间正序：旧→新，从下往上排
            if item.get("type") == "mentor_message":
                text = item.get("text", "")
                mentor_id = item.get("mentor_id", "mentor")
                ts = time.strftime("%H:%M:%S", time.localtime(item.get("timestamp") or item.get("created_at") or time.time()))
                lines = [
                    (f"导师提示 · {mentor_id}", "heading"),
                    (text, "body"),
                    (ts, "secondary"),
                ]
                card_h = max(86.0, 16.0 * len(lines) + 22.0)
                self._add_panel_card(
                    8,
                    y_offset,
                    card_w,
                    card_h,
                    _panel_marker_color(mentor=True),
                    _attributed_panel_lines(lines),
                )
                y_offset += card_h + 8
                continue

            raw = item.get("raw", "{}")
            try:
                r = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                r = {}

            topic = r.get("topic", "?")
            understanding = r.get("understanding", "?")
            severity = r.get("severity", "info")
            is_tech = r.get("is_technical", False)
            diagnosis = r.get("diagnosis", "") or ""
            suggestion = r.get("suggestion", "") or ""
            progress = r.get("progress", "") or ""
            guidance = r.get("guidance", "") or ""
            alert = r.get("alert", "") or ""
            ts = time.strftime("%H:%M:%S", time.localtime(item.get("created_at", 0)))
            event = item.get("event", "")

            # 严重程度标记
            sev_mark = {"info": "", "warn": "⚠️ ", "error": "🔴 "}.get(severity, "")
            tech_mark = "🔧 " if is_tech else ""

            # 组装多行文本
            lines = [
                (f"{sev_mark}{tech_mark}[{event}] {topic} · {understanding}", "heading"),
            ]
            if diagnosis:
                lines.append((f"诊断：{diagnosis}", "heading"))
            if suggestion:
                lines.append((f"建议：{suggestion}", "body"))
            if progress:
                lines.append((f"进展：{progress}", "secondary"))
            if alert:
                lines.append((f"⚠ 告警：{alert}", "alert"))
            elif guidance:
                lines.append((f"→ {guidance}", "body"))
            lines.append((ts, "secondary"))

            # 卡片高度按行数估算
            line_count = len(lines)
            card_h = max(96.0, 16.0 * line_count + 20.0)
            self._add_panel_card(
                8,
                y_offset,
                card_w,
                card_h,
                _panel_marker_color(severity, alert=bool(alert), tech=bool(is_tech)),
                _attributed_panel_lines(lines),
            )
            y_offset += card_h + 8

        self.card_container.setFrameSize_(
            NSMakeSize(self.card_container.frame().size.width, y_offset + 4)
        )

    def _update_icon_state(self):
        """根据所有对话的未读/告警状态更新浮标图标。"""
        has_alert = False
        total_unread = self._mentor_unread
        for sid, info in self._sessions.items():
            total_unread += info.get("unread", 0)
            lr = info.get("last_result") or {}
            if lr.get("alert") or lr.get("severity") == "error" or lr.get("understanding") in ("low", "stuck"):
                has_alert = True
        self._unread_count = total_unread
        if has_alert:
            self.icon_view.set_state_("alert", 0)
        elif total_unread > 0:
            self.icon_view.set_state_("active", total_unread)
        else:
            self.icon_view.set_state_("idle", 0)

    def pulseTick_(self, timer):
        """脉冲动画定时器。"""
        self._pulse_phase = (time.time() % 2.0) / 2.0
        self.icon_view.setNeedsDisplay_(True)

    def pause_pulse(self):
        """拖动时暂停脉冲动画，避免重绘干扰移动。"""
        if hasattr(self, "_pulse_timer") and self._pulse_timer is not None:
            self._pulse_timer.invalidate()
            self._pulse_timer = None

    def resume_pulse(self):
        """拖动结束后恢复脉冲动画。"""
        if self._pulse_timer is None:
            self._pulse_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                0.05, self, "pulseTick:", None, True
            )
            NSRunLoop.currentRunLoop().addTimer_forMode_(self._pulse_timer, "NSDefaultRunLoopMode")

    # ── WebSocket 客户端 ──

    def _start_ws_thread(self):
        if not str(getattr(self, "_student_id", "") or ""):
            log.warning("缺少 student_id，不启动学员 WebSocket 连接")
            return False

        def _run():
            asyncio.run(self._ws_loop())

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        return True

    async def _ws_loop(self):
        if not str(getattr(self, "_student_id", "") or ""):
            return
        self._ws_asyncio_loop = asyncio.get_running_loop()
        backoff = 1
        while True:
            ws_addr = self._float_ws_url()
            log.info("WS 连接中 %s", self._float_ws_url(redact_token=True))
            try:
                async with websockets.connect(ws_addr, ping_interval=20) as ws:
                    log.info("WS 已连接")
                    backoff = 1
                    self._fetch_mentor_catchup()
                    if self._fetch_pending_mentor_receipts():
                        self._start_pending_receipt_retry_task()
                    self._fetch_upload_requests()
                    async for raw in ws:
                        self._dispatch_ws_message(raw)
            except Exception as e:
                log.warning("WS 断开: %s (%ds 后重连)", e, backoff)
                await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    def _dispatch_ws_message(self, raw):
        AppHelper.callAfter(self._handle_ws_message, raw)

    def _dispatch_mentor_message(self, data):
        AppHelper.callAfter(self._handle_mentor_message, data)

    def _handle_ws_message(self, raw):
        try:
            data = json.loads(raw) if isinstance(raw, (str, bytes)) else {}
        except Exception:
            return
        if data.get("type") == "mentor_message":
            self._handle_mentor_message(data)
            return
        if data.get("type") == "mentor_command":
            self._handle_mentor_command(data)
            return
        if data.get("type") != "analysis":
            return

        result = data.get("result", {})
        session_id = data.get("session_id")
        session_title = data.get("session_title") or ""
        is_alert = bool(result.get("alert")) or result.get("understanding") in ("low", "stuck")
        is_tech = bool(result.get("is_technical"))
        severity = result.get("severity", "info")

        # 更新内存中的对话状态
        if session_id:
            if session_id not in self._sessions:
                self._sessions[session_id] = {"title": session_title, "unread": 0}
            self._sessions[session_id]["title"] = session_title or self._sessions[session_id].get("title", "")
            self._sessions[session_id]["last_result"] = result
            self._sessions[session_id]["last_ts"] = data.get("timestamp", time.time())

            # hook 只在用户当前对话里触发 → 这就是当前对话
            # 面板不可见时自动跟随；面板可见时若不是当前查看的对话则标记未读
            if not self._panel_visible:
                if session_id != self._current_session_id:
                    # Invalidate a refresh snapshot captured for the prior
                    # session even though the hidden panel does not refresh now.
                    self._refresh_request_generation = int(
                        getattr(self, "_refresh_request_generation", 0)
                    ) + 1
                self._current_session_id = session_id
            elif session_id != self._current_session_id:
                self._sessions[session_id]["unread"] = self._sessions[session_id].get("unread", 0) + 1

        # 面板可见且是当前对话 → 刷新；否则只更新图标
        if self._panel_visible and (session_id == self._current_session_id):
            self._refresh_data()
        else:
            self._update_icon_state()

        # 技术问题或告警 → 发系统通知
        if is_tech or is_alert or severity in ("warn", "error"):
            self._show_notification(result, session_title)

    def _handle_mentor_command(self, data):
        coordinator_callback = getattr(self, "_student_coordinator_callback", None)
        if callable(coordinator_callback):
            try:
                submit = getattr(coordinator_callback, "submit", None)
                if callable(submit):
                    if submit(data, self._handle_mentor_command_upload):
                        return
                elif coordinator_callback(data):
                    return
            except Exception as exc:
                log.debug("Student Coordinator 命令交接失败: %s", exc)
        if data.get("command") == "upload_conversations":
            self._handle_mentor_command_upload(data)

    def _handle_mentor_command_upload(self, data):
        student_id = data.get("student_id")
        if student_id and self._student_id and student_id != self._student_id:
            return
        if not self._student_id:
            log.warning("导师请求同步对话，但浮标缺少 student_id")
            return

        request_id = str(data.get("request_id") or "")
        session_id = str(data.get("session_id") or "")
        inflight = getattr(self, "_upload_requests_inflight", None)
        if request_id and inflight is not None:
            if request_id in inflight:
                return
            inflight.add(request_id)

        AppHelper.callAfter(self._show_upload_sync_notice, "导师请求同步对话中...")
        threading.Thread(
            target=lambda: self._upload_conversations_worker(
                request_id or None, session_id or None
            ),
            daemon=True,
        ).start()

    def _show_upload_sync_notice(self, message: str):
        try:
            self._set_ask_answer_text(message)
        except Exception as exc:
            log.debug("同步提示展示失败: %s", exc)

    def _post_upload_request_status(
        self,
        request_id: str,
        status: str,
        *,
        error_message: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        if not request_id or not self._student_id:
            return
        payload: dict[str, Any] = {
            "student_id": self._student_id,
            "status": status,
        }
        if error_message:
            payload["error_message"] = error_message
        if result is not None:
            payload["result"] = result
        self._post_json(
            f"/api/student/upload-requests/{urllib.parse.quote(request_id, safe='')}/status",
            payload,
            timeout=5,
        )

    def _upload_conversations_worker(
        self,
        request_id: str | None = None,
        session_id: str | None = None,
    ):
        try:
            if request_id:
                self._post_upload_request_status(request_id, "running")
            upload_kwargs = {"mode": "missing"}
            if request_id:
                upload_kwargs["request_id"] = request_id
            if session_id:
                upload_kwargs["session_id"] = session_id
            result = wb_upload.upload_conversations(
                self.cfg,
                self._student_id,
                **upload_kwargs,
            )
            if request_id:
                status = "failed" if result.get("failed", 0) else "done"
                error_message = "部分对话同步失败" if status == "failed" else None
                try:
                    self._post_upload_request_status(
                        request_id,
                        status,
                        error_message=error_message,
                        result=result,
                    )
                except Exception as exc:
                    log.debug("上传请求完成状态回写失败 request_id=%s: %s", request_id, exc)
            log.info(
                "导师请求同步对话完成 student=%s total=%d synced=%d skipped=%d failed=%d",
                self._student_id,
                result.get("total", 0),
                result.get("synced", 0),
                result.get("skipped", 0),
                result.get("failed", 0),
            )
        except Exception as exc:
            if request_id:
                try:
                    self._post_upload_request_status(
                        request_id,
                        "failed",
                        error_message=str(exc),
                    )
                except Exception as status_exc:
                    log.debug(
                        "上传请求失败状态回写失败 request_id=%s: %s",
                        request_id,
                        status_exc,
                    )
            log.warning("导师请求同步对话失败 student=%s: %s", self._student_id, exc)
        finally:
            if request_id and hasattr(self, "_upload_requests_inflight"):
                self._upload_requests_inflight.discard(request_id)

    def _mentor_message_state_guard(self):
        """Return the stdlib-only lock shared by UI and WebSocket threads."""
        lock = getattr(self, "_mentor_message_state_lock", None)
        if lock is None:
            lock = threading.RLock()
            self._mentor_message_state_lock = lock
        return lock

    def _has_pending_mentor_receipts(self) -> bool:
        with CopilotNativeApp._mentor_message_state_guard(self):
            return bool(
                self._pending_receipt_message_ids
                or getattr(self, "_unpersisted_rendered_message_ids", {})
            )

    def _wake_pending_receipt_retry(self):
        """Wake the one throttled retry task from the AppKit/UI thread."""
        loop = getattr(self, "_ws_asyncio_loop", None)
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(
                lambda: CopilotNativeApp._start_pending_receipt_retry_task(self)
            )

    def _handle_mentor_message(self, data):
        student_id = data.get("student_id")
        if student_id and self._student_id and student_id != self._student_id:
            return

        message_id = str(data.get("message_id") or "")
        if not message_id:
            return
        try:
            numeric_id = int(data.get("id") or 0)
        except (TypeError, ValueError):
            numeric_id = 0
        with CopilotNativeApp._mentor_message_state_guard(self):
            pending_receipts = self._pending_receipt_message_ids
            rendering_ids = getattr(self, "_rendering_mentor_message_ids", None)
            if not isinstance(rendering_ids, set):
                rendering_ids = set()
                self._rendering_mentor_message_ids = rendering_ids
            unpersisted = getattr(self, "_unpersisted_rendered_message_ids", None)
            if not isinstance(unpersisted, dict):
                unpersisted = {}
                self._unpersisted_rendered_message_ids = unpersisted
            is_seen = message_id in self._seen_mentor_message_ids
            retry_pending = message_id in pending_receipts
            is_rendering = message_id in rendering_ids
            retry_unpersisted = message_id in unpersisted
            last_seen_id = self._last_seen_mentor_message_id
        if retry_unpersisted:
            if not CopilotNativeApp._persist_unpersisted_rendered_message(self, message_id):
                CopilotNativeApp._wake_pending_receipt_retry(self)
            elif not self._ack_mentor_message(message_id):
                CopilotNativeApp._wake_pending_receipt_retry(self)
            return
        if is_seen or retry_pending:
            # A previous render may have completed while its REST receipt was
            # unavailable. Only IDs persisted as pending are retried: an
            # already confirmed duplicate needs neither rendering nor another
            # REST write, while a pending ID may have fallen out of the
            # bounded display de-duplication history after a restart.
            if retry_pending and not self._ack_mentor_message(message_id):
                CopilotNativeApp._wake_pending_receipt_retry(self)
            return
        # The bounded display de-duplication cache may have evicted an old
        # already-acked ID. A replay at or before the durable WS cursor is not
        # a new mentor message; only a persisted pending receipt may retry.
        if numeric_id > 0 and numeric_id <= last_seen_id:
            return
        if is_rendering:
            return
        with CopilotNativeApp._mentor_message_state_guard(self):
            # Recheck under the same lock before claiming the render window.
            if (
                message_id in self._seen_mentor_message_ids
                or message_id in pending_receipts
                or message_id in rendering_ids
            ):
                return
            rendering_ids.add(message_id)

        item = {
            "type": "mentor_message",
            "student_id": student_id or self._student_id,
            "message_id": message_id,
            "id": numeric_id,
            "text": data.get("text", ""),
            "mentor_id": data.get("mentor_id", "mentor"),
            "timestamp": data.get("timestamp", time.time()),
            "created_at": data.get("timestamp", time.time()),
        }
        if not self._render_mentor_message(item):
            with CopilotNativeApp._mentor_message_state_guard(self):
                rendering_ids.discard(message_id)
            return

        with CopilotNativeApp._mentor_message_state_guard(self):
            self._unpersisted_rendered_message_ids[message_id] = numeric_id
            rendering_ids.discard(message_id)
        if not CopilotNativeApp._persist_unpersisted_rendered_message(self, message_id):
            CopilotNativeApp._wake_pending_receipt_retry(self)
            return
        if not self._ack_mentor_message(message_id):
            CopilotNativeApp._wake_pending_receipt_retry(self)

    def _persist_unpersisted_rendered_message(self, message_id: str) -> bool:
        """Commit an already-rendered card before permitting its REST ack."""
        with CopilotNativeApp._mentor_message_state_guard(self):
            unpersisted = getattr(self, "_unpersisted_rendered_message_ids", {})
            numeric_id = unpersisted.get(message_id)
            if numeric_id is None:
                return True
            previous_seen = set(self._seen_mentor_message_ids)
            previous_order = list(getattr(self, "_seen_mentor_message_order", []))
            previous_last_seen_id = self._last_seen_mentor_message_id
            previous_pending = set(self._pending_receipt_message_ids)
            CopilotNativeApp._remember_seen_mentor_message_id(self, message_id)
            if numeric_id > self._last_seen_mentor_message_id:
                self._last_seen_mentor_message_id = numeric_id
            self._pending_receipt_message_ids.add(message_id)
            if self._save_mentor_message_state() is not False:
                unpersisted.pop(message_id, None)
                return True
            # Atomic publish failed twice: restore the state that governs WS
            # catch-up and retain a dedicated in-memory recovery record.
            self._seen_mentor_message_ids = previous_seen
            self._seen_mentor_message_order = previous_order
            self._last_seen_mentor_message_id = previous_last_seen_id
            self._pending_receipt_message_ids = previous_pending
            return False

    def _remember_seen_mentor_message_id(self, message_id: str):
        """Keep display de-duplication bounded without affecting receipts."""
        seen = self._seen_mentor_message_ids
        order = getattr(self, "_seen_mentor_message_order", None)
        if not isinstance(order, list):
            order = []

        # Old state files contained only a set. Preserve their IDs in a
        # deterministic bounded order when the app is first upgraded.
        order = [item for item in order if isinstance(item, str) and item in seen]
        known = set(order)
        order.extend(sorted(item for item in seen if item not in known))
        if message_id not in seen:
            seen.add(message_id)
            order.append(message_id)
        while len(order) > MAX_PERSISTED_SEEN_MENTOR_MESSAGE_IDS:
            seen.discard(order.pop(0))
        self._seen_mentor_message_order = order

    def _render_mentor_message(self, item: dict[str, Any]) -> bool:
        self._mentor_items.append(item)
        self._mentor_items = self._mentor_items[-20:]
        self._mentor_unread = 0
        try:
            self._rebuild_cards()
            self._position_analysis_panel_near_icon()
            self.analysis_panel.orderFrontRegardless()
            self.analysis_panel.setLevel_(NSFloatingWindowLevel)
            self._panel_visible = True
            self._update_icon_state()
            return True
        except Exception as exc:
            log.warning("导师消息渲染失败，暂不 ack: %s", exc)
            return False

    def _fetch_mentor_catchup(self):
        if not self._student_id:
            return
        try:
            data = self._get_json(
                "/api/student/messages",
                query={
                    "student_id": self._student_id,
                    "since": str(self._last_seen_mentor_message_id),
                },
                timeout=5,
            )
            for item in data.get("items", []):
                self._dispatch_mentor_message(item)
        except Exception as exc:
            log.debug("导师消息补拉失败: %s", exc)

    def _fetch_pending_mentor_receipts(self) -> bool:
        """Retry persisted receipts with a bounded, cursor-based server scan.

        The cursor lets a rendered ID after unrelated old pending messages
        still be found without acknowledging those unknown messages. Returning
        ``True`` asks the throttled WebSocket-loop task to continue later.
        """
        if not self._student_id or not CopilotNativeApp._has_pending_mentor_receipts(self):
            return False
        if CopilotNativeApp._retry_unpersisted_rendered_messages(self):
            return True
        with CopilotNativeApp._mentor_message_state_guard(self):
            if not self._pending_receipt_message_ids:
                return False
        with CopilotNativeApp._mentor_message_state_guard(self):
            after_id = max(0, int(getattr(self, "_pending_receipt_after_id", 0) or 0))
        observed_pending_ids: set[str] = set()
        for _ in range(MAX_PENDING_RECEIPT_PAGES_PER_SYNC):
            try:
                data = self._get_json(
                    "/api/student/messages/pending-receipts",
                    query={
                        "student_id": self._student_id,
                        "limit": str(PENDING_RECEIPT_PAGE_LIMIT),
                        "after_id": str(after_id),
                    },
                    timeout=5,
                )
            except Exception as exc:
                log.debug("导师消息 pending receipt 补拉失败: %s", exc)
                return CopilotNativeApp._has_pending_mentor_receipts(self)
            items = data.get("items", []) if isinstance(data, dict) else []
            if not isinstance(items, list) or not items:
                with CopilotNativeApp._mentor_message_state_guard(self):
                    self._pending_receipt_after_id = 0
                return CopilotNativeApp._retry_missing_pending_receipts(
                    self,
                    observed_pending_ids,
                )

            next_after_id = after_id
            for item in items:
                if not isinstance(item, dict):
                    continue
                try:
                    item_id = int(item.get("id") or 0)
                except (TypeError, ValueError):
                    item_id = 0
                if item_id > next_after_id:
                    next_after_id = item_id
                message_id = str(item.get("message_id") or "")
                with CopilotNativeApp._mentor_message_state_guard(self):
                    is_pending = message_id in self._pending_receipt_message_ids
                if message_id and is_pending:
                    observed_pending_ids.add(message_id)
                    self._ack_mentor_message(message_id)

            # Refuse to spin on malformed/non-advancing responses. A later
            # throttled retry starts a fresh scan rather than acknowledging an
            # unknown record merely to escape the page.
            if next_after_id <= after_id:
                with CopilotNativeApp._mentor_message_state_guard(self):
                    self._pending_receipt_after_id = 0
                return CopilotNativeApp._has_pending_mentor_receipts(self)
            after_id = next_after_id
            with CopilotNativeApp._mentor_message_state_guard(self):
                self._pending_receipt_after_id = after_id
            if len(items) < PENDING_RECEIPT_PAGE_LIMIT:
                with CopilotNativeApp._mentor_message_state_guard(self):
                    self._pending_receipt_after_id = 0
                return CopilotNativeApp._retry_missing_pending_receipts(
                    self,
                    observed_pending_ids,
                )
        # A single pass is deliberately capped. The reconnect-loop task
        # resumes from this cursor after a delay, so a stable connection does
        # not strand the 513th and later receipt or busy-loop the UI process.
        return CopilotNativeApp._has_pending_mentor_receipts(self)

    def _retry_missing_pending_receipts(self, observed_pending_ids: set[str]) -> bool:
        """Idempotently retry a bounded local snapshot absent from a full scan."""
        with CopilotNativeApp._mentor_message_state_guard(self):
            snapshot = sorted(
                self._pending_receipt_message_ids - observed_pending_ids
            )[:PENDING_RECEIPT_DIRECT_ACK_LIMIT]
        for message_id in snapshot:
            self._ack_mentor_message(message_id)
        return CopilotNativeApp._has_pending_mentor_receipts(self)

    def _retry_unpersisted_rendered_messages(self) -> bool:
        """Persist prior renders before retrying their acknowledgements."""
        with CopilotNativeApp._mentor_message_state_guard(self):
            message_ids = list(
                getattr(self, "_unpersisted_rendered_message_ids", {}).keys()
            )[:PENDING_RECEIPT_DIRECT_ACK_LIMIT]
        for message_id in message_ids:
            if not CopilotNativeApp._persist_unpersisted_rendered_message(self, message_id):
                return True
            if not self._ack_mentor_message(message_id):
                return True
        with CopilotNativeApp._mentor_message_state_guard(self):
            return bool(getattr(self, "_unpersisted_rendered_message_ids", {}))

    async def _retry_pending_receipts_until_settled(self):
        """Continue bounded scans on a stable connection with a fixed delay."""
        while CopilotNativeApp._has_pending_mentor_receipts(self):
            await asyncio.sleep(PENDING_RECEIPT_RETRY_DELAY_SECONDS)
            if not self._fetch_pending_mentor_receipts():
                return

    def _start_pending_receipt_retry_task(self):
        task = getattr(self, "_pending_receipt_retry_task", None)
        if task is not None and not task.done():
            return
        self._pending_receipt_retry_task = asyncio.create_task(
            self._retry_pending_receipts_until_settled()
        )

    def _fetch_upload_requests(self):
        if not self._student_id:
            return
        try:
            data = self._get_json(
                "/api/student/upload-requests",
                query={"student_id": self._student_id},
                timeout=5,
            )
            for item in data.get("items", []):
                command = {
                    "type": "mentor_command",
                    "student_id": item.get("student_id") or self._student_id,
                    "command": "upload_conversations",
                    "request_id": item.get("request_id") or "",
                    "session_id": item.get("session_id") or "",
                    "mentor_id": item.get("mentor_id") or "mentor",
                }
                AppHelper.callAfter(self._handle_mentor_command_upload, command)
        except Exception as exc:
            log.debug("导师上传请求补拉失败: %s", exc)

    def _ack_mentor_message(self, message_id: str) -> bool:
        with CopilotNativeApp._mentor_message_state_guard(self):
            inflight = getattr(self, "_receipt_ack_inflight_ids", None)
            if not isinstance(inflight, set):
                inflight = set()
                self._receipt_ack_inflight_ids = inflight
            if (
                not self._student_id
                or message_id not in self._pending_receipt_message_ids
                or message_id in inflight
            ):
                return False
            inflight.add(message_id)
        try:
            self._post_json("/api/student/messages/ack", {
                "student_id": self._student_id,
                "message_id": message_id,
            }, timeout=3)
        except Exception as exc:
            log.debug("导师消息 ack 失败: %s", exc)
            return False
        else:
            with CopilotNativeApp._mentor_message_state_guard(self):
                self._pending_receipt_message_ids.discard(message_id)
                if self._save_mentor_message_state() is False:
                    # The server receipt is already idempotently accepted, but
                    # retain local pending state so a restart can safely retry
                    # it rather than losing the durable recovery record.
                    self._pending_receipt_message_ids.add(message_id)
            return True
        finally:
            with CopilotNativeApp._mentor_message_state_guard(self):
                self._receipt_ack_inflight_ids.discard(message_id)

    def _enable_panel_keyboard_focus(self):
        if hasattr(self, "analysis_panel"):
            self.analysis_panel.setAllowsKeyboardFocus_(True)

    def _begin_ask_focus(self):
        self._enable_panel_keyboard_focus()
        if hasattr(self, "analysis_panel"):
            self.analysis_panel.makeKeyAndOrderFront_(None)
            if hasattr(self, "ask_input"):
                self.analysis_panel.makeFirstResponder_(self.ask_input)

    def _end_ask_focus(self):
        if hasattr(self, "analysis_panel"):
            try:
                self.analysis_panel.makeFirstResponder_(None)
            except Exception:
                pass
            # 回答需要继续可选择，不在返回后关闭面板键盘焦点。
            self.analysis_panel.setAllowsKeyboardFocus_(True)

    def _set_ask_answer_text(self, text: str):
        if hasattr(self, "ask_answer_view"):
            self.ask_answer_view.setBackgroundColor_(_panel_card_color())
            self.ask_answer_view.setTextColor_(_panel_text_color())
            self.ask_answer_view.setString_(text)

    def copyAnswerClicked_(self, sender):
        text = ""
        if hasattr(self, "ask_answer_view"):
            text = str(self.ask_answer_view.string() or "")
        if _copy_text_to_pasteboard(text):
            log.info("Copilot 回答已复制")

    def _diagnostics_enabled(self) -> bool:
        if not hasattr(self, "diagnostics_checkbox"):
            return True
        return bool(self.diagnostics_checkbox.state())

    def _question_from_input(self) -> str:
        if not hasattr(self, "ask_input"):
            return ""
        return str(self.ask_input.stringValue() or "").strip()

    def _set_ask_controls_enabled(self, enabled: bool):
        for name in (
            "ask_send_button",
            "sync_then_ask_button",
            "ask_without_context_button",
        ):
            control = getattr(self, name, None)
            if control is not None:
                control.setEnabled_(bool(enabled))

    def _start_student_ask(
        self,
        question: str,
        session_id: str | None,
        *,
        context_mode: str | None = None,
        sync_first: bool = False,
    ) -> bool:
        if not str(getattr(self, "_student_id", "") or ""):
            self._set_ask_answer_text("缺少 student_id，暂时不能发送问题。")
            return False
        if getattr(self, "_ask_inflight_generation", None) is not None:
            self._set_ask_answer_text("上一个问题正在处理，请等它完成后再提问。")
            return False

        generation = int(getattr(self, "_ask_generation", 0)) + 1
        self._ask_generation = generation
        self._ask_inflight_generation = generation
        request_session_id = str(getattr(self, "_current_session_id", "") or "") or None
        self._set_ask_controls_enabled(False)
        self._set_ask_answer_text("正在同步当前对话..." if sync_first else "思考中...")
        include_diagnostics = self._diagnostics_enabled()
        target = (
            self._sync_then_send_student_ask_worker
            if sync_first
            else self._send_student_ask_worker
        )
        args = (
            question,
            session_id,
            include_diagnostics,
            generation,
            request_session_id,
        ) if sync_first else (
            question,
            session_id,
            include_diagnostics,
            context_mode,
            generation,
            request_session_id,
        )
        thread = threading.Thread(
            target=target,
            args=args,
            daemon=True,
        )
        thread.start()
        return True

    def sendAskClicked_(self, sender):
        question = self._question_from_input()
        if not question:
            self._set_ask_answer_text("先输入你想问 Copilot 的问题。")
            self._begin_ask_focus()
            return
        if not self._student_id:
            self._set_ask_answer_text("缺少 student_id，暂时不能发送问题。")
            return

        session_id = self._current_session_id or None
        self._start_student_ask(question, session_id)

    def syncThenAskClicked_(self, sender):
        question = self._question_from_input()
        session_id = self._current_session_id or None
        if not question:
            self._set_ask_answer_text("先输入问题，再选择“同步最近内容并提问”。")
            self._begin_ask_focus()
            return
        if not self._student_id or not session_id:
            self._set_ask_answer_text("缺少学员或对话信息，暂时不能同步。")
            return
        self._start_student_ask(
            question,
            session_id,
            context_mode="sync_then_ask",
            sync_first=True,
        )

    def askWithoutContextClicked_(self, sender):
        question = self._question_from_input()
        if not question:
            self._set_ask_answer_text("先输入问题，再选择“不带对话上下文提问”。")
            self._begin_ask_focus()
            return
        if not self._student_id:
            self._set_ask_answer_text("缺少 student_id，暂时不能发送问题。")
            return
        self._start_student_ask(question, None, context_mode="without_session")

    def _student_ask_timeout(self) -> int:
        try:
            base = int(getattr(self, "cfg", {}).get("llm", {}).get("timeout", 30))
        except (TypeError, ValueError):
            base = 30
        return max(base + 5, 10)

    def _sync_then_send_student_ask_worker(
        self,
        question: str,
        session_id: str,
        include_diagnostics: bool,
        request_generation: int | None = None,
        request_session_id: str | None = None,
    ):
        if not str(getattr(self, "_student_id", "") or ""):
            callback_args: list[Any] = ["缺少 student_id，暂时不能同步或提问。"]
            if request_generation is not None:
                callback_args.extend([request_generation, request_session_id])
            AppHelper.callAfter(self._handle_ask_error, *callback_args)
            return
        try:
            result = wb_upload.upload_conversations(
                self.cfg,
                self._student_id,
                "missing",
                session_id=session_id,
            )
            if int(result.get("total") or 0) < 1 or int(result.get("failed") or 0) > 0:
                raise RuntimeError("当前对话同步失败")
        except Exception as exc:
            _record_recent_error("sync_then_ask", exc)
            log.warning(
                "同步后提问失败 session=%s type=%s",
                session_id,
                type(exc).__name__,
            )
            callback_args: list[Any] = [
                "当前对话同步失败，请稍后重试，或选择不带对话上下文提问。"
            ]
            if request_generation is not None:
                callback_args.extend([request_generation, request_session_id])
            AppHelper.callAfter(self._handle_ask_error, *callback_args)
            return
        worker_args: list[Any] = [
            question,
            session_id,
            include_diagnostics,
            "sync_then_ask",
        ]
        if request_generation is not None:
            worker_args.extend([request_generation, request_session_id])
        self._send_student_ask_worker(*worker_args)

    def _send_student_ask_worker(
        self,
        question: str,
        session_id: str | None,
        include_diagnostics: bool = True,
        context_mode: str | None = None,
        request_generation: int | None = None,
        request_session_id: str | None = None,
    ):
        if not str(getattr(self, "_student_id", "") or ""):
            callback_args: list[Any] = ["缺少 student_id，暂时不能发送问题。"]
            if request_generation is not None:
                callback_args.extend([request_generation, request_session_id])
            AppHelper.callAfter(self._handle_ask_error, *callback_args)
            return
        payload: dict[str, Any] = {
            "student_id": self._student_id,
            "question": question,
            "include_diagnostics": bool(include_diagnostics),
        }
        if session_id:
            payload["session_id"] = session_id
        if context_mode:
            payload["context_mode"] = context_mode
        if include_diagnostics:
            diagnostic_bundle = _collect_diagnostic_bundle()
            if diagnostic_bundle:
                payload["diagnostic_bundle"] = diagnostic_bundle
        try:
            data = self._post_json(
                "/api/student/ask",
                payload,
                timeout=CopilotNativeApp._student_ask_timeout(self),
            )
            answer, context_status, llm_status = _format_student_ask_response(data)
            ask_id = int(data.get("ask_id") or 0)
            callback_args: list[Any] = [
                question,
                answer,
                ask_id,
                context_status,
                llm_status,
            ]
            if request_generation is not None:
                callback_args.extend([request_generation, request_session_id])
            AppHelper.callAfter(self._handle_ask_answer, *callback_args)
        except Exception as exc:
            _record_recent_error("student_ask_http", exc)
            log.debug("学员提问发送失败 type=%s", type(exc).__name__)
            callback_args = ["暂时没能连接 Copilot，请稍后再试，或把问题补充完整后重发。"]
            if request_generation is not None:
                callback_args.extend([request_generation, request_session_id])
            AppHelper.callAfter(self._handle_ask_error, *callback_args)

    def _complete_ask_request(self, request_generation: int | None):
        if request_generation is None:
            self._set_ask_controls_enabled(True)
            return
        if getattr(self, "_ask_inflight_generation", None) == request_generation:
            self._ask_inflight_generation = None
            self._set_ask_controls_enabled(True)

    def _handle_ask_answer(
        self,
        question: str,
        answer: str,
        ask_id: int = 0,
        context_status: str = "ready",
        llm_status: str = "unknown",
        request_generation: int | None = None,
        request_session_id: str | None = None,
    ):
        CopilotNativeApp._complete_ask_request(self, request_generation)
        if request_generation is not None and (
            request_generation != int(getattr(self, "_ask_generation", 0))
            or request_session_id != (str(getattr(self, "_current_session_id", "") or "") or None)
        ):
            log.info("忽略已过期 Copilot 回答 generation=%s session=%s", request_generation, request_session_id)
            return
        if hasattr(self, "ask_input"):
            self.ask_input.setStringValue_("")
        self._service_available = True
        self._context_status = context_status
        self._llm_status = llm_status
        self._set_ask_answer_text(f"你问：{question}\n\nCopilot：{answer}")
        if not getattr(self, "_items", []):
            try:
                self._rebuild_cards()
            except Exception:
                log.exception("更新 Copilot 状态卡片失败")
        self._end_ask_focus()

    def _handle_ask_error(
        self,
        message: str,
        request_generation: int | None = None,
        request_session_id: str | None = None,
    ):
        CopilotNativeApp._complete_ask_request(self, request_generation)
        if request_generation is not None and (
            request_generation != int(getattr(self, "_ask_generation", 0))
            or request_session_id != (str(getattr(self, "_current_session_id", "") or "") or None)
        ):
            log.info("忽略已过期 Copilot 错误 generation=%s session=%s", request_generation, request_session_id)
            return
        self._set_ask_answer_text(message)
        self._end_ask_focus()

    def _service_base(self) -> str:
        return service_url(self.cfg)

    def _auth_headers(self) -> dict[str, str]:
        token = _configured_token(self.cfg)
        return {"X-Copilot-Token": token} if token else {}

    def _get_json(
        self,
        path: str,
        *,
        query: dict[str, str] | None = None,
        timeout: int = 5,
    ) -> dict:
        url = self._service_base() + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers=self._auth_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _post_json(self, path: str, payload: dict[str, Any], *, timeout: int = 5) -> dict:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            **self._auth_headers(),
        }
        req = urllib.request.Request(
            self._service_base() + path,
            data=body,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _float_ws_url(self, *, redact_token: bool = False) -> str:
        return _build_float_ws_url(
            self.cfg,
            self._student_id,
            self._last_seen_mentor_message_id,
            redact_token=redact_token,
        )

    def _mentor_message_state_path(self) -> str:
        return os.environ.get(
            "COPILOT_FLOAT_STATE",
            os.path.expanduser("~/.workbuddy/copilot_float_state.json"),
        )

    def _load_mentor_message_state(self):
        if not self._student_id:
            return
        with CopilotNativeApp._mentor_message_state_guard(self):
            try:
                with open(self._mentor_message_state_path(), "r", encoding="utf-8") as f:
                    data = json.load(f)
                state = data.get(self._student_id, {})
                self._last_seen_mentor_message_id = int(state.get("last_seen_message_id") or 0)
                seen_ids = state.get("seen_message_ids") or []
                if not isinstance(seen_ids, list):
                    seen_ids = []
                self._seen_mentor_message_order = list(dict.fromkeys(
                    str(message_id) for message_id in seen_ids if str(message_id)
                ))[-MAX_PERSISTED_SEEN_MENTOR_MESSAGE_IDS:]
                self._seen_mentor_message_ids = set(self._seen_mentor_message_order)
                pending_ids = state.get("pending_receipt_message_ids") or []
                if not isinstance(pending_ids, list):
                    pending_ids = []
                # Pending receipt IDs are the durable render record. Unlike the
                # display de-duplication cache, they must never be truncated.
                self._pending_receipt_message_ids = {
                    str(message_id) for message_id in pending_ids if str(message_id)
                }
            except FileNotFoundError:
                return
            except Exception as exc:
                log.debug("导师消息状态读取失败: %s", exc)

    def _save_mentor_message_state(self) -> bool:
        if not self._student_id:
            return False
        path = self._mentor_message_state_path()
        # A transient replace race/error must not turn a successful render
        # into an untracked network receipt. Retry one fresh atomic publish;
        # permanent storage failures return False to the caller.
        for attempt in range(2):
            temporary_path: str | None = None
            with CopilotNativeApp._mentor_message_state_guard(self):
                try:
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                    except FileNotFoundError:
                        data = {}
                    seen_order = getattr(self, "_seen_mentor_message_order", None)
                    if not isinstance(seen_order, list):
                        seen_order = sorted(self._seen_mentor_message_ids)
                    seen_order = list(dict.fromkeys(
                        str(message_id) for message_id in seen_order if str(message_id)
                    ))[-MAX_PERSISTED_SEEN_MENTOR_MESSAGE_IDS:]
                    self._seen_mentor_message_order = seen_order
                    persisted_last_seen_id = self._last_seen_mentor_message_id
                    unresolved_ids = [
                        int(message_id)
                        for message_id in getattr(
                            self,
                            "_unpersisted_rendered_message_ids",
                            {},
                        ).values()
                        if isinstance(message_id, int) and message_id > 0
                    ]
                    if unresolved_ids:
                        persisted_last_seen_id = min(
                            persisted_last_seen_id,
                            max(0, min(unresolved_ids) - 1),
                        )
                    data[self._student_id] = {
                        "last_seen_message_id": persisted_last_seen_id,
                        "seen_message_ids": seen_order,
                        "pending_receipt_message_ids": sorted(
                            str(message_id)
                            for message_id in self._pending_receipt_message_ids
                            if str(message_id)
                        ),
                    }
                    directory = os.path.dirname(path) or "."
                    os.makedirs(directory, exist_ok=True)
                    fd, temporary_path = tempfile.mkstemp(
                        dir=directory,
                        prefix=".copilot-float-state-",
                        suffix=".tmp",
                    )
                    with os.fdopen(fd, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(temporary_path, path)
                    temporary_path = None
                    return True
                except Exception as exc:
                    log.debug(
                        "导师消息状态保存失败 attempt=%s type=%s",
                        attempt + 1,
                        type(exc).__name__,
                    )
                finally:
                    if temporary_path is not None:
                        try:
                            os.unlink(temporary_path)
                        except OSError:
                            pass
        return False

    def _show_notification(self, result, session_title=""):
        try:
            from subprocess import run as _run
            title = "Copilot 技术助教"
            subtitle = session_title or result.get("topic", "")
            # 优先用诊断 + 建议
            diagnosis = result.get("diagnosis", "")
            suggestion = result.get("suggestion", "")
            if diagnosis and suggestion:
                message = f"{diagnosis} ｜ 建议：{suggestion}"
            elif diagnosis:
                message = diagnosis
            elif suggestion:
                message = suggestion
            else:
                message = result.get("alert") or result.get("guidance", "")
            # 转义双引号
            message = message.replace('"', "'")
            subtitle = subtitle.replace('"', "'")
            script = f'display notification "{message}" with title "{title}" subtitle "{subtitle}" sound name "Glass"'
            _run(["osascript", "-e", script], timeout=5, capture_output=True)
        except Exception as e:
            log.debug("通知发送失败: %s", e)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    )
    log.info("=== Copilot 浮动图标启动（原生 NSPanel）===")

    app = CopilotNativeApp.alloc().init_app()
    if app is None:
        log.error("初始化失败")
        sys.exit(1)

    log.info("进入 macOS 事件循环...")
    NSApp.run()


if __name__ == "__main__":
    main()
