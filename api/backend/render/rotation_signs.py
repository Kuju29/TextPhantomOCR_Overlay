"""Presentation-only repair for Lens's ambiguous near-vertical angle sign."""

import copy

from backend.render.region import box_rotation_deg

VERTICAL_TILT_DEG = 78.0


def presentation_rotation_copy(tree: dict | None) -> tuple[dict | None, dict]:
    """Return a normalized deep copy and its traceable normalization stats."""
    result = copy.deepcopy(tree)
    stats = {}
    normalize_group_rotation_signs(result, stats=stats)
    return result, stats


def normalize_group_rotation_signs(
    tree: dict | None, *, stats: dict | None = None
) -> int:
    """Make near-vertical columns face consistently within each bubble only."""
    if not isinstance(tree, dict):
        return 0
    by_index = {
        int(p.get("para_index", i)): p
        for i, p in enumerate(tree.get("paragraphs") or [])
        if isinstance(p, dict)
    }
    flipped = 0
    mixed_groups = 0
    for bg in tree.get("bubble_groups") or []:
        if not isinstance(bg, dict) or str(bg.get("direction") or "h") != "v":
            continue
        candidates = []
        for pi in bg.get("para_indices") or []:
            para = by_index.get(int(pi))
            if para is None:
                continue
            for item in para.get("items") or []:
                if not isinstance(item, dict) or not str(item.get("text") or "").strip():
                    continue
                # Read with the documented key precedence. The old
                # `rotation_deg or rotation_deg_css or 0.0` chain answers with
                # the css key whenever rotation_deg is exactly 0, so an upright
                # item could be pulled into the flip candidates.
                try:
                    rot = box_rotation_deg(item.get("box"))
                except ValueError:
                    rot = 0.0
                if abs(rot) > VERTICAL_TILT_DEG:
                    candidates.append((item, rot))
        rots = [rot for _, rot in candidates]
        pos = [rot for rot in rots if rot > 0]
        neg = [rot for rot in rots if rot < 0]
        if not pos or not neg:
            continue
        mixed_groups += 1
        if len(pos) != len(neg):
            want = 1.0 if len(pos) > len(neg) else -1.0
        else:
            want = 1.0 if max(rots, key=abs) > 0 else -1.0
        for item, rot in candidates:
            if (rot > 0) == (want > 0):
                continue
            box = item.get("box") or {}
            new_rot = rot + 180.0 * want
            box["rotation_deg"] = new_rot
            if "rotation_deg_css" in box:
                box["rotation_deg_css"] = new_rot
            p1, p2 = item.get("baseline_p1"), item.get("baseline_p2")
            if isinstance(p1, dict) and isinstance(p2, dict):
                item["baseline_p1"], item["baseline_p2"] = p2, p1
            flipped += 1
    if isinstance(stats, dict):
        stats.update({"mixed_groups": mixed_groups, "flips": flipped})
    return flipped
