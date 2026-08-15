"""Decode Google Lens OCR data into the structured "tree" the renderer uses.


Tree shape::

    {
      "side": "original" | "translated" | "Ai",
      "paragraphs": [
        {
          "side", "para_index", "start_raw", "end_raw", "text", "valid_text",
          "bounds_px",
          "items": [
            {
              "side", "para_index", "item_index", "start_raw", "end_raw",
              "text", "valid_text", "height_raw",
              "baseline_p1": {"x", "y"}, "baseline_p2": {"x", "y"},
              "box": {...},  "bounds_px",
              "spans": [ { ...span fields..., "box": {...} }, ... ]
            }, ...
          ]
        }, ...
      ]
    }

Each paragraph's geometry is a *polyline*: items carry their own straight
baseline, so a curved line of text is approximated by several items at
slightly different angles.  This is why curve handling (see
``backend.render.curve``) reconstructs curvature from neighbouring items.
"""

from __future__ import annotations

import base64
import math
from typing import Any

from backend.lens import proto
from backend.render.geometry import (
    normalize_angle_deg,
    token_box_quad_px,
)

# A side label identifies which translation layer a tree belongs to.
Side = str


# Every reason this decode can drop something, so a count is never anonymous.
# Kept as an explicit tuple rather than accumulated on demand: a reason that
# only appears in the output when it fires is a reason nobody knows to look for.
#
# Every one of these is REACHABLE — `api/tests/test_lens_tree.py` fires all five
# off the shared fixture. A counter that can never move is worse than no
# counter: it reads as "this never happens" when it means "this cannot be seen".
# Three earlier candidates (`item_no_geometry`, `item_text_out_of_range`,
# `paragraph_text_out_of_range`) turned out to be unreachable given what
# `is_item_message` already guarantees, so they are assertions now — see
# `_impossible` below.
DROP_REASONS = (
    "item_unusable_geometry",
    "item_degenerate_baseline",
    "span_no_end",
    "span_no_position",
    "span_text_out_of_range",
)


class LensTreeInvariantError(RuntimeError):
    """Raised when the decode reaches a state its own guards rule out.

    Not a bad-input error — bad input has a counter. This means two functions
    in this module disagree about what a well-formed item is, which is a code
    bug, and a code bug that silently produced an empty string here would land
    as "a bubble came out blank" three layers downstream.
    """


def _impossible(what: str) -> None:
    raise LensTreeInvariantError(what)


def _empty_diagnostics() -> dict[str, Any]:
    return {
        "drops": dict.fromkeys(DROP_REASONS, 0),
        "deepWalkParagraphs": 0,
        "exhaustedParagraphs": 0,
    }


def _slice_text(full_text: str, start: int | None, end: int | None) -> str | None:
    """Slice ``full_text[start:end]``, or ``None`` when the range is unusable.

    This used to return ``""`` on a bad range, which is what made a bad Lens
    offset indistinguishable from a genuinely empty paragraph. The rendered
    result is the same empty string either way; the difference is that the
    caller can now count it and say so.
    """
    if start is None or end is None:
        return None
    if start < 0 or end < 0 or start > end or end > len(full_text):
        return None
    return full_text[start:end]


def _range_min_max(ranges: list[tuple[int, int]]) -> tuple[int | None, int | None]:
    """Return ``(min start, max end)`` over a list of ``(start, end)`` ranges."""
    if not ranges:
        return None, None
    return min(r[0] for r in ranges), max(r[1] for r in ranges)


