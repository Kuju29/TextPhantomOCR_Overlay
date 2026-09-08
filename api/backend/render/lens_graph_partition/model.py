"""Value contracts for the Lens graph partitioner."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Rect = tuple[float, float, float, float]
Role = Literal["dialogue", "ruby", "sfx", "punctuation", "unknown"]


@dataclass(frozen=True)
class VerticalNode:
    paragraph_id: str
    paragraph_index: int
    bounds: Rect | None
    text: str
    glyph_px: float | None
    role: Role = "unknown"
    item_bounds: tuple[Rect, ...] = ()
    container_id: str | None = None


@dataclass(frozen=True)
class RubyAttachment:
    ruby_id: str
    base_id: str
    reason: str


@dataclass(frozen=True)
class PixelEvidence:
    known: bool
    line_strength: float = 0.0
    whitespace_strength: float = 0.0
    contrast: float = 0.0
    reason: str = ""


@dataclass(frozen=True)
class BoundaryEvidence:
    right_id: str
    left_id: str
    gap_z: float
    head_z: float
    font_z: float
    overlap: float
    line_strength: float
    whitespace_strength: float
    hard: Literal["same", "separate", "none"]
    keep_score: float
    cut_score: float
    reasons: tuple[str, ...] = ()
    gap_glyph: float = 0.0
    head_glyph: float = 0.0
    font_ratio: float = 1.0
    x_overlap_glyph: float = 0.0
    pixel_known: bool = False


@dataclass(frozen=True)
class CandidateTrace:
    node_ids: tuple[str, ...]
    role_ids: tuple[tuple[str, Role], ...]
    boundaries: tuple[BoundaryEvidence, ...]
    best_groups: tuple[tuple[str, ...], ...]
    runner_up_groups: tuple[tuple[str, ...], ...]
    best_score: float
    runner_up_score: float
    margin: float
    candidate_id: str = "page"
    status: Literal["resolved", "unresolved"] = "resolved"
    unresolved_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class GroupingResult:
    status: Literal["resolved", "unresolved"]
    groups: tuple[tuple[str, ...], ...]
    ruby: tuple[RubyAttachment, ...] = ()
    excluded: tuple[tuple[str, str], ...] = ()
    unresolved_ids: tuple[str, ...] = ()
    reason: str = ""
    trace: CandidateTrace | None = None
    errors: tuple[str, ...] = field(default_factory=tuple)
    traces: tuple[CandidateTrace, ...] = ()
    retention_conflicts: tuple[str, ...] = ()
