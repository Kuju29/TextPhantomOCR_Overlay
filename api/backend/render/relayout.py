"""Orientation-matching relayout — turn a Lens tree into the target's axis.

STATUS: ACTIVE — in use in the current flow.

Why this module exists
---------------------
Google Lens returns its ``translated`` layer by re-labelling the **original**
item boxes: the geometry stays exactly where the source glyphs were.  For a
vertical Japanese page that means the Thai/English translation is handed back
in 90°-rotated columns — technically positioned correctly, visually unreadable.

``lens_text.ai`` already solves this by discarding Lens geometry and building
fresh boxes with :func:`backend.render.build_ai_tree.build_ai_tree`.  But AI
needs an API key and a token budget, so users without quota fall back to
``lens_text.translated`` and get the unreadable rotated columns.

The insight is that ``build_ai_tree`` is not AI-specific at all: it maps
*(bubble groups, one text per group, target language)* onto *(new item boxes at
the target orientation)*.  Feeding it the **translated tree's own** bubble
groups and each group's own Lens text therefore produces exactly the same
relayout for the machine translation, with no provider call.

Contract
--------
Two decisions, both cheap and both made from Lens JSON only (no image decode,
no ONNX):

1. :func:`scan_tree_orientation` — is this tree's text vertical or horizontal?
2. :func:`relayout_decision` — does the target language want the other axis,
   and did the user leave the switch on?

Only when the answer is yes does the caller pay for grouping / bubble
detection and call :func:`rebuild_tree_for_target`.  Same-orientation pages
keep the untouched Lens fast path.
"""

from __future__ import annotations

from typing import Any

from backend.render.build_ai_tree import build_ai_tree
from backend.render.region import direction_preset

# An item within this many degrees of 0/90 counts as axis-aligned and is
# allowed to vote on the tree's reading axis.  Anything further off the grid is
# decorative / art-aligned text and must not decide the page's orientation.
_AXIS_TOLERANCE_DEG = 12.0

# Portrait ratio at which a rotation-less Lens item still votes vertical.
# Lens sometimes omits ``rotation_deg``; a text box more than this much taller
# than it is wide can only be a vertical column.
_PORTRAIT_RATIO = 2.2

# How many rotation values to keep in the debug meta (log-line friendly).
_ROTATION_SAMPLE_LIMIT = 12


