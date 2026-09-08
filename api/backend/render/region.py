"""Deterministic text-region geometry for the AI overlay layer.

Ported from manga-image-translator (textblock.py + rendering). Every
decision here is a closed-form computation. The model has three pieces:

1. Reading direction (horizontal vs vertical) is decided by the target
   language via LANGUAGE_DIRECTION.
2. Region tilt is the residual rotation after removing the 0/90 base.
3. Render box grows with the amount of translated text (fit_render_box).
"""

from __future__ import annotations

from typing import Any, Final, NamedTuple

import unicodedata, math

from backend.render.components.typography import is_cjk_char

# Reading direction per target language. "h" horizontal, "v" vertical,
# "hr" horizontal right-to-left, "auto" decide by region aspect.
#
# Keys are LOWERCASE. Never index this dict directly — call
# :func:`direction_preset`, which normalises first. Two different normalisers
# exist in this codebase and only one of them lowercases; see that function.
LANGUAGE_DIRECTION: Final[dict[str, str]] = {
    "th": "h", "en": "h", "id": "h", "ms": "h", "vi": "h", "tl": "h",
    "fil": "h", "fr": "h", "de": "h", "es": "h", "pt": "h", "it": "h",
    "nl": "h", "pl": "h", "cs": "h", "hu": "h", "ro": "h", "ru": "h",
    "uk": "h", "tr": "h", "ko": "h",
    # Right-to-left scripts. Persian (fa) and Urdu (ur) use Arabic script;
    # Lens reports Hebrew as "iw" but "he" is accepted too; Yiddish (yi) is RTL.
    "ar": "hr", "he": "hr", "iw": "hr", "fa": "hr", "ur": "hr",
    "ps": "hr", "ckb": "hr", "ku": "hr", "sd": "hr", "ug": "hr", "yi": "hr",
    "ja": "auto", "zh": "auto", "zh-cn": "auto", "zh-tw": "auto",
    "zh-hans": "auto", "zh-hant": "auto",
}

# Target languages whose script reads right-to-left.
RTL_LANGUAGES: Final[frozenset[str]] = frozenset(
    code for code, d in LANGUAGE_DIRECTION.items() if d == "hr"
)

# Average glyph advance as a fraction of font size.
_GLYPH_RATIO_CJK: Final[float] = 1.0
_GLYPH_RATIO_NARROW: Final[float] = 0.55

# Padding factor for the computed text area.
_AREA_PADDING: Final[float] = 1.30

# Target aspect ratios (width / height) for the render box.
_ASPECT_HORIZONTAL: Final[float] = 1.35
_ASPECT_VERTICAL: Final[float] = 0.72

_MIN_FONT_PX: Final[int] = 12

# Lens commonly reports an upright/absent rotation for Japanese columns even
# though their item rectangle is unmistakably vertical.  Keep this threshold
# in one place so the grouping gate and translated-tree relayout agree.
_PORTRAIT_CJK_RATIO: Final[float] = 2.2

class RegionGeometry(NamedTuple):
    """Deterministic geometry derived from a group of Lens items."""

    center_x: float
    center_y: float
    tilt_deg: float
    source_vertical: bool
    font_px: float
    src_width: float
    src_height: float

def _is_meaningful_cjk_char(ch: str) -> bool:
    """CJK-range Unicode Letter; symbols, numbers and punctuation are not evidence."""
    return is_cjk_char(ch) and unicodedata.category(ch).startswith("L")

def is_cjk_text(text: str, threshold: float = 0.45) -> bool:
    """True when at least threshold of the visible glyphs are CJK."""
    visible = cjk = 0
    for ch in text or "":
        if ch.isspace():
            continue
        visible += 1
        if is_cjk_char(ch):
            cjk += 1
    return visible > 0 and (cjk / visible) >= threshold

def _cjk_char_count(text: str) -> int:
    return sum(
        1 for ch in (text or "")
        if not ch.isspace() and _is_meaningful_cjk_char(ch)
    )

def glyph_ratio(text: str) -> float:
    """Average glyph width / font-size for text (CJK vs narrow scripts)."""
    return _GLYPH_RATIO_CJK if is_cjk_text(text) else _GLYPH_RATIO_NARROW

def _normalise_lang(lang: str) -> str:
    return (lang or "").strip().lower().replace("_", "-")

