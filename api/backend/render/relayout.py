"""Orientation decisions for the Translated layer, from Lens JSON only.

Lens returns its ``translated`` layer in the ORIGINAL item boxes, so a vertical
Japanese page comes back as 90°-rotated Thai/English columns. These helpers
decide, without an image decode or provider call:

1. :func:`scan_tree_orientation` — is this tree's text vertical or horizontal?
2. :func:`relayout_decision` — does the target language want the other axis,
   and did the user leave the switch on?
"""

from __future__ import annotations

from typing import Any

from backend.render.region import (
    box_rotation_deg,
    classify_item_axis,
    direction_preset,
    paragraph_reading_axis,
)
# An item within this many degrees of 0/90 counts as axis-aligned and is
# allowed to vote on the tree's reading axis.  Anything further off the grid is
# decorative / art-aligned text and must not decide the page's orientation.
_AXIS_TOLERANCE_DEG = 12.0

# How many rotation values to keep in the debug meta (log-line friendly).
_ROTATION_SAMPLE_LIMIT = 12

def target_orientation_for_lang(target_lang: str) -> str:
    """Reading axis wanted by *target_lang* — ``"h"`` or ``"v"``.

    Mirrors :func:`backend.render.ai_tree.builder.build_ai_tree` exactly: CJK and
    ``auto`` targets are typeset vertically in manga, Thai/Latin/Cyrillic and
    unknown languages stay horizontal.

    Uses :func:`backend.render.region.direction_preset` rather than indexing
    LANGUAGE_DIRECTION, whose keys are lowercase (``zh-CN`` would miss).
    """
    preset = direction_preset(target_lang)
    if preset in ("h", "hr"):
        return "h"
    if preset in ("v", "auto"):
        return "v"
    return "h"

def _item_axis(it: dict) -> tuple[str | None, float]:
    """Reading axis of one Lens item plus its glyph size in pixels-normalised.

    Returns ``(axis, font_norm)`` where axis is ``"h"``, ``"v"`` or ``None``
    (not classifiable). ``font_norm`` is the item box height as a fraction of
    the image height — the glyph size, in both orientations, because Lens
    reports height perpendicular to the baseline.
    """
    box = it.get("box") or {}
    try:
        font_norm = float(box.get("height") or 0.0)
    except (TypeError, ValueError):
        font_norm = 0.0

    try:
        axis = classify_item_axis(it, _AXIS_TOLERANCE_DEG)
    except ValueError:
        return None, font_norm
    return (None if axis == "tilted" else axis), font_norm

def scan_tree_orientation(tree: dict | None) -> tuple[str, dict[str, Any]]:
    """Classify a Lens tree's reading axis from item geometry alone.

    Returns ``(orientation, meta)`` where orientation is ``"h"`` or ``"v"``.
    Intentionally cheap: reads only the decoded JSON and never the image, so it
    is safe to call before deciding whether to rebuild layout.

    ``meta`` reports the vote counts and a rotation sample.  A caller must NOT
    read ``orientation`` alone to conclude "this page is horizontal": when
    ``axis_items`` is 0 the vote was empty (no text, or geometry that could not
    be classified) and the ``"h"`` result is a placeholder, not evidence.
    """
    n_h = n_v = n_axis = n_items = 0
    rot_samples: list[float] = []
    if isinstance(tree, dict):
        for para in tree.get("paragraphs") or []:
            if not isinstance(para, dict):
                continue
            para_items = [
                it for it in (para.get("items") or [])
                if isinstance(it, dict) and str(it.get("text") or "").strip()
            ]
            para_axis = paragraph_reading_axis(para_items, _AXIS_TOLERANCE_DEG)
            item_axes: list[str | None] = []
            for it in para_items:
                if not isinstance(it, dict) or not str(it.get("text") or "").strip():
                    continue
                n_items += 1
                box = it.get("box") or {}
                try:
                    rot = box_rotation_deg(box)
                except ValueError:
                    rot = 0.0
                rot_samples.append(rot)
                axis, _font_norm = _item_axis(it)
                item_axes.append(axis)
            # Preserve the shared paragraph-union verdict. If every short item
            # looked horizontal alone but their complete union is a vertical
            # CJK column, relayout must see the same source axis as lens grouping.
            union_vertical = para_axis == "v" and "v" not in item_axes
            for axis in item_axes:
                if axis is None:
                    continue
                n_axis += 1
                if axis == "v" or union_vertical:
                    n_v += 1
                else:
                    n_h += 1
    orient = "v" if n_axis > 0 and n_v * 2 >= n_axis else "h"
    return orient, {
        "orientation": orient,
        "axis_items": n_axis,
        "vertical_items": n_v,
        "horizontal_items": n_h,
        "items": n_items,
        "rotation_samples": [round(x, 1) for x in rot_samples[:_ROTATION_SAMPLE_LIMIT]],
    }

def relayout_decision(
    tree: dict | None,
    target_lang: str,
    *,
    enabled: bool,
) -> tuple[bool, dict[str, Any]]:
    """Decide whether *tree* must be rebuilt for *target_lang*.

    ``enabled`` is the user's switch. Returns ``(needs_relayout, meta)``; meta
    always carries a ``reason`` so the log line explains which branch was taken
    instead of leaving a silent "nothing happened".

    Reasons:
      ``user_disabled``      — the switch is off; Lens geometry is used as-is.
      ``no_geometry``        — the orientation vote was empty (no classifiable
                               text): NOT the same thing as "horizontal page",
                               so no relayout is attempted.
      ``same_orientation``   — source and target already share an axis.
      ``direction_change``   — axes differ; rebuild the tree.
    """
    source_orientation, meta = scan_tree_orientation(tree)
    target = target_orientation_for_lang(target_lang)
    meta["target_orientation"] = target
    meta["source_orientation"] = source_orientation
    meta["enabled"] = bool(enabled)

    if not enabled:
        meta["reason"] = "user_disabled"
        return False, meta
    if int(meta.get("axis_items") or 0) <= 0:
        # Distinguish "no text" from "geometry not classifiable" — both leave
        # the vote empty, and neither justifies rotating anything.
        meta["reason"] = "no_geometry"
        return False, meta
    if source_orientation == target:
        meta["reason"] = "same_orientation"
        return False, meta
    meta["reason"] = "direction_change"
    return True, meta

