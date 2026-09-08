"""Global contiguous partition with explicit uncertainty."""
from __future__ import annotations

from .evidence import rtl
from .model import BoundaryEvidence, VerticalNode


def solve(nodes: tuple[VerticalNode, ...], boundaries: tuple[BoundaryEvidence, ...]
          ) -> tuple[tuple[tuple[str, ...], ...], tuple[tuple[str, ...], ...], float, float]:
    """Return best and runner-up partitions by enumerating boundary decisions.

    Vertical candidates are normally small.  A bounded beam keeps complexity
    linear in nodes while retaining the two alternatives needed for confidence.
    """
    ordered = rtl(nodes)
    if not ordered:
        return (), (), 0.0, float("-inf")
    states = [(((ordered[0].paragraph_id,),), 0.0)]
    for boundary, node in zip(boundaries, ordered[1:]):
        nxt = []
        for groups, score in states:
            if boundary.hard != "separate":
                merged = groups[:-1] + (groups[-1] + (node.paragraph_id,),)
                nxt.append((merged, score + boundary.keep_score))
            if boundary.hard != "same":
                nxt.append((groups + ((node.paragraph_id,),),
                            score + boundary.cut_score))
        states = sorted(nxt, key=lambda item: (-item[1], item[0]))[:32]
    best = states[0]
    runner = states[1] if len(states) > 1 else ((), float("-inf"))
    return best[0], runner[0], best[1], runner[1]
