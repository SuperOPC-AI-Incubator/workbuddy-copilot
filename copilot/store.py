"""SQLite 存储：对话上报记录 + 分析结果。

两表结构：reports（每次 hook 上报）+ analyses（LLM 分析结果）。
方便后续做历史回看 / 导师面板迭代。
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger("copilot.store")

LEGACY_PROMPT_BACKFILL_WINDOW_SECONDS = 30.0


SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    session_id TEXT,
    event TEXT,
    prompt TEXT,
    transcript_path TEXT,
    msg_count INTEGER,
    tool_calls INTEGER,
    analysis_pending INTEGER DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    session_id TEXT,
    session_title TEXT,
    topic TEXT,
    understanding TEXT,
    off_topic INTEGER,
    stuck_at TEXT,
    is_technical INTEGER DEFAULT 0,
    severity TEXT DEFAULT 'info',
    diagnosis TEXT,
    suggestion TEXT,
    progress TEXT,
    guidance TEXT,
    alert TEXT,
    raw TEXT,
    created_at REAL NOT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id)
);

CREATE INDEX IF NOT EXISTS idx_reports_student ON reports(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_student ON analyses(student_id, created_at);

CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER,
    session_id TEXT,
    seq_in_session INTEGER,
    student_id TEXT,
    content TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER,
    session_id TEXT,
    student_id TEXT,
    content TEXT,
    created_at REAL NOT NULL,
    FOREIGN KEY (prompt_id) REFERENCES prompts(id)
);

CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    display_name TEXT,
    token_hash TEXT,
    created_at REAL
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    student_id TEXT,
    work_dir TEXT,
    title TEXT,
    group_type TEXT,
    space_name TEXT,
    created_at REAL,
    last_activity_at REAL
);

CREATE TABLE IF NOT EXISTS mentor_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT,
    mentor_id TEXT,
    session_id TEXT,
    text TEXT,
    message_id TEXT UNIQUE,
    created_at REAL,
    delivered_at REAL,
    read_at REAL,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS raw_transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    student_id TEXT,
    content TEXT,
    content_sha256 TEXT,
    analysis_status TEXT DEFAULT '',
    analysis_error TEXT DEFAULT '',
    created_at REAL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    summary TEXT,
    source TEXT DEFAULT 'bulk',
    content_sha256 TEXT,
    created_at REAL NOT NULL,
    UNIQUE(session_id, seq, role)
);

CREATE TABLE IF NOT EXISTS upload_requests (
    request_id TEXT PRIMARY KEY,
    mentor_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    transfer_status TEXT NOT NULL DEFAULT 'pending',
    analysis_status TEXT NOT NULL DEFAULT 'not_requested',
    error_message TEXT DEFAULT '',
    transfer_error TEXT DEFAULT '',
    analysis_error TEXT DEFAULT '',
    result_json TEXT,
    updated_at REAL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_request_sessions (
    request_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sha TEXT NOT NULL,
    analysis_status TEXT NOT NULL DEFAULT 'pending',
    analysis_error TEXT DEFAULT '',
    updated_at REAL NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (request_id, session_id),
    FOREIGN KEY (request_id) REFERENCES upload_requests(request_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS student_asks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    session_id TEXT,
    question TEXT,
    answer TEXT,
    diagnostics_attached INTEGER NOT NULL DEFAULT 0,
    diagnostics_summary TEXT NOT NULL DEFAULT '{}',
    diagnostics_version TEXT NOT NULL DEFAULT '',
    guidance_versions TEXT NOT NULL DEFAULT '[]',
    context_status TEXT NOT NULL DEFAULT '',
    llm_status TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompt_configs (
    key TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_by TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
"""

# 旧库迁移：analyses 表新增列（CREATE TABLE IF NOT EXISTS 不会改已有表）
# 注意：session 索引必须在迁移补列之后创建，否则旧库 executescript 会因缺列报错
_MIGRATIONS = [
    ("reports", "analysis_pending", "INTEGER DEFAULT 0"),
    ("analyses", "session_id", "TEXT"),
    ("analyses", "session_title", "TEXT"),
    ("analyses", "is_technical", "INTEGER DEFAULT 0"),
    ("analyses", "severity", "TEXT DEFAULT 'info'"),
    ("analyses", "diagnosis", "TEXT"),
    ("analyses", "suggestion", "TEXT"),
    ("prompts", "report_id", "INTEGER"),
    ("sessions", "group_type", "TEXT"),
    ("sessions", "space_name", "TEXT"),
    ("raw_transcripts", "content_sha256", "TEXT"),
    ("raw_transcripts", "analysis_status", "TEXT DEFAULT ''"),
    ("raw_transcripts", "analysis_error", "TEXT DEFAULT ''"),
    ("messages", "summary", "TEXT"),
    ("upload_requests", "error_message", "TEXT DEFAULT ''"),
    ("upload_requests", "result_json", "TEXT"),
    ("upload_requests", "updated_at", "REAL"),
    ("upload_requests", "transfer_status", "TEXT NOT NULL DEFAULT 'pending'"),
    ("upload_requests", "analysis_status", "TEXT NOT NULL DEFAULT 'not_requested'"),
    ("upload_requests", "transfer_error", "TEXT DEFAULT ''"),
    ("upload_requests", "analysis_error", "TEXT DEFAULT ''"),
    ("student_asks", "diagnostics_attached", "INTEGER NOT NULL DEFAULT 0"),
    ("student_asks", "diagnostics_summary", "TEXT NOT NULL DEFAULT '{}'"),
    ("student_asks", "diagnostics_version", "TEXT NOT NULL DEFAULT ''"),
    ("student_asks", "guidance_versions", "TEXT NOT NULL DEFAULT '[]'"),
    ("student_asks", "context_status", "TEXT NOT NULL DEFAULT ''"),
    ("student_asks", "llm_status", "TEXT NOT NULL DEFAULT ''"),
]

_POST_MIGRATION_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses(session_id, created_at)",
    # 回填旧数据的 session_id（从 reports 表关联）
    "UPDATE analyses SET session_id = (SELECT session_id FROM reports WHERE reports.id = analyses.report_id) WHERE analyses.session_id IS NULL",
    # 新表索引（prompts / ai_summaries 在迁移后建索引）
    "CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_prompts_student ON prompts(student_id, created_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_report_id_unique ON prompts(report_id) WHERE report_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_ai_summaries_session ON ai_summaries(session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_ai_summaries_prompt ON ai_summaries(prompt_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id)",
    "CREATE INDEX IF NOT EXISTS idx_mentor_messages_student_delivered ON mentor_messages(student_id, delivered_at)",
    "CREATE INDEX IF NOT EXISTS idx_raw_transcripts_session ON raw_transcripts(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_raw_transcripts_student_sha ON raw_transcripts(student_id, content_sha256)",
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq)",
    "CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id, session_id)",
    "CREATE INDEX IF NOT EXISTS idx_upload_requests_student_status ON upload_requests(student_id, status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_upload_request_sessions_status ON upload_request_sessions(request_id, analysis_status)",
    "CREATE INDEX IF NOT EXISTS idx_student_asks_student ON student_asks(student_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_student_asks_session ON student_asks(session_id, created_at)",
    """INSERT OR IGNORE INTO sessions
       (session_id, student_id, work_dir, title, created_at, last_activity_at)
       SELECT
         a.session_id,
         (SELECT a_student.student_id
          FROM analyses a_student
          WHERE a_student.session_id = a.session_id
          ORDER BY a_student.created_at DESC, a_student.id DESC
          LIMIT 1),
         '',
         COALESCE((
           SELECT a_title.session_title
           FROM analyses a_title
           WHERE a_title.session_id = a.session_id
           ORDER BY a_title.created_at DESC, a_title.id DESC
           LIMIT 1
         ), ''),
         MIN(a.created_at),
         MAX(a.created_at)
       FROM analyses a
       WHERE a.session_id IS NOT NULL AND a.session_id != ''
       GROUP BY a.session_id""",
]


class UploadRetryClaimConflict(RuntimeError):
    """Raised when an analysis retry cannot be claimed atomically."""