def decode_tree(
    paragraphs_b64: list[str],
    full_text: str,
    side: Side,
    img_w: int,
    img_h: int,
) -> dict[str, Any]:
    """Build a render tree from Lens ``paragraphs`` (base64 protobuf) + text.

    ``full_text`` is the concatenated text the span ranges index into.
    ``side`` labels the layer (``original`` / ``translated``).

    The returned tree carries a ``diagnostics`` block counting everything this
    decode skipped, by reason. Lens does send malformed items and there is
    nothing to draw for them — but a page that quietly loses four of its eleven
    paragraphs still renders, still looks like a translated page, and reads as
    "the AI dropped some bubbles" or "the renderer is clipping": two wrong
    files to go looking in.

    Mirrored byte for byte by ``src/shared/lens-tree.js`` and pinned to
    ``api/tests/fixtures/lens_tree.json``.
    """
    paragraphs: list[dict[str, Any]] = []
    cursor = 0
    diagnostics = _empty_diagnostics()

    def bump(reason: str) -> None:
        diagnostics["drops"][reason] += 1

    for para_index, b64s in enumerate(paragraphs_b64):
        par_bytes = base64.b64decode(b64s)
        found = proto.extract_items_from_paragraph(par_bytes)
        item_msgs = found.items
        if found.deep:
            diagnostics["deepWalkParagraphs"] += 1
        if found.exhausted:
            diagnostics["exhaustedParagraphs"] += 1

        items: list[dict[str, Any]] = []
        para_ranges: list[tuple[int, int]] = []
        para_bounds: tuple[float, float, float, float] | None = None

        for item_index, item_bytes in enumerate(item_msgs):
            geom_bytes, spans_bytes = proto.extract_item_geom_spans(item_bytes)
            if geom_bytes is None:
                # `is_item_message` only calls something an item when it has a
                # field-1 sub-message, and that is the same field this reads.
                _impossible("an item message reached decode_tree with no geometry field")

            p1, p2, height_norm = proto.get_points_from_geom(geom_bytes)
            if p1 is None or p2 is None or height_norm is None:
                bump("item_unusable_geometry")
                continue

            x1n, y1n = p1
            x2n, y2n = p2
            x1, y1 = x1n * img_w, y1n * img_h
            x2, y2 = x2n * img_w, y2n * img_h

            dx, dy = x2 - x1, y2 - y1
            # Normalise baseline direction (left -> right, or top -> bottom).
            if dx < 0 or (abs(dx) < 1e-12 and dy < 0):
                x1, y1, x2, y2 = x2, y2, x1, y1
                x1n, y1n, x2n, y2n = x2n, y2n, x1n, y1n
                dx, dy = x2 - x1, y2 - y1

            length = math.hypot(dx, dy)
            if length <= 1e-12:
                bump("item_degenerate_baseline")
                continue

            ux, uy = dx / length, dy / length
            angle_deg = normalize_angle_deg(math.degrees(math.atan2(dy, dx)))
            height_px = height_norm * img_h

            item_spans: list[dict[str, Any]] = []
            item_ranges: list[tuple[int, int]] = []
            item_bounds: tuple[float, float, float, float] | None = None

            for span_index, span_bytes in enumerate(spans_bytes):
                start, end, t0, t1 = proto.extract_span(span_bytes)

                if start is None:
                    start = cursor
                else:
                    cursor = max(cursor, start)
                if end is None:
                    bump("span_no_end")
                    continue
                cursor = max(cursor, end)

                if t0 is None and t1 is None:
                    bump("span_no_position")
                    continue
                t0 = 0.0 if t0 is None else t0
                t1 = 1.0 if t1 is None else t1

                sliced = _slice_text(full_text, start, end)
                if sliced is None:
                    bump("span_text_out_of_range")
                span_text = "" if sliced is None else sliced
                valid_text = span_text.strip() != ""
                if valid_text:
                    item_ranges.append((start, end))

                # Span endpoints along the baseline.
                e1x = x1 + ux * (t0 * length)
                e1y = y1 + uy * (t0 * length)
                e2x = x1 + ux * (t1 * length)
                e2y = y1 + uy * (t1 * length)
                cx = (e1x + e2x) / 2.0
                cy = (e1y + e2y) / 2.0

                width_px = abs(t1 - t0) * length
                left_px = cx - width_px / 2.0
                top_px = cy - height_px / 2.0
                left = left_px / img_w
                top = top_px / img_h
                width = width_px / img_w
                height = height_px / img_h

                span_node: dict[str, Any] = {
                    "side": side,
                    "para_index": para_index,
                    "item_index": item_index,
                    "span_index": span_index,
                    "start_raw": start,
                    "end_raw": end,
                    "t0_raw": t0,
                    "t1_raw": t1,
                    "height_raw": height_norm,
                    "baseline_p1": {"x": x1n, "y": y1n},
                    "baseline_p2": {"x": x2n, "y": y2n},
                    "box": {
                        "left": left,
                        "top": top,
                        "width": width,
                        "height": height,
                        "rotation_deg": angle_deg,
                        "rotation_deg_css": angle_deg,
                        "center": {"x": cx / img_w, "y": cy / img_h},
                        "left_pct": left * 100.0,
                        "top_pct": top * 100.0,
                        "width_pct": width * 100.0,
                        "height_pct": height * 100.0,
                    },
                    "text": span_text,
                    "valid_text": valid_text,
                }

                quad = token_box_quad_px(span_node, img_w, img_h, pad_px=0)
                if quad:
                    xs = [p[0] for p in quad]
                    ys = [p[1] for p in quad]
                    b = (min(xs), min(ys), max(xs), max(ys))
                    item_bounds = (
                        b
                        if item_bounds is None
                        else (
                            min(item_bounds[0], b[0]),
                            min(item_bounds[1], b[1]),
                            max(item_bounds[2], b[2]),
                            max(item_bounds[3], b[3]),
                        )
                    )
                item_spans.append(span_node)

            s0, s1 = _range_min_max(item_ranges)
            item_text = ""
            if s0 is not None:
                # `item_ranges` only ever holds ranges that already sliced
                # cleanly, and [min start, max end] over those is still inside
                # the text — so a None here is a broken invariant, not bad input.
                sliced = _slice_text(full_text, s0, s1)
                if sliced is None:
                    _impossible(f"item range {s0}..{s1} escaped a set of validated ranges")
                item_text = sliced.strip()  # type: ignore[union-attr]
                para_ranges.append((s0, s1))  # type: ignore[arg-type]

            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            item_box = {
                "left": (cx - length / 2.0) / img_w,
                "top": (cy - height_px / 2.0) / img_h,
                "width": length / img_w,
                "height": height_px / img_h,
                "rotation_deg": angle_deg,
                "rotation_deg_css": angle_deg,
                "center": {"x": cx / img_w, "y": cy / img_h},
            }

            if item_bounds is not None:
                para_bounds = (
                    item_bounds
                    if para_bounds is None
                    else (
                        min(para_bounds[0], item_bounds[0]),
                        min(para_bounds[1], item_bounds[1]),
                        max(para_bounds[2], item_bounds[2]),
                        max(para_bounds[3], item_bounds[3]),
                    )
                )

            items.append(
                {
                    "side": side,
                    "para_index": para_index,
                    "item_index": item_index,
                    "start_raw": s0,
                    "end_raw": s1,
                    "text": item_text,
                    "valid_text": item_text.strip() != "",
                    "height_raw": height_norm,
                    "baseline_p1": {"x": x1n, "y": y1n},
                    "baseline_p2": {"x": x2n, "y": y2n},
                    "box": item_box,
                    "bounds_px": item_bounds,
                    "spans": item_spans,
                }
            )

        p0, p1 = _range_min_max(para_ranges)
        para_text = ""
        if p0 is not None:
            sliced = _slice_text(full_text, p0, p1)
            if sliced is None:
                _impossible(f"paragraph range {p0}..{p1} escaped a set of validated ranges")
            para_text = sliced.strip()  # type: ignore[union-attr]
        paragraphs.append(
            {
                "side": side,
                "para_index": para_index,
                "start_raw": p0,
                "end_raw": p1,
                "text": para_text,
                "valid_text": para_text.strip() != "",
                "bounds_px": para_bounds,
                "items": items,
            }
        )

    return {"side": side, "paragraphs": paragraphs, "diagnostics": diagnostics}


