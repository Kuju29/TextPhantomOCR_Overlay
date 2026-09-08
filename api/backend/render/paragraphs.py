"""Detector-independent paragraph helpers shared by rendering and AI guards."""

from __future__ import annotations

from typing import Any

from backend.render.region import box_rotation_deg, orientation_mean_deg


_RUBY_STRIP = '。､･・…！!？?ー―〜~（）()「」『』\u3000 \t\r\n'
_RUBY_MIN_BASE_RATIO = 1.6


def paragraph_text(paragraph: dict[str, Any]) -> str:
    """Return the paragraph's canonical source text without rewriting it."""
    own = paragraph.get("text")
    if own is not None and str(own).strip():
        return str(own)
    return "".join(
        str(item.get("text") or "")
        for item in paragraph.get("items") or []
        if isinstance(item, dict)
    )


def bubble_key(paragraph: dict[str, Any]) -> tuple[float, ...] | None:
    bounds = paragraph.get("bubble_bounds_px")
    if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
        return None
    try:
        return tuple(round(float(value), 1) for value in bounds)
    except (TypeError, ValueError):
        return None


def paragraph_rotation(paragraph: dict[str, Any]) -> float:
    rotations = [
        box_rotation_deg(item.get("box"))
        for item in paragraph.get("items") or []
        if isinstance(item, dict) and str(item.get("text") or "").strip()
    ]
    return orientation_mean_deg(rotations) if rotations else 0.0


def _is_kana_only_reading(text: str, max_len: int = 8) -> bool:
    core = [char for char in text if char not in _RUBY_STRIP]
    return 1 <= len(core) <= max_len and all(
        12352 <= ord(char) <= 12543 for char in core
    )


def _has_kanji(text: str) -> bool:
    return any(13312 <= ord(char) <= 40959 for char in text)


def _paragraph_bounds(paragraph: dict[str, Any]) -> tuple[float, float, float, float] | None:
    bounds = paragraph.get("bounds_px")
    if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
        return None
    try:
        x1, y1, x2, y2 = (float(value) for value in bounds)
    except (TypeError, ValueError):
        return None
    return (x1, y1, x2, y2) if x2 > x1 and y2 > y1 else None


def _paragraph_font_px(paragraph: dict[str, Any], image_height: int) -> float:
    heights: list[float] = []
    for item in paragraph.get("items") or []:
        if not isinstance(item, dict) or not str(item.get("text") or "").strip():
            continue
        box = item.get("box") if isinstance(item.get("box"), dict) else {}
        value = float(box.get("height") or 0.0) * image_height
        if value > 1.0:
            heights.append(value)
    if not heights:
        return 0.0
    heights.sort()
    return heights[len(heights) // 2]


def _ruby_paragraph_positions(paragraphs: list[dict[str, Any]], image_height: int) -> set[int]:
    candidates = []
    for position, paragraph in enumerate(paragraphs):
        bounds = _paragraph_bounds(paragraph)
        if bounds is None:
            continue
        text = paragraph_text(paragraph)
        candidates.append(
            (position, bounds, _paragraph_font_px(paragraph, image_height), text)
        )

    ruby: set[int] = set()
    for position, bounds, font, text in candidates:
        if font <= 0 or not _is_kana_only_reading(text):
            continue
        x1, y1, x2, y2 = bounds
        height = y2 - y1
        for other_position, other_bounds, other_font, other_text in candidates:
            if other_position == position or other_font < _RUBY_MIN_BASE_RATIO * font:
                continue
            if not _has_kanji(other_text):
                continue
            ox1, oy1, ox2, oy2 = other_bounds
            overlap = max(0.0, min(y2, oy2) - max(y1, oy1)) / max(1.0, height)
            gap = max(ox1 - x2, x1 - ox2, 0.0)
            if overlap >= 0.4 and gap <= 1.6 * (x2 - x1):
                ruby.add(position)
                break
    return ruby


def group_is_ruby_only(
    group: dict[str, Any], tree: dict[str, Any], image_height: int
) -> bool:
    """Return whether a rendered group contains only a ruby reading column."""
    text = str(group.get("text") or "").strip()
    if not text or not _is_kana_only_reading(text):
        return False
    try:
        member_indices = {int(value) for value in group.get("para_indices") or []}
    except (TypeError, ValueError):
        return False
    page = [item for item in tree.get("paragraphs") or [] if isinstance(item, dict)]
    members = [
        paragraph
        for paragraph in page
        if int(paragraph.get("para_index", -1)) in member_indices
    ]
    if not members:
        return False
    ruby_positions = _ruby_paragraph_positions(members + page, image_height)
    return bool(ruby_positions & set(range(len(members))))
