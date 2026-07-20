"""Pixel-accurate measurement of a single rendered line of text.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Both helpers walk the Thai/Latin runs of a string, measure each run with its
own font, and aggregate the result.  They share the same scan loop — the only
difference is what they return.
"""

from __future__ import annotations

from PIL import Image, ImageDraw

from backend.render.fonts import font_pair
from backend.render.text_utils import sanitize_draw_text, split_runs_for_fallback

# A scratch canvas reused for all text measurement (Pillow needs a draw ctx).
_SCRATCH = ImageDraw.Draw(Image.new("RGBA", (16, 16), (0, 0, 0, 0)))


def _scan_runs(text: str, thai_path: str, latin_path: str, size: int):
    """Measure ``text`` run by run.

    Returns ``(advance_width, min_top, max_bottom)`` in pixels, all relative
    to the baseline (``anchor="ls"``).  ``None`` if the text is empty.
    """
    t = sanitize_draw_text(text)
    if not t:
        return None

    f_thai, f_latin = font_pair(thai_path, latin_path, size)
    x = 0.0
    min_top = 0.0
    max_bottom = 0.0

    for run, is_thai in split_runs_for_fallback(t):
        if run == "\n":
            continue
        font = f_thai if is_thai else f_latin
        try:
            bb = _SCRATCH.textbbox((x, 0), run, font=font, anchor="ls")
            min_top = min(min_top, float(bb[1]))
            max_bottom = max(max_bottom, float(bb[3]))
            x = float(bb[2])
        except Exception:
            # Very old Pillow / bitmap font fallback.
            try:
                w, h = _SCRATCH.textsize(run, font=font)  # type: ignore[attr-defined]
            except Exception:
                w, h = (len(run) * size * 0.5, size)
            min_top = min(min_top, -float(h) * 0.8)
            max_bottom = max(max_bottom, float(h) * 0.2)
            x += float(w)

    return x, min_top, max_bottom


def baseline_offset_px(text: str, thai_path: str, latin_path: str, size: int) -> tuple[float, float] | None:
    """Return ``(baseline_offset, total_height)`` for one line of ``text``.

    ``baseline_offset`` is how far the visual centre sits *below* the
    baseline — used to vertically centre text inside its box.
    """
    scanned = _scan_runs(text, thai_path, latin_path, size)
    if scanned is None:
        return None
    _x, min_top, max_bottom = scanned
    total_h = max(1.0, max_bottom - min_top)
    baseline_offset = -(total_h / 2.0) - min_top
    return baseline_offset, total_h


def line_metrics_px(text: str, thai_path: str, latin_path: str, size: int) -> tuple[float, float, float] | None:
    """Return ``(width, total_height, baseline_to_center)`` for one line."""
    scanned = _scan_runs(text, thai_path, latin_path, size)
    if scanned is None:
        return None
    x, min_top, max_bottom = scanned
    width = max(1.0, x)
    total_h = max(1.0, max_bottom - min_top)
    baseline_to_center = -((min_top + max_bottom) / 2.0)
    return width, total_h, baseline_to_center
