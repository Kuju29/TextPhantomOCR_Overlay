"""One file, one story: every function an image passes through, both sides.

Compact tracing uses ``TP_TRACE=1``; full function tracing uses
``TP_TRACE=full``.

Why this is separate from ``logfile.py``
---------------------------------------
``logfile.py`` records what the system decided. This records what it DID —
every function entered, what it was handed, what it gave back. They are
different jobs and mixing them would ruin both: a decision log full of function
entries is unreadable, and a call trace filtered down to decisions cannot
answer "which function did this value come from".

It exists because of a specific failure. The extension shipped a client-side
renderer, every test passed, the pages looked right, and it had refused to run
on 100% of images since the day it landed. The only evidence was one WARN line
in a console nobody was watching, and the assistant reading the code — twice —
concluded it was working. A trace of the actual path would have answered that
in one grep on day one.

Three rules
-----------
1. **File only.** Nothing here reaches stdout or the browser console. A trace
   that also spams the console gets turned off, and then it is not a trace.
2. **One file, both sides.** The extension cannot write files, so it ships its
   lines to ``POST /v1/trace`` and they land in the SAME file, interleaved by
   the trace id. Two files would mean reconstructing the order by hand, which
   is the thing this is supposed to remove.
3. **Off by default, and cheap when off.** ``enabled()`` is one boolean read.
   When it is false, no formatting happens, no folder is created, nothing is
   allocated.

Format
------
JSON Lines. One object per call:

    {"at": "...", "side": "api", "trace": "t7f3a1", "seq": 12,
     "file": "jobs/pipeline.py", "fn": "process_image", "ev": "->",
     "d": {"mode": "lens_text", "source": "ai"}}

``ev`` is ``->`` (entered), ``<-`` (returned), ``!!`` (raised) or ``..`` (a
note placed by hand at a decision point). ``trace`` ties one image's whole
journey together across both sides; ``seq`` orders it within one process.
"""

from __future__ import annotations

import atexit
import functools
import inspect
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, TypeVar

_TZ = timezone(timedelta(hours=7))

_explicit_trace = os.environ.get("TP_TRACE")
if _explicit_trace is None:
    _profile = (os.environ.get("TP_DIAGNOSTICS", "normal") or "normal").strip().lower()
    _RAW_MODE = "full" if _profile in ("deep", "full") else "1" if _profile in ("activity", "summary", "1") else "0"
else:
    # Existing deployments keep exact TP_TRACE behaviour. In particular an
    # explicit TP_TRACE=0 disables tracing even under a diagnostics profile.
    _RAW_MODE = (_explicit_trace or "0").strip().lower()
_MODE = (
    "full" if _RAW_MODE in ("full", "verbose", "functions")
    else "compact" if _RAW_MODE in ("1", "true", "on", "yes", "compact")
    else "off"
)
_ENABLED = _MODE != "off"
_ROOT = Path(os.environ.get("TP_TRACE_DIR") or os.environ.get("TP_LOG_DIR") or
             (Path(__file__).resolve().parents[1] / "logs"))
_RAW_NAME = str(os.environ.get("TP_TRACE_FILE") or "trace").replace("\\", "/")
# Prefix only, never a path.  Apart from preventing accidental writes outside
# TP_TRACE_DIR this keeps generated names valid on Windows even when an env
# file contains punctuation copied from a label.
_NAME = re.sub(r"[^A-Za-z0-9._-]+", "_", _RAW_NAME.rsplit("/", 1)[-1]).strip(" .") or "trace"
_NAME = _NAME[:80]
_NAMING = (os.environ.get("TP_TRACE_NAMING") or "session").strip().lower()
if _NAMING not in ("session", "daily"):
    _NAMING = "session"

# A session is one API process lifetime.  The old daily filename made every
# restart reset `seq` to one while appending to yesterday's story, so a day of
# repeated testing looked like one internally contradictory run.  Colons are
# deliberately absent: these files are most often produced and opened on
# Windows.
_SESSION_STARTED = datetime.now(_TZ)
_SESSION_STAMP = _SESSION_STARTED.strftime("%Y%m%d-%H%M%S")
_session_path: Path | None = None
_session_id = _SESSION_STAMP
_session_build = ""
_header_paths: set[Path] = set()
_active_day = _SESSION_STARTED.strftime("%Y%m%d")
_PATH_LOCK = threading.Lock()

