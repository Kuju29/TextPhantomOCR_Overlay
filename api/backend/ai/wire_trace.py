"""Opt-in AI boundary artifacts for operator diagnostics.

This is intentionally separate from the compact application trace.  It stores
prompts and model output, so it is disabled unless ``TP_AI_WIRE_TRACE=1``.
OpenAI-compatible raw response bodies are omitted: provider reasoning fields
cannot be safely separated from visible text in arbitrary SSE/JSON extensions.
"""

from __future__ import annotations

import contextvars
import atexit
import hashlib
import json
import os
import re
import threading
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from backend import diagnostic_retention as retention

_active: contextvars.ContextVar[Path | None] = contextvars.ContextVar("tp_ai_wire_dir", default=None)
_secrets: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar("tp_ai_wire_secrets", default=())
_lock = threading.Lock()
_folder_leases: dict[Path, tuple[retention.Lease, int]] = {}
_relay_folders: set[Path] = set()
_session_lease: retention.Lease | None = None
_session_lease_root: Path | None = None
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


def retention_limits() -> dict[str, int]:
    maximum = retention.positive_env("TP_AI_WIRE_TRACE_MAX_BYTES", retention.DEFAULT_MAX_BYTES)
    return {
        "maxBytes": maximum,
        "keepDays": retention.positive_env("TP_AI_WIRE_TRACE_KEEP_DAYS", retention.DEFAULT_KEEP_DAYS),
        "operationMaxBytes": min(maximum, retention.positive_env(
            "TP_AI_WIRE_TRACE_OPERATION_MAX_BYTES", 16 * 1024 * 1024)),
        "maxOperations": retention.positive_env("TP_AI_WIRE_TRACE_MAX_OPERATIONS", 2048),
        "maxActiveOperations": retention.positive_env(
            "TP_AI_WIRE_TRACE_MAX_ACTIVE_OPERATIONS", retention.DEFAULT_MAX_ACTIVE),
        "maxFiles": retention.positive_env("TP_AI_WIRE_TRACE_MAX_FILES", retention.DEFAULT_MAX_FILES),
    }


def _entries(root: Path):
    for item in root.iterdir():
        if ((item.name.startswith(("img-", "imgs-")) and "--" in item.name)
                or (item.name.startswith("_session-") and item.suffix == ".json")):
            yield item


def _entry_size(item: Path) -> tuple[int, bool, float, int]:
    """Flat operation folders only; unexpected links/subdirectories stay intact."""
    info = item.lstat()
    if item.is_symlink():
        return retention.charge(info.st_size), False, info.st_mtime, 1
    if item.is_file():
        return retention.charge(info.st_size), True, info.st_mtime, 1
    total, safe, touched, count = retention.ALLOCATION_UNIT, True, info.st_mtime, 1
    for child in item.iterdir():
        details = child.lstat()
        total += retention.charge(details.st_size)
        count += 1
        touched = max(touched, details.st_mtime)
        safe = safe and child.is_file() and not child.is_symlink()
        if child.is_dir() and not child.is_symlink():
            nested, _safe, nested_touched, nested_count = _entry_size(child)
            total += nested - retention.charge(details.st_size)
            count += nested_count - 1
            touched = max(touched, nested_touched)
    return total, safe, touched, count


def _scan_bytes(root: Path) -> int:
    return _scan_usage(root)[0]


def _scan_usage(root: Path) -> tuple[int, int]:
    total, count = retention.metadata_usage(root, "wire")
    for item in _entries(root):
        size, _safe, _touched, files = _entry_size(item)
        total += size
        count += files
    return total, count


