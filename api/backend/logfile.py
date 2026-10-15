"""Thread-safe, append-only JSONL diagnostics; disabled unless TP_LOG_FILE=1."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import os, json, re, threading, time
from urllib.parse import urlsplit

# Thailand is UTC+7 year-round; matching backend.log keeps the two readable
# side by side without mental arithmetic.
_TZ = timezone(timedelta(hours=7))

_LOCK = threading.RLock()
_WRITE_FAILURES = 0
_LAST_WRITE_ERROR = ""
_WRITE_COUNT = 0
_PRUNED = 0
_MAX_FILE_BYTES = 8 * 1024 * 1024
_MAX_LOG_BYTES = 64 * 1024 * 1024
_MAX_VALUE_CHARS = 4000
_SECRET_KEYS = (
    "authorization", "api_key", "apikey", "token", "cookie", "secret", "password",
    "signature", "policy", "verifier", "cipher", "csrf", "bootstrap", "credential",
    "gateway_key", "gatewaykey", "gateway-key",
)

# Usage counts are measurements, not credential tokens. Strings remain redacted.
_USAGE_COUNTS = frozenset(("inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
    "cacheWriteInputTokens", "thinkingTokens", "uncachedInputTokens", "ordinaryInputTokens", "visibleOutputTokens"))

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
    return _ROOT / f"{stream}-{_today()}-{os.getpid()}.log"

def _prune() -> None:
    """Delete files older than the retention window. Best-effort."""
    global _PRUNED
    cutoff = time.time() - _KEEP_DAYS * 86400
    try:
        for entry in _ROOT.glob("*.log"):
            if entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
                _PRUNED += 1
        entries = sorted((f for f in _ROOT.glob("*.log") if f.is_file() and not f.is_symlink()), key=lambda f:f.stat().st_mtime)
        total = sum(f.stat().st_size for f in entries)
        for f in entries:
            if total <= _MAX_LOG_BYTES: break
            size=f.stat().st_size; f.unlink(missing_ok=True); total-=size; _PRUNED+=1
    except OSError:
        pass

def _secret_key(key: Any) -> bool:
    lowered = str(key).strip().lower()
    return (
        lowered in {"body", "payload", "prompt", "messages", "content", "otp", "otp_code", "verification_code", "email", "text", "image", "image_b64", "image_base64", "data_uri"}
        or lowered in {"key", "passwd", "pwd", "api-key", "x-api-key"}
        or
        any(marker in lowered for marker in _SECRET_KEYS)
        or lowered == "sig"
        or lowered.startswith("x-amz-")
        or lowered.startswith("x-goog-")
    )

def _log_origin(value: Any) -> str:
    """Keep a useful host while dropping a page URL's path and credentials."""
    if not isinstance(value, str):
        return ""
    try:
        url = urlsplit(value)
        host = url.hostname
        port = url.port
        if not url.scheme or not host:
            return ""
        name = f"[{host}]" if ":" in host else host
        return f"{url.scheme}://{name}{':' + str(port) if port is not None else ''}"
    except ValueError:
        return ""

def _mask_private_url(match: re.Match[str]) -> str:
    raw = match.group(0)
    url = raw.rstrip(".,);]")
    trailing = raw[len(url):]
    origin = _log_origin(url)
    if not origin:
        return "<redacted-url>" + trailing
    # Query names cannot prove their values are safe; paths can carry signed IDs.
    return origin + ("/<redacted-path>" if url != origin else "") + trailing