try:
    _KEEP_DAYS = max(0, int(os.environ.get("TP_TRACE_KEEP_DAYS") or "0"))
except (TypeError, ValueError):
    _KEEP_DAYS = 0

# A trace line is a debugging aid, not a data export: long values are cut hard.
# The first characters are what identify a value; the rest is what makes the
# file unreadable.
_MAX_STR = 200
_MAX_ITEMS = 12
# Dicts get a bigger allowance than lists. A flat metrics dict — `perf`, with
# one key per pipeline stage — is exactly the thing a reader came for, and
# cutting it at twelve hid `ai_ms` behind "+25 more keys" in the one line that
# was supposed to answer where the time went.
_MAX_DICT_ITEMS = 48

# Anything whose name looks like a credential is replaced, never truncated.
# A trace file gets pasted into chat windows and issue trackers.
_SECRET_HINTS = ("api_key", "apikey", "key", "token", "secret", "password", "cookie", "auth")
_PRIVATE_CONTENT_NAMES = {
    "ai_text", "body", "character_sheet", "content", "input", "memo",
    "messages", "original_text_full", "paragraphs", "prev_context", "prompt",
    "prompt_editable", "prompt_override", "raw", "series_state", "source_text",
    "speakers", "system_dynamic", "system_static", "system_text", "text",
    "translated_text", "user_parts",
}
_PUBLIC_PROMPT_METADATA = {
    "prompthash", "promptversion", "promptchars", "promptsource",
    "systemprompthash", "systempromptchars",
}
_SECRET_QUERY_RE = re.compile(
    r"([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|"
    r"password|secret|signature|sig|policy|key-pair-id|x-amz-[^=&#\s]+|"
    r"x-goog-[^=&#\s]+)=)([^&#\s]+)",
    re.IGNORECASE,
)
_SECRET_ASSIGN_RE = re.compile(
    r"\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|authorization|cookie)"
    r"(\s*[:=]\s*)([^\s,;&]+)",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]{6,}", re.IGNORECASE)
_AUTH_FIELD_RE = re.compile(
    r"\b((?:proxy-)?authorization)(\s*:\s*)[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*",
    re.IGNORECASE,
)
_COOKIE_FIELD_RE = re.compile(
    r"\b((?:set-)?cookie)(\s*:\s*)[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*",
    re.IGNORECASE,
)
_KNOWN_TOKEN_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,})\b"
)
_URL_USERINFO_RE = re.compile(r"\b(https?://)[^/@\s:]+:[^/@\s]+@", re.IGNORECASE)

_LOCK = threading.Lock()
_seq = 0
_local = threading.local()

# --- Buffered writing --------------------------------------------------------
# The first version did mkdir + open + write + flush on EVERY line, under one
# global lock. On Linux that is 0.045 ms and invisible. On the user's Windows
# machine it measured 2.8 ms — sixty times worse — and it did not merely slow
# the server down, it moved the measurement: `read_varint` showed a self-time
# of 0.0 s across 64,464 calls while its caller `parse` showed 17.4 ms per
# call, because a child's "entered" line is written on the PARENT's clock. The
# trace was reporting its own cost as the parser's, and nearly sent the fix to
# the wrong file.
#
# So: one file handle, opened once. Lines buffer in memory and go out in
# batches. `flush()` is called when a request finishes and at process exit, so
# the file is complete for anything short of a hard kill — and a hard kill was
# never going to leave a clean file anyway.
_BUFFER_LINES = 512
_MAX_PENDING_LINES = 8192
_FLUSH_AFTER_SEC = 1.0
# Keep the destination beside every pending line. In daily mode midnight may
# pass while a disk error is being retried; a plain string buffer would then
# write yesterday's tail into today's file.
_buffer: list[tuple[Path, str, bool]] = []
_buffer_dropped = 0
_handle = None
_handle_path: Path | None = None
# Started at import, not at zero: from zero the very first line is already
# "overdue" by the whole uptime of the machine and drains on its own, which
# looks like buffering that does not work.
_last_flush = time.monotonic()


