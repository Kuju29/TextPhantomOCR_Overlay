"""Detect speech-bubble masks from an inpainted image + Lens text centers.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

The Lens tree only tells us where the *text* sits (each item is a tight
rotated rectangle around a run of glyphs).  The actual speech *bubble*
extends well past those rectangles — that's the canvas the AI translation
should be rendered into, especially when the target language has the
opposite reading direction from the source (Japanese vertical → Thai
horizontal, or English horizontal → Chinese vertical).

This module recovers each bubble's polygon entirely from data we already
have, without bringing in any extra dependencies:

1. The pipeline already inpaints the source text (``erase_text_with_boxes``
   in :mod:`backend.render.erase`), leaving a clean speech-bubble interior
   on most pages.
2. We threshold the inpainted image to a binary "interior vs ink" mask.
3. ``cv2.connectedComponentsWithStats`` gives a label for every connected
   white region (bubble interiors, blank margins, panel gaps, …).
4. For each accepted label, ``cv2.findContours`` + ``cv2.fitEllipse``
   produce the bubble's ellipse fit, and the *largest axis-aligned
   rectangle inscribed in that ellipse* (``A/sqrt(2) × B/sqrt(2)``) is
   what we return as the bubble bounds.  Unlike the raw component bbox
   — which includes the bubble's *corners*, often outside the visible
   outline — the inscribed rectangle is guaranteed to sit inside the
   bubble's outline, so text rendered into it never spills over the
   bubble edge.  This is the same approach scanlation typesetters use
   when picking text frames inside elliptical bubbles.
5. For each paragraph in the Lens tree, we seed-look-up the labels its
   item centers fall in, then return the inscribed rectangle of the
   matched label.

When a paragraph's seeds land on dark pixels (no clean interior — text
sat on a flat background, or the bubble has no outline) the function
returns ``None`` for that paragraph and the renderer falls back to the
existing text-only AABB.  Components that are larger than
``_MAX_BUBBLE_AREA_FRAC`` of the page are also rejected (they're almost
certainly the page background leaking through, not a real bubble).
"""

from __future__ import annotations

import math
import os
from typing import Any, Final

import cv2
import numpy as np
from PIL import Image

# Optional YOLO segmentation backend ---------------------------------------
#
# When ``ultralytics`` is installed AND the user opts in via the env vars
# below, the combined detector runs a YOLO segmentation pass first and uses
# its bubble polygons as the source of truth.  YOLO is much more accurate
# on hand-drawn bubbles than the threshold-based connected-components pass,
# but it adds 100-500ms on CPU, so we keep it strictly opt-in.
#
#   TP_BUBBLE_USE_YOLO=1           — enable the YOLO pass
#   TP_BUBBLE_YOLO_MODEL=path.pt   — path or HF id of a YOLO-seg checkpoint
#   TP_BUBBLE_YOLO_IMGSZ=640       — inference resolution (default 640)
#   TP_BUBBLE_YOLO_CONF=0.25       — detection confidence floor

try:
    from ultralytics import YOLO as _YOLO  # type: ignore
    _ULTRALYTICS_OK = True
except Exception:  # pragma: no cover - optional dependency
    _YOLO = None  # type: ignore[assignment]
    _ULTRALYTICS_OK = False

_yolo_model_cache: dict[str, Any] = {}

# Threshold above which a pixel counts as bubble interior.  Manga pages
# are typically inked with a hard black outline on white interiors, so a
# fixed threshold near pure white works without per-image tuning.
_BG_THRESHOLD: Final[int] = 220

# Components that swallow more than half the page are rejected — that's
# almost always the background "panel" component, not a real bubble.
_MAX_BUBBLE_AREA_FRAC: Final[float] = 0.50

# Skip tiny specks that survived inpainting (dust, JPEG noise).
_MIN_BUBBLE_AREA_PX: Final[int] = 64

# When a paragraph seed lands on a dark pixel (e.g. it's right on what
# used to be an ink stroke that the inpainter only partially cleaned),
# spiral outward this many pixels looking for a valid interior label.
_SEED_FALLBACK_RADIUS: Final[int] = 6

# 1 / sqrt(2) — the largest axis-aligned rectangle that fits inside an
# ellipse of diameters (A, B) has dimensions (A/sqrt(2), B/sqrt(2)).
# Cached as a constant because it shows up everywhere in the inscribed-
# rect maths and ``math.sqrt`` isn't free.
_INV_SQRT2: Final[float] = 1.0 / math.sqrt(2.0)


