"""Opt-in AI boundary artifacts for operator diagnostics.

This is intentionally separate from the compact application trace.  It stores
prompts and model output, so it is disabled unless ``TP_AI_WIRE_TRACE=1``.
OpenAI-compatible raw response bodies are omitted: provider reasoning fields
cannot be safely separated from visible text in arbitrary SSE/JSON extensions.
"""

from __future__ import annotations

import contextvars
import hashlib
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
_OMITTED_RAW_RESPONSE = "[raw provider response omitted]\n"
_RAW_RESPONSE_ARTIFACTS = {"05_provider_response.raw", "response-stream.sse"}
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

def image_label(identity: dict[str, Any]) -> str:
    """Source page indexes are zero-based; reservation pageOrder is unrelated."""
    origins = identity.get("origins")
    rows = origins if isinstance(origins, list) and origins else [identity]
    numbers = set()
    unknown = False
    for row in rows:
        value = row.get("pageIndex") if isinstance(row, dict) else None
        if type(value) is int and 0 <= value < 1000000:
            numbers.add(value + 1)
        else:
            unknown = True
    labels = [f"{n:04d}" for n in sorted(numbers)[:4]]
    if len(numbers) > 4:
        labels.append(f"more{len(numbers)-4}")
    if unknown:
        labels.append("unknown")
    return ("imgs-" if len(rows) > 1 else "img-") + "+".join(labels)


def folder_name(identity: dict[str, Any], execution_key: Any = None) -> str:
    kind = ("page-summary" if identity.get("recordKind") == "page_summary"
            else "repair" if identity.get("attemptKind") == "repair" else "initial")
    suffix = [safe_path_part(identity.get("traceId"), fallback="no-trace"),
              safe_path_part(identity.get("operationId"), fallback="no-operation")]
    if execution_key is not None:
        suffix.append(safe_path_part(execution_key, fallback="no-execution"))
    name = "--".join([image_label(identity), kind, *suffix])
    raw_parts = [identity.get("traceId"), identity.get("operationId")]
    if execution_key is not None:
        raw_parts.append(execution_key)
    lossy = any(raw and str(raw) != safe for raw, safe in zip(raw_parts, suffix))
    if len(name) > 120 or lossy:
        # Keep the Windows filename component bounded; full IDs stay in identity.
        digest = hashlib.sha256(json.dumps([identity.get("traceId"), identity.get("operationId"), execution_key], default=str).encode()).hexdigest()[:16]
        name = name[:102] + "--" + digest
    return name


def begin(identity: dict[str, Any]) -> contextvars.Token:
    if not enabled():
        return _active.set(None)
    identity = {**dict(identity or {}), "wireTracePid": os.getpid()}
    root = root_dir()
    folder = root / folder_name(identity)
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
        # Human-readable visible model text assembled from parsed transport frames.
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
        write_json_in(folder, "04_provider_request.json",
                      {"status": "not_applicable", "recordKind": "page_summary", "reason": "provider_requests_in_children"}
                      if identity.get("recordKind") == "page_summary" else {"status": "not_reached"})
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
        if name == "05_provider_response.meta.json":
            value = _safe_response_meta(value)
        elif name in {"10_error.json", "11_terminal.json"}:
            value = _safe_relay_terminal_meta(value)
        body = json.dumps(redact(value), ensure_ascii=False, indent=2, default=str) + "\n"
        with _lock:
            (folder / name).write_text(body, encoding="utf-8")
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def write_text_in(folder: Path, name: str, value: str) -> None:
    if name not in {"02_system_prompt.txt", "03_user_prompt.txt", "05_provider_response.raw", "05_provider_response.assembled.txt"}:
        raise AiWireTraceWriteError("AI_WIRE_TRACE_WRITE_FAILED: invalid artifact name")
    try:
        if name == "05_provider_response.raw" and value:
            value = _OMITTED_RAW_RESPONSE
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
        # Arbitrary provider query fields and URL userinfo can contain tokens.
        query = [(k, "<redacted>") for k, _ in parse_qsl(parsed.query, keep_blank_values=True)]
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1],
                           parsed.path, urlencode(query), ""))
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


def _safe_response_meta(value: Any) -> dict[str, Any]:
    row = value if isinstance(value, dict) else {}
    status = row.get("status")
    status = status if type(status) is int and 100 <= status <= 599 else None
    streamed = row.get("streamed")
    if type(streamed) is not bool:
        streamed = True if row.get("mode") == "stream" else (
            False if row.get("mode") == "body" else None)
    safe = {"status": status, "streamed": streamed, "bodyStored": False}
    for key in ("streamChunkCount", "reasoningChunkCount", "chunkCount",
                "inputTokens", "outputTokens", "totalTokens",
                "cachedInputTokens", "reasoningTokens"):
        if key in row:
            count = row[key]
            safe[key] = count if type(count) is int and count >= 0 else None
    # Safe error identifiers, never vendor message/raw/headers/reasoning.
    from backend.ai.clients.provider_error import safe_diagnostic_label
    for key in ("providerCode", "providerType", "upstreamProvider"):
        label = safe_diagnostic_label(row.get(key))
        if label:
            safe[key] = label
    wait = row.get("retryAfterMs")
    if type(wait) is int and 0 <= wait <= 3_600_000:
        safe["retryAfterMs"] = wait
    if "chunkCount" not in safe and isinstance(row.get("chunks"), list):
        safe["chunkCount"] = len(row["chunks"])
    if type(row.get("complete")) is bool:
        safe["complete"] = row["complete"]
    return safe


