"""Opt-in, lossless AI boundary artifacts for operator diagnostics.

This is intentionally separate from the compact application trace.  It stores
prompts and model output, so it is disabled unless ``TP_AI_WIRE_TRACE=1``.
Credentials are the only values rewritten before persistence.
"""

from __future__ import annotations

import contextvars
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_active: contextvars.ContextVar[Path | None] = contextvars.ContextVar("tp_ai_wire_dir", default=None)
_secrets: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar("tp_ai_wire_secrets", default=())
_lock = threading.Lock()
_SECRET_KEYS = {"authorization", "api-key", "api_key", "apikey", "x-api-key", "cookie", "set-cookie"}
_RELAY_JSON_FILES = {
    "00_identity.json", "01_units.json", "03_wire_units.json",
    "04_provider_request.json", "04_contract_selection.json", "05_provider_response.meta.json",
    "06_parsed_records.json", "07_provider_validation.json",
    "07_validation.json", "08_apply_result.json", "08_contract_applied.json", "09_timing.json",
    "10_error.json", "11_terminal.json",
}

class AiWireTraceWriteError(RuntimeError):
    code = "AI_WIRE_TRACE_WRITE_FAILED"

def enabled() -> bool:
    return os.getenv("TP_AI_WIRE_TRACE", "").strip().lower() in {"1", "true", "yes", "on"}

def root_dir() -> Path:
    return Path(os.getenv("TP_AI_WIRE_TRACE_DIR") or Path(__file__).resolve().parents[2] / "logs" / "ai-wire")

def start_session() -> dict[str, Any]:
    """Persist process-level proof that wire tracing reached this API process."""
    state = {
        "schema": "tp.ai-wire-trace-session/1",
        "enabled": enabled(),
        "pid": os.getpid(),
        "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "root": str(root_dir()),
    }
    if not state["enabled"]:
        return state
    try:
        root = root_dir()
        root.mkdir(parents=True, exist_ok=True)
        with _lock:
            (root / f"_session-{os.getpid()}.json").write_text(
                json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
    except Exception as exc:
        raise AiWireTraceWriteError(
            f"AI_WIRE_TRACE_WRITE_FAILED: session: {type(exc).__name__}"
        ) from exc
    return state

def safe_path_part(value: Any, *, fallback: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or fallback))[:80] or fallback

def begin(identity: dict[str, Any]) -> contextvars.Token:
    if not enabled():
        return _active.set(None)
    identity = {**dict(identity or {}), "wireTracePid": os.getpid()}
    trace_id = safe_path_part(identity.get("traceId"), fallback="no-trace")
    operation = safe_path_part(identity.get("operationId"), fallback="no-operation")
    root = root_dir()
    folder = root / f"{trace_id}--{operation}"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        token = _active.set(folder)
        _secrets.set(())
        write_json("00_identity.json", identity)
        # Create the boundary files immediately.  Their presence proves the
        # request entered wire tracing even when prompt composition or the
        # transport fails before a native payload/response exists.
        write_json("04_provider_request.json", {"status": "not_reached"})
        write_text("05_provider_response.raw", "")
        # Human-readable model text assembled from parsed transport frames.
        # The lossless raw boundary above remains authoritative.
        write_text("05_provider_response.assembled.txt", "")
        write_json("11_terminal.json", {"terminal": False, "state": "started"})
        return token
    except Exception as exc:
        if isinstance(exc, AiWireTraceWriteError):
            raise
        raise AiWireTraceWriteError(
            f"AI_WIRE_TRACE_WRITE_FAILED: 00_identity.json: {type(exc).__name__}"
        ) from exc

def update_identity(**details: Any) -> None:
    """Merge resolved request identity into an already-started operation.

    ``begin`` deliberately runs at HTTP ingress, before request validation.  A
    valid request can therefore add its resolved provider/model later without
    losing the provisional evidence needed for rejected requests.
    """
    folder = _active.get()
    if folder is None:
        return
    path = folder / "00_identity.json"
    try:
        with _lock:
            current: dict[str, Any] = {}
            if path.exists():
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    current = loaded
            current.update(details)
            path.write_text(
                json.dumps(redact(current), ensure_ascii=False, indent=2, default=str) + "\n",
                encoding="utf-8",
            )
    except Exception as exc:
        raise AiWireTraceWriteError(
            f"AI_WIRE_TRACE_WRITE_FAILED: 00_identity.json: {type(exc).__name__}"
        ) from exc

def active_folder() -> Path | None:
    """Return the current operation folder for explicit cross-thread handoff."""
    return _active.get()

def resume(folder: Path | None) -> contextvars.Token:
    """Attach an existing ingress operation to the current execution context."""
    _secrets.set(())
    return _active.set(folder)