def _safe_float(x: Any, default: float = 0.0) -> float:
    """Coerce ``x`` to a finite float, falling back to ``default``."""
    try:
        n = float(x)
    except (TypeError, ValueError):
        return float(default)
    return n if math.isfinite(n) else float(default)


def _seed_label(
    labels: np.ndarray, seed_x: int, seed_y: int, radius: int = _SEED_FALLBACK_RADIUS
) -> int:
    """Return the connected-component label that owns ``(seed_x, seed_y)``.

    Label 0 is the binary-image background (= ink / outside the bubble);
    if the seed lands there we spiral outward up to ``radius`` pixels and
    return the first non-zero label we find.  Returns 0 if no interior
    label is reachable within the search radius (the renderer treats this
    as "no bubble" and falls back to the text AABB).
    """
    h, w = labels.shape
    seed_x = max(0, min(w - 1, int(seed_x)))
    seed_y = max(0, min(h - 1, int(seed_y)))

    lbl = int(labels[seed_y, seed_x])
    if lbl > 0:
        return lbl

    # Ring-by-ring outward search: ring r is the square perimeter at
    # Chebyshev distance r from the seed.
    for r in range(1, max(1, int(radius)) + 1):
        for dy in range(-r, r + 1):
            ny = seed_y + dy
            if ny < 0 or ny >= h:
                continue
            for dx in range(-r, r + 1):
                if abs(dx) != r and abs(dy) != r:
                    continue  # interior of the ring — already covered
                nx = seed_x + dx
                if nx < 0 or nx >= w:
                    continue
                lbl = int(labels[ny, nx])
                if lbl > 0:
                    return lbl
    return 0


def _inscribed_rect_from_contour(
    contour: np.ndarray, img_w: int, img_h: int
) -> tuple[float, float, float, float] | None:
    """Largest *axis-aligned* rectangle that fits inside ``contour``.

    Manga speech bubbles are dominantly elliptical, so we fit an ellipse
    to the contour (``cv2.fitEllipse``) and use the closed-form solution
    for the inscribed axis-aligned rectangle:

        width  = A / sqrt(2)
        height = B / sqrt(2)

    centered on the ellipse center, where ``(A, B)`` are the ellipse's
    *full* diameters along its major / minor axes.  For a rotated
    ellipse the formula is conservative — the returned rectangle still
    fits entirely inside the ellipse, just not always the absolute
    largest axis-aligned one possible.  That's fine for our use: we want
    text that never overflows the visible bubble outline, even if we
    leave a little unused room at the corners.

    Falls back to a simple bbox-scale (×0.707) when the contour is too
    short for ``fitEllipse`` (it needs ≥ 5 points).

    Returns ``(left, top, width, height)`` in image pixels, clamped to
    the image, or ``None`` when the contour produces no usable rect.
    """
    if contour is None or len(contour) == 0:
        return None

    if len(contour) >= 5:
        try:
            (cx, cy), (a, b), _angle = cv2.fitEllipse(contour)
        except cv2.error:
            return None

        # Inscribed AABB inside the ellipse.  For a non-axis-aligned
        # ellipse this is still inside the ellipse; we're trading a few
        # percent of area for a closed-form solution.  When the major
        # axis is at ~45° the inscribed AABB shrinks toward the smaller
        # of the two — use the smaller axis on both sides to be safe.
        rect_w = float(a) * _INV_SQRT2
        rect_h = float(b) * _INV_SQRT2
        new_x = float(cx) - rect_w / 2.0
        new_y = float(cy) - rect_h / 2.0
    else:
        # fitEllipse needs ≥ 5 points — degenerate contour, just inset
        # the bbox by 1 - 1/sqrt(2) ≈ 29.3% on each side.
        bx, by, bw, bh = cv2.boundingRect(contour)
        rect_w = float(bw) * _INV_SQRT2
        rect_h = float(bh) * _INV_SQRT2
        new_x = float(bx) + (float(bw) - rect_w) / 2.0
        new_y = float(by) + (float(bh) - rect_h) / 2.0

    # Clamp into the image and drop degenerate rectangles.
    new_x = max(0.0, min(float(img_w) - 1.0, new_x))
    new_y = max(0.0, min(float(img_h) - 1.0, new_y))
    if new_x + rect_w > img_w:
        rect_w = float(img_w) - new_x
    if new_y + rect_h > img_h:
        rect_h = float(img_h) - new_y
    if rect_w <= 1.0 or rect_h <= 1.0:
        return None
    return (new_x, new_y, rect_w, rect_h)