def _safe_relay_terminal_meta(value: Any) -> dict[str, Any]:
    """Keep only structural facts from browser-supplied failure/terminal rows."""
    row = value if isinstance(value, dict) else {}
    safe: dict[str, Any] = {}
    for key in ("state", "stage", "code"):
        field = row.get(key)
        if isinstance(field, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", field):
            safe[key] = field
    for key in ("terminal", "requestDispatched", "providerResponded"):
        if type(row.get(key)) is bool:
            safe[key] = row[key]
    for key in ("status", "providerAttempts", "generationAttempts", "translated"):
        count = row.get(key)
        if type(count) is int and count >= 0:
            safe[key] = count
    if row.get("message"):
        safe["message"] = "<omitted>"
    return safe

def write_json(name: str, value: Any) -> None:
    folder = _active.get()
    if folder is None:
        return
    try:
        if name == "05_provider_response.meta.json":
            value = _safe_response_meta(value)
        elif name in {"10_error.json", "11_terminal.json"} and isinstance(value, dict):
            value = {**value, "message": "<omitted>" if value.get("message") else ""}
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
        if name in _RAW_RESPONSE_ARTIFACTS and value:
            value = _OMITTED_RAW_RESPONSE
        with _lock:
            (folder / name).write_text(str(value), encoding="utf-8")
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def append_text(name: str, value: str) -> None:
    folder = _active.get()
    if folder is None:
        return
    if name in _RAW_RESPONSE_ARTIFACTS:
        # SSE chunks can split a private reasoning value across frames. No
        # per-frame rewrite can prove the concatenation is safe to persist.
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
    """Persist structural failure evidence without vendor-controlled wording."""
    detail = getattr(exc, "detail", None)
    detail = detail if isinstance(detail, dict) and detail.get("schema") == "tp.error/1" else {}
    code = detail.get("code") or getattr(exc, "code", None)
    evidence = {}
    for key in ("origin", "httpStatus", "upstreamStatus", "requestDispatched", "providerAttempts", "generationAttempts"):
        if key in detail:
            evidence[key] = detail[key]
    status = getattr(exc, "status", None)
    if "upstreamStatus" not in evidence and type(status) is int and 100 <= status <= 599:
        evidence["upstreamStatus"] = status
    write_json("10_error.json", {
        "stage": stage, "type": type(exc).__name__,
        "code": code, "message": "<omitted>", **evidence,
    })
    terminal(state="failed", stage=stage, code=code, **evidence)

def terminal(*, state: str, stage: str = "", code: Any = None,
             message: str = "", **details: Any) -> None:
    """Write the authoritative end state for every started AI operation."""
    write_json("11_terminal.json", {
        "terminal": True, "state": state, "stage": stage,
        "code": code, "message": "<omitted>" if message else "", **details,
    })

def provider_request(*, url: str, headers: dict[str, Any], payload: Any) -> None:
    found: set[str] = set()
    try:
        for key, value in headers.items():
            if value:
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
    # Header names aid diagnostics; values may be credentials under vendor
    # specific names and are never needed to reproduce the prompt contract.
    safe_headers = {str(key): "<redacted>" for key in headers}
    write_json("04_provider_request.json", {"url": url, "headers": safe_headers, "body": payload})


def provider_response_omitted(response: Any, *, streamed: bool | None) -> None:
    """Record only HTTP status/mode for OpenAI-compatible response payloads.

    A reasoning fragment may be split across SSE lines, and vendors may add
    arbitrary JSON fields. Never persist even a prefix of that raw payload.
    """
    if _active.get() is None:
        return
    status = getattr(response, "status_code", None)
    status = status if type(status) is int and 100 <= status <= 599 else None
    write_text("05_provider_response.raw", _OMITTED_RAW_RESPONSE)
    write_json("05_provider_response.meta.json", {
        "status": status, "streamed": streamed, "bodyStored": False,
    })

def _scrub_text(value: str) -> str:
    text = str(value)
    for secret in _secrets.get():
        if secret:
            text = text.replace(secret, "<redacted>")
    return text

def provider_response(value: Any) -> None:
    # Deliberately do not inspect or serialize the vendor body. Thought fields
    # may occur anywhere inside a JSON extension.
    provider_response_omitted(None, streamed=None)

def http_response(response: Any) -> None:
    """Persist status only; never touch a native provider's response body."""
    provider_response_omitted(response, streamed=None)
