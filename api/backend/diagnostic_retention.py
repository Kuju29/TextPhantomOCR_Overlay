"""Small, process-safe disk budgets for opt-in diagnostic files.

Locks use the operating system, not PID existence: crashed processes release
their leases automatically, and PID reuse cannot make an old file look live.
This module never reads or records application content.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
import stat
from pathlib import Path
import time
from typing import Callable, Iterator
import uuid

DEFAULT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_KEEP_DAYS = 7
DEFAULT_MAX_ACTIVE = 256
DEFAULT_MAX_FILES = 32768
ALLOCATION_UNIT = 4096
_RESCAN_SECONDS = 60


def positive_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name) or default)
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


def charge(size: int) -> int:
    """Include the allocation overhead of tiny files in the diagnostic budget."""
    return ((max(1, size) + ALLOCATION_UNIT - 1) // ALLOCATION_UNIT) * ALLOCATION_UNIT


def metadata_usage(root: Path, category: str) -> tuple[int, int]:
    # Root, shared lock, counter, and one atomic counter-write temporary are
    # reserved even before creation; these costs cannot escape the byte budget.
    mandatory = {f"_{category}-retention.lock", f"_{category}-retention.json"}
    total, count = 4 * ALLOCATION_UNIT, 4
    for item in root.glob(f"_{category}-*"):
        if item.name in mandatory:
            continue
        total += charge(item.lstat().st_size)
        count += 1
    return total, count


def _lock_handle(handle, *, blocking: bool) -> bool:
    deadline = time.monotonic() + (2 if blocking else 0)
    while True:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            if not blocking or time.monotonic() >= deadline:
                return False
            time.sleep(.005)


def _unlock(handle) -> None:
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def _open_lock(path: Path, *, blocking: bool):
    if path.is_symlink():
        raise OSError("diagnostic lock must be a regular file")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    handle = os.fdopen(descriptor, "r+b", buffering=0)
    try:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"0")
        if not _lock_handle(handle, blocking=blocking):
            handle.close()
            return None
        return handle
    except BaseException:
        handle.close()
        raise


@contextmanager
def guard(root: Path, category: str) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise OSError("diagnostic root must not be a symbolic link")
    handle = _open_lock(root / f"_{category}-retention.lock", blocking=True)
    if handle is None:
        raise OSError("diagnostic retention lock unavailable")
    try:
        yield
    finally:
        _unlock(handle)


def _target_hash(target: Path) -> str:
    return hashlib.sha256(target.name.encode("utf-8")).hexdigest()[:24]


@dataclass
class Lease:
    path: Path
    handle: object


def retain(root: Path, category: str, target: Path) -> Lease:
    """Caller holds the category guard, closing the create/prune race."""
    path = root / f"_{category}-active-{_target_hash(target)}-{uuid.uuid4().hex}.lock"
    handle = _open_lock(path, blocking=True)
    if handle is None:
        raise OSError("diagnostic lease unavailable")
    return Lease(path, handle)


def release(lease: Lease | None) -> None:
    if lease is None:
        return
    try:
        _unlock(lease.handle)
    except OSError:
        pass
    try:
        lease.path.unlink()
    except OSError:
        pass


def active(root: Path, category: str, target: Path) -> bool:
    """Caller holds the guard; live leases survive across worker processes."""
    for path in root.glob(f"_{category}-active-{_target_hash(target)}-*.lock"):
        if path.is_symlink():
            # An unexpected object is not evidence that deletion is safe.
            return True
        handle = _open_lock(path, blocking=False)
        if handle is None:
            return True
        _unlock(handle)
        try:
            path.unlink()  # A dead owner left this unique lease behind.
        except OSError:
            return True
    return False


def active_count(root: Path, category: str) -> int:
    """Global lease count; crashed workers cannot leave permanent reservations."""
    count = 0
    for path in root.glob(f"_{category}-active-*.lock"):
        if path.is_symlink():
            count += 1
            continue
        handle = _open_lock(path, blocking=False)
        if handle is None:
            count += 1
            continue
        _unlock(handle)
        try:
            path.unlink()
        except OSError:
            count += 1
    return count


def usage(root: Path, category: str, scan: Callable[[], tuple[int, int]], *, refresh: bool = False) -> tuple[int, int]:
    """Read a shared byte counter; reconcile operator changes every minute."""
    state = root / f"_{category}-retention.json"
    if not refresh and not state.is_symlink():
        try:
            value = json.loads(state.read_text(encoding="utf-8"))
            if (value.get("schema") == 1 and type(value.get("bytes")) is int
                    and value["bytes"] >= 0
                    and type(value.get("files")) is int and value["files"] >= 0
                    and type(value.get("checkedAt")) in (int, float)
                    and 0 <= time.time() - value["checkedAt"] < _RESCAN_SECONDS):
                return value["bytes"], value["files"]
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    total, files = scan()
    store_usage(root, category, total, files, checked_at=time.time())
    return total, files


def store_usage(root: Path, category: str, total: int, files: int, *, checked_at: float | None = None) -> None:
    state = root / f"_{category}-retention.json"
    previous_checked = checked_at
    if previous_checked is None:
        try:
            if state.is_symlink():
                raise OSError("diagnostic state must not be a symbolic link")
            previous_checked = json.loads(state.read_text(encoding="utf-8"))["checkedAt"]
        except (OSError, ValueError, TypeError, KeyError):
            previous_checked = time.time()
    temporary = root / f"_{category}-retention-{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump({"schema": 1, "bytes": max(0, total), "files": max(0, files), "checkedAt": previous_checked}, handle)
        try:
            os.replace(temporary, state)
        except PermissionError as exc:
            # Windows readers commonly omit FILE_SHARE_DELETE: rename fails
            # while an ordinary write to the same file remains possible. This
            # rebuildable counter is protected by the category OS/thread lock.
            if getattr(exc, "winerror", None) not in {5, 32, 33}:
                raise
            for attempt in range(2):
                time.sleep(0.01 * (attempt + 1))
                try:
                    os.replace(temporary, state)
                    break
                except PermissionError as retry:
                    if getattr(retry, "winerror", None) not in {5, 32, 33}:
                        raise
            else:
                before = state.lstat()
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise OSError("diagnostic counter must be a regular single-link file")
                fd = os.open(state, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "wb") as handle:
                    opened, current = os.fstat(handle.fileno()), state.lstat()
                    if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                            or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
                        raise OSError("diagnostic counter changed during recovery")
                    handle.write(temporary.read_bytes())
                    handle.truncate()
                    handle.flush()
                    os.fsync(handle.fileno())
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
