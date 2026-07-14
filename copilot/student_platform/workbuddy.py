"""WorkBuddy's local data adapter, owned by the student platform layer.

The adapter intentionally receives an already-resolved ``config_dir``.  The
shared Student Core never imports this module and therefore never needs to
guess an operating-system-specific WorkBuddy location.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import sqlite3
import stat
from typing import Any


MAX_TRANSCRIPT_CANDIDATES = 512
# Safety cap for each individual transcript.  A student's complete projects
# directory may legitimately contain many transcripts whose aggregate size is
# much larger than this value.
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
DESCRIPTOR_TRAVERSAL_SUPPORTED = (
    getattr(os, "O_NOFOLLOW", None) is not None
    and getattr(os, "O_DIRECTORY", None) is not None
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.listdir in os.supports_fd
)


@dataclass(frozen=True)
class AdapterFailure:
    """A recoverable, user-safe description of a local WorkBuddy failure."""

    code: str
    message: str = ""


class WorkBuddyDataError(RuntimeError):
    """Raised when a list operation cannot return a truthful session list."""

    def __init__(self, failure: AdapterFailure) -> None:
        super().__init__(failure.code)
        self.failure = failure


@dataclass(frozen=True)
class WorkBuddySession:
    """Platform-normalized WorkBuddy session metadata."""

    session_id: str
    title: str
    work_dir: str
    created_at: float
    last_activity_at: float
    deleted: bool
    group_type: str
    space_name: str

    def to_dict(self) -> dict[str, Any]:
        """Preserve the mapping shape historically returned by ``wb_sync``."""
        return {
            "session_id": self.session_id,
            "title": self.title,
            "work_dir": self.work_dir,
            "created_at": self.created_at,
            "last_activity_at": self.last_activity_at,
            "deleted": self.deleted,
            "group_type": self.group_type,
            "space_name": self.space_name,
        }


@dataclass(frozen=True)
class ProbeResult:
    config_dir: Path
    database_path: Path
    capabilities: frozenset[str] = field(default_factory=frozenset)
    failure: AdapterFailure | None = None

    @property
    def ready(self) -> bool:
        return self.failure is None


@dataclass(frozen=True)
class TranscriptReadResult:
    content: str = ""
    path: Path | None = None
    failure: AdapterFailure | None = None

    @property
    def ready(self) -> bool:
        return self.failure is None


@dataclass(frozen=True)
class ActiveSessionResult:
    session_id: str | None = None
    failure: AdapterFailure | None = None


@dataclass(frozen=True)
class _TranscriptCandidate:
    """An inode-pinned JSONL location relative to the opened projects root."""

    relative_path: Path
    device: int
    inode: int


def _ms_to_seconds(value: Any) -> float:
    try:
        return float(value) / 1000.0 if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _normalise_path(value: Any) -> str:
    text = str(value or "")
    return os.path.normpath(os.path.expanduser(text)) if text else ""


def _directory_name(value: str) -> str:
    normalized = _normalise_path(value)
    return os.path.basename(normalized) if normalized else ""


def _workspace_name(workspace: dict[str, Any]) -> str:
    for key in ("name", "title", "display_name"):
        if workspace.get(key):
            return str(workspace[key])
    return _directory_name(str(workspace.get("path") or ""))


def filter_message_jsonl(path: str | os.PathLike[str]) -> str:
    """Keep only original top-level ``message`` lines from a transcript."""
    with Path(path).expanduser().open("r", encoding="utf-8", errors="replace") as handle:
        return filter_message_jsonl_text(handle.read())


def filter_message_jsonl_text(content: str) -> str:
    """Filter already-read JSONL without forcing a second filesystem traversal."""
    kept: list[str] = []
    for raw_line in content.splitlines(keepends=True):
        try:
            item = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and item.get("type") == "message":
            kept.append(raw_line if raw_line.endswith("\n") else raw_line + "\n")
    return "".join(kept)


class WorkBuddyDataAdapter:
    """Read one explicit WorkBuddy config directory without OS path guesses.

    The adapter does not infer a current session from ``last_activity_at``:
    WorkBuddy offers no reliable active-session marker in the documented local
    files used here, so it returns ``unknown_active_session`` instead.
    """

    REQUIRED_TABLES = frozenset({"sessions", "workspaces"})
    REQUIRED_COLUMNS = {
        "sessions": frozenset(
            {
                "id",
                "cwd",
                "title",
                "custom_title",
                "created_at",
                "last_activity_at",
                "deleted_at",
            }
        ),
        "workspaces": frozenset({"path", "last_opened_at"}),
    }

    def __init__(
        self,
        config_dir: str | os.PathLike[str],
        *,
        database_path: str | os.PathLike[str] | None = None,
        projects_dir: str | os.PathLike[str] | None = None,
        max_transcript_candidates: int = MAX_TRANSCRIPT_CANDIDATES,
        max_transcript_bytes: int = MAX_TRANSCRIPT_BYTES,
    ) -> None:
        if max_transcript_candidates < 1 or max_transcript_bytes < 1:
            raise ValueError("transcript index limits must be positive")
        self.config_dir = Path(config_dir).expanduser()
        self.database_path = (
            Path(database_path).expanduser()
            if database_path is not None
            else self.config_dir / "workbuddy.db"
        )
        self.projects_dir = (
            Path(projects_dir).expanduser()
            if projects_dir is not None
            else self.config_dir / "projects"
        )
        self.max_transcript_candidates = int(max_transcript_candidates)
        self.max_transcript_bytes = int(max_transcript_bytes)
        self._transcript_index: dict[str, tuple[_TranscriptCandidate, ...]] | None = None
        self._transcript_index_failure: AdapterFailure | None = None
        self._transcript_root: Path | None = None
        self._transcript_root_fd: int | None = None

    def probe(self) -> ProbeResult:
        """Validate the known local DB contract without treating errors as empty."""
        try:
            if not stat.S_ISDIR(self.config_dir.stat().st_mode):
                return self._probe_failure(
                    "not_installed", "WorkBuddy config directory is missing"
                )
            if not stat.S_ISREG(self.database_path.stat().st_mode):
                return self._probe_failure(
                    "not_installed", "WorkBuddy database is missing"
                )
            with closing(self._connect_readonly()) as connection:
                rows = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
                table_names = {str(row[0]) for row in rows}
                missing = self.REQUIRED_TABLES - table_names
                if missing:
                    return self._probe_failure(
                        "schema_mismatch", "required WorkBuddy tables are missing"
                    )
                columns_by_table = {
                    table: {
                        str(column[1])
                        for column in connection.execute(f"PRAGMA table_info({table})").fetchall()
                    }
                    for table in self.REQUIRED_TABLES
                }
        except BaseException as exc:
            return self._probe_from_exception(exc)
        if any(
            required - columns_by_table[table]
            for table, required in self.REQUIRED_COLUMNS.items()
        ):
            return self._probe_failure(
                "schema_mismatch", "required WorkBuddy columns are missing"
            )
        capabilities = {"sessions", "workspaces"}
        projects_root, _projects_stat, _projects_failure = self._projects_root()
        if projects_root is not None:
            capabilities.add("transcripts")
        return ProbeResult(
            config_dir=self.config_dir,
            database_path=self.database_path,
            capabilities=frozenset(capabilities),
        )

    def list_sessions(
        self, *, include_deleted: bool = False, limit: int = 1000
    ) -> list[WorkBuddySession]:
        """Return normalized session metadata or raise a typed local failure."""
        self._require_ready()
        if limit < 1:
            return []
        try:
            with closing(self._connect_readonly()) as connection:
                where = "" if include_deleted else "WHERE deleted_at IS NULL"
                session_rows = connection.execute(
                    f"""SELECT id, cwd, title, custom_title, created_at, last_activity_at, deleted_at
                        FROM sessions {where}
                        ORDER BY last_activity_at DESC
                        LIMIT ?""",
                    (limit,),
                ).fetchall()
                workspace_rows = connection.execute(
                    "SELECT * FROM workspaces ORDER BY last_opened_at DESC LIMIT ?", (limit,)
                ).fetchall()
        except BaseException as exc:
            raise WorkBuddyDataError(self._failure_from_exception(exc)) from exc

        workspace_names = {
            _normalise_path(row["path"]): _workspace_name(dict(row))
            for row in workspace_rows
            if _normalise_path(row["path"])
        }
        sessions: list[WorkBuddySession] = []
        for row in session_rows:
            work_dir = str(row["cwd"] or "")
            normalized = _normalise_path(work_dir)
            is_space = normalized in workspace_names
            sessions.append(
                WorkBuddySession(
                    session_id=str(row["id"] or ""),
                    title=str(row["custom_title"] or row["title"] or ""),
                    work_dir=work_dir,
                    created_at=_ms_to_seconds(row["created_at"]),
                    last_activity_at=_ms_to_seconds(row["last_activity_at"]),
                    deleted=row["deleted_at"] is not None,
                    group_type="space" if is_space else "task",
                    space_name=(
                        workspace_names[normalized] if is_space else _directory_name(work_dir)
                    ),
                )
            )
        return sessions

    def list_workspaces(self, *, limit: int = 1000) -> list[dict[str, Any]]:
        """Return raw workspace fields for legacy CLI compatibility wrappers."""
        self._require_ready()
        if limit < 1:
            return []
        try:
            with closing(self._connect_readonly()) as connection:
                rows = connection.execute(
                    "SELECT * FROM workspaces ORDER BY last_opened_at DESC LIMIT ?", (limit,)
                ).fetchall()
            return [dict(row) for row in rows]
        except BaseException as exc:
            raise WorkBuddyDataError(self._failure_from_exception(exc)) from exc

    def read_transcript(self, session_id: str) -> TranscriptReadResult:
        """Read a transcript found by the stable session id, never by cwd encoding."""
        ready = self.probe()
        if ready.failure is not None:
            return TranscriptReadResult(failure=ready.failure)
        if not isinstance(session_id, str) or not session_id:
            return TranscriptReadResult(
                failure=AdapterFailure("transcript_not_found", "session id is missing")
            )
        index, root, fresh_parent_fds, failure = self._ensure_transcript_index(session_id)
        if failure is not None:
            return TranscriptReadResult(failure=failure)
        matches = index.get(session_id, ())
        if not matches:
            self._close_descriptors(fresh_parent_fds.values())
            return TranscriptReadResult(
                failure=AdapterFailure("transcript_not_found", "no transcript matches session id")
            )
        if len(matches) > 1:
            self._close_descriptors(fresh_parent_fds.values())
            return TranscriptReadResult(
                failure=AdapterFailure(
                    "transcript_ambiguous", "multiple transcripts match the same session id"
                )
            )
        assert root is not None
        candidate = matches[0]
        fresh_parent_fd = fresh_parent_fds.pop(candidate, None)
        self._close_descriptors(fresh_parent_fds.values())
        data, read_failure = self._read_indexed_candidate(candidate, fresh_parent_fd)
        if read_failure is not None:
            return TranscriptReadResult(failure=read_failure)
        session_ids, metadata_failure = self._session_ids_from_jsonl(data)
        if metadata_failure is not None:
            return TranscriptReadResult(failure=metadata_failure)
        if session_ids != frozenset({session_id}):
            return TranscriptReadResult(
                failure=AdapterFailure(
                    "transcript_index_incomplete",
                    "transcript session metadata changed after indexing",
                )
            )
        return TranscriptReadResult(content=data.decode("utf-8"))

    def transcript_path_for_session(self, session_id: str) -> Path | None:
        """Deprecated compatibility API; verified transcripts expose content, never paths."""
        self.read_transcript(session_id)
        return None

    def detect_active_session(self) -> ActiveSessionResult:
        """Refuse to label the most recently active session as the active one."""
        ready = self.probe()
        if ready.failure is not None:
            return ActiveSessionResult(failure=ready.failure)
        return ActiveSessionResult(
            failure=AdapterFailure(
                "unknown_active_session", "no reliable WorkBuddy active-session signal is available"
            )
        )

    def close(self) -> None:
        """Release the inode-pinned projects descriptor held by a built index."""
        if self._transcript_root_fd is not None:
            os.close(self._transcript_root_fd)
            self._transcript_root_fd = None

    def __del__(self) -> None:
        try:
            self.close()
        except BaseException:
            pass

    def _ensure_transcript_index(
        self, requested_session_id: str,
    ) -> tuple[
        dict[str, tuple[_TranscriptCandidate, ...]],
        Path | None,
        dict[_TranscriptCandidate, int],
        AdapterFailure | None,
    ]:
        """Build one bounded metadata index without retaining transcript bodies."""
        if self._transcript_index is not None or self._transcript_index_failure is not None:
            return (
                self._transcript_index or {},
                self._transcript_root,
                {},
                self._transcript_index_failure,
            )
        root, root_stat, root_failure = self._projects_root()
        if root_failure is not None:
            self._transcript_index_failure = root_failure
            return {}, None, {}, root_failure
        if root is None:
            self._transcript_index = {}
            return {}, None, {}, None

        assert root_stat is not None
        root_fd, _opened_root_stat, open_failure = self._open_projects_root_descriptor(
            root, root_stat
        )
        if open_failure is not None:
            return self._set_index_failure(open_failure.code, open_failure.message)
        assert root_fd is not None

        index: dict[str, list[_TranscriptCandidate]] = {}
        fresh_parent_fds: dict[_TranscriptCandidate, int] = {}
        candidates = 0
        keep_root_fd = False
        try:
            candidates, scan_failure = self._scan_index_directory(
                root_fd,
                Path(),
                index,
                candidates,
                requested_session_id,
                fresh_parent_fds,
            )
            if scan_failure is not None:
                self._close_descriptors(fresh_parent_fds.values())
                return self._set_index_failure(scan_failure.code, scan_failure.message)
            keep_root_fd = True
        except BaseException as exc:
            self._close_descriptors(fresh_parent_fds.values())
            failure = self._failure_from_exception(exc)
            return self._set_index_failure(failure.code, failure.message)
        finally:
            if not keep_root_fd:
                os.close(root_fd)

        self._transcript_root = root
        self._transcript_root_fd = root_fd
        self._transcript_index = {
            session_id: tuple(
                sorted(paths, key=lambda candidate: candidate.relative_path.as_posix())
            )
            for session_id, paths in index.items()
        }
        return self._transcript_index, root, fresh_parent_fds, None

    def _set_index_failure(
        self, code: str, message: str
    ) -> tuple[
        dict[str, tuple[_TranscriptCandidate, ...]],
        None,
        dict[_TranscriptCandidate, int],
        AdapterFailure,
    ]:
        failure = AdapterFailure(code, message)
        self._transcript_index_failure = failure
        return {}, None, {}, failure

    def _projects_root(
        self,
    ) -> tuple[Path | None, os.stat_result | None, AdapterFailure | None]:
        """Return a real, non-symlink projects directory without path escape."""
        try:
            opened_stat = self.projects_dir.lstat()
            if stat.S_ISLNK(opened_stat.st_mode):
                return None, None, AdapterFailure(
                    "temporarily_unavailable", "projects directory must not be a symlink"
                )
            if not stat.S_ISDIR(opened_stat.st_mode):
                return None, None, None
            return self.projects_dir.resolve(strict=True), opened_stat, None
        except BaseException as exc:
            return None, None, self._failure_from_exception(exc)

    @staticmethod
    def _descriptor_support_failure() -> AdapterFailure | None:
        if not DESCRIPTOR_TRAVERSAL_SUPPORTED:
            return AdapterFailure(
                "transcript_index_incomplete", "safe descriptor traversal is unavailable"
            )
        return None

    def _open_projects_root_descriptor(
        self, root: Path, expected: os.stat_result
    ) -> tuple[int | None, os.stat_result | None, AdapterFailure | None]:
        support_failure = self._descriptor_support_failure()
        if support_failure is not None:
            return None, None, support_failure
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd: int | None = None
        keep_fd = False
        try:
            fd = os.open(root, flags)
            opened = os.fstat(fd)
            if not stat.S_ISDIR(opened.st_mode) or not os.path.samestat(opened, expected):
                return None, None, AdapterFailure(
                    "transcript_index_incomplete", "projects root changed while opening"
                )
            keep_fd = True
            return fd, opened, None
        except BaseException as exc:
            return None, None, self._failure_from_exception(exc)
        finally:
            if fd is not None and not keep_fd:
                os.close(fd)

    def _scan_index_directory(
        self,
        directory_fd: int,
        relative_directory: Path,
        index: dict[str, list[_TranscriptCandidate]],
        candidates: int,
        requested_session_id: str,
        fresh_parent_fds: dict[_TranscriptCandidate, int],
    ) -> tuple[int, AdapterFailure | None]:
        try:
            names = sorted(os.listdir(directory_fd))
        except BaseException as exc:
            return candidates, self._failure_from_exception(exc)
        for name in names:
            try:
                entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                return candidates, AdapterFailure(
                    "transcript_index_incomplete", "transcript changed while indexing"
                )
            except BaseException as exc:
                return candidates, self._failure_from_exception(exc)
            if stat.S_ISLNK(entry.st_mode):
                continue
            if stat.S_ISDIR(entry.st_mode):
                child_fd, child_failure = self._open_child_directory(directory_fd, name, entry)
                if child_failure is not None:
                    return candidates, child_failure
                assert child_fd is not None
                try:
                    candidates, scan_failure = self._scan_index_directory(
                        child_fd,
                        relative_directory / name,
                        index,
                        candidates,
                        requested_session_id,
                        fresh_parent_fds,
                    )
                finally:
                    os.close(child_fd)
                if scan_failure is not None:
                    return candidates, scan_failure
                continue
            if not stat.S_ISREG(entry.st_mode) or not name.lower().endswith(".jsonl"):
                continue
            candidates += 1
            if candidates > self.max_transcript_candidates:
                return candidates, AdapterFailure(
                    "transcript_index_incomplete", "transcript candidate limit exceeded"
                )
            data, opened, read_failure = self._read_file_at(
                directory_fd, name, self.max_transcript_bytes, entry
            )
            if read_failure is not None:
                return candidates, read_failure
            assert opened is not None
            session_ids, metadata_failure = self._session_ids_from_jsonl(data)
            if metadata_failure is not None:
                return candidates, metadata_failure
            candidate = _TranscriptCandidate(
                relative_path=relative_directory / name,
                device=opened.st_dev,
                inode=opened.st_ino,
            )
            if requested_session_id in session_ids:
                existing_matches = index.get(requested_session_id, ())
                if not existing_matches:
                    fresh_parent_fds[candidate] = os.dup(directory_fd)
                else:
                    self._close_descriptors(fresh_parent_fds.values())
                    fresh_parent_fds.clear()
            for found_session_id in session_ids:
                index.setdefault(found_session_id, []).append(candidate)
        return candidates, None

    def _read_indexed_candidate(
        self,
        candidate: _TranscriptCandidate,
        fresh_parent_fd: int | None,
    ) -> tuple[bytes, AdapterFailure | None]:
        """Reopen one indexed file through pinned descriptors and verify its inode."""
        parent_fd = fresh_parent_fd
        if parent_fd is None:
            parent_fd, open_failure = self._open_indexed_candidate_parent(candidate)
            if open_failure is not None:
                return b"", open_failure
        assert parent_fd is not None
        try:
            data, _opened, read_failure = self._read_file_at(
                parent_fd,
                candidate.relative_path.name,
                self.max_transcript_bytes,
                candidate,
            )
            return data, read_failure
        finally:
            os.close(parent_fd)

    def _open_indexed_candidate_parent(
        self, candidate: _TranscriptCandidate
    ) -> tuple[int | None, AdapterFailure | None]:
        if self._transcript_root_fd is None:
            return None, AdapterFailure(
                "transcript_index_incomplete", "transcript index root is unavailable"
            )
        try:
            directory_fd = os.dup(self._transcript_root_fd)
        except BaseException as exc:
            return None, self._failure_from_exception(exc)
        keep_fd = False
        try:
            for part in candidate.relative_path.parent.parts:
                try:
                    entry = os.stat(part, dir_fd=directory_fd, follow_symlinks=False)
                except BaseException as exc:
                    return None, self._failure_from_exception(exc)
                if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode):
                    return None, AdapterFailure(
                        "transcript_index_incomplete",
                        "transcript directory changed after indexing",
                    )
                child_fd, child_failure = self._open_child_directory(
                    directory_fd, part, entry
                )
                if child_failure is not None:
                    return None, child_failure
                assert child_fd is not None
                os.close(directory_fd)
                directory_fd = child_fd
            keep_fd = True
            return directory_fd, None
        finally:
            if not keep_fd:
                os.close(directory_fd)

    @staticmethod
    def _close_descriptors(descriptors: Any) -> None:
        for descriptor in descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def _open_child_directory(
        self, directory_fd: int, name: str, expected: os.stat_result
    ) -> tuple[int | None, AdapterFailure | None]:
        fd: int | None = None
        keep_fd = False
        try:
            fd = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd
            )
            opened = os.fstat(fd)
            if not stat.S_ISDIR(opened.st_mode) or not os.path.samestat(opened, expected):
                return None, AdapterFailure(
                    "transcript_index_incomplete", "transcript directory changed while indexing"
                )
            keep_fd = True
            return fd, None
        except BaseException as exc:
            return None, self._failure_from_exception(exc)
        finally:
            if fd is not None and not keep_fd:
                os.close(fd)

    def _read_file_at(
        self,
        directory_fd: int,
        name: str,
        max_bytes: int,
        expected: os.stat_result | _TranscriptCandidate,
    ) -> tuple[bytes, os.stat_result | None, AdapterFailure | None]:
        if max_bytes < 1:
            return b"", None, AdapterFailure(
                "transcript_index_incomplete", "transcript byte limit exceeded"
            )
        fd: int | None = None
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode):
                return b"", None, AdapterFailure(
                    "transcript_index_incomplete", "transcript is not a regular file"
                )
            expected_device = expected.st_dev if isinstance(expected, os.stat_result) else expected.device
            expected_inode = expected.st_ino if isinstance(expected, os.stat_result) else expected.inode
            if opened.st_dev != expected_device or opened.st_ino != expected_inode:
                return b"", None, AdapterFailure(
                    "transcript_index_incomplete", "transcript changed while indexing"
                )
            with os.fdopen(fd, "rb", closefd=True) as handle:
                fd = None
                data = handle.read(max_bytes + 1)
        except BaseException as exc:
            return b"", None, self._failure_from_exception(exc)
        finally:
            if fd is not None:
                os.close(fd)
        if len(data) > max_bytes:
            return b"", None, AdapterFailure(
                "transcript_index_incomplete", "transcript byte limit exceeded"
            )
        return data, opened, None


    @staticmethod
    def _session_ids_from_jsonl(
        data: bytes,
    ) -> tuple[frozenset[str], AdapterFailure | None]:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return frozenset(), AdapterFailure(
                "transcript_index_incomplete", "transcript JSONL is not valid UTF-8"
            )
        session_ids: set[str] = set()
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                return frozenset(), AdapterFailure(
                    "transcript_index_incomplete", "transcript JSONL is malformed"
                )
            if not isinstance(item, dict):
                continue
            values = [item[key] for key in ("session_id", "sessionId") if key in item]
            if not values:
                continue
            if any(not isinstance(value, str) or not value for value in values):
                return frozenset(), AdapterFailure(
                    "transcript_index_incomplete", "transcript session metadata is invalid"
                )
            if len(set(values)) != 1:
                return frozenset(), AdapterFailure(
                    "transcript_index_incomplete", "transcript session metadata conflicts"
                )
            session_ids.add(values[0])
        if len(session_ids) > 1:
            return frozenset(), AdapterFailure(
                "transcript_index_incomplete", "transcript contains multiple session ids"
            )
        return frozenset(session_ids), None

    def _connect_readonly(self) -> sqlite3.Connection:
        uri = self.database_path.resolve().as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=0)
        connection.row_factory = sqlite3.Row
        return connection

    def _require_ready(self) -> None:
        result = self.probe()
        if result.failure is not None:
            raise WorkBuddyDataError(result.failure)

    def _probe_failure(self, code: str, message: str) -> ProbeResult:
        return ProbeResult(
            config_dir=self.config_dir,
            database_path=self.database_path,
            failure=AdapterFailure(code, message),
        )

    def _probe_from_exception(self, exc: BaseException) -> ProbeResult:
        failure = self._failure_from_exception(exc)
        return self._probe_failure(failure.code, failure.message)

    @staticmethod
    def _failure_from_exception(exc: BaseException) -> AdapterFailure:
        if isinstance(exc, FileNotFoundError):
            return AdapterFailure("not_installed", "WorkBuddy local files are missing")
        if isinstance(exc, PermissionError):
            return AdapterFailure("permission_denied", "WorkBuddy local files cannot be read")
        message = str(exc).lower()
        if isinstance(exc, sqlite3.Error):
            if "no such table" in message or "no such column" in message:
                return AdapterFailure("schema_mismatch", "WorkBuddy database schema is unsupported")
            if "locked" in message or "busy" in message:
                return AdapterFailure("busy", "WorkBuddy database is temporarily busy")
            if "not a database" in message or "malformed" in message or "corrupt" in message:
                return AdapterFailure("corrupt", "WorkBuddy database is corrupt")
            if "unable to open" in message or "readonly database" in message:
                return AdapterFailure(
                    "temporarily_unavailable", "WorkBuddy database is temporarily unavailable"
                )
        return AdapterFailure("temporarily_unavailable", "WorkBuddy local data is unavailable")