def enabled() -> bool:
    return _ENABLED


def mode() -> str:
    """Configured detail level: ``off``, ``compact`` or ``full``."""
    return _MODE


def full_enabled() -> bool:
    """Whether automatic function entry/return wrapping is requested."""
    return _MODE == "full"


def _allocate_session_path() -> Path:
    """Reserve one collision-safe filename for this API process."""
    global _session_path, _session_id
    if _session_path is not None:
        return _session_path
    with _PATH_LOCK:
        if _session_path is not None:
            return _session_path
        try:
            _ROOT.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Keep tracing best-effort. `_open()` will fail silently as it did
            # before, but a read-only log directory must never stop the API.
            _session_path = _ROOT / f"{_NAME}-{_SESSION_STAMP}.jsonl"
            return _session_path
        for number in range(1, 10_000):
            suffix = "" if number == 1 else f"-{number:02d}"
            candidate = _ROOT / f"{_NAME}-{_SESSION_STAMP}{suffix}.jsonl"
            try:
                # Reserve atomically.  Two starts in the same second must not
                # discover the same free name and then both append to it.
                fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                _session_path = candidate
                _session_id = f"{_SESSION_STAMP}{suffix}"
                return candidate
            except FileExistsError:
                continue
            except OSError:
                _session_path = candidate
                return candidate
        # Impossibly many same-second starts: keep the API alive and let the
        # normal append/open error handling decide whether a line can be kept.
        _session_path = _ROOT / f"{_NAME}-{_SESSION_STAMP}-{os.getpid()}.jsonl"
        _session_id = f"{_SESSION_STAMP}-{os.getpid()}"
        return _session_path


def path() -> Path:
    if _NAMING == "daily":
        return _ROOT / f"{_NAME}-{datetime.now(_TZ).strftime('%Y%m%d')}.jsonl"
    return _allocate_session_path()


def session_id() -> str:
    global _active_day, _session_id
    if _NAMING == "daily":
        day = datetime.now(_TZ).strftime("%Y%m%d")
        if day != _active_day:
            with _PATH_LOCK:
                if day != _active_day:
                    _active_day = day
                    # The process is the same but the destination changed.
                    # A distinct handshake prevents a browser batch created
                    # before midnight from entering the new day's file.
                    _session_id = f"{_SESSION_STAMP}-d{day}"
    if _ENABLED and _NAMING == "session":
        path()  # allocate the collision suffix before returning the id
    return _session_id


def started_at() -> str:
    return _SESSION_STARTED.isoformat(timespec="seconds")


def file_name() -> str:
    return path().name if _ENABLED else ""


def _write_latest_pointer(target: Path) -> None:
    """Atomically point humans at the active file; never affects tracing."""
    try:
        _ROOT.mkdir(parents=True, exist_ok=True)
        temporary = _ROOT / f"trace-latest-{os.getpid()}.tmp"
        temporary.write_text(target.name + "\n", encoding="utf-8")
        os.replace(temporary, _ROOT / "trace-latest.txt")
    except Exception:  # noqa: BLE001 - a convenience pointer cannot break work
        pass


def _apply_retention(current: Path) -> int:
    """Delete old trace files only when the operator explicitly opted in."""
    if _KEEP_DAYS <= 0:
        return 0
    removed = 0
    cutoff = time.time() - (_KEEP_DAYS * 24 * 60 * 60)
    previous_latest: Path | None = None
    try:
        latest_name = (_ROOT / "trace-latest.txt").read_text(encoding="utf-8").strip()
        if latest_name:
            previous_latest = _ROOT / latest_name.replace("\\", "/").rsplit("/", 1)[-1]
    except OSError:
        previous_latest = None
    try:
        for candidate in _ROOT.glob(f"{_NAME}-*.jsonl"):
            try:
                if (
                    candidate == current
                    or candidate == previous_latest
                    or candidate.is_symlink()
                    or not candidate.is_file()
                ):
                    continue
                if candidate.stat().st_mtime >= cutoff:
                    continue
                candidate.unlink()
                removed += 1
            except OSError:
                continue
    except OSError:
        return removed
    return removed


