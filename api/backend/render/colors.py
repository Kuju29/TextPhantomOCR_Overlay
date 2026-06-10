"""Background-colour sampling and contrast helpers.

When the renderer erases original text it needs to know the surrounding
background colour; when it draws translated text it needs a legible
foreground colour.  Both jobs live here.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

RGB = tuple[int, int, int]
RGBA = tuple[int, int, int, int]

# Black / white foreground options for auto text colour.
TEXT_COLOR_DARK: RGBA = (0, 0, 0, 255)
TEXT_COLOR_LIGHT: RGBA = (255, 255, 255, 255)

Rect = tuple[int, int, int, int]
Quad = list[tuple[float, float]]


def median_rgba(pixels: list) -> RGBA | None:
    """Channel-wise median of a list of RGB(A) pixels."""
    if not pixels:
        return None
    rs = sorted(p[0] for p in pixels)
    gs = sorted(p[1] for p in pixels)
    bs = sorted(p[2] for p in pixels)
    mid = len(rs) // 2
    return (rs[mid], gs[mid], bs[mid], 255)


def relative_luminance(rgb: RGB) -> float:
    """WCAG relative luminance of an sRGB colour."""
    def lin(c: float) -> float:
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = rgb
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast_ratio(l1: float, l2: float) -> float:
    """WCAG contrast ratio between two luminance values."""
    a = max(l1, l2) + 0.05
    b = min(l1, l2) + 0.05
    return a / b


def pick_bw_text_color(bg_rgb: RGB) -> RGBA:
    """Pick black or white text — whichever contrasts better with ``bg_rgb``."""
    lum_bg = relative_luminance(bg_rgb)
    if contrast_ratio(lum_bg, 1.0) >= contrast_ratio(lum_bg, 0.0):
        return TEXT_COLOR_LIGHT
    return TEXT_COLOR_DARK


def sample_bg_color(base_rgb: Image.Image, rect: Rect, margin_px: int) -> RGB:
    """Median colour of a thin frame just *outside* ``rect``."""
    W, H = base_rgb.size
    l, t, r, b = rect
    m = max(1, int(margin_px))
    samples: list = []

    def add_strip(x0: int, y0: int, x1: int, y1: int) -> None:
        x0, x1 = max(0, min(W, x0)), max(0, min(W, x1))
        y0, y1 = max(0, min(H, y0)), max(0, min(H, y1))
        if x1 > x0 and y1 > y0:
            samples.extend(list(base_rgb.crop((x0, y0, x1, y1)).getdata()))

    add_strip(l, t - m, r, t)      # top
    add_strip(l, b, r, b + m)      # bottom
    add_strip(l - m, t, l, b)      # left
    add_strip(r, t, r + m, b)      # right

    med = median_rgba(samples)
    if med:
        return med[:3]
    return base_rgb.getpixel((max(0, min(W - 1, l)), max(0, min(H - 1, t))))  # type: ignore[return-value]


def sample_bg_color_from_quad(
    base_rgb: Image.Image,
    quad: Quad,
    rect: Rect,
    border_px: int = 3,
    margin_px: int = 6,
) -> RGB:
    """Median colour of a border band *inside* a rotated ``quad``.

    Falls back to :func:`sample_bg_color` (outside frame) when the quad is too
    small to yield enough samples.
    """
    l, t, r, b = rect
    w, h = r - l, b - t
    if w <= 0 or h <= 0:
        return sample_bg_color(base_rgb, rect, margin_px)

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon([(x - l, y - t) for x, y in quad], fill=255)

    bp = int(max(0, border_px or 0))
    if bp > 0:
        bp = min(bp, max(1, (min(w, h) - 1) // 2))
        eroded = mask.filter(ImageFilter.MinFilter(size=bp * 2 + 1))
        border = ImageChops.subtract(mask, eroded)
    else:
        border = mask

    region = base_rgb.crop((l, t, r, b))
    samples = [p for p, m in zip(region.getdata(), border.getdata()) if m > 0]
    if len(samples) < 24:
        return sample_bg_color(base_rgb, rect, margin_px)

    med = median_rgba(samples)
    return med[:3] if med else sample_bg_color(base_rgb, rect, margin_px)


def sample_bg_color_from_quad_ring(
    base_rgb: Image.Image,
    quad: Quad,
    rect: Rect,
    ring_px: int = 4,
) -> RGB | None:
    """Median colour of a dilated ring *around* a quad (OpenCV path).

    Returns ``None`` when there aren't enough ring pixels to be reliable.
    """
    l, t, r, b = rect
    w, h = r - l, b - t
    if w <= 0 or h <= 0:
        return None

    mask = np.zeros((h, w), dtype=np.uint8)
    pts = np.array([[(x - l, y - t) for x, y in quad]], dtype=np.int32)
    cv2.fillPoly(mask, pts, 255)

    rp = int(max(1, ring_px or 1))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (rp * 2 + 1, rp * 2 + 1))
    dilated = cv2.dilate(mask, kernel, iterations=1)
    ring = cv2.bitwise_and(dilated, cv2.bitwise_not(mask))

    rgb = np.array(base_rgb.crop((l, t, r, b)).convert("RGB"), dtype=np.uint8)
    selected = rgb[ring > 0]
    if selected.size < 24:
        return None
    med = np.median(selected, axis=0)
    return int(med[0]), int(med[1]), int(med[2])