def _prune_locked(root: Path, *, budget: int | None = None, protected: Path | None = None,
                  operation_budget: int | None = None, file_budget: int | None = None) -> tuple[int, int]:
    """Only terminal operations without an OS lease can be removed."""
    limits = retention_limits()
    cutoff = time.time() - limits["keepDays"] * 86400
    maximum = limits["maxBytes"] if budget is None else max(0, budget)
    retention.active_count(root, "wire")
    rows = []
    total, files = retention.metadata_usage(root, "wire")
    operations = 0
    max_operations = limits["maxOperations"] if operation_budget is None else max(0, operation_budget)
    max_files = limits["maxFiles"] if file_budget is None else max(0, file_budget)
    for item in _entries(root):
        size, safe, touched, count = _entry_size(item)
        total += size
        files += count
        operations += int(item.is_dir())
        completed = item.is_file()
        if safe and item.is_dir():
            try:
                completed = json.loads((item / "11_terminal.json").read_text("utf-8")).get("terminal") is True
            except (OSError, ValueError, AttributeError):
                completed = False
        rows.append((touched, item, size, count, safe and completed))
    for touched, item, size, count, completed in sorted(rows, key=lambda row: (row[0], row[1].name)):
        if (item == protected or not completed or (touched >= cutoff and total <= maximum
                and operations <= max_operations and files <= max_files)):
            continue
        if retention.active(root, "wire", item):
            continue
        try:
            if item.is_dir():
                shutil.rmtree(item)
                operations -= 1
            else:
                item.unlink()
            total -= size
            files -= count
        except OSError:
            continue
    retention.store_usage(root, "wire", total, files, checked_at=time.time())
    return total, files


def _retain_folder(folder: Path, *, relay: bool = False) -> None:
    with _lock:
        if relay and folder in _relay_folders:
            return
        lease, count = _folder_leases.get(folder, (None, 0))
        if lease is None:
            with retention.guard(folder.parent, "wire"):
                limits = retention_limits()
                if retention.active_count(folder.parent, "wire") >= limits["maxActiveOperations"]:
                    raise OSError("active wire operation retention capacity exceeded")
                created = not folder.exists()
                reserved_files = 2 if created else 1  # folder and unique active lease
                reserved_bytes = reserved_files * retention.ALLOCATION_UNIT
                total, files = _prune_locked(
                    folder.parent, budget=limits["maxBytes"] - reserved_bytes,
                    protected=folder, operation_budget=limits["maxOperations"] - int(created),
                    file_budget=limits["maxFiles"] - reserved_files)
                if (total + reserved_bytes > limits["maxBytes"]
                        or files + reserved_files > limits["maxFiles"]
                        or sum(item.is_dir() for item in _entries(folder.parent)) + int(created) > limits["maxOperations"]):
                    raise OSError("wire operation retention capacity occupied by protected evidence")
                retention.store_usage(folder.parent, "wire", total + reserved_bytes, files + reserved_files)
                folder.mkdir(parents=True, exist_ok=True)
                lease = retention.retain(folder.parent, "wire", folder)
        _folder_leases[folder] = (lease, count + 1)
        if relay:
            _relay_folders.add(folder)


def _release_folder(folder: Path | None, *, relay: bool = False) -> None:
    if folder is None:
        return
    with _lock:
        if relay:
            if folder not in _relay_folders:
                return
            _relay_folders.discard(folder)
        entry = _folder_leases.get(folder)
        if entry is None:
            return
        lease, count = entry
        if count > 1:
            _folder_leases[folder] = (lease, count - 1)
            return
        _folder_leases.pop(folder, None)
        retention.release(lease)
        # Cleanup cannot replace a successful business result. Capacity checks
        # before each content write remain fail-visible when tracing is opted in.
        try:
            with retention.guard(folder.parent, "wire"):
                _prune_locked(folder.parent)
        except OSError:
            pass


def finish_in(folder: Path) -> None:
    """Release a relay operation only after the owner's final terminal stage."""
    _release_folder(folder, relay=True)