def _session_header(target: Path, retention_deleted: int = 0) -> dict[str, Any]:
    global _seq
    _seq += 1
    return {
        "at": datetime.now(_TZ).isoformat(timespec="milliseconds"),
        "side": "api",
        "session": session_id(),
        "trace": "",
        "seq": _seq,
        "file": "trace.py",
        "fn": "session_start",
        "ev": "..",
        "d": _short({
            "startedAt": started_at(),
            "fileStartedAt": datetime.now(_TZ).isoformat(timespec="seconds"),
            "mode": _MODE,
            "build": _session_build,
            "pid": os.getpid(),
            "file": target.name,
            "naming": _NAMING,
            "retentionDays": _KEEP_DAYS,
            "retentionDeleted": retention_deleted,
        }),
    }


def _queue_locked(target: Path, text: str, *, header: bool = False) -> None:
    """Add one pending line while bounding memory under a broken trace sink."""
    global _buffer_dropped
    if len(_buffer) >= _MAX_PENDING_LINES:
        # Preserve session headers: after disk recovery every file must still
        # begin with its identity. Discard the oldest ordinary record instead.
        drop_at = next((i for i, item in enumerate(_buffer) if not item[2]), None)
        if drop_at is None:
            _buffer_dropped += 1
            return
        del _buffer[drop_at]
        _buffer_dropped += 1
    _buffer.append((target, text, header))


def _ensure_session_header() -> Path | None:
    """Make the current file self-describing before any ordinary record."""
    if not _ENABLED:
        return None
    try:
        target = path()
        with _LOCK:
            if target in _header_paths:
                return target
            deleted = _apply_retention(target)
            _write_latest_pointer(target)
            _queue_locked(
                target,
                json.dumps(_session_header(target, deleted), ensure_ascii=False) + "\n",
                header=True,
            )
            _header_paths.add(target)
            _drain_locked()
        return target
    except Exception:  # noqa: BLE001 - a trace sink never blocks API startup
        return None


def start_session(build: str = "") -> None:
    """Write one self-describing first record for this API process."""
    global _session_build
    if not _ENABLED:
        return
    _session_build = str(build or "")
    _ensure_session_header()


# --- the current trace id ----------------------------------------------------
# Thread-local: the pipeline hands one image to a worker thread and the AI layer
# to another, and both must stamp the same id. `set_trace` returns the previous
# value so a caller can restore it, which is what makes nesting safe.


def set_trace(trace_id: str) -> str:
    previous = getattr(_local, "trace", "")
    _local.trace = str(trace_id or "")
    return previous


def current_trace() -> str:
    return getattr(_local, "trace", "")


class scope:
    """``with trace.scope(id):`` — stamp every line in this block."""

    __slots__ = ("_id", "_previous")

    def __init__(self, trace_id: str) -> None:
        self._id = trace_id
        self._previous = ""

    def __enter__(self) -> "scope":
        self._previous = set_trace(self._id)
        return self

    def __exit__(self, *_exc) -> bool:
        set_trace(self._previous)
        return False


def inherit(trace_id: str) -> Callable[[Callable], Callable]:
    """Give a function submitted to another thread the caller's trace id."""

    def wrap(fn):
        @functools.wraps(fn)
        def run(*args, **kwargs):
            with scope(trace_id):
                return fn(*args, **kwargs)

        return run

    return wrap


# --- value shortening --------------------------------------------------------


def _sanitize_string(value: str) -> str:
    """Remove credentials embedded in otherwise ordinary trace strings."""
    text = str(value)
    text = _URL_USERINFO_RE.sub(r"\1<redacted>@", text)
    text = _SECRET_QUERY_RE.sub(lambda m: f"{m.group(1)}<redacted>", text)
    # Error strings often embed raw request headers. Redact the complete value,
    # including multi-token schemes (Basic/Digest/Negotiate), and all cookies.
    text = _AUTH_FIELD_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted>", text)
    text = _COOKIE_FIELD_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted>", text)
    text = _BEARER_RE.sub("Bearer <redacted>", text)
    text = _KNOWN_TOKEN_RE.sub("<redacted>", text)
    text = _SECRET_ASSIGN_RE.sub(
        lambda m: f"{m.group(1)}{m.group(2)}<redacted>", text
    )
    return text


