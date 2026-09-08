"""Immutable state shared by one API translation execution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from fastapi import Request

from backend.ai.translation.contracts import AiConfig

@dataclass(frozen=True)
class TranslationContext:
    request: Request
    payload: dict[str, Any]
    request_context: Mapping[str, Any]
    units: tuple[dict[str, Any], ...]
    target_lang: str
    config: AiConfig
    marked: str
    trace_id: str
    correlation: Mapping[str, Any]
    route_identity: Mapping[str, Any]
    requested_route: str
    resolved_provider: str
    resolved_model: str
    rate: Mapping[str, Any]
    unlimited: bool
    identity: str
    prompt_meta: Mapping[str, Any]

    @property
    def unit_count(self) -> int:
        return len(self.units)

    @property
    def char_count(self) -> int:
        return sum(len(str(unit.get("text") or "")) for unit in self.units)