def _write_bytes_locked(folder: Path, name: str, body: str, *, append: bool = False) -> None:
    if Path(name).name != name or len(name) > 100:
        raise OSError("invalid diagnostic artifact name")
    target = folder / name
    root = folder.parent
    encoded = body.encode("utf-8")
    limits = retention_limits()
    with retention.guard(root, "wire"):
        # Read the old size under the shared lock. Two workers can touch the
        # same operation; a stale pre-lock size could undercount an overwrite.
        if folder.is_symlink() or target.is_symlink():
            raise OSError("diagnostic artifact must not be a symbolic link")
        exists = target.exists()
        previous = target.stat().st_size if exists else 0
        if exists and target.stat().st_nlink != 1:
            raise OSError("diagnostic artifact must not be hard-linked")
        size = previous + len(encoded) if append else len(encoded)
        previous_charge = retention.charge(previous) if exists else 0
        size_charge = retention.charge(size)
        operation_size = _entry_size(folder)[0]
        if operation_size - previous_charge + size_charge > limits["operationMaxBytes"]:
            raise OSError("wire operation retention capacity exceeded")
        total, files = retention.usage(root, "wire", lambda: _scan_usage(root))
        growth = max(0, size_charge - previous_charge)
        new_files = int(not exists)
        if total + growth > limits["maxBytes"] or files + new_files > limits["maxFiles"]:
            total, files = _prune_locked(root, budget=limits["maxBytes"] - growth, protected=folder,
                                        file_budget=limits["maxFiles"] - new_files)
        if total + growth > limits["maxBytes"] or files + new_files > limits["maxFiles"]:
            raise OSError("wire retention capacity occupied by protected evidence")
        # Reserve first: interrupted or failed writes conservatively overcount
        # until the next inventory scan, instead of allowing extra disk growth.
        retention.store_usage(root, "wire", total + growth, files + new_files)
        with target.open("ab" if append else "wb") as handle:
            handle.write(encoded)
        retention.store_usage(root, "wire", total + size_charge - previous_charge, files + new_files)

def start_session() -> dict[str, Any]:
    """Persist process-level proof that wire tracing reached this API process."""
    state = {
        "schema": "tp.ai-wire-trace-session/1",
        "enabled": enabled(),
        "pid": os.getpid(),
        "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "root": str(root_dir()),
        "retention": retention_limits(),
    }
    if not state["enabled"]:
        return state
    try:
        root = root_dir()
        root.mkdir(parents=True, exist_ok=True)
        with _lock:
            global _session_lease, _session_lease_root
            target = root / f"_session-{os.getpid()}.json"
            with retention.guard(root, "wire"):
                if _session_lease_root != root:
                    retention.release(_session_lease)
                    _session_lease = None
                if target.is_symlink() or (target.exists() and target.stat().st_nlink != 1):
                    raise OSError("diagnostic session must be a regular private file")
                exists = target.exists()
                previous = target.stat().st_size if exists else 0
                body = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                growth = retention.charge(len(body)) - (retention.charge(previous) if exists else 0)
                lease_growth = retention.ALLOCATION_UNIT if _session_lease is None else 0
                new_files = int(not exists) + int(_session_lease is None)
                total, files = _prune_locked(root, protected=target,
                    budget=state["retention"]["maxBytes"] - max(0, growth) - lease_growth,
                    file_budget=state["retention"]["maxFiles"] - new_files)
                if _session_lease is None:
                    if retention.active_count(root, "wire") >= state["retention"]["maxActiveOperations"]:
                        raise OSError("active wire retention capacity exceeded")
                if (total + max(0, growth) + lease_growth > state["retention"]["maxBytes"]
                        or files + new_files > state["retention"]["maxFiles"]):
                    raise OSError("wire retention capacity occupied by protected evidence")
                retention.store_usage(root, "wire", total + max(0, growth) + lease_growth, files + new_files)
                if _session_lease is None:
                    _session_lease = retention.retain(root, "wire", target)
                    _session_lease_root = root
                target.write_bytes(body)
                retention.store_usage(root, "wire", total + growth + lease_growth, files + new_files)
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
    token = None
    try:
        _retain_folder(folder)
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
        _release_folder(folder)
        if token is not None:
            _active.reset(token)
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
            _write_bytes_locked(folder, "00_identity.json", json.dumps(
                redact(current), ensure_ascii=False, indent=2, default=str) + "\n")
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
    if folder is not None:
        _retain_folder(folder)
    return _active.set(folder)