def target_orientation_for_lang(target_lang: str) -> str:
    """Reading axis wanted by *target_lang* — ``"h"`` or ``"v"``.

    Mirrors :func:`backend.render.build_ai_tree.build_ai_tree` exactly: CJK and
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
        rot = float(box.get("rotation_deg") or box.get("rotation_deg_css") or 0.0)
    except (TypeError, ValueError):
        rot = 0.0
    try:
        font_norm = float(box.get("height") or 0.0)
    except (TypeError, ValueError):
        font_norm = 0.0

    residual = ((rot + 45.0) % 90.0) - 45.0
    if abs(residual) <= _AXIS_TOLERANCE_DEG:
        r_mod = rot % 180.0
        if r_mod > 90.0:
            r_mod -= 180.0
        return ("v" if abs(r_mod) > 45.0 else "h"), font_norm

    bpx = it.get("bounds_px")
    if isinstance(bpx, (list, tuple)) and len(bpx) == 4:
        try:
            w = float(bpx[2]) - float(bpx[0])
            h = float(bpx[3]) - float(bpx[1])
        except (TypeError, ValueError):
            w = h = 0.0
        if w > 0 and h > _PORTRAIT_RATIO * w:
            return "v", font_norm
    return None, font_norm


def scan_tree_orientation(tree: dict | None) -> tuple[str, dict[str, Any]]:
    """Classify a Lens tree's reading axis from item geometry alone.

    Returns ``(orientation, meta)`` where orientation is ``"h"`` or ``"v"``.
    Intentionally cheap: reads only the decoded JSON, never the image and never
    ONNX, so it is safe to call before deciding whether to do expensive work.

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
            for it in para.get("items") or []:
                if not isinstance(it, dict) or not str(it.get("text") or "").strip():
                    continue
                n_items += 1
                box = it.get("box") or {}
                try:
                    rot = float(box.get("rotation_deg") or box.get("rotation_deg_css") or 0.0)
                except (TypeError, ValueError):
                    rot = 0.0
                rot_samples.append(rot)
                residual = ((rot + 45.0) % 90.0) - 45.0
                if abs(residual) <= _AXIS_TOLERANCE_DEG:
                    n_axis += 1
                    r_mod = rot % 180.0
                    if r_mod > 90.0:
                        r_mod -= 180.0
                    if abs(r_mod) > 45.0:
                        n_v += 1
                    else:
                        n_h += 1
                    continue
                # Rotation missing/unusable — a clearly portrait text box is
                # still unambiguous evidence of a vertical column.
                bpx = it.get("bounds_px")
                if isinstance(bpx, (list, tuple)) and len(bpx) == 4:
                    try:
                        w = float(bpx[2]) - float(bpx[0])
                        h = float(bpx[3]) - float(bpx[1])
                    except (TypeError, ValueError):
                        w = h = 0.0
                    if w > 0 and h > _PORTRAIT_RATIO * w:
                        n_axis += 1
                        n_v += 1
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

    Used to crop the input for the text-block model instead of feeding it the
    whole page. Each vertical item's bounds are padded (by two glyph heights,
    or ``margin_ratio`` of the region's own size, whichever is larger) so the
    crop keeps the surrounding bubble outline, then overlapping regions are
    merged.

    IMPORTANT — this does NOT make inference cheaper. The detector resizes any
    input to a fixed 1280x1280, so one crop costs exactly as much as one full
    page, and N crops cost N times as much. The reason to crop is RESOLUTION:
    a small vertical column blown up to 1280 is far easier for the model to
    read than the same column inside a downscaled full page. Callers must apply
    their own budget for how many crops are worth it (see
    :func:`backend.render.textblocks.detect_text_blocks_in_rois`).

    Returns ``[]`` when there is no vertical text — the caller should then run
    on the full page (or, better, not run the detector at all).
    """
    if not isinstance(tree, dict) or img_w <= 0 or img_h <= 0:
        return []
    padded: list[tuple[float, float, float, float]] = []
    for para in tree.get("paragraphs") or []:
        if not isinstance(para, dict):
            continue
        for it in para.get("items") or []:
            if not isinstance(it, dict) or not str(it.get("text") or "").strip():
                continue
            axis, font_norm = _item_axis(it)
            if axis != "v":
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


def normalize_group_rotation_signs(tree: dict | None) -> int:
    """Make every column inside one bubble face the same way.

    Lens decodes a near-vertical baseline as ``+90`` or ``-90`` depending on
    which side of exactly 90 degrees the column happens to fall — a difference
    of a fraction of a degree in the artwork. Two columns of the SAME sentence
    can therefore come back with opposite signs, and the renderer faithfully
    draws one top-to-bottom and its neighbour bottom-to-top.

    The fix is per bubble group, not per page: a page may legitimately contain
    text at genuinely different angles, but two columns the grouper decided
    belong to one utterance cannot. Each group votes (by count, ties going to
    the sign of the largest-magnitude rotation) and the minority columns are
    flipped by 180 degrees, which points them the same way while keeping the
    exact tilt off the axis.

    Only near-vertical groups are touched. Returns the number of items flipped.
    """
    if not isinstance(tree, dict):
        return 0
    by_index: dict[int, dict] = {
        int(p.get("para_index", i)): p
        for i, p in enumerate(tree.get("paragraphs") or [])
        if isinstance(p, dict)
    }
    flipped = 0
    for bg in tree.get("bubble_groups") or []:
        if not isinstance(bg, dict) or str(bg.get("direction") or "h") != "v":
            continue
        items: list[dict] = []
        for pi in bg.get("para_indices") or []:
            para = by_index.get(int(pi))
            if para is None:
                continue
            items.extend(
                it for it in (para.get("items") or [])
                if isinstance(it, dict) and str(it.get("text") or "").strip()
            )
        rots: list[float] = []
        for it in items:
            box = it.get("box") or {}
            try:
                rots.append(float(box.get("rotation_deg") or box.get("rotation_deg_css") or 0.0))
            except (TypeError, ValueError):
                rots.append(0.0)
        # Only act when the group really is split across the +/-90 boundary.
        pos = [r for r in rots if r > 0]
        neg = [r for r in rots if r < 0]
        if not pos or not neg:
            continue
        if len(pos) > len(neg):
            want = 1.0
        elif len(neg) > len(pos):
            want = -1.0
        else:
            want = 1.0 if max(rots, key=abs) > 0 else -1.0

        for it, rot in zip(items, rots):
            if rot == 0.0 or (rot > 0) == (want > 0):
                continue
            new_rot = rot + 180.0 * want
            box = it.get("box") or {}
            box["rotation_deg"] = new_rot
            if "rotation_deg_css" in box:
                box["rotation_deg_css"] = new_rot
            # The baseline endpoints describe the same reversed direction, so
            # swap them too — leaving them stale would make the box and the
            # baseline disagree for anything that reads the baseline.
            p1, p2 = it.get("baseline_p1"), it.get("baseline_p2")
            if isinstance(p1, dict) and isinstance(p2, dict):
                it["baseline_p1"], it["baseline_p2"] = p2, p1
            flipped += 1
    return flipped


def rebuild_tree_for_target(
    tree: dict | None,
    target_lang: str,
    img_w: int,
    img_h: int,
) -> dict[str, Any] | None:
    """Rebuild *tree* with fresh boxes at the target language's orientation.

    Requires ``tree["bubble_groups"]`` (see
    :func:`backend.render.groups.group_paragraphs_into_bubbles`) — each group's
    own ``text`` is what gets re-laid out, so the caller must pass the tree
    whose text it wants rendered (the *translated* tree for Lens MT).

    Returns ``None`` when there are no groups to work with, so the caller can
    keep the original tree instead of rendering an empty layer. The returned
    tree keeps ``side == "Ai"``: that is the flag
    :func:`backend.render.tp_html.render_tree_overlay` uses to select the
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
