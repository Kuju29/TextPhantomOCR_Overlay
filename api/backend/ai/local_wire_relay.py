"""Receive sanitized Direct Local lifecycle evidence from the extension.

The browser owns the Ollama/LM Studio socket, so the API can only persist that
boundary when the extension explicitly relays it.  This module deliberately
accepts a fixed artifact vocabulary and constructs every path server-side.
"""

from __future__ import annotations

import hmac
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from backend.ai import wire_trace

CAPABILITY_TOKEN = secrets.token_urlsafe(32)
MAX_EVENT_BYTES = 2 * 1024 * 1024
MAX_OPERATION_BYTES = 16 * 1024 * 1024
RELAY_TIMEOUT_MS = 1500

_lock = threading.Lock()
_operation_sizes: dict[str, tuple[int, float]] = {}
OPERATION_TTL_SECONDS = 60 * 60
MAX_TRACKED_OPERATIONS = 1024

STAGE_FILES = {
    "units": ("json", "01_units.json"),
    "systemPrompt": ("text", "02_system_prompt.txt"),
    "userPrompt": ("text", "03_user_prompt.txt"),
    "wireUnits": ("json", "03_wire_units.json"),
    "providerRequest": ("json", "04_provider_request.json"),
    "contractSelection": ("json", "04_contract_selection.json"),
    "providerResponse": ("response", "05_provider_response.raw"),
    "providerAssembled": ("assembled", "05_provider_response.assembled.txt"),
    "parsedRecords": ("json", "06_parsed_records.json"),
    "providerValidation": ("json", "07_provider_validation.json"),
    "validation": ("json", "07_validation.json"),
    "applyResult": ("json", "08_apply_result.json"),
    "contractApplied": ("json", "08_contract_applied.json"),
    "timing": ("json", "09_timing.json"),
    "failure": ("failure", "10_error.json"),
    "terminal": ("terminal", "11_terminal.json"),
}


def capability() -> dict[str, Any] | None:
    if not wire_trace.enabled():
        return None
    return {
        "path": "/v2/engine/runsextension/ai/local-wire-trace",
        "token": CAPABILITY_TOKEN,
        "maxEventBytes": MAX_EVENT_BYTES,
        "timeoutMs": RELAY_TIMEOUT_MS,
    }


def authorized(candidate: str) -> bool:
    return wire_trace.enabled() and hmac.compare_digest(str(candidate or ""), CAPABILITY_TOKEN)


def _safe_part(value: Any, fallback: str) -> str:
    return wire_trace.safe_path_part(value, fallback=fallback)


def _folder(trace_id: Any, operation_id: Any, execution_key: Any) -> Path:
    trace = _safe_part(trace_id, "no-trace")
    operation = _safe_part(operation_id, "no-operation")
    execution = _safe_part(execution_key, "no-execution")
    return wire_trace.root_dir() / f"{trace}--{operation}--{execution}"


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


def receive(payload: dict[str, Any]) -> Path:
    stage = str(payload.get("stage") or "")
    if stage != "trace_started" and stage not in STAGE_FILES:
        raise ValueError("unsupported local wire trace stage")
    identity = payload.get("identity")
    if not isinstance(identity, dict):
        raise ValueError("local wire trace identity is required")
    execution_key = str(identity.get("executionKey") or "")
    if not execution_key:
        raise ValueError("local wire trace executionKey is required")
    event_size = _encoded_size(payload)
    if event_size > MAX_EVENT_BYTES:
        raise OverflowError("local wire trace event exceeds size limit")
    folder = _folder(identity.get("traceId"), identity.get("operationId"), execution_key)
    size_key = str(folder)
    now = time.monotonic()
    with _lock:
        expired = [key for key, (_, touched) in _operation_sizes.items()
                   if now - touched > OPERATION_TTL_SECONDS]
        for key in expired:
            _operation_sizes.pop(key, None)
        while len(_operation_sizes) >= MAX_TRACKED_OPERATIONS and size_key not in _operation_sizes:
            oldest = min(_operation_sizes, key=lambda key: _operation_sizes[key][1])
            _operation_sizes.pop(oldest, None)
        total = _operation_sizes.get(size_key, (0, now))[0] + event_size
        if total > MAX_OPERATION_BYTES:
            raise OverflowError("local wire trace operation exceeds size limit")
        _operation_sizes[size_key] = (total, now)

    if stage == "trace_started":
        wire_trace.begin_in(folder, {
            **identity,
            "schema": "tp.ai-wire-trace/1",
            "engine": "runsextension",
            "runtime": "direct-local",
        })
        return folder

    if not folder.is_dir():
        # Network ordering or a service-worker restart must not erase evidence.
        wire_trace.begin_in(folder, {
            **identity, "schema": "tp.ai-wire-trace/1", "engine": "runsextension",
            "runtime": "direct-local", "startRecovered": True,
        })
    kind, name = STAGE_FILES[stage]
    value = payload.get("value")
    # Failure evidence may be followed by timing and the owner terminal. Keep
    # the cumulative cap until that terminal; TTL/LRU bounds abandoned jobs.
    cleanup = kind == "terminal"
    try:
        if kind == "text":
            wire_trace.write_text_in(folder, name, str(value or ""))
        elif kind == "response":
            if isinstance(value, dict):
                raw = value.get("raw")
                if raw is None and isinstance(value.get("chunks"), list):
                    raw = "".join(str(chunk) for chunk in value["chunks"])
            else:
                raw = value
            if raw is not None:
                wire_trace.write_text_in(folder, name, str(raw))
            wire_trace.write_json_in(folder, "05_provider_response.meta.json", value)
        elif kind == "assembled":
            text = value.get("text", "") if isinstance(value, dict) else value
            wire_trace.write_text_in(folder, name, str(text or ""))
        elif kind == "failure":
            wire_trace.write_json_in(folder, name, value)
            wire_trace.write_json_in(folder, "11_terminal.json", {
                **(value if isinstance(value, dict) else {}),
                "terminal": True, "state": "failed",
            })
        elif kind == "terminal":
            wire_trace.write_json_in(folder, name, {
                **(value if isinstance(value, dict) else {"state": str(value)}),
                "terminal": True,
            })
        else:
            wire_trace.write_json_in(folder, name, value)
    finally:
        if cleanup:
            with _lock:
                _operation_sizes.pop(size_key, None)
    return folder