class Store:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._conn() as c:
            c.executescript(SCHEMA)
        # 旧库迁移：补齐新增列
        self._migrate()
        self._backfill_upload_request_axes()
        self._backfill_legacy_prompt_report_ids()
        # 迁移后创建依赖新列的索引
        with self._conn() as c:
            for sql in _POST_MIGRATION_SQL:
                c.execute(sql)

    def _migrate(self) -> None:
        with self._conn() as c:
            for table, col, coltype in _MIGRATIONS:
                cols = {row[1] for row in c.execute(f"PRAGMA table_info({table})").fetchall()}
                if col not in cols:
                    try:
                        c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
                    except sqlite3.OperationalError as exc:
                        if "duplicate column name" not in str(exc).lower():
                            raise
                        log.info("迁移: %s.%s 已存在，跳过", table, col)
                    else:
                        log.info("迁移: %s.%s 已添加", table, col)

    def _backfill_upload_request_axes(self) -> None:
        """Map legacy upload state into the independent transfer axis once."""
        with self._conn() as c:
            c.execute(
                """UPDATE upload_requests
                   SET transfer_status = CASE status
                       WHEN 'running' THEN 'running'
                       WHEN 'done' THEN 'stored'
                       WHEN 'failed' THEN 'failed'
                       ELSE 'pending'
                   END
                   WHERE transfer_status IS NULL
                      OR transfer_status = ''
                      OR (transfer_status = 'pending' AND status != 'pending')"""
            )
            c.execute(
                """UPDATE upload_requests
                   SET analysis_status = 'not_requested'
                   WHERE analysis_status IS NULL OR analysis_status = ''"""
            )
            c.execute(
                """UPDATE upload_requests
                   SET transfer_error = error_message
                   WHERE (transfer_error IS NULL OR transfer_error = '')
                     AND error_message IS NOT NULL
                     AND error_message != ''"""
            )
            c.execute(
                """UPDATE upload_requests
                   SET status = CASE transfer_status
                       WHEN 'running' THEN 'running'
                       WHEN 'stored' THEN 'done'
                       WHEN 'failed' THEN 'failed'
                       ELSE 'pending'
                   END"""
            )
            c.execute(
                """UPDATE upload_requests
                   SET transfer_error = '' WHERE transfer_error IS NULL"""
            )
            c.execute(
                """UPDATE upload_requests
                   SET analysis_error = '' WHERE analysis_error IS NULL"""
            )

    def _backfill_legacy_prompt_report_ids(self) -> None:
        """Conservatively pair legacy pending Stop prompts before adding uniqueness."""
        with self._conn() as c:
            reports = [
                dict(row)
                for row in c.execute(
                    """SELECT id, student_id, session_id, prompt, created_at
                       FROM reports
                       WHERE event = 'Stop'
                         AND analysis_pending = 1
                         AND NOT EXISTS (
                           SELECT 1 FROM prompts
                           WHERE prompts.report_id = reports.id
                         )
                       ORDER BY created_at ASC, id ASC"""
                ).fetchall()
            ]
            prompts = [
                dict(row)
                for row in c.execute(
                    """SELECT id, student_id, session_id, content, created_at
                       FROM prompts
                       WHERE report_id IS NULL
                       ORDER BY created_at ASC, id ASC"""
                ).fetchall()
            ]
            report_candidates: dict[int, set[int]] = {}
            prompt_candidates: dict[int, set[int]] = {}
            for report in reports:
                report_prompt = str(report.get("prompt") or "")
                for prompt in prompts:
                    if prompt.get("student_id") != report.get("student_id"):
                        continue
                    if prompt.get("session_id") != report.get("session_id"):
                        continue
                    if report_prompt:
                        if str(prompt.get("content") or "") != report_prompt:
                            continue
                    else:
                        delta = float(prompt["created_at"]) - float(report["created_at"])
                        if not 0 <= delta <= LEGACY_PROMPT_BACKFILL_WINDOW_SECONDS:
                            continue
                    report_id = int(report["id"])
                    prompt_id = int(prompt["id"])
                    report_candidates.setdefault(report_id, set()).add(prompt_id)
                    prompt_candidates.setdefault(prompt_id, set()).add(report_id)

            for report_id, matching_prompts in sorted(report_candidates.items()):
                if len(matching_prompts) != 1:
                    continue
                prompt_id = next(iter(matching_prompts))
                if prompt_candidates.get(prompt_id) != {report_id}:
                    continue
                updated = c.execute(
                    """UPDATE prompts SET report_id = ?
                       WHERE id = ? AND report_id IS NULL""",
                    (report_id, prompt_id),
                ).rowcount
                if updated != 1:
                    log.warning("迁移: prompt %s 未能关联 report %s", prompt_id, report_id)

    def add_report(
        self,
        student_id: str,
        session_id: str | None,
        event: str,
        prompt: str,
        transcript_path: str,
        msg_count: int,
        tool_calls: int,
    ) -> int:
        with self._conn() as c:
            return self._add_report_with_conn(
                c,
                student_id=student_id,
                session_id=session_id,
                event=event,
                prompt=prompt,
                transcript_path=transcript_path,
                msg_count=msg_count,
                tool_calls=tool_calls,
            )

    def _add_report_with_conn(
        self,
        c: sqlite3.Connection,
        *,
        student_id: str,
        session_id: str | None,
        event: str,
        transcript_path: str,
        msg_count: int,
        tool_calls: int,
        prompt: str = "",
    ) -> int:
        """Insert a report using an existing transaction."""
        now = time.time()
        c.execute(
            """INSERT INTO students (student_id, display_name, token_hash, created_at)
               VALUES (?, ?, NULL, ?)
               ON CONFLICT(student_id) DO NOTHING""",
            (student_id, "", now),
        )
        cur = c.execute(
            """INSERT INTO reports
               (student_id, session_id, event, prompt, transcript_path,
                msg_count, tool_calls, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                student_id,
                session_id,
                event,
                prompt,
                transcript_path,
                msg_count,
                tool_calls,
                now,
            ),
        )
        return int(cur.lastrowid)

    def upsert_student(self, student_id: str, display_name: str | None = None) -> None:
        """Create or update a student row.

        `display_name=None` preserves an existing display name while still creating
        the parent row required by mentor_messages' FK.
        """
        now = time.time()
        with self._conn() as c:
            c.execute(
                """INSERT INTO students (student_id, display_name, token_hash, created_at)
                   VALUES (?, ?, NULL, ?)
                   ON CONFLICT(student_id) DO UPDATE SET
                     display_name = CASE
                       WHEN excluded.display_name IS NULL THEN students.display_name
                       ELSE excluded.display_name
                     END""",
                (student_id, display_name, now),
            )

    def upsert_session(
        self,
        session_id: str,
        student_id: str,
        work_dir: str,
        title: str,
        created_at: float | None = None,
        last_activity_at: float | None = None,
        group_type: str | None = None,
        space_name: str | None = None,
    ) -> None:
        """Create or update a session row keyed by globally unique session_id."""
        now = time.time()
        created = now if created_at is None else created_at
        last_activity = now if last_activity_at is None else last_activity_at
        with self._conn() as c:
            self._ensure_session_owner_with_conn(c, session_id, student_id)
            c.execute(
                """INSERT INTO sessions
                   (session_id, student_id, work_dir, title, group_type, space_name,
                    created_at, last_activity_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     work_dir = CASE
                       WHEN sessions.work_dir IS NULL OR sessions.work_dir = ''
                       THEN excluded.work_dir
                       ELSE sessions.work_dir
                     END,
                     title = COALESCE(NULLIF(excluded.title, ''), sessions.title),
                     group_type = COALESCE(NULLIF(excluded.group_type, ''), sessions.group_type),
                     space_name = COALESCE(NULLIF(excluded.space_name, ''), sessions.space_name),
                     last_activity_at = excluded.last_activity_at""",
                (
                    session_id,
                    student_id,
                    work_dir,
                    title,
                    group_type,
                    space_name,
                    created,
                    last_activity,
                ),
            )

    def _ensure_session_owner_with_conn(
        self,
        c: sqlite3.Connection,
        session_id: str | None,
        student_id: str,
    ) -> None:
        if not session_id:
            return
        existing = c.execute(
            "SELECT student_id FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        existing_student = existing["student_id"] if existing else None
        if existing_student and existing_student != student_id:
            raise ValueError(
                f"session {session_id!r} belongs to {existing_student!r}, "
                f"not {student_id!r}"
            )

    def get_sessions_by_student_from_table(self, student_id: str, limit: int = 1000) -> list[dict]:
        """Read a student's sessions from the new copilot.db sessions table."""
        with self._conn() as c:
            rows = c.execute(
                """SELECT
                     s.session_id,
                     s.student_id,
                     s.title AS session_title,
                     s.work_dir,
                     s.group_type,
                     s.space_name,
                     s.created_at,
                     s.last_activity_at AS last_ts,
                     COUNT(a.id) AS analysis_count,
                     COALESCE(MAX(mc.c), 0) AS message_count,
                     COALESCE(SUM(CASE
                       WHEN a.alert != '' OR a.understanding IN ('low','stuck')
                       THEN 1 ELSE 0 END), 0) AS alert_count,
                     COALESCE((
                       SELECT a2.diagnosis
                       FROM analyses a2
                       WHERE a2.student_id = s.student_id
                         AND a2.session_id = s.session_id
                       ORDER BY a2.created_at DESC, a2.id DESC
                       LIMIT 1
                     ), '') AS last_diagnosis,
                     COALESCE((
                       SELECT a2.topic
                       FROM analyses a2
                       WHERE a2.student_id = s.student_id
                         AND a2.session_id = s.session_id
                       ORDER BY a2.created_at DESC, a2.id DESC
                       LIMIT 1
                     ), '') AS last_topic,
                     CASE MAX(CASE a.severity
                       WHEN 'error' THEN 3
                       WHEN 'warn' THEN 2
                       ELSE 1
                     END)
                       WHEN 3 THEN 'error'
                       WHEN 2 THEN 'warn'
                       ELSE 'info'
                     END AS last_severity,
                     COALESCE(MAX(a.is_technical), 0) AS last_is_technical
                   FROM sessions s
                   LEFT JOIN analyses a
                     ON a.student_id = s.student_id
                    AND a.session_id = s.session_id
                   LEFT JOIN (
                     SELECT session_id, COUNT(*) AS c
                     FROM messages
                     GROUP BY session_id
                   ) mc
                     ON mc.session_id = s.session_id
                   WHERE s.student_id = ?
                   GROUP BY s.session_id
                   ORDER BY s.last_activity_at DESC, s.created_at DESC
                   LIMIT ?""",
                (student_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def session_exists_for_student(self, student_id: str, session_id: str) -> bool:
        """Return whether the authoritative sessions row belongs to this student."""
        with self._conn() as c:
            row = c.execute(
                "SELECT 1 FROM sessions WHERE student_id = ? AND session_id = ? LIMIT 1",
                (student_id, session_id),
            ).fetchone()
            return row is not None

    def get_session_title(self, session_id: str) -> str:
        """Return a session title from copilot.db."""
        with self._conn() as c:
            row = c.execute(
                "SELECT title FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return (row["title"] or "") if row else ""

    def get_active_session_from_table(
        self,
        work_dir: str | None = None,
        student_id: str | None = None,
    ) -> dict | None:
        """Return the most recently active session from copilot.db."""
        clauses = []
        params: list[Any] = []
        if work_dir:
            clauses.append("work_dir = ?")
            params.append(work_dir)
        if student_id:
            clauses.append("student_id = ?")
            params.append(student_id)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._conn() as c:
            row = c.execute(
                f"""SELECT
                      session_id,
                      student_id,
                      work_dir,
                      title,
                      created_at,
                      last_activity_at AS resumed_at
                    FROM sessions
                    {where}
                    ORDER BY last_activity_at DESC, created_at DESC
                    LIMIT 1""",
                params,
            ).fetchone()
            return dict(row) if row else None

    def list_sessions_from_table(
        self,
        work_dir: str | None = None,
        student_id: str | None = None,
        limit: int = 8,
    ) -> list[dict]:
        """Return recent sessions from copilot.db."""
        clauses = []
        params: list[Any] = []
        if work_dir:
            clauses.append("work_dir = ?")
            params.append(work_dir)
        if student_id:
            clauses.append("student_id = ?")
            params.append(student_id)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(limit)
        with self._conn() as c:
            rows = c.execute(
                f"""SELECT
                      session_id,
                      student_id,
                      work_dir,
                      title,
                      created_at,
                      last_activity_at AS resumed_at
                    FROM sessions
                    {where}
                    ORDER BY last_activity_at DESC, created_at DESC
                    LIMIT ?""",
                params,
            ).fetchall()
            return [dict(r) for r in rows]

    def add_mentor_message(
        self,
        student_id: str,
        mentor_id: str,
        session_id: str,
        text: str,
        message_id: str,
    ) -> int:
        """Persist a mentor message as undelivered and return its row id."""
        with self._conn() as c:
            cur = c.execute(
                """INSERT INTO mentor_messages
                   (student_id, mentor_id, session_id, text, message_id,
                    created_at, delivered_at, read_at)
                   VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)""",
                (student_id, mentor_id, session_id, text, message_id, time.time()),
            )
            return cur.lastrowid

    def _message_cursor_id(
        self,
        c: sqlite3.Connection,
        student_id: str,
        message_id: int | str | None,
    ) -> int:
        if message_id is None:
            return 0
        if isinstance(message_id, int):
            row = c.execute(
                "SELECT id FROM mentor_messages WHERE id = ? AND student_id = ?",
                (message_id, student_id),
            ).fetchone()
            return int(row["id"]) if row else 0
        try:
            numeric_id = int(message_id)
        except ValueError:
            row = c.execute(
                "SELECT id FROM mentor_messages WHERE message_id = ? AND student_id = ?",
                (message_id, student_id),
            ).fetchone()
            return int(row["id"]) if row else 0
        row = c.execute(
            "SELECT id FROM mentor_messages WHERE id = ? AND student_id = ?",
            (numeric_id, student_id),
        ).fetchone()
        return int(row["id"]) if row else 0

    def list_undelivered_messages(
        self,
        student_id: str,
        after_message_id: int | str | None = None,
        *,
        limit: int | None = None,
    ) -> list[dict]:
        with self._conn() as c:
            cursor_id = self._message_cursor_id(c, student_id, after_message_id)
            query = """SELECT * FROM mentor_messages
                       WHERE student_id = ? AND delivered_at IS NULL AND id > ?
                       ORDER BY id ASC"""
            params: list[Any] = [student_id, cursor_id]
            if limit is not None:
                query += " LIMIT ?"
                params.append(max(0, int(limit)))
            rows = c.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def list_pending_message_receipts(
        self,
        student_id: str,
        *,
        limit: int,
        after_id: int = 0,
    ) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM mentor_messages
                   WHERE student_id = ? AND delivered_at IS NULL AND id > ?
                   ORDER BY id ASC LIMIT ?""",
                (student_id, max(0, int(after_id)), max(1, int(limit))),
            ).fetchall()
            return [dict(row) for row in rows]

    def list_messages_since(
        self,
        student_id: str,
        last_seen_message_id: int | str | None,
        *,
        limit: int | None = None,
    ) -> list[dict]:
        with self._conn() as c:
            cursor_id = self._message_cursor_id(c, student_id, last_seen_message_id)
            query = """SELECT * FROM mentor_messages
                       WHERE student_id = ? AND id > ?
                       ORDER BY id ASC"""
            params: list[Any] = [student_id, cursor_id]
            if limit is not None:
                query += " LIMIT ?"
                params.append(max(0, int(limit)))
            rows = c.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def mark_message_delivered(self, message_id: str, student_id: str | None = None) -> int:
        with self._conn() as c:
            if student_id is not None:
                cur = c.execute(
                    """UPDATE mentor_messages
                       SET delivered_at = COALESCE(delivered_at, ?)
                       WHERE message_id = ? AND student_id = ?""",
                    (time.time(), message_id, student_id),
                )
            else:
                cur = c.execute(
                    """UPDATE mentor_messages
                       SET delivered_at = COALESCE(delivered_at, ?)
                       WHERE message_id = ?""",
                    (time.time(), message_id),
                )
            return cur.rowcount

    def mark_message_read(self, message_id: str, student_id: str | None = None) -> int:
        with self._conn() as c:
            if student_id is not None:
                cur = c.execute(
                    """UPDATE mentor_messages
                       SET read_at = COALESCE(read_at, ?)
                       WHERE message_id = ? AND student_id = ?""",
                    (time.time(), message_id, student_id),
                )
            else:
                cur = c.execute(
                    """UPDATE mentor_messages
                       SET read_at = COALESCE(read_at, ?)
                       WHERE message_id = ?""",
                    (time.time(), message_id),
                )
            return cur.rowcount

    def add_raw_transcript(
        self,
        session_id: str,
        student_id: str,
        content: str,
        content_sha256: str | None = None,
    ) -> int:
        """Persist complete raw transcript content without truncation."""
        with self._conn() as c:
            self._ensure_session_owner_with_conn(c, session_id, student_id)
            cur = c.execute(
                """INSERT INTO raw_transcripts
                   (session_id, student_id, content, content_sha256,
                    analysis_status, analysis_error, created_at)
                   VALUES (?, ?, ?, ?, '', '', ?)""",
                (session_id, student_id, content, content_sha256, time.time()),
            )
            return cur.lastrowid

    def replace_session_messages(
        self,
        session_id: str,
        student_id: str,
        turns: list[dict[str, Any]],
        raw: str,
        sha: str,
    ) -> int:
        """Replace one session's bulk-uploaded message content atomically."""
        now = time.time()
        with self._conn() as c:
            self._ensure_session_owner_with_conn(c, session_id, student_id)
            c.execute(
                """INSERT INTO students (student_id, display_name, token_hash, created_at)
                   VALUES (?, '', NULL, ?)
                   ON CONFLICT(student_id) DO NOTHING""",
                (student_id, now),
            )
            c.execute(
                """INSERT INTO sessions
                   (session_id, student_id, work_dir, title, created_at, last_activity_at)
                   VALUES (?, ?, '', '', ?, ?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     last_activity_at = CASE
                       WHEN sessions.last_activity_at IS NULL
                         OR sessions.last_activity_at < excluded.last_activity_at
                       THEN excluded.last_activity_at
                       ELSE sessions.last_activity_at
                    END""",
                (session_id, student_id, now, now),
            )
            preserved_summaries: dict[tuple[int, str], str] = {}
            if sha:
                rows = c.execute(
                    """SELECT seq, text, summary
                       FROM messages
                       WHERE session_id = ?
                         AND source = 'bulk'
                         AND role = 'user'
                         AND content_sha256 = ?
                         AND COALESCE(summary, '') != ''""",
                    (session_id, sha),
                ).fetchall()
                preserved_summaries = {
                    (int(row["seq"]), str(row["text"] or "")): str(row["summary"] or "")
                    for row in rows
                }
            c.execute(
                "DELETE FROM messages WHERE session_id = ? AND source = 'bulk'",
                (session_id,),
            )

            inserted = 0
            for idx, turn in enumerate(turns):
                role = str(turn.get("role") or "")
                if role not in {"user", "assistant"}:
                    continue
                text = str(turn.get("text") or "")
                if not text:
                    continue
                seq = int(turn.get("seq") or 0)
                ts = turn.get("ts")
                created_at = ts if isinstance(ts, (int, float)) else now + (idx / 1000.0)
                summary = preserved_summaries.get((seq, text)) if role == "user" else None
                c.execute(
                    """INSERT INTO messages
                       (session_id, student_id, seq, role, text, summary, source,
                        content_sha256, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, 'bulk', ?, ?)""",
                    (session_id, student_id, seq, role, text, summary, sha, float(created_at)),
                )
                inserted += 1

            raw_row = c.execute(
                """SELECT id FROM raw_transcripts
                   WHERE session_id = ? AND student_id = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (session_id, student_id),
            ).fetchone()
            if raw_row:
                c.execute(
                    """UPDATE raw_transcripts
                       SET content = ?, content_sha256 = ?, created_at = ?,
                           analysis_status = '', analysis_error = ''
                       WHERE id = ?""",
                    (raw, sha, now, raw_row["id"]),
                )
            else:
                c.execute(
                    """INSERT INTO raw_transcripts
                       (session_id, student_id, content, content_sha256,
                        analysis_status, analysis_error, created_at)
                       VALUES (?, ?, ?, ?, '', '', ?)""",
                    (session_id, student_id, raw, sha, now),
                )
            return inserted

    def set_raw_transcript_analysis_status(
        self,
        session_id: str,
        student_id: str,
        *,
        status: str,
        error_message: str | None = None,
        content_sha256: str | None = None,
    ) -> int:
        """Update the latest raw transcript analysis status for a student session."""
        where = "session_id = ? AND student_id = ?"
        params: list[Any] = [session_id, student_id]
        if content_sha256:
            where += " AND content_sha256 = ?"
            params.append(content_sha256)
        with self._conn() as c:
            row = c.execute(
                f"""SELECT id FROM raw_transcripts
                    WHERE {where}
                    ORDER BY created_at DESC, id DESC
                    LIMIT 1""",
                params,
            ).fetchone()
            if not row:
                return 0
            cur = c.execute(
                """UPDATE raw_transcripts
                   SET analysis_status = ?, analysis_error = ?
                   WHERE id = ?""",
                (status, error_message or "", row["id"]),
            )
            return cur.rowcount

    def get_known_session_shas(self, student_id: str) -> dict[str, dict[str, str]]:
        """Return latest sha and analysis status per session for one student."""
        with self._conn() as c:
            rows = c.execute(
                """SELECT session_id, content_sha256, analysis_status
                   FROM raw_transcripts
                   WHERE student_id = ?
                     AND session_id IS NOT NULL
                     AND session_id != ''
                     AND content_sha256 IS NOT NULL
                     AND content_sha256 != ''
                   ORDER BY created_at DESC, id DESC""",
                (student_id,),
            ).fetchall()
        known: dict[str, dict[str, str]] = {}
        for row in rows:
            sid = str(row["session_id"])
            if sid not in known:
                known[sid] = {
                    "sha": str(row["content_sha256"]),
                    "analysis_status": str(row["analysis_status"] or ""),
                }
        return known

    def add_upload_request(
        self,
        mentor_id: str,
        student_id: str,
        session_id: str | None = None,
        status: str = "pending",
        request_id: str | None = None,
    ) -> str:
        """Persist a mentor-triggered upload request for audit/catch-up."""
        rid = request_id or uuid.uuid4().hex
        now = time.time()
        with self._conn() as c:
            c.execute(
                """INSERT INTO upload_requests
                   (request_id, mentor_id, student_id, session_id, status,
                    transfer_status, analysis_status, error_message,
                    transfer_error, analysis_error, result_json, updated_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'not_requested', '', '', '', NULL, ?, ?)""",
                (
                    rid,
                    mentor_id,
                    student_id,
                    session_id,
                    status,
                    {"done": "stored"}.get(status, status),
                    now,
                    now,
                ),
            )
        return rid

    def list_upload_requests(
        self,
        student_id: str | None = None,
        status: str | None = None,
    ) -> list[dict]:
        """List upload requests, optionally scoped by student and status."""
        clauses = []
        params: list[Any] = []
        if student_id:
            clauses.append("student_id = ?")
            params.append(student_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._conn() as c:
            rows = c.execute(
                f"""SELECT * FROM upload_requests
                    {where}
                    ORDER BY created_at ASC""",
                params,
            ).fetchall()
            return [dict(r) for r in rows]

    def list_pending_upload_requests(self, student_id: str | None = None) -> list[dict]:
        """List pending upload requests, optionally scoped to one student."""
        return self.list_upload_requests(student_id=student_id, status="pending")

    def get_upload_request(self, request_id: str) -> dict | None:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM upload_requests WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            return dict(row) if row else None

    def upsert_upload_request_session(
        self,
        request_id: str,
        student_id: str,
        session_id: str,
        sha: str,
        *,
        analysis_status: str = "pending",
        analysis_error: str = "",
    ) -> dict:
        now = time.time()
        with self._conn() as c:
            c.execute(
                """INSERT INTO upload_request_sessions
                   (request_id, student_id, session_id, sha, analysis_status,
                    analysis_error, updated_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(request_id, session_id) DO UPDATE SET
                     sha = excluded.sha,
                     analysis_status = excluded.analysis_status,
                     analysis_error = '',
                     updated_at = excluded.updated_at
                   WHERE upload_request_sessions.sha != excluded.sha""",
                (request_id, student_id, session_id, sha, analysis_status,
                 analysis_error, now, now),
            )
            row = c.execute(
                """SELECT * FROM upload_request_sessions
                   WHERE request_id = ? AND session_id = ?""",
                (request_id, session_id),
            ).fetchone()
            return dict(row)

    def list_upload_request_sessions(self, request_id: str) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM upload_request_sessions
                   WHERE request_id = ? ORDER BY created_at, session_id""",
                (request_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def compare_and_set_upload_request_session(
        self,
        request_id: str,
        student_id: str,
        session_id: str,
        *,
        expected: str,
        new_status: str,
        error: str = "",
        sha: str | None = None,
    ) -> int:
        sha_clause = " AND sha = ?" if sha is not None else ""
        params: list[Any] = [
            new_status, error, time.time(), request_id, student_id,
            session_id, expected,
        ]
        if sha is not None:
            params.append(sha)
        with self._conn() as c:
            cur = c.execute(
                f"""UPDATE upload_request_sessions
                   SET analysis_status = ?, analysis_error = ?, updated_at = ?
                   WHERE request_id = ? AND student_id = ? AND session_id = ?
                     AND analysis_status = ?{sha_clause}""",
                params,
            )
            return cur.rowcount

    def list_active_upload_request_sessions(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM upload_request_sessions
                   WHERE analysis_status IN ('pending', 'running')"""
            ).fetchall()
            return [dict(row) for row in rows]

    def list_active_upload_request_analyses(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM upload_requests
                   WHERE analysis_status IN ('pending', 'running')"""
            ).fetchall()
            return [dict(row) for row in rows]

    def claim_upload_analysis_retry(
        self,
        request_id: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Atomically validate and claim all retry targets for one request."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            parent_row = c.execute(
                "SELECT * FROM upload_requests WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            if parent_row is None:
                raise UploadRetryClaimConflict("upload request not found")
            parent = dict(parent_row)
            if (
                parent.get("transfer_status") != "stored"
                or parent.get("analysis_status") != "failed"
            ):
                raise UploadRetryClaimConflict(
                    "analysis retry requires transfer=stored and analysis=failed"
                )
            student_id = str(parent.get("student_id") or "")
            requested_session = str(parent.get("session_id") or "").strip()
            children = [
                dict(row) for row in c.execute(
                    """SELECT * FROM upload_request_sessions
                       WHERE request_id = ? ORDER BY created_at, session_id""",
                    (request_id,),
                ).fetchall()
            ]
            targets = [
                child for child in children
                if child.get("analysis_status") == "failed"
                and (
                    not requested_session
                    or child.get("session_id") == requested_session
                )
            ]

            legacy_target: dict[str, Any] | None = None
            if requested_session and not targets:
                existing = next(
                    (
                        child for child in children
                        if child.get("session_id") == requested_session
                    ),
                    None,
                )
                if existing is not None:
                    raise UploadRetryClaimConflict(
                        "analysis retry requires a failed child"
                    )
                raw_row = c.execute(
                    """SELECT * FROM raw_transcripts
                       WHERE student_id = ? AND session_id = ?
                       ORDER BY created_at DESC, id DESC LIMIT 1""",
                    (student_id, requested_session),
                ).fetchone()
                if raw_row is None or not str(raw_row["content_sha256"] or ""):
                    raise UploadRetryClaimConflict(
                        f"analysis retry raw missing for session: {requested_session}"
                    )
                legacy_target = {
                    "request_id": request_id,
                    "student_id": student_id,
                    "session_id": requested_session,
                    "sha": str(raw_row["content_sha256"]),
                    "analysis_status": "failed",
                    "analysis_error": str(parent.get("analysis_error") or "analysis failed"),
                    "created_at": now,
                    "updated_at": now,
                }
                targets = [legacy_target]
            if not targets:
                raise UploadRetryClaimConflict(
                    "analysis retry requires failed children"
                )

            work_items: list[dict[str, Any]] = []
            for child in targets:
                child_student = str(child.get("student_id") or "")
                child_session = str(child.get("session_id") or "")
                child_sha = str(child.get("sha") or "")
                if child_student != student_id or not child_session or not child_sha:
                    raise UploadRetryClaimConflict(
                        f"analysis retry child ownership invalid: {child_session}"
                    )
                raw_row = c.execute(
                    """SELECT * FROM raw_transcripts
                       WHERE student_id = ? AND session_id = ? AND content_sha256 = ?
                       ORDER BY created_at DESC, id DESC LIMIT 1""",
                    (student_id, child_session, child_sha),
                ).fetchone()
                if raw_row is None:
                    raise UploadRetryClaimConflict(
                        f"analysis retry raw missing for session: {child_session}"
                    )
                work_items.append({
                    "session_id": child_session,
                    "sha": child_sha,
                    "raw": dict(raw_row),
                })

            if legacy_target is not None:
                c.execute(
                    """INSERT INTO upload_request_sessions
                       (request_id, student_id, session_id, sha, analysis_status,
                        analysis_error, updated_at, created_at)
                       VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)""",
                    (
                        request_id,
                        student_id,
                        requested_session,
                        legacy_target["sha"],
                        legacy_target["analysis_error"],
                        now,
                        now,
                    ),
                )

            claimed = c.execute(
                """UPDATE upload_requests
                   SET analysis_status = 'pending', analysis_error = '', updated_at = ?
                   WHERE request_id = ? AND transfer_status = 'stored'
                     AND analysis_status = 'failed'""",
                (now, request_id),
            ).rowcount
            if claimed != 1:
                raise UploadRetryClaimConflict("analysis retry already claimed")

            for child in targets:
                updated = c.execute(
                    """UPDATE upload_request_sessions
                       SET analysis_status = 'pending', analysis_error = '', updated_at = ?
                       WHERE request_id = ? AND student_id = ? AND session_id = ?
                         AND sha = ? AND analysis_status = 'failed'""",
                    (
                        now,
                        request_id,
                        student_id,
                        str(child["session_id"]),
                        str(child["sha"]),
                    ),
                ).rowcount
                if updated != 1:
                    raise UploadRetryClaimConflict(
                        f"analysis retry child already claimed: {child['session_id']}"
                    )
            claimed_parent = c.execute(
                "SELECT * FROM upload_requests WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            return dict(claimed_parent), work_items

    def update_upload_request_status(
        self,
        request_id: str,
        *,
        student_id: str,
        status: str,
        error_message: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> int:
        """Update one upload request only if it belongs to the reporting student."""
        result_json = json.dumps(result, ensure_ascii=False) if result is not None else None
        transfer_status = {"done": "stored"}.get(status, status)
        with self._conn() as c:
            cur = c.execute(
                """UPDATE upload_requests
                   SET status = ?,
                       transfer_status = ?,
                       error_message = ?,
                       transfer_error = ?,
                       result_json = ?,
                       updated_at = ?
                   WHERE request_id = ? AND student_id = ?""",
                (
                    status,
                    transfer_status,
                    error_message or "",
                    error_message or "",
                    result_json,
                    time.time(),
                    request_id,
                    student_id,
                ),
            )
            return cur.rowcount

    def compare_and_set_upload_request_axis(
        self,
        request_id: str,
        *,
        student_id: str,
        axis: str,
        expected: str,
        new_status: str,
        error: str,
        result: dict[str, Any] | None = None,
    ) -> int:
        """Atomically update one allowlisted state axis from an expected value."""
        if axis not in {"transfer", "analysis"}:
            raise ValueError(f"unsupported upload request axis: {axis}")
        now = time.time()
        if axis == "transfer":
            legacy_status = {"stored": "done"}.get(new_status, new_status)
            sql = """UPDATE upload_requests
                     SET transfer_status = ?, transfer_error = ?,
                         status = ?, error_message = ?, result_json = ?, updated_at = ?
                     WHERE request_id = ? AND student_id = ?
                       AND transfer_status = ?"""
            params: tuple[Any, ...] = (
                new_status,
                error,
                legacy_status,
                error,
                json.dumps(result, ensure_ascii=False) if result is not None else None,
                now,
                request_id,
                student_id,
                expected,
            )
        else:
            sql = """UPDATE upload_requests
                     SET analysis_status = ?, analysis_error = ?, updated_at = ?
                     WHERE request_id = ? AND student_id = ?
                       AND analysis_status = ?"""
            params = (
                new_status,
                error,
                now,
                request_id,
                student_id,
                expected,
            )
        with self._conn() as c:
            cur = c.execute(sql, params)
            return cur.rowcount

    def get_raw_transcript(self, session_id: str) -> dict | None:
        with self._conn() as c:
            row = c.execute(
                """SELECT * FROM raw_transcripts
                   WHERE session_id = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (session_id,),
            ).fetchone()
            return dict(row) if row else None

    def get_raw_transcript_for_student_session(self, student_id: str, session_id: str) -> dict | None:
        """Return the latest raw transcript scoped to one student and session."""
        with self._conn() as c:
            row = c.execute(
                """SELECT * FROM raw_transcripts
                   WHERE student_id = ? AND session_id = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (student_id, session_id),
            ).fetchone()
            return dict(row) if row else None

    def get_raw_transcript_tail_for_student_session(
        self,
        student_id: str,
        session_id: str,
        *,
        max_chars: int,
    ) -> dict | None:
        """Return a bounded SQL-side tail without materializing full content."""
        limit = min(max(int(max_chars), 1), 1_000_000)
        with self._conn() as c:
            row = c.execute(
                """SELECT id, session_id, student_id, content_sha256, created_at,
                          CASE
                            WHEN length(COALESCE(content, '')) > ?
                            THEN substr(COALESCE(content, ''), ?)
                            ELSE COALESCE(content, '')
                          END AS content,
                          CASE
                            WHEN length(COALESCE(content, '')) > ? THEN 1
                            ELSE 0
                          END AS content_truncated
                   FROM raw_transcripts
                   WHERE student_id = ? AND session_id = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (limit, -limit, limit, student_id, session_id),
            ).fetchone()
            return dict(row) if row else None

    def get_raw_transcript_for_student_session_sha(
        self,
        student_id: str,
        session_id: str,
        content_sha256: str,
    ) -> dict | None:
        """Return the raw transcript matching one student's exact bulk SHA."""
        with self._conn() as c:
            row = c.execute(
                """SELECT * FROM raw_transcripts
                   WHERE student_id = ? AND session_id = ? AND content_sha256 = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (student_id, session_id, content_sha256),
            ).fetchone()
            return dict(row) if row else None

    def get_raw_transcript_for_report(
        self,
        session_id: str,
        report_created_at: float | None,
    ) -> dict | None:
        """Return the raw transcript captured for a report in a shared session."""
        if report_created_at is None:
            return self.get_raw_transcript(session_id)
        with self._conn() as c:
            row = c.execute(
                """SELECT * FROM raw_transcripts
                   WHERE session_id = ? AND created_at >= ?
                   ORDER BY created_at ASC, id ASC
                   LIMIT 1""",
                (session_id, report_created_at),
            ).fetchone()
            if row:
                return dict(row)
            return None
        return self.get_raw_transcript(session_id)

    def add_student_ask(
        self,
        student_id: str,
        session_id: str | None,
        question: str,
        answer: str,
        *,
        diagnostics_attached: bool = False,
        diagnostics_summary: dict[str, Any] | None = None,
        diagnostics_version: str = "",
        guidance_versions: list[str] | None = None,
        context_status: str = "",
        llm_status: str = "",
    ) -> int:
        """Persist a student-initiated Copilot question and answer."""
        self.upsert_student(student_id)
        with self._conn() as c:
            cur = c.execute(
                """INSERT INTO student_asks
                   (student_id, session_id, question, answer,
                    diagnostics_attached, diagnostics_summary,
                    diagnostics_version, guidance_versions,
                    context_status, llm_status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    student_id,
                    session_id,
                    question,
                    answer,
                    1 if diagnostics_attached else 0,
                    json.dumps(diagnostics_summary or {}, ensure_ascii=False),
                    diagnostics_version,
                    json.dumps(guidance_versions or [], ensure_ascii=False),
                    context_status,
                    llm_status,
                    time.time(),
                ),
            )
            return cur.lastrowid

    def set_prompt_config(
        self,
        key: str,
        prompt: str,
        updated_by: str | None = None,
    ) -> str:
        """Create or update one global prompt configuration."""
        now = time.time()
        normalized_key = str(key or "").strip()
        if not normalized_key:
            raise ValueError("prompt config key is required")
        with self._conn() as c:
            c.execute(
                """INSERT INTO prompt_configs
                   (key, prompt, updated_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                     prompt = excluded.prompt,
                     updated_by = excluded.updated_by,
                     updated_at = excluded.updated_at""",
                (normalized_key, prompt, updated_by or "", now, now),
            )
        return normalized_key

    def get_prompt_config(self, key: str) -> dict | None:
        normalized_key = str(key or "").strip()
        if not normalized_key:
            return None
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM prompt_configs WHERE key = ?",
                (normalized_key,),
            ).fetchone()
            return dict(row) if row else None

    def list_student_asks(
        self,
        student_id: str,
        session_id: str | None = None,
        *,
        limit: int | None = None,
    ) -> list[dict]:
        """List a student's Copilot questions, newest first."""
        with self._conn() as c:
            params: list[Any] = [student_id]
            where = "student_id = ?"
            if session_id is not None:
                where += " AND session_id = ?"
                params.append(session_id)
            limit_clause = ""
            if limit is not None:
                limit_clause = " LIMIT ?"
                params.append(max(0, int(limit)))
            rows = c.execute(
                f"""SELECT * FROM student_asks
                    WHERE {where}
                    ORDER BY created_at DESC, id DESC{limit_clause}""",
                params,
            ).fetchall()
            return [dict(r) for r in rows]

    def set_analysis_pending(self, report_id: int, pending: bool) -> int:
        with self._conn() as c:
            cur = c.execute(
                "UPDATE reports SET analysis_pending = ? WHERE id = ?",
                (1 if pending else 0, report_id),
            )
            return cur.rowcount

    def list_pending_reports(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM reports
                   WHERE analysis_pending = 1
                   ORDER BY id ASC"""
            ).fetchall()
            return [dict(r) for r in rows]

    def analysis_exists_for_report(self, report_id: int) -> bool:
        with self._conn() as c:
            row = c.execute(
                "SELECT 1 FROM analyses WHERE report_id = ? LIMIT 1",
                (report_id,),
            ).fetchone()
            return row is not None

    def add_analysis(
        self,
        report_id: int,
        student_id: str,
        result: dict[str, Any],
        session_id: str | None = None,
        session_title: str | None = None,
    ) -> int:
        with self._conn() as c:
            return self._add_analysis_with_conn(
                c,
                report_id=report_id,
                student_id=student_id,
                result=result,
                session_id=session_id,
                session_title=session_title,
            )

    def _add_analysis_with_conn(
        self,
        c: sqlite3.Connection,
        *,
        report_id: int,
        student_id: str,
        result: dict[str, Any],
        session_id: str | None,
        session_title: str | None,
    ) -> int:
        """Insert analysis details using an existing transaction."""
        cur = c.execute(
            """INSERT INTO analyses
               (report_id, student_id, session_id, session_title,
                topic, understanding, off_topic, stuck_at,
                is_technical, severity, diagnosis, suggestion,
                progress, guidance, alert, raw, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                report_id,
                student_id,
                session_id,
                session_title,
                result.get("topic", ""),
                result.get("understanding", "unknown"),
                1 if result.get("off_topic") else 0,
                result.get("stuck_at", ""),
                1 if result.get("is_technical") else 0,
                result.get("severity", "info"),
                result.get("diagnosis", ""),
                result.get("suggestion", ""),
                result.get("progress", ""),
                result.get("guidance", ""),
                result.get("alert", ""),
                json.dumps(result, ensure_ascii=False),
                time.time(),
            ),
        )
        return int(cur.lastrowid)

    def commit_bulk_analysis_if_current(
        self,
        *,
        student_id: str,
        session_id: str,
        content_sha256: str,
        result: dict[str, Any],
        session_title: str,
        msg_count: int,
    ) -> int | None:
        """Atomically persist analysis only if this is still the latest bulk SHA."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            raw_row = c.execute(
                """SELECT id, content_sha256
                   FROM raw_transcripts
                   WHERE student_id = ? AND session_id = ?
                     AND content_sha256 IS NOT NULL AND content_sha256 != ''
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (student_id, session_id),
            ).fetchone()
            if not raw_row or str(raw_row["content_sha256"]) != content_sha256:
                return None

            report_id = self._add_report_with_conn(
                c,
                student_id=student_id,
                session_id=session_id,
                event="BulkUpload",
                transcript_path="",
                msg_count=msg_count,
                tool_calls=0,
            )
            self._add_analysis_with_conn(
                c,
                report_id=report_id,
                student_id=student_id,
                result=result,
                session_id=session_id,
                session_title=session_title,
            )
            updated = c.execute(
                """UPDATE raw_transcripts
                   SET analysis_status = 'done', analysis_error = ''
                   WHERE id = ? AND content_sha256 = ?""",
                (raw_row["id"], content_sha256),
            ).rowcount
            if updated != 1:
                raise sqlite3.IntegrityError("bulk transcript changed during analysis commit")
            return report_id

    def recent_analyses(
        self,
        student_id: str | None,
        limit: int = 20,
        session_id: str | None = None,
    ) -> list[dict]:
        with self._conn() as c:
            clauses = []
            params: list = []
            if student_id:
                clauses.append("a.student_id = ?")
                params.append(student_id)
            if session_id:
                clauses.append("a.session_id = ?")
                params.append(session_id)
            where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
            params.append(limit)
            rows = c.execute(
                f"""SELECT a.*, r.event, r.prompt, r.created_at AS report_at
                    FROM analyses a JOIN reports r ON a.report_id = r.id
                    {where}
                    ORDER BY a.created_at DESC LIMIT ?""",
                params,
            ).fetchall()
            return [dict(r) for r in rows]

    def get_prompt_for_report(self, report_id: int) -> dict | None:
        """Return the durable Stop prompt associated with one report."""
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM prompts WHERE report_id = ? LIMIT 1",
                (report_id,),
            ).fetchone()
            return dict(row) if row else None

    def get_or_create_prompt_for_report(
        self,
        *,
        report_id: int,
        session_id: str,
        student_id: str,
        content: str,
    ) -> tuple[dict, bool]:
        """Persist one prompt per Stop report and allocate its sequence atomically."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            existing = c.execute(
                "SELECT * FROM prompts WHERE report_id = ? LIMIT 1",
                (report_id,),
            ).fetchone()
            if existing:
                return dict(existing), False

            seq_row = c.execute(
                """SELECT COALESCE(MAX(seq_in_session), -1) + 1 AS next_seq
                   FROM prompts WHERE session_id = ?""",
                (session_id,),
            ).fetchone()
            seq = int(seq_row["next_seq"])
            cur = c.execute(
                """INSERT INTO prompts
                   (report_id, session_id, seq_in_session, student_id, content, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (report_id, session_id, seq, student_id, content, time.time()),
            )
            row = c.execute(
                "SELECT * FROM prompts WHERE id = ?",
                (cur.lastrowid,),
            ).fetchone()
            return dict(row), True

    def add_prompt(
        self,
        session_id: str,
        seq_in_session: int,
        student_id: str,
        content: str,
    ) -> int:
        """存入学员提示词全文（不截断），返回 prompt_id。"""
        with self._conn() as c:
            cur = c.execute(
                """INSERT INTO prompts
                   (session_id, seq_in_session, student_id, content, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (session_id, seq_in_session, student_id, content, time.time()),
            )
            return cur.lastrowid

    def add_ai_summary(
        self,
        prompt_id: int | None,
        session_id: str,
        student_id: str,
        content: str,
    ) -> int:
        """Upsert a prompt-scoped AI summary, preserving the legacy method name."""
        return self.upsert_ai_summary(prompt_id, session_id, student_id, content)

    def upsert_ai_summary(
        self,
        prompt_id: int | None,
        session_id: str,
        student_id: str,
        content: str,
    ) -> int:
        """Store one AI reply summary per prompt.

        Old rows may already contain duplicate prompt_id values, so this uses a
        small transaction instead of adding a unique index that could break
        migration on existing databases.
        """
        now = time.time()
        with self._conn() as c:
            if prompt_id is not None:
                existing = c.execute(
                    """SELECT id FROM ai_summaries
                       WHERE prompt_id = ?
                       ORDER BY created_at ASC, id ASC
                       LIMIT 1""",
                    (prompt_id,),
                ).fetchone()
                if existing:
                    summary_id = int(existing["id"])
                    c.execute(
                        """UPDATE ai_summaries
                           SET session_id = ?, student_id = ?, content = ?, created_at = ?
                           WHERE id = ?""",
                        (session_id, student_id, content, now, summary_id),
                    )
                    c.execute(
                        "DELETE FROM ai_summaries WHERE prompt_id = ? AND id != ?",
                        (prompt_id, summary_id),
                    )
                    return summary_id
            cur = c.execute(
                """INSERT INTO ai_summaries
                   (prompt_id, session_id, student_id, content, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (prompt_id, session_id, student_id, content, now),
            )
            return cur.lastrowid

    def get_prompt(self, prompt_id: int) -> dict | None:
        """Return one prompt by primary key."""
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM prompts WHERE id = ?",
                (prompt_id,),
            ).fetchone()
            return dict(row) if row else None

    def get_prompts_by_session(self, session_id: str) -> list[dict]:
        """按 session 取提示词，按 seq_in_session 升序。"""
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM prompts
                   WHERE session_id = ?
                   ORDER BY seq_in_session ASC, created_at ASC""",
                (session_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_recent_sessions(self, limit: int = 2) -> list[dict]:
        """Return recently active sessions for maintenance jobs."""
        with self._conn() as c:
            rows = c.execute(
                """SELECT *
                   FROM sessions
                   ORDER BY COALESCE(last_activity_at, created_at, 0) DESC,
                            created_at DESC,
                            session_id ASC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def _get_prompt_reply_with_conn(
        self,
        c: sqlite3.Connection,
        session_id: str,
        prompt_seq: int,
    ) -> str:
        user_rows = c.execute(
            """SELECT id, seq, created_at
               FROM messages
               WHERE session_id = ? AND role = 'user'
               ORDER BY seq ASC, created_at ASC, id ASC""",
            (session_id,),
        ).fetchall()
        if not user_rows:
            return ""

        anchor_index = next(
            (idx for idx, row in enumerate(user_rows) if int(row["seq"]) == int(prompt_seq)),
            None,
        )
        if anchor_index is None:
            if prompt_seq < 0 or prompt_seq >= len(user_rows):
                return ""
            anchor_index = prompt_seq

        anchor = user_rows[anchor_index]
        next_user = user_rows[anchor_index + 1] if anchor_index + 1 < len(user_rows) else None

        where = [
            "session_id = ?",
            "role = 'assistant'",
            "(seq > ? OR (seq = ? AND created_at >= ?))",
        ]
        params: list[Any] = [
            session_id,
            int(anchor["seq"]),
            int(anchor["seq"]),
            float(anchor["created_at"] or 0),
        ]
        if next_user is not None:
            where.append("(seq < ? OR (seq = ? AND created_at < ?))")
            params.extend([
                int(next_user["seq"]),
                int(next_user["seq"]),
                float(next_user["created_at"] or 0),
            ])

        rows = c.execute(
            f"""SELECT text
                FROM messages
                WHERE {' AND '.join(where)}
                ORDER BY seq ASC, created_at ASC, id ASC""",
            params,
        ).fetchall()
        return "\n\n".join(str(row["text"]).strip() for row in rows if str(row["text"]).strip())

    def get_prompt_reply(self, session_id: str, prompt_seq: int) -> str:
        """Return all assistant text after one prompt and before the next user prompt."""
        with self._conn() as c:
            return self._get_prompt_reply_with_conn(c, session_id, int(prompt_seq))

    def get_prompt_reply_by_id(self, prompt_id: int) -> str:
        """Return concatenated assistant reply text for a prompt id."""
        prompt = self.get_prompt(prompt_id)
        if not prompt:
            return ""
        return self.get_prompt_reply(
            str(prompt.get("session_id") or ""),
            int(prompt.get("seq_in_session") or 0),
        )

    def _message_reply_rows_with_conn(
        self,
        c: sqlite3.Connection,
        message_id: int,
    ) -> list[sqlite3.Row]:
        anchor = c.execute(
            """SELECT id, session_id, seq, created_at
               FROM messages
               WHERE id = ? AND role = 'user'""",
            (int(message_id),),
        ).fetchone()
        if not anchor:
            return []

        next_user = c.execute(
            """SELECT id, seq, created_at
               FROM messages
               WHERE session_id = ?
                 AND role = 'user'
                 AND (seq > ? OR (seq = ? AND created_at > ?) OR (seq = ? AND created_at = ? AND id > ?))
               ORDER BY seq ASC, created_at ASC, id ASC
               LIMIT 1""",
            (
                anchor["session_id"],
                int(anchor["seq"]),
                int(anchor["seq"]),
                float(anchor["created_at"] or 0),
                int(anchor["seq"]),
                float(anchor["created_at"] or 0),
                int(anchor["id"]),
            ),
        ).fetchone()

        where = [
            "session_id = ?",
            "role = 'assistant'",
            "(seq > ? OR (seq = ? AND created_at >= ?))",
        ]
        params: list[Any] = [
            anchor["session_id"],
            int(anchor["seq"]),
            int(anchor["seq"]),
            float(anchor["created_at"] or 0),
        ]
        if next_user is not None:
            where.append("(seq < ? OR (seq = ? AND created_at < ?))")
            params.extend([
                int(next_user["seq"]),
                int(next_user["seq"]),
                float(next_user["created_at"] or 0),
            ])

        return c.execute(
            f"""SELECT id, text, created_at
                FROM messages
                WHERE {' AND '.join(where)}
                ORDER BY seq ASC, created_at ASC, id ASC""",
            params,
        ).fetchall()

    def get_message_reply_by_id(self, message_id: int) -> str:
        """Return concatenated assistant reply text for a user message id."""
        with self._conn() as c:
            rows = self._message_reply_rows_with_conn(c, int(message_id))
            return "\n\n".join(str(row["text"]).strip() for row in rows if str(row["text"]).strip())

    def get_message_rounds_by_session(self, session_id: str) -> list[dict]:
        """Return user message rounds and their assistant reply text for one session."""
        with self._conn() as c:
            rows = c.execute(
                """SELECT id, session_id, student_id, seq, text, summary,
                          content_sha256, created_at
                   FROM messages
                   WHERE session_id = ? AND role = 'user'
                   ORDER BY seq ASC, created_at ASC, id ASC""",
                (session_id,),
            ).fetchall()
            rounds: list[dict[str, Any]] = []
            for row in rows:
                reply_rows = self._message_reply_rows_with_conn(c, int(row["id"]))
                rounds.append({
                    "id": int(row["id"]),
                    "session_id": row["session_id"],
                    "student_id": row["student_id"],
                    "seq": int(row["seq"]),
                    "content": row["text"],
                    "summary": row["summary"] or "",
                    "content_sha256": row["content_sha256"],
                    "created_at": row["created_at"],
                    "reply": "\n\n".join(
                        str(reply_row["text"]).strip()
                        for reply_row in reply_rows
                        if str(reply_row["text"]).strip()
                    ),
                    "reply_created_at": (
                        float(reply_rows[0]["created_at"] or 0)
                        if reply_rows else None
                    ),
                })
            return rounds

    def set_message_summary(self, message_id: int, summary: str) -> int:
        """Store a generated summary on the user message row."""
        with self._conn() as c:
            cur = c.execute(
                """UPDATE messages
                   SET summary = ?
                   WHERE id = ? AND role = 'user'""",
                (summary, int(message_id)),
            )
            return cur.rowcount

    def get_ai_summaries_by_session(self, session_id: str) -> list[dict]:
        """按 session 取 AI 摘要，按 created_at 升序。"""
        with self._conn() as c:
            rows = c.execute(
                """SELECT * FROM ai_summaries
                   WHERE session_id = ?
                   ORDER BY created_at ASC""",
                (session_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def _analysis_timeline_rows(self, c: sqlite3.Connection, session_id: str) -> list[dict]:
        rows = c.execute(
            """SELECT a.id, a.session_id, a.student_id,
                      COALESCE(a.diagnosis, '') AS content, a.created_at,
                      'analysis' AS type,
                      NULL AS seq_in_session,
                      NULL AS prompt_id,
                      NULL AS reply_ref,
                      a.report_id,
                      a.severity,
                      a.understanding,
                      a.suggestion,
                      a.is_technical,
                      a.topic,
                      NULL AS has_summary,
                      NULL AS has_full_reply
               FROM analyses a
               WHERE a.session_id = ?""",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def _prompt_timeline_rows(self, c: sqlite3.Connection, session_id: str) -> list[dict]:
        prompts = c.execute(
            """SELECT *
               FROM prompts
               WHERE session_id = ?
               ORDER BY seq_in_session ASC, created_at ASC, id ASC""",
            (session_id,),
        ).fetchall()
        events: list[dict[str, Any]] = []
        for prompt in prompts:
            prompt_id = int(prompt["id"])
            prompt_seq = int(prompt["seq_in_session"] or 0)
            has_full_reply = 1 if self._get_prompt_reply_with_conn(c, session_id, prompt_seq) else 0
            events.append({
                "id": prompt_id,
                "session_id": prompt["session_id"],
                "student_id": prompt["student_id"],
                "content": prompt["content"],
                "created_at": prompt["created_at"],
                "type": "prompt",
                "seq_in_session": prompt_seq,
                "prompt_id": prompt_id,
                "reply_ref": None,
                "report_id": None,
                "severity": None,
                "understanding": None,
                "suggestion": None,
                "is_technical": None,
                "topic": None,
                "has_summary": None,
                "has_full_reply": has_full_reply,
            })
            summary = c.execute(
                """SELECT *
                   FROM ai_summaries
                   WHERE prompt_id = ?
                     AND COALESCE(content, '') != ''
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (prompt_id,),
            ).fetchone()
            if summary:
                events.append({
                    "id": summary["id"],
                    "session_id": summary["session_id"],
                    "student_id": summary["student_id"],
                    "content": summary["content"],
                    "created_at": summary["created_at"],
                    "type": "ai_summary",
                    "seq_in_session": prompt_seq,
                    "prompt_id": prompt_id,
                    "reply_ref": f"prompt:{prompt_id}",
                    "report_id": None,
                    "severity": None,
                    "understanding": None,
                    "suggestion": None,
                    "is_technical": None,
                    "topic": None,
                    "has_summary": 1,
                    "has_full_reply": has_full_reply,
                })
        return events

    def _bulk_message_timeline_rows(self, c: sqlite3.Connection, session_id: str) -> list[dict]:
        users = c.execute(
            """SELECT id, session_id, student_id, seq, text, summary, created_at
               FROM messages
               WHERE session_id = ? AND source = 'bulk' AND role = 'user'
               ORDER BY seq ASC, created_at ASC, id ASC""",
            (session_id,),
        ).fetchall()
        events: list[dict[str, Any]] = []
        for row in users:
            text = str(row["text"] or "").strip()
            if not text:
                continue
            prompt_seq = int(row["seq"])
            message_id = int(row["id"])
            reply_rows = self._message_reply_rows_with_conn(c, message_id)
            has_full_reply = 1 if any(str(reply["text"] or "").strip() for reply in reply_rows) else 0
            summary = str(row["summary"] or "").strip()
            events.append({
                "id": message_id,
                "session_id": row["session_id"],
                "student_id": row["student_id"],
                "content": text,
                "created_at": row["created_at"],
                "type": "prompt",
                "seq_in_session": prompt_seq,
                "prompt_id": None,
                "reply_ref": None,
                "report_id": None,
                "severity": None,
                "understanding": None,
                "suggestion": None,
                "is_technical": None,
                "topic": None,
                "has_summary": None,
                "has_full_reply": has_full_reply,
            })
            if has_full_reply:
                events.append({
                    "id": message_id,
                    "session_id": row["session_id"],
                    "student_id": row["student_id"],
                    "content": summary,
                    "created_at": float(reply_rows[0]["created_at"] or 0),
                    "type": "ai_summary",
                    "seq_in_session": prompt_seq,
                    "prompt_id": None,
                    "reply_ref": f"msg:{message_id}",
                    "report_id": None,
                    "severity": None,
                    "understanding": None,
                    "suggestion": None,
                    "is_technical": None,
                    "topic": None,
                    "has_summary": 1 if summary else 0,
                    "has_full_reply": has_full_reply,
                })
        return events

    def get_timeline_by_session(self, session_id: str) -> list[dict]:
        """Timeline aggregation by session.

        AI summary cards are prompt-scoped: at most one LLM summary per
        student prompt, with the full assistant reply loaded lazily by prompt_id.
        """
        with self._conn() as c:
            events = self._prompt_timeline_rows(c, session_id)
            if not events:
                events = self._bulk_message_timeline_rows(c, session_id)
            events.extend(self._analysis_timeline_rows(c, session_id))
            if events:
                priority = {"prompt": 0, "ai_summary": 1, "analysis": 2}
                events.sort(key=lambda item: (
                    float(item.get("created_at") or 0),
                    priority.get(str(item.get("type") or ""), 99),
                    int(item.get("id") or 0),
                ))
            return events

    def sessions_overview(self, student_id: str | None = None, limit: int = 10) -> list[dict]:
        """最近活跃对话概览：以 copilot.db sessions 表为权威源。"""
        sid = student_id or "student-1"
        return self.get_sessions_by_student(sid, limit=limit)

    def students_overview(self, limit: int = 50) -> list[dict]:
        """学员列表 + 状态概览（按 student_id 聚合）。"""
        with self._conn() as c:
            rows = c.execute(
                """SELECT
                     s.student_id,
                     s.display_name AS display_name,
                     COALESCE(COUNT(a.id), 0) AS analysis_count,
                     COALESCE(COUNT(DISTINCT a.session_id), 0) AS session_count,
                     COALESCE(MAX(a.created_at), s.created_at, 0) AS last_ts,
                     COALESCE((
                       SELECT a2.topic
                       FROM analyses a2
                       WHERE a2.student_id = s.student_id
                       ORDER BY a2.created_at DESC, a2.id DESC
                       LIMIT 1
                     ), '') AS last_topic,
                     CASE COALESCE(MAX(CASE a.severity
                       WHEN 'error' THEN 3
                       WHEN 'warn' THEN 2
                       ELSE 1
                     END), 1)
                       WHEN 3 THEN 'error'
                       WHEN 2 THEN 'warn'
                       ELSE 'info'
                     END AS last_severity,
                     COALESCE(SUM(CASE
                       WHEN COALESCE(a.alert, '') != ''
                         OR a.understanding IN ('low','stuck')
                       THEN 1 ELSE 0 END), 0) AS alert_count,
                     COALESCE((
                       SELECT a2.diagnosis
                       FROM analyses a2
                       WHERE a2.student_id = s.student_id
                       ORDER BY a2.created_at DESC, a2.id DESC
                       LIMIT 1
                     ), '') AS last_diagnosis
                   FROM students s
                   LEFT JOIN analyses a ON a.student_id = s.student_id
                   GROUP BY s.student_id
                   ORDER BY COALESCE(MAX(a.created_at), s.created_at, 0) DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_sessions_by_student(self, student_id: str, limit: int = 1000) -> list[dict]:
        """某学员的最近活跃对话列表，读取 copilot.db sessions 表。"""
        return self.get_sessions_by_student_from_table(student_id, limit=limit)

    def latest_for_student(self, student_id: str) -> dict | None:
        rows = self.recent_analyses(student_id, limit=1)
        return rows[0] if rows else None

    def unread_alerts(self, since_ts: float, student_id: str | None = None) -> list[dict]:
        with self._conn() as c:
            if student_id:
                rows = c.execute(
                    """SELECT * FROM analyses
                       WHERE created_at > ? AND student_id = ?
                         AND (alert != '' OR understanding IN ('low', 'stuck'))
                       ORDER BY created_at DESC LIMIT 50""",
                    (since_ts, student_id),
                ).fetchall()
            else:
                rows = c.execute(
                    """SELECT * FROM analyses
                       WHERE created_at > ?
                         AND (alert != '' OR understanding IN ('low', 'stuck'))
                       ORDER BY created_at DESC LIMIT 50""",
                    (since_ts,),
                ).fetchall()
            return [dict(r) for r in rows]

    def delete_student(self, student_id: str) -> dict[str, int]:
        """Delete one student's persisted data in a single transaction."""
        deleted: dict[str, int] = {}
        with self._conn() as c:
            cur = c.execute(
                """DELETE FROM analyses
                   WHERE student_id = ?
                      OR report_id IN (SELECT id FROM reports WHERE student_id = ?)""",
                (student_id, student_id),
            )
            deleted["analyses"] = cur.rowcount

            cur = c.execute(
                """DELETE FROM ai_summaries
                   WHERE student_id = ?
                      OR prompt_id IN (SELECT id FROM prompts WHERE student_id = ?)""",
                (student_id, student_id),
            )
            deleted["ai_summaries"] = cur.rowcount

            c.execute("DELETE FROM student_asks WHERE student_id = ?", (student_id,))

            for table in ["messages", "upload_requests"]:
                cur = c.execute(f"DELETE FROM {table} WHERE student_id = ?", (student_id,))
                if cur.rowcount:
                    deleted[table] = cur.rowcount

            for table in [
                "prompts",
                "raw_transcripts",
                "mentor_messages",
                "reports",
                "sessions",
                "students",
            ]:
                cur = c.execute(f"DELETE FROM {table} WHERE student_id = ?", (student_id,))
                deleted[table] = cur.rowcount
        return deleted
