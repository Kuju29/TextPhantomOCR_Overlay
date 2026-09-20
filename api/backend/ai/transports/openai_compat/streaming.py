"""Streaming helpers shared by OpenAI-compatible transports."""
from __future__ import annotations

import json
from decimal import Decimal
from backend.ai import wire_trace


class JsonObjectCompletionDetector:
    """Validate the complete, flat JSON translation contract."""
    def __init__(self, expected_ids: list[str] | None) -> None:
        self.expected = list(expected_ids or [])
        self.first_all_ids_ms: float | None = None
        self.full_inspections = 0

    def inspect(self, content: str, elapsed_ms: float) -> str | None:
        self.full_inspections += 1
        if not self.expected:
            return None
        source = str(content or "").strip()
        if not source.startswith("{") or not source.endswith("}"):
            return None
        try:
            pairs = json.loads(source, parse_float=Decimal,
                               object_pairs_hook=lambda items: items)
        except (TypeError, ValueError):
            return None
        if (not isinstance(pairs, list)
                or len(pairs) != len(self.expected)
                or not all(isinstance(pair, tuple) and len(pair) == 2
                           for pair in pairs)):
            return None
        keys = [pair[0] for pair in pairs]
        values = [pair[1] for pair in pairs]
        if (len(set(keys)) != len(keys)
                or set(keys) != set(self.expected)
                or not all(isinstance(item, str) and item.strip()
                           for item in values)):
            return None
        if self.first_all_ids_ms is None:
            self.first_all_ids_ms = elapsed_ms
        return "all_json_fields_closed"


class JsonClosureGate:
    """Incrementally find a root ``}`` outside JSON strings."""
    def __init__(self) -> None:
        self.depth = 0
        self.started = False
        self.closed = False
        self.in_string = False
        self.escaped = False

    def feed(self, chunk: str) -> bool:
        if self.closed:
            return False
        for char in str(chunk or ""):
            if self.in_string:
                if self.escaped:
                    self.escaped = False
                elif char == "\\":
                    self.escaped = True
                elif char == '"':
                    self.in_string = False
                continue
            if char == '"':
                self.in_string = True
            elif char == "{":
                self.started = True
                self.depth += 1
            elif char == "}" and self.started:
                self.depth -= 1
                if self.depth == 0:
                    self.closed = True
                    return True
        return False


class WireStreamCapture:
    """Bound memory/filesystem work for an opt-in SSE wire trace."""
    def __init__(self, *, max_lines: int = 32, max_chars: int = 64 * 1024) -> None:
        self.max_lines = max(1, max_lines)
        self.max_chars = max(1024, max_chars)
        self._raw: list[str] = []
        self._raw_chars = 0

    def raw(self, value: str) -> None:
        text = str(value)
        self._raw.append(text)
        self._raw_chars += len(text)
        if len(self._raw) >= self.max_lines or self._raw_chars >= self.max_chars:
            self.flush_raw()

    def flush_raw(self) -> None:
        if not self._raw:
            return
        value = "".join(self._raw)
        wire_trace.append_text("05_provider_response.raw", value)
        self._raw.clear()
        self._raw_chars = 0

    def finish(self, assembled: str) -> None:
        self.flush_raw()
        wire_trace.assembled_response(assembled)


def merge_usage(target, incoming):
    for key, value in incoming.items():
        if value is None:
            continue
        if isinstance(value, dict):
            child = target.get(key)
            if not isinstance(child, dict):
                child = {}
            merge_usage(child, value)
            target[key] = child
        else:
            target[key] = value
