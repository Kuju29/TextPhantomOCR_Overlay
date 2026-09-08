"""Orientation-matching relayout — turn a Lens tree into the target's axis.

Why this module exists
---------------------
Google Lens returns its ``translated`` layer by re-labelling the **original**
item boxes: the geometry stays exactly where the source glyphs were.  For a
vertical Japanese page that means the Thai/English translation is handed back
in 90°-rotated columns — technically positioned correctly, visually unreadable.

``lens_text.ai`` already solves this by discarding Lens geometry and building
fresh boxes with :func:`backend.render.ai_tree.builder.build_ai_tree`.  But AI
needs an API key and a token budget, so users without quota fall back to
``lens_text.translated`` and get the unreadable rotated columns.

The insight is that ``build_ai_tree`` is not AI-specific at all: it maps
*(bubble groups, one text per group, target language)* onto *(new item boxes at
the target orientation)*.  Feeding it the **translated tree's own** bubble
groups and each group's own Lens text therefore produces exactly the same
relayout for the machine translation, with no provider call.

Contract
--------
Two orientation decisions are cheap and made from Lens JSON only (no image
decode or provider call):

1. :func:`scan_tree_orientation` — is this tree's text vertical or horizontal?
2. :func:`relayout_decision` — does the target language want the other axis,
   and did the user leave the switch on?

The shared Lens graph partition happens upstream for every page. Only when the
answer is yes does the caller rebuild boxes with
:func:`rebuild_tree_for_target`; same-orientation pages keep the untouched Lens
geometry.
"""

from __future__ import annotations

from typing import Any

from backend.render.ai_tree.builder import build_ai_tree
from backend.render.region import (
    box_rotation_deg,
    classify_item_axis,
    direction_preset,
    is_cjk_text,
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
    LANGUAGE_DIRECTION: this used to key the lowercase table with a Lens-cased
    code, so ``zh-CN`` fell through to the horizontal default and a vertical
    Chinese page was relaid out flat while an identical Japanese one was left
    alone.
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

def _merge_rects(rects: list[tuple[float, float, float, float]]) -> list[tuple[float, float, float, float]]:
    """Union every group of touching/overlapping rectangles. O(n^2), n is tiny."""
    out: list[list[float]] = []
    for r in rects:
        cur = [float(r[0]), float(r[1]), float(r[2]), float(r[3])]
        merged = True
        while merged:
            merged = False
            for other in list(out):
                if (
                    cur[0] < other[2] and other[0] < cur[2]
                    and cur[1] < other[3] and other[1] < cur[3]
                ):
                    cur = [
                        min(cur[0], other[0]), min(cur[1], other[1]),
                        max(cur[2], other[2]), max(cur[3], other[3]),
                    ]
                    out.remove(other)
                    merged = True
        out.append(cur)
    return [(r[0], r[1], r[2], r[3]) for r in out]

def build_vertical_rois(
    tree: dict | None,
    img_w: int,
    img_h: int,
    *,
    margin_ratio: float = 0.15,
) -> list[tuple[float, float, float, float]]:
    """Regions of the page that Lens says contain vertical text.

    Legacy-compatible regions derived from vertical Lens items. Each item's
    bounds are padded by two glyph heights, or ``margin_ratio`` of the region's
    own size, whichever is larger, and overlapping regions are merged. Current
    graph partitioning does not consume these regions.

    Returns ``[]`` when there is no vertical text.
    """
    if not isinstance(tree, dict) or img_w <= 0 or img_h <= 0:
        return []
    padded: list[tuple[float, float, float, float]] = []
    for para in tree.get("paragraphs") or []:
        if not isinstance(para, dict):
            continue
        para_items = para.get("items") or []
        para_vertical = paragraph_reading_axis(para_items) == "v"
        for it in para_items:
            if not isinstance(it, dict) or not str(it.get("text") or "").strip():
                continue
            axis, font_norm = _item_axis(it)
            # When a column is fragmented into short upright CJK items, the
            # paragraph union supplies the vertical evidence. Include those
            # members in the ROI without treating unrelated Latin labels as v.
            if axis != "v" and not (para_vertical and axis == "h" and is_cjk_text(str(it.get("text") or ""))):
                continue
            bpx = it.get("bounds_px")
            if not (isinstance(bpx, (list, tuple)) and len(bpx) == 4):
                continue
            try:
                x1, y1, x2, y2 = (float(v) for v in bpx)
            except (TypeError, ValueError):
                continue
            if x2 <= x1 or y2 <= y1:
                continue
            font_px = max(0.0, font_norm * img_h)
            margin = max(font_px * 2.0, min(x2 - x1, y2 - y1) * margin_ratio, 12.0)
            padded.append((
                max(0.0, x1 - margin),
                max(0.0, y1 - margin),
                min(float(img_w), x2 + margin),
                min(float(img_h), y2 + margin),
            ))
    if not padded:
        return []
    return _merge_rects(padded)

def rebuild_tree_for_target(
    tree: dict | None,
    target_lang: str,
    img_w: int,
    img_h: int,
) -> dict[str, Any] | None:
    """Rebuild *tree* with fresh boxes at the target language's orientation.

    Requires ``tree["bubble_groups"]`` (see
    canonical detector-free grouping service) — each group's
    own ``text`` is what gets re-laid out, so the caller must pass the tree
    whose text it wants rendered (the *translated* tree for Lens MT).

    Returns ``None`` when there are no groups to work with, so the caller can
    keep the original tree instead of rendering an empty layer. The returned
    tree keeps ``side == "Ai"``: that is the flag
    :func:`backend.render.html.overlay.render_tree_overlay` uses to select the
    deterministic bubble-block renderer, which is the whole point of rebuilding
    the geometry. Pass ``target_lang`` to the renderer for this tree.
    """
    if not isinstance(tree, dict):
        return None
    groups = tree.get("bubble_groups") or []
    if not groups:
        return None
    group_texts = [str(bg.get("text") or "") for bg in groups]
    if not any(t.strip() for t in group_texts):
        return None
    rebuilt = build_ai_tree(groups, group_texts, tree, target_lang, img_w, img_h)
    if not (rebuilt.get("paragraphs") or []):
        return None
    # Provenance so a debug dump shows this is a relaid-out Lens layer rather
    # than an AI translation that happens to sit in the translated slot.
    rebuilt["relayout"] = {"from": str(tree.get("side") or ""), "engine": "build_ai_tree"}
    return rebuilt
