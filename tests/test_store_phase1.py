from __future__ import annotations

import sqlite3

import pytest

from copilot.store import Store


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "phase1.db")


def _count_by_student(store: Store, table: str, student_id: str) -> int:
    with store._conn() as conn:
        return conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE student_id = ?",
            (student_id,),
        ).fetchone()[0]


def test_phase1_tables_indexes_and_fk_are_created(store):
    with store._conn() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert {"sessions", "students", "mentor_messages", "raw_transcripts"} <= tables

        indexes = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
        assert "idx_sessions_student" in indexes
        assert "idx_mentor_messages_student_delivered" in indexes
        assert "idx_raw_transcripts_session" in indexes

        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """INSERT INTO mentor_messages
                   (student_id, mentor_id, session_id, text, message_id, created_at)
                   VALUES ('missing', 'mentor', 'sess', 'hello', 'm-missing', 1.0)"""
            )


def test_raw_transcript_stores_full_content(store):
    content = "完整对话原文" * 20000
    assert len(content) > 100000

    store.add_raw_transcript("sess-raw", "stu-raw", content)

    row = store.get_raw_transcript("sess-raw")
    assert row is not None
    assert row["content"] == content
    assert len(row["content"]) == len(content)


def test_raw_transcript_tail_query_never_materializes_full_content(store):
    content = "MID-LINE-" + "x" * 500_000 + "\nCOMPLETE-LATEST-LINE\n"
    store.add_raw_transcript("sess-tail", "stu-tail", content)

    row = store.get_raw_transcript_tail_for_student_session(
        "stu-tail",
        "sess-tail",
        max_chars=1_024,
    )

    assert row is not None
    assert set(row) <= {
        "id",
        "session_id",
        "student_id",
        "content_sha256",
        "created_at",
        "content",
        "content_truncated",
    }
    assert len(row["content"]) <= 1_024
    assert row["content_truncated"] == 1
    assert row["content"].endswith("COMPLETE-LATEST-LINE\n")
    assert "MID-LINE-" not in row["content"]


def test_mentor_messages_delivery_read_unique_and_since(store):
    store.upsert_student("stu-msg", "消息学员")

    first_id = store.add_mentor_message(
        "stu-msg", "mentor-1", "sess-1", "第一条", "msg-1"
    )
    second_id = store.add_mentor_message(
        "stu-msg", "mentor-1", "sess-1", "第二条", "msg-2"
    )

    undelivered = store.list_undelivered_messages("stu-msg")
    assert [m["id"] for m in undelivered] == [first_id, second_id]
    assert undelivered[0]["delivered_at"] is None

    assert store.mark_message_delivered("msg-1") == 1
    after_delivered = store.list_undelivered_messages("stu-msg")
    assert [m["id"] for m in after_delivered] == [second_id]

    delivered_row = store.list_messages_since("stu-msg", 0)[0]
    assert delivered_row["message_id"] == "msg-1"
    assert delivered_row["delivered_at"] is not None

    assert [m["id"] for m in store.list_messages_since("stu-msg", first_id)] == [second_id]
    assert [m["id"] for m in store.list_undelivered_messages("stu-msg", first_id)] == [second_id]

    assert store.mark_message_read("msg-1") == 1
    read_row = store.list_messages_since("stu-msg", 0)[0]
    assert read_row["read_at"] is not None

    with pytest.raises(sqlite3.IntegrityError):
        store.add_mentor_message("stu-msg", "mentor-1", "sess-1", "重复", "msg-1")


def test_mentor_message_cursor_is_scoped_to_student(store):
    store.upsert_student("student-a", "A")
    store.upsert_student("student-b", "B")
    first_a = store.add_mentor_message("student-a", "mentor", "sess-a", "A1", "msg-a1")
    other_b = store.add_mentor_message("student-b", "mentor", "sess-b", "B1", "msg-b1")
    second_a = store.add_mentor_message("student-a", "mentor", "sess-a", "A2", "msg-a2")

    assert other_b > first_a

    rows_from_other_cursor = store.list_messages_since("student-a", "msg-b1")
    rows_from_other_numeric_cursor = store.list_messages_since("student-a", other_b)

    assert [row["id"] for row in rows_from_other_cursor] == [first_a, second_a]
    assert [row["id"] for row in rows_from_other_numeric_cursor] == [first_a, second_a]