def direction_preset(lang: str) -> str:
    """LANGUAGE_DIRECTION entry for *lang*, or ``""`` when it is unlisted.

    The single entry point for reading the table, because indexing it directly
    is a trap. There are two language normalisers in this codebase:

      * this module's :func:`_normalise_lang` lowercases;
      * :func:`backend.lens.languages.normalize` preserves the mixed case Lens
        itself demands — it returns ``"zh-CN"``, not ``"zh-cn"``.

    The table is keyed lowercase, so every caller that passed a Lens-normalised
    code missed on Chinese and read it as an unlisted language. That is how
    ``zh-CN`` came to be typeset horizontally while ``ja`` — the same ``"auto"``
    entry one line over — was vertical, and it also made the ``zh-hans`` /
    ``zh-hant`` keys unreachable. Nothing raised; the miss just looked like a
    deliberate default.

    Regional variants fall back to their primary subtag (``zh-Hans-CN`` ->
    ``zh``), matching what :func:`is_rtl` already does for ``fa-IR`` / ``ar-EG``.
    """
    code = _normalise_lang(lang)
    if code in LANGUAGE_DIRECTION:
        return LANGUAGE_DIRECTION[code]
    primary = code.split("-", 1)[0]
    return LANGUAGE_DIRECTION.get(primary, "")

def resolve_text_direction(target_lang: str, text: str = "") -> str:
    """Return "h" or "v" for the target language - deterministic.

    RTL languages ("hr") still flow horizontally; right-to-left ordering is a
    separate concern handled by :func:`is_rtl` / the CSS ``direction`` property,
    not by this axis selection.
    """
    preset = direction_preset(target_lang)
    if preset in ("h", "hr"):
        return "h"
    if preset == "v":
        return "v"
    return "v" if is_cjk_text(text) else "h"

def is_rtl(target_lang: str) -> bool:
    """True when ``target_lang`` is written right-to-left (Arabic/Hebrew/…).

    Matches the full code first, then falls back to the primary subtag so a
    regional variant like ``fa-IR`` / ``ar-EG`` is still recognised.
    """
    code = _normalise_lang(target_lang)
    if code in RTL_LANGUAGES:
        return True
    return code.split("-", 1)[0] in RTL_LANGUAGES

def box_rotation_deg(box: Any) -> float:
    """The rotation of one box, in degrees.

    Reads ``rotation_deg``. ``rotation_deg_css`` is used ONLY when
    ``rotation_deg`` is absent — not when it is zero.

    This used to be spelled ``box.get("rotation_deg") or
    box.get("rotation_deg_css") or 0.0``, which falls through on a rotation of
    exactly 0 and silently answers with the OTHER key. The two are written
    together everywhere today, so nothing is currently wrong; the failure it
    sets up is that the day they diverge, an upright box reports the css value
    and a whole page picks the wrong reading axis — surfacing as an incorrect
    graph partition decision, far from the lookup that caused it.

    Absent from BOTH is 0°: an upright box legitimately omits the field, and
    "unset" and "0°" are the same intent. A present-but-unreadable value is
    not, and raises.

    Mirrored by ``boxRotationDeg`` in ``src/shared/lens-axis.js``.
    """
    source = box if isinstance(box, dict) else {}
    key = "rotation_deg" if "rotation_deg" in source else "rotation_deg_css"
    if key not in source:
        return 0.0
    try:
        value = float(source[key])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"box.{key} is not a number: {source[key]!r}") from exc
    # NaN / inf survive `float()` in Python but not `Number.isFinite` in the
    # JavaScript port. Refusing both keeps the two answers identical.
    if not math.isfinite(value):
        raise ValueError(f"box.{key} is not a number: {source[key]!r}")
    return value

def _item_rect(item: dict) -> tuple[float, float, float, float] | None:
    """Finite item rectangle, preferring Lens' normalised box geometry."""
    box = item.get("box") if isinstance(item.get("box"), dict) else {}
    try:
        left = float(box.get("left"))
        top = float(box.get("top"))
        width = float(box.get("width"))
        height = float(box.get("height"))
        values = (left, top, width, height)
        if all(math.isfinite(value) for value in values) and width > 0 and height > 0:
            return left, top, left + width, top + height
    except (TypeError, ValueError):
        pass
    bounds = item.get("bounds_px")
    if not (isinstance(bounds, (list, tuple)) and len(bounds) == 4):
        return None
    try:
        left, top, right, bottom = (float(value) for value in bounds)
    except (TypeError, ValueError):
        return None
    values = (left, top, right, bottom)
    if not all(math.isfinite(value) for value in values) or right <= left or bottom <= top:
        return None
    return left, top, right, bottom

def _is_portrait_rect(width: float, height: float) -> bool:
    """Stable inclusive 2.2 ratio test (avoid 2.2 * 100 rounding above 220)."""
    return width > 0.0 and height > 0.0 and (height / width) + 1e-12 >= _PORTRAIT_CJK_RATIO