def tree_warnings(tree: dict | None) -> list[str]:
    """The drops worth telling somebody about, as human-readable lines.

    An empty list means nothing was dropped — which is the common case, and is
    worth being able to assert.
    """
    diagnostics = (tree or {}).get("diagnostics")
    if not isinstance(diagnostics, dict):
        return []
    out: list[str] = []
    for reason, count in (diagnostics.get("drops") or {}).items():
        if count > 0:
            out.append(f"dropped {count} × {reason}")
    deep = int(diagnostics.get("deepWalkParagraphs") or 0)
    if deep > 0:
        out.append(
            f"{deep} paragraph(s) needed the deep item walk — "
            "Lens nested its items deeper than the shallow pass expects"
        )
    exhausted = int(diagnostics.get("exhaustedParagraphs") or 0)
    if exhausted > 0:
        out.append(
            f"{exhausted} paragraph(s) hit the 20,000-node walk budget — "
            "items past that point were NOT read"
        )
    return out


# --- Tree traversal helpers ------------------------------------------------

def iter_paragraphs(tree: dict | None) -> list[tuple[int, dict]]:
    """Yield ``(index, paragraph)`` pairs for a tree (safe on bad input)."""
    if not isinstance(tree, dict):
        return []
    out: list[tuple[int, dict]] = []
    for i, p in enumerate(tree.get("paragraphs") or []):
        if isinstance(p, dict):
            out.append((i, p))
    return out


def flatten_spans(tree: dict | None) -> list[dict]:
    """Collect every span node across all paragraphs / items."""
    spans: list[dict] = []
    for _, p in iter_paragraphs(tree):
        for it in p.get("items") or []:
            spans.extend(it.get("spans") or [])
    return spans


def spans_for_paragraphs(tree: dict | None, indices) -> list[dict]:
    """Every span node belonging to these paragraph indices."""
    want = {int(i) for i in (indices or [])}
    if not want:
        return []
    spans: list[dict] = []
    for index, para in iter_paragraphs(tree):
        if index not in want:
            continue
        for item in para.get("items") or []:
            spans.extend(item.get("spans") or [])
    return spans


def paragraph_texts(tree: dict | None) -> list[str]:
    """Return one text string per paragraph.

    Prefers the paragraph's own ``text``; if empty, joins its items' texts.
    """
    out: list[str] = []
    for _, p in iter_paragraphs(tree):
        text = str(p.get("text") or "").strip()
        if not text:
            items = p.get("items") or []
            text = " ".join(
                str(it.get("text") or "").strip()
                for it in items
                if isinstance(it, dict) and str(it.get("text") or "").strip()
            )
        out.append(text)
    return out


def tree_stats(tree: dict | None) -> dict[str, int]:
    """Return ``{paras, items, spans}`` counts — used for debug logging."""
    paras = items = spans = 0
    for _, p in iter_paragraphs(tree):
        paras += 1
        for it in p.get("items") or []:
            if not isinstance(it, dict):
                continue
            items += 1
            spans += len(it.get("spans") or [])
    return {"paras": paras, "items": items, "spans": spans}