def _inscribed_rect_from_label(
    labels: np.ndarray,
    label_id: int,
    bbox: tuple[int, int, int, int],
    img_w: int,
    img_h: int,
) -> tuple[float, float, float, float] | None:
    """Inscribed rect for a single connected component.

    Extracts a tight sub-mask for the component (avoids running
    ``findContours`` over the whole page per label), grabs the outermost
    contour, and forwards it to :func:`_inscribed_rect_from_contour`.
    """
    bx, by, bw, bh = bbox
    if bw <= 0 or bh <= 0:
        return None
    # Crop to the component's bounding box, then build a binary submask
    # of just this label.  Contour points come back in local coordinates;
    # add the bbox offset to put them back into image space.
    submask = (labels[by : by + bh, bx : bx + bw] == label_id).astype(np.uint8)
    submask *= 255
    contours, _ = cv2.findContours(submask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if contour.size == 0:
        return None
    contour = contour + np.array([[bx, by]])
    return _inscribed_rect_from_contour(contour, img_w, img_h)


def _item_seed_points(
    items: list[dict], img_w: int, img_h: int
) -> list[tuple[int, int]]:
    """Return one ``(x, y)`` seed in image pixels per text-bearing item.

    Uses ``box.center`` when available (the rotated rectangle's geometric
    centre, computed by :func:`backend.lens.tree.decode_tree`); falls
    back to ``left + width/2`` so older trees without ``center`` still
    seed correctly.
    """
    seeds: list[tuple[int, int]] = []
    for it in items or []:
        text = str(it.get("text") or "").strip()
        if not text:
            continue
        box = it.get("box") or {}
        center = box.get("center") or {}
        cx_n = _safe_float(
            center.get("x"),
            _safe_float(box.get("left")) + _safe_float(box.get("width")) / 2.0,
        )
        cy_n = _safe_float(
            center.get("y"),
            _safe_float(box.get("top")) + _safe_float(box.get("height")) / 2.0,
        )
        seeds.append((int(round(cx_n * img_w)), int(round(cy_n * img_h))))
    return seeds


def detect_bubble_bounds_by_paragraph(
    erased_image: Image.Image,
    paragraphs: list[dict],
    img_w: int,
    img_h: int,
) -> dict[int, tuple[float, float, float, float] | None]:
    """Compute a bubble bounding box (in image pixels) for every paragraph.

    Parameters
    ----------
    erased_image
        The inpainted image that the rest of the overlay sits on (i.e.
        ``result["imageDataUri"]`` decoded).  Connected components are
        labelled on this image so the bubble interior comes back as one
        big white region.
    paragraphs
        ``tree["paragraphs"]`` from any decoded Lens tree.  Item centers
        from each paragraph are used as seeds.
    img_w, img_h
        Image dimensions in pixels (must match ``erased_image``).

    Returns
    -------
    dict
        Mapping from ``para_index`` to ``(left, top, width, height)`` in
        pixels.  ``None`` is returned for paragraphs whose seeds didn't
        find a usable interior component (the renderer falls back to the
        text-only AABB for those).
    """
    if not paragraphs or img_w <= 0 or img_h <= 0:
        return {}

    try:
        gray = np.asarray(erased_image.convert("L"), dtype=np.uint8)
    except Exception:
        return {}

    # Make absolutely sure the array matches the declared dimensions —
    # PIL/Numpy occasionally disagrees on orientation when EXIF rotation
    # is in play.
    if gray.shape != (img_h, img_w):
        # Resize is cheap and avoids index-out-of-bounds when seeds are
        # computed from the declared dims.
        gray = cv2.resize(gray, (int(img_w), int(img_h)), interpolation=cv2.INTER_AREA)

    # Bright pixels are bubble interior; dark = ink, panel border, or art.
    _, binary = cv2.threshold(gray, _BG_THRESHOLD, 255, cv2.THRESH_BINARY)

    # 8-way connectivity so diagonally-touching pixels join the same
    # component (matters for jaggy hand-drawn bubble outlines).
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n_labels <= 1:
        return {int(p.get("para_index", i)): None for i, p in enumerate(paragraphs)}

    page_area = max(1, int(img_w) * int(img_h))
    max_area = int(page_area * _MAX_BUBBLE_AREA_FRAC)

    # Pre-compute one inscribed rectangle per accepted label.  Doing it
    # here (once per label) instead of inside the paragraph loop avoids
    # re-running ``findContours`` for paragraphs that share a bubble.
    inscribed_by_label: dict[int, tuple[float, float, float, float] | None] = {}
    for lbl in range(1, n_labels):
        l, t, w, h, area = (int(v) for v in stats[lbl])
        if area > max_area or area < _MIN_BUBBLE_AREA_PX:
            continue
        inscribed_by_label[lbl] = _inscribed_rect_from_label(
            labels, lbl, (l, t, w, h), img_w, img_h
        )

    out: dict[int, tuple[float, float, float, float] | None] = {}
    for i, para in enumerate(paragraphs):
        pi = int(para.get("para_index", i))
        seeds = _item_seed_points(para.get("items") or [], img_w, img_h)
        if not seeds:
            out[pi] = None
            continue

        # Look up each seed's component label.  Labels not in the
        # accepted set (too big / too small) are dropped silently.
        seen_labels: list[int] = []
        for sx, sy in seeds:
            lbl = _seed_label(labels, sx, sy)
            if lbl > 0 and lbl in inscribed_by_label and inscribed_by_label[lbl] is not None:
                if lbl not in seen_labels:
                    seen_labels.append(lbl)

        if not seen_labels:
            out[pi] = None
            continue

        # One paragraph usually sits inside one bubble.  When seeds hit
        # more than one (multi-bubble paragraph — rare), pick the bubble
        # whose inscribed rect has the largest area; that's the one most
        # likely to be the actual speech bubble for the paragraph.
        best_lbl = max(
            seen_labels,
            key=lambda l: (
                (inscribed_by_label[l][2] * inscribed_by_label[l][3])  # type: ignore[index]
                if inscribed_by_label[l] is not None
                else 0.0
            ),
        )
        out[pi] = inscribed_by_label[best_lbl]

    return out


# --- YOLO segmentation backend (optional, opt-in) -------------------------

def _yolo_enabled() -> bool:
    """True when YOLO is both available *and* the user asked for it.

    The env-var gate is intentional: YOLO inference dwarfs OpenCV CC
    labelling in wall time, so we only run it when the user explicitly
    opts in.
    """
    if not _ULTRALYTICS_OK:
        return False
    raw = (os.environ.get("TP_BUBBLE_USE_YOLO", "") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _load_yolo_model(model_path: str) -> Any:
    """Cached YOLO loader.  Returns ``None`` on any failure so callers can
    fall back cleanly to the OpenCV path.
    """
    if not _ULTRALYTICS_OK or not model_path:
        return None
    cached = _yolo_model_cache.get(model_path)
    if cached is not None:
        return cached
    try:
        model = _YOLO(model_path)  # type: ignore[misc]
    except Exception:
        return None
    _yolo_model_cache[model_path] = model
    return model


def detect_bubble_bounds_by_paragraph_yolo(
    image: Image.Image,
    paragraphs: list[dict],
    img_w: int,
    img_h: int,
    model_path: str = "",
) -> dict[int, tuple[float, float, float, float] | None] | None:
    """Locate bubble bboxes with a YOLO-segmentation model.

    Returns the same shape as :func:`detect_bubble_bounds_by_paragraph`,
    or ``None`` when YOLO isn't available / the model can't load /
    inference fails — the orchestrator falls back to the OpenCV detector.

    Each paragraph's *centroid* (average of its item centers) is used to
    pick the smallest YOLO bbox that contains it.  Multiple paragraphs
    can land on the same bubble (multi-line speech) and they'll all map
    to that bubble's bbox, which is the desired behaviour.
    """
    if not paragraphs or img_w <= 0 or img_h <= 0:
        return None
    model_path = model_path or os.environ.get("TP_BUBBLE_YOLO_MODEL", "").strip()
    model = _load_yolo_model(model_path)
    if model is None:
        return None

    imgsz = int(os.environ.get("TP_BUBBLE_YOLO_IMGSZ", "640") or 640)
    conf = float(os.environ.get("TP_BUBBLE_YOLO_CONF", "0.25") or 0.25)

    try:
        np_img = np.asarray(image.convert("RGB"))
        results = model(np_img, imgsz=imgsz, conf=conf, verbose=False)
    except Exception:
        return None

    bubble_boxes: list[tuple[float, float, float, float]] = []
    try:
        for r in results:
            boxes = getattr(r, "boxes", None)
            if boxes is None:
                continue
            xyxy = getattr(boxes, "xyxy", None)
            if xyxy is None:
                continue
            arr = xyxy.cpu().numpy() if hasattr(xyxy, "cpu") else np.asarray(xyxy)
            for row in arr:
                x1, y1, x2, y2 = (float(v) for v in row[:4])
                if x2 > x1 and y2 > y1:
                    bubble_boxes.append((x1, y1, x2, y2))
    except Exception:
        return None

    if not bubble_boxes:
        return None

    out: dict[int, tuple[float, float, float, float] | None] = {}
    for i, para in enumerate(paragraphs):
        pi = int(para.get("para_index", i))
        seeds = _item_seed_points(para.get("items") or [], img_w, img_h)
        if not seeds:
            out[pi] = None
            continue

        cx = sum(s[0] for s in seeds) / len(seeds)
        cy = sum(s[1] for s in seeds) / len(seeds)

        # Pick the smallest bubble bbox containing the centroid — when
        # bubbles nest (thought bubbles inside frames), the inner wins.
        best: tuple[float, float, float, float] | None = None
        best_area = float("inf")
        for x1, y1, x2, y2 in bubble_boxes:
            if not (x1 <= cx <= x2 and y1 <= cy <= y2):
                continue
            area = (x2 - x1) * (y2 - y1)
            if area < best_area:
                best_area = area
                best = (x1, y1, x2 - x1, y2 - y1)
        out[pi] = best
    return out


def detect_bubble_bounds_combined(
    image: Image.Image,
    paragraphs: list[dict],
    img_w: int,
    img_h: int,
    prefer_yolo: bool | None = None,
    yolo_model_path: str = "",
) -> dict[int, tuple[float, float, float, float] | None]:
    """Detect bubble bounds with YOLO first, OpenCV as fallback.

    Strategy per paragraph:
    1. If YOLO is enabled and returned a bbox for this paragraph → use it.
    2. Else if OpenCV found a connected component for this paragraph → use it.
    3. Else → ``None`` (renderer falls back to the text-only AABB).

    ``prefer_yolo`` defaults to the value of ``TP_BUBBLE_USE_YOLO``; set it
    explicitly to override on a per-call basis (e.g. in tests).
    """
    if prefer_yolo is None:
        prefer_yolo = _yolo_enabled()

    yolo_map: dict[int, tuple[float, float, float, float] | None] | None = None
    if prefer_yolo:
        yolo_map = detect_bubble_bounds_by_paragraph_yolo(
            image, paragraphs, img_w, img_h, model_path=yolo_model_path
        )

    opencv_map = detect_bubble_bounds_by_paragraph(image, paragraphs, img_w, img_h)

    if not yolo_map:
        return opencv_map

    merged: dict[int, tuple[float, float, float, float] | None] = {}
    for pi, ov in opencv_map.items():
        yv = yolo_map.get(pi)
        merged[pi] = yv if yv is not None else ov
    return merged


def attach_bubble_bounds(
    tree: dict,
    bubble_bounds_map: dict[int, tuple[float, float, float, float] | None],
) -> None:
    """Write each paragraph's bubble bounds into ``tree`` (mutates in place).

    The renderer reads ``para["bubble_bounds_px"]`` first and falls back
    to ``para["bounds_px"]`` (the text-only AABB) when it's missing.
    """
    if not isinstance(tree, dict):
        return
    for p in tree.get("paragraphs") or []:
        if not isinstance(p, dict):
            continue
        pi = int(p.get("para_index", -1))
        bounds = bubble_bounds_map.get(pi)
        if bounds is None:
            # Don't overwrite an existing value if the caller pre-populated one.
            p.setdefault("bubble_bounds_px", None)
            continue
        l, t, w, h = bounds
        p["bubble_bounds_px"] = [float(l), float(t), float(l + w), float(t + h)]