def test_mark_message_status_can_be_scoped_to_student(store):
    store.upsert_student("student-a", "A")
    store.upsert_student("student-b", "B")
    store.add_mentor_message("student-a", "mentor", "sess-a", "A1", "msg-a")
    store.add_mentor_message("student-b", "mentor", "sess-b", "B1", "msg-b")

    assert store.mark_message_delivered("msg-b", student_id="student-a") == 0
    assert store.mark_message_read("msg-b", student_id="student-a") == 0
    assert store.mark_message_delivered("msg-b", student_id="student-b") == 1
    assert store.mark_message_read("msg-b", student_id="student-b") == 1

    row_b = store.list_messages_since("student-b", 0)[0]
    row_a = store.list_messages_since("student-a", 0)[0]
    assert row_b["delivered_at"] is not None
    assert row_b["read_at"] is not None
    assert row_a["delivered_at"] is None
    assert row_a["read_at"] is None


def _seed_student_everywhere(store: Store, student_id: str, session_id: str) -> None:
    store.upsert_student(student_id, f"{student_id} name")
    store.upsert_session(
        session_id=session_id,
        student_id=student_id,
        work_dir=f"/work/{student_id}",
        title=f"{student_id} title",
        created_at=10.0,
        last_activity_at=20.0,
    )
    report_id = store.add_report(
        student_id, session_id, "Stop", "report prompt", "/tmp/transcript", 3, 0
    )
    store.add_analysis(
        report_id,
        student_id,
        {"topic": student_id, "understanding": "high", "diagnosis": "ok"},
        session_id,
        f"{student_id} title",
    )
    prompt_id = store.add_prompt(session_id, 0, student_id, f"{student_id} prompt")
    store.add_ai_summary(prompt_id, session_id, student_id, f"{student_id} summary")
    store.add_raw_transcript(session_id, student_id, f"{student_id} raw transcript")
    store.add_mentor_message(student_id, "mentor-1", session_id, f"{student_id} msg", f"msg-{student_id}")


def test_delete_student_cascades_without_cross_student_leak(store):
    _seed_student_everywhere(store, "student-a", "session-a")
    _seed_student_everywhere(store, "student-b", "session-b")

    deleted = store.delete_student("student-a")

    assert deleted["analyses"] == 1
    assert deleted["ai_summaries"] == 1
    assert deleted["prompts"] == 1
    assert deleted["raw_transcripts"] == 1
    assert deleted["mentor_messages"] == 1
    assert deleted["reports"] == 1
    assert deleted["sessions"] == 1
    assert deleted["students"] == 1

    for table in [
        "reports",
        "analyses",
        "prompts",
        "ai_summaries",
        "raw_transcripts",
        "mentor_messages",
        "sessions",
        "students",
    ]:
        assert _count_by_student(store, table, "student-a") == 0
        assert _count_by_student(store, table, "student-b") == 1


def test_delete_student_removes_fk_children_even_if_child_student_id_drifted(store):
    store.upsert_student("student-a", "A")
    report_id = store.add_report("student-a", "session-a", "Stop", "p", "", 1, 0)
    analysis_id = store.add_analysis(
        report_id,
        "student-b",
        {"topic": "drifted analysis", "understanding": "high"},
        "session-b",
        "wrong student child",
    )
    prompt_id = store.add_prompt("session-a", 0, "student-a", "prompt-a")
    summary_id = store.add_ai_summary(
        prompt_id,
        "session-b",
        "student-b",
        "drifted summary",
    )

    deleted = store.delete_student("student-a")

    assert deleted["analyses"] == 1
    assert deleted["ai_summaries"] == 1
    with store._conn() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM reports WHERE id = ?",
            (report_id,),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM analyses WHERE id = ?",
            (analysis_id,),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM prompts WHERE id = ?",
            (prompt_id,),
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM ai_summaries WHERE id = ?",
            (summary_id,),
        ).fetchone()[0] == 0


