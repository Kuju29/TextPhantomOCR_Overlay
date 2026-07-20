"""Remove the original text from an image so translated text can be drawn.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Several strategies are available; the public entry point is
:func:`erase_text_with_boxes`, which dispatches on ``mode``:

- ``inpaint`` (default) — OpenCV Telea/NS inpainting.  Best quality.
- ``solid``             — flood the box with the sampled background colour.
- ``mosaic``            — pixelate the box.
- ``clone``             — copy a neighbouring patch over the box.
- ``blend_patch``       — average several neighbouring patches over the box.

``clone`` / ``blend_patch`` fall back to ``solid`` if no donor region fits.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from backend.render.colors import sample_bg_color_from_quad
from backend.render.geometry import (
    quad_bbox,
    token_box_px,
    token_box_quad_px,
    token_quad_px,
)

Rect = tuple[int, int, int, int]

# --- Tunables --------------------------------------------------------------
DEFAULT_MODE = "inpaint"
PADDING_PX = 2
SAMPLE_MARGIN_PX = 6
BG_SAMPLE_BORDER_PX = 3

MOSAIC_BLOCK_PX = 10

CLONE_GAP_PX = 4
CLONE_BORDER_PX = 6
CLONE_FEATHER_PX = 3

BLEND_GAP_PX = 3
BLEND_FEATHER_PX = 4

INPAINT_RADIUS = 3
INPAINT_METHOD = "telea"  # "telea" or "ns"
INPAINT_DILATE_PX = 1


# --- Small image utilities -------------------------------------------------

def _pixelate(img: Image.Image, block_px: int) -> Image.Image:
    """Downscale then nearest-neighbour upscale to produce a mosaic effect."""
    w, h = img.size
    if w <= 1 or h <= 1:
        return img
    block_px = max(1, int(block_px or 1))
    sw = max(1, w // block_px)
    sh = max(1, h // block_px)
    return img.resize((sw, sh), Image.NEAREST).resize((w, h), Image.NEAREST)


def _mean_abs_diff(a: Image.Image, b: Image.Image) -> float:
    """Mean per-channel absolute difference between two equal-size images."""
    if a.size != b.size:
        return 1e18
    da = list(a.convert("RGB").getdata())
    db = list(b.convert("RGB").getdata())
    if not da:
        return 1e18
    total = 0
    for (ar, ag, ab), (br, bg, bb) in zip(da, db):
        total += abs(ar - br) + abs(ag - bg) + abs(ab - bb)
    return total / (len(da) * 3)


def _resize_small(img: Image.Image, max_w: int = 64, max_h: int = 64) -> Image.Image:
    """Shrink ``img`` to fit ``max_w`` x ``max_h`` (never upscales)."""
    w, h = img.size
    if w <= 0 or h <= 0:
        return img
    scale = min(max_w / w, max_h / h, 1.0)
    return img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BILINEAR)


# --- Clone strategy --------------------------------------------------------

def _clone_candidate_score(base: Image.Image, rect: Rect, cand_rect: Rect, direction: str, border_px: int) -> float:
    """Edge-match score between ``rect`` and a candidate donor (lower = better)."""
    W, H = base.size
    l, t, r, b = rect
    cl, ct, cr, cb = cand_rect
    if (r - l) <= 1 or (b - t) <= 1:
        return 1e18
    bp = max(1, int(border_px or 1))

    if direction == "up":
        a = base.crop((l, max(0, t - bp), r, t))
        d = base.crop((cl, max(0, cb - bp), cr, cb))
    elif direction == "down":
        a = base.crop((l, b, r, min(H, b + bp)))
        d = base.crop((cl, ct, cr, min(H, ct + bp)))
    elif direction == "left":
        a = base.crop((max(0, l - bp), t, l, b))
        d = base.crop((max(0, cr - bp), ct, cr, cb))
    else:  # right
        a = base.crop((r, t, min(W, r + bp), b))
        d = base.crop((cl, ct, min(W, cl + bp), cb))

    return _mean_abs_diff(_resize_small(a, 64, 16), _resize_small(d, 64, 16))


def _choose_clone_rect(base: Image.Image, rect: Rect, gap_px: int, border_px: int) -> Rect | None:
    """Pick the best-matching neighbouring rectangle to clone from."""
    W, H = base.size
    l, t, r, b = rect
    w, h = r - l, b - t
    gap = max(0, int(gap_px or 0))

    candidates = {
        "up": (l, t - gap - h, r, t - gap),
        "down": (l, b + gap, r, b + gap + h),
        "left": (l - gap - w, t, l - gap, b),
        "right": (r + gap, t, r + gap + w, b),
    }
    scored: list[tuple[float, Rect]] = []
    for direction, (cl, ct, cr, cb) in candidates.items():
        if cl < 0 or ct < 0 or cr > W or cb > H:
            continue
        cand = (cl, ct, cr, cb)
        scored.append((_clone_candidate_score(base, rect, cand, direction, border_px), cand))

    if not scored:
        return None
    scored.sort(key=lambda x: x[0])
    return scored[0][1]


def _erase_with_clone(base: Image.Image, rect: Rect, mask: Image.Image, gap_px: int, border_px: int, feather_px: int) -> bool:
    """Composite a cloned donor patch over ``rect``. Returns False if no donor."""
    l, t, r, b = rect
    cand = _choose_clone_rect(base, rect, gap_px, border_px)
    if not cand:
        return False
    donor = base.crop(cand)
    region = base.crop((l, t, r, b))
    m = mask.filter(ImageFilter.GaussianBlur(radius=feather_px)) if feather_px > 0 else mask
    base.paste(Image.composite(donor, region, m), (l, t))
    return True


def _erase_with_blend_patches(base: Image.Image, rect: Rect, mask: Image.Image, gap_px: int = 3, feather_px: int = 4) -> bool:
    """Average up to 8 neighbouring patches and composite over ``rect``."""
    l, t, r, b = rect
    W, H = base.size
    w, h = r - l, b - t
    if w <= 2 or h <= 2:
        return False
    gap = max(0, int(gap_px))

    offsets = [
        (0, -(h + gap)), (0, h + gap), (-(w + gap), 0), (w + gap, 0),
        (-(w + gap), -(h + gap)), (w + gap, -(h + gap)),
        (-(w + gap), h + gap), (w + gap, h + gap),
    ]
    patches: list[Image.Image] = []
    for dx, dy in offsets:
        ll, tt = l + dx, t + dy
        rr, bb = ll + w, tt + h
        if 0 <= ll and 0 <= tt and rr <= W and bb <= H:
            patches.append(base.crop((ll, tt, rr, bb)).convert("RGB"))
    if not patches:
        return False

    acc = patches[0]
    for p in patches[1:]:
        acc = ImageChops.add(acc, p, scale=1.0, offset=0)
    n = len(patches)
    blended = acc.point(lambda px: int(px / n))

    m = mask.filter(ImageFilter.GaussianBlur(radius=feather_px)) if feather_px > 0 else mask
    region = base.crop((l, t, r, b)).convert("RGB")
    base.paste(Image.composite(blended, region, m), (l, t))
    return True


# --- Inpaint strategy ------------------------------------------------------

def _token_mask_quad(token: dict, W: int, H: int, pad_px: int):
    """Best available quad for a token (box-quad -> baseline-quad -> rect)."""
    quad = token_box_quad_px(token, W, H, pad_px=pad_px)
    if quad:
        return quad
    quad = token_quad_px(token, W, H, pad_px=pad_px, apply_baseline_shift=True)
    if quad:
        return quad
    rect = token_box_px(token, W, H, pad_px=pad_px)
    if rect:
        l, t, r, b = rect
        return [(l, t), (r, t), (r, b), (l, b)]
    return None


def _erase_with_inpaint(base: Image.Image, box_tokens: list[dict], pad_px: int = 2) -> Image.Image:
    """OpenCV inpaint every token region. Returns a new image."""
    if not box_tokens:
        return base

    rgb = base.convert("RGB")
    W, H = rgb.size
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)
    for token in box_tokens:
        quad = _token_mask_quad(token, W, H, pad_px)
        if quad:
            draw.polygon(quad, fill=255)

    m = np.array(mask, dtype=np.uint8)
    ys, xs = np.where(m > 0)
    if xs.size == 0 or ys.size == 0:
        return rgb

    # Crop to the dirty region (+8px slack) — inpainting the whole image is slow.
    l = int(max(0, xs.min() - 8))
    t = int(max(0, ys.min() - 8))
    r = int(min(W, xs.max() + 1 + 8))
    b = int(min(H, ys.max() + 1 + 8))
    if r <= l or b <= t:
        return rgb

    crop_rgb = np.array(rgb.crop((l, t, r, b)), dtype=np.uint8)
    crop_mask = m[t:b, l:r]
    if INPAINT_DILATE_PX > 0:
        k = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (INPAINT_DILATE_PX * 2 + 1, INPAINT_DILATE_PX * 2 + 1)
        )
        crop_mask = cv2.dilate(crop_mask, k, iterations=1)

    bgr = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2BGR)
    flag = cv2.INPAINT_TELEA if INPAINT_METHOD.lower() in ("telea", "t") else cv2.INPAINT_NS
    out_bgr = cv2.inpaint(bgr, crop_mask, float(INPAINT_RADIUS), flag)
    out_rgb = cv2.cvtColor(out_bgr, cv2.COLOR_BGR2RGB)

    out = rgb.copy()
    out.paste(Image.fromarray(out_rgb), (l, t))
    return out


# --- Public entry point ----------------------------------------------------

def erase_text_with_boxes(
    img: Image.Image,
    box_tokens: list[dict],
    pad_px: int = PADDING_PX,
    sample_margin_px: int = SAMPLE_MARGIN_PX,
    mode: str | None = None,
    mosaic_block_px: int | None = None,
) -> Image.Image:
    """Erase every token region in ``box_tokens`` from a copy of ``img``."""
    if not box_tokens:
        return img

    mode = (mode or DEFAULT_MODE or "solid").strip().lower()
    mosaic_block_px = int(mosaic_block_px or MOSAIC_BLOCK_PX)
    base = img.convert("RGB").copy()

    if mode in ("inpaint", "cv2", "opencv"):
        return _erase_with_inpaint(base, box_tokens, pad_px=pad_px)

    W, H = base.size
    for token in box_tokens:
        quad = _token_mask_quad(token, W, H, pad_px)
        if not quad:
            continue
        rect = quad_bbox(quad, W, H)
        if not rect:
            continue

        l, t, r, b = rect
        region = base.crop((l, t, r, b))
        mask = Image.new("L", (r - l, b - t), 0)
        ImageDraw.Draw(mask).polygon([(x - l, y - t) for x, y in quad], fill=255)

        token_mode = mode
        if token_mode in ("blend_patch", "blend", "avg_patch", "patch"):
            if _erase_with_blend_patches(base, rect, mask, BLEND_GAP_PX, BLEND_FEATHER_PX):
                continue
            token_mode = "solid"

        if token_mode == "clone":
            if _erase_with_clone(base, rect, mask, CLONE_GAP_PX, CLONE_BORDER_PX, CLONE_FEATHER_PX):
                continue
            token_mode = "solid"

        if token_mode == "mosaic":
            pixelated = _pixelate(region, mosaic_block_px)
            base.paste(Image.composite(pixelated, region, mask), (l, t))
        else:  # solid
            color = sample_bg_color_from_quad(base, quad, rect, BG_SAMPLE_BORDER_PX, sample_margin_px)
            region.paste(color, mask=mask)
            base.paste(region, (l, t))

    return base
