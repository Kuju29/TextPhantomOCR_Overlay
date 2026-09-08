"""Container-aware page candidate formation without transitive flood-fill."""
from __future__ import annotations

from typing import Any

from .evidence import build_boundaries, rtl, vertical_continuation
from .model import BoundaryEvidence, VerticalNode


def _compatible(node: VerticalNode, members: list[VerticalNode], image: Any) -> bool:
    """Global head agreement, but distance/pixels only between neighbours.

    All-pairs distance silently caps the number of columns. All-pairs pixel
    corridors also mistake intervening text for a border. Global head checks
    remain necessary so a chain of small steps cannot bridge balloons.
    """
    for other in members:
        glyph = max(node.glyph_px or 1., other.glyph_px or 1.)
        continuation, proven = vertical_continuation(node, other, image)
        if continuation and proven:
            continue
        overlap = min(node.bounds[3], other.bounds[3]) - max(node.bounds[1], other.bounds[1])
        if overlap <= 0. or abs(node.bounds[1] - other.bounds[1]) >= 2. * glyph:
            return False
    ordered = rtl(tuple(members) + (node,))
    index = ordered.index(node)
    neighbours = [ordered[i] for i in (index - 1, index + 1) if 0 <= i < len(ordered)]
    for other in neighbours:
        edge = build_boundaries((node, other), image)
        if edge and edge[0].hard == "separate" and "large_font_ratio" not in edge[0].reasons:
            return False
    return True


def form_candidates(
    nodes: tuple[VerticalNode, ...], image: Any = None,
) -> tuple[tuple[tuple[str, tuple[VerticalNode, ...]], ...],
           tuple[BoundaryEvidence, ...], tuple[str, ...]]:
    """Honor explicit containers; derive loose candidates by aligned envelopes.

    A node compatible with multiple established envelopes is conservatively
    kept as a singleton.  Lack of evidence for one merge is not malformed OCR
    and must never withhold the paragraph from translation.
    """
    explicit: dict[str, list[VerticalNode]] = {}
    loose = []
    for node in nodes:
        (loose if node.container_id is None else
         explicit.setdefault(node.container_id, [])).append(node)
    formed = [(key, rtl(tuple(value)))
              for key, value in sorted(explicit.items())]
    clusters: list[list[VerticalNode]] = []
    for node in rtl(tuple(loose)):
        matches = [i for i, members in enumerate(clusters)
                   if _compatible(node, members, image)]
        if len(matches) == 1:
            clusters[matches[0]].append(node)
        else:
            clusters.append([node])
    formed.extend((f"lens-{i}", tuple(members))
                  for i, members in enumerate(clusters))
    page_edges = build_boundaries(rtl(tuple(loose)), image)
    return (tuple(formed),
            tuple(edge for edge in page_edges if edge.hard == "separate"),
            ())