def begin_in(folder: Path, identity: dict[str, Any]) -> None:
    """Create relay artifacts without relying on request-local contextvars."""
    try:
        _retain_folder(folder, relay=True)
        folder.mkdir(parents=True, exist_ok=True)
        write_json_in(folder, "00_identity.json", identity)
        write_json_in(folder, "04_provider_request.json",
                      {"status": "not_applicable", "recordKind": "page_summary", "reason": "provider_requests_in_children"}
                      if identity.get("recordKind") == "page_summary" else {"status": "not_reached"})
        write_text_in(folder, "05_provider_response.raw", "")
        write_text_in(folder, "05_provider_response.assembled.txt", "")
        write_json_in(folder, "11_terminal.json", {"terminal": False, "state": "started"})
    except AiWireTraceWriteError:
        _release_folder(folder, relay=True)
        raise
    except Exception as exc:
        _release_folder(folder, relay=True)
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
            _write_bytes_locked(folder, name, body)
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def write_text_in(folder: Path, name: str, value: str) -> None:
    if name not in {"02_system_prompt.txt", "03_user_prompt.txt", "05_provider_response.raw", "05_provider_response.assembled.txt"}:
        raise AiWireTraceWriteError("AI_WIRE_TRACE_WRITE_FAILED: invalid artifact name")
    try:
        if name == "05_provider_response.raw" and value:
            value = _OMITTED_RAW_RESPONSE
        with _lock:
            _write_bytes_locked(folder, name, _scrub_text(str(value)))
    except Exception as exc:
        raise AiWireTraceWriteError(f"AI_WIRE_TRACE_WRITE_FAILED: {name}: {type(exc).__name__}") from exc

def end(token: contextvars.Token) -> None:
    _secrets.set(())
    _release_folder(_active.get())
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
            _write_bytes_locked(folder, name, body)
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
            _write_bytes_locked(folder, name, str(value))
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
            _write_bytes_locked(folder, name, _scrub_text(str(value)), append=True)
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
    for key in ("origin", "httpStatus", "upstreamStatus", "requestDispatched", "providerAttempts", "generationAttempts",
                "centerHttpStatus", "centerRequestDispatched", "centerRequestId", "centerErrorCode",
                "providerDispatchEvidence", "creditState"):
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


def _release_all_leases() -> None:
    for lease, _count in list(_folder_leases.values()):
        retention.release(lease)
    _folder_leases.clear()
    _relay_folders.clear()
    retention.release(_session_lease)


atexit.register(_release_all_leases)

# Runtime tracing is supplementary evidence. The reservation layer above stays
# strict, but a disk failure must never interrupt SSE draining or authoritative
# provider/Center usage receipts (including writes from transport finally blocks).
from functools import wraps
from collections import OrderedDict

_degraded_folders: OrderedDict[Path, None] = OrderedDict()
_degraded_lock = threading.Lock()

def _degrade(folder, stage, exc):
    first = True
    if folder is not None:
        with _degraded_lock:
            first = folder not in _degraded_folders
            _degraded_folders[folder] = None
            while len(_degraded_folders) > 8192:
                _degraded_folders.popitem(last=False)
        _release_folder(folder)
        if _active.get() == folder:
            _active.set(None)
    if first:
        try:
            from backend import diagnostics
            diagnostics.emit("ai.wire_trace.degraded", outcome="incomplete",
                             stage=stage, error_type=type(exc).__name__)
        except Exception:
            pass

def _runtime_trace(function):
    @wraps(function)
    def run(*args, **kwargs):
        folder = _active.get()
        if function.__name__ == "resume" and args:
            folder = args[0]
        with _degraded_lock:
            disabled = folder is not None and folder in _degraded_folders
        if disabled:
            if function.__name__ == "resume":
                return _active.set(None)
            return None
        try:
            return function(*args, **kwargs)
        except (AiWireTraceWriteError, OSError) as exc:
            _degrade(folder or _active.get(), function.__name__, exc)
            if function.__name__ in {"begin", "resume"}:
                return _active.set(None)
            if function.__name__ == "start_session":
                return {"enabled": False, "incomplete": True, "code": "AI_WIRE_TRACE_WRITE_FAILED"}
            return None
    return run

for _runtime_name in ("begin", "resume", "start_session", "update_identity",
                      "write_json", "write_text", "append_text"):
    globals()[_runtime_name] = _runtime_trace(globals()[_runtime_name])