def _is_portrait_cjk_item(item: dict) -> bool:
    """Whether item geometry is strong evidence of an unrotated CJK column."""
    text = str(item.get("text") or "")
    if _cjk_char_count(text) < 2 or not is_cjk_text(text):
        return False
    rect = _item_rect(item)
    if rect is None:
        return False
    width = rect[2] - rect[0]
    height = rect[3] - rect[1]
    return _is_portrait_rect(width, height)

def classify_item_axis(item: dict, tilt_tol: float = 12.0) -> str:
    """Classify one item's reading axis from its baseline rotation.

    Returns "h" (baseline ~0deg), "v" (baseline ~+/-90deg), or "tilted"
    (off the 0/90 grid by more than tilt_tol - a decorative / perspective
    label that must keep its angle, never auto-rotated). Sign-insensitive
    for the vertical case so the unstable +/-90 sign never matters.
    """
    rot = box_rotation_deg(item.get("box"))
    residual = ((rot + 45.0) % 90.0) - 45.0
    if abs(residual) > tilt_tol:
        return "tilted"
    r = rot % 180.0
    if r > 90.0:
        r -= 180.0
    # Do this before the ordinary near-zero horizontal answer. Lens may omit
    # rotation or write 0 for a vertical Japanese/Chinese column. Geometry is
    # only allowed to override near-zero CJK: explicit near-90 and decorative
    # free angles remain authoritative, while tall Latin labels stay h.
    if abs(r) <= tilt_tol and _is_portrait_cjk_item(item):
        return "v"
    return "v" if abs(r) > 45.0 else "h"

def paragraph_reading_axis(items: list[dict], tilt_tol: float = 12.0) -> str:
    """Majority reading axis of a paragraph's text items.

    Returns "h", "v" or "tilted". Tilted items stay out of the h/v vote so
    ordinary rotation noise cannot flip a paragraph, but a tilted MAJORITY is
    the paragraph's own answer.
    """
    n_h = n_v = n_t = 0
    for it in items or []:
        if not str(it.get("text") or "").strip():
            continue
        a = classify_item_axis(it, tilt_tol)
        if a == "v":
            n_v += 1
        elif a == "h":
            n_h += 1
        else:
            n_t += 1
    text_items = [it for it in (items or []) if str(it.get("text") or "").strip()]
    # Lens may split one vertical column into several short upright items. No
    # item is portrait alone, but their complete union is. Require multiple
    # items, aggregate CJK evidence, valid geometry for every member, and only
    # near-zero rotations; incomplete/mixed geometry never manufactures a vote.
    if n_v == 0 and n_t == 0 and len(text_items) > 1:
        joined = "".join(str(it.get("text") or "") for it in text_items)
        if _cjk_char_count(joined) >= 2 and is_cjk_text(joined):
            rects: list[tuple[float, float, float, float]] = []
            valid = True
            for it in text_items:
                try:
                    rot = box_rotation_deg(it.get("box"))
                except ValueError:
                    valid = False
                    break
                folded = abs(((rot + 90.0) % 180.0) - 90.0)
                rect = _item_rect(it)
                if folded > tilt_tol or rect is None:
                    valid = False
                    break
                rects.append(rect)
            if valid:
                left = min(rect[0] for rect in rects)
                top = min(rect[1] for rect in rects)
                right = max(rect[2] for rect in rects)
                bottom = max(rect[3] for rect in rects)
                if _is_portrait_rect(right - left, bottom - top):
                    return "v"

    total = n_h + n_v + n_t
    if not total:
        return "h"
    # Excluding tilted items from the vote used to mean discarding them
    # ENTIRELY: a paragraph of 5 tilted items plus 1 upright one answered "h",
    # and a visibly slanted label was then handled as a row of level text --
    # eligible for the vertical merge path, and drawn with an averaged angle
    # that follows no baseline it owns. A tilted majority now answers
    # "tilted"; below a majority the h/v vote decides exactly as before, so
    # nothing that reads "h" or "v" on genuine rotation noise changes.
    if n_t * 2 > total:
        return "tilted"
    if n_h == 0 and n_v == 0:
        return "tilted"
    return "v" if n_v >= n_h else "h"

def _circular_mean_deg(angles: list[float]) -> float:
    """Mean of angles that live on a 180deg circle (text orientation)."""
    if not angles:
        return 0.0
    xs = sum(math.cos(math.radians(2.0 * a)) for a in angles)
    ys = sum(math.sin(math.radians(2.0 * a)) for a in angles)
    if abs(xs) < 1e-9 and abs(ys) < 1e-9:
        return 0.0
    return math.degrees(math.atan2(ys, xs)) / 2.0

