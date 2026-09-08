"""Immutable, detector-agnostic vertical grouping for Lens OCR geometry."""

from .model import BoundaryEvidence, GroupingResult, VerticalNode
from .pipeline import partition_vertical_lens

__all__ = ["BoundaryEvidence", "GroupingResult", "VerticalNode",
           "partition_vertical_lens"]
