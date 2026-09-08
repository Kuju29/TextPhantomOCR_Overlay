"""Allowlisted diagnostic metadata; never accept OCR, credentials or raw errors."""
from __future__ import annotations

from typing import Any


def counter(value: Any, maximum: int = 10**13) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum:
        return value
    return None


def shipping_metadata(value: Any) -> dict:
    if not isinstance(value, dict) or value.get("schema") != "tp.trace-shipping/1":
        return {}
    state = value.get("state")
    if state not in {"active", "backoff", "disabled", "unnegotiated"}:
        return {}
    out = {"schema": "tp.trace-shipping/1", "state": state}
    for section, keys in {
        "transport": ("attempts", "acknowledged", "totalFailures", "consecutiveFailures",
                      "lastStatus", "failedAt", "ackAt", "ackSequence", "retryAt"),
        "buffer": ("queued", "dropped"),
    }.items():
        source = value.get(section)
        if not isinstance(source, dict):
            continue
        clean = {k: source[k] for k in keys if counter(source.get(k)) is not None}
        if section == "transport" and source.get("lastCode") in {
            "", "network_error", "http_error", "deadline_exceeded", "invalid_ack",
            "trace_disabled", "session_mismatch", "no_api_base",
        }:
            clean["lastCode"] = source["lastCode"]
        if section == "transport" and source.get("lastStage") in {"", "base", "signature", "http", "ack", "session"}:
            clean["lastStage"] = source["lastStage"]
        out[section] = clean
    return out

