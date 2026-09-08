"""Partition conservation and ordering checks."""
from __future__ import annotations

from .model import VerticalNode


def validate(nodes: tuple[VerticalNode, ...], groups: tuple[tuple[str, ...], ...]
             ) -> tuple[str, ...]:
    expected = [node.paragraph_id for node in nodes]
    actual = [node_id for group in groups for node_id in group]
    errors = []
    if len(actual) != len(set(actual)):
        errors.append("duplicate_membership")
    if set(actual) != set(expected):
        errors.append("membership_not_conserved")
    return tuple(errors)