def test_sessions_backfill_uses_latest_title_and_min_created_at(tmp_path):
    db_path = tmp_path / "backfill.db"
    store = Store(db_path)
    report_old = store.add_report("stu-backfill", "sess-backfill", "Stop", "old", "", 1, 0)
    report_new = store.add_report("stu-backfill", "sess-backfill", "Stop", "new", "", 1, 0)
    old_id = store.add_analysis(
        report_old,
        "stu-backfill",
        {"topic": "old", "understanding": "low", "severity": "error"},
        "sess-backfill",
        "zz-old-title",
    )
    new_id = store.add_analysis(
        report_new,
        "stu-backfill",
        {"topic": "new", "understanding": "high", "severity": "info"},
        "sess-backfill",
        "aa-latest-title",
    )
    with store._conn() as conn:
        conn.execute("UPDATE analyses SET created_at = ? WHERE id = ?", (100.0, old_id))
        conn.execute("UPDATE analyses SET created_at = ? WHERE id = ?", (200.0, new_id))

    Store(db_path)

    with Store(db_path)._conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?",
            ("sess-backfill",),
        ).fetchone()

    assert row is not None
    assert row["student_id"] == "stu-backfill"
    assert row["title"] == "aa-latest-title"
    assert row["title"] != "zz-old-title"
    assert row["created_at"] == 100.0
    assert row["last_activity_at"] == 200.0


