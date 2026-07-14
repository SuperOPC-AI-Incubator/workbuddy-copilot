"""Addressed WebSocket registry for float and mentor clients."""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

log = logging.getLogger("copilot.connections")

FORWARD_EVENT_TYPES = {"prompt", "ai_summary", "analysis", "student_ask"}


class WSRegistry:
    """In-memory WebSocket registry for the single-worker process.

    Floats are keyed by student_id and mentors are one broadcast pool. Sets are
    used deliberately so reconnect races can briefly hold multiple sockets.
    """

    def __init__(self, *, send_timeout: float = 2.0) -> None:
        self.floats: dict[str, set[Any]] = defaultdict(set)
        self.mentors: set[Any] = set()
        self.send_timeout = send_timeout

    def register_float(self, student_id: str, ws: Any) -> None:
        self.floats[student_id].add(ws)
        log.info("float WS connected student=%s count=%d", student_id, len(self.floats[student_id]))

    def unregister_float(self, student_id: str, ws: Any) -> None:
        pool = self.floats.get(student_id)
        if not pool:
            return
        pool.discard(ws)
        if not pool:
            self.floats.pop(student_id, None)
        log.info("float WS disconnected student=%s count=%d", student_id, len(pool))

    def is_float_connected(self, student_id: str) -> bool:
        """Return the current in-process connection state for one student."""
        return bool(self.floats.get(student_id))

    def register_mentor(self, ws: Any) -> None:
        self.mentors.add(ws)
        log.info("mentor WS connected count=%d", len(self.mentors))

    def unregister_mentor(self, ws: Any) -> None:
        self.mentors.discard(ws)
        log.info("mentor WS disconnected count=%d", len(self.mentors))

    async def handle_event(self, payload: dict[str, Any]) -> None:
        event_type = payload.get("type")
        if event_type in FORWARD_EVENT_TYPES:
            await self._route_forward(payload)
        elif event_type == "mentor_message":
            await self._route_mentor_message(payload)
        elif event_type == "mentor_command":
            await self._route_mentor_command(payload)
        elif event_type == "message_delivered":
            await self._fanout(self.mentors, payload)
        elif event_type == "upload_request_status":
            await self._fanout(self.mentors, payload)

    async def _route_forward(self, payload: dict[str, Any]) -> None:
        student_id = str(payload.get("student_id") or "")
        targets = set(self.floats.get(student_id, set()))
        await asyncio.gather(
            self._fanout(self.mentors, payload),
            self._fanout(targets, payload),
        )

    async def _route_mentor_message(self, payload: dict[str, Any]) -> None:
        student_id = str(payload.get("student_id") or "")
        targets = set(self.floats.get(student_id, set()))
        # Socket success is only a transmission attempt. The durable
        # delivered state and mentor receipt are emitted exclusively by
        # MessageService.ack after StudentAgent's REST acknowledgement.
        await self._fanout(targets, payload)

    async def _route_mentor_command(self, payload: dict[str, Any]) -> None:
        student_id = str(payload.get("student_id") or "")
        targets = set(self.floats.get(student_id, set()))
        await self._fanout(targets, payload)

    async def _fanout(self, sockets: set[Any], payload: dict[str, Any]) -> int:
        if not sockets:
            return 0
        text = json.dumps(self._wire_payload(payload), ensure_ascii=False)
        results = await asyncio.gather(
            *(self._send_one(ws, text) for ws in list(sockets)),
            return_exceptions=False,
        )
        return sum(1 for ok in results if ok)

    async def _send_one(self, ws: Any, text: str) -> bool:
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=self.send_timeout)
            return True
        except Exception as exc:
            log.warning("WS send failed; dropping socket: %s", exc)
            self._drop(ws)
            return False

    def _drop(self, ws: Any) -> None:
        self.mentors.discard(ws)
        empty_students: list[str] = []
        for student_id, pool in self.floats.items():
            pool.discard(ws)
            if not pool:
                empty_students.append(student_id)
        for student_id in empty_students:
            self.floats.pop(student_id, None)

    @staticmethod
    def _wire_payload(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in payload.items()
            if not key.startswith("_") and not callable(value)
        }