def begin_in(folder: Path, identity: dict[str, Any]) -> None:
    """Create relay artifacts without relying on request-local contextvars."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        write_json_in(folder, "00_identity.json", identity)
        write_json_in(folder, "04_provider_request.json", {"status": "not_reached"})
        write_text_in(folder, "05_provider_response.raw", "")
        write_text_in(folder, "05_provider_response.assembled.txt", "")
        write_json_in(folder, "11_terminal.json", {"terminal": False, "state": "started"})
    except AiWireTraceWriteError:
        raise
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: relay begin: {type(exc).__name__}") from exc

def write_json_in(folder: Path, name: str, value: Any) -> None:
    if name not in _RELAY_JSON_FILES:
        raise AiWireTraceWriteError("AI_WIRE_TRACE_WRITE_FAILED: invalid artifact name")
    try:
        body = json.dumps(redact(value), ensure_ascii=False, indent=2, default=str) + "\n"
        with _lock:
            (folder / name).write_text(body, encoding="utf-8")
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def write_text_in(folder: Path, name: str, value: str) -> None:
    if name not in {"02_system_prompt.txt", "03_user_prompt.txt", "05_provider_response.raw", "05_provider_response.assembled.txt"}:
        raise AiWireTraceWriteError("AI_WIRE_TRACE_WRITE_FAILED: invalid artifact name")
    try:
        with _lock:
            (folder / name).write_text(_scrub_text(str(value)), encoding="utf-8")
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def end(token: contextvars.Token) -> None:
    _secrets.set(())
    _active.reset(token)

def _safe_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        query = [(k, "<redacted>" if k.lower() in _SECRET_KEYS or "key" in k.lower() else v)
                 for k, v in parse_qsl(parsed.query, keep_blank_values=True)]
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
    except Exception:
        return value

def redact(value: Any, key: str = "") -> Any:
    normalized_key = key.lower()
    if normalized_key in _SECRET_KEYS or normalized_key.endswith(("token", "secret", "password")):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str) and (
        normalized_key in {"url", "endpoint", "base_url", "baseurl"}
        or normalized_key.endswith(("url", "endpoint"))
    ):
        return _safe_url(value)
    return value

def write_json(name: str, value: Any) -> None:
    folder = _active.get()
    if folder is None:
        return
    try:
        body = json.dumps(redact(value), ensure_ascii=False, indent=2, default=str) + "\n"
        with _lock:
            (folder / name).write_text(body, encoding="utf-8")
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def write_text(name: str, value: str) -> None:
    folder = _active.get()
    if folder is None:
        return
    try:
        with _lock:
            (folder / name).write_text(str(value), encoding="utf-8")
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def append_text(name: str, value: str) -> None:
    folder = _active.get()
    if folder is None:
        return
    try:
        with _lock:
            with (folder / name).open("a", encoding="utf-8", newline="") as handle:
                handle.write(_scrub_text(str(value)))
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def append_assembled(value: str) -> None:
    """Append visible model text after one native frame was decoded.

    This is diagnostic convenience only. It never replaces or influences the
    raw response, parsing, validation, completion, or transport behavior.
    """
    append_text("05_provider_response.assembled.txt", value)

def assembled_response(value: str) -> None:
    write_text("05_provider_response.assembled.txt", _scrub_text(str(value)))

def record_error(exc: BaseException, *, stage: str) -> None:
    """Persist a credential-safe terminal failure without swallowing it."""
    message = _scrub_text(str(exc or ""))
    message = re.sub(r"(?i)(bearer\s+)[^\s,;]+", r"\1<redacted>", message)
    message = re.sub(r"([?&](?:key|api_key|token)=)[^&\s]+", r"\1<redacted>", message)
    write_json("10_error.json", {
        "stage": stage, "type": type(exc).__name__,
        "code": getattr(exc, "code", None), "message": message,
    })
    terminal(state="failed", stage=stage, code=getattr(exc, "code", None), message=message)

def terminal(*, state: str, stage: str = "", code: Any = None,
             message: str = "", **details: Any) -> None:
    """Write the authoritative end state for every started AI operation."""
    write_json("11_terminal.json", {
        "terminal": True, "state": state, "stage": stage,
        "code": code, "message": _scrub_text(message), **details,
    })

def provider_request(*, url: str, headers: dict[str, Any], payload: Any) -> None:
    found: set[str] = set()
    try:
        for key, value in headers.items():
            if key.lower() in _SECRET_KEYS and value:
                found.add(str(value))
                if str(value).lower().startswith("bearer "):
                    found.add(str(value)[7:])
        for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=True):
            if key.lower() in _SECRET_KEYS or "key" in key.lower() or "token" in key.lower():
                if value:
                    found.add(value)
    except Exception:
        pass
    _secrets.set(tuple(sorted(found, key=len, reverse=True)))
    write_json("04_provider_request.json", {"url": url, "headers": headers, "body": payload})

def _scrub_text(value: str) -> str:
    text = str(value)
    for secret in _secrets.get():
        if secret:
            text = text.replace(secret, "<redacted>")
    return text

def provider_response(value: Any) -> None:
    if isinstance(value, str):
        write_text("05_provider_response.raw", _scrub_text(value))
    else:
        write_text("05_provider_response.raw", _scrub_text(json.dumps(value, ensure_ascii=False, default=str)))

def http_response(response: Any) -> None:
    """Persist an HTTP body without requiring test doubles to expose ``text``."""
    if _active.get() is None:
        return
    value = getattr(response, "text", None)
    if value is None:
        content = getattr(response, "content", b"")
        value = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else str(content)
    provider_response(value)