def test_legacy_schema_migration_adds_pending_and_backfills_session_id(tmp_path):
    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL,
                session_id TEXT,
                event TEXT,
                prompt TEXT,
                transcript_path TEXT,
                msg_count INTEGER,
                tool_calls INTEGER,
                created_at REAL NOT NULL
            );
            CREATE TABLE analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id INTEGER NOT NULL,
                student_id TEXT NOT NULL,
                topic TEXT,
                understanding TEXT,
                off_topic INTEGER,
                stuck_at TEXT,
                progress TEXT,
                guidance TEXT,
                alert TEXT,
                raw TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY (report_id) REFERENCES reports(id)
            );
            CREATE TABLE prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                seq_in_session INTEGER,
                student_id TEXT,
                content TEXT,
                created_at REAL NOT NULL
            );
            CREATE TABLE ai_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_id INTEGER,
                session_id TEXT,
                student_id TEXT,
                content TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY (prompt_id) REFERENCES prompts(id)
            );
            INSERT INTO reports
                (student_id, session_id, event, prompt, transcript_path,
                 msg_count, tool_calls, created_at)
            VALUES ('legacy-stu', 'legacy-sess', 'Stop', 'old prompt', '', 1, 0, 10.0);
            INSERT INTO analyses
                (report_id, student_id, topic, understanding, off_topic, stuck_at,
                 progress, guidance, alert, raw, created_at)
            VALUES (1, 'legacy-stu', 'legacy topic', 'high', 0, '',
                    '', '', '', '{}', 20.0);
            """
        )

    migrated = Store(db_path)

    with migrated._conn() as conn:
        report_cols = {row[1] for row in conn.execute("PRAGMA table_info(reports)").fetchall()}
        analysis = conn.execute("SELECT * FROM analyses WHERE id = 1").fetchone()
        session = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?",
            ("legacy-sess",),
        ).fetchone()

    assert "analysis_pending" in report_cols
    assert analysis["session_id"] == "legacy-sess"
    assert session is not None
    assert session["student_id"] == "legacy-stu"
    assert session["created_at"] == 20.0
    assert session["last_activity_at"] == 20.0


def test_analysis_pending_set_and_list(store):
    first = store.add_report("stu-pending", "sess-1", "Stop", "p1", "", 1, 0)
    second = store.add_report("stu-pending", "sess-2", "Stop", "p2", "", 1, 0)

    store.set_analysis_pending(first, True)
    rows = store.list_pending_reports()
    assert [row["id"] for row in rows] == [first]

    store.set_analysis_pending(second, True)
    assert [row["id"] for row in store.list_pending_reports()] == [first, second]

    store.set_analysis_pending(first, False)
    assert [row["id"] for row in store.list_pending_reports()] == [second]


def test_add_report_keeps_recovery_prompt_and_prompt_table_keeps_full_timeline_copy(store):
    long_prompt = "权威全文" * 10000
    report_id = store.add_report(
        "stu-full-prompt", "sess-full-prompt", "Stop", long_prompt, "", 1, 0
    )
    store.add_prompt("sess-full-prompt", 0, "stu-full-prompt", long_prompt)

    with store._conn() as conn:
        report_prompt = conn.execute(
            "SELECT prompt FROM reports WHERE id = ?",
            (report_id,),
        ).fetchone()[0]

    assert report_prompt == long_prompt
    prompts = store.get_prompts_by_session("sess-full-prompt")
    assert len(prompts) == 1
    assert prompts[0]["content"] == long_prompt
    assert len(prompts[0]["content"]) == len(long_prompt)


def test_get_sessions_by_student_from_table_reads_sessions_table(store):
    store.upsert_student("stu-sessions", "会话学员")
    store.upsert_session(
        "sess-old", "stu-sessions", "/work", "旧会话", created_at=10.0, last_activity_at=20.0
    )
    store.upsert_session(
        "sess-new", "stu-sessions", "/work", "新会话", created_at=30.0, last_activity_at=40.0
    )
    report_id = store.add_report("stu-sessions", "sess-new", "Stop", "p", "", 1, 0)
    store.add_analysis(
        report_id,
        "stu-sessions",
        {
            "topic": "最新主题",
            "understanding": "stuck",
            "severity": "warn",
            "diagnosis": "最新诊断",
            "is_technical": True,
        },
        "sess-new",
        "ignored by table query",
    )

    rows = store.get_sessions_by_student_from_table("stu-sessions", limit=10)

    assert [row["session_id"] for row in rows] == ["sess-new", "sess-old"]
    assert rows[0]["session_title"] == "新会话"
    assert rows[0]["last_ts"] == 40.0
    assert rows[0]["analysis_count"] == 1
    assert rows[0]["alert_count"] == 1
    assert rows[0]["last_severity"] == "warn"
    assert rows[0]["last_topic"] == "最新主题"
    assert rows[0]["last_diagnosis"] == "最新诊断"


def test_upsert_session_existing_row_only_updates_title_and_activity(store):
    store.upsert_session(
        "sess-stable",
        "student-original",
        "/work/original",
        "旧标题",
        created_at=10.0,
        last_activity_at=20.0,
    )

    with pytest.raises(ValueError):
        store.upsert_session(
            "sess-stable",
            "student-other",
            "/work/other",
            "新标题",
            created_at=30.0,
            last_activity_at=40.0,
        )

    with store._conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?",
            ("sess-stable",),
        ).fetchone()

    assert row["student_id"] == "student-original"
    assert row["work_dir"] == "/work/original"
    assert row["created_at"] == 10.0
    assert row["title"] == "旧标题"
    assert row["last_activity_at"] == 20.0


def test_upsert_session_preserves_title_on_empty_update_and_fills_blank_work_dir(store):
    store.upsert_session(
        "sess-no-clobber",
        "student-original",
        "",
        "已有标题",
        created_at=10.0,
        last_activity_at=20.0,
    )

    store.upsert_session(
        "sess-no-clobber",
        "student-original",
        "/work/current",
        "",
        created_at=30.0,
        last_activity_at=40.0,
    )

    with store._conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?",
            ("sess-no-clobber",),
        ).fetchone()

    assert row["title"] == "已有标题"
    assert row["work_dir"] == "/work/current"
    assert row["last_activity_at"] == 40.0


def test_sessions_group_columns_migration_is_reentrant(tmp_path):
    db_path = tmp_path / "legacy-sessions.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                student_id TEXT,
                work_dir TEXT,
                title TEXT,
                created_at REAL,
                last_activity_at REAL
            );
            INSERT INTO sessions
              (session_id, student_id, work_dir, title, created_at, last_activity_at)
            VALUES ('sess-legacy', 'stu-legacy', '/work/legacy', 'Legacy', 1.0, 2.0);
            """
        )

    Store(db_path)
    Store(db_path)

    with Store(db_path)._conn() as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        row = conn.execute(
            "SELECT group_type, space_name FROM sessions WHERE session_id = ?",
            ("sess-legacy",),
        ).fetchone()

    assert {"group_type", "space_name"} <= cols
    assert row["group_type"] is None
    assert row["space_name"] is None
