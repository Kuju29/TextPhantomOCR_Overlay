"""Content previews for explicit TP_TRACE diagnostics only."""
from __future__ import annotations

import hashlib
import os
import re
from typing import Iterable

from backend import trace

_MAX = 120
_CHUNK = 16
_URL = re.compile(r"(?:https?|blob):[^\s\"'<>]+|data:[^\s\"'<>]+", re.I)
_AUTH_LINE = re.compile(r"\b(?:proxy-)?authorization\s*:\s*[^\r\n]+", re.I)
_CRED = re.compile(r"\b(?:Bearer\s+)?(?:sk-|hf_|gh[pousr]_)[A-Za-z0-9._~+\-/=]{8,}|\bAIza[0-9A-Za-z_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|\b(?:api[_-]?key|apikey|access[_-]?token|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;&]+", re.I)

def preview(value: object) -> dict:
    raw = str(value or "")
    safe = _AUTH_LINE.sub("<redacted-credential>", raw)
    safe = _URL.sub("<redacted-url>", safe)
    safe = _CRED.sub("<redacted-credential>", safe)
    safe = "".join(f"\\u{ord(ch):04x}" if ord(ch) < 32 or 127 <= ord(ch) <= 159 else ch for ch in safe)
    result = {
        "chars": len(raw),
        "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "truncated": len(safe) > _MAX,
    }
    # Content diagnostics are deliberately separate from TP_TRACE. Normal
    # TP_TRACE=1/full never writes source, prompt, translation, or provider
    # response text unless this explicit high-risk opt-in is also enabled.
    if (os.environ.get("TP_TRACE_CONTENT") or "").strip().lower() in {"1", "true", "on", "yes"}:
        result["preview"] = safe[:_MAX]
    return result

def marked_units(marked: str) -> list[dict]:
    raw = str(marked or "")
    # Provider output is one compact record per line.  Prefer that grammar so
    # diagnostics never claim items=[] for a valid provider response.
    compact = list(re.finditer(r"(?:^|\n)<<TP_(P\d+):(.*?)>>(?=\n|$)", raw, re.S))
    if compact:
        return [{"id": match.group(1), **preview(match.group(2).strip())}
                for match in compact]
    opened = list(re.finditer(r"<<TP_(P\d+)>>", raw))
    return [{"id": match.group(1), **preview(
        raw[match.end():(opened[i + 1].start() if i + 1 < len(opened) else len(raw))].strip()
    )} for i, match in enumerate(opened)]

def emit(event: str, items: Iterable[dict], **extra: object) -> None:
    """Emit bounded diagnostics without ever changing translation outcome."""
    try:
        if not trace.enabled():
            return
        values = list(items)
        count = max(1, (len(values) + _CHUNK - 1) // _CHUNK)
        for index in range(count):
            trace.note(event, {**extra, "chunk": index + 1, "chunks": count, "items": values[index * _CHUNK:(index + 1) * _CHUNK]}, file="ai/translation/invocation.py")
    except Exception:
        return

def note(event: str, data: dict) -> None:
    """Emit one diagnostic event; trace failures are intentionally non-fatal."""
    try:
        if trace.enabled():
            trace.note(event, data, file="ai/translation/invocation.py")
    except Exception:
        return