def _short(value: Any, depth: int = 0) -> Any:
    """A value small enough to read, with its shape intact."""
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, str):
        safe = _sanitize_string(value)
        return safe if len(safe) <= _MAX_STR else f"{safe[:_MAX_STR]}…(+{len(safe) - _MAX_STR})"
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if depth >= 3:
        return f"<{type(value).__name__}>"
    if isinstance(value, dict):
        out = {}
        for index, (k, v) in enumerate(value.items()):
            if index >= _MAX_DICT_ITEMS:
                out["…"] = f"+{len(value) - _MAX_DICT_ITEMS} more keys"
                break
            key = str(k)
            if _is_secret(key):
                out[key] = "<redacted>"
            elif _is_private_content(key):
                out[key] = "<redacted-content>"
            else:
                out[key] = _short(v, depth + 1)
        return out
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        head = [_short(v, depth + 1) for v in items[:_MAX_ITEMS]]
        if len(items) > _MAX_ITEMS:
            head.append(f"…+{len(items) - _MAX_ITEMS} more")
        return head
    # Objects: their type and, when they have one, their size. Enough to tell a
    # 12-paragraph tree from an empty one without serialising it.
    name = type(value).__name__
    try:
        return f"<{name} len={len(value)}>"  # type: ignore[arg-type]
    except TypeError:
        return f"<{name}>"


def _is_secret(name: str) -> bool:
    low = name.lower()
    return any(hint in low for hint in _SECRET_HINTS)


def _is_private_content(name: str) -> bool:
    """Whether a named field can carry copyrighted/private page or prompt text."""
    low = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if low.replace("_", "") in _PUBLIC_PROMPT_METADATA:
        return False
    return (
        low in _PRIVATE_CONTENT_NAMES
        or "prompt" in low
        or low.endswith(("_content", "_text"))
    )


