"""Pure text classification, escaping, and font-fitting helpers."""

from __future__ import annotations

from typing import Final

import math

from backend.lens.tree import iter_paragraphs

GLYPH_W_RATIO_CJK: Final[float] = 0.95
GLYPH_W_RATIO_THAI: Final[float] = 0.55
GLYPH_W_RATIO_LATIN: Final[float] = 0.55
MIN_FONT_PX: Final[int] = 9

CJK_RANGES: Final[tuple[tuple[int, int], ...]] = (
    (0x2E80, 0x2EFF), (0x2F00, 0x2FDF), (0x3000, 0x303F),
    (0x3040, 0x309F), (0x30A0, 0x30FF), (0x3100, 0x312F),
    (0x3130, 0x318F), (0x3190, 0x319F), (0x31A0, 0x31BF),
    (0x31C0, 0x31EF), (0x31F0, 0x31FF), (0x3200, 0x32FF),
    (0x3300, 0x33FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
    (0xA000, 0xA48F), (0xAC00, 0xD7AF), (0xF900, 0xFAFF),
    (0xFE30, 0xFE4F), (0xFF00, 0xFFEF), (0x20000, 0x2A6DF),
    (0x2A700, 0x2B73F), (0x2B740, 0x2B81F), (0x2B820, 0x2CEAF),
    (0x2F800, 0x2FA1F),
)

def finite_number(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return float(default)
    if not math.isfinite(number):
        return float(default)
    return number

def escape_text(value: str) -> str:
    if not value:
        return ""
    return (value.replace("\r", "").replace("&", "&amp;")
            .replace("<", "&lt;").replace(">", "&gt;"))

def escape_attr(value: str) -> str:
    return escape_text(value).replace('"', "&quot;").replace("'", "&#x27;")

def is_cjk_char(char: str) -> bool:
    if not char:
        return False
    codepoint = ord(char)
    return any(low <= codepoint <= high for low, high in CJK_RANGES)

def classify_text(text: str) -> str:
    if not text:
        return "latin"
    cjk = thai = other = 0
    for char in text:
        if is_cjk_char(char):
            cjk += 1
        elif 0x0E00 <= ord(char) <= 0x0E7F:
            thai += 1
        elif char.isalnum():
            other += 1
    if cjk and cjk >= max(thai, other):
        return "cjk"
    if thai and thai >= other:
        return "thai"
    return "latin"

def is_cjk_dominant(text: str, threshold: float = 0.45) -> bool:
    visible = [char for char in text if not char.isspace()]
    return bool(visible) and sum(is_cjk_char(char) for char in visible) / len(visible) >= threshold

def glyph_width_ratio(text: str) -> float:
    kind = classify_text(text)
    if kind == "cjk":
        return GLYPH_W_RATIO_CJK
    if kind == "thai":
        return GLYPH_W_RATIO_THAI
    return GLYPH_W_RATIO_LATIN

def visible_char_count(text: str) -> int:
    return sum(1 for char in text if not char.isspace()) if text else 0

def fit_item_font_size(box_width_pct: float, box_height_pct: float, text: str,
                       img_w: int, img_h: int) -> int:
    width_px = max(0.0, box_width_pct) / 100.0 * max(1, int(img_w))
    height_px = max(0.0, box_height_pct) / 100.0 * max(1, int(img_h))
    if height_px <= 0:
        return MIN_FONT_PX
    height_size = height_px * 0.85
    count = visible_char_count(text)
    if count <= 0:
        return max(MIN_FONT_PX, int(round(height_size)))
    width_size = width_px / max(1.0, (count + 0.5) * glyph_width_ratio(text))
    return max(MIN_FONT_PX, int(round(min(height_size, width_size))))

def fit_paragraph_font_size_horizontal(box_w_px: float, box_h_px: float,
                                       text: str) -> int:
    if box_w_px <= 0 or box_h_px <= 0:
        return MIN_FONT_PX
    count = visible_char_count(text)
    if count <= 0:
        return max(MIN_FONT_PX, int(round(min(box_w_px, box_h_px) * 0.85)))
    area_size = math.sqrt(box_w_px * box_h_px / max(1.0, count * glyph_width_ratio(text))) * 0.85
    return max(MIN_FONT_PX, int(round(min(area_size, box_h_px * 0.80))))

def fit_item_font_size_vertical(box_w_px: float, box_h_px: float, text: str) -> int:
    if box_w_px <= 0 or box_h_px <= 0:
        return MIN_FONT_PX
    count = visible_char_count(text)
    if count <= 0:
        return max(MIN_FONT_PX, int(round(min(box_w_px, box_h_px) * 0.85)))
    area_size = math.sqrt(box_w_px * box_h_px / count) * 0.9
    return max(MIN_FONT_PX, int(round(min(area_size, box_w_px * 0.95, box_h_px * 0.95))))

def fit_tree_font_sizes(
    tree: dict | None,
    # _thai_path: str,
    # _latin_path: str,
    img_w: int,
    img_h: int,
) -> dict[int, int]:
    """Attach deterministic per-item sizes and return paragraph medians."""
    if not isinstance(tree, dict):
        return {}
    sizes: dict[int, int] = {}
    for _, paragraph in iter_paragraphs(tree):
        per_item: list[int] = []
        for item in paragraph.get("items") or []:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            box = item.get("box") or {}
            width_pct = finite_number(
                box.get("width_pct"), finite_number(box.get("width")) * 100.0
            )
            height_pct = finite_number(
                box.get("height_pct"), finite_number(box.get("height")) * 100.0
            )
            size = fit_item_font_size(width_pct, height_pct, text, img_w, img_h)
            item["font_size_px"] = size
            per_item.append(size)
        if per_item:
            shared = sorted(per_item)[len(per_item) // 2]
            paragraph["para_font_size_px"] = shared
            sizes[int(paragraph.get("para_index", 0))] = shared
    return sizes