def orientation_mean_deg(angles: list[float]) -> float:
    """Representative orientation of a set of text baselines, in degrees.

    Text orientation lives on a 180deg circle, so the ARITHMETIC mean of a
    signed rotation list is not an orientation: averaging ``[-90, 0, 90]``
    gives 0deg, and averaging ``[0, 0, -90]`` gives -30deg -- an angle no line
    on the page is drawn at, which then gets applied to the whole block as a
    CSS ``rotate()`` and tips level text onto a diagonal. This folds the
    angles onto the circle they actually live on, so a mixed set answers with
    the direction the ink really points.
    """
    return _circular_mean_deg(list(angles or []))

def _decompose_rotation(rot_deg: float) -> tuple[float, bool]:
    """Split a Lens rotation into (residual_tilt, source_vertical)."""
    r = ((rot_deg + 90.0) % 180.0) - 90.0
    if abs(r) <= 45.0:
        return r, False
    base = 90.0 if r > 0 else -90.0
    return r - base, True

def compute_region_geometry(
    items: list[dict], img_w: int, img_h: int
) -> RegionGeometry | None:
    """Derive a RegionGeometry from a group of Lens items (image pixels)."""
    boxes: list[dict] = []
    for it in items or []:
        if not str(it.get("text") or "").strip():
            continue
        box = it.get("box")
        if isinstance(box, dict):
            boxes.append(box)
    if not boxes:
        return None

    cxs: list[float] = []
    cys: list[float] = []
    rots: list[float] = []
    heights: list[float] = []
    for box in boxes:
        center = box.get("center") or {}
        cx = center.get("x")
        cy = center.get("y")
        if cx is None:
            cx = float(box.get("left") or 0.0) + float(box.get("width") or 0.0) / 2.0
        if cy is None:
            cy = float(box.get("top") or 0.0) + float(box.get("height") or 0.0) / 2.0
        cxs.append(float(cx) * img_w)
        cys.append(float(cy) * img_h)
        rots.append(box_rotation_deg(box))
        heights.append(float(box.get("height") or 0.0) * img_h)

    center_x = sum(cxs) / len(cxs)
    center_y = sum(cys) / len(cys)

    dominant_rot = _circular_mean_deg(rots)
    tilt, source_vertical = _decompose_rotation(dominant_rot)

    valid_heights = sorted(h for h in heights if h > 1.0)
    font_px = valid_heights[len(valid_heights) // 2] if valid_heights else 0.0

    rad = math.radians(-dominant_rot)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    xs_local: list[float] = []
    ys_local: list[float] = []
    for cx, cy in zip(cxs, cys):
        dx, dy = cx - center_x, cy - center_y
        xs_local.append(dx * cos_a - dy * sin_a)
        ys_local.append(dx * sin_a + dy * cos_a)
    src_width = (max(xs_local) - min(xs_local)) if xs_local else 0.0
    src_height = (max(ys_local) - min(ys_local)) if ys_local else 0.0

    return RegionGeometry(
        center_x=center_x,
        center_y=center_y,
        tilt_deg=tilt,
        source_vertical=source_vertical,
        font_px=font_px,
        src_width=src_width,
        src_height=src_height,
    )

def fit_render_box(
    region: RegionGeometry,
    text: str,
    direction: str,
    img_w: int,
    img_h: int,
) -> tuple[float, float, float, float, float]:
    """Compute the render box for text - closed form, deterministic.

    Returns (left, top, width, height, font_px) in image pixels.
    """
    n = sum(1 for ch in (text or "") if not ch.isspace())

    floor = max(_MIN_FONT_PX, int(round((img_w + img_h) / 200.0)))
    font_px = max(float(floor), region.font_px)

    if n <= 0:
        side = font_px
        return (region.center_x - side / 2.0, region.center_y - side / 2.0,
                side, side, font_px)

    ratio = glyph_ratio(text)
    area = n * (font_px * font_px) * ratio * _AREA_PADDING

    aspect = _ASPECT_HORIZONTAL if direction == "h" else _ASPECT_VERTICAL
    width = math.sqrt(area * aspect)
    height = math.sqrt(area / aspect)

    width = max(width, font_px * ratio * 1.2)
    height = max(height, font_px * 1.2)

    width = min(width, float(img_w))
    height = min(height, float(img_h))

    left = region.center_x - width / 2.0
    top = region.center_y - height / 2.0
    left = max(0.0, min(float(img_w) - width, left))
    top = max(0.0, min(float(img_h) - height, top))

    return (left, top, width, height, font_px)