def _return_summary(value: Any) -> Any:
    """Keep full-trace return shape without serialising generated/source text."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return f"<str chars={len(value)}>"
    if isinstance(value, bytes):
        return f"<bytes len={len(value)}>"
    if isinstance(value, dict):
        return _short(value)
    if isinstance(value, (list, tuple, set)):
        return f"<{type(value).__name__} len={len(value)}>"
    return f"<{type(value).__name__}>"


# --- writing -----------------------------------------------------------------


def _open(target: Path):
    """The open handle, reopened only when the selected target changes."""
    global _handle, _handle_path
    if _handle is not None and _handle_path == target:
        return _handle
    if _handle is not None:
        try:
            _handle.close()
        except Exception:  # noqa: BLE001
            pass
        _handle = None
    try:
        _ROOT.mkdir(parents=True, exist_ok=True)
        _handle = open(target, "a", encoding="utf-8")
        _handle_path = target
    except Exception:  # noqa: BLE001 - tracing must not break a request
        _handle = None
    return _handle


def _reset_handle_locked() -> None:
    """Forget a failed handle so the next flush performs a clean reopen."""
    global _handle, _handle_path
    if _handle is not None:
        try:
            _handle.close()
        except Exception:  # noqa: BLE001
            pass
    _handle = None
    _handle_path = None


def _drain_locked() -> bool:
    """Write the buffer out. Caller holds _LOCK."""
    global _last_flush, _buffer_dropped, _seq
    if not _buffer:
        return True
    target = _buffer[0][0]
    count = 0
    parts: list[str] = []
    for pending_target, text, _is_header in _buffer:
        if pending_target != target:
            break
        parts.append(text)
        count += 1
    reports_overflow = count == len(_buffer) and _buffer_dropped > 0
    if reports_overflow:
        # This marker is appended after the surviving backlog so its sequence
        # stays monotonic. It describes the gap that occurred while the sink
        # was unavailable and is reset only after the marker itself is durable.
        _seq += 1
        parts.append(json.dumps({
            "at": datetime.now(_TZ).isoformat(timespec="milliseconds"),
            "side": "api",
            "session": session_id(),
            "trace": "",
            "seq": _seq,
            "file": "trace.py",
            "fn": "trace_sink",
            "ev": "!!",
            "d": {"apiRecordsDroppedBeforeRecovery": _buffer_dropped},
        }, ensure_ascii=False) + "\n")
    batch = "".join(parts)
    handle = _open(target)
    if handle is None:
        return False
    try:
        handle.write(batch)
        handle.flush()
    except Exception:  # noqa: BLE001 - keep the batch and retry on next flush
        _reset_handle_locked()
        return False
    del _buffer[:count]
    if reports_overflow:
        _buffer_dropped = 0
    _last_flush = time.monotonic()
    # A daily rollover can leave two destinations queued. Drain each only
    # after the older file has succeeded, preserving their order and identity.
    return _drain_locked() if _buffer else True


def _emit_locked(text: str, target: Path | None = None) -> None:
    """Buffer one line and maybe drain it. Caller holds ``_LOCK``."""
    _queue_locked(target or path(), text)
    if len(_buffer) >= _BUFFER_LINES or (time.monotonic() - _last_flush) >= _FLUSH_AFTER_SEC:
        _drain_locked()


def _emit(text: str, target: Path | None = None) -> None:
    """Buffer one line; write a batch out when it is time."""
    with _LOCK:
        _emit_locked(text, target)


def flush() -> None:
    """Write out whatever is buffered. Called per request and at process exit."""
    if not _ENABLED:
        return
    try:
        with _LOCK:
            _drain_locked()
    except Exception:  # noqa: BLE001
        pass


def write(side: str, file: str, fn: str, ev: str, data: Any = None, trace_id: str = "") -> None:
    """Append one trace line. Never raises, never prints."""
    if not _ENABLED:
        return
    global _seq
    try:
        target = _ensure_session_header()
        line = {
            "side": _sanitize_string(side),
            "session": session_id(),
            "trace": _sanitize_string(trace_id or current_trace()),
            "file": _sanitize_string(file),
            "fn": _sanitize_string(fn),
            "ev": _sanitize_string(ev),
        }
        if data is not None:
            line["d"] = _short(data)
        with _LOCK:
            _seq += 1
            line["seq"] = _seq
            line["at"] = datetime.now(_TZ).isoformat(timespec="milliseconds")
            _emit_locked(json.dumps(line, ensure_ascii=False, default=str) + "\n", target)
    except Exception:  # noqa: BLE001 - a trace that can fail a request is worse than none
        pass


def note(fn: str, data: Any = None, *, file: str = "") -> None:
    """A hand-placed line at a decision point. `ev` is `..`."""
    if not _ENABLED:
        return
    write("api", file or _caller_file(), fn, "..", data)


def _caller_file() -> str:
    try:
        frame = inspect.stack()[2]
        return str(Path(frame.filename).relative_to(Path(__file__).resolve().parent.parent))
    except Exception:  # noqa: BLE001
        return "?"


F = TypeVar("F", bound=Callable[..., Any])


def traced(fn: F) -> F:
    """Wrap one function so entering, returning and raising are all recorded.

    Applied by :func:`wrap_module`, and usable directly on anything worth
    naming. When tracing is off this returns the function untouched, so there
    is not even a wrapper frame on the hot path.
    """
    if not full_enabled():
        return fn

    try:
        rel = str(Path(fn.__code__.co_filename).resolve().relative_to(
            Path(__file__).resolve().parent.parent))
    except Exception:  # noqa: BLE001
        rel = getattr(fn, "__module__", "?")
    name = getattr(fn, "__qualname__", getattr(fn, "__name__", "?"))

    try:
        params = list(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        params = []

    @functools.wraps(fn)
    def run(*args, **kwargs):
        # Positional args by NAME. `process_image(path, lang, mode)` reading as
        # `{"image_path": ..., "target_lang": "th", "mode": "lens_text"}` is the
        # difference between a trace that answers questions and a list of
        # values in an order the reader has to look up.
        given: dict[str, Any] = {}
        for index, value in enumerate(args[: len(params)]):
            given[params[index]] = value
        for index, value in enumerate(args[len(params):]):
            given[f"arg{len(params) + index}"] = value
        given.update(kwargs)
        write("api", rel, name, "->", given)
        started = time.perf_counter()
        try:
            result = fn(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - re-raised immediately
            write("api", rel, name, "!!",
                  {"error": f"{type(exc).__name__}: {exc}",
                   "ms": round((time.perf_counter() - started) * 1000, 1)})
            raise
        write("api", rel, name, "<-",
              {"ret": _return_summary(result),
               "ms": round((time.perf_counter() - started) * 1000, 1)})
        return result

    return run  # type: ignore[return-value]


def wrap_module(module: Any, *, skip: tuple[str, ...] = ()) -> int:
    """Wrap every public function a module defines. Returns how many.

    Only functions the module DEFINES are wrapped, never ones it imported —
    otherwise a helper imported into six modules would be wrapped six times and
    report the wrong file. Names in ``skip`` are left alone; use it for
    functions called per pixel, where a trace line each would be the slowest
    thing in the program.
    """
    if not full_enabled():
        return 0
    count = 0
    module_name = getattr(module, "__name__", "")
    for name in dir(module):
        if name.startswith("_") or name in skip:
            continue
        value = getattr(module, name, None)
        if not inspect.isfunction(value):
            continue
        if getattr(value, "__module__", "") != module_name:
            continue  # imported, not defined here
        if getattr(value, "__wrapped__", None) is not None:
            continue  # already wrapped
        setattr(module, name, traced(value))
        count += 1
    return count


# --- lines shipped by the extension ------------------------------------------


def client(records: list[dict[str, Any]]) -> int:
    """Write a batch of browser-side trace lines into the same file.

    ``at`` and ``ingestedAt`` use the API receive clock, which is the clock that
    assigns ``seq``. The browser's original clock remains in ``eventAt``. This
    keeps file order honest while preserving when the browser says it happened.
    """
    if not _ENABLED:
        return 0
    global _seq
    target = _ensure_session_header()
    written = 0
    for record in records or []:
        if not isinstance(record, dict):
            continue
        try:
            stamped = record.get("t")
            event_at = (
                datetime.fromtimestamp(float(stamped) / 1000, _TZ).isoformat(timespec="milliseconds")
                if isinstance(stamped, (int, float)) and stamped > 0
                else None
            )
            line = {
                "side": _sanitize_string(str(record.get("side") or "ext")),
                "clientBuild": _sanitize_string(str(record.get("clientBuild") or "unknown")),
                "traceClientSchema": record.get("traceClientSchema"),
                "producerId": _sanitize_string(str(record.get("producerId") or "legacy")),
                "tabId": record.get("tabId"),
                "frameId": record.get("frameId"),
                "session": session_id(),
                "trace": _sanitize_string(str(record.get("trace") or "")),
                # The browser's own counter is kept as `n`: it is the only
                # thing that orders two lines written in the same millisecond
                # on a clock that is not this machine's.
                "n": record.get("n"),
                "file": _sanitize_string(str(record.get("file") or "?")),
                "fn": _sanitize_string(str(record.get("fn") or "?")),
                "ev": _sanitize_string(str(record.get("ev") or "..")),
            }
            if event_at is not None:
                line["eventAt"] = event_at
            if record.get("d") is not None:
                line["d"] = _short(record.get("d"))
            with _LOCK:
                _seq += 1
                ingested_at = datetime.now(_TZ).isoformat(timespec="milliseconds")
                line["seq"] = _seq
                line["at"] = ingested_at
                line["ingestedAt"] = ingested_at
                _emit_locked(json.dumps(line, ensure_ascii=False, default=str) + "\n", target)
            written += 1
        except Exception:  # noqa: BLE001
            continue
    return written


# A trace file missing its last batch because the process ended is a trace
# file that stops mid-sentence exactly when something went wrong.
atexit.register(flush)