def sanitize(value: Any) -> Any:
    """Redact credentials recursively and truncate oversized strings."""
    if isinstance(value, str):
        value = re.sub(r"(?i)(?:https?|wss?|file)://[^\s\"'<>]+", _mask_private_url, value)
        value = re.sub(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "<private-email>", value)
        value = re.sub(r"\b(?:sk-|rk_|re_|whsec_)[A-Za-z0-9_-]{8,}", "<redacted>", value)
        value = re.sub(r"(?i)\b(?:otp|code)\s*[:=]\s*\d{6}\b", "otp=<redacted>", value)
        # Credentials sometimes appear in exception URLs (notably Gemini's
        # ``?key=``). Redaction at the sink protects every present/future caller.
        value = re.sub(
            r"(?i)(authorization:\s*bearer\s+|bearer\s+|\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|secret|token|key|signature|sig|policy)=)[^\s&,\"'<>]+",
            lambda m: m.group(1) + "<redacted>", value,
        )
        value = re.sub(r"(?i)(https?://)[^/?#@\s]+@", r"\1<redacted>@", value)
        value = re.sub(r"([?&][^\s?&#=]{1,80}=)[^\s&#\"'<>]+",
                       lambda m: m.group(1) + "<redacted>", value)
        if len(value) > _MAX_VALUE_CHARS:
            return value[:_MAX_VALUE_CHARS] + f"…(+{len(value) - _MAX_VALUE_CHARS} chars)"
        return value
    if isinstance(value, dict):
        return {
            k: (v if k in _USAGE_COUNTS and (v is None or type(v) in (int, float))
                else "<redacted>" if _secret_key(k) or (str(k).lower() == "code" and re.fullmatch(r"[0-9]{6}", str(v)))
                else _log_origin(v) if str(k).lower() == "href" else sanitize(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize(v) for v in value[:200]]
    if isinstance(value, tuple):
        return [sanitize(v) for v in value[:200]]
    return value

def write(stream: str, record: dict[str, Any]) -> bool:
    """Append one record. Never raises — logging must not break the request."""
    global _WRITE_FAILURES, _LAST_WRITE_ERROR, _WRITE_COUNT
    if not _ENABLED:
        return False
    try:
        if stream not in {"api", "extension"}:
            raise ValueError("invalid log stream")
        from backend.diagnostic_core import current
        context = {k: v for k, v in current().items() if k in {"trace_id", "request_id", "job_id", "operation_id", "parent_request_id"}}
        safe_record = sanitize({**context, **record})
        line = {
            "at": datetime.now(_TZ).isoformat(timespec="milliseconds"),
            **(safe_record if isinstance(safe_record, dict) else {}),
        }
        text = json.dumps(line, ensure_ascii=False, default=str)
        with _LOCK:
            _ROOT.mkdir(parents=True, exist_ok=True)
            path = _path(stream)
            if path.exists() and path.stat().st_size + len(text.encode()) > _MAX_FILE_BYTES:
                for n in range(3, 0, -1):
                    old = path.with_name(path.stem + f"-old-{n}.log")
                    if old.exists():
                        if n == 3: old.unlink()
                        else: old.replace(path.with_name(path.stem + f"-old-{n+1}.log"))
                path.replace(path.with_name(path.stem + "-old-1.log"))
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(text + "\n")
                # Persist terminal events immediately.
                handle.flush()
            _WRITE_COUNT += 1
            if _WRITE_COUNT % 200 == 0: _prune()
        return True
    except Exception as exc:  # Diagnostics must not break business operations.
        _WRITE_FAILURES += 1
        _LAST_WRITE_ERROR = type(exc).__name__
        if _WRITE_FAILURES == 1 or _WRITE_FAILURES % 100 == 0:
            try: print(f"[TP Diagnostics] file_write_failed type={_LAST_WRITE_ERROR}; evidence may be missing", flush=True)
            except Exception: pass
        return False

def api(tag: str, data: dict[str, Any] | None = None, *, ok: bool = True) -> None:
    """One server-side event."""
    write("api", {"side": "api", "tag": tag, "ok": ok, **(data or {})})

# At-least-once extension delivery is deduplicated by bounded (run, n) keys.
_SEEN_MAX = 20_000
_seen_ids: dict[tuple[str, int], None] = {}


def health() -> dict:
    return {"enabled": _ENABLED, "write_failures": _WRITE_FAILURES, "last_error_type": _LAST_WRITE_ERROR,
            "written": _WRITE_COUNT, "pruned_files": _PRUNED, "max_log_bytes": _MAX_LOG_BYTES}

def client(records: list[dict[str, Any]]) -> int:
    """ACK only durable writes; dedupe IDs are committed AFTER the append."""
    from backend import diagnostics
    written = 0
    for record in records or []:
        if not isinstance(record, dict): continue
        run, number = record.get("run"), record.get("n")
        identity = (run, number) if isinstance(run, str) and isinstance(number, int) else None
        with _LOCK:
            if identity and identity in _seen_ids:
                continue
            line = {**record, "side": "extension", "source_trust": "client_reported"}
            stamped = record.get("t")
            if isinstance(stamped, (int, float)) and 0 < stamped < 10**15:
                try:
                    line["at"] = datetime.fromtimestamp(stamped/1000, _TZ).isoformat(timespec="milliseconds")
                    line["recvAt"] = datetime.now(_TZ).isoformat(timespec="milliseconds")
                except (OverflowError,ValueError,OSError): pass
            if not write("extension", line): raise OSError("diagnostic_write_failed")
            if record.get("diagnostic"):
                ctx = {name: diagnostics.valid_id(record.get(name)) for name in ("trace_id", "request_id", "operation_id", "job_id")}
                ctx.update(component="extension", source_trust="client_reported")
                data = {k:v for k,v in record.items() if k not in {"schema", "event", "outcome", *ctx}}
                persisted=diagnostics.writer.emit("extension." + diagnostics.valid_id(record.get("event"), "unknown"),
                    outcome=diagnostics.valid_id(record.get("outcome"), "info"), context=ctx, **data)
                if diagnostics.writer.enabled and not persisted: raise OSError("diagnostic_write_failed")
            if identity:
                _seen_ids[identity]=None
                while len(_seen_ids)>_SEEN_MAX: _seen_ids.pop(next(iter(_seen_ids)))
            written+=1
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
