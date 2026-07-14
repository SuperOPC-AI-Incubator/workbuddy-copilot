from __future__ import annotations

import json
import os
import re
import sqlite3
import stat
from pathlib import Path

import pytest

from copilot.student_platform.macos import macos_workbuddy_data
from copilot.student_platform.workbuddy import WorkBuddyDataAdapter


FIXTURE_MANIFEST = (
    Path(__file__).parent / "fixtures" / "workbuddy" / "macos" / "manifest.json"
)


def test_macos_fixture_contains_only_synthetic_non_sensitive_data() -> None:
    fixture_text = FIXTURE_MANIFEST.read_text(encoding="utf-8")

    assert "fixture-student" in fixture_text
    assert "/Users/" not in fixture_text
    assert re.search(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)", fixture_text) is None
    assert re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", fixture_text) is None


def _materialize_macos_workbuddy(tmp_path: Path) -> Path:
    """Build a real SQLite + JSONL WorkBuddy directory from the committed fixture."""
    manifest = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    config_dir = tmp_path / ".workbuddy"
    config_dir.mkdir()
    database = sqlite3.connect(config_dir / "workbuddy.db")
    try:
        database.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                cwd TEXT,
                title TEXT,
                custom_title TEXT,
                created_at INTEGER,
                last_activity_at INTEGER,
                deleted_at INTEGER
            );
            CREATE TABLE workspaces (
                path TEXT PRIMARY KEY,
                name TEXT,
                last_opened_at INTEGER
            );
            """
        )
        database.executemany(
            """INSERT INTO sessions
               (id, cwd, title, custom_title, created_at, last_activity_at, deleted_at)
               VALUES (:id, :cwd, :title, :custom_title, :created_at, :last_activity_at, :deleted_at)""",
            manifest["sessions"],
        )
        database.executemany(
            """INSERT INTO workspaces (path, name, last_opened_at)
               VALUES (:path, :name, :last_opened_at)""",
            manifest["workspaces"],
        )
        database.commit()
    finally:
        database.close()

    for transcript in manifest["transcripts"]:
        path = config_dir / transcript["relative_path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(json.dumps(line, ensure_ascii=False) + "\n" for line in transcript["lines"]),
            encoding="utf-8",
        )
    return config_dir


def _write_transcript(
    config_dir: Path,
    relative_path: str,
    session_id: str,
    content: str,
) -> Path:
    path = config_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"type": "message", "session_id": session_id, "content": content},
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def adapter(tmp_path: Path) -> WorkBuddyDataAdapter:
    return WorkBuddyDataAdapter(_materialize_macos_workbuddy(tmp_path))


def test_adapter_reads_sessions_and_workspaces_from_real_sqlite_fixture(
    adapter: WorkBuddyDataAdapter,
) -> None:
    sessions = adapter.list_sessions()

    assert [session.session_id for session in sessions] == [
        "fixture-session-space",
        "fixture-session-task",
    ]
    assert sessions[0].title == "Fixture workspace task"
    assert sessions[0].group_type == "space"
    assert sessions[0].space_name == "Fixture workspace"
    assert sessions[1].group_type == "task"
    assert sessions[1].space_name == "fixture-task"


def test_adapter_indexes_transcript_by_jsonl_session_id_not_cwd_encoding(
    adapter: WorkBuddyDataAdapter,
) -> None:
    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is None
    assert result.path is None
    assert "Please explain this fixture example." in result.content


def test_repeated_transcript_reads_close_every_probe_connection(
    adapter: WorkBuddyDataAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_connect = adapter._connect_readonly
    opened_connections = []

    class TrackingConnection:
        def __init__(self, connection):
            self.connection = connection
            self.closed = False

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, *args, **kwargs):
            return self.connection.execute(*args, **kwargs)

        def close(self):
            self.closed = True
            self.connection.close()

    def tracking_connect():
        connection = TrackingConnection(original_connect())
        opened_connections.append(connection)
        return connection

    monkeypatch.setattr(adapter, "_connect_readonly", tracking_connect)

    for _ in range(10):
        result = adapter.read_transcript("session-space")
        assert result.failure is None
    adapter.list_sessions()
    adapter.list_workspaces()

    assert len(opened_connections) == 14
    assert all(connection.closed for connection in opened_connections)
    adapter.close()


def test_probe_returns_schema_mismatch_instead_of_empty_success(tmp_path: Path) -> None:
    config_dir = tmp_path / ".workbuddy"
    config_dir.mkdir()
    sqlite3.connect(config_dir / "workbuddy.db").close()

    result = WorkBuddyDataAdapter(config_dir).probe()

    assert result.ready is False
    assert result.failure is not None
    assert result.failure.code == "schema_mismatch"


def test_probe_rejects_missing_required_session_column(tmp_path: Path) -> None:
    config_dir = tmp_path / ".workbuddy"
    config_dir.mkdir()
    database = sqlite3.connect(config_dir / "workbuddy.db")
    try:
        database.executescript(
            """
            CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT);
            CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER);
            """
        )
        database.commit()
    finally:
        database.close()

    result = WorkBuddyDataAdapter(config_dir).probe()

    assert result.ready is False
    assert result.failure is not None
    assert result.failure.code == "schema_mismatch"


def test_probe_reports_not_installed_when_config_dir_is_missing(tmp_path: Path) -> None:
    result = WorkBuddyDataAdapter(tmp_path / "missing-workbuddy").probe()

    assert result.ready is False
    assert result.failure is not None
    assert result.failure.code == "not_installed"


def test_probe_classifies_corrupt_database_instead_of_temporary_empty_state(tmp_path: Path) -> None:
    config_dir = tmp_path / ".workbuddy"
    config_dir.mkdir()
    (config_dir / "workbuddy.db").write_bytes(b"not a sqlite database")

    result = WorkBuddyDataAdapter(config_dir).probe()

    assert result.ready is False
    assert result.failure is not None
    assert result.failure.code == "corrupt"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission-bit breaker")
def test_probe_classifies_inaccessible_config_dir_as_permission_denied(tmp_path: Path) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)
    original_mode = stat.S_IMODE(config_dir.stat().st_mode)
    config_dir.chmod(0)
    try:
        try:
            os.listdir(config_dir)
        except PermissionError:
            pass
        else:
            pytest.skip("current account does not enforce chmod directory permissions")
        result = WorkBuddyDataAdapter(config_dir).probe()
    finally:
        config_dir.chmod(original_mode)

    assert result.ready is False
    assert result.failure is not None
    assert result.failure.code == "permission_denied"


def test_detect_active_session_keeps_unknown_as_typed_failure(
    adapter: WorkBuddyDataAdapter,
) -> None:
    result = adapter.detect_active_session()

    assert result.session_id is None
    assert result.failure is not None
    assert result.failure.code == "unknown_active_session"


def test_transcript_index_rejects_file_and_directory_symlinks_outside_projects(
    adapter: WorkBuddyDataAdapter, tmp_path: Path
) -> None:
    outside_file = tmp_path / "outside.jsonl"
    outside_file.write_text(
        json.dumps({"type": "message", "session_id": "outside-file", "content": "private"})
        + "\n",
        encoding="utf-8",
    )
    (adapter.projects_dir / "escape-file.jsonl").symlink_to(outside_file)
    outside_dir = tmp_path / "outside-dir"
    outside_dir.mkdir()
    (outside_dir / "nested.jsonl").write_text(
        json.dumps({"type": "message", "session_id": "outside-directory", "content": "private"})
        + "\n",
        encoding="utf-8",
    )
    (adapter.projects_dir / "escape-directory").symlink_to(outside_dir, target_is_directory=True)

    file_result = adapter.read_transcript("outside-file")
    directory_result = adapter.read_transcript("outside-directory")

    assert file_result.failure is not None
    assert file_result.failure.code == "transcript_not_found"
    assert directory_result.failure is not None
    assert directory_result.failure.code == "transcript_not_found"


def test_exact_filename_requires_matching_jsonl_session_metadata(
    adapter: WorkBuddyDataAdapter,
) -> None:
    _write_transcript(
        adapter.config_dir,
        "projects/wrong/fixture-session-space.jsonl",
        "different-session",
        "wrong exact filename",
    )

    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is None
    assert result.path is None
    assert "wrong exact filename" not in result.content


def test_multiple_metadata_matches_return_typed_ambiguity(
    adapter: WorkBuddyDataAdapter,
) -> None:
    _write_transcript(
        adapter.config_dir,
        "projects/other/second.jsonl",
        "fixture-session-space",
        "duplicate metadata",
    )

    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_ambiguous"


def test_transcript_index_stops_at_bounded_candidate_budget(tmp_path: Path) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)
    _write_transcript(
        config_dir, "projects/second/second.jsonl", "fixture-session-task", "second"
    )
    adapter = WorkBuddyDataAdapter(config_dir, max_transcript_candidates=1)

    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_index_incomplete"


def test_transcript_index_stops_at_bounded_byte_budget(tmp_path: Path) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)
    adapter = WorkBuddyDataAdapter(config_dir, max_transcript_bytes=8)

    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_index_incomplete"


def test_transcript_byte_budget_is_per_file_not_aggregate(tmp_path: Path) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)
    one_megabyte = "x" * (1024 * 1024)
    for number in range(9):
        _write_transcript(
            config_dir,
            f"projects/bulk/{number:02d}.jsonl",
            f"bulk-session-{number}",
            one_megabyte,
        )
    adapter = WorkBuddyDataAdapter(config_dir)

    result = adapter.read_transcript("session-space")

    assert result.failure is None
    assert "Please help me reason about the loop." in result.content


def test_transcript_index_candidates_store_metadata_not_content(
    adapter: WorkBuddyDataAdapter,
) -> None:
    result = adapter.read_transcript("session-space")

    assert result.failure is None
    assert adapter._transcript_index is not None
    candidates = [
        candidate
        for matches in adapter._transcript_index.values()
        for candidate in matches
    ]
    assert candidates
    assert all("content" not in candidate.__dataclass_fields__ for candidate in candidates)


def test_metadata_index_reads_a_then_a_different_valid_b(tmp_path: Path) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)
    _write_transcript(
        config_dir,
        "projects/second/session-task.jsonl",
        "session-task",
        "second transcript",
    )
    adapter = WorkBuddyDataAdapter(config_dir)

    first = adapter.read_transcript("session-space")
    second = adapter.read_transcript("session-task")

    assert first.failure is None
    assert "Please help me reason about the loop." in first.content
    assert second.failure is None
    assert "second transcript" in second.content


def test_metadata_index_rejects_inode_replacement_after_index(
    adapter: WorkBuddyDataAdapter,
) -> None:
    first = adapter.read_transcript("session-space")
    assert first.failure is None
    assert adapter._transcript_index is not None
    candidate = adapter._transcript_index["session-space"][0]
    transcript_path = adapter.projects_dir / candidate.relative_path
    replacement = transcript_path.with_name("replacement.tmp")
    replacement.write_text(
        json.dumps(
            {
                "type": "message",
                "session_id": "session-space",
                "content": "replacement transcript",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(replacement, transcript_path)
    assert transcript_path.stat().st_ino != candidate.inode

    result = adapter.read_transcript("session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_index_incomplete"
    assert "replacement transcript" not in result.content


def test_metadata_index_revalidates_session_id_after_same_inode_content_change(
    adapter: WorkBuddyDataAdapter,
) -> None:
    first = adapter.read_transcript("session-space")
    assert first.failure is None
    assert adapter._transcript_index is not None
    candidate = adapter._transcript_index["session-space"][0]
    transcript_path = adapter.projects_dir / candidate.relative_path
    transcript_path.write_text(
        json.dumps(
            {
                "type": "message",
                "session_id": "different-session",
                "content": "same inode, different session",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    assert transcript_path.stat().st_ino == candidate.inode

    result = adapter.read_transcript("session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_index_incomplete"
    assert "same inode, different session" not in result.content


def test_ambiguous_target_releases_temporary_parent_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)
    _write_transcript(
        config_dir,
        "projects/other/duplicate.jsonl",
        "session-space",
        "duplicate",
    )
    adapter = WorkBuddyDataAdapter(config_dir)
    original_dup = os.dup
    original_close = os.close
    duplicated: list[int] = []
    closed: list[int] = []

    def tracking_dup(fd: int) -> int:
        duplicated_fd = original_dup(fd)
        duplicated.append(duplicated_fd)
        return duplicated_fd

    def tracking_close(fd: int) -> None:
        closed.append(fd)
        original_close(fd)

    monkeypatch.setattr(os, "dup", tracking_dup)
    monkeypatch.setattr(os, "close", tracking_close)

    result = adapter.read_transcript("session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_ambiguous"
    assert duplicated
    assert set(duplicated) <= set(closed)
    adapter.close()


def test_malformed_jsonl_makes_transcript_index_typed_incomplete(
    adapter: WorkBuddyDataAdapter,
) -> None:
    malformed = adapter.projects_dir / "bad.jsonl"
    malformed.write_text("not-json\n", encoding="utf-8")

    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is not None
    assert result.failure.code == "transcript_index_incomplete"


@pytest.mark.skipif(os.name == "nt", reason="descriptor-relative POSIX race breaker")
def test_transcript_read_keeps_open_parent_descriptor_when_path_parent_is_swapped(
    adapter: WorkBuddyDataAdapter, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    safe_dir = adapter.projects_dir / "safe"
    safe_path = _write_transcript(
        adapter.config_dir,
        "projects/safe/target.jsonl",
        "session-race",
        "safe transcript",
    )
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    secret_path = _write_transcript(
        tmp_path,
        "outside/target.jsonl",
        "session-race",
        "SECRET OUTSIDE TRANSCRIPT",
    )
    assert secret_path.parent == outside_dir
    backup_dir = adapter.projects_dir / "safe-backup"
    original_path_open = Path.open
    original_os_open = os.open
    original_fdopen = os.fdopen
    secret_was_read = []
    swapped = False

    class RecordingFile:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            self.handle.__enter__()
            return self

        def __exit__(self, *args):
            return self.handle.__exit__(*args)

        def read(self, *args, **kwargs):
            data = self.handle.read(*args, **kwargs)
            if b"SECRET OUTSIDE TRANSCRIPT" in data if isinstance(data, bytes) else "SECRET OUTSIDE TRANSCRIPT" in data:
                secret_was_read.append(True)
            return data

    def swap_parent() -> None:
        nonlocal swapped
        if swapped:
            return
        swapped = True
        safe_dir.rename(backup_dir)
        safe_dir.symlink_to(outside_dir, target_is_directory=True)

    def race_path_open(path, *args, **kwargs):
        if path == safe_path:
            swap_parent()
            return RecordingFile(original_path_open(path, *args, **kwargs))
        return original_path_open(path, *args, **kwargs)

    def race_os_open(path, flags, *args, **kwargs):
        if os.fspath(path) in {os.fspath(safe_path), "target.jsonl"}:
            swap_parent()
        return original_os_open(path, flags, *args, **kwargs)

    def race_fdopen(fd, *args, **kwargs):
        return RecordingFile(original_fdopen(fd, *args, **kwargs))

    monkeypatch.setattr(Path, "open", race_path_open)
    monkeypatch.setattr(os, "open", race_os_open)
    monkeypatch.setattr(os, "fdopen", race_fdopen)

    result = adapter.read_transcript("session-race")

    assert swapped is True
    assert secret_was_read == []
    assert result.failure is None
    assert result.path is None
    assert "safe transcript" in result.content


@pytest.mark.skipif(os.name == "nt", reason="descriptor-relative POSIX race breaker")
def test_transcript_index_rejects_projects_root_replaced_after_snapshot(
    adapter: WorkBuddyDataAdapter, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    external_config = tmp_path / "external-config"
    _write_transcript(
        external_config,
        "projects/secret.jsonl",
        "session-root-race",
        "SECRET ROOT REPLACEMENT",
    )
    original_root = adapter._projects_root
    original_fdopen = os.fdopen
    backup_config = adapter.config_dir.with_name("workbuddy-backup")
    root_calls = 0
    secret_was_read = []

    class RecordingFile:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            self.handle.__enter__()
            return self

        def __exit__(self, *args):
            return self.handle.__exit__(*args)

        def read(self, *args, **kwargs):
            data = self.handle.read(*args, **kwargs)
            if b"SECRET ROOT REPLACEMENT" in data:
                secret_was_read.append(True)
            return data

    def raced_projects_root():
        nonlocal root_calls
        root_calls += 1
        result = original_root()
        if root_calls == 2:
            adapter.config_dir.rename(backup_config)
            adapter.config_dir.symlink_to(external_config, target_is_directory=True)
        return result

    monkeypatch.setattr(adapter, "_projects_root", raced_projects_root)
    monkeypatch.setattr(os, "fdopen", lambda fd, *args, **kwargs: RecordingFile(original_fdopen(fd, *args, **kwargs)))

    result = adapter.read_transcript("session-root-race")

    assert root_calls >= 2
    assert secret_was_read == []
    assert result.failure is not None
    assert result.failure.code == "transcript_index_incomplete"


def test_cached_transcript_content_exposes_no_path_after_projects_root_is_replaced(
    adapter: WorkBuddyDataAdapter, tmp_path: Path
) -> None:
    first = adapter.read_transcript("fixture-session-space")
    assert first.failure is None
    outside = tmp_path / "outside-projects"
    _write_transcript(
        tmp_path,
        "outside-projects/opaque-directory/metadata-name.jsonl",
        "fixture-session-space",
        "SECRET AFTER INDEX",
    )
    backup = adapter.projects_dir.with_name("projects-backup")
    adapter.projects_dir.rename(backup)
    adapter.projects_dir.symlink_to(outside, target_is_directory=True)

    result = adapter.read_transcript("fixture-session-space")

    assert result.failure is None
    assert result.path is None
    assert "SECRET AFTER INDEX" not in result.content
    assert "Please explain this fixture example." in result.content


def test_macos_factory_requires_an_explicit_config_dir(tmp_path: Path) -> None:
    config_dir = _materialize_macos_workbuddy(tmp_path)

    adapter = macos_workbuddy_data(config_dir)

    assert adapter.config_dir == config_dir
