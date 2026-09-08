"""Thread-safe, append-only JSONL diagnostics; disabled unless TP_LOG_FILE=1."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import os, json, threading, time

# Thailand is UTC+7 year-round; matching backend.log keeps the two readable
# side by side without mental arithmetic.
_TZ = timezone(timedelta(hours=7))

_LOCK = threading.Lock()
_MAX_VALUE_CHARS = 4000
_SECRET_KEYS = (
    "authorization", "api_key", "apikey", "token", "cookie", "secret", "password",
    "signature", "policy",
)

# Resolved once. Relative to `api/`, so `uvicorn backend.main:app` run from
# there puts logs where the source is.
_ROOT = Path(os.environ.get("TP_LOG_DIR") or (Path(__file__).resolve().parents[1] / "logs"))
_KEEP_DAYS = max(1, int(os.environ.get("TP_LOG_KEEP_DAYS", "7") or 7))
_ENABLED = (os.environ.get("TP_LOG_FILE", "0") or "0").strip().lower() in ("1", "true", "on", "yes")

def log_dir() -> Path:
    return _ROOT

def is_enabled() -> bool:
    return _ENABLED

def _today() -> str:
    return datetime.now(_TZ).strftime("%Y%m%d")

def _path(stream: str) -> Path:
    return _ROOT / f"{stream}-{_today()}.log"

def _prune() -> None:
    """Delete files older than the retention window. Best-effort."""
    cutoff = time.time() - _KEEP_DAYS * 86400
    try:
        for entry in _ROOT.glob("*.log"):
            if entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
    except OSError:
        pass

def _secret_key(key: Any) -> bool:
    lowered = str(key).strip().lower()
    return (
        any(marker in lowered for marker in _SECRET_KEYS)
        or lowered == "sig"
        or lowered.startswith("x-amz-")
        or lowered.startswith("x-goog-")
    )

def sanitize(value: Any) -> Any:
    """Redact credentials recursively and truncate oversized strings."""
    if isinstance(value, str):
        # Credentials sometimes appear in exception URLs (notably Gemini's
        # ``?key=``). Redaction at the sink protects every present/future caller.
        import re
        value = re.sub(
            r"(?i)(authorization:\s*bearer\s+|bearer\s+|[?&](?:key|api_key|token|signature|sig|policy|x-amz-[^=&\s]+|x-goog-[^=&\s]+)=)[^\s&,]+",
            lambda m: m.group(1) + "<redacted>", value,
        )
        if len(value) > _MAX_VALUE_CHARS:
            return value[:_MAX_VALUE_CHARS] + f"…(+{len(value) - _MAX_VALUE_CHARS} chars)"
        return value
    if isinstance(value, dict):
        return {
            k: ("<redacted>" if _secret_key(k) else sanitize(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize(v) for v in value[:200]]
    if isinstance(value, tuple):
        return [sanitize(v) for v in value[:200]]
    return value

def write(stream: str, record: dict[str, Any]) -> None:
    """Append one record. Never raises — logging must not break the request."""
    if not _ENABLED:
        return
    try:
        safe_record = sanitize(record)
        line = {
            "at": datetime.now(_TZ).isoformat(timespec="milliseconds"),
            **(safe_record if isinstance(safe_record, dict) else {}),
        }
        text = json.dumps(line, ensure_ascii=False, default=str)
        with _LOCK:
            _ROOT.mkdir(parents=True, exist_ok=True)
            with open(_path(stream), "a", encoding="utf-8") as handle:
                handle.write(text + "\n")
                # Persist terminal events immediately.
                handle.flush()
    except Exception:  # noqa: BLE001 - a logger that can fail a request is worse than no logger
        pass

def api(tag: str, data: dict[str, Any] | None = None, *, ok: bool = True) -> None:
    """One server-side event."""
    write("api", {"side": "api", "tag": tag, "ok": ok, **(data or {})})

# At-least-once extension delivery is deduplicated by bounded (run, n) keys.
_SEEN_MAX = 20_000
_seen_ids: dict[tuple[str, int], None] = {}
_dupes_dropped = 0

def _is_duplicate(record: dict[str, Any]) -> bool:
    """True when this exact line has already been written."""
    global _dupes_dropped
    run = record.get("run")
    number = record.get("n")
    if not isinstance(run, str) or not isinstance(number, int):
        # No identity: it cannot be de-duplicated, so it is written. Dropping an
        # unidentifiable line would silently lose data to save a maybe-copy.
        return False
    key = (run, number)
    if key in _seen_ids:
        _dupes_dropped += 1
        return True
    _seen_ids[key] = None
    while len(_seen_ids) > _SEEN_MAX:
        _seen_ids.pop(next(iter(_seen_ids)))
    return False

def duplicates_dropped() -> int:
    """How many repeat lines have been suppressed this run."""
    return _dupes_dropped

def client(records: list[dict[str, Any]]) -> int:
    """Write an extension batch, preserving event and receive timestamps."""
    written = 0
    for record in records or []:
        if not isinstance(record, dict):
            continue
        if _is_duplicate(record):
            continue
        line: dict[str, Any] = {"side": "extension", **record}
        stamped = record.get("t")
        if isinstance(stamped, (int, float)) and stamped > 0:
            line["at"] = datetime.fromtimestamp(stamped / 1000, _TZ).isoformat(
                timespec="milliseconds"
            )
            line["recvAt"] = datetime.now(_TZ).isoformat(timespec="milliseconds")
        write("extension", line)
        written += 1
    return written

def startup_banner() -> None:
    """Mark where a run begins, so a file covering several runs stays readable."""
    if not _ENABLED:
        return
    _prune()
    write(
        "api",
        {
            "side": "api",
            "tag": "boot",
            "ok": True,
            "logDir": str(_ROOT),
            "keepDays": _KEEP_DAYS,
        },
    )
